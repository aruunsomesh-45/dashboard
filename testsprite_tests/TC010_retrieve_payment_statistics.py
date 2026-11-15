"""TC010: payment stats are derived from stored Razorpay payments only (no invented fees / splits / connection state)."""
from apps.commerce.models import PaymentAttempt


def test_empty_brand(api, ws):
    d = api.get(f"{ws.base}/payments/stats/").json()
    assert d["payment_count"] == 0 and d["total_captured_minor"] == 0 and d["method_splits"] == {}
    assert d["connected"] is False and d["authorized_rate"] is None
    assert api.get(f"{ws.base}/payments/transactions/").json() == []


def test_stats_match_stored_payments(api, ws):
    spec = [("captured", "upi", 100000), ("captured", "upi", 200000), ("captured", "card", 300000), ("failed", "card", 50000)]
    for i, (st, m, amt) in enumerate(spec):
        PaymentAttempt.objects.create(workspace=ws.workspace, brand_id=ws.brand_id, provider="razorpay", provider_id=f"tc10-{i}",
                                      amount_minor=amt, status=st, method=m)
    d = api.get(f"{ws.base}/payments/stats/").json()
    assert d["payment_count"] == 3 and d["attempt_count"] == 4
    assert d["total_captured_minor"] == 600000
    assert d["authorized_rate"] == 75.0
    assert d["method_splits"] == {"upi": 66.7, "card": 33.3}
    assert d["total_fees_minor"] is None  # fee data is not stored, so it is reported as unavailable
    tx = api.get(f"{ws.base}/payments/transactions/").json()
    assert sorted(t["id"] for t in tx) == [f"tc10-{i}" for i in range(4)]
