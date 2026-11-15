"""
TC009: NDR action. The backend is configured (DELHIVERY_BASE_URL) to talk to the LOCAL stub, so we can prove exactly what
would be sent to Delhivery without any live traffic.
"""
from apps.commerce.models import Shipment
from apps.integrations.crypto import encrypt_credentials
from apps.integrations.models import Integration


def _seed(ws, awb="TC9AWB1", status="ndr", connect=True):
    s = Shipment.objects.create(workspace=ws.workspace, brand_id=ws.brand_id, provider="delhivery", provider_id=awb, awb=awb,
                                canonical_status=status, ndr_count=1)
    if connect and not Integration.objects.filter(brand_id=ws.brand_id, provider="delhivery").exists():
        Integration.objects.create(workspace=ws.workspace, brand_id=ws.brand_id, provider="delhivery", status="connected",
                                   encrypted_credentials=encrypt_credentials({"api_token": "tc-stub-token"}))
    return s


def test_reattempt_sends_one_instruction_to_courier_then_updates(api, ws, delhivery_stub):
    s = _seed(ws)
    delhivery_stub.requests.clear()
    r = api.post(f"{ws.base}/logistics/ndr/{s.awb}/action/", json={"action": "reattempt"})
    assert r.status_code == 200, r.text
    assert delhivery_stub.requests == [
        {"path": "/api/p/update", "auth": "Token tc-stub-token", "json": {"data": [{"waybill": "TC9AWB1", "act": "RE-ATTEMPT"}]}}
    ]
    s.refresh_from_db()
    assert s.canonical_status == "in_transit"


def test_invalid_action_unknown_awb_and_wrong_state_send_nothing(api, ws, delhivery_stub):
    s = _seed(ws)
    delhivery_stub.requests.clear()
    assert api.post(f"{ws.base}/logistics/ndr/{s.awb}/action/", json={"action": "explode"}).status_code == 400
    assert api.post(f"{ws.base}/logistics/ndr/DEL10398472910/action/", json={"action": "reattempt"}).status_code == 404
    assert api.post(f"{ws.base}/logistics/ndr/{s.awb}/action/", json={"action": "return_to_origin"}).status_code == 501
    Shipment.objects.filter(id=s.id).update(canonical_status="delivered")
    assert api.post(f"{ws.base}/logistics/ndr/{s.awb}/action/", json={"action": "reattempt"}).status_code == 409
    assert delhivery_stub.requests == [], "an instruction reached the courier for an invalid request"


def test_without_connected_courier_nothing_is_sent(api, ws, delhivery_stub):
    s = _seed(ws, connect=False)
    delhivery_stub.requests.clear()
    r = api.post(f"{ws.base}/logistics/ndr/{s.awb}/action/", json={"action": "reattempt"})
    assert r.status_code == 409 and delhivery_stub.requests == []
    s.refresh_from_db()
    assert s.canonical_status == "ndr"
