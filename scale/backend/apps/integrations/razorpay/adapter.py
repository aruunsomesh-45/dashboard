import hashlib
import hmac
from typing import Any

from apps.integrations.base import ProviderAdapter
from apps.integrations.crypto import decrypt_credentials


class RazorpayAdapter(ProviderAdapter):
    """
    Razorpay Provider Adapter:
    - HMAC-SHA256 signature verification on X-Razorpay-Signature
    - Normalizes payments, refunds, and payment methods
    - Amounts are already integer paise from Razorpay API
    """

    def get_auth_url(self, state: str) -> str:
        raise NotImplementedError("Razorpay uses Webhook secrets and API keys, not customer OAuth.")

    def exchange_code(self, code: str) -> dict[str, Any]:
        raise NotImplementedError("Razorpay uses direct API credentials.")

    def verify_webhook(self, headers: dict[str, str], raw_body: bytes) -> bool:
        signature = headers.get("X-Razorpay-Signature") or headers.get("x-razorpay-signature")
        if not signature:
            return False

        creds = decrypt_credentials(self.integration.encrypted_credentials)
        webhook_secret = creds.get("webhook_secret") or creds.get("api_secret", "")
        if not webhook_secret:
            return False

        expected = hmac.new(
            webhook_secret.encode("utf-8"),
            raw_body,
            hashlib.sha256,
        ).hexdigest()

        return hmac.compare_digest(signature, expected)

    def normalize_order(self, raw_payload: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError("Use normalize_payment for Razorpay payloads.")

    def normalize_payment(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(payload, dict):
            return {}
        entity = payload.get("entity") if isinstance(payload.get("entity"), dict) else payload
        status_map = {
            "authorized": "authorized",
            "captured": "captured",
            "failed": "failed",
            "refunded": "refunded",
        }
        method_map = {
            "card": "card",
            "upi": "upi",
            "netbanking": "netbanking",
            "wallet": "wallet",
        }

        raw_status = entity.get("status", "authorized")
        canonical_status = status_map.get(raw_status, "authorized")

        raw_method = entity.get("method", "other")
        canonical_method = method_map.get(raw_method, "other")

        return {
            "provider": "razorpay",
            "provider_id": entity.get("id", ""),
            "amount_minor": entity.get("amount", 0),  # Razorpay amounts are ALREADY in paise
            "currency": entity.get("currency", "INR"),
            "status": canonical_status,
            "method": canonical_method,
            "gateway_order_id": entity.get("order_id") or "",
            "error_code": entity.get("error_code") or "",
            "error_description": entity.get("error_description") or "",
        }
