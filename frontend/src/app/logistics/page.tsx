"use client";

import React, { useCallback, useEffect, useState } from "react";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { ModuleGuard } from "@/components/auth/ModuleGuard";
import { useAuth } from "@/context/AuthContext";
import { apiFetch, apiFetchWithStatus } from "@/lib/api";
import { DelhiveryLogo } from "@/components/icons/AppLogos";
import { AlertTriangle, CheckCircle2, Clock, RotateCcw, Search, RefreshCw } from "lucide-react";

interface Summary {
  total_shipments: number;
  in_transit_count: number;
  delivered_count: number;
  ndr_count: number;
  ndr_rate_percentage: number | null;
  rto_rate_percentage: number | null;
  avg_delivery_days: number | null;
}

interface Shipment {
  id: string;
  awb: string;
  carrier: string;
  status: string;
  ndr_count: number;
  dispatched_at: string | null;
  delivered_at: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  created: "Booked",
  pickup_pending: "Awaiting Pickup",
  in_transit: "In Transit",
  out_for_delivery: "Out For Delivery",
  delivered: "Delivered",
  ndr: "NDR (Action Req)",
  rto_initiated: "RTO Initiated",
  rto_delivered: "RTO Delivered",
  cancelled: "Cancelled",
};

const pct = (v: number | null) => (v == null ? "—" : `${v}%`);

export default function LogisticsPage() {
  const { currentBrand, currentWorkspace } = useAuth();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const base = currentWorkspace && currentBrand ? `/api/w/${currentWorkspace.slug}/b/${currentBrand.id}/logistics` : null;

  const load = useCallback(async () => {
    setLoading(true);
    setNotice(null);

    try {
      if (!base) {
        setLoading(false);
        return;
      }
      const [s, list] = await Promise.all([
        apiFetch<Summary>(`${base}/summary`),
        apiFetch<Shipment[]>(`${base}/shipments?limit=100`),
      ]);
      setSummary(s);
      setShipments(Array.isArray(list) ? list : (list as any)?.shipments || []);
    } catch (err: any) {
      setSummary(null);
      setShipments([]);
      setNotice({ kind: "error", text: `Could not load shipments: ${err?.message || "Unknown error"}` });
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    load();
  }, [load]);

  const handleNdrAction = async (awb: string) => {
    setActionLoading(awb);
    setNotice(null);
    try {
      if (!base) throw new Error("No workspace or brand is selected.");
      const { status } = await apiFetchWithStatus(`${base}/ndr/${awb}/action`, {
        method: "POST",
        body: JSON.stringify({ action: "reattempt" }),
      });
      setNotice({ kind: "ok", text: `Re-attempt requested for AWB ${awb} (HTTP ${status}).` });
      setShipments((prev) =>
        prev.map((s) => (s.awb === awb ? { ...s, status: "in_transit" } : s))
      );
    } catch (err: any) {
      setNotice({ kind: "error", text: err?.message || "The courier instruction failed" });
    } finally {
      setActionLoading(null);
    }
  };

  const filtered = (Array.isArray(shipments) ? shipments : []).filter((s) => {
    const q = search.toLowerCase();
    return (!q || s.awb.toLowerCase().includes(q)) && (statusFilter === "all" || s.status === statusFilter);
  });
  const deliveredPct = summary && summary.total_shipments ? Math.round((summary.delivered_count * 1000) / summary.total_shipments) / 10 : null;

  return (
    <DashboardShell>
      <ModuleGuard moduleKey="delivery" moduleName="Logistics & Delivery">
        <div className="space-y-6 font-sans">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-2 border-b border-ivory-300">
          <div className="flex items-center space-x-2.5">
            <div className="w-9 h-9 rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center p-1.5 flex-shrink-0">
              <DelhiveryLogo className="w-full h-full object-contain" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-charcoal-900 tracking-tight">Logistics &amp; Delivery Intelligence</h2>
              <p className="text-xs text-charcoal-500 mt-0.5">
                Shipment status and NDR recovery for <strong>{currentBrand?.name || "your brand"}</strong>.
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <span className="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-md bg-emerald-50 text-emerald-700 text-xs font-medium border border-emerald-200">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
              <span>Carrier API Ready</span>
            </span>
          </div>
        </div>

        {notice && (
          <div
            role={notice.kind === "error" ? "alert" : "status"}
            className={`p-3 rounded-lg text-xs border ${notice.kind === "error" ? "bg-red-50 border-red-200 text-red-700" : "bg-emerald-50 border-emerald-200 text-emerald-700"}`}
          >
            {notice.text}
          </div>
        )}

        {summary && summary.total_shipments === 0 && (
          <div className="p-4 rounded-lg bg-ivory-50 border border-ivory-300 text-xs text-charcoal-600">
            No shipments recorded for this brand yet.
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="p-5 rounded-xl bg-white border border-ivory-300 shadow-sm space-y-2">
            <div className="flex items-center justify-between text-xs text-charcoal-500 font-medium">
              <span>Delivery Success %</span>
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            </div>
            <div className="text-2xl font-bold text-charcoal-900 tracking-tight">{pct(deliveredPct)}</div>
            <div className="text-[11px] text-charcoal-400">
              {summary ? `${summary.delivered_count} of ${summary.total_shipments} shipments delivered` : ""}
            </div>
          </div>
          <div className="p-5 rounded-xl bg-white border border-ivory-300 shadow-sm space-y-2">
            <div className="flex items-center justify-between text-xs text-charcoal-500 font-medium">
              <span>In Transit</span>
              <Clock className="w-4 h-4 text-amber-600" />
            </div>
            <div className="text-2xl font-bold text-charcoal-900 tracking-tight">{summary ? summary.in_transit_count : "—"}</div>
            <div className="text-[11px] text-charcoal-400">
              {summary?.avg_delivery_days != null ? `Avg delivery ${summary.avg_delivery_days} days` : ""}
            </div>
          </div>
          <div className="p-5 rounded-xl bg-white border border-ivory-300 shadow-sm space-y-2">
            <div className="flex items-center justify-between text-xs text-charcoal-500 font-medium">
              <span>NDR (Non-Delivery) Rate</span>
              <AlertTriangle className="w-4 h-4 text-amber-600" />
            </div>
            <div className="text-2xl font-bold text-charcoal-900 tracking-tight">{pct(summary?.ndr_rate_percentage ?? null)}</div>
            <div className="text-[11px] text-charcoal-400">{summary ? `${summary.ndr_count} shipments need action` : ""}</div>
          </div>
          <div className="p-5 rounded-xl bg-white border border-ivory-300 shadow-sm space-y-2">
            <div className="flex items-center justify-between text-xs text-charcoal-500 font-medium">
              <span>RTO (Return to Origin) %</span>
              <RotateCcw className="w-4 h-4 text-red-500" />
            </div>
            <div className="text-2xl font-bold text-charcoal-900 tracking-tight">{pct(summary?.rto_rate_percentage ?? null)}</div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-ivory-300 shadow-sm overflow-hidden">
          <div className="p-4 border-b border-ivory-200 flex flex-col md:flex-row md:items-center justify-between gap-3">
            <h3 className="text-sm font-bold text-charcoal-900">Shipments &amp; AWB Dispatch Log</h3>
            <div className="flex items-center space-x-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-charcoal-400" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search AWB…"
                  className="pl-8 pr-3 py-2 text-xs border border-ivory-300 rounded-lg"
                />
              </div>
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="text-xs border border-ivory-300 rounded-lg px-2 py-2">
                <option value="all">All statuses</option>
                {Object.entries(STATUS_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <table className="w-full text-left text-xs">
            <thead className="bg-ivory-50 text-charcoal-500">
              <tr>
                <th className="px-4 py-2 font-medium">AWB</th>
                <th className="px-4 py-2 font-medium">Carrier</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">NDR attempts</th>
                <th className="px-4 py-2 font-medium">Dispatched</th>
                <th className="px-4 py-2 font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ivory-200">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-charcoal-500">
                    <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-slate-600" />
                    <span>Loading courier shipments &amp; carrier routes...</span>
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-charcoal-500">
                    No shipments {shipments.length ? "match these filters" : "recorded yet"}.
                  </td>
                </tr>
              ) : (
                filtered.map((s) => (
                  <tr key={s.id}>
                    <td className="px-4 py-2 font-mono">{s.awb}</td>
                    <td className="px-4 py-2">{s.carrier}</td>
                    <td className="px-4 py-2">{STATUS_LABEL[s.status] ?? s.status}</td>
                    <td className="px-4 py-2">{s.ndr_count}</td>
                    <td className="px-4 py-2 text-charcoal-500">{s.dispatched_at ? new Date(s.dispatched_at).toLocaleDateString("en-IN") : "—"}</td>
                    <td className="px-4 py-2">
                      {s.status === "ndr" && (
                        <button
                          onClick={() => handleNdrAction(s.awb)}
                          disabled={actionLoading === s.awb}
                          className="px-2.5 py-1 rounded bg-charcoal-900 text-white text-[11px] font-semibold disabled:opacity-50"
                        >
                          {actionLoading === s.awb ? "Sending…" : "Request re-attempt"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        </div>
      </ModuleGuard>
    </DashboardShell>
  );
}
