"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { useAuth } from "@/context/AuthContext";
import { apiFetch } from "@/lib/api";
import { invokeEdgeFunction, ConnectionTestResult } from "@/lib/serverless";
import {
  ShopifyLogo,
  RazorpayLogo,
  DelhiveryLogo,
  MetaAdsLogo,
  InstagramLogo,
} from "@/components/icons/AppLogos";
import {
  PlugZap,
  ShoppingBag,
  CreditCard,
  Truck,
  Megaphone,
  Instagram,
  CheckCircle2,
  AlertCircle,
  Clock,
  RefreshCw,
  ExternalLink,
  ShieldCheck,
  Key,
  Lock,
  ArrowRight,
  Settings,
  HelpCircle,
  Activity,
  Zap,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

interface AppConnector {
  id: string;
  name: string;
  provider: "shopify" | "razorpay" | "delhivery" | "meta_ads" | "instagram";
  category: "Store & Catalog" | "Payments" | "Logistics" | "Marketing" | "Social";
  status: "connected" | "disconnected" | "syncing" | "token_expiring" | "error";
  account_identifier: string;
  last_synced_at: string | null;
  last_error_message?: string;
  auth_type: "OAuth 2.0" | "API Key & Webhook Secret" | "Token";
  description: string;
  fields: { label: string; placeholder: string; key: string; type?: string }[];
}

const DEFAULT_APPS: AppConnector[] = [
  {
    id: "shopify",
    name: "Shopify",
    provider: "shopify",
    category: "Store & Catalog",
    status: "disconnected",
    account_identifier: "",
    last_synced_at: null,
    auth_type: "OAuth 2.0",
    description: "Sync orders, products, inventory, customers, discounts, and fulfillment updates via verified HMAC webhooks.",
    fields: [
      { label: "Shopify Store Domain", placeholder: "your-brand.myshopify.com", key: "shop_domain" },
      { label: "Admin API Access Token", placeholder: "shpat_xxxxxxxxxxxxxxxx", key: "access_token", type: "password" },
      { label: "Webhook HMAC Secret", placeholder: "shpss_xxxxxxxxxxxxxxx", key: "webhook_secret", type: "password" },
    ],
  },
  {
    id: "razorpay",
    name: "Razorpay",
    provider: "razorpay",
    category: "Payments",
    status: "disconnected",
    account_identifier: "",
    last_synced_at: null,
    auth_type: "API Key & Webhook Secret",
    description: "Reconcile payments, authorization rates, refunds, and bank chargebacks/disputes with zero amount/name collisions.",
    fields: [
      { label: "Key ID", placeholder: "rzp_live_xxxxxxxxxxxxxxxx", key: "key_id" },
      { label: "Key Secret", placeholder: "xxxxxxxxxxxxxxxxxxxxxxxx", key: "key_secret", type: "password" },
      { label: "Webhook Secret", placeholder: "whsec_xxxxxxxxxxxxxxxxxx", key: "webhook_secret", type: "password" },
    ],
  },
  {
    id: "delhivery",
    name: "Delhivery Logistics",
    provider: "delhivery",
    category: "Logistics",
    status: "disconnected",
    account_identifier: "",
    last_synced_at: null,
    auth_type: "API Key & Webhook Secret",
    description: "Unified express fulfillment tracking, Non-Delivery Report (NDR) automation, and RTO return risk prediction.",
    fields: [
      { label: "Client ID / Account Code", placeholder: "DLH_XXXXXX", key: "client_id" },
      { label: "API Token", placeholder: "Bearer token from Delhivery Unified Portal", key: "api_token", type: "password" },
      { label: "Webhook Secret Key", placeholder: "Secret key configured in Delhivery webhooks", key: "webhook_token", type: "password" },
    ],
  },
  {
    id: "meta_ads",
    name: "Meta Ads",
    provider: "meta_ads",
    category: "Marketing",
    status: "disconnected",
    account_identifier: "",
    last_synced_at: null,
    auth_type: "OAuth 2.0",
    description: "Attributed ROAS, CAC, daily ad spend, and impressions with automatic 28-day attribution restatements.",
    fields: [
      { label: "Ad Account ID", placeholder: "act_xxxxxxxxxxxxxxxx", key: "ad_account_id" },
      { label: "System User Access Token", placeholder: "EAABxxxxxxxxxxxxxxxxxxxx", key: "access_token", type: "password" },
    ],
  },
  {
    id: "instagram",
    name: "Instagram Organic",
    provider: "instagram",
    category: "Social",
    status: "disconnected",
    account_identifier: "",
    last_synced_at: null,
    auth_type: "OAuth 2.0",
    description: "Daily midnight profile follower snapshots, Reels reach, and organic engagement rate tracking.",
    fields: [
      { label: "Instagram Business Handle", placeholder: "@yourbrand", key: "handle" },
      { label: "Graph API User Token", placeholder: "EAABxxxxxxxxxxxxxxxxxxxx", key: "graph_token", type: "password" },
    ],
  },
];

export default function ConnectAppsPage() {
  const { currentWorkspace, currentBrand } = useAuth();
  const [apps, setApps] = useState<AppConnector[]>(
    DEFAULT_APPS.map((a) => ({ ...a, status: "disconnected", account_identifier: "", last_synced_at: null }))
  );
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
  const [cardFormValues, setCardFormValues] = useState<Record<string, Record<string, string>>>({});
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [savingCardId, setSavingCardId] = useState<string | null>(null);
  const [cardSaveNotice, setCardSaveNotice] = useState<Record<string, string>>({});
  const [cardSaveError, setCardSaveError] = useState<Record<string, string>>({});
  const [syncNotice, setSyncNotice] = useState<string | null>(null);

  // Serverless Integration Testing State
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, ConnectionTestResult>>({});
  const [showTestingConsole, setShowTestingConsole] = useState<boolean>(true);

  const loadIntegrations = async () => {
    if (!currentWorkspace || !currentBrand) return;
    try {
      const rows = await apiFetch<any[]>(
        `/api/w/${currentWorkspace.slug}/b/${currentBrand.id}/integrations/`
      );
      const byProvider = new Map(rows.map((r) => [r.provider, r]));
      setApps(
        DEFAULT_APPS.map((base) => {
          const remote = byProvider.get(base.provider);
          if (!remote) {
            return { ...base, status: "disconnected", account_identifier: "", last_synced_at: null };
          }
          return {
            ...base,
            status: remote.status || "disconnected",
            account_identifier: remote.account_identifier || "",
            last_synced_at: remote.last_synced_at || null,
            last_error_message: remote.last_error_message || "",
          };
        })
      );
    } catch {
      // Retain offline default state
    }
  };

  useEffect(() => {
    loadIntegrations();
  }, [currentWorkspace?.slug, currentBrand?.id]);

  const toggleCardExpand = (appId: string) => {
    setExpandedCards((prev) => {
      const next = new Set(prev);
      if (next.has(appId)) {
        next.delete(appId);
      } else {
        next.add(appId);
        const app = apps.find((a) => a.id === appId);
        if (app && app.account_identifier) {
          setCardFormValues((prev) => ({
            ...prev,
            [appId]: { ...prev[appId], [app.fields[0].key]: app.account_identifier },
          }));
        }
      }
      return next;
    });
    setCardSaveNotice((prev) => { const n = { ...prev }; delete n[appId]; return n; });
    setCardSaveError((prev) => { const n = { ...prev }; delete n[appId]; return n; });
  };

  /**
   * Serverless API Connection Test
   * Calls the `test-connection` Supabase Edge Function with credentials or provider id.
   */
  const handleTestConnection = async (app: AppConnector) => {
    if (testingId) return;
    setTestingId(app.id);

    try {
      if (!currentWorkspace || !currentBrand) {
        throw new Error("No active workspace or brand selected.");
      }

      const activeValues = cardFormValues[app.id] || {};

      // Invoke test-connection Edge Function
      const result = await invokeEdgeFunction<ConnectionTestResult>("test-connection", {
        provider: app.provider,
        workspace_id: currentWorkspace.id,
        brand_id: currentBrand.id,
        credentials: Object.keys(activeValues).length > 0 ? activeValues : undefined,
        account_identifier: app.account_identifier || activeValues[app.fields[0]?.key],
      });

      setTestResults((prev) => ({ ...prev, [app.id]: result }));

      if (result.connection_status === "connected") {
        setSyncNotice(`Connection test for ${app.name} passed in ${result.response_time}ms (HTTP ${result.http_status})!`);
      } else {
        setSyncNotice(`Connection test for ${app.name} failed: ${result.error_message || "Bad response"}`);
      }
    } catch (err: any) {
      const failedResult: ConnectionTestResult = {
        integration_name: app.provider,
        connection_status: "failed",
        http_status: 500,
        response_time: 0,
        last_tested_at: new Date().toISOString(),
        records_fetched: 0,
        error_message: err.message || "Failed to contact test-connection edge function",
      };
      setTestResults((prev) => ({ ...prev, [app.id]: failedResult }));
      setSyncNotice(`Test failed: ${err.message}`);
    } finally {
      setTestingId(null);
    }
  };

  const saveToBackend = async (app: AppConnector, values: Record<string, string>): Promise<string> => {
    if (!currentWorkspace || !currentBrand) throw new Error("No workspace or brand is selected.");
    await apiFetch(`/api/w/${currentWorkspace.slug}/b/${currentBrand.id}/integrations/`, {
      method: "POST",
      body: JSON.stringify({
        provider: app.provider,
        account_identifier: values[app.fields[0].key] || "",
        credentials: values,
      }),
    });
    let notice = `Credentials encrypted & stored for ${app.name}.`;

    // Attempt live serverless sync
    const syncFunc =
      app.provider === "shopify"
        ? "shopify-sync"
        : app.provider === "meta_ads"
        ? "meta-ads-sync"
        : app.provider === "razorpay"
        ? "razorpay-sync"
        : null;

    if (syncFunc) {
      try {
        await invokeEdgeFunction(syncFunc, {
          workspace_id: currentWorkspace.id,
          brand_id: currentBrand.id,
        });
        notice = `Connected and initial data synced via ${syncFunc}!`;
      } catch {
        // Non-blocking sync fallback
      }
    }

    await loadIntegrations();
    return notice;
  };

  const handleCardSaveCredentials = async (app: AppConnector) => {
    if (savingCardId) return;
    const values = cardFormValues[app.id] || {};

    setSavingCardId(app.id);
    setCardSaveError((prev) => { const n = { ...prev }; delete n[app.id]; return n; });
    try {
      const successNotice = await saveToBackend(app, values);
      setCardSaveNotice((prev) => ({ ...prev, [app.id]: successNotice }));
      setTimeout(() => {
        setExpandedCards((prev) => { const n = new Set(prev); n.delete(app.id); return n; });
        setCardSaveNotice((prev) => { const n = { ...prev }; delete n[app.id]; return n; });
      }, 2500);
    } catch (err: any) {
      setCardSaveError((prev) => ({ ...prev, [app.id]: err.message || "Failed to save credentials." }));
    } finally {
      setSavingCardId(null);
    }
  };

  const handleTriggerSync = async (provider: string) => {
    if (syncingId) return;
    setSyncingId(provider);
    setSyncNotice(null);
    const ws = currentWorkspace;
    const br = currentBrand;
    if (!ws || !br) throw new Error("No workspace or brand is selected.");

    try {
      const functionName =
        provider === "shopify"
          ? "shopify-sync"
          : provider === "razorpay"
          ? "razorpay-sync"
          : provider === "meta_ads"
          ? "meta-ads-sync"
          : provider === "instagram"
          ? "instagram-sync"
          : null;

      if (functionName) {
        const res = await invokeEdgeFunction<{ message?: string; records_processed?: number }>(
          functionName,
          { workspace_id: ws.id, brand_id: br.id }
        );
        setSyncNotice(res.message || `${provider} sync completed via serverless function.`);
      } else {
        setSyncNotice(`${provider.toUpperCase()} syncs automatically via webhooks.`);
      }
      await loadIntegrations();
    } catch (err: any) {
      // Fallback to proxy route
      try {
        if (provider === "shopify") {
          const res = await apiFetch<{ message?: string }>(
            `/api/w/${ws.slug}/b/${br.id}/shopify/sync-now/`,
            { method: "POST" }
          );
          setSyncNotice(res.message || "Shopify sync completed.");
        } else if (provider === "meta_ads") {
          // Same-origin proxy route (session cookie) for the Meta Ads sync.
          const res = await apiFetch<{ message?: string }>(
            `/api/w/${ws.slug}/b/${br.id}/marketing/sync-now/`,
            { method: "POST" }
          );
          setSyncNotice(res.message || "Meta Ads sync completed.");
        } else {
          setSyncNotice(`Sync failed: ${err.message}`);
        }
      } catch {
        setSyncNotice(`Sync failed: ${err.message || "Failed to trigger sync"}`);
      }
      await loadIntegrations();
    } finally {
      setSyncingId(null);
    }
  };

  const handleDisconnect = async (app: AppConnector) => {
    if (!currentWorkspace || !currentBrand) return;
    if (confirm("Disconnect this integration? Real-time webhooks and syncs will pause.")) {
      try {
        await apiFetch(
          `/api/w/${currentWorkspace.slug}/b/${currentBrand.id}/integrations/?provider=${encodeURIComponent(
            app.provider
          )}`,
          { method: "DELETE" }
        );
        await loadIntegrations();
      } catch (err: any) {
        alert(err.message || "Failed to disconnect integration.");
      }
    }
  };

  const getStatusBadge = (status: AppConnector["status"]) => {
    switch (status) {
      case "connected":
        return (
          <span className="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-md bg-emerald-50 text-emerald-700 text-xs font-semibold border border-emerald-200">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span>Connected</span>
          </span>
        );
      case "syncing":
        return (
          <span className="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-md bg-blue-50 text-blue-700 text-xs font-semibold border border-blue-200">
            <RefreshCw className="w-3 h-3 animate-spin text-blue-600" />
            <span>Syncing</span>
          </span>
        );
      case "token_expiring":
        return (
          <span className="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-md bg-amber-50 text-amber-700 text-xs font-semibold border border-amber-200">
            <Clock className="w-3 h-3 text-amber-600" />
            <span>Token Expiring</span>
          </span>
        );
      case "error":
        return (
          <span className="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-md bg-rose-50 text-rose-700 text-xs font-semibold border border-rose-200">
            <AlertCircle className="w-3 h-3 text-rose-600" />
            <span>Sync Error</span>
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-md bg-gray-100 text-charcoal-600 text-xs font-semibold border border-gray-200">
            <span className="w-2 h-2 rounded-full bg-gray-400" />
            <span>Not Connected</span>
          </span>
        );
    }
  };

  const getProviderIcon = (provider: AppConnector["provider"], size: string = "w-8 h-8") => {
    switch (provider) {
      case "shopify":
        return <ShopifyLogo className={size} />;
      case "razorpay":
        return <RazorpayLogo className={size} />;
      case "delhivery":
        return <DelhiveryLogo className={size} />;
      case "meta_ads":
        return <MetaAdsLogo className={size} />;
      case "instagram":
        return <InstagramLogo className={size} />;
    }
  };

  const connectedCount = apps.filter((a) => a.status === "connected").length;

  return (
    <DashboardShell>
      <div className="space-y-6 font-sans max-w-7xl">
        {/* Page Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-2 border-b border-ivory-300">
          <div>
            <div className="flex items-center space-x-2">
              <div className="p-2 rounded-lg bg-forest-900 text-ivory-100">
                <PlugZap className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-charcoal-900 tracking-tight">
                  Connect Commerce Apps &amp; Channels
                </h2>
                <p className="text-xs text-charcoal-500 mt-0.5">
                  Configure API keys, OAuth tokens, and webhooks for{" "}
                  <strong>{currentBrand?.name || "Active Brand"}</strong>.
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center space-x-3">
            <Link
              href="/guide"
              className="flex items-center space-x-1.5 px-3 py-1.5 bg-terracotta-50 hover:bg-terracotta-100 text-terracotta-700 border border-terracotta-200 rounded-lg text-xs font-semibold shadow-sm transition-colors"
            >
              <HelpCircle className="w-4 h-4 text-terracotta-600" />
              <span>Setup Guide &amp; FAQs</span>
            </Link>
            <div className="flex items-center space-x-2 px-3 py-1.5 bg-white border border-ivory-300 rounded-lg text-xs font-semibold text-charcoal-700 shadow-sm">
              <ShieldCheck className="w-4 h-4 text-emerald-600" />
              <span>
                {connectedCount} of {apps.length} Channels Connected
              </span>
            </div>
          </div>
        </div>

        {syncNotice && (
          <div
            className={`p-3 rounded-xl border text-xs font-medium flex items-center justify-between ${
              syncNotice.includes("failed") || syncNotice.includes("Error")
                ? "bg-rose-50 border-rose-200 text-rose-700"
                : "bg-emerald-50 border-emerald-200 text-emerald-800"
            }`}
          >
            <span>{syncNotice}</span>
            <button
              onClick={() => setSyncNotice(null)}
              className="text-xs font-bold opacity-70 hover:opacity-100 ml-3"
            >
              ✕
            </button>
          </div>
        )}

        {/* Phase 8: Integration Testing & Diagnostics Interface */}
        <div className="bg-white rounded-xl border border-ivory-300 shadow-sm overflow-hidden">
          <div
            className="p-4 bg-ivory-50 border-b border-ivory-200 flex items-center justify-between cursor-pointer select-none"
            onClick={() => setShowTestingConsole(!showTestingConsole)}
          >
            <div className="flex items-center space-x-2.5">
              <div className="p-1.5 rounded-md bg-forest-900 text-ivory-100">
                <Activity className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-charcoal-900">
                  Serverless API Connection Testing &amp; Diagnostics
                </h3>
                <p className="text-[11px] text-charcoal-500">
                  Direct live connection ping through the <code className="bg-ivory-200 px-1 py-0.5 rounded text-[10px]">test-connection</code> Edge Function.
                </p>
              </div>
            </div>

            <div className="flex items-center space-x-2 text-xs font-semibold text-charcoal-600">
              <span>{showTestingConsole ? "Hide Diagnostics" : "Show Diagnostics"}</span>
              {showTestingConsole ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </div>
          </div>

          {showTestingConsole && (
            <div className="divide-y divide-ivory-200">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-ivory-100/70 text-charcoal-600 font-semibold uppercase text-[10px] tracking-wider">
                    <tr>
                      <th className="py-2.5 px-4">Platform</th>
                      <th className="py-2.5 px-4">Connection Status</th>
                      <th className="py-2.5 px-4">Latency</th>
                      <th className="py-2.5 px-4">Records Fetched</th>
                      <th className="py-2.5 px-4">Last Tested</th>
                      <th className="py-2.5 px-4 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ivory-100 text-charcoal-700">
                    {apps.map((app) => {
                      const testRes = testResults[app.id];
                      const isTesting = testingId === app.id;

                      return (
                        <tr key={`test-${app.id}`} className="hover:bg-ivory-50/50 transition-colors">
                          <td className="py-3 px-4">
                            <div className="flex items-center space-x-2.5">
                              <div className="w-6 h-6 flex items-center justify-center flex-shrink-0">
                                {getProviderIcon(app.provider, "w-5 h-5")}
                              </div>
                              <span className="font-bold text-charcoal-900">{app.name}</span>
                            </div>
                          </td>

                          <td className="py-3 px-4">
                            {testRes ? (
                              testRes.connection_status === "connected" ? (
                                <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 font-semibold text-[11px] border border-emerald-200">
                                  <CheckCircle2 className="w-3 h-3" />
                                  <span>Passed ({testRes.http_status})</span>
                                </span>
                              ) : (
                                <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded bg-rose-50 text-rose-700 font-semibold text-[11px] border border-rose-200">
                                  <AlertCircle className="w-3 h-3" />
                                  <span>Failed ({testRes.http_status})</span>
                                </span>
                              )
                            ) : (
                              getStatusBadge(app.status)
                            )}
                          </td>

                          <td className="py-3 px-4 font-mono text-[11px]">
                            {testRes?.response_time ? (
                              <span
                                className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                  testRes.response_time < 300
                                    ? "bg-emerald-100 text-emerald-800"
                                    : testRes.response_time < 800
                                    ? "bg-amber-100 text-amber-800"
                                    : "bg-rose-100 text-rose-800"
                                }`}
                              >
                                {testRes.response_time} ms
                              </span>
                            ) : (
                              <span className="text-charcoal-400">—</span>
                            )}
                          </td>

                          <td className="py-3 px-4 font-mono text-[11px]">
                            {testRes?.records_fetched !== undefined ? (
                              <span className="font-bold text-charcoal-900">{testRes.records_fetched}</span>
                            ) : (
                              <span className="text-charcoal-400">—</span>
                            )}
                          </td>

                          <td className="py-3 px-4 text-charcoal-500 text-[11px]">
                            {testRes?.last_tested_at ? (
                              new Date(testRes.last_tested_at).toLocaleTimeString()
                            ) : app.last_synced_at ? (
                              new Date(app.last_synced_at).toLocaleTimeString()
                            ) : (
                              <span className="text-charcoal-400">Not tested</span>
                            )}
                          </td>

                          <td className="py-3 px-4 text-right">
                            <button
                              onClick={() => handleTestConnection(app)}
                              disabled={isTesting}
                              className="inline-flex items-center space-x-1 px-2.5 py-1 bg-ivory-100 hover:bg-forest-900 hover:text-white border border-ivory-300 rounded font-semibold text-[11px] text-charcoal-800 transition-colors disabled:opacity-50"
                            >
                              <Zap className={`w-3 h-3 ${isTesting ? "animate-spin text-terracotta-500" : ""}`} />
                              <span>{isTesting ? "Testing..." : "Test Connection"}</span>
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Show error diagnostics if any test failed */}
              {Object.entries(testResults).some(([_, r]) => r.connection_status === "failed") && (
                <div className="p-3 bg-rose-50/70 border-t border-rose-200 text-xs text-rose-800 space-y-1">
                  <div className="font-bold flex items-center space-x-1.5">
                    <AlertCircle className="w-3.5 h-3.5 text-rose-600" />
                    <span>Diagnostics Error Details:</span>
                  </div>
                  {Object.entries(testResults)
                    .filter(([_, r]) => r.connection_status === "failed")
                    .map(([appId, r]) => (
                      <div key={appId} className="pl-5 text-[11px] font-mono">
                        <strong>{appId.toUpperCase()}:</strong> {r.error_message}
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Security & Envelope Encryption Guarantee Banner */}
        <div className="p-4 rounded-xl bg-forest-900 text-ivory-100 shadow-sm flex flex-col md:flex-row items-start md:items-center justify-between gap-3 border border-forest-800">
          <div className="flex items-start space-x-3">
            <div className="p-2 rounded-lg bg-forest-800 text-emerald-300 flex-shrink-0 mt-0.5">
              <Lock className="w-4 h-4" />
            </div>
            <div className="text-xs space-y-0.5">
              <div className="font-bold text-white text-sm">Serverless AES-256-GCM Envelope Encryption</div>
              <p className="text-ivory-300 leading-relaxed">
                Tokens and webhook secrets are encrypted with AES-256-GCM before they are stored in PostgreSQL. Only the server can read them; the sync functions decrypt them when they run.
              </p>
            </div>
          </div>
          <span className="text-[11px] font-mono text-emerald-300 bg-forest-800 px-2.5 py-1 rounded border border-forest-700 flex-shrink-0">
            Tenant: {currentWorkspace?.slug || "default"}
          </span>
        </div>

        {/* 5 Apps Connection Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {apps.map((app) => {
            const isExpanded = expandedCards.has(app.id);
            const cardValues = cardFormValues[app.id] || {};
            const cardNotice = cardSaveNotice[app.id];
            const cardError = cardSaveError[app.id];
            const isSavingThis = savingCardId === app.id;
            const isTestingThis = testingId === app.id;

            return (
              <div
                key={app.id}
                className="bg-white rounded-xl border border-ivory-300 shadow-sm p-6 space-y-4 hover:border-terracotta-400 transition-colors flex flex-col justify-between"
              >
                <div className="space-y-3">
                  {/* Card Header */}
                  <div className="flex items-start justify-between">
                    <div className="flex items-center space-x-3.5">
                      <div className="w-12 h-12 rounded-xl bg-ivory-100 border border-ivory-200 flex items-center justify-center p-2 flex-shrink-0 shadow-sm">
                        {getProviderIcon(app.provider, "w-8 h-8")}
                      </div>
                      <div>
                        <div className="flex items-center space-x-2">
                          <h3 className="text-base font-bold text-charcoal-900">{app.name}</h3>
                          <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-ivory-100 text-charcoal-600">
                            {app.category}
                          </span>
                        </div>
                        <p className="text-xs text-charcoal-500 font-mono mt-0.5">
                          {app.account_identifier || "Not connected"}
                        </p>
                      </div>
                    </div>

                    <div>{getStatusBadge(app.status)}</div>
                  </div>

                  {/* Description */}
                  <p className="text-xs text-charcoal-600 leading-relaxed">{app.description}</p>
                </div>

                {/* Inline Credential Form */}
                {isExpanded && (
                  <div className="border-t border-ivory-200 pt-4 space-y-3 animate-in slide-in-from-top-2 fade-in duration-150">
                    {cardNotice ? (
                      <div className="p-4 text-center space-y-2">
                        <div className="w-10 h-10 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center mx-auto">
                          <CheckCircle2 className="w-5 h-5" />
                        </div>
                        <div className="text-xs font-bold text-charcoal-900">{cardNotice}</div>
                      </div>
                    ) : (
                      <>
                        {cardError && (
                          <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 flex items-start space-x-2 text-xs">
                            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-rose-600" />
                            <span>{cardError}</span>
                          </div>
                        )}

                        {app.fields.map((f) => (
                          <div key={f.key} className="space-y-1">
                            <label className="text-xs font-semibold text-charcoal-800">{f.label}</label>
                            <input
                              type={f.type || "text"}
                              placeholder={f.placeholder}
                              value={cardValues[f.key] || ""}
                              onChange={(e) =>
                                setCardFormValues((prev) => ({
                                  ...prev,
                                  [app.id]: { ...prev[app.id], [f.key]: e.target.value },
                                }))
                              }
                              className="w-full px-3 py-2 border border-ivory-300 rounded-lg bg-ivory-50 text-charcoal-800 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-terracotta-500"
                            />
                          </div>
                        ))}

                        <div className="text-[11px] text-charcoal-500 flex items-center space-x-1.5">
                          <Lock className="w-3 h-3 text-emerald-600" />
                          <span>Credentials are encrypted via AES-256-GCM before storage.</span>
                        </div>

                        <div className="flex items-center justify-between pt-1">
                          <button
                            type="button"
                            onClick={() => handleTestConnection(app)}
                            disabled={isTestingThis || app.fields.some((f) => !(cardValues[f.key]?.trim()))}
                            className="inline-flex items-center space-x-1 px-3 py-1.5 bg-ivory-100 hover:bg-ivory-200 border border-ivory-300 rounded-lg text-charcoal-800 text-xs font-semibold transition-colors disabled:opacity-40"
                          >
                            <Zap className={`w-3.5 h-3.5 ${isTestingThis ? "animate-spin text-terracotta-500" : ""}`} />
                            <span>{isTestingThis ? "Testing..." : "Test Keys"}</span>
                          </button>

                          <div className="flex items-center space-x-2">
                            <button
                              type="button"
                              onClick={() => toggleCardExpand(app.id)}
                              className="px-3 py-1.5 border border-ivory-300 rounded-lg text-charcoal-700 text-xs font-semibold hover:bg-ivory-50 transition-colors"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={() => handleCardSaveCredentials(app)}
                              disabled={isSavingThis || app.fields.some((f) => !(cardValues[f.key]?.trim()))}
                              className="inline-flex items-center space-x-1.5 px-4 py-1.5 bg-forest-900 hover:bg-forest-800 text-ivory-100 rounded-lg text-xs font-semibold transition-colors shadow-sm disabled:opacity-50"
                            >
                              <Key className="w-3.5 h-3.5" />
                              <span>{isSavingThis ? "Saving..." : "Save & Connect"}</span>
                            </button>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* Action Footer */}
                <div className="pt-4 border-t border-ivory-200 flex flex-wrap items-center justify-between gap-3 text-xs">
                  <div className="text-charcoal-400 text-[11px]">
                    {app.last_synced_at ? (
                      <span>
                        Synced {new Date(app.last_synced_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    ) : (
                      <span>Awaiting initial sync</span>
                    )}
                  </div>

                  <div className="flex items-center space-x-2">
                    <button
                      onClick={() => handleTestConnection(app)}
                      disabled={isTestingThis}
                      className="inline-flex items-center space-x-1 px-2.5 py-1.5 bg-ivory-100 hover:bg-ivory-200 border border-ivory-300 rounded-lg text-charcoal-700 font-semibold transition-colors text-xs disabled:opacity-50"
                      title="Run live API connection test"
                    >
                      <Zap className={`w-3 h-3 ${isTestingThis ? "animate-spin text-terracotta-500" : ""}`} />
                      <span>{isTestingThis ? "Testing..." : "Test"}</span>
                    </button>

                    {(app.status === "connected" || app.status === "syncing" || app.status === "token_expiring" || app.status === "error") && (
                      <>
                        <button
                          onClick={() => handleTriggerSync(app.provider)}
                          disabled={syncingId === app.provider}
                          className="inline-flex items-center space-x-1.5 px-3 py-1.5 bg-ivory-100 hover:bg-ivory-200 border border-ivory-300 rounded-lg text-charcoal-700 font-semibold transition-colors disabled:opacity-50"
                        >
                          <RefreshCw className={`w-3.5 h-3.5 ${syncingId === app.provider ? "animate-spin text-terracotta-500" : ""}`} />
                          <span>{syncingId === app.provider ? "Syncing..." : "Sync"}</span>
                        </button>

                        <button
                          onClick={() => toggleCardExpand(app.id)}
                          className="px-3 py-1.5 bg-white hover:bg-ivory-50 border border-ivory-300 rounded-lg text-charcoal-700 font-semibold transition-colors"
                        >
                          {isExpanded ? "Close" : "Configure"}
                        </button>

                        <button
                          onClick={() => handleDisconnect(app)}
                          className="text-red-600 hover:underline px-2 text-[11px]"
                        >
                          Disconnect
                        </button>
                      </>
                    )}

                    {app.status === "disconnected" && !isExpanded && (
                      <button
                        onClick={() => toggleCardExpand(app.id)}
                        className="inline-flex items-center space-x-1.5 px-4 py-1.5 bg-forest-900 hover:bg-forest-800 text-ivory-100 rounded-lg font-semibold transition-colors shadow-sm"
                      >
                        <PlugZap className="w-3.5 h-3.5" />
                        <span>Connect {app.name}</span>
                      </button>
                    )}

                    {app.status === "disconnected" && isExpanded && (
                      <button
                        onClick={() => toggleCardExpand(app.id)}
                        className="px-3 py-1.5 bg-ivory-100 hover:bg-ivory-200 border border-ivory-300 rounded-lg text-charcoal-700 font-semibold transition-colors text-xs"
                      >
                        Close
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </DashboardShell>
  );
}
