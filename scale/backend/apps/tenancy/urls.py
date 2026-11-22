from django.urls import re_path

from apps.alerts.views import (
    AlertAcknowledgeView,
    AlertResolveView,
    WorkspaceAlertListView,
)
from apps.analytics.views import MetricsQueryAPIView
from apps.integrations.logistics_views import (
    LogisticsNdrActionView,
    LogisticsShipmentsView,
    LogisticsSummaryView,
    LogisticsTrackingView,
)
from apps.integrations.payments_views import RazorpayPaymentStatsView, RazorpayTransactionsView
from apps.integrations.views import (
    BrandIntegrationListView,
    MetaAdsDashboardStatsView,
    MetaAdsSyncTriggerView,
    ShopifyDashboardStatsView,
    ShopifySyncTriggerView,
)

from .views import (
    BrandListCreateView,
    InviteAcceptView,
    InviteCreateView,
    MemberDetailView,
    MemberListView,
    WorkspaceDetailView,
    WorkspaceListCreateView,
)

urlpatterns = [
    # Global workspace operations
    re_path(r"^/?$", WorkspaceListCreateView.as_view(), name="workspace-list-create"),
    re_path(r"^invites/accept/?$", InviteAcceptView.as_view(), name="invite-accept"),
    # Brand scoped integration & shopify operations
    re_path(
        r"^(?P<workspace_slug>[-\w]+)/b/(?P<brand_id>[0-9a-f-]+)/integrations/?$",
        BrandIntegrationListView.as_view(),
        name="brand-integrations",
    ),
    re_path(
        r"^(?P<workspace_slug>[-\w]+)/b/(?P<brand_id>[0-9a-f-]+)/shopify/stats/?$",
        ShopifyDashboardStatsView.as_view(),
        name="shopify-dashboard-stats",
    ),
    re_path(
        r"^(?P<workspace_slug>[-\w]+)/b/(?P<brand_id>[0-9a-f-]+)/shopify/intelligence/?$",
        ShopifyDashboardStatsView.as_view(),
        name="shopify-dashboard-intelligence",
    ),
    re_path(
        r"^(?P<workspace_slug>[-\w]+)/b/(?P<brand_id>[0-9a-f-]+)/shopify/sync-now/?$",
        ShopifySyncTriggerView.as_view(),
        name="shopify-sync-trigger",
    ),
    re_path(
        r"^(?P<workspace_slug>[-\w]+)/b/(?P<brand_id>[0-9a-f-]+)/marketing/stats/?$",
        MetaAdsDashboardStatsView.as_view(),
        name="meta-dashboard-stats",
    ),
    re_path(
        r"^(?P<workspace_slug>[-\w]+)/b/(?P<brand_id>[0-9a-f-]+)/marketing/sync-now/?$",
        MetaAdsSyncTriggerView.as_view(),
        name="meta-sync-trigger",
    ),
    re_path(
        r"^(?P<workspace_slug>[-\w]+)/b/(?P<brand_id>[0-9a-f-]+)/metrics/?$",
        MetricsQueryAPIView.as_view(),
        name="brand-metrics-query",
    ),
    # Razorpay Payment Intelligence Operations
    re_path(
        r"^(?P<workspace_slug>[-\w]+)/b/(?P<brand_id>[0-9a-f-]+)/payments/stats/?$",
        RazorpayPaymentStatsView.as_view(),
        name="razorpay-payment-stats",
    ),
    re_path(
        r"^(?P<workspace_slug>[-\w]+)/b/(?P<brand_id>[0-9a-f-]+)/payments/transactions/?$",
        RazorpayTransactionsView.as_view(),
        name="razorpay-transactions",
    ),
    # Delhivery / Logistics Operations
    re_path(
        r"^(?P<workspace_slug>[-\w]+)/b/(?P<brand_id>[0-9a-f-]+)/logistics/summary/?$",
        LogisticsSummaryView.as_view(),
        name="logistics-summary",
    ),
    re_path(
        r"^(?P<workspace_slug>[-\w]+)/b/(?P<brand_id>[0-9a-f-]+)/logistics/shipments/?$",
        LogisticsShipmentsView.as_view(),
        name="logistics-shipments",
    ),
    re_path(
        r"^(?P<workspace_slug>[-\w]+)/b/(?P<brand_id>[0-9a-f-]+)/logistics/track/(?P<awb_code>[-\w]+)/?$",
        LogisticsTrackingView.as_view(),
        name="logistics-track",
    ),
    re_path(
        r"^(?P<workspace_slug>[-\w]+)/b/(?P<brand_id>[0-9a-f-]+)/logistics/ndr/(?P<awb_code>[-\w]+)/action/?$",
        LogisticsNdrActionView.as_view(),
        name="logistics-ndr-action",
    ),
    # Workspace deterministic alerts center
    re_path(
        r"^(?P<workspace_slug>[-\w]+)/alerts/?$",
        WorkspaceAlertListView.as_view(),
        name="workspace-alerts-list",
    ),
    re_path(
        r"^(?P<workspace_slug>[-\w]+)/alerts/(?P<alert_id>[0-9a-f-]+)/acknowledge/?$",
        AlertAcknowledgeView.as_view(),
        name="alert-acknowledge",
    ),
    re_path(
        r"^(?P<workspace_slug>[-\w]+)/alerts/(?P<alert_id>[0-9a-f-]+)/resolve/?$",
        AlertResolveView.as_view(),
        name="alert-resolve",
    ),
    # Tenant-scoped operations via URL slug
    re_path(r"^(?P<workspace_slug>[-\w]+)/?$", WorkspaceDetailView.as_view(), name="workspace-detail"),
    re_path(r"^(?P<workspace_slug>[-\w]+)/brands/?$", BrandListCreateView.as_view(), name="brand-list-create"),
    re_path(r"^(?P<workspace_slug>[-\w]+)/members/?$", MemberListView.as_view(), name="workspace-members"),
    re_path(
        r"^(?P<workspace_slug>[-\w]+)/members/(?P<member_id>[0-9a-f-]+)/?$",
        MemberDetailView.as_view(),
        name="workspace-member-detail",
    ),
    re_path(r"^(?P<workspace_slug>[-\w]+)/invites/?$", InviteCreateView.as_view(), name="workspace-invites"),
]
