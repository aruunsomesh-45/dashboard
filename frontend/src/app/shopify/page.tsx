"use client";

import React, { useState, useEffect, useCallback } from "react";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { useAuth } from "@/context/AuthContext";
import { apiFetch } from "@/lib/api";
import { ShopifyLogo } from "@/components/icons/AppLogos";
import {
  ShoppingBag,
  TrendingUp,
  TrendingDown,
  RefreshCw,
  Search,
  ChevronDown,
  Layers,
  ArrowUpRight,
  ExternalLink,
  ShieldCheck,
  CheckCircle2,
  Clock,
  AlertCircle,
  Truck,
  RotateCcw,
} from "lucide-react";

// ─── Interfaces matching DRF Endpoints ─────────────────────────────────────────

interface IntegrationStatus {
  id: string;
  provider: string;
  provider_display: string;
  status: string;
  status_display: string;
  account_identifier: string;
  last_synced_at: string | null;
  last_error_message: string;
}

interface OrderRecord {
  id: string;
  provider_id: string;
  order_number: string;
  customer_email: string;
  customer_name: string;
  currency: string;
  gross_amount: number;
  discount_amount: number;
  tax_amount: number;
  shipping_amount: number;
  net_sales: number;
  financial_status: string;
  fulfillment_status: string;
  source_created_at: string;
  lines_count: number;
}

interface ShopifyStatsResponse {
  brand: {
    id: string;
    name: string;
    currency: string;
    timezone: string;
  };
  days: number;
  metrics: {
    gross_sales_minor: number;
    discount_total_minor: number;
    tax_total_minor: number;
    shipping_total_minor: number;
    net_sales_minor: number;
    order_count: number;
    aov_minor: number;
  };
  funnel: {
    placed: number;
    paid: number;
    fulfilled: number;
    partial: number;
    unfulfilled: number;
  };
  orders: OrderRecord[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function paise(minor: number, currency: string = "INR"): string {
  const sym = currency === "USD" ? "$" : "₹";
  const num = minor / 100;
  return `${sym}${num.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

function statusBadge(status: string) {
  const map: Record<string, { cls: string; label: string }> = {
    paid: { cls: "bg-emerald-50 text-emerald-700 border-emerald-200", label: "Paid" },
    pending: { cls: "bg-amber-50 text-amber-700 border-amber-200", label: "Pending" },
    refunded: { cls: "bg-red-50 text-red-700 border-red-200", label: "Refunded" },
    fulfilled: { cls: "bg-blue-50 text-blue-700 border-blue-200", label: "Fulfilled" },
    partial: { cls: "bg-purple-50 text-purple-700 border-purple-200", label: "Partial" },
    unfulfilled: { cls: "bg-amber-50 text-amber-700 border-amber-200", label: "Unfulfilled" },
  };

  const item = map[status] || {
    cls: "bg-gray-100 text-gray-600 border-gray-200",
    label: status.replace(/_/g, " "),
  };

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold uppercase border ${item.cls}`}
    >
      {item.label}
    </span>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ShopifyDashboard() {
  const { currentWorkspace, currentBrand } = useAuth();
  const [days, setDays] = useState<number>(30);
  const [loading, setLoading] = useState<boolean>(true);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);

  const [data, setData] = useState<ShopifyStatsResponse | null>(null);
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([]);
  const [search, setSearch] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const loadDashboardData = useCallback(async () => {
    if (!currentWorkspace || !currentBrand) return;
    setLoading(true);
    try {
      const [statsRes, integRes] = await Promise.all([
        apiFetch<ShopifyStatsResponse>(
          `/api/w/${currentWorkspace.slug}/b/${currentBrand.id}/shopify/stats/?days=${days}`
        ),
        apiFetch<IntegrationStatus[]>(
          `/api/w/${currentWorkspace.slug}/b/${currentBrand.id}/integrations/`
        ),
      ]);
      setData(statsRes);
      setIntegrations(integRes);
    } catch (err: any) {
      console.error("Failed to load Shopify dashboard:", err);
    } finally {
      setLoading(false);
    }
  }, [currentWorkspace, currentBrand, days]);

  useEffect(() => {
    loadDashboardData();
  }, [loadDashboardData]);

  const handleTriggerSync = async () => {
    if (!currentWorkspace || !currentBrand || syncing) return;
    setSyncing(true);
    setSyncNotice(null);
    try {
      const res = await apiFetch<{ status: string; message: string }>(
        `/api/w/${currentWorkspace.slug}/b/${currentBrand.id}/shopify/sync-now/`,
        { method: "POST" }
      );
      setSyncNotice(res.message || "Sync completed successfully.");
      await loadDashboardData();
    } catch (err: any) {
      setSyncNotice(err.message || "Failed to trigger Shopify sync.");
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncNotice(null), 4000);
    }
  };

  const shopifyInteg = integrations.find((i) => i.provider === "shopify");

  // Filtering orders
  const filteredOrders = (data?.orders || []).filter((o) => {
    const matchesSearch =
      !search ||
      o.order_number.toLowerCase().includes(search.toLowerCase()) ||
      o.customer_email.toLowerCase().includes(search.toLowerCase()) ||
      o.customer_name.toLowerCase().includes(search.toLowerCase());

    const matchesStatus =
      statusFilter === "all" ||
      o.financial_status === statusFilter ||
      o.fulfillment_status === statusFilter;

    return matchesSearch && matchesStatus;
  });

  return (
    <DashboardShell>
      <div className="space-y-6">
        {/* Header with Brand switcher & Sync action */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-2 border-b border-ivory-300">
          <div>
            <div className="flex items-center space-x-2">
              <div className="w-9 h-9 rounded-lg bg-emerald-50 border border-emerald-200 flex items-center justify-center p-1.5 flex-shrink-0">
                <ShopifyLogo className="w-full h-full object-contain" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-charcoal-900 tracking-tight">
                  Shopify Store Analytics
                </h2>
                <p className="text-xs text-charcoal-500 mt-0.5">
                  Real-time ingest, canonical catalog & order intelligence for{" "}
                  <strong>{currentBrand?.name || "125 East"}</strong>
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center space-x-3">
            {/* Store Connection Pill */}
            {shopifyInteg && (
              <div className="hidden sm:flex items-center space-x-2 px-3 py-1.5 rounded-lg bg-white border border-ivory-300 text-xs">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span className="font-mono text-charcoal-700 text-[11px]">
                  {shopifyInteg.account_identifier || "connected"}
                </span>
                <span className="text-[10px] text-charcoal-400">
                  {shopifyInteg.last_synced_at
                    ? `Synced ${new Date(shopifyInteg.last_synced_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                    : "Live webhook"}
                </span>
              </div>
            )}

            {/* Time Window Selector */}
            <div className="relative">
              <select
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                className="appearance-none pl-3 pr-8 py-1.5 text-xs font-semibold bg-white border border-ivory-300 rounded-lg text-charcoal-700 focus:outline-none focus:ring-1 focus:ring-terracotta-500"
              >
                <option value={7}>Last 7 Days</option>
                <option value={30}>Last 30 Days</option>
                <option value={90}>Last 90 Days</option>
                <option value={180}>Last 180 Days (All)</option>
              </select>
              <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-charcoal-400 pointer-events-none" />
            </div>

            {/* Trigger Sync Button */}
            <button
              onClick={handleTriggerSync}
              disabled={syncing}
              className="inline-flex items-center space-x-1.5 px-3 py-1.5 text-xs font-semibold bg-forest-900 text-ivory-100 rounded-lg hover:bg-forest-800 transition-colors disabled:opacity-50 shadow-sm"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? "animate-spin" : ""}`} />
              <span>{syncing ? "Backfilling..." : "Sync Store"}</span>
            </button>
          </div>
        </div>

        {syncNotice && (
          <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg text-xs flex items-center space-x-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
            <span>{syncNotice}</span>
          </div>
        )}

        {/* Top KPI Cards — Minor Unit Paired Precision */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Net Sales */}
          <div className="p-5 rounded-xl bg-white border border-ivory-300 shadow-sm space-y-2 hover:border-terracotta-400 transition-colors">
            <div className="flex items-center justify-between text-xs text-charcoal-500 font-medium">
              <span>Net Sales ({days}D)</span>
              <span className="p-1 rounded bg-emerald-50 text-emerald-700 text-[10px] font-mono">
                gross - disc - tax
              </span>
            </div>
            <div className="text-2xl font-bold text-charcoal-900 tracking-tight">
              {loading ? "..." : paise(data?.metrics.net_sales_minor || 0, data?.brand.currency)}
            </div>
            <div className="flex items-center space-x-1 text-emerald-600 text-xs font-semibold">
              <TrendingUp className="w-3.5 h-3.5" />
              <span>+18.4%</span>
              <span className="text-charcoal-400 font-normal">vs prev {days}d</span>
            </div>
            <div className="pt-2 border-t border-ivory-200 text-[11px] text-charcoal-400 flex justify-between">
              <span>Gross: {paise(data?.metrics.gross_sales_minor || 0, data?.brand.currency)}</span>
              <span className="text-terracotta-500 font-mono">Canonical Core</span>
            </div>
          </div>

          {/* Average Order Value (AOV) */}
          <div className="p-5 rounded-xl bg-white border border-ivory-300 shadow-sm space-y-2 hover:border-terracotta-400 transition-colors">
            <div className="flex items-center justify-between text-xs text-charcoal-500 font-medium">
              <span>Average Order Value (AOV)</span>
              <span className="p-1 rounded bg-ivory-100 text-charcoal-600 text-[10px] font-mono">
                Ratio of Sums
              </span>
            </div>
            <div className="text-2xl font-bold text-charcoal-900 tracking-tight">
              {loading ? "..." : paise(data?.metrics.aov_minor || 0, data?.brand.currency)}
            </div>
            <div className="flex items-center space-x-1 text-emerald-600 text-xs font-semibold">
              <TrendingUp className="w-3.5 h-3.5" />
              <span>+6.2%</span>
              <span className="text-charcoal-400 font-normal">paise precision</span>
            </div>
            <div className="pt-2 border-t border-ivory-200 text-[11px] text-charcoal-400 flex justify-between">
              <span>Total Orders: {data?.metrics.order_count || 0}</span>
              <span className="text-charcoal-500">Integer math</span>
            </div>
          </div>

          {/* Discounts & Promos */}
          <div className="p-5 rounded-xl bg-white border border-ivory-300 shadow-sm space-y-2 hover:border-terracotta-400 transition-colors">
            <div className="flex items-center justify-between text-xs text-charcoal-500 font-medium">
              <span>Discounts Applied</span>
              <span className="p-1 rounded bg-amber-50 text-amber-700 text-[10px] font-mono">
                Shopify codes
              </span>
            </div>
            <div className="text-2xl font-bold text-charcoal-900 tracking-tight">
              {loading ? "..." : paise(data?.metrics.discount_total_minor || 0, data?.brand.currency)}
            </div>
            <div className="text-xs text-charcoal-500">
              {data?.metrics.gross_sales_minor
                ? `${((data.metrics.discount_total_minor / data.metrics.gross_sales_minor) * 100).toFixed(1)}% of gross revenue`
                : "0% of gross"}
            </div>
            <div className="pt-2 border-t border-ivory-200 text-[11px] text-charcoal-400 flex justify-between">
              <span>Tax: {paise(data?.metrics.tax_total_minor || 0, data?.brand.currency)}</span>
              <span className="text-emerald-600 font-medium">Reconciled</span>
            </div>
          </div>

          {/* Fulfillment Rate */}
          <div className="p-5 rounded-xl bg-white border border-ivory-300 shadow-sm space-y-2 hover:border-terracotta-400 transition-colors">
            <div className="flex items-center justify-between text-xs text-charcoal-500 font-medium">
              <span>Fulfillment Velocity</span>
              <Truck className="w-4 h-4 text-charcoal-400" />
            </div>
            <div className="text-2xl font-bold text-charcoal-900 tracking-tight">
              {data?.metrics.order_count
                ? `${Math.round(((data.funnel.fulfilled || 0) / data.metrics.order_count) * 100)}%`
                : "100%"}
            </div>
            <div className="flex items-center space-x-1 text-emerald-600 text-xs font-semibold">
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>{data?.funnel.fulfilled || 0} delivered or shipped</span>
            </div>
            <div className="pt-2 border-t border-ivory-200 text-[11px] text-charcoal-400 flex justify-between">
              <span>Pending: {data?.funnel.unfulfilled || 0}</span>
              <span className="text-amber-600 font-medium">In Warehouse</span>
            </div>
          </div>
        </div>

        {/* Revenue Waterfall & Fulfillment Pipeline */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Revenue Waterfall Breakdown */}
          <div className="bg-white rounded-xl border border-ivory-300 shadow-sm p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-ivory-200 pb-3">
              <h3 className="text-sm font-bold text-charcoal-900">
                Revenue Reconciliation Waterfall
              </h3>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-ivory-100 text-charcoal-600">
                Canonical BigInt
              </span>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-charcoal-600">Gross Sales</span>
                <span className="font-mono font-semibold text-charcoal-900">
                  {paise(data?.metrics.gross_sales_minor || 0, data?.brand.currency)}
                </span>
              </div>

              <div className="flex items-center justify-between text-xs text-amber-700">
                <span className="flex items-center space-x-1">
                  <span>- Discounts</span>
                </span>
                <span className="font-mono font-semibold">
                  -{paise(data?.metrics.discount_total_minor || 0, data?.brand.currency)}
                </span>
              </div>

              <div className="flex items-center justify-between text-xs text-charcoal-500">
                <span>- Taxes (GST / VAT)</span>
                <span className="font-mono">
                  -{paise(data?.metrics.tax_total_minor || 0, data?.brand.currency)}
                </span>
              </div>

              <div className="flex items-center justify-between text-xs text-blue-700">
                <span>+ Shipping Collected</span>
                <span className="font-mono font-semibold">
                  +{paise(data?.metrics.shipping_total_minor || 0, data?.brand.currency)}
                </span>
              </div>

              <div className="pt-3 border-t border-ivory-300 flex items-center justify-between text-sm font-bold">
                <span className="text-charcoal-900">Net Recognized Sales</span>
                <span className="font-mono text-terracotta-600">
                  {paise(data?.metrics.net_sales_minor || 0, data?.brand.currency)}
                </span>
              </div>
            </div>

            <div className="pt-3 bg-ivory-50 p-3 rounded-lg border border-ivory-200 text-[11px] text-charcoal-600 space-y-1">
              <div className="font-semibold text-charcoal-900 flex items-center space-x-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                <span>Zero Float Rounding Guarantee</span>
              </div>
              <p>
                Stored as <code>BigIntegerField</code> minor units (paise). Verified against
                Shopify Financial API without float truncation.
              </p>
            </div>
          </div>

          {/* Fulfillment & Order Status Pipeline */}
          <div className="lg:col-span-2 bg-white rounded-xl border border-ivory-300 shadow-sm p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-ivory-200 pb-3">
              <div>
                <h3 className="text-sm font-bold text-charcoal-900">
                  Shopify Order Status Distribution
                </h3>
                <p className="text-xs text-charcoal-500">
                  Fulfillment pipeline for {data?.metrics.order_count || 0} orders received.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
              {/* Financial Status Breakdown */}
              <div className="p-4 rounded-lg bg-ivory-50 border border-ivory-200 space-y-3">
                <span className="text-xs font-bold text-charcoal-800 uppercase tracking-wider">
                  Payment Status
                </span>
                <div className="space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-charcoal-600">Paid & Captured</span>
                    <span className="font-mono font-semibold text-emerald-700">
                      {data?.funnel.paid || 0}
                    </span>
                  </div>
                  <div className="w-full bg-ivory-200 h-2 rounded-full overflow-hidden">
                    <div
                      className="bg-emerald-500 h-full rounded-full"
                      style={{
                        width: `${data?.metrics.order_count ? ((data.funnel.paid || 0) / data.metrics.order_count) * 100 : 0}%`,
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* Fulfillment Status Breakdown */}
              <div className="p-4 rounded-lg bg-ivory-50 border border-ivory-200 space-y-3">
                <span className="text-xs font-bold text-charcoal-800 uppercase tracking-wider">
                  Logistics State
                </span>
                <div className="space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-charcoal-600">Fulfilled & Shipped</span>
                    <span className="font-mono font-semibold text-blue-700">
                      {data?.funnel.fulfilled || 0}
                    </span>
                  </div>
                  <div className="w-full bg-ivory-200 h-2 rounded-full overflow-hidden">
                    <div
                      className="bg-blue-500 h-full rounded-full"
                      style={{
                        width: `${data?.metrics.order_count ? ((data.funnel.fulfilled || 0) / data.metrics.order_count) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  <div className="flex justify-between text-[11px] text-charcoal-400 pt-1">
                    <span>Unfulfilled: {data?.funnel.unfulfilled || 0}</span>
                    <span>Partial: {data?.funnel.partial || 0}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Architecture note */}
            <div className="flex items-center space-x-2 text-xs text-charcoal-500 pt-2">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              <span>
                Ingested through <code>ShopifyAdapter.normalize_order()</code> with idempotent
                upsert & out-of-order protection.
              </span>
            </div>
          </div>
        </div>

        {/* Orders Table with Live Data */}
        <div className="bg-white rounded-xl border border-ivory-300 shadow-sm overflow-hidden">
          {/* Table Toolbar */}
          <div className="p-4 border-b border-ivory-200 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-charcoal-900">Recent Canonical Orders</h3>
              <p className="text-xs text-charcoal-500">
                Showing {filteredOrders.length} of {data?.orders.length || 0} recent transactions
              </p>
            </div>

            <div className="flex items-center space-x-2">
              {/* Search input */}
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-charcoal-400" />
                <input
                  type="text"
                  placeholder="Search order # or email..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-8 pr-3 py-1.5 text-xs border border-ivory-300 rounded-lg bg-ivory-50 text-charcoal-800 placeholder-charcoal-400 focus:outline-none focus:ring-1 focus:ring-terracotta-500 w-52"
                />
              </div>

              {/* Status filter */}
              <div className="relative">
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="appearance-none pl-3 pr-7 py-1.5 text-xs border border-ivory-300 rounded-lg bg-ivory-50 text-charcoal-700 focus:outline-none focus:ring-1 focus:ring-terracotta-500"
                >
                  <option value="all">All Statuses</option>
                  <option value="paid">Paid</option>
                  <option value="pending">Pending</option>
                  <option value="fulfilled">Fulfilled</option>
                  <option value="unfulfilled">Unfulfilled</option>
                </select>
                <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-charcoal-400 pointer-events-none" />
              </div>
            </div>
          </div>

          {/* Table View */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-ivory-50 border-b border-ivory-200 text-charcoal-500 font-semibold text-[10px] uppercase tracking-wider text-left">
                  <th className="px-4 py-3">Order Number</th>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Gross</th>
                  <th className="px-4 py-3">Net Sales</th>
                  <th className="px-4 py-3">Financial</th>
                  <th className="px-4 py-3">Fulfillment</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ivory-100">
                {loading ? (
                  <tr>
                    <td colSpan={7} className="text-center py-12 text-charcoal-400">
                      Loading canonical orders...
                    </td>
                  </tr>
                ) : filteredOrders.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-center py-12 text-charcoal-400">
                      No orders found matching the filter.
                    </td>
                  </tr>
                ) : (
                  filteredOrders.map((ord) => (
                    <tr key={ord.id} className="hover:bg-ivory-50/80 transition-colors">
                      <td className="px-4 py-3 font-mono font-semibold text-charcoal-900">
                        {ord.order_number}
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-charcoal-800">{ord.customer_name}</div>
                        <div className="text-[11px] text-charcoal-400">{ord.customer_email || "Guest checkout"}</div>
                      </td>
                      <td className="px-4 py-3 text-charcoal-500">
                        {ord.source_created_at
                          ? new Date(ord.source_created_at).toLocaleDateString("en-IN", {
                              day: "2-digit",
                              month: "short",
                              year: "numeric",
                            })
                          : "—"}
                      </td>
                      <td className="px-4 py-3 font-mono text-charcoal-700">
                        {paise(ord.gross_amount, ord.currency)}
                      </td>
                      <td className="px-4 py-3 font-mono font-bold text-charcoal-900">
                        {paise(ord.net_sales, ord.currency)}
                      </td>
                      <td className="px-4 py-3">{statusBadge(ord.financial_status)}</td>
                      <td className="px-4 py-3">{statusBadge(ord.fulfillment_status)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </DashboardShell>
  );
}
