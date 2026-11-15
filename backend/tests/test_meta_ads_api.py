import pytest
from unittest.mock import patch, MagicMock
from rest_framework import status
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.analytics.models import FactAdsDaily
from apps.integrations.models import Integration
from apps.integrations.meta_ads.sync import normalize_ad_account_id, parse_action_stat, parse_action_value
from apps.tenancy.models import Workspace, Brand, WorkspaceMember


@pytest.fixture
def api_client():
    return APIClient()


@pytest.fixture
def setup_tenant(db):
    user = User.objects.create_user(email="testowner@example.com", password="TestPassword123!")
    workspace = Workspace.objects.create(name="Test Meta Workspace", slug="test-meta-workspace")
    WorkspaceMember.objects.create(workspace=workspace, user=user, role=WorkspaceMember.Role.OWNER)
    brand = Brand.objects.create(workspace=workspace, name="Test Meta Brand", currency="INR")
    integration = Integration.objects.create(
        workspace=workspace,
        brand=brand,
        provider=Integration.Provider.META_ADS,
        status=Integration.Status.CONNECTED,
        account_identifier="1030684559469520",
    )
    return user, workspace, brand, integration


def test_normalize_ad_account_id():
    assert normalize_ad_account_id("1030684559469520") == "act_1030684559469520"
    assert normalize_ad_account_id("act_1030684559469520") == "act_1030684559469520"
    assert normalize_ad_account_id("   1030684559469520   ") == "act_1030684559469520"
    assert normalize_ad_account_id("") == ""


def test_parse_action_stat_and_value():
    actions = [
        {"action_type": "link_click", "value": "100"},
        {"action_type": "purchase", "value": "25"},
        {"action_type": "omni_purchase", "value": "25"},
    ]
    action_values = [
        {"action_type": "purchase", "value": "49975.50"},
    ]
    assert parse_action_stat(actions, ("purchase", "omni_purchase")) == 25
    assert parse_action_value(action_values, ("purchase", "omni_purchase")) == 49975.50


def test_meta_ads_dashboard_stats_success(api_client, setup_tenant):
    user, workspace, brand, integration = setup_tenant
    api_client.force_authenticate(user=user)

    url = f"/api/w/{workspace.slug}/b/{brand.id}/marketing/stats/"

    mock_sync_result = {
        "account": {"id": "act_1030684559469520", "name": "Debraj", "currency": "INR", "timezone": "Asia/Kolkata"},
        "summary_30d": {
            "spend_minor": 20560152,
            "impressions": 2911647,
            "clicks": 52971,
            "ctr": 1.82,
            "cpc_minor": 388,
            "cpm_minor": 7061,
            "orders": 468,
            "attributed_revenue_minor": 51057309,
            "roas": 2.48,
        },
        "summary_lifetime": {
            "spend_minor": 333040297,
            "impressions": 57630937,
            "clicks": 1016286,
            "ctr": 1.76,
            "cpc_minor": 327,
            "cpm_minor": 5778,
            "orders": 8035,
            "attributed_revenue_minor": 862274076,
            "roas": 2.59,
        },
        "campaigns": [
            {
                "id": "120246356339560442",
                "name": "CHROME EARBUDS SCALE | CBO",
                "status": "active",
                "spend_minor": 301928824,
                "impressions": 51533778,
                "clicks": 890028,
                "ctr": 1.73,
                "cpc_minor": 339,
                "orders": 7128,
                "attributed_revenue_minor": 769545531,
                "roas": 2.55,
            }
        ],
        "daily_trends": [],
    }

    with patch("apps.integrations.views.sync_meta_ads_data", return_value=mock_sync_result):
        resp = api_client.get(url)
        assert resp.status_code == status.HTTP_200_OK
        data = resp.json()
        assert data["connected"] is True
        assert data["account"]["name"] == "Debraj"
        assert data["summary_30d"]["spend_minor"] == 20560152
        assert data["summary_30d"]["roas"] == 2.48
        assert len(data["campaigns"]) == 1
        assert data["campaigns"][0]["name"] == "CHROME EARBUDS SCALE | CBO"


def test_meta_ads_expired_token_fallback(api_client, setup_tenant):
    user, workspace, brand, integration = setup_tenant
    api_client.force_authenticate(user=user)

    # Seed FactAdsDaily so fallback has historical data
    FactAdsDaily.objects.create(
        workspace=workspace,
        brand=brand,
        fact_date="2026-11-12",
        spend_minor=726519,
        impressions=94603,
        clicks=1783,
        attributed_conversions=20,
        attributed_revenue_minor=2104925,
    )

    url = f"/api/w/{workspace.slug}/b/{brand.id}/marketing/stats/"

    with patch("apps.integrations.views.sync_meta_ads_data", side_effect=ValueError("Session has expired")):
        resp = api_client.get(url)
        assert resp.status_code == status.HTTP_200_OK
        data = resp.json()
        assert data["connected"] is True
        assert data["token_expired"] is True
        assert "expired" in data["error"].lower()
        assert data["summary_30d"]["spend_minor"] == 726519
        assert data["summary_30d"]["orders"] == 20
