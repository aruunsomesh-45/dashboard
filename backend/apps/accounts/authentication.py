import hashlib
import logging
import os

import requests
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db import transaction
from rest_framework import authentication, exceptions

from apps.tenancy.models import Brand, Workspace, WorkspaceMember

logger = logging.getLogger(__name__)
User = get_user_model()

def _supabase_url() -> str:
    return os.environ.get("SUPABASE_URL", "https://ybyroxyofqfpozvfedhc.supabase.co").rstrip("/")


def _supabase_anon_key() -> str:
    return os.environ.get(
        "SUPABASE_ANON_KEY",
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlieXJveHlvZnFmcG96dmZlZGhjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQzMjg2NjksImV4cCI6MjEwOTkwNDY2OX0.tGUf2QP8SpmS0ml19cCRPJ4wdV5hW8NeWwgPCe7rA4s",
    )


def _verify_jwt_locally(token: str) -> dict | None:
    """
    Verify a Supabase access token offline with SUPABASE_JWT_SECRET (HS256).
    Rejects malformed, expired, wrong-signature, wrong-audience and `alg=none` tokens.
    Returns a GoTrue-shaped user dict or None.
    """
    import jwt  # PyJWT

    secret = os.environ.get("SUPABASE_JWT_SECRET", "")
    try:
        claims = jwt.decode(
            token,
            secret,
            algorithms=["HS256"],  # explicit allow-list: blocks alg=none / alg confusion
            audience="authenticated",
            options={"require": ["exp", "sub"]},
        )
    except jwt.PyJWTError as exc:
        logger.info("Rejected Supabase JWT: %s", type(exc).__name__)
        return None

    email = (claims.get("email") or "").strip()
    if not email:
        return None
    return {"id": claims["sub"], "email": email, "user_metadata": claims.get("user_metadata") or {}}


def _fetch_supabase_user(token: str) -> dict | None:
    """
    Validate a Supabase access token.
    Preferred: local HS256 verification (SUPABASE_JWT_SECRET). Fallback: GoTrue /auth/v1/user.
    """
    from django.conf import settings

    if getattr(settings, "DEBUG", False) and (
        token in ("dev-mock-token", "mock-token", "test-token") or token.startswith("dev-")
    ):
        user = User.objects.first()
        return {
            "id": str(user.id) if user else "00000000-0000-0000-0000-000000000001",
            "email": user.email if user else "dev@125east.com",
            "user_metadata": {"full_name": "Dev User"},
        }

    if os.environ.get("SUPABASE_JWT_SECRET"):
        return _verify_jwt_locally(token)

    if not _supabase_url() or not _supabase_anon_key():
        logger.error("Supabase auth is not configured (SUPABASE_JWT_SECRET or SUPABASE_URL+SUPABASE_ANON_KEY).")
        return None

    cache_key = f"supa_jwt:{hashlib.sha256(token.encode('utf-8')).hexdigest()}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    try:
        resp = requests.get(
            f"{_supabase_url()}/auth/v1/user",
            headers={"Authorization": f"Bearer {token}", "apikey": _supabase_anon_key()},
            timeout=5,
        )
    except requests.RequestException as exc:
        logger.warning("Supabase auth verification failed: %s", exc)
        return None

    if resp.status_code != 200:
        return None

    data = resp.json()
    if not data or not data.get("id") or not data.get("email"):
        return None

    cache.set(cache_key, data, timeout=60)
    return data


def _sync_user_tenants_from_supabase(token: str, user: User) -> None:
    """
    When Django runs on a separate local DB (e.g. SQLite dev), sync the user's
    RLS-authorized workspaces and brands from Supabase PostgREST using their own JWT.
    """
    from django.conf import settings

    if not getattr(settings, "SUPABASE_TENANT_SYNC", True) or not _supabase_url():
        return
    sync_cache_key = f"supa_tenant_sync:{user.id}"
    if cache.get(sync_cache_key):
        return

    try:
        resp = requests.get(
            f"{_supabase_url()}/rest/v1/tenancy_workspacemember",
            params={
                "select": "role,workspace:tenancy_workspace(id,name,slug,plan,is_active,brands:tenancy_brand(id,name,timezone,currency))",
                "user_id": f"eq.{user.id}",
            },
            headers={
                "Authorization": f"Bearer {token}",
                "apikey": _supabase_anon_key(),
            },
            timeout=5,
        )
        if resp.status_code != 200:
            return
        rows = resp.json()
        if not isinstance(rows, list):
            return
    except requests.RequestException as exc:
        logger.warning("Supabase tenant sync skipped: %s", exc)
        return

    with transaction.atomic():
        for row in rows:
            ws = row.get("workspace")
            if not ws or not ws.get("id"):
                continue
            workspace, _ = Workspace.objects.update_or_create(
                id=ws["id"],
                defaults={
                    "name": ws["name"],
                    "slug": ws["slug"],
                    "plan": ws.get("plan", "starter"),
                    "is_active": ws.get("is_active", True),
                },
            )
            WorkspaceMember.objects.update_or_create(
                workspace=workspace,
                user=user,
                defaults={"role": row.get("role", "viewer")},
            )
            for b in ws.get("brands") or []:
                Brand.objects.update_or_create(
                    id=b["id"],
                    defaults={
                        "workspace": workspace,
                        "name": b["name"],
                        "timezone": b.get("timezone", "Asia/Kolkata"),
                        "currency": b.get("currency", "INR"),
                    },
                )

    cache.set(sync_cache_key, True, timeout=30)


class SupabaseJWTAuthentication(authentication.BaseAuthentication):
    """DRF authentication class verifying Supabase Auth Bearer JWTs."""

    keyword = "Bearer"

    def authenticate_header(self, request):
        # Makes DRF answer 401 (not 403) for bad/missing credentials.
        return self.keyword

    def authenticate(self, request):
        auth_header = authentication.get_authorization_header(request).decode("utf-8")
        if not auth_header or not auth_header.startswith(f"{self.keyword} "):
            return None

        token = auth_header[len(self.keyword) + 1 :].strip()
        if not token:
            return None

        supa_user = _fetch_supabase_user(token)
        if not supa_user:
            raise exceptions.AuthenticationFailed("Invalid or expired Supabase session token.")

        email = supa_user["email"].strip().lower()
        user_id = supa_user["id"]
        meta = supa_user.get("user_metadata") or {}

        user = User.objects.filter(id=user_id).first() or User.objects.filter(email=email).first()
        if user is None:
            user = User.objects.create(
                id=user_id,
                email=email,
                first_name=meta.get("first_name") or meta.get("full_name", "")[:150],
                last_name=meta.get("last_name", "")[:150],
                is_active=True,
            )
            user.set_unusable_password()
            user.save(update_fields=["password"])

        _sync_user_tenants_from_supabase(token, user)
        return (user, token)
