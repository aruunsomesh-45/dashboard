"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";
import {
  Users,
  Building2,
  Boxes,
  PlugZap,
  Activity,
  Cpu,
  Webhook,
  AlertTriangle,
  CheckCircle2,
  ArrowRight,
  TrendingUp,
  ShieldCheck,
  RefreshCw,
} from "lucide-react";

export default function SuperAdminOverviewPage() {
  const [data, setData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchOverview = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) throw new Error("No active session");

      const res = await fetch("/api/super-admin/overview", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const errJson = await res.json();
        throw new Error(errJson.error || "Failed to load overview");
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
    fetchOverview();
  }, []);

  if (isLoading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <div className="flex flex-col items-center space-y-3">
          <div className="w-8 h-8 border-2 border-forest-900 border-t-transparent rounded-full animate-spin" />
          <div className="text-xs text-charcoal-500 font-medium">Loading platform metrics…</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 bg-rose-50 border border-rose-200 rounded-2xl text-rose-800 text-sm flex items-center justify-between">
        <div>
          <div className="font-bold">Error loading executive overview</div>
          <div className="text-xs text-rose-600 mt-1">{error}</div>
        </div>
        <button
          onClick={fetchOverview}
          className="px-4 py-2 bg-rose-700 text-white rounded-xl text-xs font-semibold hover:bg-rose-800"
        >
          Retry
        </button>
      </div>
    );
  }

  const m = data?.metrics || {};

  const kpis = [
    { label: "Total Platform Users", value: m.total_users, sub: `${m.active_users} active · ${m.suspended_users} suspended`, icon: Users, color: "text-blue-600", bg: "bg-blue-50" },
    { label: "Total Workspaces", value: m.total_workspaces, sub: `${m.total_brands} active brands`, icon: Building2, color: "text-forest-600", bg: "bg-forest-100" },
    { label: "Active Integrations", value: `${m.active_integrations}/${m.total_integrations}`, sub: "Shopify, Razorpay, Meta, IG", icon: PlugZap, color: "text-amber-600", bg: "bg-amber-50" },
    { label: "Platform Modules", value: `${m.active_modules}/${m.total_modules}`, sub: "Per-user RBAC enabled", icon: Boxes, color: "text-purple-600", bg: "bg-purple-50" },
  ];

  return (
    <div className="space-y-8">
      {/* Header bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-charcoal-900 tracking-tight">Executive Platform Overview</h1>
          <p className="text-xs text-charcoal-500 mt-1">
            Real-time status of multi-tenant infrastructure, per-user module allocations, and edge services.
          </p>
        </div>
        <div className="flex items-center space-x-3">
          <button
            onClick={fetchOverview}
            className="flex items-center space-x-1.5 px-3 py-2 bg-white border border-ivory-300 rounded-xl text-xs font-semibold text-charcoal-700 hover:bg-ivory-50 shadow-2xs transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh Metrics</span>
          </button>
          <Link
            href="/super-admin/users"
            className="flex items-center space-x-1.5 px-4 py-2 bg-forest-900 text-ivory-100 rounded-xl text-xs font-semibold hover:bg-forest-800 shadow-sm transition-colors"
          >
            <span>Manage Users</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        {kpis.map((kpi) => {
          const Icon = kpi.icon;
          return (
            <div key={kpi.label} className="p-5 bg-white rounded-2xl border border-ivory-300 shadow-2xs flex flex-col justify-between">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-semibold text-charcoal-500">{kpi.label}</span>
                <div className={`w-9 h-9 rounded-xl ${kpi.bg} flex items-center justify-center ${kpi.color}`}>
                  <Icon className="w-5 h-5" />
                </div>
              </div>
              <div>
                <div className="text-3xl font-extrabold text-charcoal-900 tracking-tight">{kpi.value}</div>
                <div className="text-[11px] text-charcoal-500 font-medium mt-1">{kpi.sub}</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Health & Throughput Banner */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="p-5 bg-emerald-950/90 text-emerald-100 rounded-2xl border border-emerald-800 flex items-center space-x-4">
          <div className="w-10 h-10 rounded-xl bg-emerald-800 flex items-center justify-center text-emerald-300 flex-shrink-0">
            <CheckCircle2 className="w-6 h-6" />
          </div>
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-emerald-400">Sync Success Health</div>
            <div className="text-xl font-extrabold text-white">{m.sync_success_rate}</div>
            <div className="text-[11px] text-emerald-300/80">Active background pipelines healthy</div>
          </div>
        </div>

        <div className="p-5 bg-forest-900 text-ivory-100 rounded-2xl border border-forest-800 flex items-center space-x-4">
          <div className="w-10 h-10 rounded-xl bg-forest-800 flex items-center justify-center text-amber-400 flex-shrink-0">
            <Webhook className="w-6 h-6" />
          </div>
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-forest-400">Webhooks Received</div>
            <div className="text-xl font-extrabold text-white">{m.total_webhooks} Events</div>
            <div className="text-[11px] text-ivory-300/80">{m.duplicate_webhooks} Deduplicated & Saved</div>
          </div>
        </div>

        <div className="p-5 bg-white rounded-2xl border border-ivory-300 shadow-2xs flex items-center space-x-4">
          <div className="w-10 h-10 rounded-xl bg-terracotta-100 flex items-center justify-center text-terracotta-600 flex-shrink-0">
            <Activity className="w-6 h-6" />
          </div>
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-charcoal-500">Orders Processed</div>
            <div className="text-xl font-extrabold text-charcoal-900">{m.total_orders} Orders</div>
            <div className="text-[11px] text-charcoal-500">Canonical multi-tenant records</div>
          </div>
        </div>
      </div>

      {/* Two Column Section: Recent Users & Recent Audit Trail */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Recent Registered Users */}
        <div className="bg-white rounded-2xl border border-ivory-300 shadow-2xs p-6">
          <div className="flex items-center justify-between mb-5">
            <div>
              <h2 className="text-base font-bold text-charcoal-900">Recent Platform Users</h2>
              <p className="text-xs text-charcoal-500 mt-0.5">Latest registrations across all workspaces</p>
            </div>
            <Link
              href="/super-admin/users"
              className="text-xs font-semibold text-forest-700 hover:text-forest-900 flex items-center space-x-1"
            >
              <span>View All</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>

          <div className="divide-y divide-ivory-200">
            {(data?.recent_users || []).map((u: any) => (
              <div key={u.id} className="py-3.5 flex items-center justify-between">
                <div>
                  <div className="text-xs font-bold text-charcoal-900 flex items-center space-x-2">
                    <span>{u.email}</span>
                    {u.is_superuser && (
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-extrabold uppercase bg-amber-100 text-amber-800 border border-amber-300">
                        Admin
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-charcoal-500 mt-0.5">
                    Registered: {new Date(u.created_at).toLocaleDateString()}
                  </div>
                </div>
                <div className="flex items-center space-x-2">
                  <span
                    className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                      u.is_active ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"
                    }`}
                  >
                    {u.is_active ? "Active" : "Suspended"}
                  </span>
                  <Link
                    href={`/super-admin/users/${u.id}`}
                    className="p-1 rounded-lg text-charcoal-400 hover:text-forest-900 hover:bg-ivory-100"
                  >
                    <ArrowRight className="w-4 h-4" />
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Recent Admin Audit Logs */}
        <div className="bg-white rounded-2xl border border-ivory-300 shadow-2xs p-6">
          <div className="flex items-center justify-between mb-5">
            <div>
              <h2 className="text-base font-bold text-charcoal-900">Security & Permission Audit Trail</h2>
              <p className="text-xs text-charcoal-500 mt-0.5">Immutable record of admin actions</p>
            </div>
            <Link
              href="/super-admin/audit-logs"
              className="text-xs font-semibold text-forest-700 hover:text-forest-900 flex items-center space-x-1"
            >
              <span>Full Audit Log</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>

          <div className="space-y-3">
            {(data?.recent_audit_logs || []).length === 0 ? (
              <div className="p-8 text-center text-xs text-charcoal-500">
                No administrative actions logged yet. All future permission and status changes will be recorded here.
              </div>
            ) : (
              (data?.recent_audit_logs || []).map((log: any) => (
                <div key={log.id} className="p-3 bg-ivory-50 rounded-xl border border-ivory-200 text-xs flex items-center justify-between">
                  <div>
                    <div className="font-bold text-charcoal-900">{log.action}</div>
                    <div className="text-[11px] text-charcoal-500 mt-0.5">
                      {log.metadata?.moduleKey ? `Module: ${log.metadata.moduleKey} · ` : ""}
                      {new Date(log.created_at).toLocaleString()}
                    </div>
                  </div>
                  <span className="text-[10px] text-charcoal-400 font-mono">
                    {log.target_user_id ? log.target_user_id.slice(0, 8) : "System"}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
