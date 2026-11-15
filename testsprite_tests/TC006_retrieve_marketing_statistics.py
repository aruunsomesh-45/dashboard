"""TC006: /marketing/stats reports not-connected honestly, and when connected serves stored facts (no live call: recently synced)."""
from datetime import date, timedelta

from django.utils import timezone

from apps.analytics.models import FactAdsDaily
from apps.integrations.models import Integration


def test_not_connected_brand(api, ws):
    r = api.get(f"{ws.base}/marketing/stats/")
    assert r.status_code == 200
    d = r.json()
    assert d["connected"] is False and d["campaigns"] == [] and d["daily_trends"] == [] and d["summary_30d"] is None


def test_connected_brand_serves_stored_facts(api, ws):
    # last_synced_at = now => the view serves stored facts and does NOT call the Meta Graph API.
    Integration.objects.create(workspace=ws.workspace, brand_id=ws.brand_id, provider="meta_ads", status="connected",
                               account_identifier="act_tc", last_synced_at=timezone.now())
    spend = [100000, 200000, 300000]
    for i, s in enumerate(spend):
        FactAdsDaily.objects.create(workspace=ws.workspace, brand_id=ws.brand_id, fact_date=date.today() - timedelta(days=i),
                                    spend_minor=s, impressions=1000, clicks=50, attributed_conversions=2 + i,
                                    attributed_revenue_minor=s * 4)
    d = api.get(f"{ws.base}/marketing/stats/").json()
    assert d["connected"] is True
    s30 = d["summary_30d"]
    assert s30["spend_minor"] == sum(spend)
    assert s30["orders"] == 2 + 3 + 4
    assert s30["roas"] == 4.0
    assert len(d["daily_trends"]) == 3
