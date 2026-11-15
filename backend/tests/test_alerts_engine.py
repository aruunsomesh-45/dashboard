import pytest
from apps.alerts.models import Alert
from rest_framework import status


@pytest.mark.django_db
class TestAlertsCenter:
    def test_alert_deduplication(self, workspace_a, brand_a):
        # Create alert with dedupe_key
        dedupe = f"stuck_payment:{brand_a.id}:pay_101"
        alert, created = Alert.objects.get_or_create(
            workspace=workspace_a,
            brand=brand_a,
            dedupe_key=dedupe,
            defaults={"title": "Stuck Payment pay_101", "severity": Alert.Severity.WARNING},
        )
        assert created is True

        # Second run should NOT create duplicate alert
        alert2, created2 = Alert.objects.get_or_create(
            workspace=workspace_a,
            brand=brand_a,
            dedupe_key=dedupe,
            defaults={"title": "Stuck Payment pay_101", "severity": Alert.Severity.WARNING},
        )
        assert created2 is False
        assert alert.id == alert2.id

    def test_alert_acknowledge_and_resolve(self, api_client, user_a, workspace_a, brand_a):
        alert = Alert.objects.create(
            workspace=workspace_a,
            brand=brand_a,
            dedupe_key=f"ndr_high:{brand_a.id}:2026-11-10",
            title="High NDR Rate Detected",
            severity=Alert.Severity.CRITICAL,
        )

        api_client.force_authenticate(user=user_a)

        # 1. Acknowledge
        ack_url = f"/api/w/{workspace_a.slug}/alerts/{alert.id}/acknowledge/"
        res = api_client.post(ack_url)
        assert res.status_code == status.HTTP_200_OK
        assert res.data["status"] == "acknowledged"

        # 2. Resolve
        res_url = f"/api/w/{workspace_a.slug}/alerts/{alert.id}/resolve/"
        res2 = api_client.post(res_url)
        assert res2.status_code == status.HTTP_200_OK
        assert res2.data["status"] == "resolved"

    def test_alerts_cross_tenant_isolation(self, api_client, user_a, workspace_b, brand_b):
        alert = Alert.objects.create(
            workspace=workspace_b,
            brand=brand_b,
            dedupe_key=f"ws_b_alert:{brand_b.id}",
            title="Secret Workspace B Alert",
            severity=Alert.Severity.CRITICAL,
        )

        api_client.force_authenticate(user=user_a)

        # User A cannot view Workspace B's alerts
        list_url = f"/api/w/{workspace_b.slug}/alerts/"
        res = api_client.get(list_url)
        assert res.status_code == status.HTTP_404_NOT_FOUND
