"""New animations fail closed against old hosts without weakening write deadlines."""
import asyncio
import base64
import io
import os
import unittest
from unittest.mock import AsyncMock, patch
import httpx
from fastapi import HTTPException
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
