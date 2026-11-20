import base64
import hashlib
import io
import secrets
import string
import urllib.request

import pyotp
import qrcode

from .models import MFARecoveryCode, User


def check_have_i_been_pwned(password: str) -> bool:
    """
    Checks if a password has appeared in data breaches using HaveIBeenPwned k-anonymity API.
    Returns True if password is breached (compromised), False otherwise.
    """
    sha1_hash = hashlib.sha1(password.encode("utf-8")).hexdigest().upper()
    prefix = sha1_hash[:5]
    suffix = sha1_hash[5:]

    url = f"https://api.pwnedpasswords.com/range/{prefix}"
    req = urllib.request.Request(url, headers={"User-Agent": "125EastCommerceIntelligence-SecurityCheck"})

    try:
        with urllib.request.urlopen(req, timeout=2.0) as response:
            if response.status == 200:
                body = response.read().decode("utf-8")
                for line in body.splitlines():
                    if line.startswith(suffix):
                        return True
    except Exception:
        # Graceful degradation if HIBP is down or offline
        return False
    return False


def generate_totp_secret() -> str:
    """Generates a secure Base32 TOTP secret."""
    return pyotp.random_base32()


def get_totp_provisioning_uri(user: User, secret: str, issuer: str = "125 East CI") -> str:
    """Returns the otpauth:// URI for authenticator apps."""
    totp = pyotp.TOTP(secret)
    return totp.provisioning_uri(name=user.email, issuer_name=issuer)


def generate_qr_code_base64(provisioning_uri: str) -> str:
    """Generates a base64 PNG data URL for an authenticator QR code."""
    img = qrcode.make(provisioning_uri)
    buffered = io.BytesIO()
    img.save(buffered, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffered.getvalue()).decode("utf-8")


def verify_totp_code(secret: str, code: str) -> bool:
    """Validates 6-digit TOTP code with standard time drift window."""
    if not secret or not code:
        return False
    totp = pyotp.TOTP(secret)
    return totp.verify(code.strip(), valid_window=1)


def generate_recovery_codes(user: User, count: int = 10) -> list[str]:
    """Generates single-use 10-char recovery codes and stores their SHA256 hashes."""
    # Delete existing codes
    MFARecoveryCode.objects.filter(user=user).delete()

    alphabet = string.ascii_uppercase + string.digits
    plaintext_codes = []

    for _ in range(count):
        raw_code = "".join(secrets.choice(alphabet) for _ in range(10))
        # Format as XXXX-XXXXXX
        formatted = f"{raw_code[:4]}-{raw_code[4:]}"
        plaintext_codes.append(formatted)

        code_hash = hashlib.sha256(formatted.encode("utf-8")).hexdigest()
        MFARecoveryCode.objects.create(
            user=user,
            code_hash=code_hash,
        )

    return plaintext_codes


def verify_and_consume_recovery_code(user: User, raw_code: str) -> bool:
    """Verifies a recovery code, marks it used if valid, and returns True."""
    code_hash = hashlib.sha256(raw_code.strip().upper().encode("utf-8")).hexdigest()
    try:
        record = MFARecoveryCode.objects.get(user=user, code_hash=code_hash, used_at__isnull=True)
        from django.utils import timezone

        record.used_at = timezone.now()
        record.save(update_fields=["used_at"])
        return True
    except MFARecoveryCode.DoesNotExist:
        return False


# ---------------------------------------------------------------------------
# Registration + password reset
# ---------------------------------------------------------------------------
class DuplicateEmailError(Exception):
    """Raised when a concurrent registration claimed the email between validation and insert."""


def register_user_with_workspace(email: str, password: str, workspace_name: str):
    """
    Create user + workspace + owner membership (+ default brand, audit row) in ONE transaction.
    If any step fails nothing is persisted, so there are never users without a workspace or vice versa.
    """
    from django.db import IntegrityError, transaction

    from apps.tenancy.services import create_workspace_for_owner

    try:
        with transaction.atomic():
            user = User.objects.create_user(email=email, password=password)
            workspace, _brand = create_workspace_for_owner(user, workspace_name)
    except IntegrityError as exc:
        if User.objects.filter(email__iexact=email).exists():
            raise DuplicateEmailError(email) from exc
        raise
    return user, workspace


def send_password_reset_email(user: User) -> None:
    """Email a single-use reset link. The token is bound to the current password hash and last_login,
    so it stops working once used (password changes) and expires after PASSWORD_RESET_TIMEOUT."""
    from django.conf import settings
    from django.contrib.auth.tokens import default_token_generator
    from django.core.mail import send_mail
    from django.utils.encoding import force_bytes
    from django.utils.http import urlsafe_base64_encode

    uid = urlsafe_base64_encode(force_bytes(user.pk))
    token = default_token_generator.make_token(user)
    link = f"{settings.FRONTEND_URL.rstrip('/')}/reset-password?uid={uid}&token={token}"
    hours = max(1, settings.PASSWORD_RESET_TIMEOUT // 3600)
    send_mail(
        subject="Reset your password",
        message=(
            "We received a request to reset the password for your account.\n\n"
            f"Reset it here (link valid for {hours} hours, single use):\n{link}\n\n"
            "If you didn't ask for this, you can ignore this email; your password won't change."
        ),
        from_email=settings.DEFAULT_FROM_EMAIL,
        recipient_list=[user.email],
        fail_silently=False,
    )
