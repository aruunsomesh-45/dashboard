import base64
import hashlib
import hmac
from typing import Any

from django.utils import timezone
from django.utils.dateparse import parse_datetime

from apps.integrations.base import ProviderAdapter
from apps.integrations.crypto import decrypt_credentials


def to_minor_units(amount: Any) -> int:
    """Converts a decimal/float/string money amount (e.g. '1499.50') into integer minor units (paise: 149950)."""
    if amount is None or amount == "":
        return 0
    try:
        # String parse to avoid float floating-point representation errors
        str_val = str(amount).strip()
        if "." in str_val:
            parts = str_val.split(".")
            integer_part = int(parts[0])
            fraction_part = parts[1][:2].ljust(2, "0")
            sign = -1 if integer_part < 0 or str_val.startswith("-") else 1
            return (abs(integer_part) * 100 + int(fraction_part)) * sign
        return int(str_val) * 100
    except (ValueError, TypeError):
        return 0


class ShopifyAdapter(ProviderAdapter):
    def get_auth_url(self, state: str) -> str:
        creds = decrypt_credentials(self.integration.encrypted_credentials)
        shop = creds.get("shop_url") or self.integration.account_identifier
        client_id = creds.get("client_id")
        scopes = ",".join(self.integration.scopes or ["read_orders", "read_products", "read_customers"])
        redirect_uri = creds.get("redirect_uri", "")
        return f"https://{shop}/admin/oauth/authorize?client_id={client_id}&scope={scopes}&redirect_uri={redirect_uri}&state={state}"

    def exchange_code(self, code: str) -> dict[str, Any]:
        # Exchange logic when OAuth code is received from Shopify callback
        return {"access_token": f"shpat_{code[:16]}"}

    def verify_webhook(self, headers: dict[str, str], raw_body: bytes) -> bool:
        """Cryptographically verifies incoming webhook with X-Shopify-Hmac-Sha256."""
        hmac_header = headers.get("X-Shopify-Hmac-Sha256") or headers.get("HTTP_X_SHOPIFY_HMAC_SHA256")
        if not hmac_header:
            return False

        creds = decrypt_credentials(self.integration.encrypted_credentials)
        api_secret = creds.get("api_secret") or creds.get("shared_secret", "")
        if not api_secret:
            return False

        digest = hmac.new(
            api_secret.encode("utf-8"),
            raw_body,
            hashlib.sha256,
        ).digest()
        calculated_hmac = base64.b64encode(digest).decode("utf-8")

        return hmac.compare_digest(calculated_hmac, hmac_header)

    def normalize_customer(self, raw_payload: dict[str, Any]) -> dict[str, Any]:
        """Normalizes Shopify customer payload."""
        c = raw_payload.get("customer") or raw_payload
        return {
            "provider": "shopify",
            "provider_id": str(c.get("id", "")),
            "first_name": c.get("first_name", "") or "",
            "last_name": c.get("last_name", "") or "",
            "email": (c.get("email") or "").lower().strip(),
            "phone": c.get("phone", "") or "",
            "orders_count": int(c.get("orders_count", 0)),
            "total_spent_minor": to_minor_units(c.get("total_spent", 0)),
        }

    def normalize_order(self, raw_payload: dict[str, Any]) -> dict[str, Any]:
        """Normalizes Shopify order payload into integer paise canonical fields."""
        # Timestamps
        created_at_raw = raw_payload.get("created_at")
        updated_at_raw = raw_payload.get("updated_at")
        source_created_at = parse_datetime(created_at_raw) if created_at_raw else timezone.now()
        source_updated_at = parse_datetime(updated_at_raw) if updated_at_raw else timezone.now()

        # Financials in minor units (paise)
        gross_amount = to_minor_units(raw_payload.get("total_line_items_price", 0))
        discount_amount = to_minor_units(raw_payload.get("total_discounts", 0))
        tax_amount = to_minor_units(raw_payload.get("total_tax", 0))
        shipping_amount = to_minor_units(
            (raw_payload.get("total_shipping_price_set") or {}).get("shop_money", {}).get("amount") or 0
        )

        # Net sales calculation respects taxes_included flag (F-08)
        # When taxes_included is True, gross line items already contain tax, so subtract tax.
        # When taxes_included is False, gross line items are tax-exclusive, so do not subtract tax.
        taxes_included = raw_payload.get("taxes_included", True)
        if taxes_included:
            net_sales = gross_amount - discount_amount - tax_amount
        else:
            net_sales = gross_amount - discount_amount

        # Lines normalization
        lines = []
        for line in raw_payload.get("line_items", []):
            lines.append(
                {
                    "provider_id": str(line.get("id", "")),
                    "variant_provider_id": str(line.get("variant_id", "") or ""),
                    "title": line.get("title", ""),
                    "sku": line.get("sku", "") or "",
                    "quantity": int(line.get("quantity", 1)),
                    "price_minor": to_minor_units(line.get("price", 0)),
                    "total_discount_minor": to_minor_units(line.get("total_discount", 0)),
                }
            )

        return {
            "provider": "shopify",
            "provider_id": str(raw_payload.get("id")),
            "order_number": str(raw_payload.get("order_number") or raw_payload.get("name", "")),
            "currency": raw_payload.get("currency") or "INR",
            "gross_amount": gross_amount,
            "discount_amount": discount_amount,
            "tax_amount": tax_amount,
            "shipping_amount": shipping_amount,
            "net_sales": net_sales,
            "financial_status": raw_payload.get("financial_status") or "pending",
            "fulfillment_status": raw_payload.get("fulfillment_status") or "unfulfilled",
            "source_created_at": source_created_at,
            "source_updated_at": source_updated_at,
            "cancelled_at": parse_datetime(raw_payload["cancelled_at"]) if raw_payload.get("cancelled_at") else None,
            "lines": lines,
            "customer_payload": raw_payload.get("customer"),
        }

    def normalize_product(self, raw_payload: dict[str, Any]) -> dict[str, Any]:
        """Normalizes Shopify product and variants."""
        variants = []
        for v in raw_payload.get("variants", []):
            variants.append(
                {
                    "provider_id": str(v.get("id")),
                    "title": v.get("title", "Default Title"),
                    "sku": v.get("sku", "") or "",
                    "price_minor": to_minor_units(v.get("price", 0)),
                    "inventory_quantity": int(v.get("inventory_quantity", 0)),
                }
            )

        return {
            "provider": "shopify",
            "provider_id": str(raw_payload.get("id")),
            "title": raw_payload.get("title", ""),
            "handle": raw_payload.get("handle", ""),
            "product_type": raw_payload.get("product_type", ""),
            "vendor": raw_payload.get("vendor", ""),
            "status": raw_payload.get("status", "active"),
            "variants": variants,
        }
