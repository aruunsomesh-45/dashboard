"use client";

import React, { useState, useEffect } from "react";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { useAuth } from "@/context/AuthContext";
import { apiFetch } from "@/lib/api";
import {
  ShopifyLogo,
  RazorpayLogo,
  DelhiveryLogo,
  MetaAdsLogo,
  InstagramLogo,
} from "@/components/icons/AppLogos";
import {
  TrendingUp,
  ShoppingBag,
  CreditCard,
  Truck,
  Megaphone,
  Instagram,
  ArrowUpRight,
  ShieldCheck,
  CheckCircle2,
  ChevronDown,
} from "lucide-react";

interface OverviewMetrics {
  shopify: { revenue_per_day_minor: number; net_sales_minor: number; total_orders: number };
  meta_ads: { roas: number | null; cac_minor: number | null };
  delhivery: { delivery_pct: number | null; orders_to_be_shipped: number; total_shipments: number };
  razorpay: { open_disputes: number | null; captured_payments: number; total_attempts: number; connected: boolean };
  instagram: { engagement_rate_pct: number | null };
}

const EMPTY_METRICS: OverviewMetrics = {
  shopify: { revenue_per_day_minor: 0, net_sales_minor: 0, total_orders: 0 },
  meta_ads: { roas: null, cac_minor: null },
  delhivery: { delivery_pct: null, orders_to_be_shipped: 0, total_shipments: 0 },
  razorpay: { open_disputes: null, captured_payments: 0, total_attempts: 0, connected: false },
  instagram: { engagement_rate_pct: null },
};

const fmtX = (v: number | null) => (v == null ? "—" : `${v}x`);
const fmtPct = (v: number | null) => (v == null ? "—" : `${v}%`);
const fmtNum = (v: number | null) => (v == null ? "—" : String(v));

function paise(minor: number): string {
  return "₹" + (minor / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

export default function OverviewPage() {
  const { currentWorkspace, currentBrand } = useAuth();
  const [days, setDays] = useState<number>(30);
  const [loading, setLoading] = useState<boolean>(false);

  const [metrics, setMetrics] = useState<OverviewMetrics>(EMPTY_METRICS);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchStats() {
      if (!currentWorkspace || !currentBrand) return;
      const base = `/api/w/${currentWorkspace.slug}/b/${currentBrand.id}`;
      setLoading(true);
      setError(null);
      try {
        // Every figure below comes from a backend endpoint computed from stored data; unavailable inputs are null.
        const [shop, kpi, pay] = await Promise.all([
          apiFetch<any>(`${base}/shopify/stats/?days=${days}`),
          apiFetch<any>(`${base}/metrics/?days=${days}`),
          apiFetch<any>(`${base}/payments/stats/`),
        ]);
        const m = kpi?.metrics ?? {};
        const val = (k: string): number | null => (m[k]?.available === false ? null : m[k]?.value ?? null);
        const net = shop?.metrics?.net_sales_minor || 0;
        setMetrics({
          shopify: {
            revenue_per_day_minor: days > 0 ? Math.round(net / days) : net,
            net_sales_minor: net,
            total_orders: shop?.metrics?.order_count || 0,
          },
          meta_ads: { roas: val("blended_roas"), cac_minor: val("blended_cac") },
          delhivery: {
            delivery_pct: val("delivery_success_pct"),
            orders_to_be_shipped: val("orders_to_be_shipped") ?? 0,
            total_shipments: 0,
          },
          razorpay: {
            open_disputes: val("number_of_disputes"),
            captured_payments: pay?.payment_count ?? 0,
            total_attempts: pay?.attempt_count ?? 0,
            connected: !!pay?.connected,
          },
          instagram: { engagement_rate_pct: val("organic_engagement") },
        });
      } catch (err: any) {
        setMetrics(EMPTY_METRICS);
        setError(err?.message || "Failed to load overview metrics");
      } finally {
        setLoading(false);
      }
    }

    fetchStats();
  }, [currentWorkspace, currentBrand, days]);

  return (
    <DashboardShell>
      <div className="space-y-6 font-sans">
        {/* Header Banner */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-2 border-b border-ivory-300">
          <div>
            <h2 className="text-xl font-bold text-charcoal-900 tracking-tight">
              Executive Overview
            </h2>
            <p className="text-xs text-charcoal-500 mt-0.5">
              Live normalized metrics cockpit for{" "}
              <strong>{currentBrand?.name || "125 East"}</strong> as per calculations specification.
            </p>
          </div>

          <div className="flex items-center space-x-3">
            <div className="relative">
              <select
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                className="appearance-none pl-3 pr-8 py-1.5 text-xs font-semibold bg-white border border-ivory-300 rounded-lg text-charcoal-700 focus:outline-none focus:ring-1 focus:ring-terracotta-500 shadow-sm"
              >
                <option value={7}>Last 7 Days</option>
                <option value={30}>Last 30 Days</option>
                <option value={90}>Last 90 Days</option>
              </select>
              <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-charcoal-400 pointer-events-none" />
            </div>

            <span className="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-md bg-emerald-50 text-emerald-700 text-xs font-medium border border-emerald-200 shadow-sm">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span>{loading ? "Loading…" : "From stored data"}</span>
            </span>
          </div>
        </div>

        {error && (
          <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
            {error}
          </div>
        )}

        {/* 7 Core Requested Overview Metrics Grid (calculations.md lines 3 to 9) */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-3.5">
          {/* 1. Shopify: Revenue / Day */}
          <div className="p-4 rounded-xl bg-white border border-ivory-300 shadow-sm space-y-2 hover:border-emerald-500 transition-colors">
            <div className="flex items-center justify-between text-xs text-charcoal-500 font-medium">
              <span className="flex items-center space-x-1.5">
                <ShopifyLogo className="w-4 h-4 flex-shrink-0" />
                <span className="font-semibold text-charcoal-800">Shopify</span>
              </span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 font-semibold">
                Daily Net
              </span>
            </div>
            <div>
              <div className="text-[11px] text-charcoal-500">Revenue / Day</div>
              <div className="text-xl font-bold text-charcoal-900 tracking-tight mt-0.5">
                {loading ? "..." : paise(metrics.shopify.revenue_per_day_minor)}
              </div>
            </div>
            <div className="text-[10px] text-charcoal-400 font-mono truncate" title="∑(Gross - Discounts - Refunds - Taxes)">
              ∑(Gross - Disc - Ref - Tax)
            </div>
          </div>

          {/* 2. Meta Ads: Blended ROAS */}
          <div className="p-4 rounded-xl bg-white border border-ivory-300 shadow-sm space-y-2 hover:border-purple-500 transition-colors">
            <div className="flex items-center justify-between text-xs text-charcoal-500 font-medium">
              <span className="flex items-center space-x-1.5">
                <MetaAdsLogo className="w-4 h-4 flex-shrink-0" />
                <span className="font-semibold text-charcoal-800">Meta Ads</span>
              </span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 font-semibold">
                28D Window
              </span>
            </div>
            <div>
              <div className="text-[11px] text-charcoal-500">Blended ROAS</div>
              <div className="text-xl font-bold text-charcoal-900 tracking-tight mt-0.5">
                {fmtX(metrics.meta_ads.roas)}
              </div>
            </div>
            <div className="text-[10px] text-charcoal-400 font-mono truncate" title="∑Attributed Revenue / ∑Meta Ad Spend">
              ∑Revenue / ∑Spend
            </div>
          </div>

          {/* 3. Meta Ads: Blended CAC */}
          <div className="p-4 rounded-xl bg-white border border-ivory-300 shadow-sm space-y-2 hover:border-purple-500 transition-colors">
            <div className="flex items-center justify-between text-xs text-charcoal-500 font-medium">
              <span className="flex items-center space-x-1.5">
                <MetaAdsLogo className="w-4 h-4 flex-shrink-0" />
                <span className="font-semibold text-charcoal-800">Meta Ads</span>
              </span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 font-semibold">
                Acquisition
              </span>
            </div>
            <div>
              <div className="text-[11px] text-charcoal-500">Blended CAC</div>
              <div className="text-xl font-bold text-charcoal-900 tracking-tight mt-0.5">
                {metrics.meta_ads.cac_minor == null ? "—" : paise(metrics.meta_ads.cac_minor)}
              </div>
            </div>
            <div className="text-[10px] text-charcoal-400 font-mono truncate" title="∑Ad Spend / ∑New Customers Acquired">
              ∑Spend / ∑New Cust
            </div>
          </div>

          {/* 4. Delhivery: Delivery Success % */}
          <div className="p-4 rounded-xl bg-white border border-ivory-300 shadow-sm space-y-2 hover:border-blue-500 transition-colors">
            <div className="flex items-center justify-between text-xs text-charcoal-500 font-medium">
              <span className="flex items-center space-x-1.5">
                <DelhiveryLogo className="w-4 h-4 flex-shrink-0" />
                <span className="font-semibold text-charcoal-800">Delhivery</span>
              </span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 font-semibold">
                Delivered
              </span>
            </div>
            <div>
              <div className="text-[11px] text-charcoal-500">Delivery Success %</div>
              <div className="text-xl font-bold text-charcoal-900 tracking-tight mt-0.5">
                {fmtPct(metrics.delhivery.delivery_pct)}
              </div>
            </div>
            <div className="text-[10px] text-charcoal-400 font-mono truncate" title="Count(Delivered) / Count(Total) * 100">
              Delivered / Total * 100
            </div>
          </div>

          {/* 5. Delhivery: Orders to be Shipped */}
          <div className="p-4 rounded-xl bg-white border border-ivory-300 shadow-sm space-y-2 hover:border-amber-500 transition-colors">
            <div className="flex items-center justify-between text-xs text-charcoal-500 font-medium">
              <span className="flex items-center space-x-1.5">
                <DelhiveryLogo className="w-4 h-4 flex-shrink-0" />
                <span className="font-semibold text-charcoal-800">Delhivery</span>
              </span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 font-semibold">
                Pending
              </span>
            </div>
            <div>
              <div className="text-[11px] text-charcoal-500">Orders to be Shipped</div>
              <div className="text-xl font-bold text-amber-700 tracking-tight mt-0.5">
                {metrics.delhivery.orders_to_be_shipped}
              </div>
            </div>
            <div className="text-[10px] text-charcoal-400 font-mono truncate" title="Count(Orders where Paid and Unfulfilled)">
              Paid &amp; Unfulfilled
            </div>
          </div>

          {/* 6. Razorpay: Number of Disputes */}
          <div className="p-4 rounded-xl bg-white border border-ivory-300 shadow-sm space-y-2 hover:border-red-500 transition-colors">
            <div className="flex items-center justify-between text-xs text-charcoal-500 font-medium">
              <span className="flex items-center space-x-1.5">
                <RazorpayLogo className="w-4 h-4 flex-shrink-0" />
                <span className="font-semibold text-charcoal-800">Razorpay</span>
              </span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 font-semibold">
                Claims
              </span>
            </div>
            <div>
              <div className="text-[11px] text-charcoal-500">Number of Disputes</div>
              <div className="text-xl font-bold text-charcoal-900 tracking-tight mt-0.5">
                {fmtNum(metrics.razorpay.open_disputes)}
              </div>
            </div>
            <div className="text-[10px] text-charcoal-400 font-mono truncate" title="Count(Dispute records where status is open/under_review)">
              Open / Under Review
            </div>
          </div>

          {/* 7. Instagram: Organic Engagement */}
          <div className="p-4 rounded-xl bg-white border border-ivory-300 shadow-sm space-y-2 hover:border-rose-500 transition-colors">
            <div className="flex items-center justify-between text-xs text-charcoal-500 font-medium">
              <span className="flex items-center space-x-1.5">
                <InstagramLogo className="w-4 h-4 flex-shrink-0" />
                <span className="font-semibold text-charcoal-800">Instagram</span>
              </span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 font-semibold">
                Organic
              </span>
            </div>
            <div>
              <div className="text-[11px] text-charcoal-500">Organic Engagement</div>
              <div className="text-xl font-bold text-charcoal-900 tracking-tight mt-0.5">
                {fmtPct(metrics.instagram.engagement_rate_pct)}
              </div>
            </div>
            <div className="text-[10px] text-charcoal-400 font-mono truncate" title="∑(Likes+Comments+Saves) / Followers * 100">
              ∑Engagements / Fans
            </div>
          </div>
        </div>

        {/* Channel Health & Operational Detail */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Channel Operations */}
          <div className="lg:col-span-2 bg-white rounded-xl border border-ivory-300 shadow-sm p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-ivory-200 pb-3">
              <div>
                <h3 className="text-sm font-bold text-charcoal-900">
                  5-Channel Unified Operations
                </h3>
                <p className="text-xs text-charcoal-500">
                  Data health, syncing status, and reconciliation accuracy.
                </p>
              </div>
            </div>

            <div className="divide-y divide-ivory-200 text-xs">
              <div className="py-3 flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 rounded-lg bg-emerald-50 border border-emerald-100 flex items-center justify-center p-1.5 flex-shrink-0">
                    <ShopifyLogo className="w-full h-full object-contain" />
                  </div>
                  <div>
                    <div className="font-semibold text-charcoal-900">Shopify Store Catalog &amp; Orders</div>
                    <div className="text-[11px] text-charcoal-500">Revenue / Day live rollup • Paise precision</div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-semibold text-charcoal-900">{paise(metrics.shopify.revenue_per_day_minor)}/day</div>
                  <span className="text-[10px] text-charcoal-500 font-medium">{metrics.shopify.total_orders} orders</span>
                </div>
              </div>

              <div className="py-3 flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 rounded-lg bg-blue-50 border border-blue-100 flex items-center justify-center p-1.5 flex-shrink-0">
                    <MetaAdsLogo className="w-full h-full object-contain" />
                  </div>
                  <div>
                    <div className="font-semibold text-charcoal-900">Meta Marketing API</div>
                    <div className="text-[11px] text-charcoal-500">28-day purchase conversion window • Blended CAC tracking</div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-semibold text-charcoal-900">{fmtX(metrics.meta_ads.roas)} ROAS</div>
                  <span className="text-[10px] text-charcoal-500 font-medium">{metrics.meta_ads.roas == null ? "No ads data" : "Attributed"}</span>
                </div>
              </div>

              <div className="py-3 flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center p-1 flex-shrink-0">
                    <DelhiveryLogo className="w-full h-full object-contain" />
                  </div>
                  <div>
                    <div className="font-semibold text-charcoal-900">Delhivery Express &amp; Logistics</div>
                    <div className="text-[11px] text-charcoal-500">Canonical carrier state machine • AWB fulfillment queue</div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-semibold text-charcoal-900">{fmtPct(metrics.delhivery.delivery_pct)} Delivered</div>
                  <span className="text-[10px] text-amber-600 font-medium">{metrics.delhivery.orders_to_be_shipped} unfulfilled</span>
                </div>
              </div>

              <div className="py-3 flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 rounded-lg bg-blue-50 border border-blue-100 flex items-center justify-center p-1 flex-shrink-0">
                    <RazorpayLogo className="w-full h-full object-contain" />
                  </div>
                  <div>
                    <div className="font-semibold text-charcoal-900">Razorpay Payment Gateway</div>
                    <div className="text-[11px] text-charcoal-500">Signed webhook ingestion</div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-semibold text-charcoal-900">{fmtNum(metrics.razorpay.open_disputes)} Disputes</div>
                  <span className="text-[10px] text-charcoal-500 font-medium">{metrics.razorpay.captured_payments} of {metrics.razorpay.total_attempts} captured</span>
                </div>
              </div>

              <div className="py-3 flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-amber-50 via-rose-50 to-purple-50 border border-rose-100 flex items-center justify-center p-1.5 flex-shrink-0">
                    <InstagramLogo className="w-full h-full object-contain" />
                  </div>
                  <div>
                    <div className="font-semibold text-charcoal-900">Instagram Organic Presence</div>
                    <div className="text-[11px] text-charcoal-500">Daily midnight profile snapshot • Reel discovery analysis</div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-semibold text-charcoal-900">{fmtPct(metrics.instagram.engagement_rate_pct)} Eng. Rate</div>
                  <span className="text-[10px] text-charcoal-500 font-medium">{metrics.instagram.engagement_rate_pct == null ? "Not connected" : "Organic"}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Intelligence Checklist */}
          <div className="bg-white rounded-xl border border-ivory-300 shadow-sm p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-ivory-200 pb-3">
              <div className="flex items-center space-x-2">
                <ShieldCheck className="w-4 h-4 text-emerald-600" />
                <h3 className="text-sm font-bold text-charcoal-900">
                  Intelligence Guarantees
                </h3>
              </div>

            </div>

            <div className="space-y-3 text-xs">
              <div className="p-3 rounded-lg bg-ivory-50 border border-ivory-200 space-y-1">
                <div className="font-semibold text-charcoal-900">Zero Float Drift</div>
                <p className="text-[11px] text-charcoal-500">
                  All money metrics in Shopify, Razorpay, and Meta are computed in integer paise before UI display.
                </p>
              </div>

              <div className="p-3 rounded-lg bg-ivory-50 border border-ivory-200 space-y-1">
                <div className="font-semibold text-charcoal-900">Deterministic Multi-Payment Links</div>
                <p className="text-[11px] text-charcoal-500">
                  Multiple payments link strictly on gateway reference and order IDs without name/amount collisions.
                </p>
              </div>

              <div className="p-3 rounded-lg bg-ivory-50 border border-ivory-200 space-y-1">
                <div className="font-semibold text-charcoal-900">Safe Logistics State Machine</div>
                <p className="text-[11px] text-charcoal-500">
                  Courier tracking codes safely map to canonical states (Delivered, In Transit, NDR) with safe in-transit fallback.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </DashboardShell>
  );
}
