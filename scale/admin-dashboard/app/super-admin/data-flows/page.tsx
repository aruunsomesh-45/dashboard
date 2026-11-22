"use client";

import React, { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  XCircle,
  Clock,
  RefreshCw,
  AlertTriangle,
  Database,
  Cpu,
  Layers,
  Search,
} from "lucide-react";

export default function SuperAdminDataFlowsPage() {
  const [data, setData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDataFlows = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) throw new Error("No active session");

      const res = await fetch("/api/super-admin/data-flows", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to load data flows");
      }
      const json = await res.json();
      setData(json);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchDataFlows();
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-charcoal-900 tracking-tight">Data Flow & Pipeline Telemetry</h1>
          <p className="text-xs text-charcoal-500 mt-1">
            End-to-end ingestion pipeline: External API → Edge Function → Data Validation → Database → Analytics
          </p>
        </div>
        <button
          onClick={fetchDataFlows}
          className="p-2 border border-charcoal-200 hover:bg-charcoal-50 text-charcoal-700 rounded-lg transition-colors flex items-center gap-1.5 text-xs font-semibold"
        >
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center p-12">
          <RefreshCw className="h-6 w-6 text-charcoal-400 animate-spin" />
        </div>
      ) : error ? (
        <div className="p-4 bg-red-50 border border-red-200 text-red-700 rounded-xl text-xs">{error}</div>
      ) : (
        <div className="space-y-6">
          {/* Visual 5-Stage Architecture Flow */}
          <div className="bg-white p-6 rounded-xl border border-charcoal-200/80 shadow-xs">
            <h3 className="text-sm font-bold text-charcoal-900 mb-4">Pipeline Architecture Execution Stages</h3>

            <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
              {(data?.stages || []).map((stage: any, idx: number) => (
                <div key={idx} className="relative p-4 rounded-xl border border-charcoal-200 bg-charcoal-50/50 flex flex-col justify-between">
                  <div>
                    <span className="text-[10px] font-mono font-bold text-charcoal-400">STAGE 0{idx + 1}</span>
                    <h4 className="text-xs font-bold text-charcoal-900 mt-1">{stage.name}</h4>
                    <p className="text-[11px] text-charcoal-500 mt-1">{stage.description}</p>
                  </div>
                  <div className="mt-4 pt-3 border-t border-charcoal-200/60 flex items-center justify-between">
                    <span className="flex items-center gap-1 text-[11px] font-semibold text-emerald-700">
                      <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse"></span>
                      {stage.status || "Operational"}
                    </span>
                    <span className="text-[10px] font-mono text-charcoal-400">{stage.latency || "< 120ms"}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Recent Sync Runs */}
          <div className="bg-white rounded-xl border border-charcoal-200/80 overflow-hidden shadow-xs">
            <div className="p-4 bg-charcoal-50/70 border-b border-charcoal-200/80">
              <h3 className="text-sm font-bold text-charcoal-900">Live Ingestion Executions</h3>
              <p className="text-xs text-charcoal-500">Cross-tenant batch jobs executing through Supabase Edge Functions</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="bg-charcoal-50 border-b border-charcoal-200 text-charcoal-500 font-semibold uppercase text-[10px] tracking-wider">
                    <th className="px-4 py-3">Provider</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Records Processed</th>
                    <th className="px-4 py-3">Started</th>
                    <th className="px-4 py-3">Duration / Latency</th>
                    <th className="px-4 py-3">Sanitized Error</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-charcoal-100">
                  {(data?.recent_syncs || []).map((sr: any) => {
                    const duration =
                      sr.completed_at && sr.started_at
                        ? `${Math.round((new Date(sr.completed_at).getTime() - new Date(sr.started_at).getTime()) / 1000)}s`
                        : "In flight";

                    return (
                      <tr key={sr.id} className="hover:bg-charcoal-50/50">
                        <td className="px-4 py-3 font-bold text-charcoal-900 uppercase">{sr.provider}</td>
                        <td className="px-4 py-3">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                              sr.status === "completed"
                                ? "bg-emerald-100 text-emerald-800"
                                : sr.status === "failed"
                                ? "bg-red-100 text-red-800"
                                : "bg-blue-100 text-blue-800"
                            }`}
                          >
                            {sr.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-mono">{sr.records_processed ?? 0}</td>
                        <td className="px-4 py-3 text-charcoal-500">{new Date(sr.started_at).toLocaleString()}</td>
                        <td className="px-4 py-3 font-mono text-charcoal-600">{duration}</td>
                        <td className="px-4 py-3 text-red-600 font-mono text-[11px]">{sr.error_message || "—"}</td>
                      </tr>
                    );
                  })}
                  {(!data?.recent_syncs || data.recent_syncs.length === 0) && (
                    <tr>
                      <td colSpan={6} className="px-4 py-6 text-center text-charcoal-400">
                        No synchronization records found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
