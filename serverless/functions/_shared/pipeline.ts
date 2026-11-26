/**
 * One normalisation path per entity, shared by the sync functions, the webhooks and reprocess-raw:
 *   raw payload (PII-minimised, hash-deduplicated) -> normalise -> idempotent upsert -> raw status.
 * A failure marks the raw row `failed` (queryable, re-processable) and is re-thrown to the caller.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.48.1";
import { markRaw, type RawRef, type RawSource, recordRaw } from "./ingest.ts";
import { upsertCanonical } from "./integrations.ts";
import {
  mapRazorpayPayment,
  mapRazorpayRefund,
  mapShopifyCustomer,
  mapShopifyLineItems,
  mapShopifyOrder,
  mapShopifyRefund,
  mapShopifyRefunds,
  mapOrderTouchpoints,
  type TenantCtx,
} from "./mappers.ts";

export interface ProcessOpts {
  source: RawSource;
  /** Re-processing an already stored raw row: don't store it again. */
  rawRef?: RawRef | null;
  /**
   * The payload has had PII removed (re-processing from the raw store). The customer row is then
   * looked up, never upserted, so stored customer details are not blanked out.
   */
  redacted?: boolean;
}

async function withRaw<T>(
  admin: SupabaseClient,
  ctx: TenantCtx,
  raw: { provider: string; topic: string; entityId: string; payload: unknown },
  opts: ProcessOpts,
  work: (ref: RawRef | null) => Promise<T>,
): Promise<T> {
  const ref = opts.rawRef !== undefined ? opts.rawRef : await recordRaw(admin, ctx, { ...raw, source: opts.source });
  try {
    const out = await work(ref);
    await markRaw(admin, ref, "processed");
    return out;
  } catch (e) {
    await markRaw(admin, ref, "failed", (e as Error).message);
    throw e;
  }
}

async function existingCustomerId(admin: SupabaseClient, ctx: TenantCtx, providerId: string): Promise<string | null> {
  const { data, error } = await admin.from("commerce_customer").select("id")
    .eq("brand_id", ctx.brand_id).eq("provider", "shopify").eq("provider_id", providerId).maybeSingle();
  if (error) throw new Error(`customer lookup failed: ${error.message}`);
  return data?.id ?? null;
}

/** Shopify order (REST or webhook payload) -> customer, order, lines, refunds. */
export async function processShopifyOrder(
  admin: SupabaseClient,
  ctx: TenantCtx,
  order: any,
  opts: ProcessOpts,
): Promise<{ orderId: string; created: boolean }> {
  return await withRaw(admin, ctx, { provider: "shopify", topic: "order", entityId: String(order?.id ?? ""), payload: order }, opts, async (ref) => {
    let customerId: string | null = null;
    if (order?.customer?.id !== undefined && order?.customer?.id !== null) {
      if (opts.redacted) {
        customerId = await existingCustomerId(admin, ctx, String(order.customer.id));
      } else {
        const customer = mapShopifyCustomer(order.customer, ctx);
        if (customer) customerId = (await upsertCanonical(admin, "commerce_customer", customer)).id;
      }
    }
    const row = { ...mapShopifyOrder(order, ctx, customerId), ...(ref ? { raw_payload_ref: ref.id } : {}) };
    const { id: orderId, created } = await upsertCanonical(admin, "commerce_order", row);

    // commerce_orderline has no natural key: replace the order's lines so re-syncs never duplicate them.
    const lines = mapShopifyLineItems(order, orderId);
    const { error: delErr } = await admin.from("commerce_orderline").delete().eq("order_id", orderId);
    if (delErr) throw new Error(`orderline delete failed: ${delErr.message}`);
    if (lines.length) {
      const { error } = await admin.from("commerce_orderline").insert(lines);
      if (error) throw new Error(`orderline insert failed: ${error.message}`);
    }

    for (const refund of mapShopifyRefunds(order, ctx)) {
      await upsertCanonical(admin, "commerce_refund", { ...refund, order_id: orderId, ...(ref ? { raw_payload_ref: ref.id } : {}) });
    }

    // Order-level attribution touchpoints: written once, never overwritten by later syncs.
    for (const touch of mapOrderTouchpoints(order, ctx, orderId)) {
      const { error } = await admin.from("attribution_touchpoint").insert(touch);
      if (error && (error as { code?: string }).code !== "23505") throw new Error(`touchpoint insert failed: ${error.message}`);
    }
    return { orderId, created };
  });
}

/** Shopify refunds/create webhook -> commerce_refund (order link resolved by reconciliation if the order is unknown). */
export async function processShopifyRefund(admin: SupabaseClient, ctx: TenantCtx, refund: any, opts: ProcessOpts): Promise<void> {
  await withRaw(admin, ctx, { provider: "shopify", topic: "refund", entityId: String(refund?.id ?? ""), payload: refund }, opts, async (ref) => {
    const orderProviderId = String(refund?.order_id ?? "");
    let currency = "INR";
    let orderId: string | null = null;
    if (orderProviderId) {
      const { data } = await admin.from("commerce_order").select("id, currency")
        .eq("brand_id", ctx.brand_id).eq("provider", "shopify").eq("provider_id", orderProviderId).maybeSingle();
      if (data) {
        orderId = data.id;
        currency = data.currency;
      }
    }
    await upsertCanonical(admin, "commerce_refund", {
      ...mapShopifyRefund(refund, ctx, orderProviderId, currency),
      ...(orderId ? { order_id: orderId } : {}),
      ...(ref ? { raw_payload_ref: ref.id } : {}),
    });
  });
}

/** Razorpay payment entity -> commerce_paymentattempt. */
export async function processRazorpayPayment(
  admin: SupabaseClient,
  ctx: TenantCtx,
  payment: any,
  opts: ProcessOpts,
): Promise<{ id: string; created: boolean }> {
  return await withRaw(admin, ctx, { provider: "razorpay", topic: "payment", entityId: String(payment?.id ?? ""), payload: payment }, opts, async () => {
    return await upsertCanonical(admin, "commerce_paymentattempt", mapRazorpayPayment(payment, ctx));
  });
}

/** Razorpay refund entity -> commerce_refund (linked to its payment by reconciliation). */
export async function processRazorpayRefund(admin: SupabaseClient, ctx: TenantCtx, refund: any, opts: ProcessOpts): Promise<void> {
  await withRaw(admin, ctx, { provider: "razorpay", topic: "refund", entityId: String(refund?.id ?? ""), payload: refund }, opts, async (ref) => {
    await upsertCanonical(admin, "commerce_refund", { ...mapRazorpayRefund(refund, ctx), ...(ref ? { raw_payload_ref: ref.id } : {}) });
  });
}
