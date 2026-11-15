"""
TC005: Shopify sync-now. Black-box tests must not contact Shopify, so only the paths that never leave the
machine are exercised here (successful sync with a mocked upstream is covered in backend/tests).
  * no integration configured => 400, never a fabricated "success"
  * unauthenticated => rejected
  * viewer role cannot trigger a sync
"""
import requests

from apps.accounts.models import User
from apps.tenancy.models import WorkspaceMember
from conftest import BASE_URL, Api


def test_sync_without_integration_is_an_error_not_a_fake_success(api, ws):
    r = api.post(f"{ws.base}/shopify/sync-now/")
    assert r.status_code == 400, r.text
    body = r.json()
    assert "records_processed" not in body and body.get("status") != "success"


def test_sync_requires_authentication(ws):
    r = requests.post(f"{BASE_URL}{ws.base}/shopify/sync-now/", timeout=30)
    assert r.status_code in (401, 403, 404)


def test_viewer_cannot_trigger_sync(ws):
    viewer = User.objects.create(email="tc5-viewer@tc.test")
    WorkspaceMember.objects.create(workspace=ws.workspace, user=viewer, role="viewer")
    try:
        assert Api(viewer).post(f"{ws.base}/shopify/sync-now/").status_code == 403
    finally:
        viewer.delete()
