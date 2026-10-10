"""Diagnostics preserve request shape, not content or concrete identifiers."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class ServiceDiagnosticsTests(unittest.TestCase):
    def test_manifest_declares_every_code_authored_service_route(self):
        source = '''
import json, service
print(json.dumps(sorted({
    route.path
    for router in (service.social_router, service.groups_router, service.objects_router)
    for route in router.routes
})))
'''
        root = Path(__file__).parents[1]
        with tempfile.TemporaryDirectory() as directory:
            env = {**os.environ, 'APP_ID': '9', 'APP_SLUG': 'social',
                   'APP_STORAGE_DIR': directory, 'INSTANCE_DOMAIN': 'self.example',
                   'INSTANCE_ORIGIN': 'https://self.example',
                   'API_BASE_URL': 'http://127.0.0.1:1', 'APP_TOKEN': 'fixture-not-a-credential'}
            result = subprocess.run([sys.executable, '-c', source], cwd=root, env=env,
                                    capture_output=True, text=True, check=True)
        declared = json.loads((root / 'mobius.json').read_text())['service']['diagnostics_routes']
        self.assertEqual(declared, json.loads(result.stdout))
        self.assertIn('/replies/{post_id}', declared)
        self.assertNotIn('/replies/private-id', declared)

    def test_routes_failures_and_concurrent_requests(self):
        source = r'''
import asyncio,json
import httpx
from fastapi import FastAPI, HTTPException
import service

app = FastAPI()
app.add_exception_handler(HTTPException, service.handled_failure)
service.app = app
service.migrate_legacy_state = lambda: None
async def noop(): pass
service.reconcile_badge = noop

@app.get('/replies/{post_id}')
async def replies(post_id: str):
    request = httpx.Request('GET', 'https://peer.example/private-id?token=private-token')
    response = httpx.Response(404, request=request)
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(502, 'private failure message') from exc

@app.get('/boom/{item_id}')
async def boom(item_id: str):
    raise ValueError('private error text')

@app.get('/okay')
async def okay(): return {'ok':True}

async def main():
    responses = await asyncio.gather(*[
        service.dispatch({'method':'GET','path':path,'actor':{'scope':'owner'},
                          'query':{'secret':['private-query']}})
        for path in ['replies/private-post','boom/private-item','okay']
    ])
    print(json.dumps(responses))
asyncio.run(main())
'''
        with tempfile.TemporaryDirectory() as directory:
            env = {**os.environ, 'APP_ID':'9','APP_SLUG':'social',
                   'APP_STORAGE_DIR':directory, 'INSTANCE_DOMAIN':'self.example',
                   'INSTANCE_ORIGIN':'https://self.example','API_BASE_URL':'http://127.0.0.1:1',
                   'APP_TOKEN':'fixture-not-a-credential'}
            result = subprocess.run([sys.executable,'-c',source],
                                    cwd=Path(__file__).parents[1], env=env,
                                    capture_output=True, text=True, check=True)
        replies, boom, okay = json.loads(result.stdout)
        self.assertEqual(replies['status'],502)
        self.assertEqual(replies['diagnostics'], {
            'route':'/replies/{post_id}', 'error_type':'HTTPStatusError','upstream_status':404})
        self.assertEqual(boom['status'],500)
        self.assertEqual(boom['diagnostics'], {'route':'/boom/{item_id}','error_type':'ValueError'})
        self.assertEqual(okay['diagnostics'], {'route':'/okay'})
        self.assertEqual(okay['body'], {'ok':True})
        self.assertNotIn('private', json.dumps([r['diagnostics'] for r in [replies,boom,okay]]))
