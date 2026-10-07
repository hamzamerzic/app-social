"""Social reports the Messages unread total as its sidebar badge."""

import asyncio
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

for _key, _value in {
  "APP_STORAGE_DIR": tempfile.gettempdir(), "APP_ID": "7", "APP_SLUG": "social",
  "APP_TOKEN": "test-app-token", "API_BASE_URL": "http://127.0.0.1:9",
  "INSTANCE_DOMAIN": "self.example", "INSTANCE_ORIGIN": "https://self.example",
}.items():
  os.environ.setdefault(_key, _value)

import service_runtime  # noqa: E402



def _meta(root: Path, kind: str, name: str, meta: dict) -> None:
  path = root / kind / name / "meta.json"
  path.parent.mkdir(parents=True)
  path.write_text(json.dumps(meta))


class UnreadBadgeTests(unittest.TestCase):
  def setUp(self):
    self.tmp = tempfile.TemporaryDirectory()
    self.root = Path(self.tmp.name)
    self.addCleanup(self.tmp.cleanup)

  def test_total_counts_accepted_conversations_and_groups_only(self):
    _meta(self.root, "conversations", "a", {"unread": 3})  # pre-requests legacy
    _meta(self.root, "conversations", "b", {"unread": 2, "request_status": "accepted"})
    _meta(self.root, "conversations", "c", {"unread": 4, "request_status": "pending"})
    _meta(self.root, "conversations", "d", {"unread": 9, "request_status": "blocked"})
    _meta(self.root, "groups", "g", {"unread": 1, "request_status": "accepted"})
    (self.root / "groups" / "broken").mkdir()
    (self.root / "groups" / "broken" / "meta.json").write_text("{not json")
    self.assertEqual(service_runtime.unread_total(self.root), 6)

  def _flush_with(self, status):
    sent = []

    class Response:
      status_code = status

      def raise_for_status(self):
        if status >= 400:
          raise RuntimeError(f"HTTP {status}")

    async def fake_request(method, path, *, json_body=None):
      sent.append((method, path, json_body))
      return Response()

    original = service_runtime.platform_request
    service_runtime.platform_request = fake_request
    env = patch.dict(os.environ, {"APP_STORAGE_DIR": str(self.root)})
    env.start()
    try:
      asyncio.run(service_runtime.flush_badge())
    finally:
      env.stop()
      service_runtime.platform_request = original
    return sent

  def test_only_a_request_that_changed_storage_reports_the_total(self):
    _meta(self.root, "conversations", "a", {"unread": 2})
    service_runtime._badge_dirty = False
    self.assertEqual(self._flush_with(204), [])  # a read-only request
    service_runtime.mark_badge_dirty()
    before = time.time_ns()
    sent = self._flush_with(204)
    self.assertEqual(len(sent), 1)
    method, path, body = sent[0]
    self.assertEqual((method, path), ("PUT", f"/api/apps/{service_runtime.APP.id}/badge"))
    self.assertEqual(body["count"], 2)
    # Taken before counting, from a clock: later reports always order after,
    # even if Social's own data (and its storage counter) is wiped or restored.
    self.assertGreaterEqual(body["version"], before)
    self.assertFalse(service_runtime._badge_dirty)

  def test_report_failures_and_older_platforms_never_fail_the_request(self):
    _meta(self.root, "conversations", "a", {"unread": 1})
    for status in (404, 500):
      service_runtime.mark_badge_dirty()
      self.assertEqual(len(self._flush_with(status)), 1)  # no exception raised



class DispatchReportsBadgeTests(unittest.TestCase):
  """A real request through the service entry point reports the new total."""

  def test_reading_a_conversation_reports_the_cleared_total(self):
    import service
    import social_routes

    tmp = tempfile.TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    root = Path(tmp.name)
    _meta(root, "conversations", "peer.example", {"unread": 2})
    _meta(root, "groups", "g1", {"unread": 1, "request_status": "accepted"})
    sent = []

    class Response:
      status_code = 204

      def raise_for_status(self):
        pass

    async def fake_request(method, path, *, json_body=None):
      sent.append((method, path, json_body))
      return Response()

    service_runtime._badge_dirty = False
    with (
      patch.dict(os.environ, {"APP_STORAGE_DIR": str(root)}),
      patch.object(service_runtime, "platform_request", new=fake_request),
      patch.object(social_routes, "_require_member", return_value=service_runtime.APP),
      patch.object(service, "migrate_legacy_state"),
    ):
      reply = asyncio.run(service.dispatch({
        "method": "POST", "path": "conversations/peer.example/read",
        "body": {}, "actor": {"scope": "owner"},
      }))
    self.assertEqual(reply.get("status"), 200, reply)
    self.assertEqual(len(sent), 1)
    method, path, body = sent[0]
    self.assertEqual((method, path), ("PUT", f"/api/apps/{service_runtime.APP.id}/badge"))
    self.assertEqual(body["count"], 1)  # the read conversation cleared; the group remains
    self.assertGreaterEqual(body["version"], 1)


if __name__ == "__main__":
  unittest.main()
