"""
Reliable Background Ingestion and Webhook Job Processing for 125 EAST
Features:
- Decoupled asynchronous order ingestion
- Exponential backoff retry mechanism (up to 5 attempts)
- Idempotent execution preventing duplicate processing
- Automated tenant cache invalidation upon completion
"""

import json
import logging
from celery import shared_task
from django.db import transaction
from django.utils import timezone

logger = logging.getLogger(__name__)


def process_webhook_event(event_id: str) -> bool:
    """
    Idempotently process a recorded webhook event. Safe to call twice: processed events are skipped.
    Raises on failure so callers (Celery retry / the webhook view) can react.
    """
    from apps.integrations.models import WebhookEvent
    from apps.integrations.shopify.service import ingest_shopify_order
    from apps.integrations.razorpay.service import ingest_razorpay_payment
    from apps.integrations.logistics.service import ingest_shiprocket_tracking
    from apps.analytics.cache import invalidate_brand_cache

    try:
        event = WebhookEvent.objects.select_related("brand", "workspace").get(id=event_id)
    except WebhookEvent.DoesNotExist:
        logger.error("[WEBHOOK WORKER] Event %s does not exist.", event_id)
        return False

    if event.processed:
        logger.info("[WEBHOOK WORKER] Event %s already processed. Skipping.", event_id)
        return True

    try:
        raw_payload = json.loads(event.raw_body)
        with transaction.atomic():
            if event.provider == "shopify" and event.topic.startswith("orders/"):
                ingest_shopify_order(event.brand, raw_payload)
            elif event.provider == "razorpay":
                ingest_razorpay_payment(event.brand, raw_payload)
            elif event.provider == "shiprocket":
                ingest_shiprocket_tracking(event.brand, raw_payload)
            event.processed = True
            event.processed_at = timezone.now()
            event.error = ""
            event.save(update_fields=["processed", "processed_at", "error"])
    except Exception as exc:
        event.error = str(exc)[:1000]
        event.save(update_fields=["error"])
        raise

    invalidate_brand_cache(event.workspace.slug, str(event.brand.id))
    logger.info("[WEBHOOK WORKER] Processed event %s (topic=%s)", event.event_id, event.topic)
    return True


@shared_task(
    bind=True,
    max_retries=5,
    default_retry_delay=10,
    autoretry_for=(Exception,),
    retry_backoff=True,
    retry_backoff_max=300,
    retry_jitter=True,
)
def process_webhook_event_task(self, event_id: str):
    """Celery wrapper with exponential-backoff retries (use when a broker is available)."""
    return process_webhook_event(event_id)
