import logging

from django.contrib.auth import login as auth_login
from django.contrib.auth import logout as auth_logout
from django.contrib.auth.tokens import default_token_generator
from django.middleware.csrf import get_token
from django.utils.decorators import method_decorator
from django.utils.encoding import force_str
from django.utils.http import urlsafe_base64_decode
from django.views.decorators.csrf import ensure_csrf_cookie
from rest_framework import serializers, status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.tenancy.models import BrandMember, WorkspaceMember

from .authentication import CsrfProtectedMixin
from .models import MFAChallenge, MFARecoveryCode, User, UserMFA
from .serializers import (
    DUPLICATE_EMAIL,
    LoginSerializer,
    MFAChallengeSerializer,
    MFADisableSerializer,
    MFARecoveryRegenerateSerializer,
    MFARecoverySerializer,
    MFASetupConfirmSerializer,
    MFAVerifySerializer,
    PasswordResetConfirmSerializer,
    PasswordResetRequestSerializer,
    RegisterSerializer,
    UserSerializer,
    _check_password_strength,
)
from .services import (
    DuplicateEmailError,
    create_mfa_challenge,
    decrypt_totp_secret,
    encrypt_totp_secret,
    generate_qr_code_base64,
    generate_recovery_codes,
    generate_totp_secret,
    get_totp_provisioning_uri,
    get_valid_mfa_challenge,
    register_user_with_workspace,
    send_password_reset_email,
    verify_and_consume_recovery_code,
    clear_mfa_failures,
    mfa_is_locked,
    record_mfa_failure,
    verify_totp_with_anti_replay,
)

logger = logging.getLogger(__name__)

POST_AUTH_REDIRECT = "/dashboard"

MFA_LOCKED_RESPONSE = {"error": "Too many failed verification attempts. Please wait 15 minutes and try again."}


def _active_totp_secret(user) -> str:
    """The confirmed TOTP secret: encrypted UserMFA row when enabled, else the legacy column (old rows)."""
    user_mfa = getattr(user, "mfa", None)
    if user_mfa and user_mfa.is_enabled and user_mfa.encrypted_totp_secret:
        secret = decrypt_totp_secret(user_mfa.encrypted_totp_secret)
        if secret:
            return secret
    return user.mfa_secret or ""


def get_client_ip(request):
    x_forwarded_for = request.META.get("HTTP_X_FORWARDED_FOR")
    if x_forwarded_for:
        return x_forwarded_for.split(",")[0].strip()
    return request.META.get("REMOTE_ADDR")


def error_response(serializer_errors, http_status=status.HTTP_400_BAD_REQUEST):
    """
    Uniform error body for auth endpoints: {"error": "<first human message>", "fields": {...}}.
    `error` is what the UI shows; `fields` lets forms highlight individual inputs.
    """
    fields = {}
    first = None
    for key, msgs in (serializer_errors or {}).items():
        msgs = [str(m) for m in (msgs if isinstance(msgs, (list, tuple)) else [msgs])]
        fields[key] = msgs
        if first is None and msgs:
            first = msgs[0]
    return Response({"error": first or "Invalid request.", "fields": fields}, status=http_status)


def workspaces_for(user):
    """Active workspaces the user is a member of, with role and the brands they may see."""
    memberships = (
        WorkspaceMember.objects.filter(user=user, workspace__is_active=True)
        .select_related("workspace")
        .prefetch_related("workspace__brands")
        .order_by("workspace__name")
    )
    restricted = {}
    for brand_id, ws_id in BrandMember.objects.filter(user=user).values_list("brand_id", "brand__workspace_id"):
        restricted.setdefault(ws_id, set()).add(brand_id)

    data = []
    for m in memberships:
        allowed = restricted.get(m.workspace_id)
        brands = [b for b in m.workspace.brands.all() if allowed is None or b.id in allowed]
        data.append(
            {
                "id": str(m.workspace.id),
                "name": m.workspace.name,
                "slug": m.workspace.slug,
                "role": m.role,
                "brands": [
                    {"id": str(b.id), "name": b.name, "currency": b.currency, "timezone": b.timezone}
                    for b in brands
                ],
            }
        )
    return data


def start_session(request, user, mfa_verified=False):
    """Log the user in with a fresh session id (prevents session fixation)."""
    auth_login(request, user, backend="django.contrib.auth.backends.ModelBackend")
    request.session.cycle_key()
    request.session["mfa_verified"] = bool(mfa_verified)


@method_decorator(ensure_csrf_cookie, name="dispatch")
class CsrfView(APIView):
    """
    GET /api/auth/csrf/
    Sets the csrftoken cookie; the frontend echoes it back as X-CSRFToken on every mutating request.
    """

    permission_classes = [AllowAny]
    authentication_classes = []

    def get(self, request):
        return Response({"csrfToken": get_token(request)})


class RegisterView(CsrfProtectedMixin, APIView):
    """
    POST /api/auth/register/  {workspace_name, email, password, confirm_password}
    Creates user + workspace + owner membership atomically, then signs the user in.
    """

    permission_classes = [AllowAny]
    throttle_scope = "auth"

    def post(self, request):
        serializer = RegisterSerializer(data=request.data)
        if not serializer.is_valid():
            return error_response(serializer.errors)

        data = serializer.validated_data
        try:
            user, workspace = register_user_with_workspace(data["email"], data["password"], data["workspace_name"])
        except DuplicateEmailError:
            return error_response({"email": [DUPLICATE_EMAIL]})

        start_session(request, user)
        logger.info("user_registered", extra={"user_id": str(user.id), "workspace_id": str(workspace.id)})
        return Response(
            {
                "user": UserSerializer(user).data,
                "workspaces": workspaces_for(user),
                "workspace": {"id": str(workspace.id), "slug": workspace.slug, "name": workspace.name},
                "redirect": POST_AUTH_REDIRECT,
            },
            status=status.HTTP_201_CREATED,
        )


class LoginView(CsrfProtectedMixin, APIView):
    """POST /api/auth/login/  {email, password}"""

    permission_classes = [AllowAny]
    throttle_scope = "auth"

    def post(self, request):
        serializer = LoginSerializer(data=request.data)
        if not serializer.is_valid():
            return error_response(serializer.errors)

        user = serializer.validated_data["user"]

        if user.mfa_enabled:
            # Generate cryptographic challenge token for TOTP step
            from django.utils import timezone
            _challenge, raw_token = create_mfa_challenge(user, timeout_minutes=5)
            request.session["pre_mfa_user_id"] = str(user.id)
            request.session["pre_mfa_at"] = timezone.now().timestamp()
            return Response(
                {
                    "mfa_required": True,
                    "challenge_token": raw_token,
                    "email": user.email,
                },
                status=status.HTTP_200_OK,
            )

        start_session(request, user)
        return Response(
            {
                "mfa_required": False,
                "user": UserSerializer(user).data,
                "workspaces": workspaces_for(user),
                "redirect": POST_AUTH_REDIRECT,
            }
        )


class MFAChallengeView(CsrfProtectedMixin, APIView):
    """
    POST /api/auth/mfa/challenge/ or POST /api/v1/auth/mfa/verify/
    Verifies 6-digit TOTP code via challenge_token or active pre_mfa session.
    """
    permission_classes = [AllowAny]
    throttle_scope = "auth"

    def post(self, request):
        serializer = MFAChallengeSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        challenge_token = serializer.validated_data.get("challenge_token")
        code = serializer.validated_data["code"].strip()

        challenge = None
        user = None

        if challenge_token:
            challenge, err = get_valid_mfa_challenge(challenge_token)
            if err:
                return Response({"error": err}, status=status.HTTP_401_UNAUTHORIZED if "expired" in err or "sign in again" in err else status.HTTP_400_BAD_REQUEST)
            user = challenge.user
        else:
            user_id = request.session.get("pre_mfa_user_id")
            pre_mfa_at = request.session.get("pre_mfa_at")
            from django.utils import timezone
            if not user_id or not pre_mfa_at or (timezone.now().timestamp() - pre_mfa_at) > 300:
                request.session.pop("pre_mfa_user_id", None)
                request.session.pop("pre_mfa_at", None)
                return Response(
                    {"error": "No active MFA login session found. Please log in again."},
                    status=status.HTTP_401_UNAUTHORIZED,
                )
            try:
                user = User.objects.get(id=user_id, is_active=True)
            except User.DoesNotExist:
                return Response({"error": "User not found."}, status=status.HTTP_401_UNAUTHORIZED)

        if mfa_is_locked(user):
            return Response(MFA_LOCKED_RESPONSE, status=status.HTTP_429_TOO_MANY_REQUESTS)

        # Only the CONFIRMED secret may satisfy login. (A pending, unconfirmed enrollment secret must never
        # be accepted here, otherwise a stolen session could re-enroll and own the second factor.)
        secret = _active_totp_secret(user)

        is_valid_totp = False
        if secret:
            is_valid_totp = verify_totp_with_anti_replay(user, secret, code)

        is_valid_recovery = False
        if not is_valid_totp:
            # Check recovery code fallback
            is_valid_recovery = verify_and_consume_recovery_code(user, code)

        if not (is_valid_totp or is_valid_recovery):
            record_mfa_failure(user)
            if challenge:
                challenge.attempts += 1
                challenge.save(update_fields=["attempts"])
            return Response(
                {"error": "Invalid verification code or recovery code."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Success - consume challenge and start session
        clear_mfa_failures(user)
        if challenge:
            challenge.consume()
        request.session.pop("pre_mfa_user_id", None)
        request.session.pop("pre_mfa_at", None)
        start_session(request, user, mfa_verified=True)

        return Response(
            {
                "message": "MFA verification successful",
                "recovery_code_used": is_valid_recovery,
                "user": UserSerializer(user).data,
                "workspaces": workspaces_for(user),
                "redirect": POST_AUTH_REDIRECT,
            }
        )


class MFAVerifyView(MFAChallengeView):
    """POST /api/v1/auth/mfa/verify/ alias for MFAChallengeView"""
    pass


class MFARecoveryLoginView(CsrfProtectedMixin, APIView):
    """
    POST /api/v1/auth/mfa/recovery/  {challenge_token, recovery_code}
    """
    permission_classes = [AllowAny]
    throttle_scope = "auth"

    def post(self, request):
        serializer = MFARecoverySerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        challenge_token = serializer.validated_data.get("challenge_token")
        recovery_code = serializer.validated_data["recovery_code"].strip()

        challenge = None
        user = None

        if challenge_token:
            challenge, err = get_valid_mfa_challenge(challenge_token)
            if err:
                return Response({"error": err}, status=status.HTTP_401_UNAUTHORIZED if "sign in again" in err else status.HTTP_400_BAD_REQUEST)
            user = challenge.user
        else:
            user_id = request.session.get("pre_mfa_user_id")
            pre_mfa_at = request.session.get("pre_mfa_at")
            from django.utils import timezone
            if not user_id or not pre_mfa_at or (timezone.now().timestamp() - pre_mfa_at) > 300:
                request.session.pop("pre_mfa_user_id", None)
                request.session.pop("pre_mfa_at", None)
                return Response(
                    {"error": "No active MFA login session found. Please log in again."},
                    status=status.HTTP_401_UNAUTHORIZED,
                )
            try:
                user = User.objects.get(id=user_id, is_active=True)
            except User.DoesNotExist:
                return Response({"error": "User not found."}, status=status.HTTP_401_UNAUTHORIZED)

        if mfa_is_locked(user):
            return Response(MFA_LOCKED_RESPONSE, status=status.HTTP_429_TOO_MANY_REQUESTS)

        if not verify_and_consume_recovery_code(user, recovery_code):
            record_mfa_failure(user)
            if challenge:
                challenge.attempts += 1
                challenge.save(update_fields=["attempts"])
            return Response(
                {"error": "Invalid or already-used recovery code."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        clear_mfa_failures(user)
        if challenge:
            challenge.consume()
        request.session.pop("pre_mfa_user_id", None)
        request.session.pop("pre_mfa_at", None)
        start_session(request, user, mfa_verified=True)

        return Response(
            {
                "message": "Recovery code accepted. Login successful.",
                "recovery_code_used": True,
                "user": UserSerializer(user).data,
                "workspaces": workspaces_for(user),
                "redirect": POST_AUTH_REDIRECT,
            }
        )


class MFASetupView(APIView):
    """
    POST /api/v1/security/mfa/setup/ or POST /api/auth/mfa/setup/
    """
    permission_classes = [IsAuthenticated]
    throttle_scope = "auth"

    def post(self, request):
        existing = getattr(request.user, "mfa", None)
        if request.user.mfa_enabled or (existing and existing.is_enabled):
            # Re-enrolling would replace the second factor with only a session as proof. Require the
            # disable flow (password + current code) first.
            return Response(
                {"error": "Two-factor authentication is already enabled. Disable it first to enroll a new authenticator."},
                status=status.HTTP_409_CONFLICT,
            )

        secret = generate_totp_secret()
        encrypted = encrypt_totp_secret(secret)

        user_mfa, _ = UserMFA.objects.get_or_create(user=request.user)
        user_mfa.encrypted_totp_secret = encrypted
        user_mfa.is_enabled = False
        user_mfa.confirmed_at = None
        user_mfa.last_used_step = 0  # replay high-water mark belongs to the previous secret
        user_mfa.save()

        request.session["pending_mfa_secret"] = secret

        uri = get_totp_provisioning_uri(request.user, secret)
        qr_code = generate_qr_code_base64(uri)

        return Response(
            {
                "secret": secret,
                "provisioning_uri": uri,
                "qr_code_base64": qr_code,
            }
        )


class MFAConfirmView(APIView):
    """
    POST /api/v1/security/mfa/confirm/ or POST /api/auth/mfa/confirm/
    """
    permission_classes = [IsAuthenticated]
    throttle_scope = "auth"

    def post(self, request):
        serializer = MFASetupConfirmSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        secret = request.session.get("pending_mfa_secret")
        user_mfa = getattr(request.user, "mfa", None)
        if not secret and user_mfa and user_mfa.encrypted_totp_secret:
            secret = decrypt_totp_secret(user_mfa.encrypted_totp_secret)

        if not secret:
            return Response({"error": "No pending MFA setup found. Please start setup again."}, status=status.HTTP_400_BAD_REQUEST)

        code = serializer.validated_data["code"]
        if not verify_totp_with_anti_replay(request.user, secret, code):
            return Response(
                {"error": "Invalid verification code. Please check your authenticator app."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        from django.utils import timezone
        if not user_mfa:
            user_mfa, _ = UserMFA.objects.get_or_create(user=request.user)
        user_mfa.encrypted_totp_secret = encrypt_totp_secret(secret)
        user_mfa.is_enabled = True
        user_mfa.confirmed_at = timezone.now()
        user_mfa.save()

        user = request.user
        # The secret is stored ONLY encrypted (UserMFA). The legacy plaintext column is cleared.
        user.mfa_secret = ""
        user.mfa_enabled = True
        user.save(update_fields=["mfa_secret", "mfa_enabled"])

        request.session.pop("pending_mfa_secret", None)
        request.session["mfa_verified"] = True

        # Generate 10 one-time recovery codes
        recovery_codes = generate_recovery_codes(user)

        return Response(
            {
                "message": "Two-factor authentication enabled successfully.",
                "recovery_codes": recovery_codes,
            }
        )


class MFADisableView(APIView):
    """
    POST /api/v1/security/mfa/disable/
    Requires user's current password plus either a valid TOTP code or recovery code.
    """
    permission_classes = [IsAuthenticated]
    throttle_scope = "auth"

    def post(self, request):
        serializer = MFADisableSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        user = request.user
        password = serializer.validated_data["password"]
        if not user.check_password(password):
            return Response({"error": "Incorrect password."}, status=status.HTTP_400_BAD_REQUEST)

        if mfa_is_locked(user):
            return Response(MFA_LOCKED_RESPONSE, status=status.HTTP_429_TOO_MANY_REQUESTS)

        code = serializer.validated_data.get("code", "").strip()
        user_mfa = getattr(user, "mfa", None)
        secret = _active_totp_secret(user)

        verified = False
        if code:
            if secret and verify_totp_with_anti_replay(user, secret, code):
                verified = True
            elif verify_and_consume_recovery_code(user, code):
                verified = True

        if not verified:
            record_mfa_failure(user)
            return Response({"error": "A valid 6-digit OTP or recovery code is required to disable 2FA."}, status=status.HTTP_400_BAD_REQUEST)

        # Disable MFA
        user.mfa_enabled = False
        user.mfa_secret = ""
        user.save(update_fields=["mfa_enabled", "mfa_secret"])

        if user_mfa:
            user_mfa.is_enabled = False
            user_mfa.encrypted_totp_secret = ""
            user_mfa.last_used_step = 0
            user_mfa.save(update_fields=["is_enabled", "encrypted_totp_secret", "last_used_step"])

        MFARecoveryCode.objects.filter(user=user).delete()
        MFAChallenge.objects.filter(user=user).delete()
        request.session["mfa_verified"] = False

        return Response({"message": "Two-factor authentication has been disabled."})


class MFAStatusView(APIView):
    """
    GET /api/v1/security/mfa/status/
    """
    permission_classes = [IsAuthenticated]

    def get(self, request):
        user = request.user
        user_mfa = getattr(user, "mfa", None)
        is_enabled = bool((user_mfa and user_mfa.is_enabled) or user.mfa_enabled)
        is_pending = bool(not is_enabled and ((user_mfa and user_mfa.encrypted_totp_secret) or request.session.get("pending_mfa_secret")))
        unused_codes = MFARecoveryCode.objects.filter(user=user, used_at__isnull=True).count()
        confirmed_at = user_mfa.confirmed_at.isoformat() if (user_mfa and user_mfa.confirmed_at) else None

        return Response(
            {
                "is_enabled": is_enabled,
                "is_pending": is_pending,
                "unused_recovery_codes_count": unused_codes,
                "confirmed_at": confirmed_at,
            }
        )


class MFARecoveryRegenerateView(APIView):
    """
    POST /api/v1/security/mfa/recovery-codes/regenerate/
    """
    permission_classes = [IsAuthenticated]
    throttle_scope = "auth"

    def post(self, request):
        serializer = MFARecoveryRegenerateSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        user = request.user
        if not user.mfa_enabled:
            return Response({"error": "MFA is not enabled on this account."}, status=status.HTTP_400_BAD_REQUEST)

        password = serializer.validated_data["password"]
        if not user.check_password(password):
            return Response({"error": "Incorrect password."}, status=status.HTTP_400_BAD_REQUEST)

        codes = generate_recovery_codes(user)
        return Response({"recovery_codes": codes, "message": "Recovery codes regenerated successfully."})


class LogoutView(APIView):
    """POST /api/auth/logout/  Deletes the server-side session row and clears the cookie."""

    permission_classes = [IsAuthenticated]

    def post(self, request):
        auth_logout(request)
        return Response({"message": "Logged out successfully."})


class MeView(APIView):
    """GET /api/auth/me/  Current user + workspace memberships. 401 when there is no valid session."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response({"user": UserSerializer(request.user).data, "workspaces": workspaces_for(request.user)})


class PasswordResetRequestView(CsrfProtectedMixin, APIView):
    """
    POST /api/auth/password-reset/  {email}
    Always answers 200 with the same body so it can't be used to discover which emails have accounts.
    """

    permission_classes = [AllowAny]
    throttle_scope = "auth"
    GENERIC = {"message": "If an account exists for that email, a password reset link has been sent."}

    def post(self, request):
        serializer = PasswordResetRequestSerializer(data=request.data)
        if not serializer.is_valid():
            return error_response(serializer.errors)
        email = serializer.validated_data["email"].strip().lower()
        user = User.objects.filter(email__iexact=email, is_active=True).first()
        # Deliberately includes users with an unusable password: accounts created under the old Firebase /
        # Supabase sign-in never had a local password, and this link (proof of inbox ownership) is how they set one.
        if user:
            try:
                send_password_reset_email(user)
            except Exception:  # never reveal delivery failures (or account existence) to the caller
                logger.exception("password_reset_email_failed", extra={"user_id": str(user.id)})
        return Response(self.GENERIC)


class PasswordResetConfirmView(CsrfProtectedMixin, APIView):
    """
    POST /api/auth/password-reset/confirm/  {uid, token, password, confirm_password}
    Changing the password invalidates the reset token and every existing session of the user.
    """

    permission_classes = [AllowAny]
    throttle_scope = "auth"
    INVALID_LINK = "This password reset link is invalid or has expired. Please request a new one."

    def post(self, request):
        serializer = PasswordResetConfirmSerializer(data=request.data)
        if not serializer.is_valid():
            return error_response(serializer.errors)
        data = serializer.validated_data

        try:
            user = User.objects.filter(pk=force_str(urlsafe_base64_decode(data["uid"])), is_active=True).first()
        except Exception:  # malformed uid (bad base64 / not a UUID) -> same answer as a wrong token
            user = None
        if user is None or not default_token_generator.check_token(user, data["token"]):
            return error_response({"token": [self.INVALID_LINK]})

        try:
            _check_password_strength(data["password"], user.email)
        except serializers.ValidationError as exc:
            return error_response(exc.detail)
        user.set_password(data["password"])
        user.save(update_fields=["password", "updated_at"])
        return Response({"message": "Your password has been reset. You can now sign in."})
