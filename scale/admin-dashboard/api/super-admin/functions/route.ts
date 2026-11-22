import { NextRequest, NextResponse } from "next/server";
import { verifySuperAdmin } from "@/lib/serverAdmin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await verifySuperAdmin(req);
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: auth.status || 401 });
  }

  const gatewayUrl = process.env.NEXT_PUBLIC_FUNCTIONS_URL || "http://127.0.0.1:54321/functions/v1";

  // The 7 official Supabase Edge Functions in 125East
  const functionsList = [
    {
      name: "test-connection",
      route: "/functions/v1/test-connection",
      purpose: "Validates third-party API credentials without persisting",
      method: "POST",
      runtime: "Deno / Edge Runtime",
      auth_required: true,
      supported_providers: ["shopify", "razorpay", "meta", "instagram"],
    },
    {
      name: "shopify-sync",
      route: "/functions/v1/shopify-sync",
      purpose: "Paginates Shopify Admin API for orders, customers & products",
      method: "POST",
      runtime: "Deno / Edge Runtime",
      auth_required: true,
      supported_providers: ["shopify"],
    },
    {
      name: "razorpay-sync",
      route: "/functions/v1/razorpay-sync",
      purpose: "Fetches captured payments, settlements, and refund logs",
      method: "POST",
      runtime: "Deno / Edge Runtime",
      auth_required: true,
      supported_providers: ["razorpay"],
    },
    {
      name: "meta-ads-sync",
      route: "/functions/v1/meta-ads-sync",
      purpose: "Extracts campaign insights, ROAS, and ad spend metrics",
      method: "POST",
      runtime: "Deno / Edge Runtime",
      auth_required: true,
      supported_providers: ["meta_ads"],
    },
    {
      name: "instagram-sync",
      route: "/functions/v1/instagram-sync",
      purpose: "Tracks profile reach, media engagement, and follower growth",
      method: "POST",
      runtime: "Deno / Edge Runtime",
      auth_required: true,
      supported_providers: ["instagram"],
    },
    {
      name: "webhook-shopify",
      route: "/functions/v1/webhook-shopify",
      purpose: "Listens for real-time order creation with Base64 HMAC validation",
      method: "POST",
      runtime: "Deno / Edge Runtime",
      auth_required: false,
      supported_providers: ["shopify"],
    },
    {
      name: "webhook-razorpay",
      route: "/functions/v1/webhook-razorpay",
      purpose: "Listens for payment capture & refund webhooks with Hex HMAC",
      method: "POST",
      runtime: "Deno / Edge Runtime",
      auth_required: false,
      supported_providers: ["razorpay"],
    },
  ];

  // Probe local gateway health
  let gatewayOnline = false;
  let probeLatency = 0;
  try {
    const start = Date.now();
    const res = await fetch("http://127.0.0.1:54321/health", { cache: "no-store" });
    probeLatency = Date.now() - start;
    if (res.ok) gatewayOnline = true;
  } catch {
    gatewayOnline = false;
  }

  const enrichedFunctions = functionsList.map((fn) => ({
    ...fn,
    status: gatewayOnline ? "operational" : "gateway_unreachable",
    latency_ms: probeLatency || null,
  }));

  return NextResponse.json({
    gateway: {
      url: gatewayUrl,
      online: gatewayOnline,
      latency_ms: probeLatency,
    },
    functions: enrichedFunctions,
  });
}
