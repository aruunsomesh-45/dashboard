"""TC004: /shopify/intelligence returns integer-paise metrics that equal what is actually stored; empty brand => zeros."""
from datetime import timedelta

from django.utils import timezone

from apps.commerce.models import Order


def test_empty_brand_is_zero_not_sample_data(api, ws):
    r = api.get(f"{ws.base}/shopify/intelligence/")
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["orders"] == [] and d["order_items"] == []
    assert d["metrics"]["order_count"] == 0 and d["metrics"]["gross_sales_minor"] == 0


def test_metrics_match_stored_orders(api, ws):
    now = timezone.now()
    rows = [(100000, 90000, "paid"), (250000, 225000, "paid"), (50000, 45000, "pending")]
    for i, (gross, net, fin) in enumerate(rows):
        Order.objects.create(workspace=ws.workspace, brand_id=ws.brand_id, provider="shopify", provider_id=f"tc4-{i}",
                             order_number=f"TC4-{i}", gross_amount=gross, net_sales=net, financial_status=fin,
                             source_created_at=now - timedelta(days=i))
    d = api.get(f"{ws.base}/shopify/intelligence/?days=30").json()
    m = d["metrics"]
    assert m["order_count"] == 3
    assert m["gross_sales_minor"] == sum(r[0] for r in rows) and m["net_sales_minor"] == sum(r[1] for r in rows)
    assert m["aov_minor"] == round(sum(r[1] for r in rows) / 3)
    for key in ("gross_sales_minor", "net_sales_minor", "aov_minor", "order_count"):
        assert isinstance(m[key], int) and not isinstance(m[key], bool) and m[key] >= 0
    assert d["funnel"]["placed"] == 3 and d["funnel"]["paid"] == 2
    assert {o["order_number"] for o in d["orders"]} == {"TC4-0", "TC4-1", "TC4-2"}
