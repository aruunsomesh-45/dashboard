from django.urls import path

from apps.integrations.logistics_views import DelhiveryWebhookView
from apps.integrations.webhook_views import (
    MetaWebhookView,
    RazorpayWebhookView,
    ShiprocketWebhookView,
    ShopifyWebhookView,
)

urlpatterns = [
    # Inbound webhooks (authenticated by provider HMAC signature / tokens, not by user session)
    path("webhooks/shopify/<uuid:brand_id>/", ShopifyWebhookView.as_view(), name="shopify-webhook"),
    path("webhooks/razorpay/<uuid:brand_id>/", RazorpayWebhookView.as_view(), name="razorpay-webhook"),
    path("webhooks/shiprocket/<uuid:brand_id>/", ShiprocketWebhookView.as_view(), name="shiprocket-webhook"),
    path("webhooks/meta/<uuid:brand_id>/", MetaWebhookView.as_view(), name="meta-webhook"),
    path("webhooks/delhivery/<uuid:brand_id>/", DelhiveryWebhookView.as_view(), name="delhivery-webhook"),
]
