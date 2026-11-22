/**
 * Turns tests/results/junit.xml + tests/results/smoke.json into tests/results/summary.json,
 * the single source of truth for TEST_REPORT.md and the /dev/tests dashboard page.
 * Only real recorded outcomes are emitted; nothing is inferred.
 */
const dir = new URL("./", import.meta.url);
const xml = await Deno.readTextFile(new URL("junit.xml", dir));
const cases: { suite: string; name: string; status: "passed" | "failed" | "skipped"; ms: number; file: string; full: string }[] = [];
const re = /<testcase name="([^"]*)" classname="([^"]*)" time="([^"]*)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g;
for (const m of xml.matchAll(re)) {
  const inner = m[5] ?? "";
  const status = /<failure/.test(inner) ? "failed" : /<skipped/.test(inner) ? "skipped" : "passed";
  const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const full = decode(m[1]);
  const parts = full.split(" > ");
  cases.push({ suite: parts[0], name: parts[parts.length - 1], full, status, ms: Math.round(Number(m[3]) * 1000), file: decode(m[2]) });
}
// steps are emitted as testcases whose classname contains " > "; keep leaf cases only
const leaves = cases.filter((c) => !cases.some((o) => o.file === c.file && o.full.startsWith(`${c.full} > `)));

const COMPONENTS: Record<string, (c: typeof leaves[number]) => boolean> = {
  "Unit: crypto/logger/signatures/mappers/http": (c) => c.file.replaceAll(String.fromCharCode(92), "/").includes("tests/unit"),
  "Database schema + constraints": (c) => /schema_rls/.test(c.file) && !/RLS|injection/.test(c.name),
  "Workspace isolation (RLS)": (c) => /schema_rls/.test(c.file) && /RLS/.test(c.name),
  "Shopify sync (mocked API)": (c) => /functions_sync/.test(c.file) && /Shopify sync/.test(c.suite),
  "Razorpay sync (mocked API)": (c) => /functions_sync/.test(c.file) && /Razorpay sync/.test(c.suite),
  "Meta Ads sync (mocked API)": (c) => /functions_sync/.test(c.file) && /Meta Ads/.test(c.suite),
  "Instagram sync (mocked API)": (c) => /functions_sync/.test(c.file) && /Instagram/.test(c.suite),
  "test-connection (mocked API)": (c) => /functions_sync/.test(c.file) && /test-connection/.test(c.suite),
  "Shopify webhook": (c) => /webhooks/.test(c.file) && /Shopify webhook/.test(c.suite),
  "Razorpay webhook": (c) => /webhooks/.test(c.file) && /Razorpay webhook/.test(c.suite),
  "Security": (c) => /security/.test(c.file) || (/schema_rls/.test(c.file) && /injection/.test(c.name)),
  "E2E workflows (service-level)": (c) => /e2e_workflows/.test(c.file),
  "LIVE third-party APIs": (c) => /tests[\/]live/.test(c.file),
};
const components = Object.entries(COMPONENTS).map(([name, pick]) => {
  const cs = leaves.filter(pick);
  const failed = cs.filter((c) => c.status === "failed");
  return {
    name,
    total: cs.length,
    passed: cs.filter((c) => c.status === "passed").length,
    failed: failed.length,
    skipped: cs.filter((c) => c.status === "skipped").length,
    ms: cs.reduce((a, c) => a + c.ms, 0),
    failures: failed.map((c) => c.full),
  };
});

let smoke = null;
try { smoke = JSON.parse(await Deno.readTextFile(new URL("smoke.json", dir))); } catch { /* not run */ }
const xmlStat = await Deno.stat(new URL("junit.xml", dir));
const summary = {
  generated_at: new Date().toISOString(),
  test_run_at: xmlStat.mtime?.toISOString() ?? null,
  totals: {
    total: leaves.length,
    passed: leaves.filter((c) => c.status === "passed").length,
    failed: leaves.filter((c) => c.status === "failed").length,
    skipped: leaves.filter((c) => c.status === "skipped").length,
  },
  components,
  smoke,
};
await Deno.writeTextFile(new URL("summary.json", dir), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary.totals));
for (const c of components) console.log(`${c.name.padEnd(44)} total=${String(c.total).padEnd(3)} pass=${String(c.passed).padEnd(3)} fail=${c.failed} skip=${c.skipped} ${c.ms}ms`);
