"""
Organisation control: role x endpoint permission matrix, role-change rules, MFA gate for privileged roles,
invites, brand restriction and plan limits.

Every request goes through the real login flow (session cookie; owners/admins complete a TOTP challenge), real
middleware and real permission classes. No live third-party calls: `requests` and `urllib` are blocked, and the
Shopify / Meta / Delhivery calls are mocked.

Contracts these tests assume where the application did not define one yet (change the constants/paths here if the
implementation chooses differently):
  * PATCH  /api/w/{ws}/members/{membership_id}/  {"role": ...}   -> change a member's role  (200)
  * DELETE /api/w/{ws}/members/{membership_id}/                  -> remove a member        (204)
  * "no permission" is 403; touching a resource of another tenant / a brand you are not assigned is 404
  * removing / demoting the last owner is refused with 409 (LAST_OWNER_STATUS)
  * owners/admins without verified MFA get 403 {"code": "mfa_required"} on every /api/w/{ws}/... route;
    a Bearer (Supabase) token counts as verified only when it carries the standard claim aal=aal2
  * invites expire after 7 days; an invite can only be accepted by the logged-in user whose email it was sent to
    (anything else answers 404 so invites are not discoverable); expired invites answer 400
  * starter plan: 1 brand, 3 members (pending invites count), 2 integrations; the 4th member / 2nd brand / 3rd
    integration answer 402. Re-saving credentials of a provider that is already connected is not a new integration.
  * viewers are read-only: acknowledging/resolving alerts needs analyst or higher
"""
import hashlib
import itertools
from datetime import timedelta
from types import SimpleNamespace
from unittest import mock

import pyotp
import pytest
import requests
from apps.alerts.models import Alert
from apps.commerce.models import CanonicalShipmentStatus, Order, PaymentAttempt, Shipment
from apps.integrations.crypto import encrypt_credentials
from apps.integrations.delhivery.client import DelhiveryClient
from apps.integrations.models import Integration
from apps.tenancy.models import Brand, BrandMember, Invite, Workspace, WorkspaceMember
from django.utils import timezone
from freezegun import freeze_time
from rest_framework.test import APIClient

from tests.conftest import DEFAULT_PASSWORD, make_token

pytestmark = pytest.mark.django_db

ROLES = ("viewer", "analyst", "admin", "owner")  # least -> most privileged
MFA_ROLES = {"owner", "admin"}
LAST_OWNER_STATUS = 409
PLAN = Workspace.Plan

LOGIN = "/api/auth/login/"
CHALLENGE = "/api/auth/mfa/challenge/"


# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
def _no_live_calls():
    with (
        mock.patch.object(requests.sessions.Session, "request", side_effect=AssertionError("network call attempted")),
        mock.patch("urllib.request.urlopen", side_effect=AssertionError("network call attempted")),
    ):
        yield


def session_client(user, secret=None):
    """Log in through the real endpoints; completes the TOTP challenge when the user has MFA enrolled."""
    client = APIClient()
    res = client.post(LOGIN, {"email": user.email, "password": DEFAULT_PASSWORD}, format="json")
    assert res.status_code == 200, res.content
    if secret:
        assert res.json()["mfa_required"] is True
        res = client.post(CHALLENGE, {"code": pyotp.TOTP(secret).now()}, format="json")
        assert res.status_code == 200, res.content
    return client


class Org:
    """One workspace with named members; owners/admins have MFA enrolled and verified unless told otherwise."""

    def __init__(self, user_factory, mfa_user_factory, plan, slug="acme"):
        self._user_factory, self._mfa_user_factory = user_factory, mfa_user_factory
        self.workspace = Workspace.objects.create(name=slug.title(), slug=slug, plan=plan)
        self.brand = Brand.objects.create(workspace=self.workspace, name="Brand One")
        self.members, self._clients = {}, {}
        self.ws = f"/api/w/{slug}/"

    def add(self, role, key=None, mfa=None):
        key = key or role
        mfa = role in MFA_ROLES if mfa is None else mfa
        user, secret = self._mfa_user_factory() if mfa else (self._user_factory(), None)
        membership = WorkspaceMember.objects.create(workspace=self.workspace, user=user, role=role)
        self.members[key] = SimpleNamespace(key=key, role=role, user=user, secret=secret, membership=membership)
        return self.members[key]

    def add_roles(self, roles=ROLES):
        for role in roles:
            self.add(role)
        return self

    def add_brand(self, name="Brand Two"):
        return Brand.objects.create(workspace=self.workspace, name=name)

    def restrict(self, key, *brands):
        for brand in brands:
            BrandMember.objects.create(brand=brand, user=self.members[key].user)

    def client(self, key):
        if key not in self._clients:
            m = self.members[key]
            self._clients[key] = session_client(m.user, m.secret)
        return self._clients[key]

    def snapshot(self):
        """Everything a successful forbidden write could have changed."""
        ws = self.workspace
        return (
            Workspace.objects.filter(id=ws.id).exists(),
            sorted((str(m.user_id), m.role) for m in WorkspaceMember.objects.filter(workspace=ws)),
            sorted(str(b.id) for b in Brand.objects.filter(workspace=ws)),
            sorted((i.email, i.role, i.accepted_at is None) for i in Invite.objects.filter(workspace=ws)),
            sorted(
                (i.provider, i.status, bytes(i.encrypted_credentials or b""))
                for i in Integration.objects.filter(workspace=ws)
            ),
            sorted((a.dedupe_key, a.status) for a in Alert.objects.filter(workspace=ws)),
        )

    def roles(self):
        return {m.user_id: m.role for m in WorkspaceMember.objects.filter(workspace=self.workspace)}


@pytest.fixture
def make_org(user_factory, mfa_user_factory):
    counter = itertools.count(1)

    def _make(plan=PLAN.ENTERPRISE, roles=ROLES):
        return Org(user_factory, mfa_user_factory, plan, slug=f"acme{next(counter)}").add_roles(roles)

    return _make


def connect(org, brand, provider, creds=None):
    return Integration.objects.create(
        workspace=org.workspace, brand=brand, provider=provider, status="connected",
        account_identifier=f"{provider}-acct", encrypted_credentials=encrypt_credentials(creds or {"token": "t"}),
    )


def seed_brand_data(org, brand, awb, net_sales, title):
    """Commerce, payments, shipping, integrations and an alert for one brand."""
    now = timezone.now()
    Order.objects.create(
        workspace=org.workspace, brand=brand, provider="shopify", provider_id=f"o-{brand.id}", order_number="1001",
        gross_amount=net_sales, net_sales=net_sales, financial_status="paid", source_created_at=now,
    )
    PaymentAttempt.objects.create(
        workspace=org.workspace, brand=brand, provider="razorpay", provider_id=f"p-{brand.id}",
        amount_minor=net_sales, status="captured", method="upi",
    )
    Shipment.objects.create(
        workspace=org.workspace, brand=brand, provider="delhivery", provider_id=f"s-{brand.id}", awb=awb,
        canonical_status=CanonicalShipmentStatus.NDR, ndr_count=1,
    )
    connect(org, brand, "shopify", {"shop_domain": "x.myshopify.com", "access_token": "t"})
    connect(org, brand, "delhivery", {"api_token": "t"})
    connect(org, brand, "meta_ads", {"access_token": "t", "ad_account_id": "act_1"})
    return Alert.objects.create(
        workspace=org.workspace, brand=brand, title=title, severity="warning", dedupe_key=f"dk-{brand.id}"
    )


SHOPIFY_SYNC = {"records_processed": 0, "records_created": 0, "records_updated": 0}
META_SYNC = {
    "account": {"name": "Acct"}, "campaigns": [], "daily_trends": [],
    "summary_30d": {"spend_minor": 0}, "summary_lifetime": {},
}


@pytest.fixture
def mocked_integrations():
    with (
        mock.patch("apps.integrations.views.sync_shopify_orders", return_value=SHOPIFY_SYNC),
        mock.patch("apps.integrations.views.sync_meta_ads_data", return_value=META_SYNC),
        mock.patch.object(DelhiveryClient, "_post", return_value={"request_id": "r1"}),
    ):
        yield


# ---------------------------------------------------------------------------
# 1. Role x endpoint x method matrix
# ---------------------------------------------------------------------------
# expect = (viewer, analyst, admin, owner). Paths: {ws} {brand} {alert} {target} {victim} {awb}.
Cell = SimpleNamespace
_ALL_200, _ADMIN_UP, _ANALYST_UP = (200,) * 4, (403, 403, 200, 200), (403, 200, 200, 200)
CELLS = [
    Cell(id="GET workspaces", method="get", path="/api/w/", body=None, expect=_ALL_200),
    Cell(id="POST workspaces", method="post", path="/api/w/", body={"name": "Another Co"}, expect=(201,) * 4),
    Cell(id="POST invite accept (unknown token)", method="post", path="/api/w/invites/accept/", body={"token": "nope"}, expect=(404,) * 4),
    Cell(id="GET workspace", method="get", path="{ws}", body=None, expect=_ALL_200),
    Cell(id="DELETE workspace", method="delete", path="{ws}", body=None, expect=(403, 403, 403, 204)),
    Cell(id="GET brands", method="get", path="{ws}brands/", body=None, expect=_ALL_200),
    Cell(id="POST brands", method="post", path="{ws}brands/", body={"name": "Second"}, expect=(403, 403, 201, 201)),
    Cell(id="GET members", method="get", path="{ws}members/", body=None, expect=_ADMIN_UP),
    Cell(id="PATCH member", method="patch", path="{ws}members/{target}/", body={"role": "viewer"}, expect=(403, 403, 200, 200)),
    Cell(id="DELETE member", method="delete", path="{ws}members/{victim}/", body=None, expect=(403, 403, 204, 204)),
    Cell(id="POST invites", method="post", path="{ws}invites/", body={"email": "new@x.test", "role": "viewer"}, expect=(403, 403, 201, 201)),
    Cell(id="GET alerts", method="get", path="{ws}alerts/", body=None, expect=_ALL_200),
    Cell(id="POST alert acknowledge", method="post", path="{ws}alerts/{alert}/acknowledge/", body=None, expect=_ANALYST_UP),
    Cell(id="POST alert resolve", method="post", path="{ws}alerts/{alert}/resolve/", body=None, expect=_ANALYST_UP),
    Cell(id="GET integrations", method="get", path="{ws}b/{brand}/integrations/", body=None, expect=_ALL_200),
    Cell(id="POST integrations", method="post", path="{ws}b/{brand}/integrations/",
         body={"provider": "razorpay", "credentials": {"key_id": "rzp_test_1", "key_secret": "s"}}, expect=(403, 403, 200, 200)),
    Cell(id="DELETE integrations", method="delete", path="{ws}b/{brand}/integrations/?provider=delhivery", body=None, expect=(403, 403, 200, 200)),
    Cell(id="GET shopify stats", method="get", path="{ws}b/{brand}/shopify/stats/", body=None, expect=_ALL_200),
    Cell(id="GET shopify intelligence", method="get", path="{ws}b/{brand}/shopify/intelligence/", body=None, expect=_ALL_200),
    Cell(id="POST shopify sync-now", method="post", path="{ws}b/{brand}/shopify/sync-now/", body=None, expect=_ANALYST_UP),
    Cell(id="GET marketing stats", method="get", path="{ws}b/{brand}/marketing/stats/", body=None, expect=_ALL_200),
    Cell(id="POST marketing sync-now", method="post", path="{ws}b/{brand}/marketing/sync-now/", body=None, expect=_ANALYST_UP),
    Cell(id="GET metrics", method="get", path="{ws}b/{brand}/metrics/", body=None, expect=_ALL_200),
    Cell(id="GET payments stats", method="get", path="{ws}b/{brand}/payments/stats/", body=None, expect=_ALL_200),
    Cell(id="GET payments transactions", method="get", path="{ws}b/{brand}/payments/transactions/", body=None, expect=_ALL_200),
    Cell(id="GET logistics summary", method="get", path="{ws}b/{brand}/logistics/summary/", body=None, expect=_ALL_200),
    Cell(id="GET logistics shipments", method="get", path="{ws}b/{brand}/logistics/shipments/", body=None, expect=_ALL_200),
    Cell(id="GET logistics track", method="get", path="{ws}b/{brand}/logistics/track/{awb}/", body=None, expect=_ALL_200),
    Cell(id="POST logistics ndr action", method="post", path="{ws}b/{brand}/logistics/ndr/{awb}/action/",
         body={"action": "reattempt"}, expect=(403, 403, 200, 200)),
]


@pytest.fixture
def world(make_org):
    """Enterprise workspace (no plan limits in the way) with every kind of object the endpoints touch."""
    org = make_org(PLAN.ENTERPRISE)
    alert = seed_brand_data(org, org.brand, "AWB-MATRIX-1", 100_000, "Matrix alert")
    org.add("analyst", key="target")
    org.add("viewer", key="victim")
    org.ids = {
        "ws": org.ws, "brand": org.brand.id, "alert": alert.id, "awb": "AWB-MATRIX-1",
        "target": org.members["target"].membership.id, "victim": org.members["victim"].membership.id,
    }
    return org


class TestPermissionMatrix:
    @pytest.mark.parametrize("role", ROLES)
    @pytest.mark.parametrize("cell", CELLS, ids=[c.id for c in CELLS])
    def test_exact_status_for_role(self, world, mocked_integrations, cell, role):
        client = world.client(role)
        before = world.snapshot()
        expected = cell.expect[ROLES.index(role)]

        res = getattr(client, cell.method)(cell.path.format(**world.ids), cell.body, format="json")

        assert res.status_code == expected, (
            f"{role} {cell.method.upper()} {cell.path}: expected {expected}, got {res.status_code} {res.content[:200]}"
        )
        if expected == 403:
            assert world.snapshot() == before, f"{role} was refused but {cell.id} still changed data"

    def test_every_routed_endpoint_is_in_the_matrix(self, world):
        """Guard: a new /api/w/{ws}/ route must get a row in CELLS."""
        from apps.tenancy import urls as tenancy_urls
        from django.urls import Resolver404, resolve

        def view_of(pattern):
            return pattern.callback.view_class if hasattr(pattern.callback, "view_class") else pattern.callback.cls

        routed = {
            (method, view_of(p).__name__)
            for p in tenancy_urls.urlpatterns
            for method in ("get", "post", "put", "patch", "delete")
            if hasattr(view_of(p), method)
        }
        covered = set()
        for cell in CELLS:
            path = cell.path.format(**{**world.ids, "target": world.ids["target"], "victim": world.ids["victim"]})
            try:
                covered.add((cell.method, resolve(path.split("?")[0]).func.view_class.__name__))
            except Resolver404:
                continue  # endpoint the app does not route yet; its cells fail on status instead
        # Webhooks/auth are not tenant routes; every route in apps.tenancy.urls must be covered.
        assert routed <= covered, f"tenant endpoints with no matrix row: {sorted(routed - covered)}"


# ---------------------------------------------------------------------------
# 2. Member role changes / removal
# ---------------------------------------------------------------------------
def member_url(org, key):
    return f"{org.ws}members/{org.members[key].membership.id}/"


def role_of(org, key):
    return WorkspaceMember.objects.get(id=org.members[key].membership.id).role


def exists(org, key):
    return WorkspaceMember.objects.filter(id=org.members[key].membership.id).exists()


class TestRoleChanges:
    @pytest.fixture
    def org(self, make_org):
        org = make_org(PLAN.ENTERPRISE)  # owner, admin, analyst, viewer
        org.add("owner", key="owner2")
        return org

    def patch(self, org, actor, target, role):
        return org.client(actor).patch(member_url(org, target), {"role": role}, format="json")

    # -- controls: the endpoints work, so the refusals below are the rules and not a missing route ------------
    def test_owner_can_change_roles_and_remove_members(self, org):
        assert self.patch(org, "owner", "admin", "analyst").status_code == 200
        assert role_of(org, "admin") == "analyst"
        assert self.patch(org, "owner", "viewer", "owner").status_code == 200
        assert role_of(org, "viewer") == "owner"
        assert org.client("owner").delete(member_url(org, "owner2")).status_code == 204
        assert not exists(org, "owner2")

    def test_admin_can_manage_lower_roles(self, org):
        assert self.patch(org, "admin", "viewer", "analyst").status_code == 200
        assert role_of(org, "viewer") == "analyst"
        assert org.client("admin").delete(member_url(org, "analyst")).status_code == 204

    # -- admin limits ------------------------------------------------------------------------------------------
    @pytest.mark.parametrize("target", ["analyst", "viewer", "admin"], ids=["analyst", "viewer", "self"])
    def test_admin_cannot_promote_anyone_to_owner(self, org, target):
        res = self.patch(org, "admin", target, "owner")
        assert res.status_code == 403, res.content
        assert role_of(org, target) != "owner"

    @pytest.mark.parametrize("new_role", ["admin", "analyst", "viewer"])
    def test_admin_cannot_demote_an_owner(self, org, new_role):
        res = self.patch(org, "admin", "owner2", new_role)
        assert res.status_code == 403, res.content
        assert role_of(org, "owner2") == "owner"

    def test_admin_cannot_remove_an_owner(self, org):
        res = org.client("admin").delete(member_url(org, "owner2"))
        assert res.status_code == 403, res.content
        assert exists(org, "owner2")

    # -- nobody changes their own role --------------------------------------------------------------------------
    @pytest.mark.parametrize(
        ("actor", "new_role"),
        [("owner", "admin"), ("admin", "viewer"), ("admin", "owner"), ("analyst", "admin"),
         ("analyst", "viewer"), ("viewer", "analyst"), ("viewer", "owner")],
    )
    def test_nobody_can_change_their_own_role(self, org, actor, new_role):
        before = role_of(org, actor)
        res = self.patch(org, actor, actor, new_role)
        assert res.status_code == 403, f"{actor} changed own role to {new_role}: {res.status_code} {res.content}"
        assert role_of(org, actor) == before

    # -- last owner ---------------------------------------------------------------------------------------------
    def test_last_owner_cannot_be_removed(self, org):
        assert org.client("owner").delete(member_url(org, "owner2")).status_code == 204  # control: not the last one
        res = org.client("owner").delete(member_url(org, "owner"))
        assert res.status_code == LAST_OWNER_STATUS, res.content
        assert exists(org, "owner")
        assert WorkspaceMember.objects.filter(workspace=org.workspace, role="owner").count() == 1

    def test_last_owner_cannot_be_demoted(self, org):
        assert org.client("owner").delete(member_url(org, "owner2")).status_code == 204
        res = self.patch(org, "owner", "owner", "admin")
        # Also blocked by the "nobody changes their own role" rule, so either refusal is acceptable here.
        assert res.status_code in (403, LAST_OWNER_STATUS), res.content
        assert role_of(org, "owner") == "owner"

    def test_workspace_always_keeps_an_owner(self, org):
        """No sequence of member operations may leave the workspace ownerless."""
        assert org.client("owner").delete(member_url(org, "owner2")).status_code == 204  # precondition
        org.client("owner").delete(member_url(org, "owner"))
        self.patch(org, "owner", "owner", "viewer")
        self.patch(org, "admin", "owner", "viewer")
        assert WorkspaceMember.objects.filter(workspace=org.workspace, role="owner").count() == 1

    # -- tenant isolation ---------------------------------------------------------------------------------------
    def test_member_of_another_workspace_cannot_be_touched(self, org, make_org):
        other = make_org(PLAN.ENTERPRISE)
        foreign_member = f"{other.ws}members/{org.members['viewer'].membership.id}/"  # id from `org`, slug of `other`
        res = other.client("owner").patch(foreign_member, {"role": "admin"}, format="json")
        assert res.status_code == 404, res.content
        assert role_of(org, "viewer") == "viewer"

        res = other.client("owner").delete(foreign_member)
        assert res.status_code == 404, res.content
        assert exists(org, "viewer")


# ---------------------------------------------------------------------------
# 3. MFA gate for owner / admin
# ---------------------------------------------------------------------------
GATED_ROUTES = [
    ("get", "{ws}"),
    ("get", "{ws}brands/"),
    ("get", "{ws}members/"),
    ("get", "{ws}alerts/"),
    ("get", "{ws}b/{brand}/metrics/"),
    ("post", "{ws}brands/"),
]


def hit(org, client, method, path):
    body = {"name": "Gated Brand"} if method == "post" else None
    return getattr(client, method)(path.format(ws=org.ws, brand=org.brand.id), body, format="json")


class TestMfaGate:
    @pytest.mark.parametrize(("method", "path"), GATED_ROUTES)
    @pytest.mark.parametrize("role", ["owner", "admin"])
    def test_privileged_role_without_verified_mfa_gets_403_mfa_required(self, make_org, role, method, path):
        org = make_org(PLAN.ENTERPRISE, roles=("owner",))
        member = org.add(role, key="privileged", mfa=False)  # logs in with a password only
        before = org.snapshot()

        res = hit(org, org.client("privileged"), method, path)

        assert res.status_code == 403, res.content
        assert res.json().get("code") == "mfa_required", res.content
        assert org.snapshot() == before
        assert member.secret is None

    @pytest.mark.parametrize(("method", "path"), GATED_ROUTES)
    @pytest.mark.parametrize("role", ["owner", "admin"])
    def test_privileged_role_with_verified_mfa_gets_through(self, make_org, role, method, path):
        org = make_org(PLAN.ENTERPRISE, roles=("owner", "admin"))
        res = hit(org, org.client(role), method, path)
        assert res.status_code in (200, 201), f"control: MFA-verified {role}: {res.status_code} {res.content}"

    @pytest.mark.parametrize(("method", "path"), [r for r in GATED_ROUTES if r[0] == "get" and "members" not in r[1]])
    @pytest.mark.parametrize("role", ["analyst", "viewer"])
    def test_analyst_and_viewer_are_not_gated(self, make_org, role, method, path):
        org = make_org(PLAN.ENTERPRISE, roles=("owner",))
        org.add(role, key="unprivileged", mfa=False)
        res = hit(org, org.client("unprivileged"), method, path)
        assert res.status_code == 200, res.content

    def test_unenrolled_owner_can_still_reach_mfa_setup(self, make_org):
        """The gate must not lock the user out of the only way to satisfy it."""
        org = make_org(PLAN.ENTERPRISE, roles=())
        org.add("owner", mfa=False)
        client = org.client("owner")
        assert client.get("/api/auth/me/").status_code == 200
        assert client.post("/api/auth/mfa/setup/").status_code == 200

    @pytest.mark.parametrize("role", ["owner", "admin"])
    def test_bearer_token_needs_mfa_assurance_for_privileged_roles(self, make_org, client_for, role):
        org = make_org(PLAN.ENTERPRISE, roles=("owner",))
        user = org.add(role, key="privileged", mfa=False).user
        plain = client_for(user)  # Supabase token with no MFA claim
        res = plain.get(org.ws)
        assert res.status_code == 403 and res.json().get("code") == "mfa_required", res.content

        aal2 = APIClient()
        aal2.credentials(HTTP_AUTHORIZATION=f"Bearer {make_token(user, aal='aal2')}")
        assert aal2.get(org.ws).status_code == 200

    def test_bearer_token_for_analyst_is_not_gated(self, make_org, client_for):
        org = make_org(PLAN.ENTERPRISE, roles=("owner", "analyst"))
        assert client_for(org.members["analyst"].user).get(org.ws).status_code == 200


# ---------------------------------------------------------------------------
# 4. Invites
# ---------------------------------------------------------------------------
def send_invite(org, actor, email, role="viewer"):
    return org.client(actor).post(f"{org.ws}invites/", {"email": email, "role": role}, format="json")


def accept(client, token):
    return client.post("/api/w/invites/accept/", {"token": token}, format="json")


class TestInvites:
    @pytest.fixture
    def org(self, make_org):
        return make_org(PLAN.ENTERPRISE)

    def test_token_is_stored_hashed_and_only_returned_once(self, org):
        res = send_invite(org, "owner", "hash@invite.test")
        assert res.status_code == 201, res.content
        raw = res.json()["invite_token"]

        invite = Invite.objects.get(email="hash@invite.test")
        assert invite.token_hash == hashlib.sha256(raw.encode()).hexdigest()
        assert raw not in {str(getattr(invite, f.attname)) for f in Invite._meta.concrete_fields}
        # Listing/serialising an existing invite never reveals the token.
        assert raw not in str(org.client("owner").get(f"{org.ws}members/").content)

    def test_invite_expires_in_seven_days(self, org):
        org.client("owner")  # log in outside the frozen window
        with freeze_time(timezone.now()):
            res = send_invite(org, "owner", "seven@invite.test")
            assert res.status_code == 201, res.content
            invite = Invite.objects.get(email="seven@invite.test")
            assert invite.expires_at - timezone.now() == timedelta(days=7), invite.expires_at - timezone.now()

    def test_invite_can_be_accepted_just_before_expiry(self, org, user_factory):
        invitee = user_factory(email="early@invite.test")
        client = org.client("owner")  # noqa: F841
        with freeze_time(timezone.now()) as clock:
            token = send_invite(org, "owner", invitee.email).json()["invite_token"]
            clock.tick(timedelta(days=6, hours=23))
            res = accept(session_client(invitee), token)
        assert res.status_code == 200, res.content

    def test_expired_invite_is_rejected(self, org, user_factory):
        invitee = user_factory(email="late@invite.test")
        client = org.client("owner")  # noqa: F841
        with freeze_time(timezone.now()) as clock:
            token = send_invite(org, "owner", invitee.email).json()["invite_token"]
            clock.tick(timedelta(days=7, seconds=1))
            res = accept(session_client(invitee), token)
        assert res.status_code == 400, res.content
        assert not WorkspaceMember.objects.filter(workspace=org.workspace, user=invitee).exists()

    def test_invite_is_single_use(self, org, user_factory):
        invitee = user_factory(email="once@invite.test")
        token = send_invite(org, "owner", invitee.email, "analyst").json()["invite_token"]
        client = session_client(invitee)

        assert accept(client, token).status_code == 200
        WorkspaceMember.objects.filter(workspace=org.workspace, user=invitee).delete()  # e.g. removed later

        replay = accept(client, token)
        assert replay.status_code == 404, replay.content
        assert not WorkspaceMember.objects.filter(workspace=org.workspace, user=invitee).exists()

    def test_invite_for_another_email_is_rejected_and_not_consumed(self, org, user_factory):
        invitee = user_factory(email="intended@invite.test")
        stranger = user_factory(email="stranger@invite.test")
        token = send_invite(org, "owner", invitee.email, "admin").json()["invite_token"]

        res = accept(session_client(stranger), token)
        assert res.status_code == 404, f"invite for another email was accepted: {res.status_code} {res.content}"
        assert not WorkspaceMember.objects.filter(workspace=org.workspace, user=stranger).exists()
        assert Invite.objects.get(email=invitee.email).accepted_at is None

        # The rightful recipient can still use it.
        assert accept(session_client(invitee), token).status_code == 200
        assert WorkspaceMember.objects.get(workspace=org.workspace, user=invitee).role == "admin"

    @pytest.mark.parametrize(
        ("inviter", "role", "expected"),
        [("admin", "owner", 403), ("admin", "admin", 201), ("admin", "analyst", 201), ("admin", "viewer", 201),
         ("owner", "owner", 201), ("owner", "admin", 201)],
    )
    def test_cannot_invite_above_own_role(self, org, inviter, role, expected):
        email = f"{inviter}-{role}@invite.test"
        res = send_invite(org, inviter, email, role)
        assert res.status_code == expected, res.content
        assert Invite.objects.filter(email=email).exists() is (expected == 201)

    def test_admin_cannot_obtain_owner_by_accepting_their_own_invite(self, org):
        """Escalation via invite: admin invites an email they control with role=owner."""
        res = send_invite(org, "admin", "sock@invite.test", "owner")
        assert res.status_code == 403
        assert "invite_token" not in res.json()


# ---------------------------------------------------------------------------
# 5. Brand restriction
# ---------------------------------------------------------------------------
BRAND_ENDPOINTS = [
    # (id, method, path under {ws}, body, status when allowed)
    ("integrations GET", "get", "b/{brand}/integrations/", None, 200),
    ("integrations POST", "post", "b/{brand}/integrations/", {"provider": "razorpay", "credentials": {"k": "v"}}, 200),
    ("integrations DELETE", "delete", "b/{brand}/integrations/?provider=delhivery", None, 200),
    ("shopify stats", "get", "b/{brand}/shopify/stats/", None, 200),
    ("shopify intelligence", "get", "b/{brand}/shopify/intelligence/", None, 200),
    ("shopify sync-now", "post", "b/{brand}/shopify/sync-now/", None, 200),
    ("marketing stats", "get", "b/{brand}/marketing/stats/", None, 200),
    ("marketing sync-now", "post", "b/{brand}/marketing/sync-now/", None, 200),
    ("metrics", "get", "b/{brand}/metrics/", None, 200),
    ("payments stats", "get", "b/{brand}/payments/stats/", None, 200),
    ("payments transactions", "get", "b/{brand}/payments/transactions/", None, 200),
    ("logistics summary", "get", "b/{brand}/logistics/summary/", None, 200),
    ("logistics shipments", "get", "b/{brand}/logistics/shipments/", None, 200),
    ("logistics track", "get", "b/{brand}/logistics/track/{awb}/", None, 200),
    ("logistics ndr action", "post", "b/{brand}/logistics/ndr/{awb}/action/", {"action": "reattempt"}, 200),
]
B1_SALES, B2_SALES = 123_400, 987_654_321


@pytest.fixture
def two_brands(make_org):
    org = make_org(PLAN.ENTERPRISE)
    org.brand1, org.brand2 = org.brand, org.add_brand("Brand Two")
    org.awb = {org.brand1.id: "AWB-ONE", org.brand2.id: "AWB-TWO"}
    org.alert1 = seed_brand_data(org, org.brand1, "AWB-ONE", B1_SALES, "Alert for brand one")
    org.alert2 = seed_brand_data(org, org.brand2, "AWB-TWO", B2_SALES, "Alert for brand two")
    org.add("admin", key="restricted_admin")
    org.add("viewer", key="restricted_viewer")
    org.restrict("restricted_admin", org.brand1)
    org.restrict("restricted_viewer", org.brand1)
    return org


def brand_url(org, brand, path):
    return org.ws + path.format(brand=brand.id, awb=org.awb[brand.id])


def brand_ids(rows):
    return {str(row["id"]) for row in rows}


class TestBrandRestriction:
    @pytest.mark.parametrize(("name", "method", "path", "body", "ok"), BRAND_ENDPOINTS, ids=[e[0] for e in BRAND_ENDPOINTS])
    def test_restricted_user_gets_404_on_other_brand_but_not_own(self, two_brands, mocked_integrations, name, method, path, body, ok):
        org = two_brands
        client = org.client("restricted_admin")
        before = org.snapshot()

        other = getattr(client, method)(brand_url(org, org.brand2, path), body, format="json")
        assert other.status_code == 404, f"{name} on the other brand: {other.status_code} {other.content[:200]}"
        assert org.snapshot() == before

        own = getattr(client, method)(brand_url(org, org.brand1, path), body, format="json")
        assert own.status_code == ok, f"control: {name} on the assigned brand: {own.status_code} {own.content[:200]}"

    @pytest.mark.parametrize(("name", "method", "path", "body", "ok"), [e for e in BRAND_ENDPOINTS if e[1] == "get"],
                             ids=[e[0] for e in BRAND_ENDPOINTS if e[1] == "get"])
    def test_restricted_viewer_cannot_read_other_brand(self, two_brands, name, method, path, body, ok):
        res = two_brands.client("restricted_viewer").get(brand_url(two_brands, two_brands.brand2, path))
        assert res.status_code == 404, res.content[:200]

    @pytest.mark.parametrize("path", ["b/{brand}/metrics/", "b/{brand}/shopify/stats/"])
    def test_unrestricted_owner_reaches_both_brands(self, two_brands, path):
        """Control: brand 2 exists and its endpoints work, so the 404s above come from the restriction."""
        for brand in (two_brands.brand1, two_brands.brand2):
            assert two_brands.client("owner").get(brand_url(two_brands, brand, path)).status_code == 200

    @pytest.mark.parametrize("who", ["restricted_viewer", "restricted_admin"])
    @pytest.mark.parametrize("endpoint", ["{ws}brands/", "{ws}", "/api/w/", "/api/auth/me/"],
                             ids=["brand list", "workspace detail", "workspace list", "auth me"])
    def test_brand_two_never_appears_in_lists(self, two_brands, who, endpoint):
        org = two_brands
        res = org.client(who).get(endpoint.format(ws=org.ws))
        assert res.status_code == 200, res.content
        assert str(org.brand1.id) in res.content.decode(), "control: the assigned brand is listed"
        assert str(org.brand2.id) not in res.content.decode(), f"{endpoint} lists a brand the user is not assigned to"
        assert "Brand Two" not in res.content.decode()

    def test_brand_lists_for_unrestricted_member_show_both(self, two_brands):
        """Control for the list tests."""
        assert brand_ids(two_brands.client("owner").get(f"{two_brands.ws}brands/").json()) == {
            str(two_brands.brand1.id), str(two_brands.brand2.id)}

    def test_brand_two_alerts_never_appear_in_alert_list(self, two_brands):
        rows = two_brands.client("restricted_viewer").get(f"{two_brands.ws}alerts/").json()
        assert {r["title"] for r in rows} == {"Alert for brand one"}

    @pytest.mark.parametrize("action", ["acknowledge", "resolve"])
    def test_restricted_analyst_cannot_act_on_other_brands_alert(self, two_brands, action):
        org = two_brands
        org.add("analyst", key="restricted_analyst")
        org.restrict("restricted_analyst", org.brand1)
        client = org.client("restricted_analyst")

        res = client.post(f"{org.ws}alerts/{org.alert2.id}/{action}/")
        assert res.status_code == 404, f"{res.status_code} {res.content[:200]}"
        org.alert2.refresh_from_db()
        assert org.alert2.status == Alert.Status.OPEN

        assert client.post(f"{org.ws}alerts/{org.alert1.id}/{action}/").status_code == 200  # control

    def test_metrics_for_assigned_brand_contain_only_its_own_data(self, two_brands):
        org = two_brands
        res = org.client("restricted_viewer").get(brand_url(org, org.brand1, "b/{brand}/metrics/"))
        assert res.status_code == 200
        text = res.content.decode()
        assert str(B1_SALES) in text, "control: brand one's own sales are reported"
        assert str(B2_SALES) not in text, "brand two's sales leaked into brand one's metrics"
        assert (
            res.json() == org.client("owner").get(brand_url(org, org.brand1, "b/{brand}/metrics/")).json()
        ), "a restricted user sees different numbers for their own brand than an unrestricted one"

    def test_assignment_to_another_workspaces_brand_gives_no_access(self, make_org, two_brands):
        """BrandMember rows on foreign brands must not widen access: still 404, never 403."""
        other = make_org(PLAN.ENTERPRISE)
        other.add("viewer", key="drifter")
        BrandMember.objects.create(brand=two_brands.brand2, user=other.members["drifter"].user)
        res = other.client("drifter").get(brand_url(two_brands, two_brands.brand2, "b/{brand}/metrics/"))
        assert res.status_code == 404


# ---------------------------------------------------------------------------
# 6. Plan limits (enforced by the API, not by hiding buttons)
# ---------------------------------------------------------------------------
RAZORPAY = {"provider": "razorpay", "credentials": {"key_id": "k", "key_secret": "s"}}
META = {"provider": "meta_ads", "credentials": {"access_token": "t", "ad_account_id": "act_1"}}


class TestPlanLimits:
    @pytest.fixture(params=["owner", "admin"])
    def actor(self, request):
        return request.param

    @pytest.fixture
    def starter(self, make_org):
        return make_org(PLAN.STARTER, roles=("owner", "admin"))

    def post_brand(self, org, actor):
        return org.client(actor).post(f"{org.ws}brands/", {"name": "Second Brand"}, format="json")

    # -- brands: 1 ---------------------------------------------------------------------------------------------
    def test_second_brand_is_402_on_starter(self, starter, actor):
        before = Brand.objects.filter(workspace=starter.workspace).count()
        assert before == 1
        res = self.post_brand(starter, actor)
        assert res.status_code == 402, res.content
        assert Brand.objects.filter(workspace=starter.workspace).count() == before

    def test_second_brand_is_allowed_on_a_higher_plan(self, make_org, actor):
        """Control: same request, enterprise plan."""
        org = make_org(PLAN.ENTERPRISE, roles=("owner", "admin"))
        assert self.post_brand(org, actor).status_code == 201

    def test_workspace_created_through_the_api_gets_the_starter_limits(self, user_factory, mfa_user_factory):
        user, secret = mfa_user_factory()
        client = session_client(user, secret)
        created = client.post("/api/w/", {"name": "Fresh Co"}, format="json")
        assert created.status_code == 201, created.content
        slug = created.json()["slug"]
        assert created.json()["plan"] == "starter"

        res = client.post(f"/api/w/{slug}/brands/", {"name": "Second"}, format="json")
        assert res.status_code == 402, res.content

    # -- members: 3 (pending invites count) -------------------------------------------------------------------
    def test_fourth_member_is_402(self, starter, actor):
        starter.add("viewer")  # owner + admin + viewer = 3 members
        res = send_invite(starter, actor, "fourth@plan.test")
        assert res.status_code == 402, res.content
        assert not Invite.objects.filter(email="fourth@plan.test").exists()

    def test_third_member_is_allowed(self, starter, actor):
        """Control: two members, one more fits."""
        res = send_invite(starter, actor, "third@plan.test")
        assert res.status_code == 201, res.content

    def test_pending_invites_count_towards_the_member_limit(self, starter, actor):
        assert send_invite(starter, actor, "pending1@plan.test").status_code == 201  # owner+admin+1 pending = 3
        res = send_invite(starter, actor, "pending2@plan.test")
        assert res.status_code == 402, f"pending invite was not counted: {res.status_code} {res.content}"
        assert not Invite.objects.filter(email="pending2@plan.test").exists()

    def test_member_plus_pending_invite_fills_the_workspace(self, make_org):
        org = make_org(PLAN.STARTER, roles=("owner",))
        org.add("viewer")
        assert send_invite(org, "owner", "pending@plan.test").status_code == 201  # owner+viewer+pending = 3
        assert send_invite(org, "owner", "over@plan.test").status_code == 402

    def test_accepted_invites_are_not_counted_twice(self, make_org):
        org = make_org(PLAN.STARTER, roles=("owner",))
        joined = org.add("viewer")
        Invite.objects.create(
            workspace=org.workspace, email=joined.user.email, role="viewer", token_hash="x" * 64,
            expires_at=timezone.now() + timedelta(days=7), accepted_at=timezone.now(),
        )
        res = send_invite(org, "owner", "room@plan.test")  # 2 real members: there is room for a third
        assert res.status_code == 201, f"accepted invite was double counted: {res.status_code} {res.content}"

    # -- integrations: 2 ---------------------------------------------------------------------------------------
    def post_integration(self, org, actor, body):
        return org.client(actor).post(f"{org.ws}b/{org.brand.id}/integrations/", body, format="json")

    def test_third_integration_is_402(self, starter, actor):
        connect(starter, starter.brand, "razorpay")
        connect(starter, starter.brand, "delhivery", {"api_token": "t"})
        before = starter.snapshot()

        res = self.post_integration(starter, actor, META)
        assert res.status_code == 402, res.content
        assert starter.snapshot() == before
        assert not Integration.objects.filter(workspace=starter.workspace, provider="meta_ads").exists()

    def test_second_integration_is_allowed(self, starter, actor):
        """Control: one connected, a second fits."""
        connect(starter, starter.brand, "razorpay")
        assert self.post_integration(starter, actor, META).status_code == 200

    def test_updating_credentials_of_a_connected_provider_at_the_limit_is_not_a_new_integration(self, starter, actor):
        connect(starter, starter.brand, "razorpay")
        connect(starter, starter.brand, "delhivery", {"api_token": "t"})
        assert self.post_integration(starter, actor, RAZORPAY).status_code == 200

    def test_third_integration_is_allowed_on_a_higher_plan(self, make_org, actor):
        """Control: same request, enterprise plan."""
        org = make_org(PLAN.ENTERPRISE, roles=("owner", "admin"))
        connect(org, org.brand, "razorpay")
        connect(org, org.brand, "delhivery", {"api_token": "t"})
        assert self.post_integration(org, actor, META).status_code == 200
