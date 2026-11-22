"""Rate limiting (auth, sync-now, NDR) and N+1 evidence (query counts must not grow with row count)."""
from datetime import timedelta
from unittest import mock

import pytest
from django.core.cache import cache
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient
from rest_framework.throttling import ScopedRateThrottle

from apps.commerce.models import Customer, Order, OrderLine, PaymentAttempt, Shipment
from apps.integrations.crypto import encrypt_credentials
from apps.integrations.models import Integration


@pytest.fixture
def tight_limits():
    cache.clear()
    with mock.patch.object(ScopedRateThrottle, "THROTTLE_RATES", {"auth": "3/min", "sync": "2/min", "ndr": "2/min"}):
        yield
    cache.clear()


@pytest.mark.django_db
class TestRateLimits:
    def test_login_is_throttled(self, tight_limits, user_a):
        c = APIClient()
        codes = [c.post("/api/auth/login", {"email": user_a.email, "password": "wrong-password"}, format="json").status_code
                 for _ in range(5)]
        assert codes[:3] == [400, 400, 400] and codes[3:] == [429, 429], codes

    def test_register_is_throttled(self, tight_limits):
        c = APIClient()
        codes = [c.post("/api/auth/register", {}, format="json").status_code for _ in range(4)]
        assert codes[-1] == 429, codes

    def test_sync_now_is_throttled(self, tight_limits, client_for, user_a, workspace_a, brand_a):
        Integration.objects.create(workspace=workspace_a, brand=brand_a, provider="shopify", status="connected",
                                   encrypted_credentials=encrypt_credentials({"shop_domain": "x.myshopify.com", "access_token": "t"}))
        ok = {"records_processed": 0, "records_created": 0, "records_updated": 0}
        with mock.patch("apps.integrations.views.sync_shopify_orders", return_value=ok):
            c = client_for(user_a)
            codes = [c.post(f"/api/w/{workspace_a.slug}/b/{brand_a.id}/shopify/sync-now/").status_code for _ in range(4)]
        assert codes == [200, 200, 429, 429], codes

    def test_ndr_action_is_throttled(self, tight_limits, client_for, user_a, workspace_a, brand_a):
        c = client_for(user_a)
        codes = [c.post(f"/api/w/{workspace_a.slug}/b/{brand_a.id}/logistics/ndr/NOPE/action/", {"action": "reattempt"},
                        format="json").status_code for _ in range(4)]
        assert codes == [404, 404, 429, 429], codes


def count_queries(client, url):
    cache.clear()
    with CaptureQueriesContext(connection) as ctx:
        res = client.get(url)
    assert res.status_code == 200, res.content[:200]
    return len(ctx)


def seed(workspace, brand, n):
    now = timezone.now()
    cust = Customer.objects.create(workspace=workspace, brand=brand, provider="shopify", provider_id=f"c{n}-{brand.id}",
                                   email=f"c{n}@t.test")
    orders = Order.objects.bulk_create([
        Order(workspace=workspace, brand=brand, provider="shopify", provider_id=f"o{i}-{brand.id}-{n}", order_number=str(i),
              customer=cust, gross_amount=100000, net_sales=90000, financial_status="paid",
              source_created_at=now - timedelta(minutes=i))
        for i in range(n)
    ])
    OrderLine.objects.bulk_create([OrderLine(order=o, title="x", quantity=1, price_minor=1) for o in orders])
    PaymentAttempt.objects.bulk_create([
        PaymentAttempt(workspace=workspace, brand=brand, provider="razorpay", provider_id=f"p{i}-{brand.id}-{n}",
                       amount_minor=100000, status="captured", method="upi") for i in range(n)])
    Shipment.objects.bulk_create([
        Shipment(workspace=workspace, brand=brand, provider="delhivery", provider_id=f"s{i}-{brand.id}-{n}",
                 awb=f"AWB{i}-{n}", canonical_status="delivered", shipped_at=now - timedelta(days=3), delivered_at=now)
        for i in range(n)])


@pytest.mark.django_db
class TestNoNPlusOne:
    ENDPOINTS = ["shopify/stats/?limit=100", "shopify/intelligence/?limit=100", "payments/stats/",
                 "payments/transactions/?limit=100", "logistics/summary/", "logistics/shipments/?limit=100",
                 "metrics/", "integrations/"]

    def test_query_count_independent_of_row_count(self, client_for, user_a, workspace_a, brand_a):
        c = client_for(user_a)
        base = f"/api/w/{workspace_a.slug}/b/{brand_a.id}/"
        seed(workspace_a, brand_a, 5)
        small = {e: count_queries(c, base + e) for e in self.ENDPOINTS}
        seed(workspace_a, brand_a, 60)
        large = {e: count_queries(c, base + e) for e in self.ENDPOINTS}
        print("\nquery counts (5 rows -> 65 rows):", {e: (small[e], large[e]) for e in self.ENDPOINTS})
        for e in self.ENDPOINTS:
            assert large[e] == small[e], f"{e}: {small[e]} -> {large[e]} queries (N+1)"
            assert large[e] <= 12, f"{e}: {large[e]} queries"
