"use client";

import React, { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import {
  Cpu,
  CheckCircle2,
  XCircle,
  RefreshCw,
  ExternalLink,
  ShieldCheck,
  Activity,
  Layers,
  Terminal,
} from "lucide-react";

export default function SuperAdminFunctionsPage() {
  const [functions, setFunctions] = useState<any[]>([]);
  const [gatewayStatus, setGatewayStatus] = useState<string>("checking");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchFunctions = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) throw new Error("No active session");

      const res = await fetch("/api/super-admin/functions", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to load Edge Functions");
      }
      const data = await res.json();
      setFunctions(data.functions || []);
      setGatewayStatus(data.gateway_status || "online");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchFunctions();
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-charcoal-900 tracking-tight">Supabase Serverless Edge Functions</h1>
          <p className="text-xs text-charcoal-500 mt-1">
            Real-time status, deployment health, and invocation diagnostics for Deno edge runtimes
          </p>
        </div>
        <button
          onClick={fetchFunctions}
          className="p-2 border border-charcoal-200 hover:bg-charcoal-50 text-charcoal-700 rounded-lg transition-colors flex items-center gap-1.5 text-xs font-semibold"
        >
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      <div className="bg-white p-4 rounded-xl border border-charcoal-200/80 shadow-xs flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-charcoal-100 flex items-center justify-center">
            <Terminal className="h-5 w-5 text-charcoal-700" />
          </div>
          <div>
            <span className="text-xs font-bold text-charcoal-900">Edge Gateway Runtime</span>
            <p className="text-[11px] text-charcoal-500">Supabase Edge Runtime v1.66 / Deno 2.x Architecture</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
          <span className="text-xs font-bold text-emerald-700 uppercase">Gateway Online</span>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center p-12">
          <RefreshCw className="h-6 w-6 text-charcoal-400 animate-spin" />
        </div>
      ) : error ? (
        <div className="p-4 bg-red-50 border border-red-200 text-red-700 rounded-xl text-xs">{error}</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {functions.map((fn) => (
            <div key={fn.name} className="bg-white p-5 rounded-xl border border-charcoal-200/80 shadow-xs space-y-4 flex flex-col justify-between">
              <div>
                <div className="flex items-start justify-between">
                  <h3 className="font-bold text-charcoal-900 text-sm font-mono">{fn.name}</h3>
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                      fn.status === "deployed" || fn.status === "ready"
                        ? "bg-emerald-100 text-emerald-800"
                        : "bg-blue-100 text-blue-800"
                    }`}
                  >
                    {fn.status}
                  </span>
                </div>
                <p className="text-xs text-charcoal-600 mt-2">{fn.purpose}</p>
                <div className="mt-3 flex items-center gap-2">
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-charcoal-100 text-charcoal-700">
                    Path: /functions/v1/{fn.name}
                  </span>
                </div>
              </div>

              <div className="pt-3 border-t border-charcoal-100 text-xs space-y-1">
                <div className="flex items-center justify-between text-charcoal-500">
                  <span>Runtime:</span>
                  <span className="font-mono text-charcoal-800">Deno / Edge</span>
                </div>
                <div className="flex items-center justify-between text-charcoal-500">
                  <span>Auth Guard:</span>
                  <span className="font-semibold text-emerald-700">Bearer JWT / HMAC</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
