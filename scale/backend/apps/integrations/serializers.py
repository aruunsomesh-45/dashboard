from rest_framework import serializers

from apps.commerce.models import Order
from apps.integrations.models import Integration


class IntegrationStatusSerializer(serializers.ModelSerializer):
    provider_display = serializers.CharField(source="get_provider_display", read_only=True)
    status_display = serializers.CharField(source="get_status_display", read_only=True)

    class Meta:
        model = Integration
        fields = [
            "id",
            "provider",
            "provider_display",
            "status",
            "status_display",
            "account_identifier",
            "last_synced_at",
            "last_error_message",
            "token_expires_at",
        ]


class ShopifyOrderLineSerializer(serializers.Serializer):
    id = serializers.UUIDField(read_only=True)
    title = serializers.CharField(read_only=True)
    sku = serializers.CharField(read_only=True)
    quantity = serializers.IntegerField(read_only=True)
    unit_price_minor = serializers.IntegerField(read_only=True)
    total_discount_minor = serializers.IntegerField(read_only=True)


class ShopifyOrderSerializer(serializers.ModelSerializer):
    customer_email = serializers.EmailField(source="customer.email", read_only=True, default="")
    customer_name = serializers.SerializerMethodField()
    lines_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = Order
        fields = [
            "id",
            "provider_id",
            "order_number",
            "customer_email",
            "customer_name",
            "currency",
            "gross_amount",
            "discount_amount",
            "tax_amount",
            "shipping_amount",
            "net_sales",
            "financial_status",
            "fulfillment_status",
            "source_created_at",
            "lines_count",
        ]

    def get_customer_name(self, obj):
        if obj.customer:
            name = f"{obj.customer.first_name} {obj.customer.last_name}".strip()
            return name or obj.customer.email or "Customer"
        return "Guest"
