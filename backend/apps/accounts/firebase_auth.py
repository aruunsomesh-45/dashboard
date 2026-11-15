import hashlib
import json
import logging
import os
from typing import Any, Optional, Tuple

import firebase_admin
from firebase_admin import auth as firebase_auth_admin, credentials
import jwt
from django.conf import settings
from django.contrib.auth import get_user_model
from rest_framework import authentication, exceptions

logger = logging.getLogger(__name__)
User = get_user_model()

_firebase_app_initialized = False


def get_firebase_app():
    global _firebase_app_initialized
    if _firebase_app_initialized and firebase_admin._apps:
        return firebase_admin.get_app()

    if not firebase_admin._apps:
        cred_path = os.environ.get("FIREBASE_SERVICE_ACCOUNT_KEY")
        cred_json = os.environ.get("FIREBASE_CREDENTIALS_JSON")
        project_id = os.environ.get("FIREBASE_PROJECT_ID") or os.environ.get("NEXT_PUBLIC_FIREBASE_PROJECT_ID", "east-b2b-saas")

        try:
            if cred_path and os.path.exists(cred_path):
                cred = credentials.Certificate(cred_path)
                firebase_admin.initialize_app(cred, {"projectId": project_id})
            elif cred_json:
                cred_dict = json.loads(cred_json)
                cred = credentials.Certificate(cred_dict)
                firebase_admin.initialize_app(cred, {"projectId": project_id})
            else:
                firebase_admin.initialize_app(options={"projectId": project_id})
            _firebase_app_initialized = True
        except Exception as exc:
            logger.info("Firebase Admin initialized with default configuration: %s", exc)
            _firebase_app_initialized = True

    return firebase_admin.get_app() if firebase_admin._apps else None


def verify_firebase_id_token(token: str) -> Optional[dict]:
    """
    Verifies a Firebase ID token.
    1. In dev/test, supports mock tokens.
    2. Inspects header: Firebase tokens are always RS256 signed.
    3. Uses firebase_admin.auth.verify_id_token for cryptographical verification.
    """
    # 1. Dev / test mock tokens
    if getattr(settings, "DEBUG", False) or getattr(settings, "TESTING", False):
        if token in ("dev-mock-token", "mock-token", "test-token") or token.startswith("dev-"):
            user = User.objects.filter(is_active=True).first()
            return {
                "uid": str(user.id) if user else "00000000-0000-0000-0000-000000000001",
                "email": user.email if user else "dev@125east.com",
                "name": "Dev User",
                "firebase": {"sign_in_provider": "password"},
            }

    # 2. Inspect header: if not RS256, skip to let other authenticators handle it
    try:
        header = jwt.get_unverified_header(token)
        if header.get("alg") != "RS256":
            return None
    except Exception:
        return None

    # 3. Production Firebase verification
    try:
        get_firebase_app()
        decoded_claims = firebase_auth_admin.verify_id_token(token, check_revoked=False)
        return decoded_claims
    except Exception as exc:
        logger.debug("Firebase admin verify_id_token failed: %s", exc)
        return None


class FirebaseAuthentication(authentication.BaseAuthentication):
    """
    DRF authentication class verifying Firebase ID tokens (Authorization: Bearer <ID_TOKEN>).
    Provisions or loads corresponding User model and attaches token claims to request.auth.
    """

    keyword = "Bearer"

    def authenticate_header(self, request):
        return self.keyword

    def authenticate(self, request) -> Optional[Tuple[Any, Any]]:
        auth_header = authentication.get_authorization_header(request).decode("utf-8")
        if not auth_header or not auth_header.startswith(f"{self.keyword} "):
            return None

        token = auth_header[len(self.keyword) + 1 :].strip()
        if not token:
            return None

        claims = verify_firebase_id_token(token)
        if not claims:
            # Let other authenticators in the chain try (e.g. SupabaseJWTAuthentication)
            return None

        uid = claims.get("uid") or claims.get("sub") or claims.get("user_id")
        email = (claims.get("email") or "").strip().lower()
        if not uid and not email:
            raise exceptions.AuthenticationFailed("Invalid Firebase ID token payload.")

        # Look up by ID or email
        user = None
        if uid:
            user = User.objects.filter(id=uid).first()
        if user is None and email:
            user = User.objects.filter(email=email).first()

        if user is None:
            first_name = claims.get("name") or claims.get("display_name", "")
            user_kwargs = {
                "email": email or f"{uid}@firebase.user",
                "first_name": first_name[:150],
                "is_active": True,
            }
            if uid:
                try:
                    import uuid
                    uuid.UUID(str(uid))
                    user_kwargs["id"] = uid
                except ValueError:
                    pass
            user = User.objects.create(**user_kwargs)
            user.set_unusable_password()
            user.save(update_fields=["password"])

        user.token_claims = claims
        return (user, claims)
