# Phase 4: Analytics Engine, Fact Rollups & Metrics API

## Overview & Goal
Build the deterministic metrics computation engine that powers all charts, KPI cards, and reports across your dashboard.

No AI guesswork: every number on the dashboard is derived from versioned Python formulas and Postgres aggregations, served via a unified `/api/metrics` endpoint, cached in Redis with tenant isolation, and consumed by the AI-generated Next.js frontend.

---

## 1. Core Mental Models & Concepts to Learn

### A. The Golden Statistical Rule: Ratio of Sums vs Sum of Ratios
A classic pitfall in junior analytics engineering is calculating an aggregate average by averaging daily averages:
- **WRONG:**
  $$\text{Monthly AOV} \neq \frac{\text{AOV}_{\text{Day 1}} + \text{AOV}_{\text{Day 2}} + \dots + \text{AOV}_{\text{Day 30}}}{30}$$
  If Day 1 had 1 order of ₹10,000 ($\text{AOV} = 10,000$) and Day 2 had 100 orders of ₹100 each ($\text{AOV} = 100$), the average of the two averages is $\frac{10,100}{2} = ₹5,050$. But the real AOV is $\frac{10,000 + 10,000}{101} = ₹198$!
- **CORRECT:** Always store **additive base facts** (sum of net sales, count of orders) in daily rollup tables, and compute the ratio over the requested date range:
  $$\text{AOV}_{\text{range}} = \frac{\sum \text{net\_sales}}{\sum \text{eligible\_orders}}$$

### B. Timezone Boundaries & Brand Localization
Your database stores every timestamp in **UTC**. However, an Indian e-commerce brand expects their "Daily Sales for Nov 10" to count orders placed between `2026-11-10 00:00:00+05:30` and `2026-11-10 23:59:59+05:30`.
- In SQL, use Postgres timezone conversion:
  ```sql
  (source_created_at AT TIME ZONE 'UTC' AT TIME ZONE brand.timezone)::date
  ```
- Store this localized date as `fact_date` in daily rollup tables.

### C. Daily Fact Rollup Architecture
Running `COUNT(*)` or `SUM(gross_amount)` across millions of raw order rows on every page refresh destroys database performance.
- We pre-aggregate data into **Daily Fact Tables**:
  - `FactShopDaily`: `(brand, date, gross_sales, discounts, returns, net_sales, orders_count)`
  - `FactPaymentDaily`: `(brand, date, attempts_count, success_count, failed_count, fees_paid)`
  - `FactAdsDaily`: `(brand, date, spend, impressions, clicks, attributed_conversions)`
  - `FactShipmentDaily`: `(brand, date, dispatched, delivered, ndr_count, rto_count)`
- When a sync completes, a Celery task recalculates **only the dates modified by that sync**, keeping the aggregation instant.

### D. Metric Definition Versioning
Every KPI is governed by an explicit definition in code (`apps/analytics/catalogue.py`). If you change how Net Sales is computed, you create `v2`, keeping `v1` intact for historical audits.

---

## 2. Step-by-Step Implementation Guide

### Step 1: Metric Catalogue & Formula Registry
```python
# apps/analytics/catalogue.py
from dataclasses import dataclass
from typing import Callable, List

@dataclass
class MetricDefinition:
    key: str
    display_name: str
    source: str          # 'shopify', 'razorpay', 'blended'
    description: str
    unit: str            # 'currency', 'ratio', 'percentage', 'count'
    formula_version: str # 'v1'
    compute_fn: Callable

# Formula implementations
def compute_aov(facts: dict) -> float:
    orders = facts.get('orders_count', 0)
    if not orders:
        return 0.0
    return facts.get('net_sales', 0) / orders

def compute_roas(facts: dict) -> float:
    spend = facts.get('ad_spend', 0)
    if not spend:
        return 0.0
    return facts.get('attributed_revenue', 0) / spend

METRIC_REGISTRY = {
    'aov': MetricDefinition(
        key='aov',
        display_name='Average Order Value',
        source='shopify',
        description='Net sales divided by eligible orders',
        unit='currency',
        formula_version='v1',
        compute_fn=compute_aov
    ),
    'roas': MetricDefinition(
        key='roas',
        display_name='Return on Ad Spend',
        source='meta_ads',
        description='Attributed revenue divided by ad spend',
        unit='ratio',
        formula_version='v1',
        compute_fn=compute_roas
    )
}
```

### Step 2: Daily Fact Rollup Table
```python
# apps/analytics/models.py
from django.db import models

class FactShopDaily(models.Model):
    workspace = models.ForeignKey('tenancy.Workspace', on_delete=models.CASCADE)
    brand = models.ForeignKey('tenancy.Brand', on_delete=models.CASCADE)
    fact_date = models.DateField(db_index=True)
    
    # Financials stored in paise
    gross_sales = models.BigIntegerField(default=0)
    discount_amount = models.BigIntegerField(default=0)
    tax_amount = models.BigIntegerField(default=0)
    net_sales = models.BigIntegerField(default=0)
    
    # Counts
    orders_count = models.IntegerField(default=0)
    customers_count = models.IntegerField(default=0)
    
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = ('brand', 'fact_date')
```

### Step 3: Incremental Rollup Celery Task
```python
# apps/analytics/tasks.py
from celery import shared_task
from django.db.models import Sum, Count
from apps.commerce.models import Order
from apps.analytics.models import FactShopDaily

@shared_task
def rollup_shopify_facts(workspace_id: str, brand_id: str, dates: list):
    for date_str in dates:
        # Filter orders in brand timezone for that date
        orders = Order.objects.filter(
            workspace_id=workspace_id,
            brand_id=brand_id,
            source_created_at__date=date_str
        )
        agg = orders.aggregate(
            gross=Sum('gross_amount'),
            discount=Sum('discount_amount'),
            tax=Sum('tax_amount'),
            net=Sum('net_sales'),
            count=Count('id')
        )
        
        FactShopDaily.objects.update_or_create(
            workspace_id=workspace_id,
            brand_id=brand_id,
            fact_date=date_str,
            defaults={
                'gross_sales': agg['gross'] or 0,
                'discount_amount': agg['discount'] or 0,
                'tax_amount': agg['tax'] or 0,
                'net_sales': agg['net'] or 0,
                'orders_count': agg['count'] or 0,
            }
        )
```

### Step 4: Unified Metrics API View
Implement `GET /api/w/{ws}/metrics/`:
- Parses query params: `keys=net_sales,aov`, `brand_id`, `from_date`, `to_date`, `compare=previous_period`.
- Checks Redis cache key: `ws:{ws_id}:brand:{brand_id}:metrics:{hash_of_params}`.
- If cache miss: queries the fact tables for both primary and comparison date ranges, invokes `compute_fn` from registry, formats response, and caches in Redis for 15 minutes.

---

## 3. What the AI Frontend Needs (API Contract)

The AI building your Next.js dashboard consumes this standardized response:

```json
{
  "currency": "INR",
  "from_date": "2026-11-01",
  "to_date": "2026-11-10",
  "comparison_period": "2026-10-22 to 2026-10-31",
  "metrics": {
    "net_sales": {
      "display_name": "Net Sales",
      "value": 14500000,
      "formatted": "₹1,45,000",
      "comparison_value": 12000000,
      "percentage_change": 20.83,
      "freshness": "fresh",
      "formula_version": "v1",
      "sparkline": [
        { "date": "2026-11-01", "value": 1200000 },
        { "date": "2026-11-02", "value": 1500000 }
      ]
    },
    "aov": {
      "display_name": "Average Order Value",
      "value": 145000,
      "formatted": "₹1,450",
      "comparison_value": 135000,
      "percentage_change": 7.41,
      "freshness": "fresh",
      "formula_version": "v1"
    }
  }
}
```

---

## 4. Verification & Exit Gate Checklist

- [ ] **Unit Math Tests:** Unit test with known inputs: 3 days of orders verify that multi-day AOV calculates correctly as ratio-of-sums, not average-of-averages.
- [ ] **Data Reconciliation:** Querying Net Sales for a real brand matches Shopify Admin within 0.1% (attributable only to defined tax/refund timing differences).
- [ ] **Tenant Isolation in Cache:** Calling the metrics endpoint for Workspace 1 and Workspace 2 with identical date ranges produces completely separate cached results; no data cross-pollination.
- [ ] **Stale Data Flagging:** If Shopify hasn't synced in 24 hours, `freshness` returns `"stale"`, prompting the UI to display a warning pill.
