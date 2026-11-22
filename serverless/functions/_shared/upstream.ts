/**
 * Resilient fetch for third-party APIs: per-attempt timeout, retries on 429 / 5xx / network errors,
 * honouring Retry-After. Never logs URLs or headers (they can carry tokens).
 */
export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type SleepFn = (ms: number) => Promise<void>;

export const defaultSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

export class UpstreamError extends Error {
  constructor(
    public kind: "timeout" | "network" | "http",
    message: string,
    public status = 0,
    public body: unknown = null,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

export interface RetryOptions {
  retries?: number; // extra attempts after the first
  timeoutMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: SleepFn;
}

export function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

export async function fetchWithRetry(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit = {},
  opts: RetryOptions = {},
): Promise<Response> {
  const retries = opts.retries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const base = opts.baseDelayMs ?? 500;
  const maxDelay = opts.maxDelayMs ?? 10_000;
  const sleep = opts.sleep ?? defaultSleep;

  let lastErr: UpstreamError | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchFn(url, { ...init, signal: ctrl.signal });
    } catch (e) {
      clearTimeout(timer);
      const aborted = (e as Error)?.name === "AbortError" || ctrl.signal.aborted;
      lastErr = aborted
        ? new UpstreamError("timeout", `Upstream request timed out after ${timeoutMs}ms`)
        : new UpstreamError("network", `Upstream network error: ${(e as Error)?.message ?? e}`);
      if (attempt < retries) {
        await sleep(Math.min(maxDelay, base * 2 ** attempt));
        continue;
      }
      throw lastErr;
    }
    clearTimeout(timer);

    if (res.status === 429 || res.status >= 500) {
      if (attempt < retries) {
        const ra = parseRetryAfterMs(res.headers.get("Retry-After"));
        await res.body?.cancel();
        await sleep(Math.min(maxDelay, ra ?? base * 2 ** attempt));
        continue;
      }
    }
    return res;
  }
  throw lastErr ?? new UpstreamError("network", "Upstream request failed");
}

/** Reads a JSON body; an empty body yields {} and a non-JSON body yields null. */
export async function safeJson(res: Response): Promise<any> {
  const text = await res.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
