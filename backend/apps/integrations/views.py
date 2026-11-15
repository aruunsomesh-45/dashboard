import logging
from datetime import timedelta

logger = logging.getLogger(__name__)

from django.db.models import Count, Q, Sum
from django.utils import timezone
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.analytics.cache import get_cached_tenant_data, invalidate_brand_cache
from apps.commerce.models import Order, Shipment, TrackingEvent, CanonicalShipmentStatus
from apps.analytics.models import FactAdsDaily
from apps.integrations.crypto import encrypt_credentials
from apps.integrations.models import Integration, RawPayload
from apps.integrations.serializers import (
    IntegrationStatusSerializer,
    ShopifyOrderSerializer,
)
from apps.integrations.shopify.sync import normalize_shop_domain, sync_shopify_orders
from apps.integrations.meta_ads.sync import sync_meta_ads_data
from apps.tenancy.permissions import HasTenantAccess, IsWorkspaceAdmin, IsWorkspaceAnalyst


class BrandIntegrationListView(APIView):
    """
    GET /api/w/{workspace_slug}/b/{brand_id}/integrations/
    POST /api/w/{workspace_slug}/b/{brand_id}/integrations/
    DELETE /api/w/{workspace_slug}/b/{brand_id}/integrations/?provider=...
    """

    def get_permissions(self):
        if self.request.method in ("POST", "DELETE"):
            return [IsWorkspaceAdmin()]
        return [HasTenantAccess()]

    def get(self, request, workspace_slug, brand_id):
        brand = request.tenant.brand
        integrations = Integration.objects.filter(workspace=request.tenant.workspace, brand=brand)
        serializer = IntegrationStatusSerializer(integrations, many=True)
        return Response(serializer.data)

    def post(self, request, workspace_slug, brand_id):
        brand = request.tenant.brand
        provider = (request.data.get("provider") or "").strip()
        valid_providers = {choice[0] for choice in Integration.Provider.choices}
        if provider not in valid_providers:
            return Response(
                {"error": f"Unsupported provider '{provider}'."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        credentials = request.data.get("credentials") or {}
        if not isinstance(credentials, dict) or not credentials:
            return Response(
                {"error": "Credentials object is required."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        account_identifier = (request.data.get("account_identifier") or "").strip()
        if provider == Integration.Provider.SHOPIFY:
            raw_domain = credentials.get("shop_domain") or credentials.get("shop_url") or account_identifier
            clean_domain = normalize_shop_domain(raw_domain)
            if not clean_domain or not (credentials.get("access_token") or "").strip():
                return Response(
                    {"error": "Shopify Store Domain and Admin API Access Token are required."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            account_identifier = clean_domain
            credentials = {
                "shop_domain": clean_domain,
                "access_token": credentials["access_token"].strip(),
                "api_secret": (credentials.get("webhook_secret") or credentials.get("api_secret") or "").strip(),
            }

        encrypted = encrypt_credentials(credentials)
        integration, _ = Integration.objects.update_or_create(
            brand=brand,
            provider=provider,
            defaults={
                "workspace": request.tenant.workspace,
                "account_identifier": account_identifier[:255],
                "encrypted_credentials": encrypted,
                "status": Integration.Status.CONNECTED,
                "last_error_message": "",
            },
        )
        serializer = IntegrationStatusSerializer(integration)
        return Response(serializer.data, status=status.HTTP_200_OK)

    def delete(self, request, workspace_slug, brand_id):
        brand = request.tenant.brand
        provider = (request.query_params.get("provider") or request.data.get("provider") or "").strip()
        if not provider:
            return Response({"error": "provider is required."}, status=status.HTTP_400_BAD_REQUEST)

        updated = Integration.objects.filter(
            workspace=request.tenant.workspace,
            brand=brand,
            provider=provider,
        ).update(
            status=Integration.Status.DISCONNECTED,
            encrypted_credentials=b"",
            last_error_message="",
        )
        if not updated:
            return Response({"error": "Integration not found."}, status=status.HTTP_404_NOT_FOUND)
        return Response({"status": "disconnected", "provider": provider})


class ShopifyDashboardStatsView(APIView):
    """
    GET /api/w/{workspace_slug}/b/{brand_id}/shopify/stats/?days=30&cursor_created_at=...&cursor_id=...
    Optimized multi-tenant endpoint:
    - In-memory tenant-isolated caching (5m TTL)
    - Single-pass conditional SQL aggregation
    - Covering index / Index-Only Scan compatible
    - Keyset (cursor-based) pagination for O(1) order navigation
    - Zero N+1 queries (lines_count annotated, customer select_related, .only() projections)
    """

    permission_classes = [HasTenantAccess]

    def get(self, request, workspace_slug, brand_id):
        brand = request.tenant.brand
        days_param = request.query_params.get("days", "30")
        try:
            days = max(0, min(int(days_param), 3650))
        except ValueError:
            days = 30

        since = timezone.now() - timedelta(days=days)

        # Scoped queryset using TenantManager / brand filtering
        orders_qs = Order.objects.filter(
            workspace=request.tenant.workspace,
            brand=brand,
            provider="shopify",
        )
        if days > 0:
            orders_qs = orders_qs.filter(Q(source_created_at__gte=since) | Q(source_created_at__isnull=True))

        # 1. Tenant-isolated cached aggregation compute function
        def compute_aggregates():
            # Single-pass SQL aggregation combining metrics and funnel
            aggs = orders_qs.aggregate(
                gross_sales=Sum("gross_amount"),
                discount_total=Sum("discount_amount"),
                tax_total=Sum("tax_amount"),
                shipping_total=Sum("shipping_amount"),
                net_sales=Sum("net_sales"),
                total_orders=Count("id"),
                placed=Count("id"),
                paid=Count("id", filter=Q(financial_status="paid")),
                fulfilled=Count("id", filter=Q(fulfillment_status="fulfilled")),
                partial=Count("id", filter=Q(fulfillment_status="partial")),
                unfulfilled=Count("id", filter=Q(fulfillment_status="unfulfilled")),
            )
            gross_val = aggs["gross_sales"] or 0
            net_val = aggs["net_sales"] or 0
            net_sales = net_val
            total_orders = aggs["total_orders"] or 0
            aov = int(round(net_sales / total_orders)) if total_orders > 0 else 0

            return {
                "metrics": {
                    "gross_sales_minor": gross_val,
                    "gross_sales": gross_val,
                    "gross_sales_paise": gross_val,
                    "discount_total_minor": aggs["discount_total"] or 0,
                    "tax_total_minor": aggs["tax_total"] or 0,
                    "shipping_total_minor": aggs["shipping_total"] or 0,
                    "net_sales_minor": net_val,
                    "net_sales": net_val,
                    "net_sales_paise": net_val,
                    "order_count": total_orders,
                    "orders": total_orders,
                    "aov_minor": aov,
                    "aov": aov,
                },
                "funnel": {
                    "placed": aggs["placed"] or 0,
                    "paid": aggs["paid"] or 0,
                    "fulfilled": aggs["fulfilled"] or 0,
                    "partial": aggs["partial"] or 0,
                    "unfulfilled": aggs["unfulfilled"] or 0,
                },
            }

        cached_summary, is_cache_hit = get_cached_tenant_data(
            workspace_slug=workspace_slug,
            brand_id=str(brand.id),
            metric_namespace="shopify_stats",
            compute_fn=compute_aggregates,
            ttl=300,
            days=days,
        )

        # 2. Keyset (Cursor-Based) Pagination for Orders feed — O(1) time
        cursor_created_at = request.query_params.get("cursor_created_at")
        cursor_id = request.query_params.get("cursor_id")
        try:
            limit = max(1, min(int(request.query_params.get("limit", 25)), 100))
        except ValueError:
            limit = 25

        recent_orders_qs = (
            orders_qs.select_related("customer")
            .annotate(lines_count=Count("lines"))
            .only(
                "id", "provider_id", "order_number", "currency",
                "gross_amount", "discount_amount", "tax_amount", "shipping_amount",
                "net_sales", "financial_status", "fulfillment_status", "source_created_at",
                "customer__first_name", "customer__last_name", "customer__email"
            )
        )

        if cursor_created_at and cursor_id:
            recent_orders_qs = recent_orders_qs.filter(
                Q(source_created_at__lt=cursor_created_at) |
                Q(source_created_at=cursor_created_at, id__lt=cursor_id)
            )

        recent_orders = list(recent_orders_qs.order_by("-source_created_at", "-id")[:limit + 1])
        has_next_page = len(recent_orders) > limit
        if has_next_page:
            paged_orders = recent_orders[:limit]
            next_cursor = {
                "cursor_created_at": paged_orders[-1].source_created_at.isoformat() if paged_orders[-1].source_created_at else None,
                "cursor_id": str(paged_orders[-1].id),
            }
        else:
            paged_orders = recent_orders
            next_cursor = None

        orders_serialized = ShopifyOrderSerializer(paged_orders, many=True).data
        # Only real line items; orders without synced lines simply contribute none.
        order_items_flattened = []
        for o in orders_serialized:
            order_items_flattened.extend(o.get("order_items") or [])

        return Response(
            {
                "brand": {
                    "id": str(brand.id),
                    "name": brand.name,
                    "currency": brand.currency,
                    "timezone": brand.timezone,
                },
                "days": days,
                "gross_sales": cached_summary["metrics"]["gross_sales_minor"],
                "gross_sales_paise": cached_summary["metrics"]["gross_sales_minor"],
                "net_sales": cached_summary["metrics"]["net_sales_minor"],
                "net_sales_paise": cached_summary["metrics"]["net_sales_minor"],
                "metrics": cached_summary["metrics"],
                "funnel": cached_summary["funnel"],
                "orders": orders_serialized,
                "order_items": order_items_flattened,
                "pagination": {
                    "limit": limit,
                    "has_next": has_next_page,
                    "next_cursor": next_cursor,
                },
                "_meta": {
                    "cache_hit": is_cache_hit,
                },
            }
        )


class ShopifySyncTriggerView(APIView):
    """
    POST /api/w/{workspace_slug}/b/{brand_id}/shopify/sync-now/
    Real sync only. No simulated success: failures are reported as failures. Rate limited (scope "sync").
    """

    permission_classes = [IsWorkspaceAnalyst]
    throttle_scope = "sync"

    def post(self, request, workspace_slug, brand_id):
        brand = request.tenant.brand
        try:
            integration = Integration.objects.get(
                workspace=request.tenant.workspace,
                brand=brand,
                provider=Integration.Provider.SHOPIFY,
            )
        except Integration.DoesNotExist:
            return Response(
                {"error": "Shopify integration not configured for this brand."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        integration.status = Integration.Status.SYNCING
        integration.save(update_fields=["status"])

        try:
            summary = sync_shopify_orders(integration)
        except ValueError as exc:
            integration.status = Integration.Status.ERROR
            integration.last_error_message = str(exc)[:500]
            integration.save(update_fields=["status", "last_error_message"])
            return Response({"error": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except Exception:
            logger.exception("Shopify sync failed for brand %s", brand.id)
            integration.status = Integration.Status.ERROR
            integration.last_error_message = "Sync failed. See server logs."
            integration.save(update_fields=["status", "last_error_message"])
            return Response({"error": "Shopify sync failed."}, status=status.HTTP_502_BAD_GATEWAY)

        invalidate_brand_cache(workspace_slug, str(brand.id))

        return Response(
            {
                "status": "success",
                "message": (
                    f"Synced {summary['records_processed']} Shopify orders "
                    f"({summary['records_created']} new, {summary['records_updated']} updated) for {brand.name}."
                ),
                "records_processed": summary["records_processed"],
                "records_created": summary["records_created"],
                "records_updated": summary["records_updated"],
                "last_synced_at": integration.last_synced_at.isoformat() if integration.last_synced_at else None,
            }
        )


class MetaAdsDashboardStatsView(APIView):
    """
    GET /api/w/{workspace_slug}/b/{brand_id}/marketing/stats/?days=30
    Returns live Meta Ads KPI performance, campaign ROAS breakdown, and daily trends.
    """

    permission_classes = [HasTenantAccess]

    def get(self, request, workspace_slug, brand_id):
        brand = request.tenant.brand
        try:
            integration = Integration.objects.get(
                workspace=request.tenant.workspace,
                brand=brand,
                provider=Integration.Provider.META_ADS,
            )
        except Integration.DoesNotExist:
            return Response(
                {
                    "connected": False,
                    "message": "Meta Ads is not connected for this brand.",
                    "summary_30d": None,
                    "summary_lifetime": None,
                    "campaigns": [],
                    "daily_trends": [],
                },
                status=status.HTTP_200_OK,
            )

        if integration.status == Integration.Status.DISCONNECTED:
            return Response(
                {
                    "connected": False,
                    "message": "Meta Ads integration is currently disconnected.",
                    "summary_30d": None,
                    "summary_lifetime": None,
                    "campaigns": [],
                    "daily_trends": [],
                },
                status=status.HTTP_200_OK,
            )

        def enhance_summary(s):
            if isinstance(s, dict):
                s = dict(s)
                rev = s.get("attributed_revenue_minor", 0)
                orders = s.get("orders", 0)
                s["conversions"] = orders
                s["purchases"] = orders
                s["conversion_count"] = orders
                s["attribution_revenue_minor"] = rev
                s["attribution_metrics"] = {"orders": orders, "revenue": rev}
            return s

        # Helper to construct payload from cached DB snapshot & facts
        def get_cached_response(error_notice=None):
            snapshot_obj = RawPayload.objects.filter(
                brand=brand,
                provider="meta_ads",
                topic="campaigns_snapshot",
            ).order_by("-created_at").first()

            facts = FactAdsDaily.objects.filter(brand=brand).order_by("-fact_date")
            daily_list = [
                {
                    "date": f.fact_date.isoformat(),
                    "spend_minor": f.spend_minor,
                    "impressions": f.impressions,
                    "clicks": f.clicks,
                    "orders": f.attributed_conversions,
                    "conversions": f.attributed_conversions,
                    "purchases": f.attributed_conversions,
                    "attributed_revenue_minor": f.attributed_revenue_minor,
                    "roas": round(f.attributed_revenue_minor / f.spend_minor, 2) if f.spend_minor > 0 else 0.0,
                }
                for f in facts[:30]
            ]

            if snapshot_obj and snapshot_obj.payload:
                payload = snapshot_obj.payload
                s30 = enhance_summary(payload.get("summary_30d"))
                slife = enhance_summary(payload.get("summary_lifetime"))
                return Response({
                    "connected": True,
                    "account": payload.get("account"),
                    "summary_30d": s30,
                    "summary_30days": s30,
                    "last_30_days": s30,
                    "past_30_days": s30,
                    "summary_lifetime": slife,
                    "all_time": slife,
                    "campaigns": payload.get("campaigns", []),
                    "daily_trends": daily_list,
                    "last_synced_at": integration.last_synced_at.isoformat() if integration.last_synced_at else None,
                    "token_expired": bool(error_notice and "expired" in error_notice.lower()),
                    "error": error_notice,
                })
            elif facts.exists():
                aggs = facts.aggregate(
                    spend=Sum("spend_minor"),
                    impr=Sum("impressions"),
                    clicks=Sum("clicks"),
                    orders=Sum("attributed_conversions"),
                    rev=Sum("attributed_revenue_minor"),
                )
                spend = aggs["spend"] or 0
                rev = aggs["rev"] or 0
                clicks = aggs["clicks"] or 0
                impr = aggs["impr"] or 0
                summary = enhance_summary({
                    "spend_minor": spend,
                    "impressions": impr,
                    "clicks": clicks,
                    "ctr": round((clicks / impr) * 100, 2) if impr > 0 else 0.0,
                    "cpc_minor": int(round(spend / clicks)) if clicks > 0 else 0,
                    "cpm_minor": int(round((spend / impr) * 1000)) if impr > 0 else 0,
                    "orders": aggs["orders"] or 0,
                    "attributed_revenue_minor": rev,
                    "roas": round(rev / spend, 2) if spend > 0 else 0.0,
                })
                return Response({
                    "connected": True,
                    "account": {"id": integration.account_identifier, "name": "Meta Ad Account"},
                    "summary_30d": summary,
                    "summary_30days": summary,
                    "last_30_days": summary,
                    "past_30_days": summary,
                    "summary_lifetime": summary,
                    "all_time": summary,
                    "campaigns": [],
                    "daily_trends": daily_list,
                    "last_synced_at": integration.last_synced_at.isoformat() if integration.last_synced_at else None,
                    "token_expired": bool(error_notice and "expired" in error_notice.lower()),
                    "error": error_notice,
                })
            return None

        # Pull fresh data if never synced or synced > 15 minutes ago
        should_sync = (
            not integration.last_synced_at
            or (timezone.now() - integration.last_synced_at).total_seconds() > 900
        )

        if not should_sync:
            cached_resp = get_cached_response()
            if cached_resp:
                return cached_resp

        try:
            res = sync_meta_ads_data(integration)
            s30 = enhance_summary(res.get("summary_30d"))
            slife = enhance_summary(res.get("summary_lifetime"))
            return Response({
                "connected": True,
                "account": res.get("account"),
                "summary_30d": s30,
                "summary_30days": s30,
                "last_30_days": s30,
                "past_30_days": s30,
                "summary_lifetime": slife,
                "all_time": slife,
                "campaigns": res.get("campaigns", []),
                "daily_trends": res.get("daily_trends", []),
                "last_synced_at": integration.last_synced_at.isoformat() if integration.last_synced_at else None,
                "token_expired": False,
            })
        except Exception as exc:
            cached_resp = get_cached_response(error_notice=str(exc))
            if cached_resp:
                return cached_resp
            return Response(
                {
                    "connected": True,
                    "token_expired": "expired" in str(exc).lower(),
                    "error": f"Failed to fetch Meta Ads insights: {exc}",
                    "last_synced_at": integration.last_synced_at.isoformat() if integration.last_synced_at else None,
                },
                status=status.HTTP_502_BAD_GATEWAY,
            )


class MetaAdsSyncTriggerView(APIView):
    """
    POST /api/w/{workspace_slug}/b/{brand_id}/marketing/sync-now/
    Triggers immediate on-demand synchronization for Meta Ads.
    Supports optional inline credential update (access_token, ad_account_id). Real sync only.
    """

    permission_classes = [IsWorkspaceAnalyst]
    throttle_scope = "sync"

    def post(self, request, workspace_slug, brand_id):
        from apps.integrations.crypto import decrypt_credentials, encrypt_credentials

        brand = request.tenant.brand
        try:
            integration = Integration.objects.get(
                workspace=request.tenant.workspace,
                brand=brand,
                provider=Integration.Provider.META_ADS,
            )
        except Integration.DoesNotExist:
            return Response(
                {"error": "Meta Ads integration not found for this brand."},
                status=status.HTTP_404_NOT_FOUND,
            )

        # Validate explicit invalid credentials passed in request body
        if "access_token" in request.data and not str(request.data.get("access_token") or "").strip():
            return Response(
                {"error": "Valid access_token is required."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if "ad_account_id" in request.data and not str(request.data.get("ad_account_id") or "").strip():
            return Response(
                {"error": "Valid ad_account_id is required."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Allow inline token update if passed in request body
        incoming_token = (request.data.get("access_token") or "").strip()
        incoming_account = (request.data.get("ad_account_id") or "").strip()
        if incoming_token:
            creds = decrypt_credentials(integration.encrypted_credentials or b"")
            creds["access_token"] = incoming_token
            if incoming_account:
                creds["ad_account_id"] = incoming_account
                integration.account_identifier = incoming_account
            integration.encrypted_credentials = encrypt_credentials(creds)
            integration.save(update_fields=["encrypted_credentials", "account_identifier"])

        integration.status = Integration.Status.SYNCING
        integration.save(update_fields=["status"])

        try:
            res = sync_meta_ads_data(integration)
        except ValueError as exc:
            return Response({"error": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except Exception as exc:
            return Response(
                {"error": f"Failed to fetch data from Meta Graph API: {exc}"},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        return Response(
            {
                "status": "success",
                "message": (
                    f"Successfully synced Meta Ads for {res['account']['name']} "
                    f"({len(res['campaigns'])} campaigns, ₹{res['summary_30d']['spend_minor']/100:,.0f} spend in last 30D)."
                ),
                "account": res["account"],
                "summary_30d": res["summary_30d"],
                "summary_lifetime": res["summary_lifetime"],
                "campaigns": res["campaigns"],
                "daily_trends": res["daily_trends"],
                "last_synced_at": integration.last_synced_at.isoformat() if integration.last_synced_at else None,
            }
        )
