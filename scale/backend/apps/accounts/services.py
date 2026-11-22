import base64
import hashlib
import io
import secrets
import string
import urllib.request
from typing import Optional

from cryptography.fernet import Fernet
from django.conf import settings
import pyotp
import qrcode

from .models import MFAChallenge, MFARecoveryCode, User, UserMFA


def _get_mfa_cipher() -> Fernet:
    """Returns a Fernet cipher instance for encrypting TOTP secrets at rest."""
    key = getattr(settings, "MFA_ENCRYPTION_KEY", None)
    if not key:
        derived = hashlib.sha256(settings.SECRET_KEY.encode()).digest()
        key = base64.urlsafe_b64encode(derived)
    elif isinstance(key, str):
        key = key.encode()
    return Fernet(key)


def encrypt_totp_secret(raw_secret: str) -> str:
    """Encrypts a plaintext base32 TOTP secret at rest."""
    if not raw_secret:
        return ""
    return _get_mfa_cipher().encrypt(raw_secret.encode()).decode()


def decrypt_totp_secret(encrypted_secret: str) -> str:
    """Decrypts an encrypted TOTP secret.

    A value that is a Fernet token but fails to decrypt (wrong/rotated key, tampering) yields "" so
    verification fails closed. Previously the ciphertext itself was returned and used as the TOTP
    secret, which made pyotp raise on invalid base32 (HTTP 500) instead of a clean rejection.
    Legacy plaintext base32 secrets (pre-encryption rows) are still returned unchanged.
    """
    if not encrypted_secret:
        return ""
    try:
        return _get_mfa_cipher().decrypt(encrypted_secret.encode()).decode()
    except Exception:
        if encrypted_secret.startswith("gAAAAA"):
            import logging

            logging.getLogger(__name__).error("mfa_secret_decrypt_failed")
            return ""
        return encrypted_secret


# ---------------------------------------------------------------------------
# Per-account brute-force protection for the second factor.
# The IP-based DRF throttle alone is not enough: X-Forwarded-For is client-controlled when the API is
# reachable directly, and an attacker who knows the password can mint unlimited MFA challenges.
# ---------------------------------------------------------------------------
MFA_MAX_FAILURES = 10
MFA_LOCKOUT_SECONDS = 15 * 60


def _mfa_fail_key(user) -> str:
    return f"mfa_fail:{user.pk}"


def mfa_is_locked(user) -> bool:
    from django.core.cache import cache

    return int(cache.get(_mfa_fail_key(user), 0) or 0) >= MFA_MAX_FAILURES


def record_mfa_failure(user) -> None:
    from django.core.cache import cache

    key = _mfa_fail_key(user)
    cache.add(key, 0, timeout=MFA_LOCKOUT_SECONDS)
    try:
        cache.incr(key)
    except ValueError:  # expired between add and incr
        cache.set(key, 1, timeout=MFA_LOCKOUT_SECONDS)


def clear_mfa_failures(user) -> None:
    from django.core.cache import cache

    cache.delete(_mfa_fail_key(user))


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
    clean = code.strip().replace(" ", "").replace("-", "")
    if not clean.isdigit() or len(clean) != 6:
        return False
    totp = pyotp.TOTP(secret)
    return totp.verify(clean, valid_window=1)


def verify_totp_with_anti_replay(user: User, secret: str, code: str) -> bool:
    """
    Validates 6-digit TOTP code with valid_window=1 (±30s drift) and prevents reuse
    of codes within the same step.
    """
    if not secret or not code:
        return False
    clean = code.strip().replace(" ", "").replace("-", "")
    if not clean.isdigit() or len(clean) != 6:
        return False

    totp = pyotp.TOTP(secret)
    import datetime
    from django.core.cache import cache

    now_dt = datetime.datetime.now()
    if not totp.verify(clean, for_time=now_dt, valid_window=1):
        return False

    current_step = totp.timecode(now_dt)
    matched_step = None
    for offset in (0, -1, 1):
        step = current_step + offset
        if totp.generate_otp(step) == clean:
            matched_step = step
            break

    if matched_step is None:
        matched_step = current_step

    # Replay state is per SECRET: a freshly enrolled authenticator must not be blocked by steps used with the old one.
    secret_tag = hashlib.sha256(secret.encode()).hexdigest()[:16]
    replay_key = f"mfa_step:{user.id}:{secret_tag}:{matched_step}"
    if cache.get(replay_key):
        return False

    user_mfa = getattr(user, "mfa", None)
    if user_mfa and user_mfa.last_used_step and user_mfa.last_used_step >= matched_step:
        return False

    cache.set(replay_key, True, timeout=120)
    if user_mfa:
        user_mfa.last_used_step = matched_step
        user_mfa.save(update_fields=["last_used_step"])

    return True


def create_mfa_challenge(user: User, timeout_minutes: int = 5) -> tuple[MFAChallenge, str]:
    """
    Creates a single-use cryptographically random MFA challenge.
    Stores only the SHA256 hash in the database, returns the raw token to the client.
    """
    from datetime import timedelta
    from django.utils import timezone

    raw_token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
    expires_at = timezone.now() + timedelta(minutes=timeout_minutes)

    challenge = MFAChallenge.objects.create(
        user=user,
        challenge_token_hash=token_hash,
        expires_at=expires_at,
    )
    return challenge, raw_token


def get_valid_mfa_challenge(raw_token: str) -> tuple[Optional[MFAChallenge], Optional[str]]:
    """
    Validates challenge by raw token:
    Returns (challenge, None) on success, or (None, error_message) on failure.
    """
    from django.utils import timezone

    if not raw_token:
        return None, "MFA challenge token is required."

    token_hash = hashlib.sha256(raw_token.strip().encode()).hexdigest()
    challenge = MFAChallenge.objects.filter(challenge_token_hash=token_hash).first()

    if not challenge:
        return None, "Invalid or expired MFA challenge. Please sign in again."

    if challenge.consumed_at is not None:
        return None, "MFA challenge has already been used. Please sign in again."

    if timezone.now() > challenge.expires_at:
        return None, "MFA challenge has expired. Please sign in again."

    if challenge.attempts >= 5:
        return None, "Too many failed attempts. Please sign in again."

    return challenge, None


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
