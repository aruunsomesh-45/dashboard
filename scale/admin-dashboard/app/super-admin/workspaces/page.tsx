"use client";

import React, { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import {
  Building2,
  Search,
  Filter,
  CheckCircle2,
  XCircle,
  ExternalLink,
  Users,
  Store,
  RefreshCw,
  Layers,
} from "lucide-react";

export default function SuperAdminWorkspacesPage() {
  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchWorkspaces = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) throw new Error("No active session");

      const res = await fetch("/api/super-admin/workspaces", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to load workspaces");
      }
      const data = await res.json();
      setWorkspaces(data.workspaces || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchWorkspaces();
  }, []);

  const filtered = workspaces.filter(
    (w) =>
      w.name?.toLowerCase().includes(search.toLowerCase()) ||
      w.slug?.toLowerCase().includes(search.toLowerCase()) ||
      w.id?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-charcoal-900 tracking-tight">Workspaces & Multi-Tenancy</h1>
          <p className="text-xs text-charcoal-500 mt-1">
            Manage organization boundaries, enterprise tenants, and connected brand stores
          </p>
        </div>
        <button
          onClick={fetchWorkspaces}
          className="p-2 border border-charcoal-200 hover:bg-charcoal-50 text-charcoal-700 rounded-lg transition-colors flex items-center gap-1.5 text-xs font-semibold"
        >
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-3 bg-white p-3 rounded-xl border border-charcoal-200/80 shadow-xs">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-charcoal-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by workspace name, slug or UUID..."
            className="w-full pl-9 pr-3 py-1.5 text-xs bg-charcoal-50 border border-charcoal-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-charcoal-900"
          />
        </div>
      </div>

      {/* Workspace Cards */}
      {isLoading ? (
        <div className="flex items-center justify-center p-12">
          <RefreshCw className="h-6 w-6 text-charcoal-400 animate-spin" />
        </div>
      ) : error ? (
        <div className="p-4 bg-red-50 border border-red-200 text-red-700 rounded-xl text-xs">{error}</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filtered.map((w) => (
            <div key={w.id} className="bg-white p-5 rounded-xl border border-charcoal-200/80 shadow-xs space-y-4">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-bold text-charcoal-900 text-base">{w.name}</h3>
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-charcoal-100 text-charcoal-700">
                      {w.slug}
                    </span>
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-blue-100 text-blue-800 uppercase">
                      {w.plan || "standard"}
                    </span>
                  </div>
                  <p className="text-xs text-charcoal-400 font-mono mt-1">Tenant ID: {w.id}</p>
                </div>
                {w.is_active ? (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300 flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" /> ACTIVE
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-100 text-red-800 border border-red-300 flex items-center gap-1">
                    <XCircle className="h-3 w-3" /> SUSPENDED
                  </span>
                )}
              </div>

              {/* Members & Brands breakdown */}
              <div className="grid grid-cols-2 gap-2 text-xs pt-2 border-t border-charcoal-100">
                <div className="flex items-center gap-1.5 text-charcoal-600">
                  <Users className="h-3.5 w-3.5 text-charcoal-400" />
                  <span>{w.member_count ?? 1} Members</span>
                </div>
                <div className="flex items-center gap-1.5 text-charcoal-600">
                  <Store className="h-3.5 w-3.5 text-charcoal-400" />
                  <span>{w.brands?.length ?? 0} Brands</span>
                </div>
              </div>

              {/* Brands list */}
              {w.brands && w.brands.length > 0 && (
                <div className="bg-charcoal-50 p-3 rounded-lg text-xs space-y-1.5">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-charcoal-400 block">
                    Associated Stores
                  </span>
                  {w.brands.map((b: any) => (
                    <div key={b.id} className="flex items-center justify-between text-charcoal-800 font-medium">
                      <span>• {b.name}</span>
                      <span className="text-charcoal-500 font-mono text-[10px]">{b.currency || "INR"}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
