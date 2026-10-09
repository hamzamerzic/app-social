"""New animations fail closed against old hosts without weakening write deadlines."""
import asyncio
import base64
import gc
import io
import os
import random
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
import httpx
from fastapi import HTTPException
from fastapi.responses import FileResponse
from PIL import Image

os.environ.setdefault("APP_STORAGE_DIR", "/tmp/social-gif-owner-tests")
os.environ.setdefault("APP_ID", "7")
os.environ.setdefault("APP_SLUG", "social")
import social_routes as routes
import service_runtime


class GifOwnerRoutes(unittest.IsolatedAsyncioTestCase):
  def setUp(self):
    out = io.BytesIO()
    Image.new("RGB", (2, 2), "red").save(out, format="GIF")
    self.attachment = {"mime": "image/gif", "data_b64": base64.b64encode(out.getvalue()).decode(), "w": 2, "h": 2}
    self.principal = service_runtime.Principal("owner", None, None)
    for name, kwargs in (
      ("_require_member", {}),
      ("_load_identity", {"return_value": {"handle": "owner", "private_key_b64": "fixture"}}),
      ("_require_username", {}), ("_sign", {"return_value": "sig"}),
      ("_own_host", {"return_value": "owner.example"}),
    ):
      self.enterContext(patch.object(routes, name, **kwargs))
    self.send = self.enterContext(patch.object(routes, "_post_signed_envelope", new=AsyncMock(return_value=self.response({"status": "ok"}))))
    self.discover = self.enterContext(patch.object(routes, "federation_request", new=AsyncMock()))

  def response(self, body):
    return httpx.Response(200, json=body, request=httpx.Request("GET", "https://community.example/board"))

  async def send_asgi(self, response, send=None, *, headers=(), extensions=None):
    messages = []
    async def collect(message):
      messages.append(message)
      if send is not None:
        await send(message)
    async def receive():
      await asyncio.Event().wait()
    await response({
      "type": "http", "method": "GET", "headers": list(headers),
      "asgi": {"version": "3.0", "spec_version": "2.4"},
      "extensions": extensions or {},
    }, receive, collect)
    return messages

  async def test_evicted_gif_response_streams_exact_bytes_and_releases_its_file(self):
    gif = b"GIF89a" + b"g" * 14
    png = b"\x89PNG" + b"p" * 8
    with (
      tempfile.TemporaryDirectory() as directory,
      patch.object(routes, "_peer_board_media_dir", return_value=Path(directory)),
      patch.object(routes, "BOARD_MEDIA_CACHE_MAX_BYTES", 16),
      patch.object(routes, "_require_owner_or_common_app"),
      patch.object(routes, "_download_board_media", new=AsyncMock(side_effect=[
        ("image/gif", gif), ("image/png", png),
      ])),
    ):
      first = await routes.get_board_media_for_owner("abcdef12", mime="image/gif", db=None, principal=self.principal)
      self.assertFalse(first._opened.closed)
      ranged = await routes.get_board_media_for_owner("abcdef12", mime="image/gif", db=None, principal=self.principal)
      second = await routes.get_board_media_for_owner("abcdef34", mime="image/png", db=None, principal=self.principal)
      self.assertFalse((Path(directory) / f"{routes._peer_board_media_name(routes.COMMUNITY_HOST, 'abcdef12')}.gif").exists())
      messages = await self.send_asgi(first, extensions={"http.response.pathsend": {}})
      self.assertEqual(b"".join(m.get("body", b"") for m in messages[1:]), gif)
      self.assertEqual(messages[0]["status"], 200)
      headers = dict(messages[0]["headers"])
      self.assertEqual(headers[b"content-type"], b"image/gif")
      self.assertEqual(headers[b"content-length"], str(len(gif)).encode())
      self.assertEqual(headers[b"cache-control"], routes.OWNER_BOARD_IMAGE_CACHE.encode())
      self.assertIn(b"etag", headers)
      self.assertIn(b"last-modified", headers)
      self.assertEqual(headers[b"x-content-type-options"], b"nosniff")
      self.assertTrue(first._opened.closed)
      range_messages = await self.send_asgi(ranged, headers=[(b"range", b"bytes=2-5")])
      self.assertEqual(range_messages[0]["status"], 206)
      self.assertEqual(b"".join(m.get("body", b"") for m in range_messages[1:]), gif[2:6])
      self.assertEqual(dict(range_messages[0]["headers"])[b"content-range"], b"bytes 2-5/20")
      self.assertTrue(ranged._opened.closed)
      await self.send_asgi(second)
      self.assertTrue(second._opened.closed)

  async def test_full_size_gif_stays_byte_exact_after_cache_eviction(self):
    small = base64.b64decode(self.attachment["data_b64"])
    target_size = 20 * 1024 * 1024
    budget = target_size - len(small) - 3  # comment marker and terminator
    blocks = (budget + 255) // 256
    payload, extra = divmod(budget - blocks, blocks)
    comment = (bytes([payload + 1]) + b"g" * (payload + 1)) * extra
    comment += (bytes([payload]) + b"g" * payload) * (blocks - extra)
    gif = small[:-1] + b"\x21\xfe" + comment + b"\x00;"
    self.assertEqual(len(gif), target_size)
    Image.open(io.BytesIO(gif)).verify()
    with (
      tempfile.TemporaryDirectory() as directory,
      patch.object(routes, "_peer_board_media_dir", return_value=Path(directory)),
      patch.object(routes, "_require_owner_or_common_app"),
      patch.object(routes, "_download_board_media", new=AsyncMock(side_effect=[
        ("image/gif", gif), ("image/png", b"\x89PNG"),
      ])),
    ):
      first = await routes.get_board_media_for_owner("abcdef12", db=None, principal=self.principal)
      second = await routes.get_board_media_for_owner("abcdef34", db=None, principal=self.principal)
      self.assertFalse(Path(first._opened.name).exists())
      messages = await self.send_asgi(first)
      self.assertEqual(b"".join(m.get("body", b"") for m in messages[1:]), gif)
      self.assertTrue(first._opened.closed)
      await self.send_asgi(second)

  async def test_cached_ranges_match_native_file_response(self):
    data = b"GIF89a" + bytes(range(32))
    with (
      tempfile.TemporaryDirectory() as directory,
      patch.object(routes, "_peer_board_media_dir", return_value=Path(directory)),
      patch.object(routes, "_require_owner_or_common_app"),
      patch.object(routes, "_download_board_media", new=AsyncMock(return_value=("image/gif", data))),
    ):
      baseline_path = Path(directory) / ".baseline.gif"
      baseline_path.write_bytes(data)
      for range_value, if_range in (
        (None, None), ("bytes=2-5", None), ("bytes=6-", None),
        ("bytes=-4", None), ("bytes=0-1,5-7", None),
        ("bytes=2-5", "match"), ("bytes=2-5", "mismatch"),
        ("bytes=2-5", "date-match"), ("bytes=2-5", "date-mismatch"),
        ("garbage", None), ("bytes=99-100", None),
      ):
        with self.subTest(range=range_value, if_range=if_range):
          cached = await routes.get_board_media_for_owner("abcdef12", db=None, principal=self.principal)
          native = FileResponse(baseline_path, media_type="image/gif", headers={
            "cache-control": routes.OWNER_BOARD_IMAGE_CACHE,
            "x-content-type-options": "nosniff",
          })
          request_headers = [] if range_value is None else [(b"range", range_value.encode())]
          cached_headers = list(request_headers)
          native_headers = list(request_headers)
          if if_range is not None:
            # Native FileResponse computes its ETag at send time.
            native.set_stat_headers(baseline_path.stat())
            if if_range == "match":
              cached_if_range, native_if_range = cached.headers["etag"], native.headers["etag"]
            elif if_range == "date-match":
              cached_if_range, native_if_range = cached.headers["last-modified"], native.headers["last-modified"]
            elif if_range == "date-mismatch":
              cached_if_range = native_if_range = "Wed, 01 Jan 2020 00:00:00 GMT"
            else:
              cached_if_range = native_if_range = '"other"'
            cached_headers.append((b"if-range", cached_if_range.encode()))
            native_headers.append((b"if-range", native_if_range.encode()))
          with patch("starlette.responses.token_hex", return_value="fixed-boundary"):
            expected = await self.send_asgi(native, headers=native_headers)
            actual = await self.send_asgi(cached, headers=cached_headers)
          self.assertEqual(actual[0]["status"], expected[0]["status"])
          self.assertEqual(b"".join(m.get("body", b"") for m in actual[1:]),
                           b"".join(m.get("body", b"") for m in expected[1:]))
          actual_headers, expected_headers = dict(actual[0]["headers"]), dict(expected[0]["headers"])
          for header in (b"content-type", b"content-length", b"content-range", b"accept-ranges", b"cache-control"):
            self.assertEqual(actual_headers.get(header), expected_headers.get(header), header)
          self.assertTrue(cached._opened.closed)

  async def test_cached_response_releases_file_on_failed_or_cancelled_send_and_abandonment(self):
    with (
      tempfile.TemporaryDirectory() as directory,
      patch.object(routes, "_peer_board_media_dir", return_value=Path(directory)),
      patch.object(routes, "_require_owner_or_common_app"),
      patch.object(routes, "_download_board_media", new=AsyncMock(return_value=("image/gif", b"GIF89a"))),
    ):
      async def fail(message):
        if message["type"] == "http.response.body":
          raise RuntimeError("send failed")
      response = await routes.get_board_media_for_owner("abcdef12", db=None, principal=self.principal)
      with self.assertRaises(RuntimeError):
        await self.send_asgi(response, fail)
      self.assertTrue(response._opened.closed)

      blocked = asyncio.Event()
      async def stall(message):
        if message["type"] == "http.response.body":
          blocked.set()
          await asyncio.Event().wait()
      response = await routes.get_board_media_for_owner("abcdef12", db=None, principal=self.principal)
      task = asyncio.create_task(self.send_asgi(response, stall))
      await blocked.wait()
      task.cancel()
      with self.assertRaises(asyncio.CancelledError):
        await task
      self.assertTrue(response._opened.closed)

      response = await routes.get_board_media_for_owner("abcdef12", db=None, principal=self.principal)
      opened = response._opened
      del response
      gc.collect()
      self.assertTrue(opened.closed)

  async def test_expired_cached_media_survives_refresh_replacement_and_offline_failure(self):
    old, new = b"GIF89a-old", b"GIF89a-new"
    with (
      tempfile.TemporaryDirectory() as directory,
      patch.object(routes, "_peer_board_media_dir", return_value=Path(directory)),
      patch.object(routes, "_require_owner_or_common_app"),
    ):
      path = Path(directory) / f"{routes._peer_board_media_name(routes.COMMUNITY_HOST, 'abcdef12')}.gif"
      path.write_bytes(old)
      existing = await routes.get_board_media_for_owner("abcdef12", db=None, principal=self.principal)
      expired = time.time() - routes.BOARD_MEDIA_CACHE_TTL_S - 10
      os.utime(path, (expired, expired))
      started, release = asyncio.Event(), asyncio.Event()
      async def download(*args, **kwargs):
        started.set()
        await release.wait()
        return "image/gif", new
      with patch.object(routes, "_download_board_media", side_effect=download):
        task = asyncio.create_task(routes.get_board_media_for_owner("abcdef12", db=None, principal=self.principal))
        await started.wait()
        # A different cache writer replaces the path while this refresh waits.
        path.unlink()
        release.set()
        refreshed = await task
      self.assertEqual(b"".join(m.get("body", b"") for m in (await self.send_asgi(existing))[1:]), old)
      self.assertEqual(b"".join(m.get("body", b"") for m in (await self.send_asgi(refreshed))[1:]), new)
      self.assertTrue(existing._opened.closed)
      self.assertTrue(refreshed._opened.closed)

      os.utime(path, (expired, expired))
      with patch.object(routes, "_download_board_media", side_effect=RuntimeError("offline")):
        fallback = await routes.get_board_media_for_owner("abcdef12", db=None, principal=self.principal)
      self.assertEqual(b"".join(m.get("body", b"") for m in (await self.send_asgi(fallback))[1:]), new)
      self.assertTrue(fallback._opened.closed)

      # A refreshed format replaces the old name without invalidating a
      # response already opened on the previous format.
      os.utime(path, None)
      prior_format = await routes.get_board_media_for_owner("abcdef12", db=None, principal=self.principal)
      os.utime(path, (expired, expired))
      with patch.object(routes, "_download_board_media", new=AsyncMock(return_value=("image/png", b"png-new"))):
        changed = await routes.get_board_media_for_owner("abcdef12", db=None, principal=self.principal)
      self.assertFalse(path.exists())
      self.assertEqual(b"".join(m.get("body", b"") for m in (await self.send_asgi(prior_format))[1:]), new)
      self.assertEqual(b"".join(m.get("body", b"") for m in (await self.send_asgi(changed))[1:]), b"png-new")
      self.assertTrue(prior_format._opened.closed)
      self.assertTrue(changed._opened.closed)

  async def test_existing_reply_posters_above_new_output_budget_remain_readable(self):
    original = Image.frombytes("RGB", (640, 640), random.Random(1).randbytes(640 * 640 * 3))
    output = io.BytesIO()
    original.save(output, format="WEBP", quality=72, method=4)
    legacy_poster = output.getvalue()
    self.assertGreater(len(legacy_poster), routes.MAX_THUMBNAIL_BYTES)
    self.assertLess(len(legacy_poster), 1024 * 1024)

    async def download(method, url, **kwargs):
      if len(legacy_poster) > kwargs["max_response_bytes"]:
        raise ValueError("Response exceeds transfer budget")
      return httpx.Response(200, content=legacy_poster,
        headers={"content-type": "image/webp"}, request=httpx.Request(method, url))

    with patch.object(routes, "_require_owner_or_common_app"):
      self.discover.side_effect = download
      result = await routes.get_reply_media_for_owner(
        "abcdef12", "abcdef34", thumbnail=True, db=None, principal=self.principal)
    self.assertEqual(result.status_code, 200)
    self.assertLessEqual(len(result.body), routes.MAX_THUMBNAIL_BYTES)
    self.assertEqual(result.media_type, "image/webp")

  async def submit(self, kind, gallery=False):
    if kind == "reply":
      return await routes.reply_to_post(routes.ReplyPost(post_id="abcdef12", id="abcdef34", text="caption", attachment=self.attachment), db=None, principal=self.principal)
    body = routes.PublishPost(text="caption", **({"attachments": [{"mime": "image/png", "data_b64": "eA==", "w": 1, "h": 1}, self.attachment]} if gallery else {"attachment": self.attachment}))
    return await routes.publish_post(body, db=None, principal=self.principal)

  async def test_all_community_gif_sends_require_explicit_support_and_keep_captions(self):
    for kind, gallery in (("post", False), ("post", True), ("reply", False)):
      for supported in (False, "true", True):
        with self.subTest(kind=kind, gallery=gallery, supported=supported):
          self.send.reset_mock();self.discover.reset_mock()
          self.discover.return_value=self.response({"capabilities": {"reply_attachments": True, "gif_attachments": supported}})
          if supported is True:
            await self.submit(kind, gallery)
            envelope=self.send.await_args.args[1]
            self.assertEqual(envelope["text"], "caption")
            selected=envelope["attachments"][1] if gallery else envelope["attachment"]
            self.assertEqual(selected, self.attachment)
            self.assertEqual(self.discover.await_count, 1)
          else:
            with self.assertRaises(HTTPException) as caught:
              await self.submit(kind, gallery)
            self.assertEqual(caught.exception.status_code, 409)
            self.assertIn("animated GIFs", caught.exception.detail)
            self.send.assert_not_awaited()

  async def test_discovery_failure_never_starts_a_write(self):
    for kind in ("post", "reply"):
      self.send.reset_mock();self.discover.side_effect=httpx.ConnectError("offline")
      with self.assertRaises(HTTPException) as caught:
        await self.submit(kind)
      self.assertEqual(caught.exception.status_code, 502)
      self.send.assert_not_awaited()

  async def test_legacy_boolean_gif_capability_does_not_admit_large_media(self):
    self.discover.return_value = self.response({"capabilities": {
      "gif_attachments": True, "reply_attachments": True,
    }})
    large = {**self.attachment, "data_b64": base64.b64encode(b"x" * (1024 * 1024 + 1)).decode()}
    with self.assertRaises(HTTPException) as caught:
      await routes._require_community_media_support(
        "community.example", gif=True, originals=[(large, b"x" * (1024 * 1024 + 1))],
        envelope_bytes=1024 * 1024,
      )
    self.assertEqual(caught.exception.status_code, 409)
    self.send.assert_not_awaited()
    self.discover.return_value = self.response({"capabilities": {
      "gif_attachments": True,
    }, "media_limits": {"gif_bytes": 20 * 1024 * 1024,
                        "static_bytes": 5 * 1024 * 1024,
                        "combined_bytes": 20 * 1024 * 1024,
                        "thumbnail_bytes": 120 * 1024,
                        "max_images": 4,
                        "envelope_bytes": 60 * 1024 * 1024}})
    await routes._require_community_media_support(
      "community.example", gif=True, originals=[(large, b"x" * (1024 * 1024 + 1))],
      envelope_bytes=2 * 1024 * 1024 + 1,
    )

  async def test_gif_post_discovery_and_write_share_the_service_deadline(self):
    self.assertLess(routes.COMMUNITY_WRITE_TIMEOUT_S, 15)
    async def discover(*args, **kwargs):
      await asyncio.sleep(.02)
      return self.response({"capabilities": {"gif_attachments": True}})
    async def send(*args, **kwargs):
      await asyncio.sleep(.05)
    self.discover.side_effect=discover;self.send.side_effect=send
    with patch.object(routes, "COMMUNITY_WRITE_TIMEOUT_S", .04):
      with self.assertRaises(HTTPException) as caught:
        await self.submit("post")
    self.assertIn("may have been sent", caught.exception.detail)

  async def test_gif_post_capability_deadline_fails_closed(self):
    async def discover(*args, **kwargs):
      await asyncio.sleep(.05)
    self.discover.side_effect=discover
    with patch.object(routes, "COMMUNITY_WRITE_TIMEOUT_S", .02):
      with self.assertRaises(HTTPException) as caught:
        await self.submit("post")
    self.assertIn("support could not be checked", caught.exception.detail)
    self.send.assert_not_awaited()
