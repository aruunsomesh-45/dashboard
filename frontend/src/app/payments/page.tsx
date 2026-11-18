"use client";

import React, { useCallback, useEffect, useState } from "react";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { useAuth } from "@/context/AuthContext";
import { apiFetch } from "@/lib/api";
import { RazorpayLogo } from "@/components/icons/AppLogos";
import { CheckCircle2, XCircle, Clock, Search, AlertCircle, RefreshCw } from "lucide-react";

interface PaymentStats {
  connected: boolean;
  payment_count: number;
  attempt_count: number;
  authorized_rate: number | null;
  total_captured_minor: number;
  total_fees_minor: number | null;
  method_splits: Record<string, number>;
}

interface Transaction {
  id: string;
  order_id: string;
  amount_minor: number;
  currency: string;
  status: "captured" | "failed" | "refunded" | "authorized";
  method: string;
  error_code: string | null;
  created_at: string;
}

function paise(minor: number): string {
  return "₹" + (minor / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

const METHOD_LABEL: Record<string, string> = {
  upi: "UPI",
  card: "Cards",
  netbanking: "Net Banking",
  wallet: "Wallets",
  other: "Other",
};

function StatusBadge({ status }: { status: Transaction["status"] }) {
  const map = {
    captured: { cls: "bg-emerald-50 text-emerald-700 border-emerald-200", Icon: CheckCircle2, label: "Captured" },
    failed: { cls: "bg-red-50 text-red-700 border-red-200", Icon: XCircle, label: "Failed" },
    refunded: { cls: "bg-amber-50 text-amber-700 border-amber-200", Icon: Clock, label: "Refunded" },
    authorized: { cls: "bg-blue-50 text-blue-700 border-blue-200", Icon: Clock, label: "Authorized" },
  } as const;
  const { cls, Icon, label } = map[status] ?? map.authorized;
  return (
    <span className={`inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-semibold uppercase border ${cls}`}>
      <Icon className="w-3 h-3" />
      <span>{label}</span>
    </span>
  );
}

export default function PaymentsPage() {
  const { currentBrand, currentWorkspace } = useAuth();
  const [stats, setStats] = useState<PaymentStats | null>(null);
  const [payments, setPayments] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [methodFilter, setMethodFilter] = useState("all");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (!currentWorkspace || !currentBrand) {
        setLoading(false);
        return;
      }
      const base = `/api/w/${currentWorkspace.slug}/b/${currentBrand.id}/payments`;
      const [s, t] = await Promise.all([
        apiFetch<PaymentStats>(`${base}/stats`),
        apiFetch<Transaction[]>(`${base}/transactions?limit=100`),
      ]);
      setStats(s);
      setPayments(t);
    } catch (err: any) {
      setStats(null);
      setPayments([]);
      setError(`Could not load payments: ${err?.message || "Unknown error"}`);
    } finally {
      setLoading(false);
    }
  }, [currentWorkspace, currentBrand]);

  useEffect(() => {
    load();
  }, [load]);
  const filtered = payments.filter((p) => {
    const q = search.toLowerCase();
    const matchSearch = !q || p.id.toLowerCase().includes(q) || p.order_id.toLowerCase().includes(q);
    return matchSearch && (statusFilter === "all" || p.status === statusFilter) && (methodFilter === "all" || p.method === methodFilter);
  });

  const methodRows = Object.entries(stats?.method_splits ?? {}).sort((a, b) => b[1] - a[1]);

  return (
    <DashboardShell>
      <div className="space-y-6">
        <div className="flex items-center justify-between pb-1">
          <div>
            <h2 className="text-xl font-bold text-charcoal-900 tracking-tight flex items-center space-x-2.5">
              <span className="w-8 h-8 rounded-lg bg-blue-50 border border-blue-100 flex items-center justify-center p-1 flex-shrink-0">
                <RazorpayLogo className="w-full h-full object-contain" />
              </span>
              <span>Payments &amp; Razorpay Gateway</span>
            </h2>
            <p className="text-xs text-charcoal-500 mt-0.5">
              Authorization rates and payment attempts for <strong>{currentBrand?.name || "your brand"}</strong>, from Razorpay webhooks.
            </p>
          </div>
          <div className="flex items-center space-x-2">
            {stats && (
              <span
                className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium border ${
                  stats.connected ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-gray-100 text-gray-600 border-gray-200"
                }`}
              >
                {stats.connected ? "Razorpay connected" : "Razorpay not connected"}
              </span>
            )}
          </div>
        </div>

        {error && (
          <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 flex items-center space-x-2">
            <AlertCircle className="w-4 h-4" />
            <span>{error}</span>
          </div>
        )}

        {stats && !stats.connected && stats.attempt_count === 0 && (
          <div className="p-4 rounded-lg bg-ivory-50 border border-ivory-300 text-xs text-charcoal-600">
            No Razorpay data yet. Connect Razorpay under <a className="underline" href="/integrations">Connect Apps</a> and add the
            webhook; payments appear here as Razorpay delivers signed events.
          </div>
        )}

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="p-5 rounded-xl bg-white border border-ivory-300 shadow-sm space-y-2">
            <div className="text-xs text-charcoal-500 font-medium">Gateway Success Rate</div>
            <div className="text-2xl font-bold text-charcoal-900 tracking-tight">
              {stats?.authorized_rate != null ? `${stats.authorized_rate}%` : "—"}
            </div>
            <div className="text-xs text-charcoal-400">captured / all attempts</div>
          </div>
          <div className="p-5 rounded-xl bg-white border border-ivory-300 shadow-sm space-y-2">
            <div className="text-xs text-charcoal-500 font-medium">Captured Revenue</div>
            <div className="text-2xl font-bold text-charcoal-900 tracking-tight">{stats ? paise(stats.total_captured_minor) : "—"}</div>
            <div className="text-xs text-charcoal-400">{stats ? `${stats.payment_count} captured payments` : ""}</div>
          </div>
          <div className="p-5 rounded-xl bg-white border border-ivory-300 shadow-sm space-y-2">
            <div className="text-xs text-charcoal-500 font-medium">Payment Attempts</div>
            <div className="text-2xl font-bold text-charcoal-900 tracking-tight">{stats ? stats.attempt_count : "—"}</div>
            <div className="text-xs text-charcoal-400">all statuses</div>
          </div>
          <div className="p-5 rounded-xl bg-white border border-ivory-300 shadow-sm space-y-2">
            <div className="text-xs text-charcoal-500 font-medium">Gateway Fees</div>
            <div className="text-2xl font-bold text-charcoal-900 tracking-tight">
              {stats?.total_fees_minor != null ? paise(stats.total_fees_minor) : "—"}
            </div>
            <div className="text-xs text-charcoal-400">{stats?.total_fees_minor == null ? "not available from webhooks yet" : ""}</div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-ivory-300 shadow-sm p-6 space-y-4">
          <h3 className="text-sm font-bold text-charcoal-900">Payment Method Volume</h3>
          {methodRows.length === 0 ? (
            <p className="text-xs text-charcoal-500">No captured payments yet.</p>
          ) : (
            <div className="space-y-3">
              {methodRows.map(([m, pct]) => (
                <div key={m} className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="font-medium text-charcoal-700">{METHOD_LABEL[m] ?? m}</span>
                    <span className="text-charcoal-500">{pct}% of captured payments</span>
                  </div>
                  <div className="h-1.5 rounded bg-ivory-200">
                    <div className="h-1.5 rounded bg-blue-500" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white rounded-xl border border-ivory-300 shadow-sm overflow-hidden">
          <div className="p-4 border-b border-ivory-200 flex flex-col md:flex-row md:items-center justify-between gap-3">
            <h3 className="text-sm font-bold text-charcoal-900">Payment Attempts &amp; Webhook Log</h3>
            <div className="flex items-center space-x-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-charcoal-400" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search pay_id or order…"
                  className="pl-8 pr-3 py-2 text-xs border border-ivory-300 rounded-lg"
                />
              </div>
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="text-xs border border-ivory-300 rounded-lg px-2 py-2">
                <option value="all">All statuses</option>
                <option value="captured">Captured</option>
                <option value="failed">Failed</option>
                <option value="refunded">Refunded</option>
                <option value="authorized">Authorized</option>
              </select>
              <select value={methodFilter} onChange={(e) => setMethodFilter(e.target.value)} className="text-xs border border-ivory-300 rounded-lg px-2 py-2">
                <option value="all">All methods</option>
                <option value="upi">UPI</option>
                <option value="card">Card</option>
                <option value="netbanking">Net Banking</option>
                <option value="wallet">Wallet</option>
              </select>
            </div>
          </div>
          <table className="w-full text-left text-xs">
            <thead className="bg-ivory-50 text-charcoal-500">
              <tr>
                <th className="px-4 py-2 font-medium">Payment</th>
                <th className="px-4 py-2 font-medium">Gateway order</th>
                <th className="px-4 py-2 font-medium">Amount</th>
                <th className="px-4 py-2 font-medium">Method</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Received</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ivory-200">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-charcoal-500">
                    <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-emerald-600" />
                    <span>Loading payment attempts &amp; gateway stats...</span>
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-charcoal-500">
                    No payments {payments.length ? "match these filters" : "recorded yet"}.
                  </td>
                </tr>
              ) : (
                filtered.map((p) => (
                  <tr key={p.id}>
                    <td className="px-4 py-2 font-mono">{p.id}</td>
                    <td className="px-4 py-2 font-mono text-charcoal-500">{p.order_id || "—"}</td>
                    <td className="px-4 py-2">{paise(p.amount_minor)}</td>
                    <td className="px-4 py-2 uppercase">{p.method}</td>
                    <td className="px-4 py-2">
                      <StatusBadge status={p.status} />
                      {p.error_code && <span className="ml-2 text-red-600">{p.error_code}</span>}
                    </td>
                    <td className="px-4 py-2 text-charcoal-500">{new Date(p.created_at).toLocaleString("en-IN")}</td>
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
