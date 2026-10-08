"""Animation originals use one bounded validator across all Common content."""

import base64
import io
import random
import os
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image

import common_protocol
import community_host
from common_public import CommonPublicStore, image_thumbnail_bytes, validate_reply_original_bytes, validate_thumbnail_bytes
from test_community_host import _peer, _signed


def animation():
  palette = [0, 0, 0, 255, 0, 0, 0, 0, 255] + [0] * (768 - 9)
  frames = []
  for color in (1, 2):
    image = Image.new("P", (24, 16), color)
    image.putpalette(palette)
    image.putpixel((0, 0), 0)
    frames.append(image)
  output = io.BytesIO()
  frames[0].save(output, format="GIF", save_all=True, append_images=frames[1:],
                 optimize=False, duration=[80, 170], loop=3, disposal=[2, 3],
                 transparency=0, comment=b"original metadata ; GIF89a")
  return output.getvalue()


def wire(data, size=(24, 16)):
  return {"mime": "image/gif", "data_b64": base64.b64encode(data).decode(),
          "w": size[0], "h": size[1]}


def tiny_container(size=(1, 1), frames=1, *, broken_last=False):
  """Small descriptors on a chosen canvas keep resource fixtures cheap."""
  output = io.BytesIO()
  Image.new("P", (1, 1)).save(output, format="GIF")
  data = output.getvalue()
  start = 13 + 3 * 2 ** ((data[10] & 7) + 1)
  header = bytearray(data[:start])
  header[6:10] = size[0].to_bytes(2, "little") + size[1].to_bytes(2, "little")
  frame = data[start:-1]
  last = bytearray(frame)
  if broken_last:
    # A complete sub-block containing a bad LZW stream, not a framing error.
    last[12:15] = b"\xff\xff\xff"
  return bytes(header) + frame * (frames - 1) + bytes(last) + b";"


def padded_gif(total_bytes):
  """A fully framed, decodable GIF with legal comment sub-block padding."""
  original = tiny_container()
  overhead = 3  # extension introducer, comment label, terminator
  room = total_bytes - len(original) - overhead
  blocks = bytearray()
  while room:
    take = min(255, room - 1)
    if room - take - 1 == 1:
      take -= 1
    if take <= 0:
      raise ValueError("Cannot represent padding length")
    blocks.append(take)
    blocks.extend(b"x" * take)
    room -= take + 1
  return original[:-1] + b"\x21\xfe" + bytes(blocks) + b"\x00;"


def invalid_gifs():
  small = tiny_container()
  # The first image descriptor follows this tiny global color table.
  start = 13 + 3 * 2 ** ((small[10] & 7) + 1)
  zero_frame = bytearray(small)
  zero_frame[start + 5:start + 7] = b"\0\0"
  outside_canvas = bytearray(small)
  outside_canvas[start + 1:start + 3] = b"\1\0"
  return [
    (wire(b"not a GIF", (1, 1)), 400),
    (wire(small[:-1], (1, 1)), 400),  # Pillow accepts this missing trailer.
    (wire(small[:-3] + b";", (1, 1)), 400),
    (wire(small + b"junk", (1, 1)), 400),
    (wire(small, (2, 1)), 400),
    (wire(tiny_container((0, 1)), (1, 1)), 400),
    (wire(bytes(zero_frame), (1, 1)), 400),
    (wire(bytes(outside_canvas), (1, 1)), 400),
    (wire(tiny_container((1601, 1)), (1601, 1)), 413),
    (wire(tiny_container(frames=301), (1, 1)), 413),
    (wire(tiny_container((1600, 1600), frames=13), (1600, 1600)), 413),
  ] + [
    ({**value, "mime": mime}, 400)
    for value in (
      wire(small, (1, 1)), wire(small[:-1], (1, 1)),
      wire(tiny_container(frames=301), (1, 1)),
      wire(tiny_container((1601, 1)), (1601, 1)),
      wire(tiny_container((1600, 1600), frames=13), (1600, 1600)),
    )
    for mime in ("image/png", "image/jpeg", "image/webp")
  ] + [(wire(tiny_container(frames=2, broken_last=True), (1, 1)), 400)]


class CanonicalGifTests(unittest.TestCase):
  def test_animated_original_cannot_be_installed_as_an_autoplay_thumbnail(self):
    with self.assertRaisesRegex(ValueError, "static thumbnail"):
      validate_thumbnail_bytes(wire(animation()), animation())

  def test_exact_original_and_static_behavior_are_preserved(self):
    data = animation()
    value = wire(data)
    validated, original = common_protocol.validate_attachment(value)
    self.assertIs(validated, value)
    self.assertEqual(original, data)
    validate_reply_original_bytes(value, data)
    self.assertEqual(common_protocol.ATTACHMENT_MIME_EXT["image/gif"], "gif")
    for mime in ("image/jpeg", "image/png", "image/webp"):
      legacy = {**value, "mime": mime, "data_b64": base64.b64encode(b"legacy original").decode()}
      self.assertEqual(common_protocol.validate_attachment(legacy)[1], b"legacy original")

  def test_complete_framing_and_every_raster_are_required(self):
    for value, status in invalid_gifs():
      with self.subTest(status=status, value=value):
        with self.assertRaises(HTTPException) as caught:
          common_protocol.validate_attachment(value)
        self.assertEqual(caught.exception.status_code, status)
    data = tiny_container()
    for end in range(len(data)):
      with self.subTest(prefix=end), self.assertRaises(HTTPException):
        common_protocol.validate_attachment(wire(data[:end], (1, 1)))

  def test_budget_and_container_preflight_precedes_pillow(self):
    for value, status in invalid_gifs()[:-1]:
      with self.subTest(status=status), patch("PIL.Image.open") as opened:
        with self.assertRaises(HTTPException):
          common_protocol.validate_attachment(value)
        opened.assert_not_called()
    # Inclusive frame/side boundaries remain usable without large fixtures.
    common_protocol.validate_attachment(wire(tiny_container(frames=300), (1, 1)))
    common_protocol.validate_attachment(wire(tiny_container((1600, 1)), (1600, 1)))

  def test_wire_shape_mime_and_byte_limits_are_unchanged(self):
    data = animation()
    value = wire(data)
    cases = [({**value, "frames": 2}, 400), ({**value, "w": True}, 400),
             ({**value, "h": 0}, 400), ({**value, "data_b64": "!"}, 400),
             (wire(b"x" * (20 * 1024 * 1024 + 1)), 413)]
    output = io.BytesIO()
    Image.new("RGB", (24, 16)).save(output, format="PNG")
    cases.append((wire(output.getvalue()), 400))
    for malformed, status in cases:
      with self.subTest(status=status), self.assertRaises(HTTPException) as caught:
        common_protocol.validate_attachment(malformed)
      self.assertEqual(caught.exception.status_code, status)
    with self.assertRaises(HTTPException) as caught:
      common_protocol.validate_attachment_envelope_size({"text": "x" * (60 * 1024 * 1024)})
    self.assertEqual(caught.exception.status_code, 413)

  def test_large_gif_and_static_boundaries_and_gallery_total(self):
    mb = 1024 * 1024
    for size in (mb + 1, 20 * mb):
      data = padded_gif(size)
      self.assertEqual(len(data), size)
      self.assertEqual(common_protocol.validate_attachment(wire(data, (1, 1)))[1], data)
    mime, poster = image_thumbnail_bytes(data)
    self.assertEqual(mime, "image/webp")
    self.assertLessEqual(len(poster), common_protocol.MAX_THUMBNAIL_BYTES)
    with self.assertRaises(HTTPException) as caught:
      common_protocol.validate_attachment(wire(padded_gif(20 * mb + 1), (1, 1)))
    self.assertEqual(caught.exception.status_code, 413)
    static = lambda size: {"mime": "image/jpeg", "data_b64": base64.b64encode(b"a" * size).decode(), "w": 1, "h": 1}
    common_protocol.validate_attachment(static(5 * mb))
    with self.assertRaises(HTTPException) as caught:
      common_protocol.validate_attachment(static(5 * mb + 1))
    self.assertEqual(caught.exception.status_code, 413)
    common_protocol.validate_attachments([static(5 * mb)] * 4)
    with self.assertRaises(HTTPException) as caught:
      common_protocol.validate_attachments([static(5 * mb)] * 4 + [static(1)])
    self.assertEqual(caught.exception.status_code, 400)  # four-image cap
    with self.assertRaises(HTTPException) as caught:
      common_protocol.validate_attachments([wire(data, (1, 1)), static(1)])
    self.assertEqual(caught.exception.status_code, 413)
    with self.assertRaises(HTTPException) as caught:
      common_protocol.validate_attachment(static(120 * 1024 + 1), thumbnail=True)
    self.assertEqual(caught.exception.status_code, 413)

  def test_large_original_fits_signed_plaintext_and_encrypted_transport(self):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
    import social_routes
    original = wire(padded_gif(1024 * 1024 + 1), (1, 1))
    key = common_protocol.new_signing_key()
    plain = {"v": 0, "type": "message", "id": "abcdef12", "from": "a.example",
             "to": "b.example", "text": "", "sent_at": time.time(),
             "attachment": original}
    plain["sig"] = common_protocol.sign(plain, key)
    common_protocol.validate_attachment_envelope_size(plain)
    self.assertTrue(common_protocol.verify(
      {k: v for k, v in plain.items() if k != "sig"}, plain["sig"],
      common_protocol.signing_public_key(key)))
    recipient = X25519PrivateKey.generate()
    private = base64.b64encode(recipient.private_bytes(
      serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
      serialization.NoEncryption())).decode()
    public = base64.b64encode(recipient.public_key().public_bytes(
      serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()
    sealed = social_routes._seal_dm("abcdef12", public, text="", attachment=original, reply_to=None)
    encrypted = {k: v for k, v in plain.items() if k not in ("attachment", "sig")}
    encrypted["enc"] = sealed
    encrypted["sig"] = common_protocol.sign(encrypted, key)
    common_protocol.validate_attachment_envelope_size(encrypted)
    opened = social_routes._open_dm("abcdef12", sealed, private)
    self.assertEqual(common_protocol.validate_attachment(opened["attachment"])[1],
                     base64.b64decode(original["data_b64"]))

  def test_first_frame_thumbnail_is_a_static_transparent_poster(self):
    data = animation()
    mime, poster = image_thumbnail_bytes(data)
    self.assertEqual(mime, "image/webp")
    with Image.open(io.BytesIO(poster)) as image:
      self.assertEqual(image.size, (24, 16))
      self.assertEqual(image.n_frames, 1)
      rgba = image.convert("RGBA")
      self.assertEqual(rgba.getpixel((0, 0))[3], 0)
      self.assertGreater(rgba.getpixel((12, 8))[0], 240)
      self.assertLess(rgba.getpixel((12, 8))[2], 10)


class CommunityGifTests(unittest.TestCase):
  def test_failed_reply_commit_cannot_reuse_a_different_gif_original_or_poster(self):
    from common_public import atomic_write

    for poster_fails in (False, True):
      with self.subTest(poster_fails=poster_fails), tempfile.TemporaryDirectory() as root:
        store = CommonPublicStore(root)
        store.store_post({"id": "abcdef12", "host": "member.example", "text": "Post",
                          "created_at": 1, "replies": []})
        old = animation()
        new = tiny_container((24, 16))
        post_path = store.board_dir() / "abcdef12.json"

        def fail_commit(path, content):
          if path == post_path:
            raise OSError("reply JSON commit failed")
          return atomic_write(path, content)

        args = ("abcdef12", "abcdef34", "member.example", "member", "Caption", 2)
        with patch("common_public.atomic_write", side_effect=fail_commit):
          with self.assertRaises(OSError):
            store.add_reply(*args, (wire(old), old))
        old_poster = store.reply_thumbnail_dir() / "abcdef12" / "abcdef34.webp"
        self.assertTrue(old_poster.exists())
        self.assertEqual(store.get_replies("abcdef12")["replies"], [])
        if poster_fails:
          with patch("common_public.image_thumbnail_bytes", side_effect=OSError("poster failed")):
            store.add_reply(*args, (wire(new), new))
          self.assertFalse(old_poster.exists())
        else:
          store.add_reply(*args, (wire(new), new))
        self.assertEqual(store.reply_image("abcdef12", "abcdef34")[0].read_bytes(), new)
        poster = store.reply_image("abcdef12", "abcdef34", thumbnail=True)
        self.assertEqual(poster[0].read_bytes(), image_thumbnail_bytes(new)[1])
        self.assertNotEqual(poster[0].read_bytes(), image_thumbnail_bytes(old)[1])
        result = store.add_reply(*args, (wire(new), new))
        self.assertFalse(result["activity"])
        self.assertEqual(result["reply_count"], 1)

  def test_signed_post_reply_caption_retry_original_poster_recovery_and_deletion(self):
    with tempfile.TemporaryDirectory() as root:
      store = CommonPublicStore(root)
      store.register("member.example", "member", "")
      key = _peer(Path(root), "member.example")
      post_id, reply_id = str(uuid.uuid4()), str(uuid.uuid4())
      data = animation()
      body = {"v": 0, "from": "member.example", "sent_at": time.time(),
              "id": post_id, "type": "board_post", "text": "Post caption",
              "attachment": wire(data)}
      reply = {**body, "id": reply_id, "post_id": post_id,
               "type": "board_reply", "text": "Reply caption"}
      with TestClient(community_host.create_app(root)) as client:
        self.assertTrue(client.get("/api/common/board").json()["capabilities"]["gif_attachments"])
        for _ in range(2):
          response = client.post("/api/common/board", json=_signed(key, body))
          self.assertEqual(response.status_code, 200, response.text)
        # A transient poster failure never damages the committed original.
        with patch("common_public.image_thumbnail_bytes", side_effect=OSError("encoder failed")):
          response = client.post("/api/common/board/reply", json=_signed(key, reply))
        self.assertEqual(response.status_code, 200, response.text)
        response = client.post("/api/common/board/reply", json=_signed(key, reply))
        self.assertEqual(response.json()["reply_count"], 1)
        saved_post = client.get("/api/common/board").json()["posts"][0]
        self.assertEqual(saved_post["text"], "Post caption")
        saved_reply = store.get_replies(post_id)["replies"][0]
        self.assertEqual(saved_reply["text"], "Reply caption")
        changed = client.post("/api/common/board/reply", json=_signed(key, {**reply, "text": "Changed"}))
        self.assertEqual(changed.status_code, 409)
        base = f"/api/common/board/{post_id}/replies/{reply_id}/"
        for path in (f"/api/common/board/media/{post_id}.gif", base + "media.gif", base + "media"):
          response = client.get(path)
          self.assertEqual(response.status_code, 200, response.text)
          self.assertEqual(response.headers["content-type"], "image/gif")
          self.assertEqual(response.content, data)
          with Image.open(io.BytesIO(response.content)) as image:
            self.assertEqual(image.n_frames, 2)
            self.assertEqual(image.info["loop"], 3)
            self.assertEqual(image.info["transparency"], 0)
            for index, duration, disposal in ((0, 80, 2), (1, 170, 3)):
              image.seek(index)
              self.assertEqual(image.info["duration"], duration)
              self.assertEqual(image.disposal_method, disposal)
        thumb = store.reply_thumbnail_dir() / post_id / f"{reply_id}.webp"
        self.assertFalse(thumb.exists())
        for path in (f"/api/common/board/thumbnail/{post_id}.webp", base + "thumbnail.webp"):
          response = client.get(path)
          self.assertEqual(response.status_code, 200, response.text)
          self.assertEqual(response.content, image_thumbnail_bytes(data)[1])
        self.assertTrue(thumb.exists())
        thumb.unlink()
        store.delete_post(post_id, "member.example")
        # Even an orphan original cannot resurrect a deleted reply's poster.
        orphan = store.reply_media_dir() / post_id / f"{reply_id}.gif"
        orphan.parent.mkdir(parents=True, exist_ok=True)
        orphan.write_bytes(data)
        self.assertEqual(client.get(base + "media.gif").status_code, 404)
        self.assertEqual(client.get(base + "thumbnail.webp").status_code, 404)
        self.assertEqual(client.get(f"/api/common/board/media/{post_id}.gif").status_code, 404)
        self.assertFalse(thumb.exists())

  def test_invalid_signed_post_reply_and_gallery_leave_no_media_or_records(self):
    with tempfile.TemporaryDirectory() as root:
      store = CommonPublicStore(root)
      store.register("member.example", "member", "")
      key = _peer(Path(root), "member.example")
      post_id = str(uuid.uuid4())
      store.store_post({"id": post_id, "host": "member.example", "text": "Post",
                        "created_at": time.time(), "replies": []})
      with TestClient(community_host.create_app(root)) as client:
        for value, status in invalid_gifs():
          for kind, path in (("board_post", "/api/common/board"),
                             ("board_reply", "/api/common/board/reply")):
            identity = str(uuid.uuid4())
            body = {"v": 0, "type": kind, "from": "member.example", "id": identity,
                    "post_id": post_id, "text": "Caption", "sent_at": time.time(),
                    "attachment": value}
            with self.subTest(kind=kind, status=status):
              response = client.post(path, json=_signed(key, body))
              self.assertEqual(response.status_code, status, response.text)
              self.assertIn("detail", response.json())
              self.assertFalse((store.board_dir() / f"{identity}.json").exists())
          body.pop("attachment")
          body.update(type="board_post", id=str(uuid.uuid4()),
                      attachments=[wire(animation()), value])
          self.assertEqual(client.post("/api/common/board", json=_signed(key, body)).status_code, status)
        self.assertEqual(store.get_replies(post_id)["replies"], [])
        for directory in (store.board_media_dir(), store.board_thumbnail_dir(),
                          store.reply_media_dir(), store.reply_thumbnail_dir()):
          self.assertEqual(list(directory.rglob("*")), [])

  def test_direct_store_gif_guards_precede_files_and_records(self):
    with tempfile.TemporaryDirectory() as root:
      store = CommonPublicStore(root)
      post = {"id": "abcdef12", "host": "member.example", "text": "Post", "created_at": 1}
      data = tiny_container()[:-1]
      with self.assertRaises(HTTPException):
        store.store_post(post, (wire(data, (1, 1)), data))
      self.assertFalse((store.board_dir() / "abcdef12.json").exists())
      store.store_post(post)
      with self.assertRaises(HTTPException):
        store.add_reply("abcdef12", "abcdef34", "member.example", "member", "Reply", 2,
                        (wire(data, (1, 1)), data))
      self.assertEqual(store.get_replies("abcdef12")["replies"], [])
      self.assertEqual(list(store.board_media_dir().rglob("*")), [])
      self.assertEqual(list(store.reply_media_dir().rglob("*")), [])

  def test_direct_store_rejects_gif_bytes_mislabeled_as_a_static_image(self):
    for mime in ("image/png", "image/jpeg", "image/webp"):
      with self.subTest(mime=mime), tempfile.TemporaryDirectory() as root:
        store = CommonPublicStore(root)
        data = tiny_container(frames=301)
        metadata = {**wire(data, (1, 1)), "mime": mime}
        with self.assertRaises(HTTPException) as caught:
          store.store_post({"id": "abcdef12", "host": "member.example",
                            "text": "Caption", "created_at": 1}, (metadata, data))
        self.assertEqual(caught.exception.status_code, 400)
        self.assertFalse((store.board_dir() / "abcdef12.json").exists())
        self.assertEqual(list(store.board_media_dir().rglob("*")), [])


class MessageGifSeamTests(unittest.IsolatedAsyncioTestCase):
  async def test_dm_and_group_canonical_seam_rejects_before_outbound_persistence(self):
    with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {
      "APP_STORAGE_DIR": root, "APP_ID": "7", "APP_SLUG": "social",
    }):
      import social_routes
      import social_groups
      from service_runtime import Principal
      app = SimpleNamespace(id=7, slug="social")
      self.assertIs(social_routes._validate_attachment, common_protocol.validate_attachment)
      self.assertIs(social_groups._validate_attachment, common_protocol.validate_attachment)
      data = animation()
      for validator in (social_routes._validate_attachment, social_groups._validate_attachment):
        self.assertEqual(validator(wire(data))[1], data)
      malformed = wire(data[:-1])
      with (patch.object(social_routes, "_require_member", return_value=app),
            patch.object(social_groups, "_require_member", return_value=app),
            patch.object(social_routes, "_persist_outgoing_message", new=AsyncMock()) as dm_store,
            patch.object(social_routes, "_prepare_outgoing_conversation", new=AsyncMock()) as consent,
            patch.object(social_groups, "_store_group_message", new=AsyncMock()) as group_store,
            patch.object(social_groups, "_host_commit_post", new=AsyncMock()) as group_commit):
        owner = Principal("owner", None, None)
        with self.assertRaises(HTTPException) as caught:
          await social_routes.send_message(social_routes.SendMessage(
            to="peer.example", text="Caption", attachment=malformed), db=None, principal=owner)
        self.assertEqual(caught.exception.status_code, 400)
        with self.assertRaises(HTTPException) as caught:
          await social_groups.send_group_message("abcdef12", social_groups.GroupSend(
            text="Caption", attachment=malformed), db=None, principal=owner)
        self.assertEqual(caught.exception.status_code, 400)
        dm_store.assert_not_called()
        consent.assert_not_called()
        group_store.assert_not_called()
        group_commit.assert_not_called()

  async def test_dm_plain_encrypted_and_group_post_relay_validate_before_inbound_storage(self):
    with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {
      "APP_STORAGE_DIR": root, "APP_ID": "7", "APP_SLUG": "social",
    }):
      import social_routes
      import social_groups
      app = SimpleNamespace(id=7, slug="social")
      malformed = wire(animation()[:-1])
      body = {"v": 0, "type": "message", "from": "peer.example", "to": "self.example",
              "id": "abcdef34", "text": "Caption", "sent_at": 1, "attachment": malformed}
      with (patch.object(social_routes, "_joined_for_federation", return_value=True),
            patch.object(social_routes, "_own_host", return_value="self.example"),
            patch.object(social_routes, "_verify_peer_envelope", new=AsyncMock(return_value={"handle": "peer"})),
            patch.object(social_routes, "_common_app") as dm_app,
            patch.object(social_routes, "_load_identity", return_value={"enc_private_key_b64": "unused"}),
            patch.object(social_routes, "_open_dm", return_value=body),
            patch.object(social_groups, "_host_commit_post", new=AsyncMock()) as commit,
            patch.object(social_groups, "_store_group_message", new=AsyncMock()) as store,
            patch.object(social_groups, "_load_group_meta", return_value={"host": "peer.example"}),
            patch.object(social_groups, "_verify_peer_envelope", new=AsyncMock(return_value={"handle": "peer"}))):
        for encrypted in (False, True):
          envelope = {**body, "enc": {}} if encrypted else body
          with patch.object(social_routes, "_read_envelope", new=AsyncMock(return_value=envelope)):
            with self.assertRaises(HTTPException) as caught:
              await social_routes.receive_message(None, db=None)
          self.assertEqual(caught.exception.status_code, 400)
        original = {**body, "type": "group_post", "gid": "abcdef12", "to": "peer.example"}
        relay = {**original, "type": "group_message", "original": original}
        for envelope in (original, relay):
          with self.assertRaises(HTTPException) as caught:
            await social_groups._accept_group_envelope(None, app, envelope, {"handle": "peer"})
          self.assertEqual(caught.exception.status_code, 400)
        dm_app.assert_not_called()
        commit.assert_not_called()
        store.assert_not_called()


class GeneratedPosterBudgetTests(unittest.TestCase):
  def test_high_detail_generated_poster_fits_media_download_budget(self):
    original = io.BytesIO()
    Image.frombytes('RGB', (640, 640), random.Random(1).randbytes(640 * 640 * 3)).save(original, format='PNG')
    mime, poster = image_thumbnail_bytes(original.getvalue())
    self.assertEqual(mime, 'image/webp')
    self.assertLessEqual(len(poster), common_protocol.MAX_THUMBNAIL_BYTES)
    with Image.open(io.BytesIO(poster)) as image:
      self.assertLessEqual(max(image.size), 640)
      image.load()


if __name__ == "__main__":
  unittest.main()
