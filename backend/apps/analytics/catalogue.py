from collections.abc import Callable
from dataclasses import dataclass
from typing import Any


@dataclass
class MetricDefinition:
    key: str
    display_name: str
    source: str  # 'shopify', 'meta_ads', 'delhivery', 'razorpay', 'instagram', 'blended'
    description: str
    unit: str  # 'currency_minor', 'ratio', 'percentage', 'count'
    formula_version: str  # 'v1'
    compute_fn: Callable[[dict[str, Any]], Any]


# ─── Exact Mathematical Formulas as per calculations.md ───────────────────────


def compute_revenue_per_day(facts: dict[str, Any]) -> int:
    """∑(Gross − Discounts − Refunds − Taxes) / Days"""
    days = facts.get("days", 30) or 1
    net_sales = facts.get("net_sales", 0)
    return int(round(net_sales / days))


def compute_blended_roas(facts: dict[str, Any]) -> float:
    """∑Attributed Revenue / ∑Meta Ad Spend (28-day restated)"""
    spend = facts.get("ad_spend", 0)
    if not spend:
        return 0.0
    revenue = facts.get("attributed_revenue", 0)
    return round(revenue / spend, 2)


def compute_blended_cac(facts: dict[str, Any]) -> int:
    """∑Ad Spend / ∑New Customers Acquired"""
    new_customers = facts.get("new_customers_count", 0)
    spend = facts.get("ad_spend", 0)
    if not new_customers:
        return 0
    return int(round(spend / new_customers))


def compute_delivery_success_pct(facts: dict[str, Any]) -> float:
    """Count(Delivered Shipments) / Count(Total Shipments) * 100"""
    total = facts.get("total_shipments", 0)
    if not total:
        return 0.0
    delivered = facts.get("delivered_shipments", 0)
    return round((delivered / total) * 100, 1)


def compute_orders_to_be_shipped(facts: dict[str, Any]) -> int:
    """Count(Orders where Paid and Unfulfilled)"""
    return facts.get("paid_unfulfilled_orders", 0)


def compute_number_of_disputes(facts: dict[str, Any]) -> int:
    """Count(Dispute records where status is open/under_review)"""
    return facts.get("open_disputes_count", 0)


def compute_organic_engagement(facts: dict[str, Any]) -> float:
    """∑(Likes + Comments + Saves) / Followers Count * 100"""
    followers = facts.get("followers_count", 0)
    if not followers:
        return 0.0
    engagements = facts.get("total_engagements", 0)
    return round((engagements / followers) * 100, 2)


def compute_aov(facts: dict[str, Any]) -> int:
    """Ratio of Sums: ∑Net Sales / ∑Eligible Orders"""
    orders = facts.get("orders_count", 0)
    if not orders:
        return 0
    return int(round(facts.get("net_sales", 0) / orders))


def compute_cm1_profit(facts: dict[str, Any]) -> int:
    """Contribution Margin 1: Gross Margin - (Ad Spend + Gateway Charges + Shipping)"""
    gross_profit = facts.get("gross_profit", 0)
    ad_spend = facts.get("ad_spend", 0)
    gateway_fee = facts.get("gateway_fee", 0)
    freight = facts.get("shipping_cost", 0)
    return gross_profit - (ad_spend + gateway_fee + freight)


# ─── Metric Registry ──────────────────────────────────────────────────────────

METRIC_REGISTRY: dict[str, MetricDefinition] = {
    "revenue_per_day": MetricDefinition(
        key="revenue_per_day",
        display_name="Revenue / Day (Daily Net Sales)",
        source="shopify",
        description="Daily net realized sales: ∑(Gross − Discounts − Refunds − Taxes) / Days",
        unit="currency_minor",
        formula_version="v1",
        compute_fn=compute_revenue_per_day,
    ),
    "blended_roas": MetricDefinition(
        key="blended_roas",
        display_name="Blended ROAS",
        source="meta_ads",
        description="Return on ad spend: ∑Attributed Revenue / ∑Meta Ad Spend (28-day window)",
        unit="ratio",
        formula_version="v1",
        compute_fn=compute_blended_roas,
    ),
    "blended_cac": MetricDefinition(
        key="blended_cac",
        display_name="Blended CAC",
        source="meta_ads",
        description="Customer acquisition cost: ∑Ad Spend / ∑New Customers Acquired",
        unit="currency_minor",
        formula_version="v1",
        compute_fn=compute_blended_cac,
    ),
    "delivery_success_pct": MetricDefinition(
        key="delivery_success_pct",
        display_name="Delivery Success %",
        source="delhivery",
        description="Successful delivery rate: Count(Delivered) / Count(Total Shipments) * 100",
        unit="percentage",
        formula_version="v1",
        compute_fn=compute_delivery_success_pct,
    ),
    "orders_to_be_shipped": MetricDefinition(
        key="orders_to_be_shipped",
        display_name="Orders to be Shipped",
        source="delhivery",
        description="Pending warehouse dispatch queue: Count(Orders where Paid and Unfulfilled)",
        unit="count",
        formula_version="v1",
        compute_fn=compute_orders_to_be_shipped,
    ),
    "number_of_disputes": MetricDefinition(
        key="number_of_disputes",
        display_name="Number of Disputes",
        source="razorpay",
        description="Active chargeback claims: Count(Disputes where status is open/under_review)",
        unit="count",
        formula_version="v1",
        compute_fn=compute_number_of_disputes,
    ),
    "organic_engagement": MetricDefinition(
        key="organic_engagement",
        display_name="Organic Engagement",
        source="instagram",
        description="Follower engagement rate: ∑(Likes + Comments + Saves) / Followers * 100",
        unit="percentage",
        formula_version="v1",
        compute_fn=compute_organic_engagement,
    ),
    "aov": MetricDefinition(
        key="aov",
        display_name="Average Order Value",
        source="shopify",
        description="Ratio of sums: ∑Net Sales / ∑Eligible Orders",
        unit="currency_minor",
        formula_version="v1",
        compute_fn=compute_aov,
    ),
    "cm1_profit": MetricDefinition(
        key="cm1_profit",
        display_name="Contribution Margin 1 (CM1)",
        source="blended",
        description="Operating Profit Health Score: Gross Margin − (Ad Spend + Gateway Charges + Freight)",
        unit="currency_minor",
        formula_version="v1",
        compute_fn=compute_cm1_profit,
    ),
}
