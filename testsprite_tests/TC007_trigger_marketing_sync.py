"""
TC007: marketing sync-now. Never contacts Meta: only local-failure paths are exercised.
  * no integration => 404
  * blank credentials in body => 400 (validated before any upstream call)
  * the old `mock=true` simulation switch no longer fabricates a success
"""
from apps.integrations.crypto import encrypt_credentials
from apps.integrations.models import Integration


def test_no_integration_is_404(api, ws):
    assert api.post(f"{ws.base}/marketing/sync-now/").status_code == 404


def test_blank_credentials_are_rejected_before_any_upstream_call(api, ws):
    Integration.objects.create(workspace=ws.workspace, brand_id=ws.brand_id, provider="meta_ads", status="connected",
                               encrypted_credentials=encrypt_credentials({"access_token": "x"}))
    assert api.post(f"{ws.base}/marketing/sync-now/", json={"access_token": "   "}).status_code == 400
    assert api.post(f"{ws.base}/marketing/sync-now/", json={"ad_account_id": ""}).status_code == 400


def test_mock_flag_cannot_fake_success(api, ws):
    # The integration has no token at all, so the real sync path fails fast locally with a validation error.
    Integration.objects.create(workspace=ws.workspace, brand_id=ws.brand_id, provider="meta_ads", status="connected",
                               encrypted_credentials=b"")
    r = api.post(f"{ws.base}/marketing/sync-now/?mock=true", json={"mock": True})
    assert r.status_code in (400, 502), r.text
    assert "simulated" not in r.text and r.json().get("status") != "success"
