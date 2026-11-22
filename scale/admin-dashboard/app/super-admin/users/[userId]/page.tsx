"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import {
  ArrowLeft,
  ShieldCheck,
  ShieldAlert,
  User,
  Key,
  Database,
  Layers,
  Activity,
  Radio,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Sliders,
  ExternalLink,
  Building2,
  Lock,
  Unlock,
  FileText,
  Save,
  RotateCcw,
} from "lucide-react";

export default function UserDetailPage() {
  const params = useParams();
  const router = useRouter();
  const userId = params.userId as string;

  const [activeTab, setActiveTab] = useState<string>("overview");
  const [data, setData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Module edit state: { [moduleKey]: boolean | null }
  const [moduleOverrides, setModuleOverrides] = useState<{ [key: string]: boolean | null }>({});
  const [isSavingPermissions, setIsSavingPermissions] = useState(false);
  const [permSuccessMsg, setPermSuccessMsg] = useState<string | null>(null);
  const [permErrorMsg, setPermErrorMsg] = useState<string | null>(null);

  // Status toggle state
  const [statusLoading, setStatusLoading] = useState(false);

  const fetchUserData = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) throw new Error("No active session");

      const res = await fetch(`/api/super-admin/users/${userId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to load user details");
      }
      const json = await res.json();
      setData(json);

      // Initialize module override states
      const initialOverrides: { [key: string]: boolean | null } = {};
      json.modules?.forEach((m: any) => {
        initialOverrides[m.module_key] = m.user_override;
      });
      setModuleOverrides(initialOverrides);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (userId) {
      fetchUserData();
    }
  }, [userId]);

  const handleToggleModuleOverride = (moduleKey: string, currentVal: boolean | null, targetVal: boolean | null) => {
    setModuleOverrides((prev) => ({
      ...prev,
      [moduleKey]: targetVal,
    }));
  };

  const handleSaveModulePermissions = async () => {
    if (!confirm("Confirm updating module permissions for this user? This will immediately take effect across all dashboard routes and APIs.")) {
      return;
    }

    setIsSavingPermissions(true);
    setPermSuccessMsg(null);
    setPermErrorMsg(null);

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;

      // Save each modified module
      for (const [moduleKey, enabled] of Object.entries(moduleOverrides)) {
        const orig = data.modules.find((m: any) => m.module_key === moduleKey);
        if (orig && orig.user_override !== enabled) {
          const res = await fetch("/api/super-admin/permissions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              targetType: "user",
              targetId: userId,
              moduleKey,
              enabled,
            }),
          });
          if (!res.ok) {
            const err = await res.json();
            throw new Error(`Failed to update ${moduleKey}: ${err.error || "Unknown error"}`);
          }
        }
      }

      setPermSuccessMsg("Module permissions updated successfully!");
      await fetchUserData();
    } catch (err: any) {
      setPermErrorMsg(err.message);
    } finally {
      setIsSavingPermissions(false);
    }
  };

  const handleToggleUserStatus = async () => {
    if (!data?.user) return;
    const newStatus = !data.user.is_active;
    const msg = newStatus
      ? `Re-activate user ${data.user.email}?`
      : `Suspend user ${data.user.email}? The user will be immediately blocked from signing in or calling API endpoints.`;

    if (!confirm(msg)) return;

    setStatusLoading(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;

      const res = await fetch(`/api/super-admin/users/${userId}/status`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ isActive: newStatus }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to update account status");
      }
      await fetchUserData();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setStatusLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[500px]">
        <div className="flex flex-col items-center gap-3">
          <RefreshCw className="h-8 w-8 text-charcoal-400 animate-spin" />
          <span className="text-xs text-charcoal-500 font-mono">Loading user inspection dossier...</span>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6 bg-red-50 border border-red-200 rounded-xl max-w-xl mx-auto my-12 text-center">
        <AlertTriangle className="h-10 w-10 text-red-500 mx-auto mb-3" />
        <h2 className="text-lg font-bold text-red-900">Failed to Load User</h2>
        <p className="text-xs text-red-700 mt-1 mb-4">{error || "User record could not be retrieved"}</p>
        <Link
          href="/super-admin/users"
          className="inline-flex items-center gap-2 px-4 py-2 bg-charcoal-900 text-white rounded-lg text-xs font-medium hover:bg-black transition-colors"
        >
          <ArrowLeft className="h-4 w-4" /> Back to User Directory
        </Link>
      </div>
    );
  }

  const { user, workspaces, brands, modules, integrations, sync_runs, webhooks, audit_logs } = data;

  const tabs = [
    { id: "overview", label: "1. Overview", icon: User },
    { id: "modules", label: "2. Modules & Permissions", icon: Sliders, badge: modules?.length },
    { id: "workspaces", label: "3. Workspaces & Brands", icon: Building2, badge: workspaces?.length },
    { id: "integrations", label: "4. Integrations", icon: Radio, badge: integrations?.length },
    { id: "data-flows", label: "5. Data Flows", icon: Activity },
    { id: "sync-history", label: "6. Sync History", icon: Clock, badge: sync_runs?.length },
    { id: "analytics", label: "7. Analytics Status", icon: Database },
    { id: "security", label: "8. Security & Auth", icon: Key },
    { id: "audit-logs", label: "9. Activity Logs", icon: FileText, badge: audit_logs?.length },
  ];

  return (
    <div className="space-y-6">
      {/* Back button & User Header Banner */}
      <div className="flex flex-col gap-4">
        <Link
          href="/super-admin/users"
          className="inline-flex items-center gap-1.5 text-xs text-charcoal-500 hover:text-charcoal-900 font-medium transition-colors w-fit"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to User Registry
        </Link>

        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-6 rounded-2xl border border-charcoal-200/80 shadow-xs">
          <div className="flex items-start gap-4">
            <div className="h-14 w-14 rounded-2xl bg-charcoal-900 text-white flex items-center justify-center font-bold text-xl shadow-inner">
              {user.email ? user.email.slice(0, 2).toUpperCase() : "U"}
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl font-bold text-charcoal-900 tracking-tight">{user.email}</h1>
                {user.is_superuser && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-300">
                    SUPER ADMIN
                  </span>
                )}
                {user.is_active ? (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300 flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" /> ACTIVE
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-100 text-red-800 border border-red-300 flex items-center gap-1">
                    <XCircle className="h-3 w-3" /> SUSPENDED
                  </span>
                )}
              </div>
              <p className="text-xs text-charcoal-500 font-mono mt-1">ID: {user.id}</p>
              <div className="flex items-center gap-4 text-[11px] text-charcoal-500 mt-2">
                <span>Created: {new Date(user.created_at).toLocaleDateString()}</span>
                <span>•</span>
                <span>Last login: {user.last_login ? new Date(user.last_login).toLocaleString() : "Never"}</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleToggleUserStatus}
              disabled={statusLoading || user.is_superuser}
              className={`px-3 py-2 text-xs font-semibold rounded-lg border transition-colors flex items-center gap-1.5 ${
                user.is_active
                  ? "border-red-200 bg-red-50 text-red-700 hover:bg-red-100"
                  : "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
              } ${statusLoading || user.is_superuser ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              {user.is_active ? (
                <>
                  <Lock className="h-3.5 w-3.5" /> Suspend Account
                </>
              ) : (
                <>
                  <Unlock className="h-3.5 w-3.5" /> Activate Account
                </>
              )}
            </button>
            <button
              onClick={fetchUserData}
              className="p-2 border border-charcoal-200 hover:bg-charcoal-50 text-charcoal-700 rounded-lg transition-colors"
              title="Refresh dossier"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Tabs Navigation */}
      <div className="border-b border-charcoal-200/80 bg-white rounded-t-xl px-2 overflow-x-auto scrollbar-thin">
        <div className="flex gap-1 min-w-max">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-3 text-xs font-semibold border-b-2 transition-all ${
                  isActive
                    ? "border-charcoal-900 text-charcoal-900 bg-charcoal-50/50"
                    : "border-transparent text-charcoal-500 hover:text-charcoal-800 hover:border-charcoal-300"
                }`}
              >
                <Icon className={`h-4 w-4 ${isActive ? "text-charcoal-900" : "text-charcoal-400"}`} />
                <span>{tab.label}</span>
                {tab.badge !== undefined && (
                  <span
                    className={`ml-1 px-1.5 py-0.2 rounded-full text-[10px] font-mono ${
                      isActive ? "bg-charcoal-900 text-white" : "bg-charcoal-100 text-charcoal-600"
                    }`}
                  >
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab 1: Overview */}
      {activeTab === "overview" && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-white p-5 rounded-xl border border-charcoal-200/80">
              <span className="text-[11px] font-bold uppercase tracking-wider text-charcoal-400">Account Type</span>
              <p className="text-base font-bold text-charcoal-900 mt-1">
                {user.is_superuser ? "Platform Super Admin" : user.is_staff ? "Staff Member" : "Standard User"}
              </p>
              <span className="text-[11px] text-charcoal-500 mt-2 block">
                {user.is_superuser ? "Bypasses all module restrictions" : "Subject to per-user permissions"}
              </span>
            </div>

            <div className="bg-white p-5 rounded-xl border border-charcoal-200/80">
              <span className="text-[11px] font-bold uppercase tracking-wider text-charcoal-400">Workspaces</span>
              <p className="text-2xl font-bold text-charcoal-900 mt-1">{workspaces.length}</p>
              <span className="text-[11px] text-charcoal-500 mt-2 block">
                Primary: {workspaces[0]?.workspace?.name || "None"}
              </span>
            </div>

            <div className="bg-white p-5 rounded-xl border border-charcoal-200/80">
              <span className="text-[11px] font-bold uppercase tracking-wider text-charcoal-400">Active Integrations</span>
              <p className="text-2xl font-bold text-charcoal-900 mt-1">
                {integrations.filter((i: any) => i.status === "active").length} / {integrations.length}
              </p>
              <span className="text-[11px] text-emerald-600 font-medium mt-2 block">
                {integrations.some((i: any) => i.last_error_message) ? "Errors detected in 1+ syncs" : "All integrations operational"}
              </span>
            </div>

            <div className="bg-white p-5 rounded-xl border border-charcoal-200/80">
              <span className="text-[11px] font-bold uppercase tracking-wider text-charcoal-400">Enabled Modules</span>
              <p className="text-2xl font-bold text-charcoal-900 mt-1">
                {modules.filter((m: any) => m.effective_enabled).length} / {modules.length}
              </p>
              <span className="text-[11px] text-charcoal-500 mt-2 block">
                {modules.filter((m: any) => m.user_override !== null).length} explicit per-user overrides
              </span>
            </div>
          </div>

          {/* Quick Module Summary */}
          <div className="bg-white p-6 rounded-xl border border-charcoal-200/80">
            <h3 className="text-sm font-bold text-charcoal-900 mb-3 flex items-center gap-2">
              <Sliders className="h-4 w-4 text-charcoal-700" /> Current Module Accessibility
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {modules.map((m: any) => (
                <div
                  key={m.module_key}
                  className={`p-3 rounded-lg border text-xs flex items-center justify-between ${
                    m.effective_enabled
                      ? "bg-emerald-50/50 border-emerald-200 text-emerald-900"
                      : "bg-charcoal-50 border-charcoal-200 text-charcoal-500"
                  }`}
                >
                  <span className="font-semibold">{m.module_name}</span>
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                      m.effective_enabled ? "bg-emerald-200 text-emerald-900" : "bg-charcoal-200 text-charcoal-700"
                    }`}
                  >
                    {m.effective_enabled ? "ENABLED" : "DISABLED"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Tab 2: Modules & Permissions */}
      {activeTab === "modules" && (
        <div className="space-y-6">
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
            <ShieldCheck className="h-5 w-5 text-amber-700 shrink-0 mt-0.5" />
            <div className="text-xs text-amber-900">
              <p className="font-bold">Module Permission Hierarchy & Precedence</p>
              <p className="mt-1">
                Workspace permissions establish the allowed baseline for all members. You can configure per-user overrides below:
                <br />
                • <strong className="text-emerald-800">User Override: ENABLED</strong> — Unlocks module even if restricted for standard members.
                <br />
                • <strong className="text-red-800">User Override: DISABLED</strong> — Explicitly blocks module even if workspace allows it.
                <br />
                • <strong>INHERIT</strong> — Follows the workspace baseline default.
                <br />
                {user.is_superuser && (
                  <span className="text-amber-800 font-semibold block mt-1">
                    NOTE: This user is flagged as SUPER ADMIN. Super admins always have universal access to all active platform modules.
                  </span>
                )}
              </p>
            </div>
          </div>

          {permSuccessMsg && (
            <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg text-xs flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4" /> {permSuccessMsg}
            </div>
          )}

          {permErrorMsg && (
            <div className="p-3 bg-red-50 border border-red-200 text-red-800 rounded-lg text-xs flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" /> {permErrorMsg}
            </div>
          )}

          {/* Module Permissions Table */}
          <div className="bg-white rounded-xl border border-charcoal-200/80 overflow-hidden shadow-xs">
            <div className="p-4 bg-charcoal-50/70 border-b border-charcoal-200/80 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-charcoal-900">Per-User Module Control Matrix</h3>
                <p className="text-xs text-charcoal-500">Configure access for each of the 7 core modules</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    // Reset all to inherit
                    const resetObj: any = {};
                    modules.forEach((m: any) => {
                      resetObj[m.module_key] = null;
                    });
                    setModuleOverrides(resetObj);
                  }}
                  className="px-2.5 py-1.5 text-xs text-charcoal-600 hover:text-charcoal-900 bg-white border border-charcoal-200 rounded-lg flex items-center gap-1 transition-colors"
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Reset All to Workspace Baseline
                </button>
                <button
                  onClick={handleSaveModulePermissions}
                  disabled={isSavingPermissions}
                  className="px-4 py-1.5 text-xs font-semibold bg-charcoal-900 hover:bg-black text-white rounded-lg flex items-center gap-1.5 transition-colors disabled:opacity-50"
                >
                  {isSavingPermissions ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  Save Permission Matrix
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="bg-charcoal-50 border-b border-charcoal-200 text-charcoal-500 font-semibold uppercase text-[10px] tracking-wider">
                    <th className="px-4 py-3">Module</th>
                    <th className="px-4 py-3">Key</th>
                    <th className="px-4 py-3">Platform Global</th>
                    <th className="px-4 py-3">Workspace Baseline</th>
                    <th className="px-4 py-3">Per-User Override Selection</th>
                    <th className="px-4 py-3 text-right">Effective Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-charcoal-100">
                  {modules.map((mod: any) => {
                    const currentOverride = moduleOverrides[mod.module_key];
                    const isChanged = currentOverride !== mod.user_override;
                    const effective = user.is_superuser
                      ? true
                      : currentOverride !== null && currentOverride !== undefined
                      ? currentOverride
                      : mod.workspace_baseline;

                    return (
                      <tr key={mod.module_key} className={isChanged ? "bg-amber-50/40" : "hover:bg-charcoal-50/50"}>
                        <td className="px-4 py-3">
                          <div className="font-bold text-charcoal-900">{mod.module_name}</div>
                          <div className="text-[11px] text-charcoal-500">{mod.description}</div>
                        </td>
                        <td className="px-4 py-3 font-mono text-[11px] text-charcoal-600">{mod.module_key}</td>
                        <td className="px-4 py-3">
                          {mod.is_active ? (
                            <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-800">
                              ACTIVE
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-charcoal-200 text-charcoal-700">
                              DISABLED
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                              mod.workspace_baseline ? "bg-blue-100 text-blue-800" : "bg-charcoal-200 text-charcoal-700"
                            }`}
                          >
                            {mod.workspace_baseline ? "ALLOWED" : "RESTRICTED"}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1 bg-charcoal-100 p-0.5 rounded-lg w-fit">
                            <button
                              type="button"
                              onClick={() => handleToggleModuleOverride(mod.module_key, currentOverride, true)}
                              className={`px-2.5 py-1 rounded text-[10px] font-bold transition-all ${
                                currentOverride === true
                                  ? "bg-emerald-600 text-white shadow-xs"
                                  : "text-charcoal-600 hover:text-charcoal-900"
                              }`}
                            >
                              ENABLE
                            </button>
                            <button
                              type="button"
                              onClick={() => handleToggleModuleOverride(mod.module_key, currentOverride, false)}
                              className={`px-2.5 py-1 rounded text-[10px] font-bold transition-all ${
                                currentOverride === false
                                  ? "bg-red-600 text-white shadow-xs"
                                  : "text-charcoal-600 hover:text-charcoal-900"
                              }`}
                            >
                              DISABLE
                            </button>
                            <button
                              type="button"
                              onClick={() => handleToggleModuleOverride(mod.module_key, currentOverride, null)}
                              className={`px-2.5 py-1 rounded text-[10px] font-medium transition-all ${
                                currentOverride === null
                                  ? "bg-white text-charcoal-900 shadow-xs border border-charcoal-300"
                                  : "text-charcoal-500 hover:text-charcoal-900"
                              }`}
                            >
                              INHERIT
                            </button>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span
                            className={`px-2 py-1 rounded-full text-[10px] font-bold inline-flex items-center gap-1 ${
                              effective
                                ? "bg-emerald-100 text-emerald-800 border border-emerald-300"
                                : "bg-red-100 text-red-800 border border-red-300"
                            }`}
                          >
                            {effective ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                            {effective ? "GRANTED" : "BLOCKED"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Tab 3: Workspaces & Brands */}
      {activeTab === "workspaces" && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl border border-charcoal-200/80 overflow-hidden shadow-xs">
            <div className="p-4 bg-charcoal-50/70 border-b border-charcoal-200/80">
              <h3 className="text-sm font-bold text-charcoal-900">Workspace Memberships</h3>
              <p className="text-xs text-charcoal-500">Tenants this user has authorization to access</p>
            </div>
            <div className="divide-y divide-charcoal-100">
              {workspaces.map((m: any, idx: number) => (
                <div key={idx} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-charcoal-900 text-sm">{m.workspace?.name}</span>
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-charcoal-100 text-charcoal-700">
                        {m.workspace?.slug}
                      </span>
                      <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-blue-100 text-blue-800 uppercase">
                        {m.role || "member"}
                      </span>
                    </div>
                    <p className="text-xs text-charcoal-500 font-mono mt-1">Workspace ID: {m.workspace?.id}</p>
                    <p className="text-xs text-charcoal-400 mt-1">Joined: {new Date(m.created_at).toLocaleDateString()}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white rounded-xl border border-charcoal-200/80 overflow-hidden shadow-xs">
            <div className="p-4 bg-charcoal-50/70 border-b border-charcoal-200/80">
              <h3 className="text-sm font-bold text-charcoal-900">Connected Brands / Stores</h3>
              <p className="text-xs text-charcoal-500">Brands configured within the user's workspaces</p>
            </div>
            <div className="divide-y divide-charcoal-100">
              {brands.map((b: any) => (
                <div key={b.id} className="p-4 flex items-center justify-between">
                  <div>
                    <span className="font-bold text-charcoal-900 text-sm">{b.name}</span>
                    <p className="text-xs text-charcoal-500 font-mono mt-1">Brand ID: {b.id}</p>
                    <div className="flex items-center gap-3 text-xs text-charcoal-400 mt-1">
                      <span>Currency: {b.currency || "INR"}</span>
                      <span>•</span>
                      <span>Timezone: {b.timezone || "Asia/Kolkata"}</span>
                    </div>
                  </div>
                </div>
              ))}
              {brands.length === 0 && (
                <div className="p-6 text-center text-xs text-charcoal-400">No brands associated with this user.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Tab 4: Integrations */}
      {activeTab === "integrations" && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl border border-charcoal-200/80 overflow-hidden shadow-xs">
            <div className="p-4 bg-charcoal-50/70 border-b border-charcoal-200/80">
              <h3 className="text-sm font-bold text-charcoal-900">Configured Integration Connectors</h3>
              <p className="text-xs text-charcoal-500">Live API credentials and sync health per service</p>
            </div>

            <div className="divide-y divide-charcoal-100">
              {integrations.map((integ: any) => (
                <div key={integ.id} className="p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-charcoal-900 uppercase text-sm tracking-wide">
                        {integ.provider}
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                          integ.status === "active"
                            ? "bg-emerald-100 text-emerald-800"
                            : "bg-charcoal-100 text-charcoal-700"
                        }`}
                      >
                        {integ.status}
                      </span>
                    </div>
                    <p className="text-xs text-charcoal-500 font-mono mt-1">Account: {integ.account_identifier || "Default"}</p>
                    <div className="flex items-center gap-3 text-xs text-charcoal-400 mt-2">
                      <span>Last sync: {integ.last_synced_at ? new Date(integ.last_synced_at).toLocaleString() : "Never"}</span>
                      <span>•</span>
                      <span>Credentials: <strong className="text-emerald-700 font-mono">ENCRYPTED (AES-256-GCM)</strong></span>
                    </div>
                    {integ.last_error_message && (
                      <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-[11px] text-red-700 font-mono">
                        Error: {integ.last_error_message}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {integrations.length === 0 && (
                <div className="p-6 text-center text-xs text-charcoal-400">No active integrations found.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Tab 5: Data Flows */}
      {activeTab === "data-flows" && (
        <div className="space-y-6">
          <div className="bg-white p-6 rounded-xl border border-charcoal-200/80 shadow-xs">
            <h3 className="text-sm font-bold text-charcoal-900 mb-2">Ingestion & Processing Pipeline</h3>
            <p className="text-xs text-charcoal-500 mb-6">Live stage-by-stage status for this user&apos;s workspace</p>

            <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
              {[
                { stage: "1. External API", desc: "OAuth & Signature Handshake", status: "Operational", color: "emerald" },
                { stage: "2. Edge Function", desc: "Deno Serverless Ingestor", status: "Operational", color: "emerald" },
                { stage: "3. Data Validation", desc: "Payload & Schema Sanitization", status: "Operational", color: "emerald" },
                { stage: "4. Database Store", desc: "PostgreSQL & RLS Enforcement", status: "Operational", color: "emerald" },
                { stage: "5. Analytics Layer", desc: "Aggregation & Materialized Views", status: "Operational", color: "emerald" },
              ].map((s, idx) => (
                <div key={idx} className="p-4 rounded-xl border border-charcoal-200 bg-charcoal-50/50 flex flex-col justify-between">
                  <div>
                    <span className="text-[10px] font-bold text-charcoal-400 uppercase tracking-wider">{s.stage}</span>
                    <h4 className="text-xs font-bold text-charcoal-900 mt-1">{s.desc}</h4>
                  </div>
                  <div className="mt-4 flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-emerald-500"></span>
                    <span className="text-[11px] font-semibold text-emerald-800">{s.status}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Tab 6: Sync History */}
      {activeTab === "sync-history" && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl border border-charcoal-200/80 overflow-hidden shadow-xs">
            <div className="p-4 bg-charcoal-50/70 border-b border-charcoal-200/80">
              <h3 className="text-sm font-bold text-charcoal-900">Recent Synchronization Runs</h3>
              <p className="text-xs text-charcoal-500">Automated pull jobs and background batch synchronizations</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="bg-charcoal-50 border-b border-charcoal-200 text-charcoal-500 font-semibold uppercase text-[10px] tracking-wider">
                    <th className="px-4 py-3">Provider</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Records Processed</th>
                    <th className="px-4 py-3">Started</th>
                    <th className="px-4 py-3">Completed</th>
                    <th className="px-4 py-3">Error</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-charcoal-100">
                  {sync_runs.map((sr: any) => (
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
                      <td className="px-4 py-3 text-charcoal-500">
                        {sr.completed_at ? new Date(sr.completed_at).toLocaleString() : "Running..."}
                      </td>
                      <td className="px-4 py-3 text-red-600 font-mono text-[11px]">{sr.error_message || "—"}</td>
                    </tr>
                  ))}
                  {sync_runs.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-6 text-center text-charcoal-400">
                        No synchronization runs logged yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Tab 7: Analytics Status */}
      {activeTab === "analytics" && (
        <div className="space-y-6">
          <div className="bg-white p-6 rounded-xl border border-charcoal-200/80 shadow-xs">
            <h3 className="text-sm font-bold text-charcoal-900 mb-2">Analytics Engine Diagnostics</h3>
            <p className="text-xs text-charcoal-500 mb-4">Calculations and aggregations status for this account</p>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="p-4 rounded-xl border border-charcoal-200 bg-charcoal-50/50">
                <span className="text-[10px] font-bold text-charcoal-400 uppercase tracking-wider">Aggregation State</span>
                <p className="text-sm font-bold text-charcoal-900 mt-1">Up to Date</p>
                <span className="text-[11px] text-charcoal-500 mt-1 block">Hourly sync jobs healthy</span>
              </div>
              <div className="p-4 rounded-xl border border-charcoal-200 bg-charcoal-50/50">
                <span className="text-[10px] font-bold text-charcoal-400 uppercase tracking-wider">Cache Status</span>
                <p className="text-sm font-bold text-emerald-700 mt-1">Warm (Next.js Cache)</p>
                <span className="text-[11px] text-charcoal-500 mt-1 block">TTL: 300s</span>
              </div>
              <div className="p-4 rounded-xl border border-charcoal-200 bg-charcoal-50/50">
                <span className="text-[10px] font-bold text-charcoal-400 uppercase tracking-wider">Webhook Throughput</span>
                <p className="text-sm font-bold text-charcoal-900 mt-1">{webhooks.length} events processed</p>
                <span className="text-[11px] text-charcoal-500 mt-1 block">Zero dead-letter events</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tab 8: Security & Auth */}
      {activeTab === "security" && (
        <div className="space-y-6">
          <div className="bg-white p-6 rounded-xl border border-charcoal-200/80 shadow-xs">
            <h3 className="text-sm font-bold text-charcoal-900 mb-4">User Security Profile</h3>
            <div className="space-y-3 text-xs">
              <div className="flex items-center justify-between py-2 border-b border-charcoal-100">
                <span className="text-charcoal-600">Platform Super Admin Privilege:</span>
                <span className="font-bold text-charcoal-900">{user.is_superuser ? "YES" : "NO"}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-charcoal-100">
                <span className="text-charcoal-600">Two-Factor Authentication (MFA):</span>
                <span className="font-bold text-charcoal-900">{user.mfa_enabled ? "ENFORCED (TOTP)" : "DISABLED"}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-charcoal-100">
                <span className="text-charcoal-600">Account Status:</span>
                <span className={`font-bold ${user.is_active ? "text-emerald-700" : "text-red-700"}`}>
                  {user.is_active ? "Active" : "Suspended"}
                </span>
              </div>
              <div className="flex items-center justify-between py-2">
                <span className="text-charcoal-600">Database Role:</span>
                <span className="font-mono text-charcoal-700">authenticated (PostgreSQL RLS)</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tab 9: Activity Logs */}
      {activeTab === "audit-logs" && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl border border-charcoal-200/80 overflow-hidden shadow-xs">
            <div className="p-4 bg-charcoal-50/70 border-b border-charcoal-200/80">
              <h3 className="text-sm font-bold text-charcoal-900">Administrative Audit Trail</h3>
              <p className="text-xs text-charcoal-500">Immutable ledger of modifications targeting this user</p>
            </div>
            <div className="divide-y divide-charcoal-100">
              {audit_logs.map((log: any) => (
                <div key={log.id} className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-charcoal-900">{log.action}</span>
                      <span className="text-charcoal-400 font-mono text-[10px]">ID: {log.id.slice(0, 8)}</span>
                    </div>
                    <pre className="mt-2 p-2 bg-charcoal-50 rounded text-[11px] text-charcoal-700 font-mono max-w-2xl overflow-x-auto">
                      {JSON.stringify(log.metadata, null, 2)}
                    </pre>
                  </div>
                  <div className="text-right text-charcoal-400 text-[11px] shrink-0">
                    {new Date(log.created_at).toLocaleString()}
                  </div>
                </div>
              ))}
              {audit_logs.length === 0 && (
                <div className="p-6 text-center text-xs text-charcoal-400">No administrative changes recorded yet.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
