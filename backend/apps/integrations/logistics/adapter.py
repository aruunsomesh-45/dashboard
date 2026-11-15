from typing import Any

from apps.commerce.models import CanonicalShipmentStatus
from apps.integrations.base import ProviderAdapter
from apps.integrations.logistics.status_map import map_logistics_status


class ShiprocketAdapter(ProviderAdapter):
    """
    Shiprocket / Carrier Logistics Adapter:
    - Normalizes raw AWB tracking numbers, courier partners, and states
    - Uses status_map pattern with safe IN_TRANSIT fallback
    """

    def get_auth_url(self, state: str) -> str:
        raise NotImplementedError("Shiprocket uses email/password token auth.")

    def exchange_code(self, code: str) -> dict[str, Any]:
        raise NotImplementedError("Direct token generation used.")

    def verify_webhook(self, headers: dict[str, str], raw_body: bytes) -> bool:
        # Carrier webhooks often verify via custom static token or header secret
        token = headers.get("X-Api-Key") or headers.get("x-api-key")
        return bool(token)

    def normalize_order(self, raw_payload: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError("Use normalize_shipment for logistics payloads.")

    def normalize_shipment(self, payload: dict[str, Any]) -> dict[str, Any]:
        raw_status = payload.get("current_status_id") or payload.get("current_status") or ""
        canonical = map_logistics_status(raw_status)

        return {
            "provider": "shiprocket",
            "provider_id": str(payload.get("shipment_id") or payload.get("awb_code") or ""),
            "awb": str(payload.get("awb_code") or payload.get("awb") or ""),
            "courier_name": payload.get("courier_name") or "Express Carrier",
            "canonical_status": canonical,
            "raw_status": str(raw_status),
            "ndr_count": 1 if canonical == CanonicalShipmentStatus.NDR else 0,
        }
