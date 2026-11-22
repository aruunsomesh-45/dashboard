/** Error carrying an HTTP status, so handlers can answer 400/401/403/404 instead of a blanket 500. */
export class HttpError extends Error {
  constructor(public status: number, message: string, public details: unknown = null) {
    super(message);
    this.name = "HttpError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export function requireUuid(v: unknown, name: string): string {
  if (v === undefined || v === null || v === "") throw new HttpError(400, `Missing required ${name}`);
  if (!isUuid(v)) throw new HttpError(400, `Invalid ${name}: must be a UUID`);
  return v;
}

/** Parses an integer option and clamps it into [min, max]; falls back to `def` when absent or invalid. */
export function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Reads a JSON object body. Malformed or non-object JSON is a 400, not a 500. */
export async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    const text = await req.text();
    body = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    throw new HttpError(400, "Malformed JSON body");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}
