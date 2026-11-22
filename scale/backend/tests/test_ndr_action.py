"""NDR action safety. DelhiveryClient._post is ALWAYS patched; a guard fails the test if anything reaches the network."""
from unittest import mock

import pytest
import requests

from apps.commerce.models import CanonicalShipmentStatus, Shipment
from apps.integrations.crypto import encrypt_credentials
from apps.integrations.delhivery.client import DelhiveryError
from apps.integrations.models import Integration
from apps.tenancy.models import WorkspaceMember
from tests.conftest import User


@pytest.fixture(autouse=True)
def no_network():
    with mock.patch.object(requests.sessions.Session, "request", side_effect=AssertionError("network call attempted")):
        yield


@pytest.fixture
def ndr(workspace_a, brand_a, user_a):
    s = Shipment.objects.create(workspace=workspace_a, brand=brand_a, provider="delhivery", provider_id="s1",
                                awb="AWB-TEST-1", canonical_status=CanonicalShipmentStatus.NDR, ndr_count=1)
    Integration.objects.create(workspace=workspace_a, brand=brand_a, provider="delhivery", status="connected",
                               encrypted_credentials=encrypt_credentials({"api_token": "test-token"}))
    return s


def url(ws, brand, awb):
    return f"/api/w/{ws.slug}/b/{brand.id}/logistics/ndr/{awb}/action/"


@pytest.mark.django_db
class TestNdrAction:
    def test_reattempt_calls_courier_then_updates_status(self, client_for, user_a, workspace_a, brand_a, ndr):
        with mock.patch("apps.integrations.delhivery.client.DelhiveryClient._post", return_value={"request_id": "r1"}) as post:
            res = client_for(user_a).post(url(workspace_a, brand_a, ndr.awb), {"action": "reattempt"}, format="json")
        assert res.status_code == 200
        post.assert_called_once_with("/api/p/update", {"data": [{"waybill": "AWB-TEST-1", "act": "RE-ATTEMPT"}]})
        ndr.refresh_from_db()
        assert ndr.canonical_status == "in_transit"

    def test_courier_failure_leaves_local_state_unchanged(self, client_for, user_a, workspace_a, brand_a, ndr):
        with mock.patch("apps.integrations.delhivery.client.DelhiveryClient._post", side_effect=DelhiveryError("boom")):
            res = client_for(user_a).post(url(workspace_a, brand_a, ndr.awb), {"action": "reattempt"}, format="json")
        assert res.status_code == 502
        ndr.refresh_from_db()
        assert ndr.canonical_status == "ndr"

    def test_without_integration_nothing_is_sent_or_changed(self, client_for, user_a, workspace_a, brand_a, ndr):
        Integration.objects.filter(provider="delhivery").delete()
        with mock.patch("apps.integrations.delhivery.client.DelhiveryClient._post") as post:
            res = client_for(user_a).post(url(workspace_a, brand_a, ndr.awb), {"action": "reattempt"}, format="json")
        assert res.status_code == 409 and not post.called
        ndr.refresh_from_db()
        assert ndr.canonical_status == "ndr"

    def test_unknown_awb_is_404_not_fabricated_success(self, client_for, user_a, workspace_a, brand_a, ndr):
        with mock.patch("apps.integrations.delhivery.client.DelhiveryClient._post") as post:
            res = client_for(user_a).post(url(workspace_a, brand_a, "DEL10398472910"), {"action": "reattempt"}, format="json")
        assert res.status_code == 404 and not post.called

    def test_non_ndr_shipment_is_rejected(self, client_for, user_a, workspace_a, brand_a, ndr):
        Shipment.objects.filter(id=ndr.id).update(canonical_status="delivered")
        with mock.patch("apps.integrations.delhivery.client.DelhiveryClient._post") as post:
            res = client_for(user_a).post(url(workspace_a, brand_a, ndr.awb), {"action": "reattempt"}, format="json")
        assert res.status_code == 409 and not post.called

    def test_viewer_cannot_trigger_courier_instruction(self, client_for, workspace_a, brand_a, ndr):
        viewer = User.objects.create_user(email="viewer@a.test", password="x-Secure-Pass-3")
        WorkspaceMember.objects.create(workspace=workspace_a, user=viewer, role="viewer")
        with mock.patch("apps.integrations.delhivery.client.DelhiveryClient._post") as post:
            res = client_for(viewer).post(url(workspace_a, brand_a, ndr.awb), {"action": "reattempt"}, format="json")
        assert res.status_code == 403 and not post.called

    def test_rto_is_explicitly_unsupported(self, client_for, user_a, workspace_a, brand_a, ndr):
        with mock.patch("apps.integrations.delhivery.client.DelhiveryClient._post") as post:
            res = client_for(user_a).post(url(workspace_a, brand_a, ndr.awb), {"action": "return_to_origin"}, format="json")
        assert res.status_code == 501 and not post.called

    def test_invalid_action_400(self, client_for, user_a, workspace_a, brand_a, ndr):
        res = client_for(user_a).post(url(workspace_a, brand_a, ndr.awb), {"action": "explode"}, format="json")
        assert res.status_code == 400
