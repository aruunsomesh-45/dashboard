from apps.analytics.catalogue import (
    compute_aov,
    compute_blended_cac,
    compute_blended_roas,
    compute_cm1_profit,
    compute_delivery_success_pct,
    compute_number_of_disputes,
    compute_orders_to_be_shipped,
    compute_organic_engagement,
    compute_revenue_per_day,
)


class TestMetricsCalculationFormulas:
    def test_shopify_revenue_per_day(self):
        facts = {"net_sales": 15000000, "days": 30}  # ₹1,50,000 across 30 days
        assert compute_revenue_per_day(facts) == 500000  # ₹5,000 / day

    def test_meta_ads_roas_and_cac(self):
        facts = {
            "ad_spend": 3400000,  # ₹34,000 spend
            "attributed_revenue": 14212000,  # ₹1,42,120 revenue
            "new_customers_count": 81,
        }
        assert compute_blended_roas(facts) == 4.18
        assert compute_blended_cac(facts) == 41975  # ~₹420 CAC (minor units)

    def test_delhivery_delivery_pct_and_pending_shipments(self):
        facts = {
            "delivered_shipments": 78,
            "total_shipments": 84,
            "paid_unfulfilled_orders": 8,
        }
        assert compute_delivery_success_pct(facts) == 92.9
        assert compute_orders_to_be_shipped(facts) == 8

    def test_razorpay_disputes(self):
        facts = {"open_disputes_count": 0}
        assert compute_number_of_disputes(facts) == 0

    def test_instagram_organic_engagement(self):
        facts = {
            "followers_count": 42850,
            "total_engagements": 1800,  # Likes + Comments + Saves
        }
        assert compute_organic_engagement(facts) == 4.2

    def test_ratio_of_sums_aov_anti_bias(self):
        # Golden statistical rule: Ratio of Sums, NOT Average of Averages
        # Day 1: 1 order of ₹10,000
        # Day 2: 100 orders of ₹100
        # Average of daily AOV would incorrectly yield: (10,000 + 100) / 2 = 5,050
        # Ratio of sums correctly yields: 20,000 / 101 = ~198
        facts = {
            "net_sales": 2000000,  # ₹20,000 in paise
            "orders_count": 101,
        }
        assert compute_aov(facts) == 19802  # ₹198.02 in paise

    def test_pnl_cm1_profit_waterfall(self):
        facts = {
            "gross_profit": 96856000,  # ₹9,68,560
            "ad_spend": 3400000,  # ₹34,000 Meta Ads
            "gateway_fee": 284860,  # ~2% Razorpay fee
            "shipping_cost": 9400000,  # Delhivery Forward + RTO
        }
        assert compute_cm1_profit(facts) == 83771140  # ₹8,37,711.40 Contribution Margin
