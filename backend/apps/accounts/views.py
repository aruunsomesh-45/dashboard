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
from .models import User
from .serializers import (
    DUPLICATE_EMAIL,
    LoginSerializer,
    MFAChallengeSerializer,
    MFASetupConfirmSerializer,
    PasswordResetConfirmSerializer,
    PasswordResetRequestSerializer,
    RegisterSerializer,
    UserSerializer,
    _check_password_strength,
)
from .services import (
    DuplicateEmailError,
    generate_qr_code_base64,
    generate_recovery_codes,
    generate_totp_secret,
    get_totp_provisioning_uri,
    register_user_with_workspace,
    send_password_reset_email,
    verify_and_consume_recovery_code,
    verify_totp_code,
)

logger = logging.getLogger(__name__)

POST_AUTH_REDIRECT = "/dashboard"


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
            # Password step done; the session is NOT authenticated until the TOTP challenge passes.
            request.session["pre_mfa_user_id"] = str(user.id)
            from django.utils import timezone
            request.session["pre_mfa_at"] = timezone.now().timestamp()
            return Response({"mfa_required": True, "email": user.email}, status=status.HTTP_200_OK)

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
    permission_classes = [AllowAny]
    throttle_scope = "auth"

    def post(self, request):
        serializer = MFAChallengeSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

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

        code = serializer.validated_data["code"].strip()

        # Check TOTP first (with anti-replay check)
        from django.core.cache import cache
        replay_key = f"mfa_used:{user.id}:{code}"
        if cache.get(replay_key):
            is_valid_totp = False
        else:
            is_valid_totp = verify_totp_code(user.mfa_secret, code)
            if is_valid_totp:
                cache.set(replay_key, True, timeout=90)
        is_valid_recovery = False

        if not is_valid_totp:
            # Check recovery code fallback
            is_valid_recovery = verify_and_consume_recovery_code(user, code)

        if not (is_valid_totp or is_valid_recovery):
            return Response(
                {"error": "Invalid verification code or recovery code."}, status=status.HTTP_400_BAD_REQUEST
            )

        # Complete login
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


class MFASetupView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        secret = generate_totp_secret()
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
    permission_classes = [IsAuthenticated]

    def post(self, request):
        serializer = MFASetupConfirmSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        secret = request.session.get("pending_mfa_secret")
        if not secret:
            return Response({"error": "No pending MFA setup found."}, status=status.HTTP_400_BAD_REQUEST)

        code = serializer.validated_data["code"]
        if not verify_totp_code(secret, code):
            return Response(
                {"error": "Invalid verification code. Please check your authenticator app."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Persist MFA secret to user
        user = request.user
        user.mfa_secret = secret
        user.mfa_enabled = True
        user.save(update_fields=["mfa_secret", "mfa_enabled"])
        if "pending_mfa_secret" in request.session:
            del request.session["pending_mfa_secret"]
        request.session["mfa_verified"] = True

        # Generate recovery codes
        recovery_codes = generate_recovery_codes(user)

        return Response(
            {
                "message": "MFA enabled successfully.",
                "recovery_codes": recovery_codes,
            }
        )


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
