import pyotp
import pytest
from apps.accounts.models import MFARecoveryCode, User
from apps.accounts.services import generate_recovery_codes
from rest_framework import status


@pytest.mark.django_db
class TestAuthenticationAndMFA:
    def test_user_registration_requires_10_char_password(self, api_client):
        # Short password fails
        res_short = api_client.post(
            "/api/auth/register/",
            {"workspace_name": "W", "email": "short@test.com", "password": "pass", "confirm_password": "pass"},
        )
        assert res_short.status_code == status.HTTP_400_BAD_REQUEST

        # Valid password succeeds with Argon2
        res_valid = api_client.post(
            "/api/auth/register/",
            {
                "workspace_name": "New Co",
                "email": "newuser@test.com",
                "password": "SuperSecurePassword123!",
                "confirm_password": "SuperSecurePassword123!",
            },
        )
        assert res_valid.status_code == status.HTTP_201_CREATED
        user = User.objects.get(email="newuser@test.com")
        assert user.password.startswith("argon2")

    def test_login_without_mfa(self, api_client, user_a):
        response = api_client.post("/api/auth/login/", {"email": user_a.email, "password": "SecurePassword123!"})
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["mfa_required"] is False
        assert data["user"]["email"] == user_a.email

    def test_mfa_setup_and_confirmation(self, api_client, user_a):
        api_client.force_authenticate(user=user_a)

        # 1. Initiate MFA setup
        setup_res = api_client.post("/api/auth/mfa/setup/")
        assert setup_res.status_code == status.HTTP_200_OK
        setup_data = setup_res.json()
        secret = setup_data["secret"]
        assert "qr_code_base64" in setup_data
        assert setup_data["qr_code_base64"].startswith("data:image/png;base64,")

        # 2. Generate valid TOTP token using secret
        totp = pyotp.TOTP(secret)
        valid_code = totp.now()

        # 3. Confirm MFA setup
        confirm_res = api_client.post("/api/auth/mfa/confirm/", {"code": valid_code})
        assert confirm_res.status_code == status.HTTP_200_OK
        confirm_data = confirm_res.json()

        # Must return 10 recovery codes
        assert len(confirm_data["recovery_codes"]) == 10

        user_a.refresh_from_db()
        assert user_a.mfa_enabled is True
        # QA 2026-11-21: the TOTP secret is stored only encrypted (UserMFA), never in the plaintext column.
        assert user_a.mfa_secret == ""
        from apps.accounts.services import decrypt_totp_secret
        assert user_a.mfa.encrypted_totp_secret and user_a.mfa.encrypted_totp_secret != secret
        assert decrypt_totp_secret(user_a.mfa.encrypted_totp_secret) == secret

    def test_mfa_login_flow_and_challenge(self, api_client, user_a):
        # Enable MFA on user_a
        secret = pyotp.random_base32()
        user_a.mfa_enabled = True
        user_a.mfa_secret = secret
        user_a.save()

        # 1. Login should state MFA is required
        login_res = api_client.post("/api/auth/login/", {"email": user_a.email, "password": "SecurePassword123!"})
        assert login_res.status_code == status.HTTP_200_OK
        assert login_res.json()["mfa_required"] is True

        # 2. Challenge with wrong code fails
        fail_res = api_client.post("/api/auth/mfa/challenge/", {"code": "000000"})
        assert fail_res.status_code == status.HTTP_400_BAD_REQUEST

        # 3. Challenge with correct TOTP code succeeds
        valid_code = pyotp.TOTP(secret).now()
        success_res = api_client.post("/api/auth/mfa/challenge/", {"code": valid_code})
        assert success_res.status_code == status.HTTP_200_OK
        assert success_res.json()["message"] == "MFA verification successful"

    def test_recovery_code_single_use(self, api_client, user_a):
        secret = pyotp.random_base32()
        user_a.mfa_enabled = True
        user_a.mfa_secret = secret
        user_a.save()

        # Generate recovery codes
        codes = generate_recovery_codes(user_a, count=5)
        test_code = codes[0]

        # Login to initiate MFA session
        api_client.post("/api/auth/login/", {"email": user_a.email, "password": "SecurePassword123!"})

        # Challenge using recovery code succeeds
        res_rec = api_client.post("/api/auth/mfa/challenge/", {"code": test_code})
        assert res_rec.status_code == status.HTTP_200_OK
        assert res_rec.json()["recovery_code_used"] is True

        # Recovery code is now marked used
        used_code_record = MFARecoveryCode.objects.filter(user=user_a, used_at__isnull=False)
        assert used_code_record.count() == 1

        # Attempting to reuse the exact same recovery code fails
        api_client.post("/api/auth/login/", {"email": user_a.email, "password": "SecurePassword123!"})
        res_reuse = api_client.post("/api/auth/mfa/challenge/", {"code": test_code})
        assert res_reuse.status_code == status.HTTP_400_BAD_REQUEST
