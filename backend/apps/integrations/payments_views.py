"""Razorpay payment intelligence + signed, idempotent webhook ingestion."""
import hashlib
import json
import logging
from datetime import datetime, timezone as dt_timezone

from django.db import IntegrityError, transaction
from django.db.models import Count, Q, Sum
from django.utils import timezone
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import csrf_exempt
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.analytics.cache import invalidate_brand_cache
from apps.commerce.models import PaymentAttempt
from apps.integrations.models import Integration, WebhookEvent
from apps.integrations.razorpay.adapter import RazorpayAdapter
from apps.tenancy.models import Brand
from apps.tenancy.permissions import HasTenantAccess

logger = logging.getLogger(__name__)


class RazorpayPaymentStatsView(APIView):
    """GET /api/w/{slug}/b/{brand_id}/payments/stats/ - computed only from stored PaymentAttempt rows."""

    permission_classes = [HasTenantAccess]

    def get(self, request, workspace_slug, brand_id):
        brand = request.tenant.brand
        qs = PaymentAttempt.objects.filter(workspace=request.tenant.workspace, brand=brand, provider="razorpay")
        agg = qs.aggregate(
            total=Count("id"),
            captured=Count("id", filter=Q(status="captured")),
            captured_amount=Sum("amount_minor", filter=Q(status="captured")),
        )
        captured_n = agg["captured"] or 0
        method_rows = qs.filter(status="captured").values("method").annotate(n=Count("id"))
        method_splits = (
            {r["method"]: round(r["n"] * 100.0 / captured_n, 1) for r in method_rows} if captured_n else {}
        )
        connected = (
            Integration.objects.filter(
                workspace=request.tenant.workspace, brand=brand, provider=Integration.Provider.RAZORPAY
            )
            .exclude(status=Integration.Status.DISCONNECTED)
            .exists()
        )
        return Response(
            {
                "connected": connected,
                "provider": "razorpay",
                "payment_count": captured_n,
                "attempt_count": agg["total"] or 0,
                "authorized_rate": round(captured_n * 100.0 / agg["total"], 1) if agg["total"] else None,
                "total_captured_minor": agg["captured_amount"] or 0,
                # Razorpay fee data is not stored on PaymentAttempt, so it is not invented.
                "total_fees_minor": None,
                "method_splits": method_splits,
            }
        )


class RazorpayTransactionsView(APIView):
    """GET /api/w/{slug}/b/{brand_id}/payments/transactions/?limit=50"""

    permission_classes = [HasTenantAccess]

    def get(self, request, workspace_slug, brand_id):
        try:
            limit = max(1, min(int(request.query_params.get("limit", 50)), 200))
        except ValueError:
            limit = 50
        rows = PaymentAttempt.objects.filter(
            workspace=request.tenant.workspace, brand=request.tenant.brand, provider="razorpay"
        ).order_by("-created_at")[:limit]
        return Response(
            [
                {
                    "id": p.provider_id,
                    "order_id": p.gateway_order_id,
                    "amount_minor": p.amount_minor,
                    "currency": p.currency,
                    "status": p.status,
                    "method": p.method,
                    "error_code": p.error_code,
                    "created_at": p.created_at.isoformat(),
                }
                for p in rows
            ]
        )


from apps.integrations.webhook_views import RazorpayWebhookView
