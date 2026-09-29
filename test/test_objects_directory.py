"""Shared-object invitations cannot bypass Social's People membership gate."""

import os
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

os.environ.setdefault("APP_STORAGE_DIR", "/tmp/social-objects-directory-tests")
os.environ.setdefault("APP_ID", "7")
os.environ.setdefault("APP_SLUG", "social")

import social_objects


class ObjectDirectoryTests(unittest.IsolatedAsyncioTestCase):
  async def test_unjoined_bare_handle_cannot_search_directory(self):
    search = AsyncMock()
    with (
      patch.object(social_objects, "resolve_handle_hosts", new=AsyncMock(return_value=None)),
      patch.object(social_objects, "_load_identity", return_value={}),
      patch.object(social_objects, "_search_community_members", new=search),
    ):
      with self.assertRaises(HTTPException) as raised:
        await social_objects._resolve_invitees("alex")
    self.assertEqual(raised.exception.status_code, 403)
    search.assert_not_awaited()

  async def test_joined_bare_handle_uses_signed_member_search(self):
    search = AsyncMock(return_value={
      "users": [{"host": "alex.example", "handle": "alex"}],
    })
    with (
      patch.object(social_objects, "resolve_handle_hosts", new=AsyncMock(return_value=None)),
      patch.object(social_objects, "_load_identity", return_value={
        "joined_at": 1, "directory_synced": {"handle": "owner"},
      }),
      patch.object(social_objects, "_search_community_members", new=search),
    ):
      recipient = await social_objects._resolve_invitees("alex")
    self.assertEqual(recipient.hosts, ["alex.example"])
    search.assert_awaited_once_with("alex")
