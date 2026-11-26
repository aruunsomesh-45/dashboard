import { handleCors } from "../_shared/cors.ts";
import { handleWebhook } from "../_shared/webhooks.ts";
import { verifyRazorpaySignature } from "../_shared/signatures.ts";
import { processRazorpayPayment, processRazorpayRefund } from "../_shared/pipeline.ts";
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
        const payment = payload?.payload?.payment?.entity;
        const refund = payload?.payload?.refund?.entity;
        if (topic.startsWith("refund.") && refund) {
          // refund events also carry the payment, whose amount_refunded/refund_status changed
          if (payment) await processRazorpayPayment(admin, ctx, payment, { source: "webhook" });
          await processRazorpayRefund(admin, ctx, refund, { source: "webhook" });
          return;
        }
        if (!payment) return; // e.g. settlement.* — logged, not projected
        if (!topic.startsWith("payment.") && topic !== "order.paid") return;
        await processRazorpayPayment(admin, ctx, payment, { source: "webhook" });
      },
    });
  };
}
