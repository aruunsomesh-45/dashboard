from django.db import transaction

from apps.commerce.models import Customer, Order, OrderLine
from apps.integrations.models import Integration, RawPayload
from apps.integrations.shopify.adapter import ShopifyAdapter


def ingest_shopify_order(brand, raw_payload: dict) -> Order:
    """
    Ingests or updates a canonical Order from raw Shopify JSON.
    Guarantees idempotency and out-of-order event safety.
    """
    integration = Integration.objects.get(brand=brand, provider=Integration.Provider.SHOPIFY)
    adapter = ShopifyAdapter(integration)
    norm = adapter.normalize_order(raw_payload)

    with transaction.atomic():
        # 1. Customer resolution
        customer = None
        if norm.get("customer_payload"):
            c_norm = adapter.normalize_customer(norm["customer_payload"])
            customer, _ = Customer.objects.update_or_create(
                workspace=brand.workspace,
                brand=brand,
                provider="shopify",
                provider_id=c_norm["provider_id"],
                defaults={
                    "first_name": c_norm["first_name"],
                    "last_name": c_norm["last_name"],
                    "email": c_norm["email"],
                    "phone": c_norm["phone"],
                    "orders_count": c_norm["orders_count"],
                    "total_spent_minor": c_norm["total_spent_minor"],
                },
            )

        # 2. Check for out-of-order events:
        existing_order = Order.objects.filter(brand=brand, provider="shopify", provider_id=norm["provider_id"]).first()

        if existing_order and existing_order.source_updated_at:
            if norm["source_updated_at"] < existing_order.source_updated_at:
                # Discard older event to preserve fresh state
                return existing_order

        # 3. Upsert Canonical Order
        order, _ = Order.objects.update_or_create(
            workspace=brand.workspace,
            brand=brand,
            provider="shopify",
            provider_id=norm["provider_id"],
            defaults={
                "order_number": norm["order_number"],
                "customer": customer,
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

        # 4. Upsert Order Lines
        # Clear existing lines for full state synchronization
        order.lines.all().delete()
        for line_data in norm.get("lines", []):
            OrderLine.objects.create(
                order=order,
                title=line_data["title"],
                sku=line_data["sku"],
                quantity=line_data["quantity"],
                price_minor=line_data["price_minor"],
                total_discount_minor=line_data["total_discount_minor"],
            )

        # 5. Save Raw Payload for replay and audits (90-day retention)
        RawPayload.objects.create(
            workspace=brand.workspace,
            brand=brand,
            provider="shopify",
            topic="orders/updated",
            entity_id=norm["provider_id"],
            payload=raw_payload,
        )

        return order
