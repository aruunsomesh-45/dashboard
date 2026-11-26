import { errorResponse } from "../_shared/response.ts";
import { HttpError } from "../_shared/http.ts";
import { logger } from "../_shared/logger.ts";
import { MAX_BATCH_BYTES, normalizeTrackingBatch } from "../_shared/tracking.ts";
import type { Deps } from "../_shared/deps.ts";

/**
 * Public storefront ingestion endpoint (verify_jwt = false: browsers have no Supabase session).
 * Protection: site public key + Origin allow-list (checked in SQL), 64 KiB cap, strict validation,
 * consent required, idempotent event ids. The response never reveals whether a site key exists.
 * Accepts text/plain (sendBeacon / no CORS preflight) or application/json.
 */
function cors(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function reply(origin: string | null, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(origin), "Content-Type": "application/json" } });
}

export function createHandler(deps: Deps) {
  return async (req: Request): Promise<Response> => {
    const origin = req.headers.get("origin");
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (req.method !== "POST") return errorResponse("Method not allowed", 405);
    if (!origin) return reply(null, 403, { success: false, error: "Origin required" });

    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > MAX_BATCH_BYTES) return reply(origin, 413, { success: false, error: "Payload too large" });
    const raw = await req.text();
    if (raw.length > MAX_BATCH_BYTES) return reply(origin, 413, { success: false, error: "Payload too large" });

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return reply(origin, 400, { success: false, error: "Malformed JSON" });
    }

    try {
      const { publicKey, batch } = normalizeTrackingBatch(parsed);
      if (!batch.consent.analytics) return reply(origin, 202, { success: true, data: { stored: false, reason: "no analytics consent" } });
      const { data, error } = await deps.adminClient().rpc("ingest_tracking_batch", { p_public_key: publicKey, p_origin: origin, p_batch: batch });
      if (error) {
        if ((error as { code?: string }).code === "28000") return reply(origin, 403, { success: false, error: "Not allowed" });
        if ((error as { code?: string }).code === "22023") return reply(origin, 400, { success: false, error: "Invalid session" });
        logger.error("tracking ingest failed", { error: error.message });
        return reply(origin, 500, { success: false, error: "Temporary failure" });
      }
      return reply(origin, 202, { success: true, data });
    } catch (e) {
      if (e instanceof HttpError) return reply(origin, e.status, { success: false, error: e.message });
      logger.error("tracking handler crashed", { error: (e as Error).message });
      return reply(origin, 500, { success: false, error: "Temporary failure" });
    }
  };
}
