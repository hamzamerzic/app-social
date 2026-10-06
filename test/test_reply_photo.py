"""Community reply photos remain scoped to their post and stable reply id."""

import base64
import io
import struct
import tempfile
import time
import unittest
import uuid
import zlib
from unittest.mock import patch

from fastapi.testclient import TestClient
from fastapi import HTTPException
from PIL import Image

import community_host
from common_public import CommonPublicStore
from test_community_host import _peer, _signed


def photo(size=(24, 16)):
  output = io.BytesIO()
  Image.new("RGB", size, "red").save(output, format="PNG")
  return output.getvalue()


def wire(data, size=(24, 16)):
  return {"mime": "image/png", "data_b64": base64.b64encode(data).decode(),
          "w": size[0], "h": size[1]}


def oversized_png_header():
  data = bytearray(photo())
  data[16:24] = struct.pack(">II", 5000, 5000)
  data[29:33] = struct.pack(">I", zlib.crc32(data[12:29]) & 0xffffffff)
  return bytes(data)


class ReplyPhotoTests(unittest.TestCase):
  def test_missing_reply_thumbnail_recovers_after_transient_processing_failure(self):
    with tempfile.TemporaryDirectory() as root:
      store = CommonPublicStore(root)
      store.store_post({"id": "post", "host": "author.example", "text": "Post",
                        "created_at": 1, "replies": []})
      data = photo()
      with patch("common_public.image_thumbnail_bytes", side_effect=OSError("encoder failed")):
        result = store.add_reply("post", "reply", "member.example", "member",
                                 "Caption", 2, (wire(data), data))
      self.assertTrue(result["activity"])
      self.assertEqual(store.reply_image("post", "reply")[0].read_bytes(), data)
      self.assertFalse((store.reply_thumbnail_dir() / "post" / "reply.webp").exists())
      with patch("common_public.image_thumbnail_bytes", side_effect=OSError("still failing")):
        self.assertIsNone(store.reply_image("post", "reply", thumbnail=True))
      self.assertFalse((store.reply_thumbnail_dir() / "post" / "reply.webp").exists())

      recovered = store.reply_image("post", "reply", thumbnail=True)

      self.assertEqual(recovered[1], "image/webp")
      with Image.open(recovered[0]) as image:
        self.assertLessEqual(max(image.size), 640)
      self.assertEqual(store.reply_image("post", "reply", thumbnail=True), recovered)
      self.assertEqual(len(store.get_replies("post")["replies"]), 1)

  def test_reply_thumbnail_recovery_rejects_corrupt_and_oversized_originals(self):
    with tempfile.TemporaryDirectory() as root:
      store = CommonPublicStore(root)
      store.store_post({"id": "post", "host": "author.example", "text": "Post",
                        "created_at": 1, "replies": []})
      corrupt = b"not an image"
      store.add_reply("post", "corrupt", "member.example", "member", "Photo", 2,
                      (wire(corrupt), corrupt))
      self.assertIsNone(store.reply_image("post", "corrupt", thumbnail=True))
      data = photo()
      store.add_reply("post", "oversized", "member.example", "member", "Photo", 3,
                      (wire(data), data))
      (store.reply_thumbnail_dir() / "post" / "oversized.webp").unlink()
      store.reply_image("post", "oversized")[0].write_bytes(oversized_png_header())

      with self.assertRaises(HTTPException) as caught:
        store.reply_image("post", "oversized", thumbnail=True)
      self.assertEqual(caught.exception.status_code, 400)
      self.assertFalse((store.reply_thumbnail_dir() / "post" / "oversized.webp").exists())

  def test_deleted_reply_cannot_regenerate_thumbnail_from_orphaned_original(self):
    with tempfile.TemporaryDirectory() as root:
      store = CommonPublicStore(root)
      store.store_post({"id": "post", "host": "author.example", "text": "Post",
                        "created_at": 1, "replies": []})
      data = photo()
      with patch("common_public.image_thumbnail_bytes", side_effect=OSError("encoder failed")):
        store.add_reply("post", "reply", "member.example", "member", "Photo", 2,
                        (wire(data), data))
      find_image = store.find_image
      deleted = False

      def delete_after_record_check(directory, stem):
        nonlocal deleted
        if not deleted and directory == store.reply_thumbnail_dir() / "post":
          deleted = True
          store.delete_post("post", "author.example")
        return find_image(directory, stem)

      with patch.object(store, "find_image", side_effect=delete_after_record_check):
        self.assertIsNone(store.reply_image("post", "reply", thumbnail=True))
      self.assertTrue(deleted)
      orphan_dir = store.reply_media_dir() / "post"
      orphan_dir.mkdir()
      (orphan_dir / "reply.png").write_bytes(data)

      self.assertIsNone(store.reply_image("post", "reply", thumbnail=True))
      self.assertIsNone(store.reply_image("post", "reply"))
      self.assertFalse((store.reply_thumbnail_dir() / "post" / "reply.webp").exists())

  def test_signed_member_photo_and_text_photo_only_retry_and_scoped_deletion(self):
    with tempfile.TemporaryDirectory() as root:
      store = CommonPublicStore(root)
      store.register("member.example", "member", "")
      key = _peer(store.data_dir(), "member.example")
      post_id, other_post = str(uuid.uuid4()), str(uuid.uuid4())
      reply_id = str(uuid.uuid4())
      for item in (post_id, other_post):
        store.store_post({"id": item, "host": "author.example", "handle": "author",
                          "text": "Post", "created_at": time.time(), "replies": []})
      base = {"v": 0, "type": "board_reply", "post_id": post_id,
              "id": reply_id, "from": "member.example", "sent_at": time.time()}
      path = "/api/common/board/reply"
      media_path = f"/api/common/board/{post_id}/replies/{reply_id}/media.png"
      thumb_path = f"/api/common/board/{post_id}/replies/{reply_id}/thumbnail.webp"
      with TestClient(community_host.create_app(root)) as client:
        self.assertTrue(client.get("/api/common/board").json()["capabilities"]["reply_attachments"])
        signed = _signed(key, {**base, "text": "Hello", "attachment": wire(photo())})
        first = client.post(path, json=signed)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()["id"], reply_id)
        self.assertEqual(first.json()["attachment"]["mime"], "image/png")
        self.assertEqual(client.get(media_path).content, photo())
        self.assertEqual(client.get(thumb_path).status_code, 200)
        self.assertEqual(client.get(media_path.replace(post_id, other_post)).status_code, 404)
        retry = client.post(path, json=signed)
        self.assertEqual(retry.json()["reply_count"], 1)
        changed = client.post(path, json=_signed(key, {**base, "text": "Changed", "attachment": wire(photo())}))
        self.assertEqual(changed.status_code, 409)
        photo_only = client.post(path, json=_signed(key, {**base, "id": str(uuid.uuid4()),
          "text": "", "attachment": wire(photo())}))
        self.assertEqual(photo_only.status_code, 200, photo_only.text)
        text_only = client.post(path, json=_signed(key, {**base, "id": str(uuid.uuid4()), "text": "Plain"}))
        self.assertEqual(text_only.status_code, 200, text_only.text)
        blank = client.post(path, json=_signed(key, {**base, "id": str(uuid.uuid4()), "text": " "}))
        self.assertEqual(blank.status_code, 400)
        self.assertEqual(store.get_replies(post_id)["replies"][0]["attachment"]["w"], 24)
        store.delete_post(post_id, "author.example")
        self.assertEqual(client.get(media_path).status_code, 404)
        self.assertEqual(client.get(thumb_path).status_code, 404)

  def test_nonmember_and_invalid_or_oversized_photo_do_not_create_reply(self):
    with tempfile.TemporaryDirectory() as root:
      store = CommonPublicStore(root)
      key = _peer(store.data_dir(), "outsider.example")
      post_id = str(uuid.uuid4())
      store.store_post({"id": post_id, "host": "author.example", "text": "Post",
                        "created_at": time.time(), "replies": []})
      body = {"v": 0, "type": "board_reply", "post_id": post_id,
              "id": str(uuid.uuid4()), "from": "outsider.example", "sent_at": time.time(),
              "text": "", "attachment": wire(photo())}
      with TestClient(community_host.create_app(root)) as client:
        self.assertEqual(client.post("/api/common/board/reply", json=_signed(key, body)).status_code, 403)
        store.register("outsider.example", "outsider", "")
        invalid = {**body, "attachment": {**body["attachment"], "w": 9000}}
        self.assertEqual(client.post("/api/common/board/reply", json=_signed(key, invalid)).status_code, 400)
        oversized = {**body, "attachment": wire(b"x" * (1024 * 1024 + 1))}
        self.assertEqual(client.post("/api/common/board/reply", json=_signed(key, oversized)).status_code, 413)
        self.assertEqual(store.get_replies(post_id)["replies"], [])

  def test_stable_reply_cannot_replace_author_photo_metadata_or_thumbnail(self):
    with tempfile.TemporaryDirectory() as root:
      store = CommonPublicStore(root)
      post_id, reply_id = str(uuid.uuid4()), str(uuid.uuid4())
      store.store_post({"id": post_id, "host": "author.example", "text": "Post",
                        "created_at": time.time(), "replies": []})
      data = photo()
      attachment = (wire(data), data)
      thumbnail = (wire(data), data)
      original = (post_id, reply_id, "member.example", "member", "Caption", 1)
      first = store.add_reply(*original, attachment, thumbnail)
      self.assertTrue(first["activity"])
      self.assertFalse(store.add_reply(*original, attachment, thumbnail)["activity"])
      for args, image, thumb in [
        ((*original[:2], "other.example", *original[3:]), attachment, thumbnail),
        (original, (wire(photo((25, 16)), (25, 16)), photo((25, 16))), thumbnail),
        (original, ({**attachment[0], "w": 23}, data), thumbnail),
        (original, attachment, None),
      ]:
        with self.subTest(args=args, image=image[0], has_thumbnail=thumb is not None):
          with self.assertRaises(HTTPException) as caught:
            store.add_reply(*args, image, thumb)
          self.assertEqual(caught.exception.status_code, 409)
      self.assertEqual(store.reply_image(post_id, reply_id)[0].read_bytes(), data)
      self.assertEqual(len(store.get_replies(post_id)["replies"]), 1)
