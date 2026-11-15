from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.alerts.models import Alert
from apps.alerts.serializers import AlertSerializer
from apps.tenancy.permissions import HasTenantAccess


class WorkspaceAlertListView(APIView):
    """
    GET /api/w/{workspace_slug}/alerts/
    Returns list of active alerts across the workspace scoped to authorized brands.
    """

    permission_classes = [HasTenantAccess]

    def get(self, request, workspace_slug):
        workspace = request.tenant.workspace
        alerts = Alert.objects.filter(workspace=workspace)

        if request.tenant.allowed_brand_ids is not None:
            alerts = alerts.filter(brand_id__in=request.tenant.allowed_brand_ids)

        # Status filter (open, acknowledged, resolved)
        status_param = request.query_params.get("status")
        if status_param:
            alerts = alerts.filter(status=status_param)

        serializer = AlertSerializer(alerts.order_by("-updated_at")[:50], many=True)
        return Response(serializer.data)


class AlertAcknowledgeView(APIView):
    """
    POST /api/w/{workspace_slug}/alerts/{alert_id}/acknowledge/
    Marks an alert as acknowledged by current user.
    """

    permission_classes = [HasTenantAccess]

    def post(self, request, workspace_slug, alert_id):
        try:
            alert = Alert.objects.get(
                id=alert_id,
                workspace=request.tenant.workspace,
            )
        except Alert.DoesNotExist:
            return Response({"error": "Alert not found."}, status=status.HTTP_404_NOT_FOUND)

        alert.status = Alert.Status.ACKNOWLEDGED
        alert.acknowledged_by = request.user
        alert.acknowledged_at = timezone.now()
        alert.save(update_fields=["status", "acknowledged_by", "acknowledged_at", "updated_at"])

        return Response(AlertSerializer(alert).data)


class AlertResolveView(APIView):
    """
    POST /api/w/{workspace_slug}/alerts/{alert_id}/resolve/
    Resolves an open alert.
    """

    permission_classes = [HasTenantAccess]

    def post(self, request, workspace_slug, alert_id):
        try:
            alert = Alert.objects.get(
                id=alert_id,
                workspace=request.tenant.workspace,
            )
        except Alert.DoesNotExist:
            return Response({"error": "Alert not found."}, status=status.HTTP_404_NOT_FOUND)

        alert.status = Alert.Status.RESOLVED
        alert.resolved_at = timezone.now()
        alert.save(update_fields=["status", "resolved_at", "updated_at"])

        return Response(AlertSerializer(alert).data)
