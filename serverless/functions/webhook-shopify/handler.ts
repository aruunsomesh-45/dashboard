import { handleCors } from "../_shared/cors.ts";
import { handleWebhook } from "../_shared/webhooks.ts";
import { verifyShopifyHmac } from "../_shared/signatures.ts";
import { processShopifyOrder, processShopifyRefund } from "../_shared/pipeline.ts";
import type { Deps } from "../_shared/deps.ts";

/** Order topics that carry a full order payload (orders/delete only carries an id). */
const ORDER_UPSERT_TOPICS = new Set([
  "orders/create",
  "orders/updated",
  "orders/paid",
  "orders/cancelled",
  "orders/fulfilled",
  "orders/partially_fulfilled",
  "orders/edited",
]);

export function createHandler(deps: Deps) {
  return async (req: Request): Promise<Response> => {
    const cors = handleCors(req);
    if (cors) return cors;
    return await handleWebhook(req, deps, {
      provider: "shopify",
      // Shopify signs webhooks with the app's client secret (API secret key, shpss_...).
      secretFrom: (c) => String(c.webhook_secret || c.api_secret || c.shared_secret || c.client_secret || "").trim(),
      signatureHeader: "x-shopify-hmac-sha256",
      verify: verifyShopifyHmac,
      // X-Shopify-Event-Id is stable across retries of the same event; Webhook-Id identifies the delivery.
      deliveryId: (r, _p, hash) => r.headers.get("x-shopify-event-id") || r.headers.get("x-shopify-webhook-id") || `sha256:${hash}`,
      topic: (r) => (r.headers.get("x-shopify-topic") || "unknown").toLowerCase(),
      storedHeaders: (r) => ({
        "x-shopify-topic": r.headers.get("x-shopify-topic"),
        "x-shopify-shop-domain": r.headers.get("x-shopify-shop-domain"),
        "x-shopify-webhook-id": r.headers.get("x-shopify-webhook-id"),
        "x-shopify-event-id": r.headers.get("x-shopify-event-id"),
        "x-shopify-api-version": r.headers.get("x-shopify-api-version"),
      }),
      process: async (admin, ctx, topic, payload) => {
        if (ORDER_UPSERT_TOPICS.has(topic)) {
          await processShopifyOrder(admin, ctx, payload, { source: "webhook" });
        } else if (topic === "refunds/create") {
          await processShopifyRefund(admin, ctx, payload, { source: "webhook" });
        }
        // other topics: kept in the webhook event log, not projected
      },
    });
  };
}
