// Rate-limit handling, retries, timeouts, input validation.  [MOCKED: scripted fetch, no network]
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { fetchWithRetry, parseRetryAfterMs, safeJson, UpstreamError } from "../../supabase/functions/_shared/upstream.ts";
import { clampInt, HttpError, isUuid, readJsonObject, requireUuid } from "../../supabase/functions/_shared/http.ts";

function scripted(responses: Array<Response | Error | "hang">) {
  const calls: string[] = [];
  let i = 0;
  const fn = (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url));
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r === "hang") {
      return new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
    }
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve(r.clone());
  };
  return { fn, calls };
}
const noSleep = (rec: number[]) => (ms: number) => { rec.push(ms); return Promise.resolve(); };

Deno.test("fetchWithRetry: 429 with Retry-After is retried after the advertised delay", async () => {
  const slept: number[] = [];
  const s = scripted([new Response("", { status: 429, headers: { "Retry-After": "2" } }), new Response("{}", { status: 200 })]);
  const res = await fetchWithRetry(s.fn, "https://api.example/x", {}, { sleep: noSleep(slept) });
  assertEquals(res.status, 200);
  assertEquals(s.calls.length, 2);
  assertEquals(slept, [2000]);
});

Deno.test("fetchWithRetry: 5xx retried with exponential back-off, then gives up and returns last response", async () => {
  const slept: number[] = [];
  const s = scripted([new Response("", { status: 503 })]);
  const res = await fetchWithRetry(s.fn, "https://api.example/x", {}, { retries: 2, baseDelayMs: 100, sleep: noSleep(slept) });
  assertEquals(res.status, 503);
  assertEquals(s.calls.length, 3);
  assertEquals(slept, [100, 200]);
});

Deno.test("fetchWithRetry: 4xx (other than 429) is NOT retried", async () => {
  const s = scripted([new Response("", { status: 401 })]);
  const res = await fetchWithRetry(s.fn, "https://api.example/x", {}, { sleep: noSleep([]) });
  assertEquals(res.status, 401);
  assertEquals(s.calls.length, 1);
});

Deno.test("fetchWithRetry: timeout -> UpstreamError(kind=timeout) after retries", async () => {
  const s = scripted(["hang"]);
  const e = await assertRejects(() => fetchWithRetry(s.fn, "https://api.example/x", {}, { retries: 1, timeoutMs: 20, sleep: noSleep([]) }), UpstreamError);
  assertEquals(e.kind, "timeout");
  assertEquals(s.calls.length, 2);
});

Deno.test("fetchWithRetry: network error -> retried, then UpstreamError(kind=network)", async () => {
  const s = scripted([new TypeError("dns error")]);
  const e = await assertRejects(() => fetchWithRetry(s.fn, "https://api.example/x", {}, { retries: 1, sleep: noSleep([]) }), UpstreamError);
  assertEquals(e.kind, "network");
  assertEquals(s.calls.length, 2);
});

Deno.test("fetchWithRetry: recovers when a transient network error is followed by success", async () => {
  const s = scripted([new TypeError("reset"), new Response('{"ok":true}', { status: 200 })]);
  const res = await fetchWithRetry(s.fn, "https://api.example/x", {}, { sleep: noSleep([]) });
  assertEquals(await res.json(), { ok: true });
});

Deno.test("parseRetryAfterMs: seconds, http-date, garbage", () => {
  assertEquals(parseRetryAfterMs("3"), 3000);
  assertEquals(parseRetryAfterMs(null), null);
  assertEquals(parseRetryAfterMs("soon"), null);
  const d = parseRetryAfterMs(new Date(Date.now() + 5000).toUTCString())!;
  assert(d > 3000 && d <= 5000);
});

Deno.test("safeJson: empty body -> {}, malformed -> null, valid -> object", async () => {
  assertEquals(await safeJson(new Response("")), {});
  assertEquals(await safeJson(new Response("<html>502</html>")), null);
  assertEquals(await safeJson(new Response('{"a":1}')), { a: 1 });
});

Deno.test("UUID validation and clamping", () => {
  assert(isUuid("e281b706-c22c-4348-b3fc-ad5fdbd441a5"));
  for (const bad of ["", "abc", "e281b706c22c4348b3fcad5fdbd441a5", "' OR 1=1 --", null, 5]) assertEquals(isUuid(bad), false);
  assertEquals(requireUuid("e281b706-c22c-4348-b3fc-ad5fdbd441a5", "x"), "e281b706-c22c-4348-b3fc-ad5fdbd441a5");
  try {
    requireUuid("1; drop table x", "workspace_id");
  } catch (e) {
    assertEquals((e as HttpError).status, 400);
  }
  assertEquals(clampInt(undefined, 90, 1, 365), 90);
  assertEquals(clampInt("9999", 90, 1, 365), 365);
  assertEquals(clampInt(-5, 90, 1, 365), 1);
  assertEquals(clampInt("abc", 90, 1, 365), 90);
  assertEquals(clampInt(2.9, 90, 1, 365), 2);
});

Deno.test("readJsonObject: malformed JSON / arrays / scalars are 400", async () => {
  const mk = (b: string) => new Request("http://x", { method: "POST", body: b });
  assertEquals(await readJsonObject(mk("")), {});
  assertEquals(await readJsonObject(mk('{"a":1}')), { a: 1 });
  for (const bad of ["{bad", "[1,2]", "42", "null", '"str"']) {
    const e = await assertRejects(() => readJsonObject(mk(bad)), HttpError);
    assertEquals(e.status, 400);
  }
});
