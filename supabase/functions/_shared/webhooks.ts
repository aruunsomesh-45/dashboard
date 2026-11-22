import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.48.1";
import { decryptCredentials } from "./crypto.ts";
import { errorResponse, successResponse } from "./response.ts";
import { isUuid } from "./http.ts";
import { logger } from "./logger.ts";
import { sha256Hex } from "./signatures.ts";
import type { Deps } from "./deps.ts";

export const MAX_WEBHOOK_BODY = 1024 * 1024; // 1 MiB

export interface WebhookSpec {
  provider: "shopify" | "razorpay";
  /** Pull the signing secret out of the decrypted credential blob. */
  secretFrom: (creds: Record<string, unknown>) => string;
  /** Header carrying the signature. */
  signatureHeader: string;
  verify: (secret: string, body: Uint8Array, header: string | null) => Promise<boolean>;
  /** Stable per-delivery id (provider header, else hash of the raw body). */
  deliveryId: (req: Request, payload: any, bodyHash: string) => string;
  topic: (req: Request, payload: any) => string;
  /** Persist business data. Must be idempotent (upserts) because providers retry. */
  process: (admin: SupabaseClient, ctx: { workspace_id: string; brand_id: string }, topic: string, payload: any) => Promise<void>;
  /** Non-sensitive headers to keep with the event log (never the signature). */
  storedHeaders: (req: Request) => Record<string, string | null>;
}

/**
 * Shared webhook pipeline:
 *  1. size limit  2. brand_id validation  3. signature presence  4. integration + secret lookup
 *  5. signature over the RAW bytes  6. JSON parse  7. duplicate check  8. idempotent processing
 *  9. event log insert.
 *
 * Processing happens BEFORE the event is logged. If processing fails we answer 500 and log
 * nothing, so the provider's automatic retry re-processes it. (Previously the event was logged
 * as processed first; a failed write then made every retry look like a duplicate and the
 * order/payment was silently lost.)
 */
export async function handleWebhook(req: Request, deps: Deps, spec: WebhookSpec): Promise<Response> {
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_WEBHOOK_BODY) return errorResponse("Payload too large", 413);
  const rawBuf = await req.arrayBuffer();
  if (rawBuf.byteLength > MAX_WEBHOOK_BODY) return errorResponse("Payload too large", 413);
  const raw = new Uint8Array(rawBuf);

  const brandId = new URL(req.url).searchParams.get("brand_id");
  if (!isUuid(brandId)) return errorResponse("Missing or invalid brand_id query parameter", 400);

  const signature = req.headers.get(spec.signatureHeader);
  if (!signature) {
    logger.warn(`Rejected ${spec.provider} webhook: missing signature`, { brand_id: brandId });
    return errorResponse("Missing webhook signature", 401);
  }

  let admin: SupabaseClient;
  try {
    admin = deps.adminClient();
  } catch (e) {
    logger.error("Webhook misconfigured", { error: (e as Error).message });
    return errorResponse("Webhook endpoint is misconfigured", 500);
  }

  const { data: integ, error: intErr } = await admin
    .from("integrations_integration")
    .select("id, workspace_id, brand_id, encrypted_credentials")
    .eq("brand_id", brandId)
    .eq("provider", spec.provider)
    .maybeSingle();
  if (intErr) {
    logger.error(`${spec.provider} webhook integration lookup failed`, { error: intErr.message });
    return errorResponse("Temporary failure", 500);
  }
  // Same 401 for "unknown brand" and "bad signature" so the endpoint can't be used to enumerate brands.
  if (!integ) return errorResponse("Invalid webhook signature", 401);

  let secret = "";
  try {
    secret = spec.secretFrom(integ.encrypted_credentials ? await decryptCredentials(integ.encrypted_credentials) : {});
  } catch (e) {
    logger.error(`${spec.provider} webhook secret decrypt failed`, { error: (e as Error).message });
    return errorResponse("Webhook endpoint is misconfigured", 500);
  }
  if (!secret) {
    logger.warn(`Rejected ${spec.provider} webhook: no webhook secret stored`, { brand_id: brandId });
    return errorResponse("Invalid webhook signature", 401);
  }

  if (!(await spec.verify(secret, raw, signature))) {
    logger.warn(`Rejected ${spec.provider} webhook: invalid signature`, { brand_id: brandId });
    return errorResponse("Invalid webhook signature", 401);
  }

  let payload: any;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return errorResponse("Malformed JSON payload", 400);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return errorResponse("Malformed JSON payload", 400);
  }

  const deliveryId = spec.deliveryId(req, payload, await sha256Hex(raw));
  const topic = spec.topic(req, payload).slice(0, 100);
  const eventId = `${spec.provider}:${deliveryId}`.slice(0, 255);
  const ctx = { workspace_id: integ.workspace_id as string, brand_id: brandId };

  const { data: existing, error: dupErr } = await admin
    .from("integrations_webhookevent")
    .select("id")
    .eq("brand_id", brandId)
    .eq("provider", spec.provider)
    .eq("event_id", eventId)
    .limit(1)
    .maybeSingle();
  if (dupErr) {
    logger.error(`${spec.provider} webhook duplicate check failed`, { error: dupErr.message });
    return errorResponse("Temporary failure", 500);
  }
  if (existing) return successResponse({ status: "duplicate", event_id: eventId });

  try {
    await spec.process(admin, ctx, topic, payload);
  } catch (e) {
    logger.error(`${spec.provider} webhook processing failed`, { event_id: eventId, topic, error: (e as Error).message });
    return errorResponse("Webhook processing failed; provider should retry", 500);
  }

  const { data: inserted, error: insErr } = await admin
    .from("integrations_webhookevent")
    .insert({
      ...ctx,
      provider: spec.provider,
      event_id: eventId,
      topic,
      raw_body: new TextDecoder().decode(raw),
      headers: spec.storedHeaders(req),
      processed: true,
      processed_at: new Date().toISOString(),
    })
    .select("id");
  if (insErr) {
    // Business data is already persisted idempotently; a retry will simply re-upsert.
    logger.error(`${spec.provider} webhook event log insert failed`, { event_id: eventId, error: insErr.message });
    return errorResponse("Webhook event could not be recorded; provider should retry", 500);
  }
  // trg_webhookevent_dedupe silently drops a concurrent duplicate insert (no row returned).
  if (!inserted || inserted.length === 0) return successResponse({ status: "duplicate", event_id: eventId });

  return successResponse({ status: "accepted", event_id: eventId, topic });
}
