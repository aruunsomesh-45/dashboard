from unittest import mock

import pytest
from apps.commerce.models import Order
from apps.integrations.models import Integration
from rest_framework import status


@pytest.mark.django_db
class TestShopifyDashboardEndpoints:
    def test_shopify_stats_endpoint(self, api_client, user_a, workspace_a, brand_a):
        # Create an order under workspace_a and brand_a
        Order.objects.create(
            workspace=workspace_a,
            brand=brand_a,
            provider="shopify",
            provider_id="sh_test_101",
            order_number="ORD-101",
            gross_amount=100000,
            discount_amount=10000,
            tax_amount=5000,
            shipping_amount=2000,
            net_sales=85000,
            financial_status="paid",
            fulfillment_status="fulfilled",
        )

        api_client.force_authenticate(user=user_a)
        url = f"/api/w/{workspace_a.slug}/b/{brand_a.id}/shopify/stats/?days=30"
        response = api_client.get(url)

        assert response.status_code == status.HTTP_200_OK
        data = response.data
        assert data["metrics"]["gross_sales_minor"] == 100000
        assert data["metrics"]["net_sales_minor"] == 85000
        assert data["metrics"]["order_count"] == 1
        assert data["metrics"]["aov_minor"] == 85000
        assert data["funnel"]["fulfilled"] == 1
        assert len(data["orders"]) == 1
        assert data["orders"][0]["order_number"] == "ORD-101"

    def test_shopify_stats_cross_tenant_isolation(self, api_client, user_a, workspace_b, brand_b):
        # user_a should not be able to access workspace_b's shopify stats -> 404
        api_client.force_authenticate(user=user_a)
        url = f"/api/w/{workspace_b.slug}/b/{brand_b.id}/shopify/stats/"
        response = api_client.get(url)
        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_integrations_list_endpoint(self, api_client, user_a, workspace_a, brand_a):
        Integration.objects.create(
            workspace=workspace_a,
            brand=brand_a,
            provider=Integration.Provider.SHOPIFY,
            status=Integration.Status.CONNECTED,
            account_identifier="test-brand.myshopify.com",
        )

        api_client.force_authenticate(user=user_a)
        url = f"/api/w/{workspace_a.slug}/b/{brand_a.id}/integrations/"
        response = api_client.get(url)

        assert response.status_code == status.HTTP_200_OK
        assert len(response.data) == 1
        assert response.data[0]["provider"] == "shopify"
        assert response.data[0]["status"] == "connected"
        assert response.data[0]["account_identifier"] == "test-brand.myshopify.com"

    def test_shopify_sync_trigger(self, api_client, user_a, workspace_a, brand_a):
        Integration.objects.create(
            workspace=workspace_a,
            brand=brand_a,
            provider=Integration.Provider.SHOPIFY,
            status=Integration.Status.CONNECTED,
            account_identifier="test-brand.myshopify.com",
        )

        api_client.force_authenticate(user=user_a)
        url = f"/api/w/{workspace_a.slug}/b/{brand_a.id}/shopify/sync-now/"
        # The integration has no credentials, and tests must never reach Shopify: mock the upstream sync.
        # (This test used to rely on a DEBUG-only fake-success fallback in the view, now removed.)
        summary = {"records_processed": 3, "records_created": 2, "records_updated": 1}
        with mock.patch("apps.integrations.views.sync_shopify_orders", return_value=summary) as sync:
            response = api_client.post(url)

        assert sync.called
        assert response.status_code == status.HTTP_200_OK
        assert response.data["status"] == "success"
        assert response.data["records_processed"] == 3
