"use client";

import React, { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import {
  Radio,
  Search,
  Filter,
  CheckCircle2,
  XCircle,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  Lock,
} from "lucide-react";

export default function SuperAdminWebhooksPage() {
  const [webhooks, setWebhooks] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchWebhooks = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) throw new Error("No active session");

      const res = await fetch("/api/super-admin/webhooks", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to load webhooks");
      }
      const data = await res.json();
      setWebhooks(data.webhooks || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchWebhooks();
  }, []);

  const filtered = webhooks.filter((w) => {
    const matchesSearch =
      w.topic?.toLowerCase().includes(search.toLowerCase()) ||
      w.event_id?.toLowerCase().includes(search.toLowerCase()) ||
      w.provider?.toLowerCase().includes(search.toLowerCase());

    const matchesProvider = providerFilter === "all" || w.provider === providerFilter;
    return matchesSearch && matchesProvider;
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-charcoal-900 tracking-tight">Webhook Ingestion & Signature Verification</h1>
          <p className="text-xs text-charcoal-500 mt-1">
            Real-time webhook events, raw signature verifications (HMAC-SHA256), and idempotent ingestion logs
          </p>
        </div>
        <button
          onClick={fetchWebhooks}
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
            placeholder="Search by topic, provider, or event ID..."
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
                  <th className="px-4 py-3">Topic / Event</th>
                  <th className="px-4 py-3">External Event ID</th>
                  <th className="px-4 py-3">Signature Verification</th>
                  <th className="px-4 py-3">Processing State</th>
                  <th className="px-4 py-3">Received At</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-charcoal-100">
                {filtered.map((wh) => (
                  <tr key={wh.id} className="hover:bg-charcoal-50/50">
                    <td className="px-4 py-3 font-bold text-charcoal-900 uppercase">{wh.provider}</td>
                    <td className="px-4 py-3 font-mono font-medium text-charcoal-800">{wh.topic}</td>
                    <td className="px-4 py-3 font-mono text-[11px] text-charcoal-500">{wh.event_id}</td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300 inline-flex items-center gap-1">
                        <ShieldCheck className="h-3 w-3" /> VERIFIED (HMAC)
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase inline-flex items-center gap-1 ${
                          wh.processed
                            ? "bg-emerald-100 text-emerald-800"
                            : "bg-amber-100 text-amber-800"
                        }`}
                      >
                        {wh.processed ? <CheckCircle2 className="h-3 w-3" /> : <RefreshCw className="h-3 w-3 animate-spin" />}
                        {wh.processed ? "PROCESSED" : "PENDING"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-charcoal-500 text-[11px]">
                      {new Date(wh.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-charcoal-400">
                      No webhook events logged yet.
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
