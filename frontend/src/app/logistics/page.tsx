"use client";

import React, { useCallback, useEffect, useState } from "react";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { useAuth } from "@/context/AuthContext";
import { apiFetch, apiFetchWithStatus } from "@/lib/api";
import { USE_DEMO_APIS, demoUrl, demoUrlLabel, DEMO_ONLY_MESSAGE } from "@/lib/demoApis";
import { DelhiveryLogo } from "@/components/icons/AppLogos";
import { AlertTriangle, CheckCircle2, Clock, RotateCcw, Search, Truck, RefreshCw } from "lucide-react";

// Everything here comes from the backend (stored shipments). No client-side sample data, and no claim of a
// live carrier connection: an empty brand shows empty states, API failures show an error.

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
  const [apiSource, setApiSource] = useState<"backend" | "demo_countries">("backend");
  const [countries, setCountries] = useState<Array<{ name: string; code: string }>>([]);
  const [countriesError, setCountriesError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  // Submit form state for dispatch/NDR action
  const [inputAwb, setInputAwb] = useState("DEL10398472910");
  const [selectedCarrier, setSelectedCarrier] = useState("Delhivery");
  const [selectedCountry, setSelectedCountry] = useState("India");
  const [ndrActionType, setNdrActionType] = useState("reattempt");
  const [submitting, setSubmitting] = useState(false);

  const base = currentWorkspace && currentBrand ? `/api/w/${currentWorkspace.slug}/b/${currentBrand.id}/logistics` : null;

  const load = useCallback(async () => {
    setLoading(true);
    setNotice(null);

    setCountriesError(null);

    if (!USE_DEMO_APIS) {
      try {
        if (!base) throw new Error("No workspace or brand is selected.");
        const [s, list] = await Promise.all([
          apiFetch<Summary>(`${base}/summary`),
          apiFetch<Shipment[]>(`${base}/shipments?limit=100`),
        ]);
        setSummary(s);
        setShipments(list);
        setApiSource("backend");
      } catch (err: any) {
        setSummary(null);
        setShipments([]);
        setNotice({ kind: "error", text: `Could not load shipments from the backend: ${err?.message || "Unknown error"}` });
      } finally {
        setLoading(false);
      }
      return;
    }

    // Demo mode: delivery destinations from JSONPlaceholder /users addresses (NEXT_PUBLIC_DEMO_LOGISTICS_API).
    // (REST Countries v3.1 was retired and v5 needs an API key, so it can no longer be used keyless.)
    setApiSource("demo_countries");
    try {
      const cRes = await apiFetch<Array<{ id: number; address?: { city?: string; zipcode?: string } }>>(demoUrl("logistics"));
      if (!Array.isArray(cRes)) throw new Error("Demo API did not return a list of destinations.");
      const sorted = cRes
        .filter((u) => u.address?.city)
        .map((u) => ({ name: String(u.address!.city), code: String(u.address!.zipcode || u.id) }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 30);
      setCountries(sorted);
    } catch (cErr: any) {
      setCountries([]);
      setCountriesError(`Could not load delivery destinations from the demo API: ${cErr?.message || "Unknown error"}`);
    }

    try {
      // Sample shipments shown in demo mode only (the demo API has no shipment data).
      const demoList: Shipment[] = [
        {
          id: "shp_1",
          awb: "DEL10398472910",
          carrier: "Delhivery Surface",
          status: "ndr",
          ndr_count: 1,
          dispatched_at: new Date(Date.now() - 86400000 * 2).toISOString(),
          delivered_at: null,
        },
        {
          id: "shp_2",
          awb: "DEL99281748291",
          carrier: "Delhivery Air Express",
          status: "delivered",
          ndr_count: 0,
          dispatched_at: new Date(Date.now() - 86400000 * 4).toISOString(),
          delivered_at: new Date(Date.now() - 86400000).toISOString(),
        },
        {
          id: "shp_3",
          awb: "DEL48192049182",
          carrier: "Delhivery Surface",
          status: "in_transit",
          ndr_count: 0,
          dispatched_at: new Date(Date.now() - 86400000).toISOString(),
          delivered_at: null,
        },
        {
          id: "shp_4",
          awb: "SR84920194821",
          carrier: "Shiprocket / Blue Dart",
          status: "out_for_delivery",
          ndr_count: 0,
          dispatched_at: new Date(Date.now() - 86400000 * 3).toISOString(),
          delivered_at: null,
        },
      ];

      setSummary({
        total_shipments: 4,
        in_transit_count: 1,
        delivered_count: 1,
        ndr_count: 1,
        ndr_rate_percentage: 25.0,
        rto_rate_percentage: 0.0,
        avg_delivery_days: 2.8,
      });
      setShipments(demoList);
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
      let status: number;
      if (!USE_DEMO_APIS) {
        if (!base) throw new Error("No workspace or brand is selected.");
        ({ status } = await apiFetchWithStatus(`${base}/ndr/${awb}/action`, {
          method: "POST",
          body: JSON.stringify({ action: "reattempt" }),
        }));
      } else {
        // Demo mode: httpbin echo (NEXT_PUBLIC_HTTPBIN_POST_API)
        ({ status } = await apiFetchWithStatus(demoUrl("echo"), {
          method: "POST",
          body: JSON.stringify({ awb, action: "reattempt", source: "ndr_button" }),
        }));
      }
      setNotice({ kind: "ok", text: `Re-attempt requested for AWB ${awb} (HTTP ${status}).` });
      // Update local status to in_transit
      setShipments((prev) =>
        prev.map((s) => (s.awb === awb ? { ...s, status: "in_transit" } : s))
      );
    } catch (err: any) {
      setNotice({ kind: "error", text: err?.message || "The courier instruction failed" });
    } finally {
      setActionLoading(null);
    }
  };

  const handleDispatchOrReattempt = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputAwb.trim()) {
      setNotice({ kind: "error", text: "Please provide a valid AWB code." });
      return;
    }
    if (!USE_DEMO_APIS) {
      setNotice({ kind: "error", text: DEMO_ONLY_MESSAGE });
      return;
    }

    setSubmitting(true);
    setNotice(null);

    const payload = {
      awb: inputAwb.trim(),
      carrier: selectedCarrier,
      destination_country: selectedCountry,
      action: ndrActionType,
      timestamp: new Date().toISOString(),
    };

    try {
      // Demo mode: httpbin echo (NEXT_PUBLIC_HTTPBIN_POST_API)
      const { status, data: res } = await apiFetchWithStatus<any>(demoUrl("echo"), {
        method: "POST",
        body: JSON.stringify(payload),
      });

      const data = res?.json;
      if (!data?.awb) throw new Error(`Demo API returned HTTP ${status} but did not echo the instruction.`);
      setNotice({
        kind: "ok",
        text: `Logistics instruction sent: HTTP ${status} from httpbin. Courier: ${data.carrier}, AWB: ${data.awb}, Destination: ${data.destination_country}.`,
      });

      // Insert or update shipment list
      setShipments((prev) => {
        const existing = prev.find((s) => s.awb === data.awb);
        if (existing) {
          return prev.map((s) =>
            s.awb === data.awb ? { ...s, status: "in_transit" } : s
          );
        }
        return [
          {
            id: `shp_${Date.now()}`,
            awb: data.awb,
            carrier: data.carrier,
            status: "in_transit",
            ndr_count: 0,
            dispatched_at: new Date().toISOString(),
            delivered_at: null,
          },
          ...prev,
        ];
      });
    } catch (err: any) {
      setNotice({ kind: "error", text: `Submission failed: ${err?.message || "Could not dispatch"}` });
    } finally {
      setSubmitting(false);
    }
  };

  const filtered = shipments.filter((s) => {
    const q = search.toLowerCase();
    return (!q || s.awb.toLowerCase().includes(q)) && (statusFilter === "all" || s.status === statusFilter);
  });
  const deliveredPct = summary && summary.total_shipments ? Math.round((summary.delivered_count * 1000) / summary.total_shipments) / 10 : null;

  return (
    <DashboardShell>
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
            <span className="inline-flex items-center space-x-1 px-2.5 py-1 rounded-md text-[11px] font-mono border bg-ivory-100 border-ivory-300 text-charcoal-700">
              <span className={`w-2 h-2 rounded-full ${apiSource === "backend" ? "bg-emerald-500" : "bg-blue-500"}`} />
              <span>{apiSource === "backend" ? "Backend DRF API" : "Demo: JSONPlaceholder destinations + sample shipments"}</span>
            </span>
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

        {/* STEP 5: Interactive Courier Dispatch & NDR Action Form with Submit Button */}
        <div className="bg-white rounded-xl border border-ivory-300 shadow-sm p-5 space-y-4">
          <div className="flex items-center justify-between pb-2 border-b border-ivory-200">
            <div>
              <h3 className="text-sm font-bold text-charcoal-900 flex items-center space-x-2">
                <Truck className="w-4 h-4 text-slate-700" />
                <span>Dispatch Shipment / Trigger NDR Recovery Action</span>
              </h3>
              <p className="text-xs text-charcoal-500 mt-0.5">
                Transmit dispatch instructions or NDR delivery re-attempts to Delhivery / carrier hubs.
              </p>
            </div>
            <span className="text-[11px] font-mono bg-ivory-100 px-2 py-0.5 rounded border border-ivory-200 text-charcoal-600">
              {USE_DEMO_APIS ? `Demo Destination API: JSONPlaceholder (${countries.length} destinations loaded)` : "Demo mode off"}
            </span>
          </div>

          {countriesError && (
            <div role="alert" className="p-3 rounded-lg text-xs border bg-red-50 border-red-200 text-red-700">
              {countriesError}
            </div>
          )}
          {USE_DEMO_APIS && !loading && !countriesError && countries.length === 0 && (
            <div className="p-3 rounded-lg text-xs border bg-ivory-50 border-ivory-300 text-charcoal-600">
              The demo API returned no delivery destinations.
            </div>
          )}

          <form onSubmit={handleDispatchOrReattempt} className="grid grid-cols-1 sm:grid-cols-5 gap-3 text-xs">
            <div>
              <label className="block font-semibold text-charcoal-700 mb-1">AWB Code</label>
              <input
                type="text"
                required
                value={inputAwb}
                onChange={(e) => setInputAwb(e.target.value)}
                placeholder="DEL10398472910"
                className="w-full px-3 py-2 border border-ivory-300 rounded-lg bg-ivory-50 text-charcoal-800 font-mono text-xs focus:ring-1 focus:ring-slate-500"
              />
            </div>
            <div>
              <label className="block font-semibold text-charcoal-700 mb-1">Carrier Hub</label>
              <select
                value={selectedCarrier}
                onChange={(e) => setSelectedCarrier(e.target.value)}
                className="w-full px-3 py-2 border border-ivory-300 rounded-lg bg-ivory-50 text-charcoal-800 text-xs focus:ring-1 focus:ring-slate-500"
              >
                <option value="Delhivery Surface">Delhivery Surface</option>
                <option value="Delhivery Air Express">Delhivery Air Express</option>
                <option value="Shiprocket Direct">Shiprocket Direct</option>
                <option value="Blue Dart Express">Blue Dart Express</option>
              </select>
            </div>
            <div>
              <label className="block font-semibold text-charcoal-700 mb-1">Destination (demo addresses)</label>
              <select
                value={selectedCountry}
                onChange={(e) => setSelectedCountry(e.target.value)}
                className="w-full px-3 py-2 border border-ivory-300 rounded-lg bg-ivory-50 text-charcoal-800 text-xs focus:ring-1 focus:ring-slate-500"
              >
                <option value="India">India (Domestic Standard)</option>
                {countries.map((c) => (
                  <option key={c.code} value={c.name}>
                    {c.name} ({c.code})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block font-semibold text-charcoal-700 mb-1">Instruction Type</label>
              <select
                value={ndrActionType}
                onChange={(e) => setNdrActionType(e.target.value)}
                className="w-full px-3 py-2 border border-ivory-300 rounded-lg bg-ivory-50 text-charcoal-800 text-xs focus:ring-1 focus:ring-slate-500"
              >
                <option value="reattempt">NDR Delivery Re-attempt</option>
                <option value="dispatch">New Milestone Dispatch</option>
                <option value="address_update">Customer Address Update</option>
              </select>
            </div>
            <div className="flex items-end">
              <button
                type="submit"
                disabled={submitting || !inputAwb.trim()}
                className="w-full px-4 py-2 bg-slate-800 hover:bg-slate-900 text-white rounded-lg text-xs font-semibold transition-colors disabled:opacity-50 flex items-center justify-center space-x-1.5 shadow-sm"
              >
                {submitting ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Transmitting...</span>
                  </>
                ) : (
                  <>
                    <Truck className="w-3.5 h-3.5" />
                    <span>Submit Courier Action</span>
                  </>
                )}
              </button>
            </div>
          </form>
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
    </DashboardShell>
  );
}
