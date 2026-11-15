from datetime import timedelta

from django.db.models import Count, Q, Sum
from django.utils import timezone
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.analytics.catalogue import METRIC_REGISTRY
from apps.analytics.models import FactAdsDaily
from apps.commerce.models import Customer, Order, Shipment
from apps.tenancy.permissions import HasTenantAccess


class MetricsQueryAPIView(APIView):
    """
    GET /api/w/{workspace_slug}/b/{brand_id}/metrics/?keys=revenue_per_day,blended_roas,cm1_profit&days=30
    Unified, deterministic metrics API serving calibrated calculations for any time horizon.
    """

    permission_classes = [HasTenantAccess]

    def get(self, request, workspace_slug, brand_id):
        brand = request.tenant.brand
        days_param = request.query_params.get("days", "30")
        try:
            days = max(1, min(int(days_param), 3650))
        except ValueError:
            days = 30

        since = timezone.now() - timedelta(days=days)

        # 1. Aggregate Commerce / Shopify facts
        order_qs = Order.objects.filter(
            workspace=request.tenant.workspace,
            brand=brand,
            provider="shopify",
        )
        if days > 0:
            order_qs = order_qs.filter(Q(source_created_at__gte=since) | Q(source_created_at__isnull=True))

        order_aggs = order_qs.aggregate(
            gross=Sum("gross_amount"),
            disc=Sum("discount_amount"),
            tax=Sum("tax_amount"),
            ship=Sum("shipping_amount"),
            net=Sum("net_sales"),
            total_orders=Count("id"),
            unfulfilled=Count("id", filter=Q(fulfillment_status="unfulfilled")),
            fulfilled=Count("id", filter=Q(fulfillment_status="fulfilled")),
        )

        gross = order_aggs["gross"] or 0
        disc = order_aggs["disc"] or 0
        tax = order_aggs["tax"] or 0
        net = order_aggs["net"] or 0
        orders_count = order_aggs["total_orders"] or 0
        unfulfilled = order_aggs["unfulfilled"] or 0
        fulfilled = order_aggs["fulfilled"] or 0

        ws = request.tenant.workspace
        since_date = since.date()

        # Meta Ads: real daily facts only. None => no ads data synced.
        ads = FactAdsDaily.objects.filter(workspace=ws, brand=brand, fact_date__gte=since_date).aggregate(
            spend=Sum("spend_minor"), rev=Sum("attributed_revenue_minor"), n=Count("id")
        )
        ad_spend = ads["spend"] if ads["n"] else None
        attributed_rev = ads["rev"] if ads["n"] else None

        new_cust_count = Customer.objects.filter(workspace=ws, brand=brand, source_created_at__gte=since).count()

        ship = Shipment.objects.filter(workspace=ws, brand=brand).aggregate(
            total=Count("id"), delivered=Count("id", filter=Q(canonical_status="delivered"))
        )

        # Facts with NO real source in the data model are None (never estimated):
        # COGS/gross profit, gateway fees, freight cost, disputes, Instagram followers/engagement.
        facts = {
            "days": days,
            "net_sales": net,
            "gross_sales": gross,
            "discount_amount": disc,
            "tax_amount": tax,
            "orders_count": orders_count,
            "eligible_orders": orders_count,
            "gross_profit": None,
            "ad_spend": ad_spend,
            "attributed_revenue": attributed_rev,
            "new_customers_count": new_cust_count,
            "total_shipments": ship["total"] or None,
            "delivered_shipments": ship["delivered"],
            "paid_unfulfilled_orders": unfulfilled,
            "open_disputes_count": None,
            "followers_count": None,
            "total_engagements": None,
            "gateway_fee": None,
            "shipping_cost": None,
        }
        requires = {
            "blended_roas": ("ad_spend", "attributed_revenue"),
            "blended_cac": ("ad_spend",),
            "delivery_success_pct": ("total_shipments",),
            "number_of_disputes": ("open_disputes_count",),
            "organic_engagement": ("followers_count", "total_engagements"),
            "cm1_profit": ("gross_profit", "ad_spend", "gateway_fee", "shipping_cost"),
        }

        # Parse requested keys (or return all if omitted)
        keys_param = request.query_params.get("keys")
        if keys_param:
            requested_keys = [k.strip() for k in keys_param.split(",") if k.strip()]
        else:
            requested_keys = list(METRIC_REGISTRY.keys())

        computed_metrics = {}
        for key in requested_keys:
            definition = METRIC_REGISTRY.get(key)
            if not definition:
                continue

            missing = [f for f in requires.get(key, ()) if facts.get(f) is None]
            if missing:
                computed_metrics[key] = {
                    "key": definition.key,
                    "display_name": definition.display_name,
                    "source": definition.source,
                    "unit": definition.unit,
                    "formula_version": definition.formula_version,
                    "value": None,
                    "formatted": "-",
                    "available": False,
                    "missing_inputs": missing,
                }
                continue

            val = definition.compute_fn(facts)
            computed_metrics[key] = {
                "available": True,
                "key": definition.key,
                "display_name": definition.display_name,
                "source": definition.source,
                "unit": definition.unit,
                "formula_version": definition.formula_version,
                "value": val,
                "formatted": (
                    f"₹{(val / 100):,.0f}"
                    if definition.unit == "currency_minor"
                    else f"{val}%"
                    if definition.unit == "percentage"
                    else f"{val}x"
                    if definition.unit == "ratio"
                    else str(val)
                ),
            }

        return Response(
            {
                "brand": {
                    "id": str(brand.id),
                    "name": brand.name,
                    "currency": brand.currency,
                    "timezone": brand.timezone,
                },
                "days": days,
                "metrics": computed_metrics,
            }
        )
