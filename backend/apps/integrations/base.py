from abc import ABC, abstractmethod
from typing import Any


class ProviderAdapter(ABC):
    def __init__(self, integration_record):
        self.integration = integration_record

    @abstractmethod
    def get_auth_url(self, state: str) -> str:
        """Returns OAuth authorization URL."""
        pass

    @abstractmethod
    def exchange_code(self, code: str) -> dict[str, Any]:
        """Exchanges authorization code for access token."""
        pass

    @abstractmethod
    def verify_webhook(self, headers: dict[str, str], raw_body: bytes) -> bool:
        """Cryptographically verifies incoming webhook payload."""
        pass

    @abstractmethod
    def normalize_order(self, raw_payload: dict[str, Any]) -> dict[str, Any]:
        """Transforms provider-specific payload into Canonical Order fields."""
        pass

    def normalize_payment(self, raw_payload: dict[str, Any]) -> dict[str, Any]:
        """Transforms provider-specific payment payload into Canonical Payment fields."""
        raise NotImplementedError("Payment normalization not supported for this provider.")

    def normalize_shipment(self, raw_payload: dict[str, Any]) -> dict[str, Any]:
        """Transforms provider-specific shipment payload into Canonical Shipment fields."""
        raise NotImplementedError("Shipment normalization not supported for this provider.")
