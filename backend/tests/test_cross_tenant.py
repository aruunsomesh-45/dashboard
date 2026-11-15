"""
Cross-tenant isolation. User A (owner of workspace A) holds a VALID token and attacks workspace B
through every /api/w/{slug}/... route (GET, POST, DELETE), plus B's brand_id under A's slug.

Every attack must be 403/404, must not leak B's data, and must not mutate B's data.
A positive control proves each URL is real (B's own owner is NOT answered with 404).
"""
import uuid
from unittest import mock

import pytest
from django.urls import get_resolver
from django.utils import timezone

from apps.alerts.models import Alert
from apps.commerce.models import CanonicalShipmentStatus, Order, PaymentAttempt, Shipment
from apps.integrations.crypto import encrypt_credentials
from apps.integrations.models import Integration
from apps.tenancy.models import Brand, Workspace, WorkspaceMember
from tests.conftest import User, make_token

SECRET_MARKERS = ["B-SECRET-ORDER-777", "B-SECRET-AWB-999", "pay_B_SECRET_1", "B Secret Brand", "b-secret-shop"]


@pytest.fixture
def world(db):
    """Workspace A (user_a owner, brand_a) and workspace B (user_b owner, brand_b) with distinctive data in B."""
    ua = User.objects.create_user(email="a-owner@a.test", password="x-Secure-Pass-1")
    ub = User.objects.create_user(email="b-owner@b.test", password="x-Secure-Pass-2")
    wa = Workspace.objects.create(name="WS A", slug="ws-a")
    wb = Workspace.objects.create(name="WS B", slug="ws-b")
    WorkspaceMember.objects.create(workspace=wa, user=ua, role="owner")
    WorkspaceMember.objects.create(workspace=wb, user=ub, role="owner")
    ba = Brand.objects.create(workspace=wa, name="A Brand")
    bb = Brand.objects.create(workspace=wb, name="B Secret Brand")

    Order.objects.create(workspace=wb, brand=bb, provider="shopify", provider_id="b1",
                         order_number="B-SECRET-ORDER-777", gross_amount=999999, net_sales=999999,
                         financial_status="paid", source_created_at=timezone.now())
    ship = Shipment.objects.create(workspace=wb, brand=bb, provider="delhivery", provider_id="bs1",
                                   awb="B-SECRET-AWB-999", canonical_status=CanonicalShipmentStatus.NDR)
    PaymentAttempt.objects.create(workspace=wb, brand=bb, provider="razorpay", provider_id="pay_B_SECRET_1",
                                  amount_minor=555500, status="captured", method="upi")
    for prov, ident in (("shopify", "b-secret-shop.myshopify.com"), ("meta_ads", "act_B"), ("delhivery", "b-delhivery")):
        Integration.objects.create(workspace=wb, brand=bb, provider=prov, status="connected",
                                   account_identifier=ident,
                                   encrypted_credentials=encrypt_credentials({"api_token": "tok", "access_token": "tok",
                                                                              "shop_domain": ident}))
    alert = Alert.objects.create(workspace=wb, brand=bb, title="B-SECRET-ALERT", dedupe_key="b1")
    return dict(ua=ua, ub=ub, wa=wa, wb=wb, ba=ba, bb=bb, ship=ship, alert=alert)


def routes(ws, brand, awb, alert):
    """(name, method, path, body). One entry per tenant route; completeness is asserted below."""
    b = f"/api/w/{ws}/b/{brand}"
    return [
        ("workspace-detail", "GET", f"/api/w/{ws}/", None),
        ("workspace-detail", "DELETE", f"/api/w/{ws}/", None),
        ("brand-list-create", "GET", f"/api/w/{ws}/brands/", None),
        ("brand-list-create", "POST", f"/api/w/{ws}/brands/", {"name": "Injected"}),
        ("workspace-members", "GET", f"/api/w/{ws}/members/", None),
        ("workspace-member-detail", "PATCH", f"/api/w/{ws}/members/{uuid.uuid4()}/", {"role": "viewer"}),
        ("workspace-member-detail", "DELETE", f"/api/w/{ws}/members/{uuid.uuid4()}/", None),
        ("workspace-invites", "POST", f"/api/w/{ws}/invites/", {"email": "evil@x.test", "role": "owner"}),
        ("workspace-alerts-list", "GET", f"/api/w/{ws}/alerts/", None),
        ("alert-acknowledge", "POST", f"/api/w/{ws}/alerts/{alert}/acknowledge/", None),
        ("alert-resolve", "POST", f"/api/w/{ws}/alerts/{alert}/resolve/", None),
        ("brand-integrations", "GET", f"{b}/integrations/", None),
        ("brand-integrations", "POST", f"{b}/integrations/",
         {"provider": "razorpay", "credentials": {"webhook_secret": "attacker"}}),
        ("brand-integrations", "DELETE", f"{b}/integrations/?provider=shopify", None),
        ("shopify-dashboard-stats", "GET", f"{b}/shopify/stats/", None),
        ("shopify-dashboard-intelligence", "GET", f"{b}/shopify/intelligence/", None),
        ("shopify-sync-trigger", "POST", f"{b}/shopify/sync-now/", None),
        ("meta-dashboard-stats", "GET", f"{b}/marketing/stats/", None),
        ("meta-sync-trigger", "POST", f"{b}/marketing/sync-now/", None),
        ("brand-metrics-query", "GET", f"{b}/metrics/", None),
        ("razorpay-payment-stats", "GET", f"{b}/payments/stats/", None),
        ("razorpay-transactions", "GET", f"{b}/payments/transactions/", None),
        ("logistics-summary", "GET", f"{b}/logistics/summary/", None),
        ("logistics-shipments", "GET", f"{b}/logistics/shipments/", None),
        ("logistics-track", "GET", f"{b}/logistics/track/{awb}/", None),
        ("logistics-ndr-action", "POST", f"{b}/logistics/ndr/{awb}/action/", {"action": "reattempt"}),
    ]


def _send(client, method, path, body):
    kw = {"format": "json"} if body is not None else {}
    return getattr(client, method.lower())(path, body, **kw) if body is not None else getattr(client, method.lower())(path)


def _tenant_route_names():
    names = set()

    def walk(patterns):
        for p in patterns:
            if hasattr(p, "url_patterns"):
                walk(p.url_patterns)
            elif p.name and "workspace_slug" in p.pattern.regex.groupindex:
                names.add(p.name)

    walk(get_resolver().url_patterns)
    return names


def test_route_table_is_fully_covered(world):
    """New tenant routes must be added to this suite, or this test fails."""
    covered = {r[0] for r in routes("x", uuid.uuid4(), "x", uuid.uuid4())}
    assert _tenant_route_names() - {"invite-accept"} <= covered, _tenant_route_names() - covered


@pytest.fixture
def spies():
    with mock.patch("apps.integrations.views.sync_shopify_orders") as shop, \
         mock.patch("apps.integrations.views.sync_meta_ads_data") as meta, \
         mock.patch("apps.integrations.delhivery.client.DelhiveryClient._post") as dlv:
        yield shop, meta, dlv


@pytest.mark.django_db
class TestCrossTenant:
    def test_a_attacks_workspace_b(self, world, client_for, spies):
        client = client_for(world["ua"])
        for name, method, path, body in routes(world["wb"].slug, world["bb"].id, world["ship"].awb, world["alert"].id):
            res = _send(client, method, path, body)
            text = res.content.decode()
            assert res.status_code in (403, 404), f"{method} {path} -> {res.status_code}: {text[:200]}"
            for marker in SECRET_MARKERS:
                assert marker not in text, f"{method} {path} leaked {marker}"
        shop, meta, dlv = spies
        assert not shop.called and not meta.called and not dlv.called, "an upstream call was made for a foreign tenant"
        self._assert_b_untouched(world)

    def test_b_brand_id_under_a_slug(self, world, client_for, spies):
        client = client_for(world["ua"])
        for name, method, path, body in routes(world["wa"].slug, world["bb"].id, world["ship"].awb, world["alert"].id):
            # Only routes that take a foreign object id: brand-scoped routes + alert ack/resolve.
            # (GET /alerts/ takes no foreign id and correctly returns A's own, empty, list.)
            if "/b/" not in path and name not in ("alert-acknowledge", "alert-resolve"):
                continue
            res = _send(client, method, path, body)
            text = res.content.decode()
            assert res.status_code in (403, 404), f"{method} {path} -> {res.status_code}: {text[:200]}"
            for marker in SECRET_MARKERS:
                assert marker not in text
        self._assert_b_untouched(world)

    def test_unauthenticated_gets_nothing(self, world, spies):
        from rest_framework.test import APIClient

        client = APIClient()
        for name, method, path, body in routes(world["wb"].slug, world["bb"].id, world["ship"].awb, world["alert"].id):
            res = _send(client, method, path, body)
            assert res.status_code in (401, 403, 404), f"{method} {path} -> {res.status_code}"
            for marker in SECRET_MARKERS:
                assert marker not in res.content.decode()
        self._assert_b_untouched(world)

    def test_positive_control_b_owner_reaches_own_routes(self, world, client_for, spies):
        """Proves the attack URLs are real: the rightful owner is not answered with 404."""
        shop, meta, dlv = spies
        shop.return_value = {"records_processed": 0, "records_created": 0, "records_updated": 0}
        meta.return_value = {"account": {"name": "x"}, "campaigns": [], "summary_30d": {"spend_minor": 0},
                             "summary_lifetime": {}, "daily_trends": []}
        client = client_for(world["ub"])
        skip_destructive = {("workspace-detail", "DELETE"), ("brand-integrations", "DELETE"),
                            ("brand-integrations", "POST"), ("workspace-invites", "POST"),
                            ("brand-list-create", "POST")}
        for name, method, path, body in routes(world["wb"].slug, world["bb"].id, world["ship"].awb, world["alert"].id):
            if (name, method) in skip_destructive:
                continue
            res = _send(client, method, path, body)
            assert res.status_code != 404, f"control {method} {path} unexpectedly 404"
            assert res.status_code < 500, f"control {method} {path} -> {res.status_code}"

    @staticmethod
    def _assert_b_untouched(world):
        wb, bb = world["wb"], world["bb"]
        assert Workspace.objects.filter(id=wb.id, is_active=True).exists(), "workspace B was deleted"
        assert Brand.objects.filter(workspace=wb).count() == 1, "brand injected into B"
        assert Integration.objects.filter(brand=bb, status="connected").count() == 3, "B integration mutated"
        assert not Integration.objects.filter(brand=bb, provider="razorpay").exists()
        assert Shipment.objects.get(id=world["ship"].id).canonical_status == "ndr", "B shipment mutated"
        assert Alert.objects.get(id=world["alert"].id).status == "open", "B alert mutated"
        assert WorkspaceMember.objects.filter(workspace=wb).count() == 1
        from apps.tenancy.models import Invite

        assert not Invite.objects.filter(workspace=wb).exists()


@pytest.mark.django_db
class TestNdrCrossBrandAwbCollision:
    def test_same_awb_in_two_workspaces_only_touches_own(self, world, client_for):
        """Old code updated Shipment by AWB alone; an AWB shared across tenants must not be cross-modified."""
        wa, ba = world["wa"], world["ba"]
        mine = Shipment.objects.create(workspace=wa, brand=ba, provider="delhivery", provider_id="a1",
                                       awb=world["ship"].awb, canonical_status=CanonicalShipmentStatus.NDR)
        Integration.objects.create(workspace=wa, brand=ba, provider="delhivery", status="connected",
                                   encrypted_credentials=encrypt_credentials({"api_token": "tok"}))
        with mock.patch("apps.integrations.delhivery.client.DelhiveryClient._post", return_value={"ok": 1}):
            c = client_for(world["ua"])
            c.credentials(HTTP_AUTHORIZATION=f"Bearer {make_token(world['ua'], aal='aal2')}")
            res = c.post(
                f"/api/w/{wa.slug}/b/{ba.id}/logistics/ndr/{mine.awb}/action/", {"action": "reattempt"}, format="json")
        assert res.status_code == 200
        assert Shipment.objects.get(id=mine.id).canonical_status == "in_transit"
        assert Shipment.objects.get(id=world["ship"].id).canonical_status == "ndr", "foreign shipment modified"

