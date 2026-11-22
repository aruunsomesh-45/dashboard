"use client";

import React, { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import {
  Radio,
  Search,
  Filter,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  ExternalLink,
  ShieldCheck,
  Lock,
} from "lucide-react";

export default function SuperAdminIntegrationsPage() {
  const [integrations, setIntegrations] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchIntegrations = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) throw new Error("No active session");

      const res = await fetch("/api/super-admin/integrations", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to load integrations");
      }
      const data = await res.json();
      setIntegrations(data.integrations || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchIntegrations();
  }, []);

  const filtered = integrations.filter((i) => {
    const matchesSearch =
      i.account_identifier?.toLowerCase().includes(search.toLowerCase()) ||
      i.provider?.toLowerCase().includes(search.toLowerCase()) ||
      i.brand?.name?.toLowerCase().includes(search.toLowerCase()) ||
      i.workspace?.name?.toLowerCase().includes(search.toLowerCase());

    const matchesProvider = providerFilter === "all" || i.provider === providerFilter;
    return matchesSearch && matchesProvider;
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-charcoal-900 tracking-tight">Cross-Tenant Integrations Monitor</h1>
          <p className="text-xs text-charcoal-500 mt-1">
            Global connection health, encrypted credential verification, and sync status
          </p>
        </div>
        <button
          onClick={fetchIntegrations}
          className="p-2 border border-charcoal-200 hover:bg-charcoal-50 text-charcoal-700 rounded-lg transition-colors flex items-center gap-1.5 text-xs font-semibold"
        >
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      <div className="flex flex-col sm:flex-row items-center gap-3 bg-white p-3 rounded-xl border border-charcoal-200/80 shadow-xs">
        <div className="relative flex-1 w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-charcoal-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by provider, brand, or workspace..."
            className="w-full pl-9 pr-3 py-1.5 text-xs bg-charcoal-50 border border-charcoal-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-charcoal-900"
          />
        </div>
        <select
          value={providerFilter}
          onChange={(e) => setProviderFilter(e.target.value)}
          className="px-3 py-1.5 text-xs bg-charcoal-50 border border-charcoal-200 rounded-lg focus:outline-none font-medium text-charcoal-700"
        >
          <option value="all">All Providers</option>
          <option value="shopify">Shopify</option>
          <option value="razorpay">Razorpay</option>
          <option value="delivery">Delivery</option>
          <option value="meta_ads">Meta Ads</option>
          <option value="instagram">Instagram</option>
        </select>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center p-12">
          <RefreshCw className="h-6 w-6 text-charcoal-400 animate-spin" />
        </div>
      ) : error ? (
        <div className="p-4 bg-red-50 border border-red-200 text-red-700 rounded-xl text-xs">{error}</div>
      ) : (
        <div className="bg-white rounded-xl border border-charcoal-200/80 overflow-hidden shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="bg-charcoal-50 border-b border-charcoal-200 text-charcoal-500 font-semibold uppercase text-[10px] tracking-wider">
                  <th className="px-4 py-3">Provider</th>
                  <th className="px-4 py-3">Tenant & Brand</th>
                  <th className="px-4 py-3">Account Identifier</th>
                  <th className="px-4 py-3">Credentials</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Last Sync</th>
                  <th className="px-4 py-3">Errors / Health</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-charcoal-100">
                {filtered.map((integ) => (
                  <tr key={integ.id} className="hover:bg-charcoal-50/50">
                    <td className="px-4 py-3 font-bold text-charcoal-900 uppercase">
                      {integ.provider}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-semibold text-charcoal-900">{integ.brand?.name || "Global"}</div>
                      <div className="text-[11px] text-charcoal-500">{integ.workspace?.name || "Workspace"}</div>
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-charcoal-700">
                      {integ.account_identifier || "Default Store"}
                    </td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center gap-1 w-fit">
                        <Lock className="h-2.5 w-2.5" /> AES-256-GCM
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase inline-flex items-center gap-1 ${
                          integ.status === "active"
                            ? "bg-emerald-100 text-emerald-800"
                            : "bg-charcoal-100 text-charcoal-700"
                        }`}
                      >
                        {integ.status === "active" ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                        {integ.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-charcoal-500 text-[11px]">
                      {integ.last_synced_at ? new Date(integ.last_synced_at).toLocaleString() : "Never"}
                    </td>
                    <td className="px-4 py-3">
                      {integ.last_error_message ? (
                        <span className="text-red-600 font-mono text-[11px] max-w-xs truncate block" title={integ.last_error_message}>
                          {integ.last_error_message}
                        </span>
                      ) : (
                        <span className="text-emerald-600 text-[11px] font-medium">Healthy</span>
                      )}
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-charcoal-400">
                      No matching integrations found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
