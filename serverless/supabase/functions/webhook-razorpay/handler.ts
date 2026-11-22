import { handleCors } from "../_shared/cors.ts";
import { handleWebhook } from "../_shared/webhooks.ts";
import { verifyRazorpaySignature } from "../_shared/signatures.ts";
import { upsertCanonical } from "../_shared/integrations.ts";
import { mapRazorpayPayment } from "../_shared/mappers.ts";
import type { Deps } from "../_shared/deps.ts";

export function createHandler(deps: Deps) {
  return async (req: Request): Promise<Response> => {
    const cors = handleCors(req);
    if (cors) return cors;
    return await handleWebhook(req, deps, {
      provider: "razorpay",
      // The webhook secret is set per-webhook in the Razorpay dashboard (NOT the API key secret).
      secretFrom: (c) => String(c.webhook_secret || "").trim(),
      signatureHeader: "x-razorpay-signature",
      verify: verifyRazorpaySignature,
      // X-Razorpay-Event-Id is identical across Razorpay's retries of one event.
      deliveryId: (r, _p, hash) => r.headers.get("x-razorpay-event-id") || `sha256:${hash}`,
      topic: (_r, p) => String(p?.event || "unknown"),
      storedHeaders: (r) => ({ "x-razorpay-event-id": r.headers.get("x-razorpay-event-id") }),
      process: async (admin, ctx, topic, payload) => {
        const entity = payload?.payload?.payment?.entity;
        if (!entity) return; // e.g. refund.* / settlement.* — logged, not projected
        if (!topic.startsWith("payment.") && topic !== "order.paid") return;
        await upsertCanonical(admin, "commerce_paymentattempt", mapRazorpayPayment(entity, ctx));
      },
    });
  };
}
