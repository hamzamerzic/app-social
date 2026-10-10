#!/usr/bin/env python3
"""JSON-v1 adapter for Social's app-owned ASGI service."""

from __future__ import annotations

import asyncio
import base64
import json
import sys
from urllib.parse import urlencode

import httpx
from fastapi import FastAPI, Request
from fastapi.exception_handlers import http_exception_handler
from starlette.exceptions import HTTPException

from service_runtime import migrate_legacy_state, reconcile_badge, reset_actor, set_actor
from social_groups import router as groups_router
from social_objects import router as objects_router
from social_routes import router as social_router


app = FastAPI()
app.include_router(social_router)
app.include_router(groups_router)
app.include_router(objects_router)


def _record_failure(diagnostics: dict, exc: Exception) -> None:
  cause = exc.__cause__ or exc
  diagnostics["error_type"] = type(cause).__name__
  if isinstance(cause, httpx.HTTPStatusError):
    diagnostics["upstream_status"] = cause.response.status_code


@app.exception_handler(HTTPException)
async def handled_failure(request: Request, exc: HTTPException):
  diagnostics = request.scope.get("mobius_diagnostics")
  if exc.status_code >= 500 and diagnostics is not None:
    _record_failure(diagnostics, exc)
  return await http_exception_handler(request, exc)


# Möbius may run everything above once and fork each request from it, which
# removes ~0.9 s of imports per request. Module setup therefore reads only
# per-installation values (APP_ID, APP_SLUG, APP_STORAGE_DIR) and starts no
# threads; APP_TOKEN and the request are read inside dispatch().
MOBIUS_PRELOAD = True


async def dispatch(request: dict) -> dict:
  migrate_legacy_state()
  query = request.get("query") if isinstance(request.get("query"), dict) else {}
  suffix = "/" + str(request.get("path") or "").lstrip("/")
  if query:
    suffix += "?" + urlencode(query, doseq=True)
  headers = request.get("headers") if isinstance(request.get("headers"), dict) else {}
  token = set_actor(request.get("actor") or {})
  diagnostics = {}

  async def diagnosed_app(scope, receive, send):
    scope["mobius_diagnostics"] = diagnostics
    try:
      await app(scope, receive, send)
    except Exception as exc:
      _record_failure(diagnostics, exc)
      raise
    finally:
      route = scope.get("route")
      if route is not None:
        diagnostics["route"] = route.path

  try:
    async with httpx.AsyncClient(
      transport=httpx.ASGITransport(app=diagnosed_app, raise_app_exceptions=False),
      base_url="http://social.service",
    ) as client:
      response = await client.request(
        str(request.get("method") or "GET"), suffix,
        headers=headers,
        json=request.get("body") if request.get("body") is not None else None,
      )
  finally:
    reset_actor(token)
  await reconcile_badge()
  media_type = response.headers.get("content-type", "").split(";", 1)[0].lower()
  forwarded = {
    name: value for name, value in response.headers.items()
    if name.lower() in {"cache-control", "etag", "last-modified"}
  }
  if media_type == "application/json" or media_type.endswith("+json"):
    try:
      body = response.json()
    except ValueError:
      body = {"detail": "Social returned invalid JSON."}
    return {"status": response.status_code, "body": body, "headers": forwarded, "diagnostics": diagnostics}
  return {
    "status": response.status_code,
    "body_base64": base64.b64encode(response.content).decode(),
    "media_type": media_type or "application/octet-stream",
    "headers": forwarded,
    "diagnostics": diagnostics,
  }


if __name__ == "__main__":
  try:
    print(json.dumps(asyncio.run(dispatch(json.load(sys.stdin))), separators=(",", ":")))
  except Exception as exc:
    print(f"Social service failed: {exc}", file=sys.stderr)
    raise SystemExit(1)
