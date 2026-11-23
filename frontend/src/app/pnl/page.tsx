"use client";

import React, { useState, useEffect } from "react";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { useAuth } from "@/context/AuthContext";
import { apiFetch } from "@/lib/api";
import { ShopifyLogo, MetaAdsLogo } from "@/components/icons/AppLogos";
import { ReceiptText, ChevronDown, ShieldCheck, Sparkles, Info } from "lucide-react";

// Computed server-side by GET /api/w/:slug/b/:brand/pnl (route.ts profitAndLoss). null = no data source
// for that line (shown as "—", never estimated silently). COGS, gateway fees and freight are benchmark
// estimates and are labelled as such on the page.
interface PnLResponse {
  days: number;
  lines: {
    gross_sales_minor: number;
    discounts_minor: number;
    refunds_minor: number;
    net_revenue_minor: number;
    cogs_minor: number;
    gross_margin_minor: number;
    ad_spend_minor: number | null;
    gateway_charges_minor: number;
    shipping_costs_minor: number;
    cm1_minor: number;
    fixed_overhead_minor: number | null;
    ebitda_minor: number | null;
  };
  pct_of_net: Record<
    "gross_sales" | "discounts" | "refunds" | "cogs" | "gross_margin" | "ad_spend" | "gateway_charges" | "shipping_costs" | "cm1" | "ebitda",
    number | null
  >;
  memo: { tax_collected_minor: number; shipping_charged_minor: number; partially_refunded_order_count: number };
  assumptions: { cogs_pct_of_net: number; gateway_fee_pct_of_net: number; freight_per_order_minor: number };
  sources: { ad_spend: "meta_ads" | "not_connected" };
}

const DEFAULT_ASSUMPTIONS = { cogs_pct_of_net: 35, gateway_fee_pct_of_net: 2, freight_per_order_minor: 7500 };

const pctVal = (v: number | null | undefined): string => (v == null ? "—" : `${v.toFixed(1)}%`);

function paise(minor: number | null | undefined): string {
  if (minor == null) return "—";
  const isNeg = minor < 0;
  const abs = Math.abs(minor);
  const formatted = "₹" + (abs / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 });
  return isNeg ? `−${formatted}` : formatted;
}

/** A deduction: "−₹1,234"; "₹0" when zero; "—" when there is no data source. */
const minus = (minor: number | null | undefined) => (minor == null ? "—" : minor === 0 ? paise(0) : "−" + paise(minor));

export default function PnLPage() {
  const { currentWorkspace, currentBrand } = useAuth();
  const [days, setDays] = useState<number>(30);
  const [loading, setLoading] = useState<boolean>(false);
  const [data, setData] = useState<PnLResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadPnL() {
      if (!currentWorkspace || !currentBrand) return;
      try {
        setLoading(true);
        setError(null);
        const res = await apiFetch<PnLResponse>(`/api/w/${currentWorkspace.slug}/b/${currentBrand.id}/pnl/?days=${days}`);
        if (!cancelled) setData(res);
      } catch (err: any) {
        if (!cancelled) {
          setData(null);
          setError(err?.message || "Failed to load P&L data");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadPnL();
    return () => {
      cancelled = true;
    };
  }, [currentWorkspace, currentBrand, days]);

  const l = data?.lines;
  const p = data?.pct_of_net;
  const a = data?.assumptions ?? DEFAULT_ASSUMPTIONS;
  const show = (v: string) => (loading ? "..." : v);

  return (
    <DashboardShell>
      <div className="space-y-6 font-sans">
        {error && (
          <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
            {error}
          </div>
        )}
        <div className="p-3.5 rounded-xl bg-amber-50/80 border border-amber-200 text-xs text-amber-950 flex flex-col sm:flex-row sm:items-center justify-between gap-2 shadow-sm">
          <div className="flex items-center space-x-2.5">
            <Info className="w-4 h-4 text-amber-600 flex-shrink-0" />
            <span>
              <strong>Some costs are estimates.</strong> Revenue, discounts, refunds and Meta ad spend come from your synced
              data. COGS ({a.cogs_pct_of_net}% of net revenue), payment gateway fees ({a.gateway_fee_pct_of_net}%) and forward
              freight ({paise(a.freight_per_order_minor)} per order) are industry benchmarks until real cost data is connected.
            </span>
          </div>
          <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-amber-100 text-amber-800 self-start sm:self-center flex-shrink-0">
            Benchmark estimates
          </span>
        </div>

        {/* Page Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-2 border-b border-ivory-300">
          <div className="flex items-center space-x-2">
            <div className="p-2 rounded-lg bg-forest-900 text-ivory-100">
              <ReceiptText className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-charcoal-900 tracking-tight">Profit &amp; Loss (P&amp;L) Statement</h2>
              <p className="text-xs text-charcoal-500 mt-0.5">
                Contribution margin for <strong>{currentBrand?.name || "Active Brand"}</strong>, last {days} days.
              </p>
            </div>
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
              <span className="w-2 h-2 rounded-full bg-emerald-500" />
              <span>{loading ? "Loading…" : "From synced data"}</span>
            </span>
          </div>
        </div>

        {/* 4 PnL Landmark Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="p-5 rounded-xl bg-white border border-ivory-300 shadow-sm space-y-2 hover:border-emerald-500 transition-colors">
            <div className="flex items-center justify-between text-xs text-charcoal-500 font-medium">
              <span>1. Net Revenue</span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 font-semibold">Shopify</span>
            </div>
            <div className="text-2xl font-bold text-charcoal-900 tracking-tight">{show(paise(l?.net_revenue_minor ?? 0))}</div>
            <div className="text-xs text-charcoal-500">Gross: {paise(l?.gross_sales_minor ?? 0)}</div>
          </div>

          <div className="p-5 rounded-xl bg-white border border-ivory-300 shadow-sm space-y-2 hover:border-forest-600 transition-colors">
            <div className="flex items-center justify-between text-xs text-charcoal-500 font-medium">
              <span>2. Gross Margin</span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-forest-50 text-forest-700 font-semibold">
                {pctVal(p?.gross_margin)} Margin
              </span>
            </div>
            <div className="text-2xl font-bold text-charcoal-900 tracking-tight">{show(paise(l?.gross_margin_minor ?? 0))}</div>
            <div className="text-xs text-charcoal-500">After estimated COGS: {minus(l?.cogs_minor ?? 0)}</div>
          </div>

          <div className="p-5 rounded-xl bg-forest-900 text-ivory-100 shadow-sm space-y-2 border border-forest-800">
            <div className="flex items-center justify-between text-xs text-ivory-300 font-medium">
              <span>3. Contribution Margin (CM1)</span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-forest-800 text-emerald-300 font-semibold">Health Score</span>
            </div>
            <div className="text-2xl font-bold text-emerald-400 tracking-tight">{show(paise(l?.cm1_minor ?? 0))}</div>
            <div className="text-xs text-ivory-300">{pctVal(p?.cm1)} of net revenue</div>
          </div>

          <div className="p-5 rounded-xl bg-white border border-ivory-300 shadow-sm space-y-2 hover:border-terracotta-500 transition-colors">
            <div className="flex items-center justify-between text-xs text-charcoal-500 font-medium">
              <span>4. Net Profit (EBITDA)</span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-terracotta-50 text-terracotta-700 font-semibold">Bottom-Line</span>
            </div>
            <div className="text-2xl font-bold text-terracotta-600 tracking-tight">{show(paise(l?.ebitda_minor))}</div>
            <div className="text-xs text-charcoal-500">Needs fixed overheads (not tracked yet)</div>
          </div>
        </div>

        {/* Detailed Financial Waterfall Table */}
        <div className="bg-white rounded-xl border border-ivory-300 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-ivory-200">
            <h3 className="text-sm font-bold text-charcoal-900">Full Financial Waterfall Breakdown</h3>
            <p className="text-xs text-charcoal-500">
              Computed on the server in integer paise. Rows whose source is “Estimate” use the benchmarks above.
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-ivory-50 border-b border-ivory-200 text-charcoal-500 font-semibold text-[10px] uppercase tracking-wider text-left">
                  <th className="px-6 py-3">P&amp;L Line Item</th>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3 text-right">Amount (INR)</th>
                  <th className="px-4 py-3 text-right">% of Net Revenue</th>
                  <th className="px-6 py-3">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ivory-100">
                <tr className="hover:bg-ivory-50/50">
                  <td className="px-6 py-3 font-semibold text-charcoal-900">Gross Sales (before discounts)</td>
                  <td className="px-4 py-3 text-charcoal-600 font-medium">
                    <span className="inline-flex items-center space-x-1.5">
                      <ShopifyLogo className="w-3.5 h-3.5 flex-shrink-0" />
                      <span>Shopify orders</span>
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono font-semibold text-right text-charcoal-900">{paise(l?.gross_sales_minor ?? 0)}</td>
                  <td className="px-4 py-3 text-right font-mono text-charcoal-400">{pctVal(p?.gross_sales)}</td>
                  <td className="px-6 py-3 text-charcoal-400">Product sales excluding tax and shipping; cancelled and voided orders excluded</td>
                </tr>

                <tr className="hover:bg-ivory-50/50 text-charcoal-600">
                  <td className="px-6 py-3 pl-10 text-amber-800">− Discounts &amp; Promos</td>
                  <td className="px-4 py-3 text-charcoal-500 font-medium">
                    <span className="inline-flex items-center space-x-1.5">
                      <ShopifyLogo className="w-3.5 h-3.5 flex-shrink-0" />
                      <span>Shopify orders</span>
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-right text-amber-800">{minus(l?.discounts_minor ?? 0)}</td>
                  <td className="px-4 py-3 text-right font-mono text-charcoal-400">{pctVal(p?.discounts)}</td>
                  <td className="px-6 py-3 text-charcoal-400">Discount codes and automatic discounts</td>
                </tr>

                <tr className="hover:bg-ivory-50/50 text-charcoal-600">
                  <td className="px-6 py-3 pl-10 text-red-600">− Refunds</td>
                  <td className="px-4 py-3 text-charcoal-500 font-medium">
                    <span className="inline-flex items-center space-x-1.5">
                      <ShopifyLogo className="w-3.5 h-3.5 flex-shrink-0" />
                      <span>Shopify orders</span>
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-right text-red-600">{minus(l?.refunds_minor ?? 0)}</td>
                  <td className="px-4 py-3 text-right font-mono text-charcoal-400">{pctVal(p?.refunds)}</td>
                  <td className="px-6 py-3 text-charcoal-400">
                    Fully refunded orders
                    {data?.memo.partially_refunded_order_count
                      ? `; ${data.memo.partially_refunded_order_count} partially refunded order(s) not deducted (refund amounts are not synced)`
                      : ""}
                  </td>
                </tr>

                <tr className="bg-emerald-50/50 font-bold text-emerald-950">
                  <td className="px-6 py-3.5">= 1. Net Revenue</td>
                  <td className="px-4 py-3.5 font-mono text-emerald-800">Shopify</td>
                  <td className="px-4 py-3.5 font-mono text-right text-emerald-900 text-sm">{paise(l?.net_revenue_minor ?? 0)}</td>
                  <td className="px-4 py-3.5 text-right font-mono text-emerald-800">100.0%</td>
                  <td className="px-6 py-3.5 text-emerald-800">Product revenue after discounts and refunds</td>
                </tr>

                <tr className="hover:bg-ivory-50/50 text-charcoal-600">
                  <td className="px-6 py-3 pl-10 text-red-700">− Cost of Goods Sold (COGS)</td>
                  <td className="px-4 py-3 text-charcoal-500 font-mono">Estimate</td>
                  <td className="px-4 py-3 font-mono text-right text-red-700">{minus(l?.cogs_minor ?? 0)}</td>
                  <td className="px-4 py-3 text-right font-mono text-charcoal-400">{pctVal(p?.cogs)}</td>
                  <td className="px-6 py-3 text-charcoal-500">Benchmark: {a.cogs_pct_of_net}% of net revenue</td>
                </tr>

                <tr className="bg-ivory-100 font-bold text-charcoal-900">
                  <td className="px-6 py-3.5">= 2. Gross Margin</td>
                  <td className="px-4 py-3.5 font-mono text-charcoal-700">Calculated</td>
                  <td className="px-4 py-3.5 font-mono text-right text-charcoal-900 text-sm">{paise(l?.gross_margin_minor ?? 0)}</td>
                  <td className="px-4 py-3.5 text-right font-mono text-charcoal-700">{pctVal(p?.gross_margin)}</td>
                  <td className="px-6 py-3.5 text-charcoal-600">Product profit before acquisition and shipping</td>
                </tr>

                <tr className="hover:bg-ivory-50/50 text-charcoal-600">
                  <td className="px-6 py-3 pl-10 text-purple-700">− Paid Marketing Spend</td>
                  <td className="px-4 py-3 text-charcoal-600 font-medium">
                    <span className="inline-flex items-center space-x-1.5">
                      <MetaAdsLogo className="w-3.5 h-3.5 flex-shrink-0" />
                      <span>Meta Ads</span>
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-right text-purple-700">{minus(l?.ad_spend_minor)}</td>
                  <td className="px-4 py-3 text-right font-mono text-charcoal-400">{pctVal(p?.ad_spend)}</td>
                  <td className="px-6 py-3 text-charcoal-400">
                    {data?.sources.ad_spend === "not_connected"
                      ? "Meta Ads not connected; no ad spend deducted"
                      : `Synced Meta spend for the same ${days} days`}
                  </td>
                </tr>

                <tr className="hover:bg-ivory-50/50 text-charcoal-600">
                  <td className="px-6 py-3 pl-10 text-blue-700">− Payment Gateway Charges</td>
                  <td className="px-4 py-3 text-charcoal-500 font-mono">Estimate</td>
                  <td className="px-4 py-3 font-mono text-right text-blue-700">{minus(l?.gateway_charges_minor ?? 0)}</td>
                  <td className="px-4 py-3 text-right font-mono text-charcoal-400">{pctVal(p?.gateway_charges)}</td>
                  <td className="px-6 py-3 text-charcoal-500">Benchmark: {a.gateway_fee_pct_of_net}% of net revenue</td>
                </tr>

                <tr className="hover:bg-ivory-50/50 text-charcoal-600">
                  <td className="px-6 py-3 pl-10 text-amber-700">− Shipping &amp; Fulfillment Costs</td>
                  <td className="px-4 py-3 text-charcoal-500 font-mono">Estimate</td>
                  <td className="px-4 py-3 font-mono text-right text-amber-700">{minus(l?.shipping_costs_minor ?? 0)}</td>
                  <td className="px-4 py-3 text-right font-mono text-charcoal-400">{pctVal(p?.shipping_costs)}</td>
                  <td className="px-6 py-3 text-charcoal-500">Benchmark: {paise(a.freight_per_order_minor)} per order forward freight</td>
                </tr>

                <tr className="bg-forest-900 font-bold text-ivory-100">
                  <td className="px-6 py-3.5">= 3. Contribution Margin 1 (CM1)</td>
                  <td className="px-4 py-3.5 font-mono text-emerald-300">Calculated</td>
                  <td className="px-4 py-3.5 font-mono text-right text-emerald-400 text-sm">{paise(l?.cm1_minor ?? 0)}</td>
                  <td className="px-4 py-3.5 text-right font-mono text-emerald-300">{pctVal(p?.cm1)}</td>
                  <td className="px-6 py-3.5 text-ivory-200">Cash left after variable costs</td>
                </tr>

                <tr className="hover:bg-ivory-50/50 text-charcoal-600">
                  <td className="px-6 py-3 pl-10 text-charcoal-600">− Fixed Overheads</td>
                  <td className="px-4 py-3 text-charcoal-500 font-mono">Not tracked</td>
                  <td className="px-4 py-3 font-mono text-right text-charcoal-700">{minus(l?.fixed_overhead_minor)}</td>
                  <td className="px-4 py-3 text-right font-mono text-charcoal-400">—</td>
                  <td className="px-6 py-3 text-charcoal-400">Salaries, rent, software: not recorded in the app yet</td>
                </tr>

                <tr className="bg-terracotta-500 font-bold text-white">
                  <td className="px-6 py-4">= 4. Net Profit (EBITDA)</td>
                  <td className="px-4 py-4 font-mono text-ivory-100">Unavailable</td>
                  <td className="px-4 py-4 font-mono text-right text-base text-white">{paise(l?.ebitda_minor)}</td>
                  <td className="px-4 py-4 text-right font-mono text-ivory-100">{pctVal(p?.ebitda)}</td>
                  <td className="px-6 py-4 text-ivory-100">Shown once fixed overheads are recorded</td>
                </tr>

                <tr className="text-charcoal-500 bg-ivory-50/60">
                  <td className="px-6 py-3 pl-10">Memo: GST collected</td>
                  <td className="px-4 py-3 font-mono">Shopify orders</td>
                  <td className="px-4 py-3 font-mono text-right">{paise(data?.memo.tax_collected_minor ?? 0)}</td>
                  <td className="px-4 py-3 text-right font-mono">—</td>
                  <td className="px-6 py-3">Collected for the government; not part of revenue</td>
                </tr>
                <tr className="text-charcoal-500 bg-ivory-50/60">
                  <td className="px-6 py-3 pl-10">Memo: Shipping charged to customers</td>
                  <td className="px-4 py-3 font-mono">Shopify orders</td>
                  <td className="px-4 py-3 font-mono text-right">{paise(data?.memo.shipping_charged_minor ?? 0)}</td>
                  <td className="px-4 py-3 text-right font-mono">—</td>
                  <td className="px-6 py-3">Not included in net revenue above</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* Strategy & Notes */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="p-4 rounded-xl bg-white border border-ivory-300 shadow-sm space-y-2">
            <div className="flex items-center space-x-2 text-xs font-bold text-charcoal-900">
              <ShieldCheck className="w-4 h-4 text-emerald-600" />
              <span>Contribution Margin Rule</span>
            </div>
            <p className="text-xs text-charcoal-500 leading-relaxed">
              If CM1 is positive ({pctVal(p?.cm1)}), each extra order leaves cash in the business. If CM1 turns negative, scaling
              ad spend will accelerate losses.
            </p>
          </div>

          <div className="p-4 rounded-xl bg-white border border-ivory-300 shadow-sm space-y-2">
            <div className="flex items-center space-x-2 text-xs font-bold text-charcoal-900">
              <Sparkles className="w-4 h-4 text-purple-600" />
              <span>Meta Restatement Effect</span>
            </div>
            <p className="text-xs text-charcoal-500 leading-relaxed">
              Meta can restate spend and conversions for recent days. Each Meta Ads sync re-fetches the recent window, so ad spend
              for the last few weeks may change slightly after a sync.
            </p>
          </div>
        </div>
      </div>
    </DashboardShell>
  );
}
