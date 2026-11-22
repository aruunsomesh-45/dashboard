"""Logistics views. Everything is derived from stored Shipment/TrackingEvent rows, scoped to the tenant."""
import logging

from django.db.models import Avg, Count, F, Q
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.commerce.models import CanonicalShipmentStatus as S
from apps.commerce.models import Shipment
from apps.integrations.crypto import decrypt_credentials
from apps.integrations.delhivery.client import DelhiveryClient, DelhiveryError
from apps.integrations.models import Integration
from apps.tenancy.permissions import HasTenantAccess, IsWorkspaceAdmin

logger = logging.getLogger(__name__)


def _scoped(request):
    return Shipment.objects.filter(workspace=request.tenant.workspace, brand=request.tenant.brand)


class LogisticsSummaryView(APIView):
    permission_classes = [HasTenantAccess]

    def get(self, request, workspace_slug, brand_id):
        agg = _scoped(request).aggregate(
            total=Count("id"),
            ndr=Count("id", filter=Q(canonical_status=S.NDR)),
            delivered=Count("id", filter=Q(canonical_status=S.DELIVERED)),
            in_transit=Count("id", filter=Q(canonical_status__in=[S.IN_TRANSIT, S.OUT_FOR_DELIVERY])),
            rto=Count("id", filter=Q(canonical_status__in=[S.RTO_INITIATED, S.RTO_DELIVERED])),
            avg_delivery=Avg(
                F("delivered_at") - F("shipped_at"),
                filter=Q(delivered_at__isnull=False, shipped_at__isnull=False),
            ),
        )
        total = agg["total"]

        def pct(n):
            return round(n * 100.0 / total, 2) if total else None

        avg = agg["avg_delivery"]
        return Response(
            {
                "carrier": "delhivery",
                "total_shipments": total,
                "in_transit_count": agg["in_transit"],
                "delivered_count": agg["delivered"],
                "ndr_count": agg["ndr"],
                "ndr_rate_percentage": pct(agg["ndr"]),
                "rto_rate_percentage": pct(agg["rto"]),
                "avg_delivery_days": round(avg.total_seconds() / 86400, 1) if avg else None,
                # Not stored anywhere yet; reported as unavailable instead of invented.
                "total_shipping_spend_minor": None,
                "on_time_delivery_rate": None,
            }
        )


class LogisticsShipmentsView(APIView):
    permission_classes = [HasTenantAccess]

    def get(self, request, workspace_slug, brand_id):
        try:
            limit = max(1, min(int(request.query_params.get("limit", 50)), 200))
        except ValueError:
            limit = 50
        rows = _scoped(request).order_by("-created_at")[:limit]
        return Response(
            [
                {
                    "id": str(s.id),
                    "awb": s.awb,
                    "awb_code": s.awb,
                    "carrier": s.courier_name or "unknown",
                    "status": s.canonical_status,
                    "canonical_status": s.canonical_status,
                    "ndr_count": s.ndr_count,
                    "dispatched_at": s.shipped_at.isoformat() if s.shipped_at else None,
                    "delivered_at": s.delivered_at.isoformat() if s.delivered_at else None,
                }
                for s in rows
            ]
        )


class LogisticsTrackingView(APIView):
    permission_classes = [HasTenantAccess]

    def get(self, request, workspace_slug, brand_id, awb_code):
        shipment = _scoped(request).filter(awb=awb_code).first()
        if not shipment:
            return Response({"error": "Shipment not found."}, status=status.HTTP_404_NOT_FOUND)
        events = shipment.events.order_by("-occurred_at")
        return Response(
            {
                "awb_code": shipment.awb,
                "carrier": shipment.courier_name or "unknown",
                "current_status": shipment.canonical_status,
                "scans": [
                    {"timestamp": e.occurred_at.isoformat(), "location": e.location, "activity": e.status_description}
                    for e in events
                ],
            }
        )


class LogisticsNdrActionView(APIView):
    """
    POST /api/w/{slug}/b/{brand_id}/logistics/ndr/{awb}/action/
    Sends a REAL instruction to Delhivery (via DelhiveryClient) and only then updates local status.
    - admin/owner only, rate limited (throttle scope "ndr")
    - shipment must belong to this workspace+brand; the Delhivery integration must be connected
    - local state is NOT changed if Delhivery rejects/fails
    """

    permission_classes = [IsWorkspaceAdmin]
    throttle_scope = "ndr"

    def post(self, request, workspace_slug, brand_id, awb_code):
        action = request.data.get("action", "reattempt")
        if action not in ("reattempt", "return_to_origin"):
            return Response(
                {"error": "Invalid action. Supported actions: 'reattempt', 'return_to_origin'."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        shipment = _scoped(request).filter(awb=awb_code).first()
        if not shipment:
            return Response({"error": "Shipment not found."}, status=status.HTTP_404_NOT_FOUND)
        if shipment.canonical_status != S.NDR:
            return Response({"error": "Shipment is not in NDR state."}, status=status.HTTP_409_CONFLICT)

        if action == "return_to_origin":
            return Response(
                {"error": "return_to_origin is not implemented against the Delhivery API yet."},
                status=status.HTTP_501_NOT_IMPLEMENTED,
            )

        integration = Integration.objects.filter(
            workspace=request.tenant.workspace,
            brand=request.tenant.brand,
            provider=Integration.Provider.DELHIVERY,
            status=Integration.Status.CONNECTED,
        ).first()
        if not integration:
            return Response(
                {"error": "Delhivery integration is not connected for this brand."},
                status=status.HTTP_409_CONFLICT,
            )
        try:
            token = decrypt_credentials(integration.encrypted_credentials or b"").get("api_token", "")
            DelhiveryClient(token).reattempt(shipment.awb)
        except DelhiveryError as exc:
            logger.warning("Delhivery NDR action failed for %s: %s", shipment.awb, exc)
            return Response(
                {"error": "Courier rejected or failed the instruction."}, status=status.HTTP_502_BAD_GATEWAY
            )

        shipment.canonical_status = S.IN_TRANSIT
        shipment.save(update_fields=["canonical_status", "updated_at"])
        logger.info("ndr_action", extra={"awb": shipment.awb, "action": action, "workspace": workspace_slug})
        return Response({"success": True, "awb_code": shipment.awb, "action": action})


class DelhiveryWebhookView(APIView):
    """
    POST /api/webhooks/delhivery/{brand_id}/
    Not implemented: Delhivery scan webhooks are not processed. An unauthenticated endpoint that
    pretends to accept them is worse than none, so this returns 501 until a signature scheme + handler exist.
    """

    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request, brand_id):
        return Response(
            {"error": "Delhivery webhook ingestion is not implemented."}, status=status.HTTP_501_NOT_IMPLEMENTED
        )
