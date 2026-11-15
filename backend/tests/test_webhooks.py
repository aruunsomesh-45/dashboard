"""Webhook security + idempotency (Shopify + Razorpay). No network: all processing is local."""
import base64
import hashlib
import hmac
import json

import pytest
from rest_framework.test import APIClient

from apps.commerce.models import Order, PaymentAttempt
from apps.integrations.crypto import encrypt_credentials
from apps.integrations.models import Integration, WebhookEvent

SHOPIFY_SECRET = "shopify-test-secret"
RZP_SECRET = "razorpay-test-secret"


def shopify_sig(body: bytes, secret=SHOPIFY_SECRET):
    return base64.b64encode(hmac.new(secret.encode(), body, hashlib.sha256).digest()).decode()


def rzp_sig(body: bytes, secret=RZP_SECRET):
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


@pytest.fixture
def shopify_integration(workspace_a, brand_a):
    return Integration.objects.create(
        workspace=workspace_a, brand=brand_a, provider="shopify", status="connected",
        encrypted_credentials=encrypt_credentials({"api_secret": SHOPIFY_SECRET}),
    )


@pytest.fixture
def rzp_integration(workspace_a, brand_a):
    return Integration.objects.create(
        workspace=workspace_a, brand=brand_a, provider="razorpay", status="connected",
        encrypted_credentials=encrypt_credentials({"webhook_secret": RZP_SECRET}),
    )


ORDER = {
    "id": 5551234, "order_number": 1042, "name": "#1042", "currency": "INR",
    "total_line_items_price": "1499.00", "total_discounts": "0.00", "total_tax": "0.00",
    "financial_status": "paid", "fulfillment_status": None,
    "created_at": "2026-11-01T10:00:00+05:30", "updated_at": "2026-11-01T10:05:00+05:30",
    "line_items": [{"id": 1, "title": "Ring", "quantity": 1, "price": "1499.00"}],
}


@pytest.mark.django_db
class TestShopifyWebhook:
    def url(self, brand):
        return f"/api/webhooks/shopify/{brand.id}/"

    def post(self, brand, body, sig=None, webhook_id="wh-1"):
        headers = {"HTTP_X_SHOPIFY_TOPIC": "orders/create", "HTTP_X_SHOPIFY_WEBHOOK_ID": webhook_id}
        if sig is not None:
            headers["HTTP_X_SHOPIFY_HMAC_SHA256"] = sig
        return APIClient().post(self.url(brand), data=body, content_type="application/json", **headers)

    def test_valid_signature_processes_order(self, brand_a, shopify_integration):
        body = json.dumps(ORDER).encode()
        res = self.post(brand_a, body, shopify_sig(body))
        assert res.status_code == 200, res.content
        assert Order.objects.filter(brand=brand_a, provider_id="5551234").count() == 1

    def test_missing_signature_is_401(self, brand_a, shopify_integration):
        body = json.dumps(ORDER).encode()
        res = self.post(brand_a, body, sig=None)
        assert res.status_code == 401
        assert not Order.objects.exists() and not WebhookEvent.objects.exists()

    def test_tampered_payload_is_401(self, brand_a, shopify_integration):
        body = json.dumps(ORDER).encode()
        sig = shopify_sig(body)
        tampered = json.dumps({**ORDER, "total_line_items_price": "1.00"}).encode()
        res = self.post(brand_a, tampered, sig)
        assert res.status_code == 401
        assert not Order.objects.exists()

    def test_wrong_secret_is_401(self, brand_a, shopify_integration):
        body = json.dumps(ORDER).encode()
        assert self.post(brand_a, body, shopify_sig(body, "attacker-secret")).status_code == 401

    def test_same_event_twice_processed_once(self, brand_a, shopify_integration):
        body = json.dumps(ORDER).encode()
        sig = shopify_sig(body)
        r1 = self.post(brand_a, body, sig, webhook_id="wh-dup")
        r2 = self.post(brand_a, body, sig, webhook_id="wh-dup")
        assert (r1.status_code, r2.status_code) == (200, 200)
        assert r2.json()["status"] == "duplicate"
        assert WebhookEvent.objects.filter(provider="shopify").count() == 1
        assert Order.objects.filter(brand=brand_a).count() == 1

    def test_same_body_without_webhook_id_is_still_idempotent(self, brand_a, shopify_integration):
        body = json.dumps(ORDER).encode()
        sig = shopify_sig(body)
        headers = {"HTTP_X_SHOPIFY_HMAC_SHA256": sig, "HTTP_X_SHOPIFY_TOPIC": "orders/create"}
        for _ in range(2):
            APIClient().post(self.url(brand_a), data=body, content_type="application/json", **headers)
        assert WebhookEvent.objects.count() == 1

    def test_signature_headers_are_not_persisted(self, brand_a, shopify_integration):
        body = json.dumps(ORDER).encode()
        self.post(brand_a, body, shopify_sig(body))
        stored = json.dumps(WebhookEvent.objects.get().headers).lower()
        assert "hmac" not in stored and "authorization" not in stored


@pytest.mark.django_db
class TestRazorpayWebhook:
    def url(self, brand):
        return f"/api/webhooks/razorpay/{brand.id}/"

    def body(self, pay_id="pay_ABC123", status="captured"):
        return json.dumps({
            "event": "payment.captured",
            "payload": {"payment": {"entity": {
                "id": pay_id, "amount": 149900, "currency": "INR", "status": status,
                "method": "upi", "order_id": "order_XYZ", "created_at": 1790000000,
            }}},
        }).encode()

    def post(self, brand, body, sig=None, event_id="evt_1"):
        headers = {"HTTP_X_RAZORPAY_EVENT_ID": event_id}
        if sig is not None:
            headers["HTTP_X_RAZORPAY_SIGNATURE"] = sig
        return APIClient().post(self.url(brand), data=body, content_type="application/json", **headers)

    def test_valid_signature_creates_payment(self, brand_a, rzp_integration):
        body = self.body()
        res = self.post(brand_a, body, rzp_sig(body))
        assert res.status_code == 200, res.content
        p = PaymentAttempt.objects.get(brand=brand_a, provider_id="pay_ABC123")
        assert (p.amount_minor, p.status, p.method) == (149900, "captured", "upi")

    def test_missing_signature_is_401(self, brand_a, rzp_integration):
        assert self.post(brand_a, self.body(), sig=None).status_code == 401
        assert not PaymentAttempt.objects.exists()

    def test_tampered_payload_is_401(self, brand_a, rzp_integration):
        good = self.body()
        sig = rzp_sig(good)
        tampered = self.body(pay_id="pay_EVIL")
        assert self.post(brand_a, tampered, sig).status_code == 401
        assert not PaymentAttempt.objects.exists()

    def test_wrong_secret_is_401(self, brand_a, rzp_integration):
        body = self.body()
        assert self.post(brand_a, body, rzp_sig(body, "attacker")).status_code == 401

    def test_integration_without_secret_rejects_everything(self, workspace_a, brand_a):
        Integration.objects.create(workspace=workspace_a, brand=brand_a, provider="razorpay", status="connected")
        body = self.body()
        # Empty-secret HMAC must never be accepted.
        assert self.post(brand_a, body, rzp_sig(body, "")).status_code == 401

    def test_same_event_twice_processed_once(self, brand_a, rzp_integration):
        body = self.body()
        sig = rzp_sig(body)
        r1 = self.post(brand_a, body, sig, event_id="evt_dup")
        r2 = self.post(brand_a, body, sig, event_id="evt_dup")
        assert r1.status_code == 200 and r2.json()["status"] == "duplicate"
        assert PaymentAttempt.objects.filter(brand=brand_a).count() == 1
        assert WebhookEvent.objects.filter(provider="razorpay").count() == 1

    def test_webhook_for_other_brand_cannot_write_here(self, workspace_a, brand_a, workspace_b, brand_b, rzp_integration):
        """A payload signed with brand A's secret, sent to brand B's URL, is rejected."""
        Integration.objects.create(workspace=workspace_b, brand=brand_b, provider="razorpay", status="connected",
                                   encrypted_credentials=encrypt_credentials({"webhook_secret": "b-secret"}))
        body = self.body()
        res = self.post(brand_b, body, rzp_sig(body, RZP_SECRET))
        assert res.status_code == 401
        assert not PaymentAttempt.objects.filter(brand=brand_b).exists()


@pytest.mark.django_db
def test_delhivery_webhook_is_not_a_fake_accept(brand_a):
    res = APIClient().post(f"/api/webhooks/delhivery/{brand_a.id}/", {"awb": "X"}, format="json")
    assert res.status_code == 501
