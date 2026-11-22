"""
Authentication security tests: registration, password reset, login, throttling, MFA, recovery codes, sessions,
CSRF and password storage.

Every test asserts on a protection, so it fails if that protection is removed.
No live third-party calls: the HaveIBeenPwned lookup (urllib) is forced offline for every test.

Registration contract: POST /api/auth/register/ {workspace_name, email, password, confirm_password} creates the
user, the workspace and the owner membership in one transaction and signs the user in (201). A duplicate email
answers 400 with a clear message (the product chose explicit feedback over enumeration resistance here; login and
password reset stay non-enumerating).
"""
import hashlib
import json
import os
import re
import statistics
import subprocess
import sys
import time
import uuid
from datetime import UTC, datetime, timedelta
from importlib import import_module
from unittest import mock

import pyotp
import pytest
from apps.accounts.models import MFARecoveryCode, User
from apps.accounts.services import generate_recovery_codes
from apps.tenancy.models import Brand, Workspace, WorkspaceMember
from django.conf import settings
from django.contrib.auth.hashers import identify_hasher
from django.contrib.auth.password_validation import CommonPasswordValidator
from django.core import mail
from django.core.cache import cache
from django.db import connection
from django.test import override_settings
from django.urls import URLResolver, get_resolver
from freezegun import freeze_time
from rest_framework.test import APIClient
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from tests.conftest import DEFAULT_PASSWORD

REGISTER = "/api/auth/register/"
PASSWORD_RESET = "/api/auth/password-reset/"
PASSWORD_RESET_CONFIRM = "/api/auth/password-reset/confirm/"
LOGIN = "/api/auth/login/"
CHALLENGE = "/api/auth/mfa/challenge/"
MFA_SETUP = "/api/auth/mfa/setup/"
MFA_CONFIRM = "/api/auth/mfa/confirm/"
LOGOUT = "/api/auth/logout/"
ME = "/api/auth/me/"
CSRF = "/api/auth/csrf/"

STRONG_PASSWORD = "Tr0ub4dor&Zebra-Lantern"
ARGON2 = "django.contrib.auth.hashers.Argon2PasswordHasher"

pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
def _isolation():
    """Fresh throttle counters per test, and no live HaveIBeenPwned call (lookup behaves as if offline)."""
    cache.clear()
    with mock.patch("urllib.request.urlopen", side_effect=OSError("network disabled in tests")):
        yield
    cache.clear()


def login(client, email, password=DEFAULT_PASSWORD):
    return client.post(LOGIN, {"email": email, "password": password}, format="json")


def register(client, email, password=STRONG_PASSWORD, workspace_name="Acme Co", **overrides):
    body = {"workspace_name": workspace_name, "email": email, "password": password, "confirm_password": password}
    return client.post(REGISTER, {**body, **overrides}, format="json")


def is_authenticated(client) -> bool:
    return client.get(ME).status_code == 200


def session_key(client):
    morsel = client.cookies.get(settings.SESSION_COOKIE_NAME)
    return morsel.value if morsel and morsel.value else None


def session_exists(key) -> bool:
    return import_module(settings.SESSION_ENGINE).SessionStore().exists(key)


def client_with_session_cookie(key):
    c = APIClient()
    c.cookies[settings.SESSION_COOKIE_NAME] = key
    return c


def wrong_totp(secret) -> str:
    """A 6-digit code that is definitely not valid for `secret` right now (including drift window)."""
    totp = pyotp.TOTP(secret)
    now = time.time()
    valid = {totp.at(now + drift) for drift in (-60, -30, 0, 30, 60)}
    return next(c for c in ("000000", "111111", "222222", "333333", "444444", "555555") if c not in valid)


def reset_link_params(email) -> dict:
    assert len(mail.outbox) == 1, f"expected exactly one reset email, got {len(mail.outbox)}"
    message = mail.outbox[0]
    assert message.to == [email]
    uid = re.search(r"uid=([A-Za-z0-9_-]+)", message.body)
    token = re.search(r"token=([A-Za-z0-9_-]+)", message.body)
    assert uid and token, f"no reset link in email body: {message.body!r}"
    return {"uid": uid.group(1), "token": token.group(1)}


# ---------------------------------------------------------------------------
# Registration + email verification
# ---------------------------------------------------------------------------
class TestRegistration:
    def test_register_creates_user_workspace_owner_and_session(self):
        client = APIClient()
        res = register(client, "Founder@Example.test", workspace_name="Founder Labs")
        assert res.status_code == 201, res.content
        body = res.json()
        assert body["redirect"] == "/dashboard"
        assert body["user"]["email"] == "founder@example.test", "email is stored lower-cased"

        user = User.objects.get(email="founder@example.test")
        ws = Workspace.objects.get(id=body["workspace"]["id"])
        assert ws.name == "Founder Labs" and ws.slug == "founder-labs"
        m = WorkspaceMember.objects.get(user=user, workspace=ws)
        assert m.role == WorkspaceMember.Role.OWNER
        assert Brand.objects.filter(workspace=ws).count() == 1, "dashboard needs a default brand"
        assert [w["slug"] for w in body["workspaces"]] == ["founder-labs"]

        assert is_authenticated(client), "registration signs the user in"
        assert client.get(ME).json()["workspaces"][0]["role"] == "owner"

    def test_duplicate_email_is_rejected_case_insensitively(self, user_a):
        res = register(APIClient(), user_a.email.upper())
        assert res.status_code == 400, res.content
        assert res.json()["fields"]["email"] == ["An account with this email already exists."]
        assert res.json()["error"] == "An account with this email already exists."
        user_a.refresh_from_db()
        assert user_a.check_password(DEFAULT_PASSWORD), "existing account must be untouched"
        assert User.objects.filter(email__iexact=user_a.email).count() == 1
        assert Workspace.objects.filter(name="Acme Co").count() == 0

    def test_password_confirmation_must_match(self):
        res = register(APIClient(), "mismatch@reg.test", confirm_password="Something-Else-123")
        assert res.status_code == 400
        assert "confirm_password" in res.json()["fields"]
        assert not User.objects.filter(email="mismatch@reg.test").exists()

    @pytest.mark.parametrize("missing", ["workspace_name", "email", "password", "confirm_password"])
    def test_every_field_is_required(self, missing):
        body = {"workspace_name": "W", "email": "req@reg.test", "password": STRONG_PASSWORD, "confirm_password": STRONG_PASSWORD}
        body.pop(missing)
        res = APIClient().post(REGISTER, body, format="json")
        assert res.status_code == 400 and missing in res.json()["fields"], res.content
        assert not User.objects.filter(email="req@reg.test").exists()

    def test_blank_workspace_name_and_bad_email_rejected(self):
        res = register(APIClient(), "not-an-email", workspace_name="   ")
        assert res.status_code == 400
        assert {"email", "workspace_name"} <= set(res.json()["fields"])

    def test_failure_mid_transaction_leaves_nothing_behind(self):
        """All writes are one transaction: if the membership insert fails, the user and workspace vanish too."""
        with mock.patch("apps.tenancy.services.WorkspaceMember.objects.create", side_effect=RuntimeError("boom")):
            with pytest.raises(RuntimeError):
                register(APIClient(), "atomic@reg.test", workspace_name="Atomic Inc")
        assert not User.objects.filter(email="atomic@reg.test").exists()
        assert not Workspace.objects.filter(name="Atomic Inc").exists()

    def test_same_workspace_name_gets_unique_slug(self):
        assert register(APIClient(), "one@slug.test", workspace_name="Same Name").status_code == 201
        assert register(APIClient(), "two@slug.test", workspace_name="Same Name").status_code == 201
        slugs = sorted(Workspace.objects.filter(name="Same Name").values_list("slug", flat=True))
        assert slugs == ["same-name", "same-name-1"]

    def test_session_cookie_is_http_only(self):
        client = APIClient()
        register(client, "cookie@reg.test")
        morsel = client.cookies[settings.SESSION_COOKIE_NAME]
        assert morsel["httponly"] is True
        assert morsel["samesite"] == "Lax"
        assert int(morsel["max-age"]) == settings.SESSION_COOKIE_AGE


class TestPasswordReset:
    NEW_PW = "Brand-New-Passphrase-77"

    def confirm(self, params, pw=None):
        pw = pw or self.NEW_PW
        return APIClient().post(PASSWORD_RESET_CONFIRM, {**params, "password": pw, "confirm_password": pw}, format="json")

    def test_reset_flow_sets_new_password_and_kills_old_sessions(self, user_a):
        old_session = APIClient()
        login(old_session, user_a.email)
        assert is_authenticated(old_session)

        res = APIClient().post(PASSWORD_RESET, {"email": user_a.email.upper()}, format="json")
        assert res.status_code == 200
        params = reset_link_params(user_a.email)

        assert self.confirm(params).status_code == 200
        assert login(APIClient(), user_a.email, self.NEW_PW).status_code == 200
        assert login(APIClient(), user_a.email, DEFAULT_PASSWORD).status_code == 400
        assert not is_authenticated(old_session), "password change must invalidate existing sessions"
        assert self.confirm(params, "Another-Passphrase-88").status_code == 400, "reset token is single use"

    def test_unknown_email_gets_identical_response_and_no_mail(self, user_a):
        known = APIClient().post(PASSWORD_RESET, {"email": user_a.email}, format="json")
        mail.outbox.clear()
        unknown = APIClient().post(PASSWORD_RESET, {"email": "ghost@nowhere.test"}, format="json")
        assert (known.status_code, known.json()) == (unknown.status_code, unknown.json())
        assert len(mail.outbox) == 0

    def test_tampered_token_rejected(self, user_a):
        APIClient().post(PASSWORD_RESET, {"email": user_a.email}, format="json")
        params = reset_link_params(user_a.email)
        params["token"] = params["token"][:-1] + ("a" if params["token"][-1] != "a" else "b")
        assert self.confirm(params).status_code == 400
        user_a.refresh_from_db()
        assert user_a.check_password(DEFAULT_PASSWORD)

    def test_garbage_uid_rejected(self):
        assert self.confirm({"uid": "!!!", "token": "x"}).status_code == 400

    def test_weak_new_password_rejected(self, user_a):
        APIClient().post(PASSWORD_RESET, {"email": user_a.email}, format="json")
        params = reset_link_params(user_a.email)
        res = self.confirm(params, "password123")
        assert res.status_code == 400 and "password" in res.json()["fields"]


# ---------------------------------------------------------------------------
# Login
# ---------------------------------------------------------------------------
class TestLogin:
    def test_wrong_email_and_wrong_password_are_indistinguishable(self, user_a):
        unknown_client, known_client = APIClient(), APIClient()
        unknown = login(unknown_client, "nobody@nowhere.test", DEFAULT_PASSWORD)
        wrong_pw = login(known_client, user_a.email, "Not-The-Password-42")

        assert unknown.status_code == wrong_pw.status_code
        assert unknown.status_code in (400, 401)
        assert unknown.json() == wrong_pw.json(), "login error reveals whether the email has an account"
        assert not is_authenticated(unknown_client)
        assert not is_authenticated(known_client)

    def test_wrong_email_and_wrong_password_take_comparable_time(self, user_a):
        """Unknown emails must still pay for a password hash, otherwise response time enumerates accounts."""
        client = APIClient()

        def median_seconds(email, password, runs=7):
            login(client, email, password)  # warm-up
            samples = []
            for _ in range(runs):
                start = time.perf_counter()
                login(client, email, password)
                samples.append(time.perf_counter() - start)
            return statistics.median(samples)

        unknown = median_seconds("nobody@nowhere.test", "Not-The-Password-42")
        wrong_pw = median_seconds(user_a.email, "Not-The-Password-42")
        ratio = min(unknown, wrong_pw) / max(unknown, wrong_pw)
        assert ratio >= 0.5, f"unknown email {unknown * 1000:.1f}ms vs wrong password {wrong_pw * 1000:.1f}ms"

    def test_inactive_user_cannot_log_in(self, user_factory, user_a):
        inactive = user_factory(email="disabled@inactive.test", is_active=False)
        client = APIClient()

        res = login(client, inactive.email, DEFAULT_PASSWORD)  # correct password
        assert res.status_code in (400, 401), res.content
        assert not is_authenticated(client)
        assert "_auth_user_id" not in client.session

        # ...and the refusal does not disclose that the password was right / the account exists.
        wrong_pw = login(APIClient(), user_a.email, "Not-The-Password-42")
        assert (res.status_code, res.json()) == (wrong_pw.status_code, wrong_pw.json())

    def test_correct_credentials_log_in(self, user_a):
        """Control: the failures above are not caused by a broken login endpoint."""
        client = APIClient()
        res = login(client, user_a.email)
        assert res.status_code == 200 and res.json()["mfa_required"] is False
        assert is_authenticated(client)


# ---------------------------------------------------------------------------
# Brute-force throttling (uses the rates the application ships with, not test overrides)
# ---------------------------------------------------------------------------
@pytest.fixture
def shipped_throttle_rates():
    from config.settings import base as shipped

    rates = shipped.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]
    with mock.patch.object(ScopedRateThrottle, "THROTTLE_RATES", rates):
        yield rates


class TestBruteForceThrottling:
    def test_sixth_failed_login_within_a_minute_is_429(self, shipped_throttle_rates, user_a):
        client = APIClient()
        codes = [login(client, user_a.email, f"wrong-password-{i}").status_code for i in range(6)]
        assert codes[:5] == [400] * 5, codes
        assert codes[5] == 429, f"6th failed login was not throttled: {codes} (auth rate: {shipped_throttle_rates['auth']})"

        # Still locked out even with the right password.
        assert login(client, user_a.email).status_code == 429
        assert not is_authenticated(client)

    def test_sixth_failed_mfa_challenge_within_a_minute_is_429(self, shipped_throttle_rates, mfa_user_factory):
        user, secret = mfa_user_factory()
        client = APIClient()
        assert login(client, user.email).json()["mfa_required"] is True

        bad = wrong_totp(secret)
        codes = [client.post(CHALLENGE, {"code": bad}, format="json").status_code for _ in range(6)]
        assert 200 not in codes, codes
        assert codes[5] == 429, f"6th failed MFA challenge was not throttled: {codes} (auth rate: {shipped_throttle_rates['auth']})"

        # Still locked out even with the right code.
        assert client.post(CHALLENGE, {"code": pyotp.TOTP(secret).now()}, format="json").status_code == 429
        assert not is_authenticated(client)


# ---------------------------------------------------------------------------
# MFA (TOTP)
# ---------------------------------------------------------------------------
class TestMFA:
    def test_password_step_returns_mfa_required_without_authenticated_session(self, mfa_user_factory, workspace_a):
        user, _ = mfa_user_factory()
        client = APIClient()

        res = login(client, user.email)
        assert res.status_code == 200
        body = res.json()
        assert body["mfa_required"] is True
        assert "user" not in body and "workspaces" not in body, "account data returned before the second factor"

        assert "_auth_user_id" not in client.session
        assert client.get(ME).status_code in (401, 403)
        assert client.get("/api/w/").status_code in (401, 403)

    def test_correct_totp_completes_login(self, mfa_user_factory):
        user, secret = mfa_user_factory()
        client = APIClient()
        login(client, user.email)

        res = client.post(CHALLENGE, {"code": pyotp.TOTP(secret).now()}, format="json")
        assert res.status_code == 200, res.content
        me = client.get(ME)
        assert me.status_code == 200 and me.json()["user"]["email"] == user.email

    def test_wrong_totp_does_not_complete_login(self, mfa_user_factory):
        user, secret = mfa_user_factory()
        client = APIClient()
        login(client, user.email)

        res = client.post(CHALLENGE, {"code": wrong_totp(secret)}, format="json")
        assert res.status_code == 400
        assert not is_authenticated(client)

    def test_totp_without_password_step_is_rejected(self, mfa_user_factory):
        _, secret = mfa_user_factory()
        client = APIClient()

        res = client.post(CHALLENGE, {"code": pyotp.TOTP(secret).now()}, format="json")
        assert res.status_code == 401
        assert not is_authenticated(client)

    def test_same_totp_code_cannot_be_replayed(self, mfa_user_factory):
        user, secret = mfa_user_factory()
        code = pyotp.TOTP(secret).now()

        victim = APIClient()
        login(victim, user.email)
        assert victim.post(CHALLENGE, {"code": code}, format="json").status_code == 200

        # Attacker knows the password and observed the code that was just used.
        attacker = APIClient()
        assert login(attacker, user.email).json()["mfa_required"] is True
        replay = attacker.post(CHALLENGE, {"code": code}, format="json")
        assert replay.status_code == 400, "an already-used TOTP code was accepted a second time"
        assert not is_authenticated(attacker)

    def test_pending_mfa_state_is_usable_inside_five_minutes(self, mfa_user_factory):
        """Control for the expiry test below."""
        user, secret = mfa_user_factory()
        client = APIClient()
        with freeze_time(datetime.now(UTC)) as clock:
            login(client, user.email)
            clock.tick(timedelta(minutes=4))
            res = client.post(CHALLENGE, {"code": pyotp.TOTP(secret).now()}, format="json")
            assert res.status_code == 200, res.content

    def test_pending_mfa_state_expires_after_five_minutes(self, mfa_user_factory):
        user, secret = mfa_user_factory()
        client = APIClient()
        with freeze_time(datetime.now(UTC)) as clock:
            assert login(client, user.email).json()["mfa_required"] is True
            clock.tick(timedelta(minutes=5, seconds=1))

            res = client.post(CHALLENGE, {"code": pyotp.TOTP(secret).now()}, format="json")
            assert res.status_code in (400, 401), f"stale pre-MFA state still accepted: {res.status_code}"
            assert not is_authenticated(client)


# ---------------------------------------------------------------------------
# Recovery codes
# ---------------------------------------------------------------------------
class TestRecoveryCodes:
    def test_ten_codes_generated_and_stored_only_as_sha256(self, user_a):
        client = APIClient()
        login(client, user_a.email)
        secret = client.post(MFA_SETUP).json()["secret"]
        res = client.post(MFA_CONFIRM, {"code": pyotp.TOTP(secret).now()}, format="json")
        assert res.status_code == 200, res.content

        codes = res.json()["recovery_codes"]
        assert len(codes) == 10 and len(set(codes)) == 10

        stored = list(MFARecoveryCode.objects.filter(user=user_a))
        assert len(stored) == 10
        assert {r.code_hash for r in stored} == {hashlib.sha256(c.encode()).hexdigest() for c in codes}

        # No plaintext (with or without the dash) in any column of the table.
        with connection.cursor() as cur:
            cur.execute(f"SELECT * FROM {MFARecoveryCode._meta.db_table} WHERE user_id = %s", [str(user_a.id)])
            dump = " ".join(str(value) for row in cur.fetchall() for value in row).upper()
        for code in codes:
            assert code not in dump and code.replace("-", "") not in dump

    def test_each_code_works_exactly_once(self, mfa_user_factory):
        user, _ = mfa_user_factory()
        codes = generate_recovery_codes(user)
        assert len(codes) == 10

        for code in codes:
            first = APIClient()
            login(first, user.email)
            res = first.post(CHALLENGE, {"code": code}, format="json")
            assert res.status_code == 200 and res.json()["recovery_code_used"] is True, res.content
            assert is_authenticated(first)

            second = APIClient()
            login(second, user.email)
            assert second.post(CHALLENGE, {"code": code}, format="json").status_code == 400, f"{code} reused"
            assert not is_authenticated(second)

        assert MFARecoveryCode.objects.filter(user=user, used_at__isnull=True).count() == 0

    def test_code_is_bound_to_its_owner(self, mfa_user_factory):
        owner, _ = mfa_user_factory()
        other, _ = mfa_user_factory()
        code = generate_recovery_codes(owner)[0]
        generate_recovery_codes(other)

        client = APIClient()
        login(client, other.email)
        assert client.post(CHALLENGE, {"code": code}, format="json").status_code == 400
        assert not is_authenticated(client)
        assert MFARecoveryCode.objects.filter(user=owner, used_at__isnull=False).count() == 0


# ---------------------------------------------------------------------------
# Session lifecycle
# ---------------------------------------------------------------------------
class TestSessions:
    def test_session_id_rotates_on_login(self, user_a):
        """Session fixation: an ID that existed before login must not become the authenticated session."""
        client = APIClient()
        planted = client.session
        planted["planted_by"] = "attacker"
        planted.save()
        fixed_key = session_key(client)
        assert fixed_key and session_exists(fixed_key)

        assert login(client, user_a.email).status_code == 200

        assert session_key(client) != fixed_key
        assert not session_exists(fixed_key), "pre-login session survived login"
        assert not is_authenticated(client_with_session_cookie(fixed_key))
        assert is_authenticated(client)

    def test_session_id_rotates_when_mfa_completes(self, mfa_user_factory):
        user, secret = mfa_user_factory()
        client = APIClient()
        login(client, user.email)
        pre_mfa_key = session_key(client)
        assert pre_mfa_key

        assert client.post(CHALLENGE, {"code": pyotp.TOTP(secret).now()}, format="json").status_code == 200

        assert session_key(client) != pre_mfa_key
        assert not session_exists(pre_mfa_key)
        assert not is_authenticated(client_with_session_cookie(pre_mfa_key))

    def test_logout_destroys_session_server_side(self, user_a):
        client = APIClient()
        login(client, user_a.email)
        key = session_key(client)
        stolen = client_with_session_cookie(key)
        assert is_authenticated(stolen), "control: the copied cookie works before logout"

        assert client.post(LOGOUT).status_code == 200

        assert not session_exists(key), "session row still present after logout"
        # The API answers unauthenticated requests with 401 (Bearer challenge); 403 is accepted as well.
        assert stolen.get(ME).status_code in (401, 403)
        assert stolen.get("/api/w/").status_code in (401, 403)
        assert stolen.post(LOGOUT).status_code in (401, 403)


# ---------------------------------------------------------------------------
# CSRF
# ---------------------------------------------------------------------------
# Every state-changing route reachable with a session cookie: (method, path template, view class name).
SESSION_STATE_CHANGING = [
    ("post", MFA_SETUP, "MFASetupView"),
    ("post", MFA_CONFIRM, "MFAConfirmView"),
    ("post", "/api/v1/security/mfa/disable/", "MFADisableView"),
    ("post", "/api/v1/security/mfa/recovery-codes/regenerate/", "MFARecoveryRegenerateView"),
    ("post", LOGOUT, "LogoutView"),
    ("post", "/api/w/", "WorkspaceListCreateView"),
    ("post", "/api/w/invites/accept/", "InviteAcceptView"),
    ("delete", "/api/w/{ws}/", "WorkspaceDetailView"),
    ("post", "/api/w/{ws}/brands/", "BrandListCreateView"),
    ("post", "/api/w/{ws}/invites/", "InviteCreateView"),
    ("patch", "/api/w/{ws}/members/{uuid}/", "MemberDetailView"),
    ("delete", "/api/w/{ws}/members/{uuid}/", "MemberDetailView"),
    ("post", "/api/w/{ws}/alerts/{uuid}/acknowledge/", "AlertAcknowledgeView"),
    ("post", "/api/w/{ws}/alerts/{uuid}/resolve/", "AlertResolveView"),
    ("post", "/api/w/{ws}/b/{brand}/integrations/", "BrandIntegrationListView"),
    ("delete", "/api/w/{ws}/b/{brand}/integrations/", "BrandIntegrationListView"),
    ("post", "/api/w/{ws}/b/{brand}/shopify/sync-now/", "ShopifySyncTriggerView"),
    ("post", "/api/w/{ws}/b/{brand}/marketing/sync-now/", "MetaAdsSyncTriggerView"),
    ("post", "/api/w/{ws}/b/{brand}/logistics/ndr/AWB123/action/", "LogisticsNdrActionView"),
]
# State-changing routes used before a session exists.
ANONYMOUS_STATE_CHANGING = [
    ("post", REGISTER, "RegisterView"),
    ("post", LOGIN, "LoginView"),
    ("post", CHALLENGE, "MFAChallengeView"),
    ("post", "/api/v1/auth/mfa/verify/", "MFAVerifyView"),
    ("post", "/api/v1/auth/mfa/recovery/", "MFARecoveryLoginView"),
    ("post", PASSWORD_RESET, "PasswordResetRequestView"),
    ("post", PASSWORD_RESET_CONFIRM, "PasswordResetConfirmView"),
]
# Inbound provider webhooks: no cookies involved, authenticated by HMAC signature instead.
CSRF_EXEMPT_VIEWS = {
    "ShopifyWebhookView", "RazorpayWebhookView", "DelhiveryWebhookView", "ShiprocketWebhookView", "MetaWebhookView",
}
UNSAFE_METHODS = ("post", "put", "patch", "delete")


def _api_view_classes(patterns=None):
    for pattern in patterns if patterns is not None else get_resolver().url_patterns:
        if isinstance(pattern, URLResolver):
            yield from _api_view_classes(pattern.url_patterns)
            continue
        cls = getattr(pattern.callback, "cls", None) or getattr(pattern.callback, "view_class", None)
        if cls is not None and issubclass(cls, APIView):
            yield cls


def csrf_token_for(client) -> str:
    return client.get(CSRF).json()["csrfToken"]


@pytest.fixture
def csrf_client():
    return APIClient(enforce_csrf_checks=True)


@pytest.fixture
def csrf_session_client(csrf_client, user_a, brand_a):
    """Session-authenticated client that enforces CSRF; logged in properly (with a token)."""
    res = csrf_client.post(
        LOGIN, {"email": user_a.email, "password": DEFAULT_PASSWORD}, format="json",
        HTTP_X_CSRFTOKEN=csrf_token_for(csrf_client),
    )
    assert res.status_code == 200, res.content
    return csrf_client


class TestCSRF:
    def test_csrf_matrix_covers_every_state_changing_route(self):
        """Guard: a new unsafe endpoint must be added to the matrix above (or consciously exempted)."""
        routed = {
            (method, cls.__name__)
            for cls in _api_view_classes()
            for method in UNSAFE_METHODS
            if hasattr(cls, method)
        }
        covered = {(m, name) for m, _, name in SESSION_STATE_CHANGING + ANONYMOUS_STATE_CHANGING}
        exempt = {(m, name) for m, name in routed if name in CSRF_EXEMPT_VIEWS}
        assert routed - exempt == covered, f"untested: {routed - exempt - covered}; stale: {covered - routed}"

    def test_login_without_csrf_token_is_rejected(self, csrf_client, user_a):
        res = login(csrf_client, user_a.email)
        assert res.status_code == 403, f"login accepted without a CSRF token ({res.status_code})"
        assert not is_authenticated(csrf_client)

    def test_login_with_csrf_token_succeeds(self, csrf_client, user_a):
        """Control: the 403s in this class come from the missing token, nothing else."""
        res = csrf_client.post(
            LOGIN, {"email": user_a.email, "password": DEFAULT_PASSWORD}, format="json",
            HTTP_X_CSRFTOKEN=csrf_token_for(csrf_client),
        )
        assert res.status_code == 200, res.content
        assert is_authenticated(csrf_client)

    def test_register_without_csrf_token_is_rejected(self, csrf_client):
        res = register(csrf_client, "csrf@register.test")
        assert res.status_code == 403, f"register accepted without a CSRF token ({res.status_code})"
        assert not User.objects.filter(email="csrf@register.test").exists()

    def test_mfa_challenge_without_csrf_token_is_rejected(self, csrf_client, mfa_user_factory):
        user, secret = mfa_user_factory()
        csrf_client.post(
            LOGIN, {"email": user.email, "password": DEFAULT_PASSWORD}, format="json",
            HTTP_X_CSRFTOKEN=csrf_token_for(csrf_client),
        )
        res = csrf_client.post(CHALLENGE, {"code": pyotp.TOTP(secret).now()}, format="json")
        assert res.status_code == 403, f"MFA challenge accepted without a CSRF token ({res.status_code})"
        assert not is_authenticated(csrf_client)

    @pytest.mark.parametrize(
        ("method", "path"),
        [(m, p) for m, p, _ in SESSION_STATE_CHANGING],
        ids=[f"{m.upper()} {p}" for m, p, _ in SESSION_STATE_CHANGING],
    )
    def test_session_request_without_csrf_token_is_rejected(self, csrf_session_client, workspace_a, brand_a, method, path):
        url = path.format(ws=workspace_a.slug, brand=brand_a.id, uuid=uuid.uuid4())
        res = getattr(csrf_session_client, method)(url, {}, format="json")
        assert res.status_code == 403, f"{method.upper()} {url} -> {res.status_code} {res.content[:200]}"
        assert "CSRF" in res.content.decode()

    def test_logout_without_csrf_token_leaves_session_alive(self, csrf_session_client):
        assert csrf_session_client.post(LOGOUT).status_code == 403
        assert is_authenticated(csrf_session_client), "forged logout destroyed the session"

    def test_session_request_with_csrf_token_is_accepted(self, csrf_session_client):
        """Control for the matrix: same client, same endpoint, token supplied."""
        res = csrf_session_client.post(LOGOUT, HTTP_X_CSRFTOKEN=csrf_token_for(csrf_session_client))
        assert res.status_code == 200, res.content


# ---------------------------------------------------------------------------
# Password storage + strength
# ---------------------------------------------------------------------------
@pytest.fixture(scope="module")
def prod_settings():
    """PASSWORD_HASHERS / AUTH_PASSWORD_VALIDATORS as loaded by config.settings.prod (fresh interpreter)."""
    env = {
        **os.environ,
        "DJANGO_SETTINGS_MODULE": "config.settings.prod",
        "SECRET_KEY": "prod-settings-probe-" + "k" * 50,
        "INTEGRATION_ENCRYPTION_KEY": "e" * 40,
        "ALLOWED_HOSTS": "api.example.test",
        "CORS_ALLOWED_ORIGINS": "https://app.example.test",
        "DEMO_MODE": "False",
        "DEBUG": "False",
        "SENTRY_DSN": "",
    }
    probe = (
        "import json; from config.settings import prod as s; "
        "print(json.dumps({'hashers': s.PASSWORD_HASHERS, 'validators': s.AUTH_PASSWORD_VALIDATORS}))"
    )
    out = subprocess.run(
        [sys.executable, "-c", probe], cwd=settings.BASE_DIR, env=env, capture_output=True, text=True, timeout=60
    )
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout.strip().splitlines()[-1])


class TestPasswords:
    def test_prod_settings_hash_with_argon2(self, prod_settings):
        assert prod_settings["hashers"][0] == ARGON2, "new passwords are hashed with PASSWORD_HASHERS[0]"

    def test_prod_settings_enforce_length_and_common_password_validators(self, prod_settings):
        validators = {v["NAME"].rsplit(".", 1)[-1]: v.get("OPTIONS", {}) for v in prod_settings["validators"]}
        assert validators.get("MinimumLengthValidator", {}).get("min_length", 0) >= 10
        assert "CommonPasswordValidator" in validators

    def test_registered_password_is_stored_as_argon2_hash(self, prod_settings):
        with override_settings(PASSWORD_HASHERS=prod_settings["hashers"]):
            res = register(APIClient(), "hash@storage.test")
            assert res.status_code < 300, res.content

            stored = User.objects.get(email="hash@storage.test").password
            assert stored.startswith("argon2$argon2id$"), stored[:20]
            assert identify_hasher(stored).algorithm == "argon2"
            assert STRONG_PASSWORD not in stored
            assert STRONG_PASSWORD not in res.content.decode() and "argon2" not in res.content.decode()

    def test_password_shorter_than_ten_characters_is_rejected(self):
        res = register(APIClient(), "short@pw.test", "Zx9!kQ2#v")  # 9 chars, otherwise strong
        assert res.status_code == 400, res.content
        assert not User.objects.filter(email="short@pw.test").exists()

    def test_ten_character_password_is_accepted(self):
        """Control: the boundary is 10, and rejections above are about length."""
        res = register(APIClient(), "ten@pw.test", "Zx9!kQ2#vL")
        assert res.status_code < 300, res.content
        assert User.objects.filter(email="ten@pw.test").exists()

    @pytest.mark.parametrize("password", ["password123", "qwertyuiop", "iloveyou123"])
    def test_common_password_is_rejected(self, password):
        assert len(password) >= 10 and password in CommonPasswordValidator().passwords, "bad test fixture"

        res = register(APIClient(), "common@pw.test", password)
        assert res.status_code == 400, f"common password {password!r} accepted ({res.status_code})"
        assert not User.objects.filter(email="common@pw.test").exists()

    def test_breached_password_is_rejected(self):
        """HaveIBeenPwned k-anonymity lookup (mocked): a password present in the breach corpus is refused."""
        digest = hashlib.sha1(STRONG_PASSWORD.encode()).hexdigest().upper()
        response = mock.MagicMock(status=200)
        response.read.return_value = f"0000000000000000000000000000000000A:1\r\n{digest[5:]}:42\r\n".encode()
        response.__enter__.return_value = response

        with mock.patch("urllib.request.urlopen", return_value=response) as urlopen:
            res = register(APIClient(), "breached@pw.test")

        assert res.status_code == 400, res.content
        assert not User.objects.filter(email="breached@pw.test").exists()
        # k-anonymity: only the 5-char hash prefix leaves the process.
        assert urlopen.call_args.args[0].full_url.endswith(f"/range/{digest[:5]}")


class TestLegacyAccounts:
    def test_user_without_local_password_can_set_one_via_reset(self):
        """Accounts provisioned by the old Firebase/Supabase sign-in have no usable password; reset is their way in."""
        legacy = User.objects.create_user(email="legacy@firebase.test")  # password=None -> unusable
        assert not legacy.has_usable_password()
        assert login(APIClient(), legacy.email, "anything-at-all-1").status_code == 400

        APIClient().post(PASSWORD_RESET, {"email": legacy.email}, format="json")
        params = reset_link_params(legacy.email)
        pw = "First-Local-Passphrase-5"
        res = APIClient().post(PASSWORD_RESET_CONFIRM, {**params, "password": pw, "confirm_password": pw}, format="json")
        assert res.status_code == 200, res.content
        assert login(APIClient(), legacy.email, pw).status_code == 200
