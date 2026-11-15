import pytest
from apps.accounts.models import User
from apps.tenancy.models import Brand, Workspace, WorkspaceMember
from rest_framework.test import APIClient


@pytest.fixture
def api_client():
    return APIClient()


@pytest.fixture
def workspace_a(db):
    return Workspace.objects.create(name="125 East Apparel", slug="125-east")


@pytest.fixture
def workspace_b(db):
    return Workspace.objects.create(name="Competitor Retail", slug="competitor")


@pytest.fixture
def user_a(db, workspace_a):
    user = User.objects.create_user(email="owner@125east.com", password="SecurePassword123!")
    WorkspaceMember.objects.create(
        user=user,
        workspace=workspace_a,
        role=WorkspaceMember.Role.OWNER,
    )
    return user


@pytest.fixture
def user_b(db, workspace_b):
    user = User.objects.create_user(email="admin@competitor.com", password="SecurePassword456!")
    WorkspaceMember.objects.create(
        user=user,
        workspace=workspace_b,
        role=WorkspaceMember.Role.ADMIN,
    )
    return user


@pytest.fixture
def brand_a(db, workspace_a):
    return Brand.objects.create(workspace=workspace_a, name="Apparel", currency="INR")


@pytest.fixture
def brand_b(db, workspace_b):
    return Brand.objects.create(workspace=workspace_b, name="Footwear", currency="INR")


# ---------------------------------------------------------------------------
# Real-JWT auth helpers (exercise SupabaseJWTAuthentication, not force_authenticate)
# ---------------------------------------------------------------------------
import time  # noqa: E402

import jwt  # noqa: E402

TEST_JWT_SECRET = "unit-test-supabase-jwt-secret-0123456789-abcdefghij"


@pytest.fixture(autouse=True)
def _supabase_env(monkeypatch):
    monkeypatch.setenv("SUPABASE_JWT_SECRET", TEST_JWT_SECRET)


def make_token(user, secret=TEST_JWT_SECRET, exp_delta=3600, aud="authenticated", **extra):
    now = int(time.time())
    claims = {
        "sub": str(user.id),
        "email": user.email,
        "aud": aud,
        "role": "authenticated",
        "iat": now,
        "exp": now + exp_delta,
        **extra,
    }
    return jwt.encode(claims, secret, algorithm="HS256")


@pytest.fixture
def client_for():
    """client_for(user) -> APIClient that sends a valid Bearer JWT for that user."""

    def _make(user):
        c = APIClient()
        c.credentials(HTTP_AUTHORIZATION=f"Bearer {make_token(user)}")
        return c

    return _make


# ---------------------------------------------------------------------------
# Factories
# ---------------------------------------------------------------------------
import itertools  # noqa: E402

import pyotp  # noqa: E402

DEFAULT_PASSWORD = "SecurePassword123!"
_user_seq = itertools.count(1)


@pytest.fixture
def user_factory(db):
    """user_factory(email=None, password=DEFAULT_PASSWORD, **fields) -> User (active unless is_active=False)."""

    def _make(email=None, password=DEFAULT_PASSWORD, **fields):
        return User.objects.create_user(email=email or f"user{next(_user_seq)}@factory.test", password=password, **fields)

    return _make


@pytest.fixture
def mfa_user_factory(user_factory):
    """mfa_user_factory(**fields) -> (User with TOTP MFA enabled, base32 secret)."""

    def _make(**fields):
        secret = pyotp.random_base32()
        user = user_factory(mfa_enabled=True, mfa_secret=secret, **fields)
        return user, secret

    return _make
