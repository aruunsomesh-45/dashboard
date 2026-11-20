"""
Email/password + server-side session authentication, end to end through the real endpoints.

Covers: register, duplicate email, login (valid / wrong password / unknown email), logout, protected routes with and
without a session, session expiry, workspace creation + owner membership, multiple workspaces per user, and
workspace isolation. No Firebase/Supabase/bearer tokens exist any more; one test pins that down.
"""
from datetime import timedelta
from unittest import mock

import pytest
from apps.accounts.models import User
from apps.tenancy.models import Workspace, WorkspaceMember
from django.conf import settings
from django.core.cache import cache
from django.utils import timezone
from freezegun import freeze_time
from rest_framework.test import APIClient

pytestmark = pytest.mark.django_db

PW = "Correct-Horse-Battery-9"
ME = "/api/auth/me/"


@pytest.fixture(autouse=True)
def _offline():
    cache.clear()
    with mock.patch("urllib.request.urlopen", side_effect=OSError("offline")):  # HaveIBeenPwned
        yield


def register(client, email, workspace="Acme", password=PW):
    return client.post(
        "/api/auth/register/",
        {"workspace_name": workspace, "email": email, "password": password, "confirm_password": password},
        format="json",
    )


def login(client, email, password=PW):
    return client.post("/api/auth/login/", {"email": email, "password": password}, format="json")


class TestAuthentication:
    def test_register_then_access_dashboard_data(self):
        c = APIClient()
        res = register(c, "alice@a.test", "Alice Co")
        assert res.status_code == 201, res.content
        slug = res.json()["workspace"]["slug"]
        brand = res.json()["workspaces"][0]["brands"][0]["id"]

        assert c.get(ME).status_code == 200
        assert c.get(f"/api/w/{slug}/").status_code == 200
        assert c.get(f"/api/w/{slug}/b/{brand}/metrics/").status_code == 200

    def test_register_existing_email(self):
        register(APIClient(), "dup@a.test")
        res = register(APIClient(), "DUP@a.test", "Other")
        assert res.status_code == 400
        assert res.json()["error"] == "An account with this email already exists."
        assert User.objects.filter(email__iexact="dup@a.test").count() == 1

    def test_login_valid_credentials(self):
        register(APIClient(), "bob@a.test")
        c = APIClient()
        res = login(c, "Bob@A.test")  # email is case-insensitive
        assert res.status_code == 200, res.content
        body = res.json()
        assert body["mfa_required"] is False and body["redirect"] == "/dashboard"
        assert body["workspaces"][0]["role"] == "owner"
        assert c.get(ME).json()["user"]["email"] == "bob@a.test"

    def test_login_wrong_password_and_unknown_email_look_identical(self):
        register(APIClient(), "carol@a.test")
        wrong = login(APIClient(), "carol@a.test", "Wrong-Password-000")
        unknown = login(APIClient(), "nobody@a.test")
        assert wrong.status_code == unknown.status_code == 400
        assert wrong.json() == unknown.json()
        assert wrong.json()["error"] == "Invalid email or password."

    def test_login_validation(self):
        res = APIClient().post("/api/auth/login/", {"email": "not-an-email"}, format="json")
        assert res.status_code == 400
        assert {"email", "password"} <= set(res.json()["fields"])

    def test_logout_ends_session(self):
        c = APIClient()
        register(c, "dave@a.test")
        assert c.post("/api/auth/logout/").status_code == 200
        assert c.get(ME).status_code == 401
        assert c.get("/api/w/").status_code == 401

    def test_protected_routes_without_session(self):
        c = APIClient()
        res = c.get(ME)
        assert res.status_code == 401
        assert res.headers.get("WWW-Authenticate", "").startswith("Session")
        assert c.get("/api/w/").status_code == 401

    def test_bearer_tokens_are_not_an_authentication_method(self):
        register(APIClient(), "erin@a.test")
        c = APIClient()
        c.credentials(HTTP_AUTHORIZATION="Bearer dev-mock-token")
        assert c.get(ME).status_code == 401

    def test_session_expires(self):
        c = APIClient()
        with freeze_time(timezone.now()) as clock:
            register(c, "frank@a.test")
            assert c.get(ME).status_code == 200
            clock.tick(timedelta(seconds=settings.SESSION_COOKIE_AGE - 60))
            assert c.get(ME).status_code == 200, "still valid just before expiry"
            clock.tick(timedelta(seconds=120))
            assert c.get(ME).status_code == 401, "session must expire after SESSION_COOKIE_AGE"

    def test_session_id_is_rotated_on_login(self):
        c = APIClient()
        c.get("/api/auth/csrf/")
        register(APIClient(), "gina@a.test")
        c.cookies[settings.SESSION_COOKIE_NAME] = "attacker-chosen-session-id"
        login(c, "gina@a.test")
        assert c.cookies[settings.SESSION_COOKIE_NAME].value != "attacker-chosen-session-id"


class TestWorkspaces:
    def test_workspace_and_owner_membership_saved(self):
        res = register(APIClient(), "owner@w.test", "Saved Workspace")
        ws = Workspace.objects.get(slug=res.json()["workspace"]["slug"])
        assert ws.name == "Saved Workspace" and ws.is_active
        member = WorkspaceMember.objects.get(workspace=ws)
        assert member.user.email == "owner@w.test" and member.role == "owner"

    def test_user_can_own_multiple_workspaces(self):
        c = APIClient()
        register(c, "multi@w.test", "First")
        res = c.post("/api/w/", {"name": "Second"}, format="json")
        assert res.status_code == 201, res.content
        names = sorted(w["name"] for w in c.get(ME).json()["workspaces"])
        assert names == ["First", "Second"]
        assert {w["role"] for w in c.get(ME).json()["workspaces"]} == {"owner"}

    def test_workspace_isolation(self):
        a, b = APIClient(), APIClient()
        ws_a = register(a, "a@iso.test", "Tenant A").json()["workspaces"][0]
        ws_b = register(b, "b@iso.test", "Tenant B").json()["workspaces"][0]

        # Each user sees only their own workspace.
        assert [w["slug"] for w in a.get(ME).json()["workspaces"]] == [ws_a["slug"]]
        assert [w["slug"] for w in b.get("/api/w/").json()] == [ws_b["slug"]]

        # Without membership, the other tenant's routes are indistinguishable from non-existent ones.
        brand_a = ws_a["brands"][0]["id"]
        assert b.get(f"/api/w/{ws_a['slug']}/").status_code == 404
        assert b.get(f"/api/w/{ws_a['slug']}/members/").status_code == 404
        assert b.get(f"/api/w/{ws_a['slug']}/b/{brand_a}/metrics/").status_code == 404
        assert b.post(f"/api/w/{ws_a['slug']}/brands/", {"name": "x"}, format="json").status_code == 404
        # ...and B's own brand id can't be used under A's slug either.
        assert a.get(f"/api/w/{ws_a['slug']}/b/{ws_b['brands'][0]['id']}/metrics/").status_code == 404

    def test_membership_grants_access(self):
        a, b = APIClient(), APIClient()
        ws_a = register(a, "a2@iso.test", "Shared").json()["workspace"]
        register(b, "b2@iso.test", "B Own")
        assert b.get(f"/api/w/{ws_a['slug']}/").status_code == 404
        WorkspaceMember.objects.create(
            workspace=Workspace.objects.get(id=ws_a["id"]), user=User.objects.get(email="b2@iso.test"), role="viewer"
        )
        assert b.get(f"/api/w/{ws_a['slug']}/").status_code == 200
        assert len(b.get(ME).json()["workspaces"]) == 2
