"""
Inbound webhook endpoints for external commerce and marketing providers:
Shopify, Razorpay, Shiprocket, and Meta Ads.

Security & Architecture:
- CSRF exempt (webhooks authenticate via provider cryptographic signatures/tokens, not sessions)
- Strict body size limit enforced at 1 MiB (HTTP 413)
- Timing-safe constant-time verification using hmac.compare_digest / secrets.compare_digest
- Signature verification strictly precedes any JSON body parsing (HTTP 401 before HTTP 400)
- Brand-scoped idempotent deduplication via WebhookEvent
- Async Celery task dispatch on transaction commit (transaction.on_commit)
- Zero credentials or signatures persisted in headers/logs
"""

import base64
import hashlib
import hmac
import json
import logging
import secrets

from django.db import transaction
from django.http import HttpResponse
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import csrf_exempt
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.integrations.crypto import decrypt_credentials
from apps.integrations.models import Integration, WebhookEvent
from apps.integrations.tasks import process_webhook_event_task
from apps.tenancy.models import Brand

logger = logging.getLogger(__name__)

MAX_BODY_SIZE = 1024 * 1024  # 1 MiB


@method_decorator(csrf_exempt, name="dispatch")
class BaseWebhookView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    slug: str = ""
    db_provider: str = ""
    event_id_header: str | None = None

    def verify_signature(self, request, brand: Brand, integration: Integration, creds: dict) -> bool:
        raise NotImplementedError

    def get_topic(self, request, body_data: dict) -> str:
        raise NotImplementedError

    def get_delivery_id(self, request, raw_body: bytes) -> str:
        if self.event_id_header:
            meta_key = self.event_id_header
            header_key = meta_key.replace("HTTP_", "").replace("_", "-").lower()
            header_val = (
                request.headers.get(header_key)
                if hasattr(request, "headers")
                else None
            ) or request.META.get(meta_key)
            if header_val:
                return str(header_val).strip()
        return "body_" + hashlib.sha256(raw_body).hexdigest()

    def post(self, request, brand_id):
        # 1. Enforce payload size limit (checked before database lookups / parsing)
        if len(request.body) > MAX_BODY_SIZE:
            return Response(
                {"error": "Payload size exceeds maximum allowed limit."},
                status=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            )

        # 2. Resolve Brand & Integration (404 for unknown, mismatched, or disconnected)
        try:
            brand = Brand.objects.select_related("workspace").only(
                "id", "workspace__id", "workspace__slug"
            ).get(id=brand_id)
            integration = Integration.objects.only(
                "id", "provider", "status", "account_identifier", "encrypted_credentials"
            ).get(
                brand=brand,
                provider=self.db_provider,
            )
        except (Brand.DoesNotExist, Integration.DoesNotExist, ValueError):
            return Response(
                {"error": f"Brand or {self.slug} integration not found."},
                status=status.HTTP_404_NOT_FOUND,
            )

        if integration.status != Integration.Status.CONNECTED:
            return Response(
                {"error": f"{self.slug} integration is disconnected."},
                status=status.HTTP_404_NOT_FOUND,
            )

        creds = decrypt_credentials(integration.encrypted_credentials or b"")

        # 3. Cryptographic signature and credential verification (must happen BEFORE body parsing)
        if not self.verify_signature(request, brand, integration, creds):
            logger.warning("Rejected %s webhook: authentication failed for brand %s", self.slug, brand.id)
            return Response(
                {"error": "Invalid signature or credentials."},
                status=status.HTTP_401_UNAUTHORIZED,
            )

        # 4. JSON body validation
        try:
            body_data = json.loads(request.body)
        except (ValueError, TypeError):
            return Response(
                {"error": "Malformed JSON payload."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if not isinstance(body_data, dict):
            return Response(
                {"error": "Expected JSON object payload."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # 5. Extract delivery ID and topic
        delivery_id = self.get_delivery_id(request, request.body)
        topic = self.get_topic(request, body_data)
        event_id = f"{self.slug}:{brand.id}:{delivery_id}"

        # Sanitize headers to never persist secrets or signatures
        headers_dict = (
            request.headers
            if hasattr(request, "headers") and request.headers
            else {k[5:].replace("_", "-").lower(): v for k, v in request.META.items() if k.startswith("HTTP_")}
        )
        sanitized_headers = {}
        for k, v in headers_dict.items():
            k_lower = k.lower()
            if not any(s in k_lower for s in ("signature", "api_key", "api-key", "hmac", "secret", "token", "authorization", "cookie")):
                sanitized_headers[k] = v

        # 6. Idempotent storage and transactional Celery enqueue on commit
        with transaction.atomic():
            event, created = WebhookEvent.objects.get_or_create(
                event_id=event_id,
                defaults={
                    "workspace": brand.workspace,
                    "brand": brand,
                    "provider": self.db_provider,
                    "topic": topic,
                    "raw_body": request.body.decode("utf-8"),
                    "headers": sanitized_headers,
                    "processed": False,
                },
            )
            if not created:
                return Response(
                    {"status": "duplicate", "message": "Event already processed."},
                    status=status.HTTP_200_OK,
                )

            transaction.on_commit(
                lambda: process_webhook_event_task.apply_async(args=[str(event.id)])
            )

        return Response(
            {"status": "accepted", "event_id": event.event_id},
            status=status.HTTP_200_OK,
        )


class ShopifyWebhookView(BaseWebhookView):
    slug = "shopify"
    db_provider = "shopify"
    event_id_header = "HTTP_X_SHOPIFY_WEBHOOK_ID"

    def verify_signature(self, request, brand: Brand, integration: Integration, creds: dict) -> bool:
        # 1. Shop domain verification
        shop_domain = (
            request.headers.get("x-shopify-shop-domain")
            if hasattr(request, "headers")
            else None
        ) or request.META.get("HTTP_X_SHOPIFY_SHOP_DOMAIN")
        if not shop_domain:
            logger.warning("Rejected shopify webhook: missing shop domain for brand %s", brand.id)
            return False

        expected_domain = creds.get("shop_domain") or integration.account_identifier or ""
        if not expected_domain:
            logger.warning("Rejected shopify webhook: no configured shop domain for brand %s", brand.id)
            return False

        if not secrets.compare_digest(str(shop_domain).strip().lower(), str(expected_domain).strip().lower()):
            logger.warning("Rejected shopify webhook: shop domain mismatch for brand %s", brand.id)
            return False

        # 2. Secret presence check
        api_secret = creds.get("api_secret") or creds.get("shared_secret")
        if not api_secret:
            logger.warning("Rejected shopify webhook: missing secret for brand %s", brand.id)
            return False

        # 3. HMAC header check
        hmac_val = (
            request.headers.get("x-shopify-hmac-sha256")
            if hasattr(request, "headers")
            else None
        ) or request.META.get("HTTP_X_SHOPIFY_HMAC_SHA256")
        if not hmac_val:
            logger.warning("Rejected shopify webhook: missing hmac header for brand %s", brand.id)
            return False

        digest = hmac.new(
            str(api_secret).encode("utf-8"),
            request.body,
            hashlib.sha256,
        ).digest()
        expected_b64 = base64.b64encode(digest).decode("utf-8")

        if not hmac.compare_digest(expected_b64, str(hmac_val).strip()):
            logger.warning("Rejected shopify webhook: invalid hmac signature for brand %s", brand.id)
            return False

        return True

    def get_topic(self, request, body_data: dict) -> str:
        return (
            (request.headers.get("x-shopify-topic") if hasattr(request, "headers") else None)
            or request.META.get("HTTP_X_SHOPIFY_TOPIC")
            or "orders/updated"
        )


class RazorpayWebhookView(BaseWebhookView):
    slug = "razorpay"
    db_provider = "razorpay"
    event_id_header = "HTTP_X_RAZORPAY_EVENT_ID"

    def verify_signature(self, request, brand: Brand, integration: Integration, creds: dict) -> bool:
        webhook_secret = creds.get("webhook_secret")
        if not webhook_secret:
            logger.warning("Rejected razorpay webhook: missing secret for brand %s", brand.id)
            return False

        sig_val = (
            request.headers.get("x-razorpay-signature")
            if hasattr(request, "headers")
            else None
        ) or request.META.get("HTTP_X_RAZORPAY_SIGNATURE")
        if not sig_val:
            logger.warning("Rejected razorpay webhook: missing signature header for brand %s", brand.id)
            return False

        expected_hex = hmac.new(
            str(webhook_secret).encode("utf-8"),
            request.body,
            hashlib.sha256,
        ).hexdigest()

        if not hmac.compare_digest(expected_hex, str(sig_val).strip()):
            logger.warning("Rejected razorpay webhook: invalid signature for brand %s", brand.id)
            return False

        return True

    def get_topic(self, request, body_data: dict) -> str:
        return body_data.get("event", "payment.captured")


class ShiprocketWebhookView(BaseWebhookView):
    slug = "shiprocket"
    db_provider = "shiprocket"
    event_id_header = None

    def verify_signature(self, request, brand: Brand, integration: Integration, creds: dict) -> bool:
        webhook_token = creds.get("webhook_token")
        if not webhook_token:
            logger.warning("Rejected shiprocket webhook: missing token for brand %s", brand.id)
            return False

        # Block tokens provided via query parameters or request body
        if "token" in request.GET or "x-api-key" in request.GET:
            logger.warning("Rejected shiprocket webhook: query parameter token not allowed for brand %s", brand.id)
            return False

        api_key = (
            request.headers.get("x-api-key")
            if hasattr(request, "headers")
            else None
        ) or request.META.get("HTTP_X_API_KEY")
        if not api_key:
            logger.warning("Rejected shiprocket webhook: missing api key header for brand %s", brand.id)
            return False

        if not secrets.compare_digest(str(api_key), str(webhook_token)):
            logger.warning("Rejected shiprocket webhook: invalid api key for brand %s", brand.id)
            return False

        return True

    def get_topic(self, request, body_data: dict) -> str:
        return body_data.get("current_status", "shipment_update")


class MetaWebhookView(BaseWebhookView):
    slug = "meta"
    db_provider = "meta_ads"
    event_id_header = None

    def get(self, request, brand_id):
        try:
            brand = Brand.objects.get(id=brand_id)
            integration = Integration.objects.get(
                brand=brand,
                provider=self.db_provider,
            )
        except (Brand.DoesNotExist, Integration.DoesNotExist, ValueError):
            return HttpResponse("Not found", status=status.HTTP_404_NOT_FOUND, content_type="text/plain")

        if integration.status != Integration.Status.CONNECTED:
            return HttpResponse("Disconnected", status=status.HTTP_404_NOT_FOUND, content_type="text/plain")

        creds = decrypt_credentials(integration.encrypted_credentials or b"")
        stored_verify = creds.get("verify_token")
        if not stored_verify:
            return HttpResponse("Forbidden", status=status.HTTP_403_FORBIDDEN, content_type="text/plain")

        mode = request.GET.get("hub.mode")
        challenge = request.GET.get("hub.challenge", "")
        token_in = request.GET.get("hub.verify_token")

        if not mode or not secrets.compare_digest(str(mode), "subscribe"):
            return HttpResponse("Invalid mode", status=status.HTTP_403_FORBIDDEN, content_type="text/plain")

        if not token_in or not secrets.compare_digest(str(token_in), str(stored_verify)):
            return HttpResponse("Forbidden", status=status.HTTP_403_FORBIDDEN, content_type="text/plain")

        return HttpResponse(challenge, status=200, content_type="text/plain")

    def verify_signature(self, request, brand: Brand, integration: Integration, creds: dict) -> bool:
        app_secret = creds.get("app_secret")
        if not app_secret:
            logger.warning("Rejected meta webhook: missing secret for brand %s", brand.id)
            return False

        hub_sig = (
            request.headers.get("x-hub-signature-256")
            if hasattr(request, "headers")
            else None
        ) or request.META.get("HTTP_X_HUB_SIGNATURE_256")
        if not hub_sig:
            logger.warning("Rejected meta webhook: missing signature header for brand %s", brand.id)
            return False

        hub_sig_str = str(hub_sig)
        if not hub_sig_str.startswith("sha256="):
            logger.warning("Rejected meta webhook: invalid signature format for brand %s", brand.id)
            return False

        incoming_hex = hub_sig_str[7:]
        expected_hex = hmac.new(
            str(app_secret).encode("utf-8"),
            request.body,
            hashlib.sha256,
        ).hexdigest()

        if not hmac.compare_digest(expected_hex, incoming_hex):
            logger.warning("Rejected meta webhook: invalid signature for brand %s", brand.id)
            return False

        return True

    def get_topic(self, request, body_data: dict) -> str:
        return body_data.get("object", "ad_account")
