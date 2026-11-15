from datetime import datetime, timezone as dt_timezone
import logging
from django.db import transaction
from django.utils import timezone

from apps.commerce.models import Order, OrderPaymentLink, PaymentAttempt
from apps.integrations.models import Integration
from apps.integrations.razorpay.adapter import RazorpayAdapter

logger = logging.getLogger(__name__)


def ingest_razorpay_payment(brand, raw_payload: dict) -> PaymentAttempt:
    """
    Ingests a Razorpay payment webhook payload and reconciles it deterministically with Canonical Order.
    Rules:
    - Normalizes status, method, and amounts (already in integer paise).
    - Links to Order IF AND ONLY IF notes.shopify_order_id matches an existing Order.
    - Two orders of identical amount at the same minute must NOT cross-link.
    - Payments without a deterministic key remain in the unlinked bucket.
    """
    integration = Integration.objects.filter(brand=brand, provider=Integration.Provider.RAZORPAY).first()
    adapter = RazorpayAdapter(integration)

    # Extract payment entity safely
    payload_obj = raw_payload.get("payload") if isinstance(raw_payload.get("payload"), dict) else {}
    payment_obj = payload_obj.get("payment") if isinstance(payload_obj.get("payment"), dict) else {}
    if isinstance(payment_obj.get("entity"), dict):
        entity = payment_obj["entity"]
    elif isinstance(raw_payload.get("entity"), dict):
        entity = raw_payload["entity"]
    else:
        entity = raw_payload

    norm = adapter.normalize_payment(entity)

    # Extract created_at timestamp
    created_at_epoch = entity.get("created_at")
    source_created_at = (
        datetime.fromtimestamp(created_at_epoch, tz=dt_timezone.utc)
        if created_at_epoch
        else timezone.now()
    )

    notes = entity.get("notes") or {}
    shopify_order_id = str(
        notes.get("shopify_order_id") or notes.get("Shopify_Order_Id") or notes.get("shopify_order") or ""
    ).strip()

    with transaction.atomic():
        payment, _ = PaymentAttempt.objects.update_or_create(
            workspace=brand.workspace,
            brand=brand,
            provider="razorpay",
            provider_id=norm["provider_id"],
            defaults={
                "amount_minor": norm["amount_minor"],
                "currency": norm.get("currency", "INR"),
                "status": norm["status"],
                "method": norm["method"],
                "gateway_order_id": norm.get("gateway_order_id", ""),
                "error_code": norm.get("error_code", ""),
                "error_description": norm.get("error_description", ""),
                "source_created_at": source_created_at,
            },
        )

        # Deterministic reconciliation
        if shopify_order_id:
            order = Order.objects.filter(
                brand=brand,
                provider="shopify",
                provider_id=shopify_order_id,
            ).first()
            if order:
                OrderPaymentLink.objects.update_or_create(
                    order=order,
                    payment_attempt=payment,
                    defaults={
                        "match_method": "notes.shopify_order_id",
                        "confidence": 1.0,
                    },
                )
                logger.info(
                    "Linked Razorpay payment %s to Order %s via notes.shopify_order_id",
                    payment.provider_id,
                    order.provider_id,
                )
            else:
                logger.warning(
                    "Razorpay payment %s has shopify_order_id %s which does not exist; remains unlinked",
                    payment.provider_id,
                    shopify_order_id,
                )
        else:
            logger.info(
                "Razorpay payment %s has no deterministic key; kept in unlinked bucket",
                payment.provider_id,
            )

    return payment
