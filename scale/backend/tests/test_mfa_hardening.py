"""
Google Authenticator / TOTP lifecycle and bypass tests (QA audit 2026-11-21).

Real Django stack on the isolated SQLite test DB; TOTP codes are generated with pyotp from the
secret returned by enrollment (exactly what an authenticator app does after scanning the QR).
No secret or OTP value is printed by these tests.
"""
import base64
import time
from urllib.parse import parse_qs, unquote, urlparse

import pyotp
import pytest
from django.core.cache import cache
from rest_framework.test import APIClient

from apps.accounts.models import MFAChallenge, User, UserMFA
from apps.accounts.services import (
    MFA_MAX_FAILURES,
    decrypt_totp_secret,
    encrypt_totp_secret,
    verify_totp_code,
)

PASSWORD = "SecurePassword123!"
PROTECTED = "/api/auth/me/"


@pytest.fixture(autouse=True)
def _clear_cache():
    cache.clear()  # anti-replay steps and lockout counters live in the cache
    yield
    cache.clear()


def enroll(user):
    """Run setup + confirm through the API; returns (client, secret, recovery_codes)."""
    c = APIClient()
    c.force_login(user)
    setup = c.post("/api/v1/security/mfa/setup/")
    assert setup.status_code == 200, setup.content
    secret = setup.json()["secret"]
    res = c.post("/api/v1/security/mfa/confirm/", {"code": pyotp.TOTP(secret).now()}, format="json")
    assert res.status_code == 200, res.content
    return c, secret, res.json()["recovery_codes"]


def password_step(email, password=PASSWORD):
    c = APIClient()
    res = c.post("/api/auth/login/", {"email": email, "password": password}, format="json")
    return c, res


def code_for_other_step(secret):
    """A valid code from the NEXT 30-second window (not yet used), within the ±1 step skew policy."""
    totp = pyotp.TOTP(secret)
    return totp.at(time.time() + 30)


@pytest.mark.django_db
class TestEnrollment:
    def test_provisioning_uri_and_qr_are_valid_for_authenticator_apps(self, user_a):
        c = APIClient()
        c.force_login(user_a)
        data = c.post("/api/v1/security/mfa/setup/").json()
        uri = urlparse(data["provisioning_uri"])
        assert (uri.scheme, uri.netloc) == ("otpauth", "totp")
        assert unquote(uri.path).lstrip("/").endswith(user_a.email)
        q = parse_qs(uri.query)
        assert q["secret"][0] == data["secret"] and len(q["secret"][0]) >= 16
        assert q["issuer"][0]
        png = base64.b64decode(data["qr_code_base64"].split(",", 1)[1])
        assert png[:8] == b"\x89PNG\r\n\x1a\n"

    def test_each_enrollment_gets_a_unique_secret(self, user_factory):
        a, b = user_factory(), user_factory()
        secrets = set()
        for u in (a, b):
            c = APIClient()
            c.force_login(u)
            secrets.add(c.post("/api/v1/security/mfa/setup/").json()["secret"])
        assert len(secrets) == 2

    def test_not_enabled_until_a_correct_code_is_confirmed(self, user_a):
        c = APIClient()
        c.force_login(user_a)
        secret = c.post("/api/v1/security/mfa/setup/").json()["secret"]
        user_a.refresh_from_db()
        assert user_a.mfa_enabled is False
        assert c.post("/api/v1/security/mfa/confirm/", {"code": "000000"}, format="json").status_code == 400
        user_a.refresh_from_db()
        assert user_a.mfa_enabled is False
        assert c.get("/api/v1/security/mfa/status/").json()["is_enabled"] is False
        assert c.post("/api/v1/security/mfa/confirm/", {"code": pyotp.TOTP(secret).now()}, format="json").status_code == 200
        user_a.refresh_from_db()
        assert user_a.mfa_enabled is True

    def test_secret_is_stored_encrypted_only(self, user_a):
        _, secret, _ = enroll(user_a)
        user_a.refresh_from_db()
        assert user_a.mfa_secret == ""
        row = UserMFA.objects.get(user=user_a)
        assert secret not in row.encrypted_totp_secret
        assert decrypt_totp_secret(row.encrypted_totp_secret) == secret

    def test_status_endpoint_never_returns_the_secret(self, user_a):
        c, secret, _ = enroll(user_a)
        body = c.get("/api/v1/security/mfa/status/").content.decode()
        assert secret not in body and "otpauth" not in body
        me = c.get("/api/auth/me/").content.decode()
        assert secret not in me

    def test_frontend_cannot_mark_mfa_enabled_by_itself(self, user_a):
        """Only the server flips mfa_enabled; profile endpoints don't accept it."""
        c = APIClient()
        c.force_login(user_a)
        for path in ("/api/auth/me/", "/api/v1/security/mfa/status/"):
            for method in ("patch", "put", "post"):
                getattr(c, method)(path, {"mfa_enabled": True, "is_enabled": True}, format="json")
        user_a.refresh_from_db()
        assert user_a.mfa_enabled is False

    def test_re_enrollment_while_enabled_is_refused(self, user_a):
        """A stolen session must not be able to swap the second factor for one the attacker controls."""
        c, secret, _ = enroll(user_a)
        before = UserMFA.objects.get(user=user_a).encrypted_totp_secret
        res = c.post("/api/v1/security/mfa/setup/")
        assert res.status_code == 409
        assert "secret" not in res.json()
        assert UserMFA.objects.get(user=user_a).encrypted_totp_secret == before
        # the original authenticator still works for login
        cache.clear()
        lc, r = password_step(user_a.email)
        assert r.json()["mfa_required"] is True
        ok = lc.post("/api/auth/mfa/verify/", {"challenge_token": r.json()["challenge_token"], "code": code_for_other_step(secret)}, format="json")
        assert ok.status_code == 200, ok.content


@pytest.mark.django_db
class TestLoginEnforcement:
    def test_password_alone_does_not_create_a_session(self, user_a):
        enroll(user_a)
        c, res = password_step(user_a.email)
        assert res.status_code == 200
        body = res.json()
        assert body["mfa_required"] is True and body["challenge_token"]
        assert "user" not in body and "workspaces" not in body
        assert c.get(PROTECTED).status_code == 401, "protected API reachable before the second factor"
        assert c.get("/api/w/").status_code == 401

    def test_correct_code_completes_login(self, user_a):
        _, secret, _ = enroll(user_a)
        c, res = password_step(user_a.email)
        ok = c.post("/api/auth/mfa/verify/", {"challenge_token": res.json()["challenge_token"], "code": code_for_other_step(secret)}, format="json")
        assert ok.status_code == 200
        assert c.get(PROTECTED).status_code == 200

    @pytest.mark.parametrize("bad", ["", "12345", "1234567", "abcdef", "12 34 5x", "000000"])
    def test_invalid_codes_are_rejected(self, user_a, bad):
        enroll(user_a)
        c, res = password_step(user_a.email)
        r = c.post("/api/auth/mfa/verify/", {"challenge_token": res.json()["challenge_token"], "code": bad}, format="json")
        assert r.status_code == 400
        assert c.get(PROTECTED).status_code == 401

    def test_code_reuse_is_rejected(self, user_a):
        _, secret, _ = enroll(user_a)
        code = code_for_other_step(secret)
        c1, r1 = password_step(user_a.email)
        assert c1.post("/api/auth/mfa/verify/", {"challenge_token": r1.json()["challenge_token"], "code": code}, format="json").status_code == 200
        c2, r2 = password_step(user_a.email)
        replay = c2.post("/api/auth/mfa/verify/", {"challenge_token": r2.json()["challenge_token"], "code": code}, format="json")
        assert replay.status_code == 400
        assert c2.get(PROTECTED).status_code == 401

    def test_expired_challenge_is_rejected(self, user_a):
        _, secret, _ = enroll(user_a)
        c, res = password_step(user_a.email)
        from django.utils import timezone
        MFAChallenge.objects.filter(user=user_a).update(expires_at=timezone.now() - timezone.timedelta(seconds=1))
        r = c.post("/api/auth/mfa/verify/", {"challenge_token": res.json()["challenge_token"], "code": code_for_other_step(secret)}, format="json")
        assert r.status_code == 401
        assert c.get(PROTECTED).status_code == 401

    def test_challenge_token_of_another_user_cannot_be_used(self, user_a, user_b):
        _, secret_a, _ = enroll(user_a)
        _, secret_b, _ = enroll(user_b)
        _, ra = password_step(user_a.email)
        cb = APIClient()
        r = cb.post("/api/auth/mfa/verify/", {"challenge_token": ra.json()["challenge_token"], "code": code_for_other_step(secret_b)}, format="json")
        assert r.status_code == 400  # B's code does not satisfy A's challenge

    def test_per_account_lockout_survives_ip_rotation(self, user_a):
        """10 wrong codes lock the account's second factor for 15 min, whatever IP / X-Forwarded-For is used."""
        _, secret, _ = enroll(user_a)
        for i in range(MFA_MAX_FAILURES):
            c, res = password_step(user_a.email)
            c.post("/api/auth/mfa/verify/", {"challenge_token": res.json()["challenge_token"], "code": "000000"},
                   format="json", HTTP_X_FORWARDED_FOR=f"203.0.113.{i}")
        c, res = password_step(user_a.email)
        locked = c.post("/api/auth/mfa/verify/", {"challenge_token": res.json()["challenge_token"], "code": code_for_other_step(secret)},
                        format="json", HTTP_X_FORWARDED_FOR="198.51.100.7")
        assert locked.status_code == 429, "correct code must be refused while locked"
        assert c.get(PROTECTED).status_code == 401

    def test_recovery_code_is_single_use(self, user_a):
        _, _, codes = enroll(user_a)
        c1, r1 = password_step(user_a.email)
        assert c1.post("/api/auth/mfa/recovery/", {"challenge_token": r1.json()["challenge_token"], "recovery_code": codes[0]}, format="json").status_code == 200
        c2, r2 = password_step(user_a.email)
        assert c2.post("/api/auth/mfa/recovery/", {"challenge_token": r2.json()["challenge_token"], "recovery_code": codes[0]}, format="json").status_code == 400


@pytest.mark.django_db
class TestDisableAndReenroll:
    def test_disable_requires_password_and_a_fresh_code(self, user_a):
        c, secret, _ = enroll(user_a)
        assert c.post("/api/v1/security/mfa/disable/", {"password": "wrong-password", "code": code_for_other_step(secret)}, format="json").status_code == 400
        assert c.post("/api/v1/security/mfa/disable/", {"password": PASSWORD, "code": ""}, format="json").status_code == 400
        user_a.refresh_from_db()
        assert user_a.mfa_enabled is True
        assert c.post("/api/v1/security/mfa/disable/", {"password": PASSWORD, "code": code_for_other_step(secret)}, format="json").status_code == 200
        user_a.refresh_from_db()
        assert user_a.mfa_enabled is False
        assert UserMFA.objects.get(user=user_a).encrypted_totp_secret == ""

    def test_unauthenticated_disable_is_rejected(self, user_a):
        enroll(user_a)
        assert APIClient().post("/api/v1/security/mfa/disable/", {"password": PASSWORD, "code": "123456"}, format="json").status_code == 401

    def test_re_enroll_after_disable_issues_a_new_secret(self, user_a):
        c, old, _ = enroll(user_a)
        assert c.post("/api/v1/security/mfa/disable/", {"password": PASSWORD, "code": code_for_other_step(old)}, format="json").status_code == 200
        cache.clear()
        new = c.post("/api/v1/security/mfa/setup/").json()["secret"]
        assert new != old
        assert c.post("/api/v1/security/mfa/confirm/", {"code": pyotp.TOTP(new).now()}, format="json").status_code == 200
        # the old authenticator no longer works
        lc, r = password_step(user_a.email)
        assert lc.post("/api/auth/mfa/verify/", {"challenge_token": r.json()["challenge_token"], "code": pyotp.TOTP(old).now()}, format="json").status_code == 400


class TestClockSkewPolicy:
    """valid_window=1: the previous and next 30 s steps are accepted, two steps away are not."""

    SECRET = pyotp.random_base32()

    # Offsets of exactly ±30 s / ±60 s land exactly 1 / 2 steps away from the current step, wherever "now" falls.
    @pytest.mark.parametrize("offset,ok", [(0, True), (-30, True), (30, True), (-60, False), (60, False), (-300, False)])
    def test_window(self, offset, ok):
        code = pyotp.TOTP(self.SECRET).at(time.time() + offset)
        if not ok and code == pyotp.TOTP(self.SECRET).now():
            pytest.skip("1-in-a-million collision between two windows")
        assert verify_totp_code(self.SECRET, code) is ok

    def test_wrong_key_ciphertext_fails_closed_not_500(self):
        token = encrypt_totp_secret("JBSWY3DPEHPK3PXP")
        assert decrypt_totp_secret(token[:-4] + "AAAA") == ""
