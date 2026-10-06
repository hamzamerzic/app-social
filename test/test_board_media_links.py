"""Social's server asks the community host for board images by CDN-cacheable links."""

import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from PIL import Image

with patch.dict(os.environ, {
  "APP_STORAGE_DIR": os.path.join(tempfile.gettempdir(), "social-board-media-tests"),
  "APP_ID": "7", "APP_SLUG": "social",
}):
  import social_routes

POST = "0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b"


def png() -> bytes:
  output = io.BytesIO()
  Image.new("RGB", (32, 24), "#5678ab").save(output, "PNG")
  return output.getvalue()


def host_url(path: str) -> str:
  return social_routes._peer_service_url(social_routes.COMMUNITY_HOST, path)


class BoardMediaLinkTests(unittest.IsolatedAsyncioTestCase):
  def setUp(self):
    temporary = tempfile.TemporaryDirectory()
    self.addCleanup(temporary.cleanup)
    cache_dir = patch.object(
      social_routes, "_peer_board_media_dir", return_value=Path(temporary.name),
    )
    cache_dir.start()
    self.addCleanup(cache_dir.stop)

  async def requested(self, index, *, thumbnail=False, recorded_mime=None, missing=0):
    download = AsyncMock(
      side_effect=[ValueError("missing")] * missing + [("image/png", png())],
    )
    with patch.object(social_routes, "_download_board_media", new=download):
      response = await social_routes._serve_owner_board_media(
        social_routes.COMMUNITY_HOST, POST, index, thumbnail, recorded_mime,
      )
    self.assertEqual(response.status_code, 200)
    return [awaited.args[0] for awaited in download.await_args_list]

  async def test_thumbnails_use_the_hosts_webp_link(self):
    self.assertEqual(
      await self.requested(None, thumbnail=True),
      [host_url(f"board/thumbnail/{POST}.webp")],
    )

  async def test_reply_proxy_uses_post_and_reply_scoped_link(self):
    reply_id = "1f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b"
    download = AsyncMock(return_value=("image/png", png()))
    with (
      patch.object(social_routes, "_require_owner_or_common_app"),
      patch.object(social_routes, "_download_board_media", new=download),
    ):
      response = await social_routes.get_reply_media_for_owner(
        POST, reply_id, False, "image/png", db=None, principal=None,
      )
    self.assertEqual(response.status_code, 200)
    self.assertEqual(response.body, png())
    self.assertEqual(response.headers["cache-control"], social_routes.OWNER_BOARD_IMAGE_CACHE)
    self.assertEqual(response.headers["x-content-type-options"], "nosniff")
    self.assertEqual(download.await_args.args[0], host_url(
      f"board/{POST}/replies/{reply_id}/media.png"))
    self.assertEqual(
      await self.requested(2, thumbnail=True),
      [host_url(f"board/thumbnail/{POST}/2.webp")],
    )

  async def test_full_images_use_the_type_the_post_records(self):
    self.assertEqual(
      await self.requested(1, recorded_mime="image/jpeg"),
      [host_url(f"board/media/{POST}/1.jpg")],
    )
    self.assertEqual(
      await self.requested(None, recorded_mime="image/png"),
      [host_url(f"board/media/{POST}.png")],
    )

  async def test_an_unknown_type_falls_back_to_the_bare_link(self):
    # Distinct images, since a fetched one is then served from Social's copy.
    for index, recorded_mime in ((2, None), (3, "text/html")):
      with self.subTest(recorded_mime=recorded_mime):
        self.assertEqual(
          await self.requested(index, recorded_mime=recorded_mime),
          [host_url(f"board/media/{POST}/{index}")],
        )

  async def test_a_missing_thumbnail_falls_back_to_the_full_image(self):
    self.assertEqual(
      await self.requested(0, thumbnail=True, missing=1),
      [host_url(f"board/thumbnail/{POST}/0.webp"), host_url(f"board/media/{POST}/0")],
    )

  async def test_the_owner_routes_pass_the_recorded_type_through(self):
    served = AsyncMock(return_value="served")
    with (
      patch.object(social_routes, "_require_owner_or_common_app"),
      patch.object(social_routes, "_serve_owner_board_media", new=served),
    ):
      await social_routes.get_board_media_for_owner(
        POST, thumbnail=False, mime="image/png", db=None, principal=None,
      )
      await social_routes.get_board_media_index_for_owner(
        POST, 1, thumbnail=False, mime="image/jpeg", db=None, principal=None,
      )
    self.assertEqual(
      [awaited.args for awaited in served.await_args_list],
      [
        (social_routes.COMMUNITY_HOST, POST, None, False, "image/png"),
        (social_routes.COMMUNITY_HOST, POST, 1, False, "image/jpeg"),
      ],
    )


if __name__ == "__main__":
  unittest.main()
