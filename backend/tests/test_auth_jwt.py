"""JWT auth: expired, malformed, wrong-secret, wrong-audience, alg=none, refresh. All 401 with no data."""
import base64
import json
import time

import jwt
import pytest
from rest_framework.test import APIClient

from tests.conftest import TEST_JWT_SECRET, make_token

ENDPOINTS = ["/api/w/", "/api/auth/me"]


def bearer(token):
    c = APIClient()
    c.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")
    return c


def b64(d):
    return base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()


@pytest.mark.django_db
class TestJwt:
    @pytest.mark.parametrize("path", ENDPOINTS)
    def test_valid_token_ok(self, user_a, workspace_a, path):
        res = bearer(make_token(user_a)).get(path)
        assert res.status_code == 200, res.content

    @pytest.mark.parametrize("path", ENDPOINTS + ["/api/w/125-east/"])
    def test_bad_tokens_are_401_without_data(self, user_a, workspace_a, path):
        now = int(time.time())
        bad = {
            "expired": make_token(user_a, exp_delta=-60),
            "wrong_secret": make_token(user_a, secret="a-different-secret-0123456789-abcdefghijklmnop"),
            "wrong_audience": make_token(user_a, aud="somebody-else"),
            "no_exp": jwt.encode({"sub": str(user_a.id), "email": user_a.email, "aud": "authenticated"},
                                 TEST_JWT_SECRET, algorithm="HS256"),
            "alg_none": f"{b64({'alg': 'none', 'typ': 'JWT'})}.{b64({'sub': str(user_a.id), 'email': user_a.email, 'aud': 'authenticated', 'exp': now + 999})}.",
            "malformed_garbage": "not.a.jwt",
            "malformed_one_segment": "abc",
            "truncated": make_token(user_a)[:-10],
            "tampered_payload": (lambda t: ".".join([t.split(".")[0], b64({"sub": str(user_a.id), "email": "x@evil.test", "aud": "authenticated", "exp": now + 999}), t.split(".")[2]]))(make_token(user_a)),
        }
        for label, token in bad.items():
            res = bearer(token).get(path)
            assert res.status_code == 401, f"{label} -> {res.status_code} {res.content[:100]}"
            body = res.content.decode()
            assert user_a.email not in body and "125 East Apparel" not in body, f"{label} leaked data"

    def test_empty_bearer_and_no_header_do_not_authenticate(self, workspace_a):
        assert bearer("").get("/api/auth/me").status_code in (401, 403)
        assert APIClient().get("/api/auth/me").status_code in (401, 403)

    def test_dev_bypass_tokens_are_rejected(self, user_a):
        for t in ("dev-mock-token", "mock-token", "test-token", "dev-anything"):
            assert bearer(t).get("/api/auth/me").status_code == 401, t

    def test_refresh_flow_old_expires_new_works(self, user_a, workspace_a):
        """Supabase refresh issues a new JWT for the same sub: the expired one stays dead, the new one works."""
        expired = make_token(user_a, exp_delta=-1)
        assert bearer(expired).get("/api/w/").status_code == 401
        refreshed = make_token(user_a, exp_delta=3600)  # what supabase.auth.refreshSession() returns
        res = bearer(refreshed).get("/api/w/")
        assert res.status_code == 200
        assert [w["slug"] for w in res.json()] == ["125-east"]

    def test_token_for_deleted_or_unknown_user_does_not_see_other_tenants(self, workspace_a, user_a):
        """A valid token for a brand-new identity is auto-provisioned but has no memberships => sees nothing."""
        class U:  # unknown identity signed with the right secret
            id = "11111111-1111-1111-1111-111111111111"
            email = "stranger@nowhere.test"

        res = bearer(make_token(U)).get("/api/w/")
        assert res.status_code == 200 and res.json() == []
        assert bearer(make_token(U)).get(f"/api/w/{workspace_a.slug}/").status_code == 404
