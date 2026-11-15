"""
Shared fixtures for TC001-TC010 (black-box HTTP tests against a RUNNING backend).

Setup (see testsprite_tests/README.md):
  * backend started with DATABASE_URL=<test db>, SUPABASE_JWT_SECRET=<TC_JWT_SECRET>,
    DELHIVERY_BASE_URL=http://127.0.0.1:9099  (the stub below - nothing ever leaves the machine)
  * tests run with the same DATABASE_URL (they seed rows through the Django ORM) and TC_BASE_URL.

Every test gets its own workspace (unique slug) and the fixture deletes it afterwards,
so nothing is left behind. Real auth is used: each request carries an HS256 JWT.
"""
import json
import os
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer

import jwt
import pytest
import requests

BASE_URL = os.environ.get("TC_BASE_URL", "http://127.0.0.1:8002").rstrip("/")
JWT_SECRET = os.environ.get("TC_JWT_SECRET", "tc-only-jwt-secret-0123456789-abcdefghijklmnopqrstu")
STUB_PORT = int(os.environ.get("TC_DELHIVERY_STUB_PORT", "9099"))

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.dev")
os.environ.setdefault("SUPABASE_JWT_SECRET", JWT_SECRET)
import django  # noqa: E402

django.setup()

from apps.accounts.models import User  # noqa: E402
from apps.tenancy.models import Workspace  # noqa: E402


def make_jwt(user, secret=JWT_SECRET, exp_delta=3600):
    now = int(time.time())
    return jwt.encode(
        {"sub": str(user.id), "email": user.email, "aud": "authenticated", "iat": now, "exp": now + exp_delta},
        secret,
        algorithm="HS256",
    )


class DelhiveryStub:
    """Local stand-in for Delhivery. Records every request so tests can assert on what WOULD have been sent."""

    def __init__(self):
        self.requests = []
        stub = self

        class H(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                stub.requests.append({"path": self.path, "auth": self.headers.get("Authorization"), "json": json.loads(body or b"{}")})
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"request_id": "stub-1"}')

            def log_message(self, *a):
                pass

        self.server = HTTPServer(("127.0.0.1", STUB_PORT), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


@pytest.fixture(scope="session")
def delhivery_stub():
    s = DelhiveryStub()
    yield s
    s.server.shutdown()


@pytest.fixture(scope="session")
def tc_user():
    u, _ = User.objects.get_or_create(email="tc-owner@tc.test", defaults={"first_name": "TC", "last_name": "Owner"})
    return u


class Api:
    def __init__(self, user):
        self.user = user
        self.s = requests.Session()
        self.s.headers.update({"Authorization": f"Bearer {make_jwt(user)}", "Accept": "application/json"})

    def req(self, method, path, **kw):
        kw.setdefault("timeout", 30)
        return self.s.request(method, BASE_URL + path, **kw)

    get = lambda self, p, **kw: self.req("GET", p, **kw)  # noqa: E731
    post = lambda self, p, **kw: self.req("POST", p, **kw)  # noqa: E731
    delete = lambda self, p, **kw: self.req("DELETE", p, **kw)  # noqa: E731


@pytest.fixture
def api(tc_user):
    return Api(tc_user)


@pytest.fixture
def anon():
    s = requests.Session()
    return lambda path, **kw: s.get(BASE_URL + path, timeout=30, **kw)


@pytest.fixture
def ws(api, tc_user):
    """A fresh workspace+brand created through the public API; deleted through the API afterwards."""
    name = f"tc-{uuid.uuid4().hex[:10]}"
    r = api.post("/api/w/", json={"name": name})
    assert r.status_code == 201, r.text
    data = r.json()
    slug, brand_id = data["slug"], data["brands"][0]["id"]
    ns = type("WS", (), {})()
    ns.slug, ns.brand_id, ns.name = slug, brand_id, name
    ns.base = f"/api/w/{slug}/b/{brand_id}"
    ns.workspace = Workspace.objects.get(slug=slug)
    yield ns
    r = api.delete(f"/api/w/{slug}/")
    assert r.status_code == 204, f"cleanup failed: {r.status_code} {r.text}"
    assert not Workspace.objects.filter(slug=slug).exists(), "workspace left behind"
