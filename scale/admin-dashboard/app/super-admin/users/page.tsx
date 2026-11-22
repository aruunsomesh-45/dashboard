"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";
import {
  Users,
  Search,
  Filter,
  ShieldCheck,
  CheckCircle2,
  XCircle,
  MoreVertical,
  ExternalLink,
  Settings,
  RefreshCw,
  Boxes,
  Lock,
  Unlock,
} from "lucide-react";

export default function SuperAdminUsersPage() {
  const [users, setUsers] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchUsers = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) throw new Error("No active session");

      const queryParams = new URLSearchParams();
      if (search) queryParams.set("search", search);
      if (statusFilter !== "all") queryParams.set("status", statusFilter);

      const res = await fetch(`/api/super-admin/users?${queryParams.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const errJson = await res.json();
        throw new Error(errJson.error || "Failed to load users");
      }
      const data = await res.json();
      setUsers(data.users || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, [statusFilter]);

  const handleToggleStatus = async (user: any) => {
    const newStatus = !user.is_active;
    const confirmMsg = newStatus
      ? `Activate account for ${user.email}?`
      : `Are you sure you want to suspend ${user.email}? They will immediately lose access to all modules and dashboards.`;

    if (!confirm(confirmMsg)) return;

    setActionLoading(user.id);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      const res = await fetch(`/api/super-admin/users/${user.id}/status`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ isActive: newStatus }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to update status");
      }
      await fetchUsers();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-charcoal-900 tracking-tight">Platform User Management</h1>
          <p className="text-xs text-charcoal-500 mt-1">
            Audit customer accounts, manage workspace memberships, and configure per-user module authorizations.
          </p>
        </div>
        <button
          onClick={fetchUsers}
          className="flex items-center space-x-1.5 px-3 py-2 bg-white border border-ivory-300 rounded-xl text-xs font-semibold text-charcoal-700 hover:bg-ivory-50 shadow-2xs transition-colors self-start md:self-auto"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Refresh Users</span>
        </button>
      </div>

      {/* Search and Filters Bar */}
      <div className="p-4 bg-white rounded-2xl border border-ivory-300 shadow-2xs flex flex-col md:flex-row items-center justify-between gap-4">
        <div className="relative w-full md:w-96">
          <Search className="w-4 h-4 text-charcoal-400 absolute left-3.5 top-3" />
          <input
            type="text"
            placeholder="Search users by email or ID…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && fetchUsers()}
            className="w-full pl-10 pr-4 py-2 bg-ivory-50 border border-ivory-300 rounded-xl text-xs text-charcoal-900 placeholder-charcoal-400 focus:outline-none focus:ring-2 focus:ring-forest-900/20"
          />
        </div>

        <div className="flex items-center space-x-2 w-full md:w-auto">
          <Filter className="w-3.5 h-3.5 text-charcoal-400" />
          <span className="text-xs font-medium text-charcoal-500">Status:</span>
          {["all", "active", "suspended", "superadmin"].map((st) => (
            <button
              key={st}
              onClick={() => setStatusFilter(st)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold capitalize transition-colors ${
                statusFilter === st
                  ? "bg-forest-900 text-ivory-100 shadow-2xs"
                  : "bg-ivory-100 text-charcoal-600 hover:bg-ivory-200"
              }`}
            >
              {st}
            </button>
          ))}
        </div>
      </div>

      {/* Users Table */}
      <div className="bg-white rounded-2xl border border-ivory-300 shadow-2xs overflow-hidden">
        {isLoading ? (
          <div className="p-12 text-center text-xs text-charcoal-500 flex flex-col items-center space-y-2">
            <div className="w-6 h-6 border-2 border-forest-900 border-t-transparent rounded-full animate-spin" />
            <span>Loading user registry…</span>
          </div>
        ) : error ? (
          <div className="p-8 text-center text-rose-700 text-xs">Error: {error}</div>
        ) : users.length === 0 ? (
          <div className="p-12 text-center text-xs text-charcoal-500">No users found matching your criteria.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-ivory-200 bg-ivory-50 text-[11px] font-bold uppercase tracking-wider text-charcoal-500">
                  <th className="py-3 px-4">User</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Workspaces & Roles</th>
                  <th className="py-3 px-4">Module Controls</th>
                  <th className="py-3 px-4">Registered</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ivory-200 text-xs text-charcoal-700">
                {users.map((u) => (
                  <tr key={u.id} className="hover:bg-ivory-50/60 transition-colors">
                    {/* User Identity */}
                    <td className="py-3.5 px-4">
                      <div className="font-bold text-charcoal-900 flex items-center space-x-2">
                        <span>{u.email}</span>
                        {u.is_superuser && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-extrabold uppercase bg-amber-100 text-amber-800 border border-amber-300">
                            Super Admin
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] font-mono text-charcoal-400 mt-0.5">{u.id}</div>
                    </td>

                    {/* Status Badge */}
                    <td className="py-3.5 px-4">
                      <span
                        className={`inline-flex items-center space-x-1 px-2.5 py-1 rounded-full text-[11px] font-semibold ${
                          u.is_active
                            ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
                            : "bg-rose-50 text-rose-800 border border-rose-200"
                        }`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${u.is_active ? "bg-emerald-500" : "bg-rose-500"}`} />
                        <span>{u.is_active ? "Active" : "Suspended"}</span>
                      </span>
                    </td>

                    {/* Workspaces */}
                    <td className="py-3.5 px-4">
                      <div className="space-y-1">
                        {u.workspaces?.length === 0 ? (
                          <span className="text-charcoal-400 italic">No workspace assigned</span>
                        ) : (
                          u.workspaces?.map((ws: any, idx: number) => (
                            <div key={idx} className="flex items-center space-x-1.5">
                              <span className="font-semibold text-charcoal-800">{ws.name}</span>
                              <span className="px-1 py-0.5 rounded text-[9px] uppercase font-bold bg-ivory-200 text-charcoal-600">
                                {ws.role}
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                    </td>

                    {/* Module Controls Indicator */}
                    <td className="py-3.5 px-4">
                      <div className="flex items-center space-x-1.5">
                        <Boxes className="w-3.5 h-3.5 text-forest-600" />
                        <span className="font-medium text-charcoal-800">
                          {u.is_superuser ? (
                            <span className="text-emerald-700 font-semibold">All 7 Enabled (Admin)</span>
                          ) : u.disabled_modules?.length > 0 ? (
                            <span className="text-amber-700 font-semibold">{u.disabled_modules.length} Disabled</span>
                          ) : (
                            <span className="text-forest-700">All Modules Standard</span>
                          )}
                        </span>
                      </div>
                      {u.disabled_modules?.length > 0 && (
                        <div className="text-[10px] text-charcoal-400 truncate max-w-xs mt-0.5">
                          Blocked: {u.disabled_modules.join(", ")}
                        </div>
                      )}
                    </td>

                    {/* Registered Date */}
                    <td className="py-3.5 px-4 text-charcoal-500 text-[11px]">
                      {new Date(u.created_at).toLocaleDateString()}
                    </td>

                    {/* Actions */}
                    <td className="py-3.5 px-4 text-right">
                      <div className="flex items-center justify-end space-x-2">
                        <Link
                          href={`/super-admin/users/${u.id}`}
                          className="px-2.5 py-1.5 rounded-lg bg-forest-900 text-ivory-100 hover:bg-forest-800 text-xs font-semibold transition-colors flex items-center space-x-1"
                        >
                          <Settings className="w-3 h-3" />
                          <span>Configure</span>
                        </Link>
                        {!u.is_superuser && (
                          <button
                            disabled={actionLoading === u.id}
                            onClick={() => handleToggleStatus(u)}
                            className={`p-1.5 rounded-lg border transition-colors ${
                              u.is_active
                                ? "border-rose-200 text-rose-700 hover:bg-rose-50"
                                : "border-emerald-200 text-emerald-700 hover:bg-emerald-50"
                            }`}
                            title={u.is_active ? "Suspend User" : "Activate User"}
                          >
                            {u.is_active ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
