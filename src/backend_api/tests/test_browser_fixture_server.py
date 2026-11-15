"""The explicit browser-test fixture command must remain isolated and offline."""
import contextlib
import io
import os
import runpy
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


class BrowserFixtureServerTests(unittest.TestCase):
    def test_temporary_fixture_serves_real_routes_and_can_expire_snapshot(self):
        import httpx
        import app as api
        from fastapi.testclient import TestClient
        script = Path(__file__).resolve().parents[3] / "tools" / "browser-fixture-server.py"
        def exercise(server):
            with TestClient(server.config.app) as client:
                fixture = client.get("/test-fixture").json()
                self.assertEqual(fixture["observationCount"], 702)
                manifest = client.get("/global/manifest").json()
                self.assertEqual(manifest["count"], 702)
                selected = {"snapshotId": fixture["snapshotId"], "options": {"search": fixture["observationIds"][-1]}}
                page = client.post("/global/observations", json=selected)
                self.assertEqual(page.status_code, 200)
                self.assertEqual(page.json()["data"]["total"], 1)
                expired = client.post("/test-fixture/expire-snapshot").json()
                self.assertEqual(expired["expiredSnapshotId"], fixture["snapshotId"])
                self.assertNotEqual(expired["replacementSnapshotId"], fixture["snapshotId"])
                self.assertEqual(client.post("/global/observations", json=selected).status_code, 410)
                self.assertEqual(client.get("/test-fixture").json()["upstreamAttempts"], [])
                self.assertEqual(client.post("/test-fixture/shutdown").json()["status"], "stopping")
                self.assertTrue(server.should_exit)
        original_transport = httpx.AsyncHTTPTransport.handle_async_request
        with patch.dict(os.environ), patch.object(sys, "argv", [str(script)]), patch("uvicorn.Server.run", autospec=True, side_effect=exercise), patch.object(httpx.AsyncHTTPTransport, "handle_async_request", original_transport), patch.object(api.app, "middleware_stack", None), patch.object(api.app, "user_middleware", list(api.app.user_middleware)), patch.object(api.app.router, "routes", list(api.app.router.routes)), contextlib.redirect_stdout(io.StringIO()):
            runpy.run_path(str(script), run_name="__main__")
