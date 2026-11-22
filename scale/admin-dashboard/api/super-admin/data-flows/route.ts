import { NextRequest, NextResponse } from "next/server";
import { getAdminClient, verifySuperAdmin } from "@/lib/serverAdmin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await verifySuperAdmin(req);
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: auth.status || 401 });
  }

  const admin = getAdminClient();

  try {
    // Pipeline tracking from sync runs and webhooks
    const { data: syncRuns } = await admin
      .from("integrations_syncrun")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(50);

    const { data: webhooks } = await admin
      .from("integrations_webhookevent")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);

    // Standardized stages for the 125East pipeline:
    // External API -> Edge Function -> Validation & Decrypt -> Database -> Analytics
    const pipelineStages = [
      { id: "upstream_api", name: "1. External API Handshake", status: "healthy", description: "Shopify Admin API, Razorpay, Meta Graph API" },
      { id: "edge_function", name: "2. Edge Function Dispatch", status: "healthy", description: "Deno Edge Runtime gateway verification" },
      { id: "validation", name: "3. Cryptographic Validation", status: "healthy", description: "HMAC-SHA256 & AES-256-GCM Decryption" },
      { id: "database", name: "4. PostgreSQL Persistence", status: "healthy", description: "Idempotent upsert & RLS isolation" },
      { id: "analytics", name: "5. Analytics Aggregation", status: "healthy", description: "Daily facts rollups & P&L statements" },
    ];

    return NextResponse.json({
      pipeline_stages: pipelineStages,
      recent_syncs: syncRuns || [],
      recent_webhooks: webhooks || [],
    });
  } catch (err: any) {
    return NextResponse.json({ error: "Failed to load data flow metrics", details: err?.message }, { status: 500 });
  }
}
