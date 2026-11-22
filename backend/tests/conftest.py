import pytest
# Import before any test freezes the clock: DRF binds SimpleRateThrottle.timer = time.time at import time, and if
# that first import happens inside freezegun.freeze_time the throttle keeps freezegun's fake function forever
# (TypeError in every later throttled request). Test-harness issue only. QA 2026-11-21.
import rest_framework.throttling  # noqa: F401,E402
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
# Session auth helper (the API's only authentication method: an HTTP-only session cookie)
# ---------------------------------------------------------------------------
def session_client_for(user, mfa_verified=True):
    """APIClient carrying a real server-side Django session for `user` (sessionid cookie).

    mfa_verified=True mirrors a session that completed the TOTP challenge, which owners/admins with MFA
    enrolled need for workspace routes. Pass False to model a session that never passed it.
    """
    c = APIClient()
    c.force_login(user)
    session = c.session
    session["mfa_verified"] = mfa_verified
    session.save()
    return c


@pytest.fixture
def client_for():
    """client_for(user) -> APIClient authenticated with a real session cookie for that user."""
    return session_client_for


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
