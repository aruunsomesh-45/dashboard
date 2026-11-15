"""
Metric correctness against hand-calculated values. The arithmetic is in the comments next to each expectation.

Everything runs through the real HTTP endpoints (real middleware, real Postgres, no mocks of our own code), with the
clock frozen at NOW so "last 30 days", freshness and window edges are deterministic. Money is integer paise.
The brand timezone is Asia/Kolkata (IST = UTC+05:30) unless a test says otherwise.

Endpoints used, and the contract assumed where the app has no implementation yet:
  * GET metrics/            ?keys=...&days=N                    (exists)
  * GET shopify/stats/      ?days=N                             (exists)
  * GET marketing/stats/, logistics/summary/, payments/stats/  (exist)
  * metrics/ and shopify/stats/ also accept ?from=YYYY-MM-DD&to=YYYY-MM-DD: inclusive calendar dates in the BRAND's
    timezone ("days" in the response is the number of dates in the range)
  * metrics/?compare=previous_period adds, per metric, `previous_value` and `change_pct`
    (= (current - previous) / previous * 100, one decimal, null when previous is 0), plus top-level
    `previous_range` {from, to}: the same number of days immediately before `from`
  * metrics/ and shopify/stats/ carry a top-level `freshness`: "stale" when the Shopify integration's last sync is
    more than 24h old (exactly 24h is still fresh), otherwise "fresh"
  * `formatted` strings use Indian digit grouping (lakh/crore): 14500000 paise -> "₹1,45,000"
  * payments/stats/ exposes `upi_drop_off_rate` = UPI attempts that failed with error_code payment_cancelled or
    payment_timeout / all UPI attempts * 100
  * ratios follow appflow/phases/calculations.md (NDR % counts shipments with >= 1 NDR, RTO % counts RTO *delivered*)
"""
import itertools
from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace
from unittest import mock
from zoneinfo import ZoneInfo

import pytest
import requests
from apps.analytics.catalogue import (
    compute_aov,
    compute_blended_cac,
    compute_blended_roas,
    compute_cm1_profit,
    compute_delivery_success_pct,
    compute_organic_engagement,
    compute_revenue_per_day,
)
from apps.analytics.models import FactAdsDaily
from apps.commerce.models import Customer, Order, PaymentAttempt, Shipment
from apps.integrations.models import Integration
from apps.tenancy.models import WorkspaceMember
from django.core.cache import cache
from freezegun import freeze_time
from rest_framework.test import APIClient

pytestmark = pytest.mark.django_db

IST = ZoneInfo("Asia/Kolkata")
NOW = datetime(2026, 11, 15, 12, 0, tzinfo=UTC)
_ids = itertools.count(1)


# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
def clock():
    cache.clear()
    with (
        freeze_time(NOW) as frozen,
        mock.patch.object(requests.sessions.Session, "request", side_effect=AssertionError("network call attempted")),
    ):
        yield frozen
    cache.clear()


@pytest.fixture
def ctx(clock, user_factory, workspace_a, brand_a):
    """A viewer (read-only, not subject to the owner/admin MFA gate) looking at brand_a."""
    viewer = user_factory()
    WorkspaceMember.objects.create(workspace=workspace_a, user=viewer, role="viewer")
    client = APIClient()
    client.force_login(viewer)
    base = f"/api/w/{workspace_a.slug}/b/{brand_a.id}/"

    def get(path, **params):
        return client.get(base + path, params)

    return SimpleNamespace(workspace=workspace_a, brand=brand_a, get=get)


def ist(day, hour=12, minute=0, month=11, second=0):
    return datetime(2026, month, day, hour, minute, second, tzinfo=IST)


def rng(first, last, month=11):
    return {"from": date(2026, month, first).isoformat(), "to": date(2026, month, last).isoformat()}


def order(ctx, when, net, *, n=1, financial="paid", fulfilment="unfulfilled", cancelled=False):
    """n identical Shopify orders of `net` paise placed at `when` (an aware datetime)."""
    Order.objects.bulk_create([
        Order(
            workspace=ctx.workspace, brand=ctx.brand, provider="shopify", provider_id=f"o{next(_ids)}",
            order_number=str(next(_ids)), gross_amount=net, net_sales=net, financial_status=financial,
            fulfillment_status=fulfilment, source_created_at=when, cancelled_at=when if cancelled else None,
        )
        for _ in range(n)
    ])


def ads(ctx, day, spend, revenue, impressions=0, clicks=0, month=11):
    FactAdsDaily.objects.create(
        workspace=ctx.workspace, brand=ctx.brand, fact_date=date(2026, month, day), spend_minor=spend,
        attributed_revenue_minor=revenue, impressions=impressions, clicks=clicks,
    )


def new_customers(ctx, n, when=None):
    for _ in range(n):
        Customer.objects.create(
            workspace=ctx.workspace, brand=ctx.brand, provider="shopify", provider_id=f"c{next(_ids)}",
            source_created_at=when or NOW - timedelta(days=3),
        )


def shipment(ctx, status, ndr_count=0):
    Shipment.objects.create(
        workspace=ctx.workspace, brand=ctx.brand, provider="delhivery", provider_id=f"s{next(_ids)}",
        awb=f"AWB{next(_ids)}", canonical_status=status, ndr_count=ndr_count,
    )


def payment(ctx, status, method="upi", error_code=""):
    PaymentAttempt.objects.create(
        workspace=ctx.workspace, brand=ctx.brand, provider="razorpay", provider_id=f"p{next(_ids)}",
        amount_minor=100000, status=status, method=method, error_code=error_code,
    )


def connect(ctx, provider, last_synced_at):
    return Integration.objects.create(
        workspace=ctx.workspace, brand=ctx.brand, provider=provider, status="connected",
        last_synced_at=last_synced_at,
    )


def zero_or_null(value, label):
    assert value is None or (value == 0 and value is not False), f"{label}: expected 0 or null, got {value!r}"


def metrics(ctx, keys, **query):
    res = ctx.get("metrics/", keys=",".join(keys), **query)
    assert res.status_code == 200, res.content
    return res.json()


def metric_value(ctx, key, **query):
    return metrics(ctx, [key], **query)["metrics"][key]["value"]


# Facts that both the metrics endpoint and the Shopify dashboard report, read the same way.
SURFACES = ["metrics", "shopify_stats"]
with_surface = pytest.mark.parametrize("surface", SURFACES)


def read_sales(ctx, surface, **query):
    """-> (net_sales_paise, order_count or None, aov_paise). metrics/ reports net sales as revenue_per_day over `days`,
    exact whenever net is divisible by days (every dataset below is chosen so)."""
    if surface == "metrics":
        data = metrics(ctx, ["revenue_per_day", "aov"], **query)
        m = data["metrics"]
        return m["revenue_per_day"]["value"] * data["days"], None, m["aov"]["value"]
    res = ctx.get("shopify/stats/", limit=1, **query)
    assert res.status_code == 200, res.content
    m = res.json()["metrics"]
    return m["net_sales_minor"], m["order_count"], m["aov_minor"]


# ---------------------------------------------------------------------------
# 1. AOV is a ratio of sums
# ---------------------------------------------------------------------------
class TestAov:
    def seed_two_days(self, ctx):
        order(ctx, ist(10), 1_000_000, n=1)   # Day 1: 1 order of ₹10,000 = 1,000,000 paise
        order(ctx, ist(11), 10_000, n=100)    # Day 2: 100 orders of ₹100 = 10,000 paise each

    @with_surface
    def test_aov_over_range_is_sum_of_net_over_sum_of_orders(self, ctx, surface):
        self.seed_two_days(ctx)
        # sum(net)    = 1,000,000 + 100 * 10,000 = 2,000,000 paise   (₹20,000)
        # sum(orders) = 1 + 100                  = 101
        # AOV         = 2,000,000 / 101 = 19,801.98 -> 19,802 paise = ₹198.02
        # Average of the daily AOVs would be (1,000,000 + 10,000) / 2 = 505,000 paise = ₹5,050: wrong.
        net, orders, aov = read_sales(ctx, surface, **rng(10, 11))
        assert aov != 505_000, "AOV is the average of daily AOVs (₹5,050) instead of a ratio of sums"
        assert aov == 19_802
        if surface == "shopify_stats":  # metrics/ derives net from revenue-per-day, which rounds when days does not divide it
            assert net == 2_000_000
        assert orders in (None, 101)

    @with_surface
    def test_each_single_day_has_its_own_aov(self, ctx, surface):
        self.seed_two_days(ctx)
        # Day 1: 1,000,000 / 1 = 1,000,000 ; Day 2: 100 * 10,000 / 100 = 10,000
        assert read_sales(ctx, surface, **rng(10, 10))[2] == 1_000_000
        assert read_sales(ctx, surface, **rng(11, 11))[2] == 10_000

    def test_formula_ratio_of_sums(self):
        assert compute_aov({"net_sales": 2_000_000, "orders_count": 101}) == 19_802  # 2,000,000 / 101 = 19,801.98

    def test_formula_zero_orders_is_zero(self):
        assert compute_aov({"net_sales": 0, "orders_count": 0}) == 0
        assert compute_aov({"net_sales": 500_000, "orders_count": 0}) == 0


# ---------------------------------------------------------------------------
# 2. Daily facts land on the brand-local date
# ---------------------------------------------------------------------------
def seed_boundary_orders(ctx):
    order(ctx, ist(10, 23, 30), 111_100)            # A: 10 Nov 23:30 IST = 10 Nov 18:00 UTC
    order(ctx, ist(11, 0, 15), 222_200)             # B: 11 Nov 00:15 IST = 10 Nov 18:45 UTC  <- UTC date is the 10th
    order(ctx, ist(11, 23, 59, second=59), 400)     # D: 11 Nov 23:59:59 IST = 11 Nov 18:29:59 UTC
    order(ctx, ist(12, 0, 0), 5_000_000)            # E: 12 Nov 00:00 IST = 11 Nov 18:30:00 UTC <- UTC date is the 11th


class TestBrandLocalDays:
    @with_surface
    def test_orders_land_on_the_ist_date_not_the_utc_date(self, ctx, surface):
        seed_boundary_orders(ctx)
        # IST dates:  10 Nov = A                = 111,100
        #             11 Nov = B + D            = 222,200 + 400 = 222,600
        #             12 Nov = E                = 5,000,000
        # A UTC-date bug would give 10 Nov = A + B = 333,300 and 11 Nov = D + E = 5,000,400.
        assert read_sales(ctx, surface, **rng(10, 10))[0] == 111_100
        assert read_sales(ctx, surface, **rng(11, 11))[0] == 222_600
        assert read_sales(ctx, surface, **rng(12, 12))[0] == 5_000_000

    def test_order_counts_per_ist_day(self, ctx):
        seed_boundary_orders(ctx)
        # 10 Nov: A (1 order). 11 Nov: B and D (2 orders). 12 Nov: E (1 order).
        counts = [read_sales(ctx, "shopify_stats", **rng(d, d))[1] for d in (10, 11, 12)]
        assert counts == [1, 2, 1]

    def test_late_evening_ist_order_stays_on_its_day(self, ctx):
        order(ctx, ist(10, 23, 30), 111_100)  # 23:30 IST on the 10th
        order(ctx, ist(11, 0, 15), 222_200)   # 00:15 IST on the 11th
        assert metric_value(ctx, "revenue_per_day", **rng(10, 10)) == 111_100
        assert metric_value(ctx, "revenue_per_day", **rng(11, 11)) == 222_200

    def test_uses_the_brand_timezone_not_a_hardcoded_one(self, ctx, brand_a):
        brand_a.timezone = "UTC"
        brand_a.save(update_fields=["timezone"])
        seed_boundary_orders(ctx)
        # For a UTC brand the same four instants fall on: 10 Nov = A + B = 333,300 ; 11 Nov = D + E = 5,000,400.
        assert metric_value(ctx, "revenue_per_day", **rng(10, 10)) == 333_300
        assert metric_value(ctx, "revenue_per_day", **rng(11, 11)) == 5_000_400


# ---------------------------------------------------------------------------
# 3. Ratios: hand-calculated values, and zero denominators
# ---------------------------------------------------------------------------
def seed_ads_dataset(ctx):
    #            spend     revenue    impressions  clicks
    ads(ctx, 8, 100_000, 400_000, 10_000, 200)
    ads(ctx, 9, 100_000, 500_000, 6_000, 150)
    ads(ctx, 10, 100_000, 300_000, 4_000, 150)
    # totals:    300,000   1,200,000  20,000       500


class TestAdsRatios:
    def test_roas(self, ctx):
        seed_ads_dataset(ctx)
        # ROAS = sum(attributed revenue) / sum(spend) = 1,200,000 / 300,000 = 4.0
        assert metric_value(ctx, "blended_roas") == 4.0

    def test_cac(self, ctx):
        seed_ads_dataset(ctx)
        new_customers(ctx, 4)
        # CAC = sum(spend) / new customers = 300,000 / 4 = 75,000 paise (₹750)
        assert metric_value(ctx, "blended_cac") == 75_000

    @pytest.fixture
    def marketing(self, ctx):
        connect(ctx, "meta_ads", NOW - timedelta(minutes=1))  # recent sync: serve stored facts, no live call

        def summary():
            res = ctx.get("marketing/stats/")
            assert res.status_code == 200, res.content
            return res.json()["summary_30d"]

        return summary

    def test_ctr_and_cpc(self, ctx, marketing):
        seed_ads_dataset(ctx)
        s = marketing()
        # CTR = clicks / impressions * 100 = 500 / 20,000 * 100 = 2.5 %
        assert s["ctr"] == pytest.approx(2.5, abs=0.005)
        # CPC = spend / clicks = 300,000 / 500 = 600 paise (₹6)
        assert s["cpc_minor"] == 600
        # ROAS on the same page = 1,200,000 / 300,000 = 4.0
        assert s["roas"] == 4.0

    # -- zero denominators ---------------------------------------------------------------------------------------
    def test_roas_with_zero_spend(self, ctx):
        ads(ctx, 9, 0, 50_000)  # revenue but no spend: 50,000 / 0 must not crash or report 50,000x
        zero_or_null(metric_value(ctx, "blended_roas"), "ROAS")

    def test_roas_with_no_ads_data_at_all(self, ctx):
        zero_or_null(metric_value(ctx, "blended_roas"), "ROAS")

    def test_cac_with_zero_new_customers(self, ctx):
        ads(ctx, 9, 100_000, 400_000)  # spend but nobody acquired: 100,000 / 0
        zero_or_null(metric_value(ctx, "blended_cac"), "CAC")

    @pytest.mark.parametrize(
        ("label", "row"),
        [
            ("all zero", dict(spend=0, revenue=0, impressions=0, clicks=0)),
            ("impressions but no clicks", dict(spend=5_000, revenue=0, impressions=5_000, clicks=0)),
            ("clicks but no spend", dict(spend=0, revenue=9_000, impressions=100, clicks=10)),
        ],
    )
    def test_ctr_cpc_roas_never_divide_by_zero(self, ctx, marketing, label, row):
        ads(ctx, 9, row["spend"], row["revenue"], row["impressions"], row["clicks"])
        s = marketing()
        if row["impressions"] == 0:
            zero_or_null(s["ctr"], f"{label}: CTR")      # x / 0 impressions
        if row["clicks"] == 0:
            zero_or_null(s["cpc_minor"], f"{label}: CPC")  # x / 0 clicks
        if row["spend"] == 0:
            zero_or_null(s["roas"], f"{label}: ROAS")      # x / 0 spend
            assert s["cpc_minor"] == 0 or s["cpc_minor"] is None  # 0 spend / 10 clicks = 0

    def test_formulas_zero_denominators(self):
        assert compute_blended_roas({"ad_spend": 0, "attributed_revenue": 50_000}) == 0.0
        assert compute_blended_cac({"ad_spend": 100_000, "new_customers_count": 0}) == 0
        assert compute_delivery_success_pct({"total_shipments": 0, "delivered_shipments": 0}) == 0.0
        assert compute_organic_engagement({"followers_count": 0, "total_engagements": 10}) == 0.0
        assert compute_revenue_per_day({"net_sales": 0, "days": 0}) == 0


def seed_shipments(ctx):
    # 10 dispatches. status / NDRs raised during the journey:
    for _ in range(3):
        shipment(ctx, "delivered", ndr_count=0)       # S1-S3
    shipment(ctx, "delivered", ndr_count=1)           # S4  NDR once, then delivered
    shipment(ctx, "ndr", ndr_count=1)                 # S5
    shipment(ctx, "ndr", ndr_count=2)                 # S6
    shipment(ctx, "rto_delivered", ndr_count=3)       # S7
    shipment(ctx, "rto_delivered", ndr_count=0)       # S8
    shipment(ctx, "rto_initiated", ndr_count=3)       # S9  on its way back, not yet delivered
    shipment(ctx, "in_transit", ndr_count=0)          # S10


class TestLogisticsRatios:
    def summary(self, ctx):
        res = ctx.get("logistics/summary/")
        assert res.status_code == 200, res.content
        return res.json()

    def test_ndr_rate_counts_shipments_with_at_least_one_ndr(self, ctx):
        seed_shipments(ctx)
        # Shipments with >= 1 NDR: S4, S5, S6, S7, S9 = 5 ; total dispatches = 10 ; NDR % = 5 / 10 * 100 = 50.0
        # (counting only those *currently* in NDR status gives S5, S6 = 20.0: wrong)
        assert self.summary(ctx)["ndr_rate_percentage"] == pytest.approx(50.0, abs=0.005)

    def test_rto_rate_counts_rto_delivered(self, ctx):
        seed_shipments(ctx)
        # RTO delivered: S7, S8 = 2 ; total = 10 ; RTO % = 2 / 10 * 100 = 20.0
        # (also counting S9, still in rto_initiated, gives 30.0: wrong)
        assert self.summary(ctx)["rto_rate_percentage"] == pytest.approx(20.0, abs=0.005)

    def test_delivery_success_rate(self, ctx):
        seed_shipments(ctx)
        # Delivered: S1-S4 = 4 of 10 = 40.0 % (the formula, as the Overview page uses it)
        assert compute_delivery_success_pct({"delivered_shipments": 4, "total_shipments": 10}) == 40.0
        assert self.summary(ctx)["delivered_count"] == 4

    def test_no_shipments_means_zero_or_null_not_a_crash(self, ctx):
        body = self.summary(ctx)  # NDR / RTO over 0 dispatches
        zero_or_null(body["ndr_rate_percentage"], "NDR %")
        zero_or_null(body["rto_rate_percentage"], "RTO %")

    def test_shipments_without_any_ndr_or_rto_report_zero(self, ctx):
        for _ in range(4):
            shipment(ctx, "delivered")
        body = self.summary(ctx)
        assert body["ndr_rate_percentage"] == 0 and body["rto_rate_percentage"] == 0


def seed_payments(ctx):
    # UPI: 10 attempts
    for _ in range(6):
        payment(ctx, "captured", "upi")
    payment(ctx, "failed", "upi", "payment_cancelled")      # user backed out
    payment(ctx, "failed", "upi", "payment_cancelled")
    payment(ctx, "failed", "upi", "payment_timeout")        # never approved in the UPI app
    payment(ctx, "failed", "upi", "insufficient_funds")     # failed, but not a drop-off
    # Card: 6 attempts. A cancelled card payment is not a UPI drop-off.
    for _ in range(4):
        payment(ctx, "captured", "card")
    payment(ctx, "failed", "card", "payment_cancelled")
    payment(ctx, "failed", "card", "card_declined")


class TestPaymentRatios:
    def stats(self, ctx):
        res = ctx.get("payments/stats/")
        assert res.status_code == 200, res.content
        return res.json()

    def test_gateway_authorization_rate(self, ctx):
        seed_payments(ctx)
        # Captured: 6 UPI + 4 card = 10 ; total attempts: 10 UPI + 6 card = 16 ; rate = 10 / 16 * 100 = 62.5 %
        assert self.stats(ctx)["authorized_rate"] == pytest.approx(62.5, abs=0.05)

    def test_upi_drop_off_rate(self, ctx):
        seed_payments(ctx)
        # UPI cancel/timeout: 2 + 1 = 3 ; UPI attempts = 10 ; drop-off = 3 / 10 * 100 = 30.0 %
        # (card cancel excluded; insufficient_funds excluded)
        body = self.stats(ctx)
        assert "upi_drop_off_rate" in body, "payments/stats does not expose upi_drop_off_rate"
        assert body["upi_drop_off_rate"] == pytest.approx(30.0, abs=0.05)

    def test_no_attempts_means_zero_or_null_not_a_crash(self, ctx):
        body = self.stats(ctx)
        zero_or_null(body["authorized_rate"], "authorization rate")
        assert "upi_drop_off_rate" in body
        zero_or_null(body["upi_drop_off_rate"], "UPI drop-off")

    def test_card_only_attempts_have_no_upi_denominator(self, ctx):
        payment(ctx, "captured", "card")
        payment(ctx, "failed", "card", "payment_cancelled")
        body = self.stats(ctx)
        assert body["authorized_rate"] == pytest.approx(50.0, abs=0.05)  # 1 captured / 2 attempts
        assert "upi_drop_off_rate" in body
        zero_or_null(body["upi_drop_off_rate"], "UPI drop-off with 0 UPI attempts")


class TestEmptyBrand:
    def test_every_metric_is_zero_or_null_never_an_error(self, ctx):
        res = ctx.get("metrics/")
        assert res.status_code == 200, res.content
        for key, m in res.json()["metrics"].items():
            zero_or_null(m["value"], key)


# ---------------------------------------------------------------------------
# 4. Contribution margin waterfall
# ---------------------------------------------------------------------------
class TestContributionMargin:
    # Net revenue ₹5,00,000                                   = 50,000,000 paise
    # - COGS ₹1,75,000 (35 %)                                 = 17,500,000      -> gross profit 32,500,000
    # - Meta ads ₹60,000                                      =  6,000,000
    # - Razorpay fees ₹10,000 (2 % of ₹5,00,000)              =  1,000,000
    # - Shipping: forward ₹45,000 + RTO ₹12,000 = ₹57,000     =  5,700,000
    # CM1 = 32,500,000 - 6,000,000 - 1,000,000 - 5,700,000    = 19,800,000 paise (₹1,98,000)
    NET, COGS, ADS, FEES, FORWARD, RTO = 50_000_000, 17_500_000, 6_000_000, 1_000_000, 4_500_000, 1_200_000

    def facts(self, **over):
        base = {
            "gross_profit": self.NET - self.COGS,
            "ad_spend": self.ADS,
            "gateway_fee": self.FEES,
            "shipping_cost": self.FORWARD + self.RTO,
        }
        return {**base, **over}

    def test_waterfall_matches_the_manual_calculation(self):
        assert compute_cm1_profit(self.facts()) == 19_800_000

    @pytest.mark.parametrize(
        ("component", "amount"),
        [("ad_spend", 6_000_000), ("gateway_fee", 1_000_000), ("shipping_cost", 5_700_000), ("gross_profit", 32_500_000)],
    )
    def test_every_component_counts_exactly_once(self, component, amount):
        # Zeroing one input must move CM1 by exactly that input: +6,000,000 / +1,000,000 / +5,700,000 for the costs,
        # -32,500,000 for gross profit.
        without = compute_cm1_profit(self.facts(**{component: 0}))
        delta = without - 19_800_000
        assert delta == (-amount if component == "gross_profit" else amount)

    def test_rto_freight_is_part_of_shipping(self):
        forward_only = compute_cm1_profit(self.facts(shipping_cost=self.FORWARD))
        with_rto = compute_cm1_profit(self.facts(shipping_cost=self.FORWARD + self.RTO))
        assert forward_only - with_rto == self.RTO == 1_200_000

    def test_loss_making_period_goes_negative(self):
        # Gross profit 1,000,000 - (ads 2,000,000 + fees 100,000 + shipping 300,000) = -1,400,000
        assert compute_cm1_profit(
            {"gross_profit": 1_000_000, "ad_spend": 2_000_000, "gateway_fee": 100_000, "shipping_cost": 300_000}
        ) == -1_400_000

    def test_endpoint_never_estimates_missing_cost_inputs(self, ctx):
        """COGS, Razorpay fees and carrier charges are not stored anywhere, so CM1 must say so instead of guessing
        (a 35 % COGS / 2 % fee / ₹85-per-parcel assumption would show a confident but made-up margin)."""
        order(ctx, ist(10), 50_000_000)
        ads(ctx, 9, 6_000_000, 20_000_000)
        cm1 = metrics(ctx, ["cm1_profit"])["metrics"]["cm1_profit"]
        assert cm1["available"] is False and cm1["value"] is None
        assert {"gross_profit", "gateway_fee", "shipping_cost"} <= set(cm1["missing_inputs"])


# ---------------------------------------------------------------------------
# 5. Cancelled orders are excluded
# ---------------------------------------------------------------------------
class TestCancelledOrders:
    def seed(self, ctx):
        order(ctx, ist(10), 100_000, financial="paid", fulfilment="fulfilled")
        order(ctx, ist(10), 200_000, financial="paid", fulfilment="unfulfilled")
        order(ctx, ist(11), 300_000, financial="pending", fulfilment="unfulfilled")
        order(ctx, ist(11), 500_000, financial="paid", fulfilment="unfulfilled", cancelled=True)
        order(ctx, ist(12), 700_000, financial="voided", fulfilment="unfulfilled", cancelled=True)

    @with_surface
    def test_cancelled_orders_do_not_count_towards_sales_orders_or_aov(self, ctx, surface):
        self.seed(ctx)
        # Live: 100,000 + 200,000 + 300,000 = 600,000 paise over 3 orders -> AOV 200,000.
        # (Including the cancelled 500,000 + 700,000 would give 1,800,000 / 5 = 360,000.)
        net, orders, aov = read_sales(ctx, surface, days=30)
        assert net == 600_000
        assert aov == 200_000
        assert orders in (None, 3)

    def test_funnel_placed_excludes_cancelled(self, ctx):
        self.seed(ctx)
        funnel = ctx.get("shopify/stats/", limit=1, days=30).json()["funnel"]
        assert funnel["placed"] == 3  # 5 orders - 2 cancelled

    @with_surface
    def test_a_brand_with_only_cancelled_orders_reports_zero(self, ctx, surface):
        order(ctx, ist(10), 500_000, cancelled=True, n=2)
        net, orders, aov = read_sales(ctx, surface, days=30)
        assert (net, aov) == (0, 0)
        assert orders in (None, 0)

    def test_orders_to_be_shipped_is_paid_unfulfilled_and_not_cancelled(self, ctx):
        self.seed(ctx)
        # Paid + unfulfilled + live: only the 200,000 order = 1.
        # (the pending 300,000 is unpaid; the paid 500,000 is cancelled)  Counting every unfulfilled row gives 4.
        assert metric_value(ctx, "orders_to_be_shipped", days=30) == 1


# ---------------------------------------------------------------------------
# 6. Previous-period comparison
# ---------------------------------------------------------------------------
class TestPreviousPeriod:
    KEYS = ["revenue_per_day", "aov", "blended_roas"]

    def seed(self, ctx):
        # Current period 6-10 Nov (5 days)
        order(ctx, ist(6, 0, 30), 100_000)
        order(ctx, ist(8, 12), 200_000)
        order(ctx, ist(10, 23, 30), 300_000)
        # Previous period 1-5 Nov (the 5 days immediately before)
        order(ctx, ist(1, 0, 30), 50_000)
        order(ctx, ist(2, 12), 50_000)
        order(ctx, ist(4, 12), 100_000)
        order(ctx, ist(5, 23, 30), 200_000)
        # Outside both: must not leak into either side
        order(ctx, ist(31, 23, 30, month=10), 7_777_777)   # 31 Oct 23:30 IST, a day before the previous period
        order(ctx, ist(11, 0, 15), 8_888_888)              # 11 Nov 00:15 IST, a day after the current period
        ads(ctx, 7, 100_000, 200_000)                      # current
        ads(ctx, 3, 100_000, 400_000)                      # previous
        ads(ctx, 12, 900_000, 900_000)                     # after the current period
        ads(ctx, 31, 50_000, 5_000_000, month=10)          # before the previous period

    def compare(self, ctx, first=6, last=10):
        data = metrics(ctx, self.KEYS, compare="previous_period", **rng(first, last))
        return data, data["metrics"]

    def test_previous_range_is_the_same_length_immediately_before(self, ctx):
        self.seed(ctx)
        data, _ = self.compare(ctx)
        assert data["previous_range"] == {"from": "2026-11-01", "to": "2026-11-05"}

    def test_revenue_per_day_change(self, ctx):
        self.seed(ctx)
        _, m = self.compare(ctx)
        # current  = (100,000 + 200,000 + 300,000) / 5 days = 600,000 / 5 = 120,000
        # previous = (50,000 + 50,000 + 100,000 + 200,000) / 5 = 400,000 / 5 = 80,000
        # change   = (120,000 - 80,000) / 80,000 * 100 = +50.0 %
        assert m["revenue_per_day"]["value"] == 120_000
        assert m["revenue_per_day"]["previous_value"] == 80_000
        assert m["revenue_per_day"]["change_pct"] == pytest.approx(50.0, abs=0.05)

    def test_aov_change_uses_ratio_of_sums_on_both_sides(self, ctx):
        self.seed(ctx)
        _, m = self.compare(ctx)
        # current  = 600,000 / 3 orders = 200,000 ; previous = 400,000 / 4 orders = 100,000
        # change   = (200,000 - 100,000) / 100,000 * 100 = +100.0 %
        assert m["aov"]["value"] == 200_000
        assert m["aov"]["previous_value"] == 100_000
        assert m["aov"]["change_pct"] == pytest.approx(100.0, abs=0.05)

    def test_a_decrease_is_negative(self, ctx):
        self.seed(ctx)
        _, m = self.compare(ctx)
        # ROAS current = 200,000 / 100,000 = 2.0 ; previous = 400,000 / 100,000 = 4.0
        # change = (2.0 - 4.0) / 4.0 * 100 = -50.0 %
        assert m["blended_roas"]["value"] == 2.0
        assert m["blended_roas"]["previous_value"] == 4.0
        assert m["blended_roas"]["change_pct"] == pytest.approx(-50.0, abs=0.05)

    def test_change_is_rounded_to_one_decimal(self, ctx):
        order(ctx, ist(8, 12), 400_000)   # current 400,000 / 5 days = 80,000
        order(ctx, ist(3, 12), 300_000)   # previous 300,000 / 5 days = 60,000
        _, m = self.compare(ctx)
        # (80,000 - 60,000) / 60,000 * 100 = 33.333... -> 33.3
        assert m["revenue_per_day"]["change_pct"] == pytest.approx(33.3, abs=0.05)

    def test_no_previous_data_gives_null_change_not_infinity_or_a_crash(self, ctx):
        order(ctx, ist(8, 12), 400_000)   # current only: previous revenue / orders = 0
        _, m = self.compare(ctx)
        assert m["revenue_per_day"]["value"] == 80_000
        zero_or_null(m["revenue_per_day"]["previous_value"], "previous revenue/day")
        assert m["revenue_per_day"]["change_pct"] is None   # (80,000 - 0) / 0 is undefined
        assert m["aov"]["change_pct"] is None

    def test_without_compare_there_is_no_comparison_block(self, ctx):
        self.seed(ctx)
        m = metrics(ctx, self.KEYS, **rng(6, 10))["metrics"]
        assert "change_pct" not in m["revenue_per_day"]
        assert m["revenue_per_day"]["value"] == 120_000  # the range itself still applies


# ---------------------------------------------------------------------------
# 7. Freshness
# ---------------------------------------------------------------------------
class TestFreshness:
    def freshness(self, ctx, surface):
        res = ctx.get("metrics/" if surface == "metrics" else "shopify/stats/")
        assert res.status_code == 200, res.content
        assert "freshness" in res.json(), "response has no `freshness`"
        return res.json()["freshness"]

    @with_surface
    @pytest.mark.parametrize(
        ("age", "expected"),
        [
            (timedelta(minutes=1), "fresh"),
            (timedelta(hours=23, minutes=59, seconds=59), "fresh"),
            (timedelta(hours=24), "fresh"),                   # "> 24h" is strict
            (timedelta(hours=24, seconds=1), "stale"),
            (timedelta(days=3), "stale"),
        ],
        ids=["1min", "23h59m59s", "exactly-24h", "24h00m01s", "3days"],
    )
    def test_stale_only_when_last_sync_is_older_than_24h(self, ctx, surface, age, expected):
        connect(ctx, "shopify", NOW - age)
        assert self.freshness(ctx, surface) == expected

    @with_surface
    def test_never_synced_is_not_reported_fresh(self, ctx, surface):
        connect(ctx, "shopify", None)
        assert self.freshness(ctx, surface) != "fresh"

    def test_freshness_follows_the_clock_not_a_stored_flag(self, ctx, clock):
        connect(ctx, "shopify", NOW - timedelta(hours=20))
        assert self.freshness(ctx, "metrics") == "fresh"
        clock.tick(timedelta(hours=5))  # now 25h since the sync
        cache.clear()
        assert self.freshness(ctx, "metrics") == "stale"


# ---------------------------------------------------------------------------
# 8. Indian number formatting
# ---------------------------------------------------------------------------
class TestIndianFormatting:
    @pytest.mark.parametrize(
        ("paise", "expected"),
        [
            (99_900, "₹999"),                      # ₹999
            (100_000, "₹1,000"),                   # ₹1,000
            (1_000_000, "₹10,000"),                # ₹10,000
            (10_000_000, "₹1,00,000"),             # ₹1 lakh
            (14_500_000, "₹1,45,000"),             # ₹1,45,000 (the Western grouping would be ₹145,000)
            (1_234_567_800, "₹1,23,45,678"),       # ₹1.23 crore
        ],
    )
    def test_currency_uses_lakh_crore_grouping(self, ctx, paise, expected):
        order(ctx, NOW - timedelta(hours=1), paise)   # one order inside a 1-day window: revenue/day = paise / 1
        m = metrics(ctx, ["revenue_per_day"], days=1)["metrics"]["revenue_per_day"]
        assert m["value"] == paise
        assert m["formatted"] == expected

    def test_aov_is_formatted_the_same_way(self, ctx):
        order(ctx, NOW - timedelta(hours=1), 14_500_000)
        assert metrics(ctx, ["aov"], days=1)["metrics"]["aov"]["formatted"] == "₹1,45,000"
