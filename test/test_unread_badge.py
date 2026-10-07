"""Social keeps its Möbius sidebar badge reconciled with the Messages unread total."""

import asyncio
import json
import os
import tempfile
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
  path.parent.mkdir(parents=True, exist_ok=True)
  path.write_text(json.dumps(meta))


def _version(root: Path, v: int) -> None:
  (root / "state").mkdir(parents=True, exist_ok=True)
  (root / "state" / "version.json").write_text(json.dumps({"v": v}))


class FakePlatform:
  """Möbius's badge endpoint: ordering by revision, unrevisioned resets."""

  def __init__(self):
    self.count, self.revision, self.calls, self.fail, self.status = 0, None, [], False, 200

  async def request(self, method, path, *, json_body=None):
    self.calls.append(json_body)
    platform = self

    class Response:
      status_code = platform.status

      def raise_for_status(self):
        if platform.fail:
          raise RuntimeError("platform unavailable")

      def json(self):
        return reply

    if self.fail or self.status != 200:
      reply = None
      return Response()
    revision = json_body.get("revision")
    applied = revision is None or self.revision is None or revision > self.revision
    if applied:
      self.count, self.revision = json_body["count"], revision
    reply = {"count": self.count, "revision": self.revision, "applied": applied}
    return Response()


class BadgeTests(unittest.TestCase):
  def setUp(self):
    tmp = tempfile.TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    self.root = Path(tmp.name)
    self.platform = FakePlatform()
    for patcher in (
      patch.dict(os.environ, {"APP_STORAGE_DIR": str(self.root)}),
      patch.object(service_runtime, "STORAGE", self.root),
      patch.object(service_runtime, "platform_request", new=self.platform.request),
    ):
      patcher.start()
      self.addCleanup(patcher.stop)

  def reconcile(self):
    asyncio.run(service_runtime.reconcile_badge())

  def write(self, version, **metas):
    """A storage transaction: change metadata, then record at its version."""
    for name, meta in metas.items():
      _meta(self.root, "conversations", name, meta)
    _version(self.root, version)
    service_runtime.record_badge(self.root, version)

  def test_total_uses_the_same_status_rule_as_the_messages_tab(self):
    _meta(self.root, "conversations", "legacy", {"unread": 3})
    _meta(self.root, "conversations", "accepted", {"unread": 2, "request_status": "accepted"})
    _meta(self.root, "conversations", "future", {"unread": 1, "request_status": "archived"})
    for hidden in ("pending", "declined", "blocked"):
      _meta(self.root, "conversations", hidden, {"unread": 9, "request_status": hidden})
    _meta(self.root, "groups", "g", {"unread": 1, "request_status": "accepted"})
    (self.root / "groups" / "broken").mkdir()
    (self.root / "groups" / "broken" / "meta.json").write_text("{not json")
    self.assertEqual(service_runtime.unread_total(self.root), 7)

  def test_existing_unread_messages_are_reported_on_the_first_request(self):
    # An installation upgraded to this version already holds unread messages;
    # any request (here a read-only one) brings the sidebar up to date.
    _meta(self.root, "conversations", "peer", {"unread": 2})
    _version(self.root, 40)
    self.reconcile()
    self.assertEqual((self.platform.count, self.platform.revision), (2, 40))
    self.reconcile()
    self.assertEqual(len(self.platform.calls), 1)  # acknowledged: nothing to resend

  def test_a_failed_report_is_retried_by_a_later_request(self):
    self.write(5, peer={"unread": 2})
    self.reconcile()
    self.write(6, peer={"unread": 0})  # the conversation was read
    self.platform.fail = True
    self.reconcile()
    self.assertEqual(self.platform.count, 2)
    # The platform recovers; the next request of any kind repairs the badge,
    # even though reading an already-read conversation changes nothing.
    self.platform.fail = False
    self.reconcile()
    self.assertEqual((self.platform.count, self.platform.revision), (0, 6))

  def test_writes_that_do_not_change_the_count_do_not_report(self):
    self.write(5, peer={"unread": 1})
    self.reconcile()
    self.write(6, peer={"unread": 1, "last_text": "edited"})
    self.reconcile()
    self.assertEqual(len(self.platform.calls), 1)

  def test_a_stale_snapshot_never_resets_a_newer_count(self):
    # Another request already reported revision 9 (count 0); this request's
    # snapshot is revision 8 (count 4). It is stale, not a restore.
    self.platform.count, self.platform.revision = 0, 9
    _version(self.root, 9)
    (self.root / "state" / "badge.json").write_text(json.dumps({"revision": 8, "count": 4}))
    self.reconcile()
    self.assertEqual((self.platform.count, self.platform.revision), (0, 9))
    self.assertEqual(self.platform.calls, [{"count": 4, "revision": 8}])

  def test_restored_storage_resets_the_ordering(self):
    # Möbius last accepted revision 300; Social's data was then restored from
    # a backup at revision 12, so its own reports would all look stale.
    self.platform.count, self.platform.revision = 5, 300
    self.write(12, peer={"unread": 1})
    self.reconcile()
    self.assertEqual(self.platform.calls[-1], {"count": 1})
    self.assertEqual(self.platform.count, 1)
    self.write(13, peer={"unread": 0})
    self.reconcile()
    self.assertEqual((self.platform.count, self.platform.revision), (0, 13))

  def test_an_older_mobius_is_asked_again_hourly_and_gets_the_badge_once_upgraded(self):
    self.platform.status = 404
    self.write(5, peer={"unread": 1})
    now = 1_000_000.0
    with patch.object(service_runtime.time, "time", side_effect=lambda: now):
      self.reconcile()
      self.reconcile()  # within the hour: not asked again
      self.assertEqual(len(self.platform.calls), 1)
      # Möbius is upgraded; unread messages already exist, and the next retry
      # reports them without waiting for the unread count to change.
      self.platform.status = 200
      now += service_runtime.BADGE_UNSUPPORTED_RETRY_SECONDS
      self.reconcile()
    self.assertEqual((self.platform.count, self.platform.revision), (1, 5))
    self.reconcile()
    self.assertEqual(len(self.platform.calls), 2)  # acknowledged now


class DispatchReconcilesBadgeTests(unittest.TestCase):
  """A real request through the service entry point updates the sidebar."""

  def test_reading_a_conversation_reports_the_cleared_total(self):
    import service
    import social_routes

    tmp = tempfile.TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    root = Path(tmp.name)
    _meta(root, "conversations", "peer.example", {"unread": 2})
    _meta(root, "groups", "g1", {"unread": 1, "request_status": "accepted"})
    platform = FakePlatform()
    with (
      patch.dict(os.environ, {"APP_STORAGE_DIR": str(root)}),
      patch.object(service_runtime, "STORAGE", root),
      patch.object(service_runtime, "platform_request", new=platform.request),
      patch.object(social_routes, "_require_member", return_value=service_runtime.APP),
      patch.object(service, "migrate_legacy_state"),
    ):
      reply = asyncio.run(service.dispatch({
        "method": "POST", "path": "conversations/peer.example/read",
        "body": {}, "actor": {"scope": "owner"},
      }))
    self.assertEqual(reply.get("status"), 200, reply)
    self.assertEqual(platform.count, 1)  # the read conversation cleared; the group remains
    self.assertGreaterEqual(platform.revision, 1)


if __name__ == "__main__":
  unittest.main()
