import logging
import re
from datetime import timedelta
from urllib.parse import urlparse

import requests
from django.db import transaction
from django.utils import timezone

from apps.commerce.models import Customer, Order, OrderLine
from apps.integrations.crypto import decrypt_credentials
from apps.integrations.models import Integration, SyncRun
from apps.integrations.shopify.adapter import ShopifyAdapter

logger = logging.getLogger(__name__)

SHOPIFY_API_VERSION = "2024-10"
NEXT_LINK_RE = re.compile(r'<([^>]+)>;\s*rel="next"')


def normalize_shop_domain(raw_domain: str) -> str:
    """Extracts bare hostname (e.g. 'your-brand.myshopify.com') from user input."""
    val = (raw_domain or "").strip()
    if val.startswith("http://") or val.startswith("https://"):
        val = urlparse(val).netloc or val
    return val.split("/")[0].lower()


def sync_shopify_orders(integration: Integration, days: int = 90, max_pages: int = 10) -> dict:
    """
    Pulls orders and customers from Shopify Admin REST API into canonical commerce tables.
    Returns summary dict: {records_processed, records_created, records_updated}.
    """
    creds = decrypt_credentials(integration.encrypted_credentials or b"")
    shop_domain = normalize_shop_domain(
        creds.get("shop_domain") or creds.get("shop_url") or integration.account_identifier
    )
    access_token = (creds.get("access_token") or "").strip()

    if not shop_domain or not access_token:
        raise ValueError("Shopify Store Domain and Admin API Access Token are required.")

    sync_run = SyncRun.objects.create(
        workspace=integration.workspace,
        brand=integration.brand,
        integration=integration,
        status=SyncRun.Status.RUNNING,
        resource="orders",
    )

    adapter = ShopifyAdapter(integration)
    since_iso = (timezone.now() - timedelta(days=days)).isoformat()
    next_url: str | None = f"https://{shop_domain}/admin/api/{SHOPIFY_API_VERSION}/orders.json"
    params: dict | None = {
        "status": "any",
        "limit": 250,
        "created_at_min": since_iso,
    }

    processed = 0
    created_count = 0
    updated_count = 0

    try:
        page = 0
        while next_url and page < max_pages:
            page += 1
            resp = requests.get(
                next_url,
                params=params,
                headers={
                    "X-Shopify-Access-Token": access_token,
                    "Accept": "application/json",
                },
                timeout=20,
            )
            # Subsequent paginated URLs from Shopify already include query params
            params = None

            if resp.status_code == 401:
                raise ValueError("Shopify rejected the Admin API Access Token (401 Unauthorized).")
            if resp.status_code == 403:
                raise ValueError("Shopify API token lacks required 'read_orders' scope (403 Forbidden).")
            if resp.status_code == 404:
                raise ValueError(f"Shopify store '{shop_domain}' was not found (404).")
            if resp.status_code >= 400:
                raise ValueError(f"Shopify API error ({resp.status_code}): {resp.text[:300]}")

            orders_data = resp.json().get("orders", [])
            if not orders_data:
                break

            with transaction.atomic():
                for raw_order in orders_data:
                    norm = adapter.normalize_order(raw_order)

                    customer_obj = None
                    cust_payload = norm.get("customer_payload")
                    if cust_payload and cust_payload.get("id"):
                        c_norm = adapter.normalize_customer(cust_payload)
                        customer_obj, _ = Customer.objects.update_or_create(
                            brand=integration.brand,
                            provider="shopify",
                            provider_id=c_norm["provider_id"],
                            defaults={
                                "workspace": integration.workspace,
                                "first_name": c_norm["first_name"],
                                "last_name": c_norm["last_name"],
                                "email": c_norm["email"],
                                "phone": c_norm["phone"],
                                "orders_count": c_norm["orders_count"],
                                "total_spent_minor": c_norm["total_spent_minor"],
                            },
                        )

                    order_obj, is_created = Order.objects.update_or_create(
                        brand=integration.brand,
                        provider="shopify",
                        provider_id=norm["provider_id"],
                        defaults={
                            "workspace": integration.workspace,
                            "customer": customer_obj,
                            "order_number": norm["order_number"],
                            "currency": norm["currency"],
                            "gross_amount": norm["gross_amount"],
                            "discount_amount": norm["discount_amount"],
                            "tax_amount": norm["tax_amount"],
                            "shipping_amount": norm["shipping_amount"],
                            "net_sales": norm["net_sales"],
                            "financial_status": norm["financial_status"],
                            "fulfillment_status": norm["fulfillment_status"],
                            "source_created_at": norm["source_created_at"],
                            "source_updated_at": norm["source_updated_at"],
                            "cancelled_at": norm["cancelled_at"],
                        },
                    )

                    if norm["lines"]:
                        OrderLine.objects.filter(order=order_obj).delete()
                        OrderLine.objects.bulk_create(
                            [
                                OrderLine(
                                    order=order_obj,
                                    title=line["title"][:255],
                                    sku=line["sku"][:100],
                                    quantity=line["quantity"],
                                    price_minor=line["price_minor"],
                                    total_discount_minor=line["total_discount_minor"],
                                )
                                for line in norm["lines"]
                            ]
                        )

                    processed += 1
                    if is_created:
                        created_count += 1
                    else:
                        updated_count += 1

            link_header = resp.headers.get("Link", "")
            match = NEXT_LINK_RE.search(link_header)
            next_url = match.group(1) if match else None

        sync_run.status = SyncRun.Status.SUCCESS
        sync_run.finished_at = timezone.now()
        sync_run.records_processed = processed
        sync_run.records_created = created_count
        sync_run.records_updated = updated_count
        sync_run.save(
            update_fields=["status", "finished_at", "records_processed", "records_created", "records_updated"]
        )

        integration.status = Integration.Status.CONNECTED
        integration.last_synced_at = timezone.now()
        integration.last_error_message = ""
        integration.save(update_fields=["status", "last_synced_at", "last_error_message"])

        return {
            "records_processed": processed,
            "records_created": created_count,
            "records_updated": updated_count,
        }

    except Exception as exc:
        logger.exception("Shopify sync failed for brand %s", integration.brand_id)
        sync_run.status = SyncRun.Status.FAILED
        sync_run.finished_at = timezone.now()
        sync_run.error_message = str(exc)[:1000]
        sync_run.save(update_fields=["status", "finished_at", "error_message"])

        integration.status = Integration.Status.ERROR
        integration.last_error_message = str(exc)[:1000]
        integration.save(update_fields=["status", "last_error_message"])
        raise
