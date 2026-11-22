import pyotp
import pytest
from rest_framework.test import APIClient

from apps.accounts.models import MFARecoveryCode, UserMFA
from apps.accounts.services import decrypt_totp_secret, encrypt_totp_secret
from tests.conftest import session_client_for

DEFAULT_PASSWORD = "SecurePassword123!"


@pytest.mark.django_db
class TestTOTPMFAEndpoints:
    def test_mfa_status_disabled_initially(self, user_a):
        client = session_client_for(user_a)
        res = client.get("/api/v1/security/mfa/status/")
        assert res.status_code == 200
        data = res.json()
        assert data["is_enabled"] is False
        assert data["unused_recovery_codes_count"] == 0

    def test_mfa_setup_flow_and_confirm(self, user_a):
        client = session_client_for(user_a)
        # 1. Setup
        res = client.post("/api/v1/security/mfa/setup/")
        assert res.status_code == 200
        data = res.json()
        assert "secret" in data
        assert "provisioning_uri" in data
        assert "qr_code_base64" in data
        assert data["qr_code_base64"].startswith("data:image/png;base64,")

        secret = data["secret"]

        # Secret is encrypted at rest in UserMFA
        user_mfa = UserMFA.objects.get(user=user_a)
        assert user_mfa.is_enabled is False
        assert user_mfa.encrypted_totp_secret != secret
        assert decrypt_totp_secret(user_mfa.encrypted_totp_secret) == secret

        # 2. Confirm with bad code fails
        res_bad = client.post("/api/v1/security/mfa/confirm/", {"code": "000000"}, format="json")
        assert res_bad.status_code == 400

        # 3. Confirm with valid code succeeds
        valid_code = pyotp.TOTP(secret).now()
        res_good = client.post("/api/v1/security/mfa/confirm/", {"code": valid_code}, format="json")
        assert res_good.status_code == 200
        data_good = res_good.json()
        assert "recovery_codes" in data_good
        assert len(data_good["recovery_codes"]) == 10

        user_a.refresh_from_db()
        assert user_a.mfa_enabled is True
        user_mfa.refresh_from_db()
        assert user_mfa.is_enabled is True
        assert user_mfa.confirmed_at is not None

        # Verify status now reflects enabled
        res_status = client.get("/api/v1/security/mfa/status/")
        assert res_status.json()["is_enabled"] is True
        assert res_status.json()["unused_recovery_codes_count"] == 10

    def test_login_with_mfa_challenge_and_verify(self, user_a):
        client = APIClient()
        # Setup MFA on user_a
        secret = pyotp.random_base32()
        UserMFA.objects.create(
            user=user_a,
            encrypted_totp_secret=encrypt_totp_secret(secret),
            is_enabled=True,
        )
        user_a.mfa_enabled = True
        user_a.mfa_secret = secret
        user_a.save()

        # Step 1: Login with password
        res = client.post("/api/v1/auth/login/", {"email": user_a.email, "password": DEFAULT_PASSWORD}, format="json")
        assert res.status_code == 200
        data = res.json()
        assert data["mfa_required"] is True
        assert "challenge_token" in data
        challenge_token = data["challenge_token"]

        # Step 2: Verify with wrong code fails
        res_fail = client.post(
            "/api/v1/auth/mfa/verify/",
            {"challenge_token": challenge_token, "code": "999999"},
            format="json",
        )
        assert res_fail.status_code == 400

        # Step 3: Verify with correct code succeeds
        valid_code = pyotp.TOTP(secret).now()
        res_ok = client.post(
            "/api/v1/auth/mfa/verify/",
            {"challenge_token": challenge_token, "code": valid_code},
            format="json",
        )
        assert res_ok.status_code == 200
        assert res_ok.json()["user"]["email"] == user_a.email

        # Step 4: Challenge cannot be reused
        res_reused = client.post(
            "/api/v1/auth/mfa/verify/",
            {"challenge_token": challenge_token, "code": valid_code},
            format="json",
        )
        assert res_reused.status_code in (400, 401)

    def test_recovery_code_login_and_single_use(self, user_a):
        client = APIClient()
        # Setup MFA and 1 recovery code
        secret = pyotp.random_base32()
        UserMFA.objects.create(
            user=user_a,
            encrypted_totp_secret=encrypt_totp_secret(secret),
            is_enabled=True,
        )
        user_a.mfa_enabled = True
        user_a.mfa_secret = secret
        user_a.save()

        from apps.accounts.services import generate_recovery_codes
        codes = generate_recovery_codes(user_a, count=1)
        recovery_code = codes[0]

        # Login to get challenge
        res = client.post("/api/v1/auth/login/", {"email": user_a.email, "password": DEFAULT_PASSWORD}, format="json")
        challenge_token = res.json()["challenge_token"]

        # Recovery login
        res_rec = client.post(
            "/api/v1/auth/mfa/recovery/",
            {"challenge_token": challenge_token, "recovery_code": recovery_code},
            format="json",
        )
        assert res_rec.status_code == 200
        assert res_rec.json()["recovery_code_used"] is True

        # Recovery code is now marked used
        rec_obj = MFARecoveryCode.objects.get(user=user_a)
        assert rec_obj.used_at is not None

        # Try to use it again on new challenge
        res2 = client.post("/api/v1/auth/login/", {"email": user_a.email, "password": DEFAULT_PASSWORD}, format="json")
        challenge_token_2 = res2.json()["challenge_token"]
        res_rec_2 = client.post(
            "/api/v1/auth/mfa/recovery/",
            {"challenge_token": challenge_token_2, "recovery_code": recovery_code},
            format="json",
        )
        assert res_rec_2.status_code == 400

    def test_disable_mfa_requires_password_and_otp(self, user_a):
        client = session_client_for(user_a)
        secret = pyotp.random_base32()
        UserMFA.objects.create(
            user=user_a,
            encrypted_totp_secret=encrypt_totp_secret(secret),
            is_enabled=True,
        )
        user_a.mfa_enabled = True
        user_a.mfa_secret = secret
        user_a.save()

        # Wrong password
        res = client.post(
            "/api/v1/security/mfa/disable/",
            {"password": "WrongPassword!", "code": pyotp.TOTP(secret).now()},
            format="json",
        )
        assert res.status_code == 400

        # Wrong code
        res = client.post(
            "/api/v1/security/mfa/disable/",
            {"password": DEFAULT_PASSWORD, "code": "000000"},
            format="json",
        )
        assert res.status_code == 400

        # Correct password and code
        res = client.post(
            "/api/v1/security/mfa/disable/",
            {"password": DEFAULT_PASSWORD, "code": pyotp.TOTP(secret).now()},
            format="json",
        )
        assert res.status_code == 200
        user_a.refresh_from_db()
        assert user_a.mfa_enabled is False
        assert UserMFA.objects.get(user=user_a).is_enabled is False
