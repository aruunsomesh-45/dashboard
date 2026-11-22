"use client";

import React, { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, CircleDashed, FlaskConical, MinusCircle, Play, RefreshCw, XCircle } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { supabase } from "@/lib/supabaseClient";
import { invokeEdgeFunction, type ConnectionTestResult } from "@/lib/serverless";

// ─── Types mirrored from serverless/tests/results/summary.json ────────────────
interface ComponentResult { name: string; total: number; passed: number; failed: number; skipped: number; ms: number; failures: string[] }
interface SmokeCheck { component: string; check: string; verdict: string; http: number | null; ms: number; detail: string }
export interface TestSummary {
  generated_at: string;
  test_run_at: string | null;
  totals: { total: number; passed: number; failed: number; skipped: number };
  components: ComponentResult[];
  smoke: { checks: SmokeCheck[]; startedAt: string; target: string } | null;
}

type Provider = "shopify" | "razorpay" | "meta_ads" | "instagram";

interface IntegrationRow { id: string; provider: Provider; status: string; last_synced_at: string | null; last_error_message: string }

interface LiveResult { at: string; ms: number; result?: ConnectionTestResult; error?: string }

const PLATFORMS: { provider: Provider; label: string; sync: string; webhook: string | null; persistence: string | null; fn: string }[] = [
  { provider: "shopify", label: "Shopify", sync: "Shopify sync (mocked API)", webhook: "Shopify webhook", persistence: "Shopify sync (mocked API)", fn: "shopify-sync" },
  { provider: "razorpay", label: "Razorpay", sync: "Razorpay sync (mocked API)", webhook: "Razorpay webhook", persistence: "Razorpay sync (mocked API)", fn: "razorpay-sync" },
  { provider: "meta_ads", label: "Meta Ads", sync: "Meta Ads sync (mocked API)", webhook: null, persistence: "Meta Ads sync (mocked API)", fn: "meta-ads-sync" },
  // No Instagram media/insights table exists in the schema, so persistence is not implemented.
  { provider: "instagram", label: "Instagram", sync: "Instagram sync (mocked API)", webhook: null, persistence: null, fn: "instagram-sync" },
];

type Tone = "pass" | "fail" | "skip" | "na" | "unknown";

function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const styles: Record<Tone, string> = {
    pass: "bg-emerald-50 text-emerald-800 border-emerald-200",
    fail: "bg-red-50 text-red-800 border-red-200",
    skip: "bg-amber-50 text-amber-800 border-amber-200",
    na: "bg-gray-50 text-gray-500 border-gray-200",
    unknown: "bg-gray-50 text-gray-600 border-gray-200",
  };
  const Icon = { pass: CheckCircle2, fail: XCircle, skip: MinusCircle, na: MinusCircle, unknown: CircleDashed }[tone];
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-semibold ${styles[tone]}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {children}
    </span>
  );
}

function suiteBadge(c: ComponentResult | undefined, tag: string) {
  if (!c || c.total === 0) return <Badge tone="unknown">not run</Badge>;
  if (c.failed > 0) return <Badge tone="fail">{c.failed}/{c.total} failed · {tag}</Badge>;
  if (c.passed === 0) return <Badge tone="skip">skipped · {tag}</Badge>;
  return <Badge tone="pass">{c.passed}/{c.total} · {tag}</Badge>;
}

const fmtTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "—");

export default function TestDashboard({ summary }: { summary: TestSummary | null }) {
  const { user, currentWorkspace, currentBrand } = useAuth();
  const [integrations, setIntegrations] = useState<IntegrationRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [live, setLive] = useState<Record<string, LiveResult>>({});
  const [running, setRunning] = useState<Set<string>>(new Set());

  const comp = (name: string) => summary?.components.find((c) => c.name === name);
  const smokeFor = (fn: string) => summary?.smoke?.checks.find((c) => c.component === fn);

  const loadIntegrations = useCallback(async () => {
    if (!currentBrand?.id) return;
    setLoadError(null);
    // Only non-sensitive columns. encrypted_credentials is not selectable by clients (column grant).
    const { data, error } = await supabase
      .from("integrations_integration")
      .select("id, provider, status, last_synced_at, last_error_message")
      .eq("brand_id", currentBrand.id);
    if (error) setLoadError(error.message);
    else setIntegrations((data ?? []) as IntegrationRow[]);
  }, [currentBrand?.id]);

  useEffect(() => {
    void loadIntegrations();
  }, [loadIntegrations]);

  const runOne = useCallback(async (provider: Provider) => {
    const integ = integrations.find((i) => i.provider === provider);
    if (!integ) return;
    setRunning((s) => new Set(s).add(provider));
    const t0 = performance.now();
    try {
      // test-connection performs read-only upstream calls and writes nothing.
      const result = await invokeEdgeFunction<ConnectionTestResult>("test-connection", { integration_id: integ.id });
      setLive((m) => ({ ...m, [provider]: { at: new Date().toISOString(), ms: Math.round(performance.now() - t0), result } }));
    } catch (e) {
      setLive((m) => ({ ...m, [provider]: { at: new Date().toISOString(), ms: Math.round(performance.now() - t0), error: (e as Error).message } }));
    } finally {
      setRunning((s) => {
        const n = new Set(s);
        n.delete(provider);
        return n;
      });
    }
  }, [integrations]);

  const runAll = useCallback(async () => {
    for (const p of PLATFORMS) if (integrations.some((i) => i.provider === p.provider)) await runOne(p.provider);
  }, [integrations, runOne]);

  const liveBadge = (provider: Provider) => {
    const r = live[provider];
    if (!integrations.some((i) => i.provider === provider)) return <Badge tone="na">not connected</Badge>;
    if (!r) return <Badge tone="unknown">not run</Badge>;
    if (r.error) return <Badge tone="fail">error</Badge>;
    return r.result?.connection_status === "connected" ? <Badge tone="pass">connected · live</Badge> : <Badge tone="fail">failed · live</Badge>;
  };

  const e2e = comp("E2E workflows (service-level)");
  const unit = comp("Unit: crypto/logger/signatures/mappers/http");

  return (
    <div className="min-h-screen bg-ivory-100 font-sans text-forest-900">
      <header className="flex items-center justify-between border-b border-forest-800 bg-forest-900 px-6 py-4 text-ivory-100">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-5 w-5" aria-hidden />
          <h1 className="text-lg font-bold">Integration test dashboard</h1>
          <span className="ml-2 rounded bg-amber-400 px-2 py-0.5 text-xs font-bold text-forest-900">DEV ONLY</span>
        </div>
        <button
          onClick={runAll}
          disabled={!integrations.length || running.size > 0}
          className="inline-flex items-center gap-2 rounded-lg bg-ivory-100 px-4 py-2 text-sm font-semibold text-forest-900 disabled:opacity-50"
        >
          <Play className="h-4 w-4" aria-hidden /> Run all live connection tests
        </button>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 p-6">
        <section className="rounded-xl border border-gray-200 bg-white p-4 text-sm">
          <p>
            <strong>Suite results</strong> come from the last <code>deno task report</code> run
            {summary ? <> ({fmtTime(summary.test_run_at)}): <strong>{summary.totals.passed}</strong> passed, <strong>{summary.totals.failed}</strong> failed, <strong>{summary.totals.skipped}</strong> skipped of {summary.totals.total}.</> : <> — <em>no results file found</em>.</>}
          </p>
          <p className="mt-1 text-gray-600">
            &ldquo;mocked&rdquo; = synthetic API responses against an isolated database; it proves the code path, not live connectivity.
            &ldquo;live&rdquo; = a real call made from this page via the <code>test-connection</code> function. Secrets are never sent to this page.
          </p>
          <p className="mt-1 text-gray-600">
            Workspace: <strong>{currentWorkspace?.name ?? "—"}</strong> · Brand: <strong>{currentBrand?.name ?? "—"}</strong> · User: {user?.email ?? "not signed in"}
          </p>
          {loadError && <p className="mt-2 flex items-center gap-1 text-red-700"><AlertCircle className="h-4 w-4" /> Could not load integrations: {loadError}</p>}
        </section>

        <section className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                {["Platform", "Unit", "API connection", "Data fetching", "DB persistence", "Webhook", "E2E", "Deployed fn", "Last test", "Response", "Records", "Error", ""].map((h) => (
                  <th key={h} className="whitespace-nowrap px-3 py-2 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {PLATFORMS.map((p) => {
                const r = live[p.provider];
                const smoke = smokeFor(p.fn);
                return (
                  <tr key={p.provider} className="align-top">
                    <td className="whitespace-nowrap px-3 py-3 font-semibold">{p.label}</td>
                    <td className="px-3 py-3">{suiteBadge(unit, "mocked")}</td>
                    <td className="px-3 py-3">{liveBadge(p.provider)}</td>
                    <td className="px-3 py-3">{suiteBadge(comp(p.sync), "mocked")}</td>
                    <td className="px-3 py-3">{p.persistence ? suiteBadge(comp(p.persistence), "local DB") : <Badge tone="na">not implemented</Badge>}</td>
                    <td className="px-3 py-3">{p.webhook ? suiteBadge(comp(p.webhook), "local DB") : <Badge tone="na">n/a</Badge>}</td>
                    <td className="px-3 py-3">{p.provider === "shopify" || p.provider === "razorpay" ? suiteBadge(e2e, "service") : <Badge tone="na">n/a</Badge>}</td>
                    <td className="px-3 py-3">
                      {!smoke ? <Badge tone="unknown">not checked</Badge>
                        : smoke.verdict === "NOT_DEPLOYED" ? <Badge tone="fail">not deployed</Badge>
                        : smoke.verdict === "DEPLOYED_AUTH_OK" ? <Badge tone="pass">deployed</Badge>
                        : <Badge tone="fail">{smoke.verdict.toLowerCase()}</Badge>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-gray-600">{fmtTime(r?.at)}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-gray-600">{r ? `${r.result?.response_time ?? r.ms} ms` : "—"}</td>
                    <td className="px-3 py-3 text-gray-600">{r?.result ? r.result.records_fetched : "—"}</td>
                    <td className="max-w-xs px-3 py-3 text-xs text-red-700">
                      {r?.error ?? r?.result?.error_message ?? integrations.find((i) => i.provider === p.provider)?.last_error_message ?? ""}
                    </td>
                    <td className="px-3 py-3">
                      <button
                        onClick={() => runOne(p.provider)}
                        disabled={!integrations.some((i) => i.provider === p.provider) || running.has(p.provider)}
                        className="inline-flex items-center gap-1 rounded-md border border-forest-800 px-2 py-1 text-xs font-semibold disabled:opacity-40"
                      >
                        <RefreshCw className={`h-3.5 w-3.5 ${running.has(p.provider) ? "animate-spin" : ""}`} aria-hidden /> Test
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        {summary && (
          <section className="grid gap-4 md:grid-cols-2">
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <h2 className="mb-2 text-sm font-bold">Automated suites</h2>
              <ul className="space-y-1 text-sm">
                {summary.components.map((c) => (
                  <li key={c.name} className="flex items-center justify-between gap-2">
                    <span>{c.name}</span>
                    <span className="flex items-center gap-2 text-xs text-gray-500">
                      {c.ms} ms {suiteBadge(c, c.name.includes("LIVE") ? "live" : "")}
                    </span>
                  </li>
                ))}
              </ul>
              {summary.components.some((c) => c.failures.length) && (
                <pre className="mt-3 overflow-x-auto rounded bg-red-50 p-2 text-xs text-red-800">
                  {summary.components.flatMap((c) => c.failures).join("\n")}
                </pre>
              )}
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <h2 className="mb-2 text-sm font-bold">Live smoke checks {summary.smoke ? `· ${summary.smoke.target} · ${fmtTime(summary.smoke.startedAt)}` : ""}</h2>
              {!summary.smoke ? <p className="text-sm text-gray-500">Run <code>deno task smoke</code>.</p> : (
                <ul className="space-y-1 text-xs">
                  {summary.smoke.checks.map((c, i) => (
                    <li key={i} className="flex items-start justify-between gap-2">
                      <span><strong>{c.component}</strong> — {c.check}<br /><span className="text-gray-500">{c.detail}</span></span>
                      <span className="whitespace-nowrap text-gray-500">{c.ms} ms <Badge tone={["PASS", "OPERATIONAL", "DEPLOYED_AUTH_OK"].includes(c.verdict) ? "pass" : "fail"}>{c.verdict}</Badge></span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
