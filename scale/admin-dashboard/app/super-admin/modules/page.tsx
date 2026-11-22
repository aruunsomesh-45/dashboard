"use client";

import React, { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import {
  Boxes,
  ShieldAlert,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Power,
  Sliders,
  AlertTriangle,
} from "lucide-react";

export default function SuperAdminModulesPage() {
  const [modules, setModules] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchModules = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) throw new Error("No active session");

      const res = await fetch("/api/super-admin/modules", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to load modules");
      }
      const data = await res.json();
      setModules(data.modules || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchModules();
  }, []);

  const handleToggleGlobalModule = async (module: any) => {
    const newStatus = !module.is_active;
    const msg = newStatus
      ? `Re-enable ${module.module_name} globally? This makes it available across all tenants.`
      : `Disable ${module.module_name} GLOBALLY? This is a platform kill-switch: ALL users across all workspaces will immediately lose access to this module, regardless of individual permissions.`;

    if (!confirm(msg)) return;

    setActionLoading(module.id);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;

      const res = await fetch("/api/super-admin/modules", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          moduleId: module.id,
          isActive: newStatus,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to update module");
      }
      await fetchModules();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-charcoal-900 tracking-tight">Platform Modules Catalog</h1>
          <p className="text-xs text-charcoal-500 mt-1">
            Global catalog of functional modules and platform-wide emergency kill switches
          </p>
        </div>
        <button
          onClick={fetchModules}
          className="p-2 border border-charcoal-200 hover:bg-charcoal-50 text-charcoal-700 rounded-lg transition-colors flex items-center gap-1.5 text-xs font-semibold"
        >
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
        <ShieldAlert className="h-5 w-5 text-amber-700 shrink-0 mt-0.5" />
        <div className="text-xs text-amber-900">
          <p className="font-bold">Global Module Kill Switches</p>
          <p className="mt-1">
            Toggling a module here turns it on or off for the <strong>entire 125East platform</strong>. If a module is
            disabled at the platform level, no tenant or user can access it, regardless of their individual user
            overrides.
          </p>
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
          {modules.map((m) => (
            <div
              key={m.id}
              className={`p-5 rounded-xl border bg-white shadow-xs space-y-4 flex flex-col justify-between ${
                m.is_active ? "border-charcoal-200/80" : "border-red-200 bg-red-50/20"
              }`}
            >
              <div>
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-bold text-charcoal-900 text-base">{m.module_name}</h3>
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                      m.is_active ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"
                    }`}
                  >
                    {m.is_active ? "ACTIVE" : "KILLED"}
                  </span>
                </div>
                <span className="font-mono text-[11px] text-charcoal-400 mt-1 block">Key: {m.module_key}</span>
                <p className="text-xs text-charcoal-600 mt-3">{m.description || "Core platform capability"}</p>
              </div>

              <div className="pt-4 border-t border-charcoal-100 flex items-center justify-between">
                <span className="text-[11px] text-charcoal-400">Created: {new Date(m.created_at).toLocaleDateString()}</span>
                <button
                  onClick={() => handleToggleGlobalModule(m)}
                  disabled={actionLoading === m.id}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                    m.is_active
                      ? "bg-red-50 border border-red-200 text-red-700 hover:bg-red-100"
                      : "bg-emerald-50 border border-emerald-200 text-emerald-700 hover:bg-emerald-100"
                  } ${actionLoading === m.id ? "opacity-50" : ""}`}
                >
                  <Power className="h-3.5 w-3.5" />
                  {m.is_active ? "Kill Globally" : "Activate Globally"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
