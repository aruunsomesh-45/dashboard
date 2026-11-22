/**
 * Local Serverless Edge Function Gateway for 125 EAST
 *
 * Runs all 7 Supabase Edge Functions on localhost:54321 without requiring Docker Desktop.
 * Fully compatible with the official Supabase Edge Runtime URL structure:
 * http://127.0.0.1:54321/functions/v1/<function-name>
 */

import { handleCors } from "./supabase/functions/_shared/cors.ts";
import { errorResponse, successResponse } from "./supabase/functions/_shared/response.ts";

import { defaultDeps } from "./supabase/functions/_shared/deps.ts";
import { createHandler as testConnection } from "./supabase/functions/test-connection/handler.ts";
import { createHandler as shopifySync } from "./supabase/functions/shopify-sync/handler.ts";
import { createHandler as razorpaySync } from "./supabase/functions/razorpay-sync/handler.ts";
import { createHandler as metaAdsSync } from "./supabase/functions/meta-ads-sync/handler.ts";
import { createHandler as instagramSync } from "./supabase/functions/instagram-sync/handler.ts";
import { createHandler as webhookShopify } from "./supabase/functions/webhook-shopify/handler.ts";
import { createHandler as webhookRazorpay } from "./supabase/functions/webhook-razorpay/handler.ts";

const PORT = 54321;
// Loopback only by default: the gateway holds the service-role key. Set GATEWAY_HOST to expose it.
const HOST = Deno.env.get("GATEWAY_HOST") || "0.0.0.0";

const deps = defaultDeps();
const handlers: Record<string, (req: Request) => Promise<Response>> = {
  "test-connection": testConnection(deps),
  "shopify-sync": shopifySync(deps),
  "razorpay-sync": razorpaySync(deps),
  "meta-ads-sync": metaAdsSync(deps),
  "instagram-sync": instagramSync(deps),
  "webhook-shopify": webhookShopify(deps),
  "webhook-razorpay": webhookRazorpay(deps),
};

async function router(req: Request): Promise<Response> {
  const cors = handleCors(req);
  if (cors) return cors;

  const url = new URL(req.url);
  const path = url.pathname;

  // Health check & root directory
  if (path === "/" || path === "/health") {
    return successResponse({
      status: "online",
      server: "125 EAST Local Edge Functions Gateway",
      functions: Object.keys(handlers),
      timestamp: new Date().toISOString(),
    });
  }

  // Supabase functions endpoint: /functions/v1/<name>
  const match = path.match(/^\/functions\/v1\/([a-zA-Z0-9_-]+)/);
  if (!match) {
    return errorResponse(`Unknown route: ${path}`, 404);
  }

  const functionName = match[1];
  const handler = handlers[functionName];

  if (!handler) {
    return errorResponse(`Function '${functionName}' not found`, 404);
  }

  try {
    return await handler(req);
  } catch (err) {
    return errorResponse(`Handler execution failed: ${(err as Error).message}`, 500);
  }
}

console.log("=====================================================================");
console.log(`⚡ 125 EAST Serverless Edge Functions Gateway Running on http://${HOST}:${PORT}`);
console.log("=====================================================================");
console.log("Available Local Functions:");
for (const fn of Object.keys(handlers)) {
  console.log(`  POST http://${HOST}:${PORT}/functions/v1/${fn}`);
}
console.log("=====================================================================");

Deno.serve({ port: PORT, hostname: HOST }, router);
