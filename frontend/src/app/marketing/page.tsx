"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { ModuleGuard } from "@/components/auth/ModuleGuard";
import { useAuth } from "@/context/AuthContext";
import { apiFetch } from "@/lib/api";
import { MetaAdsLogo, InstagramLogo } from "@/components/icons/AppLogos";
import {
  TrendingUp,
  ArrowUpRight,
  RefreshCw,
  Info,
  PlugZap,
  ShoppingBag,
  MousePointer,
  Eye,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
} from "lucide-react";

interface Campaign {
  id: string;
  name: string;
  status: "active" | "paused";
  effective_status?: string;
  spend_minor: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpc_minor: number;
  roas: number;
  orders: number;
  attributed_revenue_minor: number;
}

interface MetaSummary {
  spend_minor: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpc_minor: number;
  cpm_minor: number;
  orders: number;
  attributed_revenue_minor: number;
  roas: number;
}

interface MetaStatsResponse {
  connected: boolean;
  message?: string;
  account?: {
    id: string;
    name: string;
    currency: string;
    timezone: string;
  };
  summary_30d?: MetaSummary;
  summary_lifetime?: MetaSummary;
  campaigns?: Campaign[];
  daily_trends?: Array<{
    date: string;
    spend_minor: number;
    impressions: number;
    clicks: number;
    orders: number;
    attributed_revenue_minor: number;
    roas: number;
  }>;
  last_synced_at?: string;
  token_expired?: boolean;
  error?: string;
}

function paise(minor?: number): string {
  if (minor === undefined || minor === null) return "₹0";
  return "₹" + Math.round(minor / 100).toLocaleString("en-IN");
}

export default function MarketingPage() {
  const { currentWorkspace, currentBrand } = useAuth();
  const [stats, setStats] = useState<MetaStatsResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [tab, setTab] = useState<"meta" | "organic">("meta");
  const [timeframe, setTimeframe] = useState<"30d" | "lifetime">("30d");

  const loadStats = async () => {
    setLoading(true);
    setStatsError(null);

    try {
      if (!currentWorkspace || !currentBrand) {
        setLoading(false);
        return;
      }
      const data = await apiFetch<MetaStatsResponse>(
        `/api/w/${currentWorkspace.slug}/b/${currentBrand.id}/marketing/stats/`
      );
      setStats(data);
    } catch (err: any) {
      setStats(null);
      setStatsError(`Could not load Meta Ads data: ${err?.message || "Unknown error"}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStats();
  }, [currentWorkspace?.slug, currentBrand?.id]);

  const handleSyncNow = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncNotice(null);
    setSyncError(null);
    try {
      if (!currentWorkspace || !currentBrand) throw new Error("No workspace or brand is selected.");
      const res = await apiFetch<{ message?: string }>(
        `/api/w/${currentWorkspace.slug}/b/${currentBrand.id}/marketing/sync-now/`,
        { method: "POST" }
      );
      setSyncNotice(res.message || "Meta Ads sync completed successfully.");
      await loadStats();
    } catch (err: any) {
      setSyncError(`Sync failed: ${err?.message || "Failed to contact Meta API"}`);
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncNotice(null), 5000);
    }
  };

  const activeSummary =
    timeframe === "30d" ? stats?.summary_30d : stats?.summary_lifetime;

  return (
    <DashboardShell>
      <ModuleGuard moduleKey="meta_ads" moduleName="Meta Ads Intelligence">
        <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-1">
          <div>
            <h2 className="text-xl font-bold text-charcoal-900 tracking-tight flex items-center space-x-2.5">
              <span className="w-8 h-8 rounded-lg bg-blue-50 border border-blue-100 flex items-center justify-center p-1.5 flex-shrink-0">
                <MetaAdsLogo className="w-full h-full object-contain" />
              </span>
              <span>Marketing &amp; Meta Ads Intelligence</span>
            </h2>
            <p className="text-xs text-charcoal-500 mt-0.5">
              Live ad spend, click attribution, and ROAS restatements for{" "}
              <strong>{currentBrand?.name || "your brand"}</strong>
              {stats?.account && (
                <span className="ml-2 inline-flex items-center text-charcoal-700 bg-ivory-100 px-2 py-0.5 rounded font-mono text-[11px] border border-ivory-300">
                  Account: {stats.account.name} ({stats.account.id})
                </span>
              )}
            </p>
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={handleSyncNow}
              disabled={syncing}
              aria-label="Sync Data"
              className="inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-forest-900 text-ivory-100 text-xs font-semibold hover:bg-forest-800 transition-colors shadow-sm disabled:opacity-60"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? "animate-spin" : ""}`} />
              <span>{syncing ? "Syncing Meta..." : "Sync Data"}</span>
            </button>

            <span className="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-md bg-purple-50 text-purple-700 text-xs font-medium border border-purple-200">
              <span className="w-2 h-2 rounded-full bg-purple-500 animate-pulse" />
              <span>28-Day Restatement Active</span>
            </span>
          </div>
        </div>

        {(syncError || statsError) && (
          <div role="alert" className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs">
            {syncError || statsError}
          </div>
        )}

        {/* Sync notification banner */}
        {syncNotice && (
          <div className="p-3.5 rounded-xl bg-forest-50 border border-forest-200 text-forest-900 text-xs flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <CheckCircle2 className="w-4 h-4 text-forest-700 flex-shrink-0" />
              <span>{syncNotice}</span>
            </div>
            <button
              onClick={() => setSyncNotice(null)}
              className="text-forest-700 hover:text-forest-900 font-bold"
            >
              &times;
            </button>
          </div>
        )}

        {/* Token Expired / Error Banner */}
        {stats?.token_expired && (
          <div className="p-4 rounded-xl bg-amber-50 border border-amber-300 text-amber-950 text-xs flex items-start justify-between gap-3 shadow-xs">
            <div className="flex items-start space-x-2.5">
              <AlertCircle className="w-4 h-4 text-amber-700 flex-shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="font-bold text-amber-900">
                  Meta Access Token Expired
                </p>
                <p className="text-amber-800 leading-relaxed">
                  Your temporary Meta user token has expired. Displaying cached analytics from your last sync. To resume live updates and daily restatements, generate a <strong>System User Token (Never Expire)</strong> in Meta Business Settings and reconnect.
                </p>
              </div>
            </div>
            <Link
              href="/integrations"
              className="px-3 py-1.5 rounded-lg bg-amber-700 hover:bg-amber-800 text-white font-semibold text-xs whitespace-nowrap shadow-xs transition-colors flex-shrink-0"
            >
              Update Token
            </Link>
          </div>
        )}

        {/* Tab switch */}
        <div className="flex items-center justify-between border-b border-ivory-300 pb-2">
          <div className="flex space-x-2">
            <button
              onClick={() => setTab("meta")}
              className={`px-4 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
                tab === "meta"
                  ? "bg-forest-900 text-ivory-100 shadow-sm"
                  : "bg-white text-charcoal-600 border border-ivory-300 hover:border-terracotta-400"
              }`}
            >
              Meta Paid Ads (Facebook &amp; Instagram)
            </button>
            <button
              onClick={() => setTab("organic")}
              className={`px-4 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
                tab === "organic"
                  ? "bg-forest-900 text-ivory-100 shadow-sm"
                  : "bg-white text-charcoal-600 border border-ivory-300 hover:border-terracotta-400"
              }`}
            >
              Instagram Organic Growth
            </button>
          </div>

          {tab === "meta" && stats?.connected && (
            <div className="flex items-center space-x-1 bg-ivory-200 p-0.5 rounded-lg text-xs font-medium border border-ivory-300">
              <button
                onClick={() => setTimeframe("30d")}
                className={`px-3 py-1 rounded-md transition-all ${
                  timeframe === "30d"
                    ? "bg-white text-charcoal-900 font-semibold shadow-xs"
                    : "text-charcoal-600 hover:text-charcoal-900"
                }`}
              >
                Last 30 Days
              </button>
              <button
                onClick={() => setTimeframe("lifetime")}
                className={`px-3 py-1 rounded-md transition-all ${
                  timeframe === "lifetime"
                    ? "bg-white text-charcoal-900 font-semibold shadow-xs"
                    : "text-charcoal-600 hover:text-charcoal-900"
                }`}
              >
                All-Time (Lifetime)
              </button>
            </div>
          )}
        </div>

        {tab === "meta" ? (
          <>
            {!stats?.connected && !loading ? (
              <div className="p-8 rounded-2xl bg-white border border-ivory-300 text-center space-y-4">
                <div className="w-12 h-12 mx-auto rounded-full bg-blue-50 text-blue-600 flex items-center justify-center">
                  <MetaAdsLogo className="w-6 h-6" />
                </div>
                <div className="max-w-md mx-auto space-y-1">
                  <h3 className="text-base font-bold text-charcoal-900">
                    Connect Your Meta Ads Account
                  </h3>
                  <p className="text-xs text-charcoal-500">
                    Enter your Meta Ad Account ID and Access Token in the Integrations panel to pull live campaigns, ROAS, click attribution, and conversion restatements.
                  </p>
                </div>
                <Link
                  href="/integrations"
                  className="inline-flex items-center space-x-2 px-4 py-2 rounded-lg bg-forest-900 text-ivory-100 text-xs font-semibold hover:bg-forest-800 transition-colors shadow-sm"
                >
                  <PlugZap className="w-4 h-4" />
                  <span>Go to Connect Apps</span>
                </Link>
              </div>
            ) : (
              <>
                {/* Top KPI Cards */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="p-5 rounded-xl bg-white border border-ivory-300 shadow-sm space-y-2">
                    <div className="text-xs text-charcoal-500 font-medium">
                      Total Ad Spend ({timeframe === "30d" ? "30D" : "All-Time"})
                    </div>
                    <div className="text-2xl font-bold text-charcoal-900 tracking-tight">
                      {paise(activeSummary?.spend_minor)}
                    </div>
                    <div className="flex items-center space-x-1 text-emerald-600 text-xs font-semibold">
                      <TrendingUp className="w-3.5 h-3.5" />
                      <span>{activeSummary?.orders || 0} Attributed Orders</span>
                    </div>
                  </div>

                  <div className="p-5 rounded-xl bg-white border border-ivory-300 shadow-sm space-y-2">
                    <div className="text-xs text-charcoal-500 font-medium">Blended ROAS</div>
                    <div className="text-2xl font-bold text-emerald-700 tracking-tight">
                      {activeSummary?.roas ? `${activeSummary.roas}x` : "0.00x"}
                    </div>
                    <div className="flex items-center space-x-1 text-emerald-600 text-xs font-semibold">
                      <ArrowUpRight className="w-3.5 h-3.5" />
                      <span>{paise(activeSummary?.attributed_revenue_minor)} attributed</span>
                    </div>
                  </div>

                  <div className="p-5 rounded-xl bg-white border border-ivory-300 shadow-sm space-y-2">
                    <div className="text-xs text-charcoal-500 font-medium">Avg Cost Per Click (CPC)</div>
                    <div className="text-2xl font-bold text-charcoal-900 tracking-tight">
                      {paise(activeSummary?.cpc_minor)}
                    </div>
                    <div className="text-xs text-charcoal-400">
                      {activeSummary?.clicks ? activeSummary.clicks.toLocaleString() : 0} outbound clicks
                    </div>
                  </div>

                  <div className="p-5 rounded-xl bg-white border border-ivory-300 shadow-sm space-y-2">
                    <div className="text-xs text-charcoal-500 font-medium">Click-Through Rate (CTR)</div>
                    <div className="text-2xl font-bold text-charcoal-900 tracking-tight">
                      {activeSummary?.ctr ? `${activeSummary.ctr}%` : "0.00%"}
                    </div>
                    <div className="text-xs text-charcoal-400">
                      {activeSummary?.impressions ? activeSummary.impressions.toLocaleString() : 0} impressions
                    </div>
                  </div>
                </div>

                {/* Restatement note banner */}
                <div className="p-4 rounded-xl bg-purple-50 border border-purple-200 flex items-start space-x-3">
                  <Info className="w-4 h-4 text-purple-700 flex-shrink-0 mt-0.5" />
                  <div className="text-xs text-purple-900 leading-relaxed">
                    <strong>Why Meta numbers shift:</strong> Meta operates a 7-day click / 1-day view attribution window. Conversions restate retroactively as users who saw an ad convert days later. Our sync engine captures these restatements so your financial metrics match true cash flow.
                  </div>
                </div>

                {/* Campaigns table */}
                <div className="bg-white rounded-xl border border-ivory-300 shadow-sm overflow-hidden">
                  <div className="px-5 py-4 border-b border-ivory-200 flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-bold text-charcoal-900">
                        Meta Ad Campaigns ({stats?.campaigns?.length || 0})
                      </h3>
                      <p className="text-xs text-charcoal-500">
                        Live metrics pulled from Marketing Graph API v21.0
                      </p>
                    </div>
                    {stats?.last_synced_at && (
                      <span className="text-[11px] text-charcoal-400 font-mono">
                        Last synced: {new Date(stats.last_synced_at).toLocaleTimeString()}
                      </span>
                    )}
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-ivory-50 border-b border-ivory-200">
                          {[
                            "Campaign",
                            "Status",
                            "Spend",
                            "Impressions",
                            "Clicks",
                            "CTR",
                            "CPC",
                            "ROAS",
                            "Orders",
                            "Attributed Revenue",
                          ].map((h) => (
                            <th
                              key={h}
                              className="px-4 py-2.5 text-left font-semibold text-charcoal-500 uppercase tracking-wider text-[10px]"
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-ivory-100">
                        {stats?.campaigns && stats.campaigns.length > 0 ? (
                          stats.campaigns.map((c) => (
                            <tr key={c.id} className="hover:bg-ivory-50 transition-colors">
                              <td className="px-4 py-3 font-semibold text-charcoal-900 max-w-xs truncate">
                                <div>{c.name}</div>
                                <div className="text-[10px] text-charcoal-400 font-mono">ID: {c.id}</div>
                              </td>
                              <td className="px-4 py-3">
                                <span
                                  className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase ${
                                    c.status === "active"
                                      ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                                      : "bg-gray-100 text-gray-500"
                                  }`}
                                >
                                  {c.status}
                                </span>
                              </td>
                              <td className="px-4 py-3 font-semibold text-charcoal-900">
                                {paise(c.spend_minor)}
                              </td>
                              <td className="px-4 py-3 text-charcoal-600 font-mono">
                                {c.impressions.toLocaleString()}
                              </td>
                              <td className="px-4 py-3 text-charcoal-600 font-mono">
                                {c.clicks.toLocaleString()}
                              </td>
                              <td className="px-4 py-3 font-semibold text-charcoal-800">
                                {c.ctr}%
                              </td>
                              <td className="px-4 py-3 font-mono text-charcoal-600">
                                {paise(c.cpc_minor)}
                              </td>
                              <td className="px-4 py-3 font-bold text-emerald-600">
                                {c.roas}x
                              </td>
                              <td className="px-4 py-3 font-semibold text-charcoal-900">
                                {c.orders}
                              </td>
                              <td className="px-4 py-3 font-semibold text-emerald-700">
                                {paise(c.attributed_revenue_minor)}
                              </td>
                            </tr>
                          ))
                        ) : (
                          <tr>
                            <td colSpan={10} className="px-4 py-8 text-center text-charcoal-400">
                              {loading ? "Loading Meta Ads data..." : "No campaigns found."}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </>
        ) : (
          /* Instagram Organic Tab */
          <div className="space-y-6">
            <div className="p-8 rounded-2xl bg-white border border-ivory-300 text-center space-y-4">
              <div className="w-12 h-12 mx-auto rounded-full bg-gradient-to-tr from-amber-500 via-rose-500 to-purple-600 text-white flex items-center justify-center p-2.5">
                <InstagramLogo className="w-full h-full object-contain" />
              </div>
              <div className="max-w-md mx-auto space-y-1">
                <h3 className="text-base font-bold text-charcoal-900">
                  Connect Instagram Business Account
                </h3>
                <p className="text-xs text-charcoal-500">
                  Link your Instagram Business Account in Connect Apps to sync organic profile reach, follower growth, Reels impressions, and engagement rates directly via the Instagram Graph API.
                </p>
              </div>
              <Link
                href="/integrations"
                className="inline-flex items-center space-x-2 px-4 py-2 rounded-lg bg-forest-900 text-ivory-100 text-xs font-semibold hover:bg-forest-800 transition-colors shadow-sm"
              >
                <PlugZap className="w-4 h-4" />
                <span>Configure in Connect Apps</span>
              </Link>
            </div>
          </div>
        )}
        </div>
      </ModuleGuard>
    </DashboardShell>
  );
}
