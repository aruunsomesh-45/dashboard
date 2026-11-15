from django.conf import settings
from django.contrib.auth import login as auth_login
from django.contrib.auth import logout as auth_logout
from django.middleware.csrf import get_token
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import ensure_csrf_cookie
from rest_framework import status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.tenancy.models import WorkspaceMember

from .models import User
from .serializers import (
    LoginSerializer,
    MFAChallengeSerializer,
    MFASetupConfirmSerializer,
    RegisterSerializer,
    UserSerializer,
)
from .services import (
    generate_qr_code_base64,
    generate_recovery_codes,
    generate_totp_secret,
    get_totp_provisioning_uri,
    verify_and_consume_recovery_code,
    verify_totp_code,
)


def get_client_ip(request):
    x_forwarded_for = request.META.get("HTTP_X_FORWARDED_FOR")
    if x_forwarded_for:
        return x_forwarded_for.split(",")[0].strip()
    return request.META.get("REMOTE_ADDR")


@method_decorator(ensure_csrf_cookie, name="dispatch")
class CsrfView(APIView):
    """
    GET /api/auth/csrf/
    Sets the csrftoken cookie so the browser (and apiFetch) can read it
    and include it as X-CSRFToken on all mutating requests.
    No authentication required — this is called before login.
    """

    permission_classes = [AllowAny]
    authentication_classes = []  # Skip session auth — no session yet

    def get(self, request):
        return Response({"csrfToken": get_token(request)})


class RegisterView(APIView):
    permission_classes = [AllowAny]
    throttle_scope = "auth"

    def post(self, request):
        serializer = RegisterSerializer(data=request.data)
        if serializer.is_valid():
            user = serializer.save()
            return Response(
                {"message": "User registered successfully", "user": UserSerializer(user).data},
                status=status.HTTP_201_CREATED,
            )
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)


class LoginView(APIView):
    permission_classes = [AllowAny]
    throttle_scope = "auth"

    def post(self, request):
        serializer = LoginSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        user = serializer.validated_data["user"]

        if user.mfa_enabled:
            # Store partial session state for MFA challenge
            request.session["pre_mfa_user_id"] = str(user.id)
            return Response({"mfa_required": True, "email": user.email}, status=status.HTTP_200_OK)

        # Full login
        auth_login(request, user)
        request.session.cycle_key()  # Rotate session ID to protect against session fixation
        request.session["mfa_verified"] = False

        # Build list of user's workspaces
        memberships = WorkspaceMember.objects.filter(user=user, workspace__is_active=True).select_related("workspace")
        workspaces_data = [
            {
                "id": m.workspace.id,
                "name": m.workspace.name,
                "slug": m.workspace.slug,
                "role": m.role,
            }
            for m in memberships
        ]

        return Response(
            {
                "mfa_required": False,
                "user": UserSerializer(user).data,
                "workspaces": workspaces_data,
            }
        )


class MFAChallengeView(APIView):
    permission_classes = [AllowAny]
    throttle_scope = "auth"

    def post(self, request):
        serializer = MFAChallengeSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        user_id = request.session.get("pre_mfa_user_id")
        if not user_id:
            return Response(
                {"error": "No active MFA login session found. Please log in again."},
                status=status.HTTP_401_UNAUTHORIZED,
            )

        try:
            user = User.objects.get(id=user_id, is_active=True)
        except User.DoesNotExist:
            return Response({"error": "User not found."}, status=status.HTTP_401_UNAUTHORIZED)

        code = serializer.validated_data["code"].strip()

        # Check TOTP first
        is_valid_totp = verify_totp_code(user.mfa_secret, code)
        is_valid_recovery = False

        if not is_valid_totp:
            # Check recovery code fallback
            is_valid_recovery = verify_and_consume_recovery_code(user, code)

        if not (is_valid_totp or is_valid_recovery):
            return Response(
                {"error": "Invalid verification code or recovery code."}, status=status.HTTP_400_BAD_REQUEST
            )

        # Complete login
        auth_login(request, user)
        request.session.cycle_key()
        if "pre_mfa_user_id" in request.session:
            del request.session["pre_mfa_user_id"]
        request.session["mfa_verified"] = True

        memberships = WorkspaceMember.objects.filter(user=user, workspace__is_active=True).select_related("workspace")
        workspaces_data = [
            {
                "id": m.workspace.id,
                "name": m.workspace.name,
                "slug": m.workspace.slug,
                "role": m.role,
            }
            for m in memberships
        ]

        return Response(
            {
                "message": "MFA verification successful",
                "recovery_code_used": is_valid_recovery,
                "user": UserSerializer(user).data,
                "workspaces": workspaces_data,
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
    permission_classes = [IsAuthenticated]

    def post(self, request):
        auth_logout(request)
        return Response({"message": "Logged out successfully."})


class MeView(APIView):
    def get_permissions(self):
        return [IsAuthenticated()]

    def get(self, request):
        user = request.user
        if not user or not user.is_authenticated:
            return Response({"detail": "Authentication credentials were not provided."}, status=status.HTTP_401_UNAUTHORIZED)

        from apps.tenancy.models import BrandMember
        memberships = (
            WorkspaceMember.objects.filter(user=user, workspace__is_active=True)
            .select_related("workspace")
            .prefetch_related("workspace__brands")
        )

        workspaces_data = []
        for m in memberships:
            brands = m.workspace.brands.all()
            user_brands = BrandMember.objects.filter(brand__workspace=m.workspace, user=user).values_list("brand_id", flat=True)
            if user_brands.exists():
                brands = brands.filter(id__in=user_brands)

            workspaces_data.append(
                {
                    "id": str(m.workspace.id),
                    "name": m.workspace.name,
                    "slug": m.workspace.slug,
                    "role": m.role,
                    "brands": [
                        {
                            "id": str(b.id),
                            "name": b.name,
                            "currency": b.currency,
                            "timezone": b.timezone,
                        }
                        for b in brands
                    ],
                }
            )

        return Response(
            {
                "user": UserSerializer(user).data,
                "workspaces": workspaces_data,
            }
        )
