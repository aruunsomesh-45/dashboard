"""TC008: logistics summary/shipments are computed from stored shipments; an empty brand shows zero, not demo numbers."""
from datetime import timedelta

from django.utils import timezone

from apps.commerce.models import Shipment


def test_empty_brand(api, ws):
    d = api.get(f"{ws.base}/logistics/summary/").json()
    assert d["total_shipments"] == 0 and d["ndr_count"] == 0 and d["delivered_count"] == 0
    assert d["ndr_rate_percentage"] is None
    assert api.get(f"{ws.base}/logistics/shipments/").json() == []
    assert api.get(f"{ws.base}/logistics/track/DEL10398472910/").status_code == 404


def test_summary_matches_stored_shipments(api, ws):
    now = timezone.now()
    spec = ["delivered", "delivered", "delivered", "in_transit", "ndr", "rto_initiated"]
    for i, st in enumerate(spec):
        Shipment.objects.create(workspace=ws.workspace, brand_id=ws.brand_id, provider="delhivery", provider_id=f"tc8-{i}",
                                awb=f"TC8AWB{i}", canonical_status=st, shipped_at=now - timedelta(days=4),
                                delivered_at=(now - timedelta(days=2)) if st == "delivered" else None)
    d = api.get(f"{ws.base}/logistics/summary/").json()
    assert d["total_shipments"] == 6 and d["delivered_count"] == 3 and d["in_transit_count"] == 1 and d["ndr_count"] == 1
    assert d["ndr_rate_percentage"] == round(100 / 6, 2) and d["rto_rate_percentage"] == round(100 / 6, 2)
    assert d["avg_delivery_days"] == 2.0
    ships = api.get(f"{ws.base}/logistics/shipments/").json()
    assert {s["awb"] for s in ships} == {f"TC8AWB{i}" for i in range(6)}
