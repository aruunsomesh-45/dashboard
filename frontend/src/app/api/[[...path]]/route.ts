import { NextRequest, NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabaseServer";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { path?: string[] } }) {
  return handleRequest(req, params?.path || [], "GET");
}

export async function POST(req: NextRequest, { params }: { params: { path?: string[] } }) {
  return handleRequest(req, params?.path || [], "POST");
}

export async function PUT(req: NextRequest, { params }: { params: { path?: string[] } }) {
  return handleRequest(req, params?.path || [], "PUT");
}

export async function DELETE(req: NextRequest, { params }: { params: { path?: string[] } }) {
  return handleRequest(req, params?.path || [], "DELETE");
}

async function handleRequest(req: NextRequest, pathParts: string[], method: string) {
  const admin = getAdminClient();
  const searchParams = req.nextUrl.searchParams;

  // Path format: w / :workspaceSlug / b / :brandId / :subpath...
  const wIdx = pathParts.indexOf("w");
  const bIdx = pathParts.indexOf("b");

  if (wIdx !== -1 && bIdx !== -1 && bIdx === wIdx + 2) {
    const wsSlug = pathParts[wIdx + 1];
    const brandId = pathParts[bIdx + 1];
    const actionParts = pathParts.slice(bIdx + 2);
    const action = actionParts.join("/").replace(/\/+$/, "");

    // 1. Shopify Stats: /api/w/:ws/b/:brand/shopify/stats
    if (action === "shopify/stats") {
      const days = parseInt(searchParams.get("days") || "30", 10) || 30;
      const { data: allOrders } = await admin
        .from("commerce_order")
        .select("*")
        .eq("brand_id", brandId);

      const orders = allOrders || [];
      const nonCancelled = orders.filter((o: any) => !o.cancelled_at);

      const gross_sales = nonCancelled.reduce((sum: number, o: any) => sum + (o.gross_amount || 0), 0);
      const net_sales = nonCancelled.reduce((sum: number, o: any) => sum + (o.net_sales || 0), 0);
      const discount_total = nonCancelled.reduce((sum: number, o: any) => sum + (o.discount_amount || 0), 0);
      const tax_total = nonCancelled.reduce((sum: number, o: any) => sum + (o.tax_amount || 0), 0);
      const shipping_total = nonCancelled.reduce((sum: number, o: any) => sum + (o.shipping_amount || 0), 0);
      const order_count = nonCancelled.length;
      const aov = order_count > 0 ? Math.round(net_sales / order_count) : 0;

      const funnel = {
        placed: nonCancelled.length,
        paid: nonCancelled.filter((o: any) => o.financial_status === "paid").length,
        fulfilled: nonCancelled.filter((o: any) => o.fulfillment_status === "fulfilled").length,
        partial: nonCancelled.filter((o: any) => o.fulfillment_status === "partial").length,
        unfulfilled: nonCancelled.filter((o: any) => o.fulfillment_status === "unfulfilled").length,
      };

      return NextResponse.json({
        metrics: {
          gross_sales_minor: gross_sales,
          gross_sales,
          net_sales_minor: net_sales,
          net_sales,
          discount_total_minor: discount_total,
          tax_total_minor: tax_total,
          shipping_total_minor: shipping_total,
          order_count,
          orders: order_count,
          aov_minor: aov,
          aov,
        },
        funnel,
        orders: orders.slice(0, 50),
      });
    }

    // 2. Payments Stats: /api/w/:ws/b/:brand/payments/stats or /payments
    if (action === "payments/stats" || action === "payments") {
      const { data: allPayments } = await admin
        .from("commerce_paymentattempt")
        .select("*")
        .eq("brand_id", brandId);

      const attempts = allPayments || [];
      const captured = attempts.filter((p: any) => p.status === "captured");
      const captured_n = captured.length;
      const total_n = attempts.length;
      const captured_amount = captured.reduce((sum: number, p: any) => sum + (p.amount_minor || 0), 0);

      const { data: integ } = await admin
        .from("integrations_integration")
        .select("id, status")
        .eq("brand_id", brandId)
        .eq("provider", "razorpay")
        .maybeSingle();

      return NextResponse.json({
        connected: integ?.status === "connected",
        provider: "razorpay",
        payment_count: captured_n,
        attempt_count: total_n,
        authorized_rate: total_n > 0 ? Math.round((captured_n / total_n) * 1000) / 10 : null,
        total_captured_minor: captured_amount,
        splits: attempts.slice(0, 50),
      });
    }

    // 3. Overview KPIs: /api/w/:ws/b/:brand/metrics
    if (action === "metrics") {
      const { data: allOrders } = await admin
        .from("commerce_order")
        .select("id, fulfillment_status, financial_status, cancelled_at")
        .eq("brand_id", brandId);

      const orders = allOrders || [];
      const nonCancelled = orders.filter((o: any) => !o.cancelled_at);
      const unfulfilled = nonCancelled.filter(
        (o: any) => o.fulfillment_status === "unfulfilled" && o.financial_status === "paid"
      ).length;

      return NextResponse.json({
        metrics: {
          blended_roas: { value: null, available: false },
          blended_cac: { value: null, available: false },
          delivery_success_pct: { value: null, available: false },
          orders_to_be_shipped: { value: unfulfilled, available: true },
          number_of_disputes: { value: 0, available: true },
          organic_engagement: { value: null, available: false },
        },
      });
    }

    // 4. Integrations list: /api/w/:ws/b/:brand/integrations
    if (action === "integrations") {
      const { data: list } = await admin
        .from("integrations_integration")
        .select("id, provider, status, account_identifier, last_synced_at, last_error_message, created_at, updated_at")
        .eq("brand_id", brandId);

      return NextResponse.json(list || []);
    }

    // 5. Marketing Stats: /api/w/:ws/b/:brand/marketing/stats
    if (action === "marketing/stats") {
      return NextResponse.json({
        campaigns: [],
        metrics: {
          spend_minor: 0,
          impressions: 0,
          clicks: 0,
          cpc_minor: 0,
          cpm_minor: 0,
          ctr_pct: 0,
        },
      });
    }

    // 6. Logistics Stats: /api/w/:ws/b/:brand/logistics
    if (action === "logistics") {
      return NextResponse.json({
        shipments: [],
        metrics: {
          total_shipments: 0,
          delivered: 0,
          in_transit: 0,
          rto: 0,
          delivery_pct: null,
        },
      });
    }

    // 7. Sync-now triggers: call Supabase Edge Functions directly
    if (action === "shopify/sync-now" && method === "POST") {
      return forwardToEdgeFunction("shopify-sync", { brand_id: brandId, workspace_slug: wsSlug });
    }
    if (action === "marketing/sync-now" && method === "POST") {
      return forwardToEdgeFunction("meta-ads-sync", { brand_id: brandId, workspace_slug: wsSlug });
    }
    if (action === "payments/sync-now" && method === "POST") {
      return forwardToEdgeFunction("razorpay-sync", { brand_id: brandId, workspace_slug: wsSlug });
    }
  }

  // Workspace team members: /api/w/:ws/members
  if (wIdx !== -1 && pathParts[pathParts.length - 1] === "members") {
    const wsSlug = pathParts[wIdx + 1];
    const { data: ws } = await admin.from("tenancy_workspace").select("id").eq("slug", wsSlug).maybeSingle();
    if (ws) {
      const { data: members } = await admin
        .from("tenancy_workspacemember")
        .select("id, role, created_at, user:accounts_user(id, email, first_name, last_name, mfa_enabled, created_at)")
        .eq("workspace_id", ws.id);
      return NextResponse.json(members || []);
    }
    return NextResponse.json([]);
  }

  // Graceful fallback for any other route
  return NextResponse.json({ status: "ok", data: [] });
}

async function forwardToEdgeFunction(functionName: string, payload: Record<string, any>) {
  const functionsUrl =
    process.env.NEXT_PUBLIC_FUNCTIONS_URL ||
    "https://ybyroxyofqfpozvfedhc.supabase.co/functions/v1";
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    "";

  try {
    const res = await fetch(`${functionsUrl}/${functionName}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
      },
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => ({ success: res.ok }));
    return NextResponse.json(json, { status: res.status });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message }, { status: 500 });
  }
}
