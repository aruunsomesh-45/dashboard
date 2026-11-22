"use client";

import React, { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import {
  FileText,
  Search,
  Filter,
  RefreshCw,
  ShieldCheck,
  User,
  Calendar,
} from "lucide-react";

export default function SuperAdminAuditLogsPage() {
  const [logs, setLogs] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAuditLogs = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) throw new Error("No active session");

      const res = await fetch("/api/super-admin/audit-logs", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to load audit logs");
      }
      const data = await res.json();
      setLogs(data.logs || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchAuditLogs();
  }, []);

  const filtered = logs.filter(
    (l) =>
      l.action?.toLowerCase().includes(search.toLowerCase()) ||
      l.target_user_id?.toLowerCase().includes(search.toLowerCase()) ||
      l.admin_user_id?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-charcoal-900 tracking-tight">Administrative Audit Trail</h1>
          <p className="text-xs text-charcoal-500 mt-1">
            Immutable security ledger tracking every platform administrative operation and permission modification
          </p>
        </div>
        <button
          onClick={fetchAuditLogs}
          className="p-2 border border-charcoal-200 hover:bg-charcoal-50 text-charcoal-700 rounded-lg transition-colors flex items-center gap-1.5 text-xs font-semibold"
        >
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      <div className="flex items-center gap-3 bg-white p-3 rounded-xl border border-charcoal-200/80 shadow-xs">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-charcoal-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by action, admin ID, or target UUID..."
            className="w-full pl-9 pr-3 py-1.5 text-xs bg-charcoal-50 border border-charcoal-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-charcoal-900"
          />
        </div>
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
                  <th className="px-4 py-3">Timestamp</th>
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3">Target User / Entity</th>
                  <th className="px-4 py-3">Admin Executor</th>
                  <th className="px-4 py-3">Metadata & Changes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-charcoal-100">
                {filtered.map((log) => (
                  <tr key={log.id} className="hover:bg-charcoal-50/50">
                    <td className="px-4 py-3 text-charcoal-500 text-[11px] whitespace-nowrap">
                      {new Date(log.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 font-bold text-charcoal-900">{log.action}</td>
                    <td className="px-4 py-3 font-mono text-[11px] text-charcoal-700">
                      {log.target_user_id ? log.target_user_id.slice(0, 13) + "..." : "Global"}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-charcoal-500">
                      {log.admin_user_id ? log.admin_user_id.slice(0, 8) + "..." : "System"}
                    </td>
                    <td className="px-4 py-3">
                      <pre className="p-2 bg-charcoal-50 rounded text-[11px] text-charcoal-700 font-mono max-w-md overflow-x-auto">
                        {JSON.stringify(log.metadata, null, 2)}
                      </pre>
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-charcoal-400">
                      No audit records found.
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
