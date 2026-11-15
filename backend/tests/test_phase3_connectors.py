import pytest
from apps.commerce.models import (
    CanonicalShipmentStatus,
    Order,
    OrderPaymentLink,
    PaymentAttempt,
)
from apps.integrations.crypto import encrypt_credentials
from apps.integrations.logistics.status_map import map_logistics_status
from apps.integrations.models import Integration
from apps.integrations.razorpay.adapter import RazorpayAdapter


@pytest.mark.django_db
class TestPhase3Connectors:
    def test_razorpay_webhook_hmac_verification(self, workspace_a, brand_a):
        integ = Integration.objects.create(
            workspace=workspace_a,
            brand=brand_a,
            provider=Integration.Provider.RAZORPAY,
            encrypted_credentials=encrypt_credentials({"webhook_secret": "secure_rzp_secret_123"}),
        )

        adapter = RazorpayAdapter(integ)
        body = b'{"event":"payment.captured","payload":{}}'

        # Valid signature
        import hashlib
        import hmac

        valid_sig = hmac.new(b"secure_rzp_secret_123", body, hashlib.sha256).hexdigest()
        assert adapter.verify_webhook({"X-Razorpay-Signature": valid_sig}, body) is True

        # Invalid signature
        assert adapter.verify_webhook({"X-Razorpay-Signature": "wrong_signature"}, body) is False

    def test_multi_payment_linking_to_single_order(self, workspace_a, brand_a):
        order = Order.objects.create(
            workspace=workspace_a,
            brand=brand_a,
            provider="shopify",
            provider_id="sh_ord_999",
            order_number="ORD-999",
            gross_amount=149900,
            net_sales=149900,
        )

        # 1st attempt: Failed UPI
        failed_pay = PaymentAttempt.objects.create(
            workspace=workspace_a,
            brand=brand_a,
            provider="razorpay",
            provider_id="pay_fail_01",
            amount_minor=149900,
            status=PaymentAttempt.Status.FAILED,
            method=PaymentAttempt.Method.UPI,
            error_code="BAD_REQUEST_ERROR",
        )
        OrderPaymentLink.objects.create(
            order=order,
            payment_attempt=failed_pay,
            match_method="notes_order_id",
            confidence=1.0,
        )

        # 2nd attempt: Successful Card capture
        success_pay = PaymentAttempt.objects.create(
            workspace=workspace_a,
            brand=brand_a,
            provider="razorpay",
            provider_id="pay_succ_02",
            amount_minor=149900,
            status=PaymentAttempt.Status.CAPTURED,
            method=PaymentAttempt.Method.CARD,
        )
        OrderPaymentLink.objects.create(
            order=order,
            payment_attempt=success_pay,
            match_method="notes_order_id",
            confidence=1.0,
        )

        # Verify 1 order has exactly 2 linked payment attempts
        assert order.payment_links.count() == 2
        statuses = set(link.payment_attempt.status for link in order.payment_links.all())
        assert statuses == {PaymentAttempt.Status.FAILED, PaymentAttempt.Status.CAPTURED}

    def test_logistics_status_mapping_and_safe_fallback(self):
        # Known status codes
        assert map_logistics_status("DEL") == CanonicalShipmentStatus.DELIVERED
        assert map_logistics_status("RAD") == CanonicalShipmentStatus.OUT_FOR_DELIVERY
        assert map_logistics_status("19") == CanonicalShipmentStatus.NDR
        assert map_logistics_status("14") == CanonicalShipmentStatus.RTO_DELIVERED

        # Unknown cryptic code should gracefully fallback to IN_TRANSIT without crashing
        assert map_logistics_status("UNKNOWN_SPECIAL_STATUS_XYZ") == CanonicalShipmentStatus.IN_TRANSIT
