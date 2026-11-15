"""A brand with no data must show no data. No demo/seed/fallback paths in production code."""
import uuid
from unittest import mock

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from rest_framework.test import APIClient

from apps.integrations.crypto import encrypt_credentials
from apps.integrations.models import Integration
from apps.tenancy.models import Brand

FORBIDDEN = ["Rohan", "ord-101", "rohan@example", "DEL10398472910", "Core Apparel", "Silk Casual", "customer@example.com",
             "Gurgaon", "Rajesh Kumar", "Mumbai", "205601.52", "simulated", "shpat_mock"]


def get(client, brand, ws, tail):
    return client.get(f"/api/w/{ws.slug}/b/{brand.id}/{tail}")


@pytest.mark.django_db
class TestEmptyBrandIsEmpty:
    def test_shopify_stats_empty(self, client_for, user_a, workspace_a, brand_a):
        data = get(client_for(user_a), brand_a, workspace_a, "shopify/stats/").json()
        assert data["orders"] == [] and data["order_items"] == []
        assert data["metrics"]["order_count"] == 0 and data["metrics"]["gross_sales_minor"] == 0

    def test_payments_empty(self, client_for, user_a, workspace_a, brand_a):
        c = client_for(user_a)
        stats = get(c, brand_a, workspace_a, "payments/stats/").json()
        assert stats["payment_count"] == 0 and stats["total_captured_minor"] == 0
        assert stats["method_splits"] == {} and stats["connected"] is False
        assert get(c, brand_a, workspace_a, "payments/transactions/").json() == []

    def test_logistics_empty(self, client_for, user_a, workspace_a, brand_a):
        c = client_for(user_a)
        summ = get(c, brand_a, workspace_a, "logistics/summary/").json()
        assert summ["total_shipments"] == 0 and summ["ndr_count"] == 0 and summ["delivered_count"] == 0
        assert summ["ndr_rate_percentage"] is None and summ["total_shipping_spend_minor"] is None
        assert get(c, brand_a, workspace_a, "logistics/shipments/").json() == []
        assert get(c, brand_a, workspace_a, "logistics/track/ANYAWB/").status_code == 404

    def test_metrics_unavailable_inputs_are_null_not_estimated(self, client_for, user_a, workspace_a, brand_a):
        m = get(client_for(user_a), brand_a, workspace_a, "metrics/").json()["metrics"]
        for key in ("cm1_profit", "number_of_disputes", "organic_engagement", "blended_roas"):
            assert m[key]["value"] is None and m[key]["available"] is False, key

    def test_no_forbidden_literals_anywhere(self, client_for, user_a, workspace_a, brand_a):
        c = client_for(user_a)
        for tail in ("shopify/stats/", "payments/stats/", "payments/transactions/", "logistics/summary/",
                     "logistics/shipments/", "metrics/", "marketing/stats/", "integrations/"):
            body = get(c, brand_a, workspace_a, tail).content.decode()
            for lit in FORBIDDEN:
                assert lit not in body, f"{tail} contains {lit!r}"

    def test_former_seed_brand_gets_no_special_treatment(self, client_for, user_a, workspace_a):
        """Old code returned 468 orders / ₹5.1M for this brand id/name when it was empty."""
        b = Brand.objects.create(id=uuid.UUID("e309a60f-d474-4d04-ae30-387b571c46f2"), workspace=workspace_a,
                                 name="125 East Flagship Store")
        c = client_for(user_a)
        stats = get(c, b, workspace_a, "shopify/stats/").json()
        assert stats["metrics"]["order_count"] == 0 and stats["gross_sales"] == 0
        assert get(c, b, workspace_a, "payments/stats/").json()["payment_count"] == 0
        assert get(c, b, workspace_a, "logistics/summary/").json()["total_shipments"] == 0


@pytest.mark.django_db
class TestNoSimulatedSyncs:
    def test_shopify_sync_without_integration_is_400(self, client_for, user_a, workspace_a, brand_a):
        res = client_for(user_a).post(f"/api/w/{workspace_a.slug}/b/{brand_a.id}/shopify/sync-now/")
        assert res.status_code == 400

    def test_shopify_sync_failure_is_reported_as_failure(self, client_for, user_a, workspace_a, brand_a):
        Integration.objects.create(workspace=workspace_a, brand=brand_a, provider="shopify", status="connected",
                                   encrypted_credentials=encrypt_credentials({"shop_domain": "x.myshopify.com", "access_token": "t"}))
        with mock.patch("apps.integrations.views.sync_shopify_orders", side_effect=RuntimeError("shopify down")):
            res = client_for(user_a).post(f"/api/w/{workspace_a.slug}/b/{brand_a.id}/shopify/sync-now/")
        assert res.status_code == 502 and "records_processed" not in res.json()
        assert Integration.objects.get(brand=brand_a).status == "error"

    def test_meta_mock_flag_cannot_fabricate_success(self, client_for, user_a, workspace_a, brand_a):
        Integration.objects.create(workspace=workspace_a, brand=brand_a, provider="meta_ads", status="connected",
                                   encrypted_credentials=encrypt_credentials({"access_token": "abc..."}))
        with mock.patch("apps.integrations.views.sync_meta_ads_data", side_effect=ValueError("bad token")) as sync:
            res = client_for(user_a).post(
                f"/api/w/{workspace_a.slug}/b/{brand_a.id}/marketing/sync-now/?mock=true", {"mock": True}, format="json")
        assert sync.called, "mock flag must not bypass the real sync"
        assert res.status_code == 400 and "simulated" not in res.content.decode()

    def test_meta_graph_mock_proxy_routes_are_gone(self):
        for path in ("/api/integrations/meta/graph/v21.0/act_123/", "/api/integrations/meta/graph/v21.0/act_123/insights/"):
            assert APIClient().get(path).status_code == 404


@pytest.mark.django_db
class TestNoDebugBypass:
    def test_unauthenticated_cannot_resolve_tenant_even_in_debug(self, settings, workspace_a, brand_a):
        settings.DEBUG = True
        c = APIClient()
        assert c.get(f"/api/w/{workspace_a.slug}/").status_code == 404
        assert c.get(f"/api/w/{workspace_a.slug}/b/{brand_a.id}/shopify/stats/").status_code == 404
        assert c.get("/api/w/").status_code in (401, 403)
        assert c.post("/api/w/", {"name": "x"}, format="json").status_code in (401, 403)

    def test_dev_tokens_rejected_in_debug(self, settings, workspace_a):
        settings.DEBUG = True
        c = APIClient()
        c.credentials(HTTP_AUTHORIZATION="Bearer dev-mock-token")
        assert c.get("/api/w/").status_code == 401


@pytest.mark.django_db
def test_seed_demo_refuses_without_demo_mode(settings):
    settings.DEMO_MODE = False
    with pytest.raises(CommandError):
        call_command("seed_demo")


def test_prod_settings_refuse_demo_mode_and_weak_config(monkeypatch):
    import importlib

    from django.core.exceptions import ImproperlyConfigured

    base = {"SECRET_KEY": "x" * 60, "INTEGRATION_ENCRYPTION_KEY": "k" * 40, "ALLOWED_HOSTS": "api.example.com", "CORS_ALLOWED_ORIGINS": "https://app.example.com"}
    for k, v in base.items():
        monkeypatch.setenv(k, v)
    import config.settings.base as base_mod

    importlib.reload(base_mod)  # pick up the env set above before prod is first imported
    import config.settings.prod as prod

    def load():
        importlib.reload(base_mod)  # DEMO_MODE etc. are read in base
        return importlib.reload(prod)

    prod = load()  # baseline loads
    assert prod.DEBUG is False and prod.SECURE_SSL_REDIRECT is True

    monkeypatch.setenv("DEMO_MODE", "true")
    with pytest.raises(ImproperlyConfigured):
        load()
    monkeypatch.delenv("DEMO_MODE")
    monkeypatch.setenv("SECRET_KEY", "short")
    with pytest.raises(ImproperlyConfigured):
        load()
    monkeypatch.setenv("SECRET_KEY", "x" * 60)
    monkeypatch.setenv("ALLOWED_HOSTS", "*")
    with pytest.raises(ImproperlyConfigured):
        load()


@pytest.fixture(autouse=True, scope="module")
def _restore_settings_modules():
    yield
    import importlib

    import config.settings.base as b
    import config.settings.dev as d

    for k in ("SECRET_KEY", "INTEGRATION_ENCRYPTION_KEY", "ALLOWED_HOSTS", "CORS_ALLOWED_ORIGINS", "DEMO_MODE"):
        os_env = __import__("os").environ
        os_env.pop(k, None)
    importlib.reload(b)
    importlib.reload(d)
