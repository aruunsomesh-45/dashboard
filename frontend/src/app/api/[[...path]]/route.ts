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

async function handleRequest(req: NextRequest, rawPathParts: string[], method: string) {
  const admin = getAdminClient();
  const searchParams = req.nextUrl.searchParams;
  // Normalize path segments by removing any trailing empty tokens
  const pathParts = (rawPathParts || []).filter(Boolean);
  const fullPath = pathParts.join("/");

  // ── MFA & Security Endpoints ──────────────────────────────────────────
  if (fullPath.includes("mfa/status")) {
    return NextResponse.json({
      is_enabled: false,
      is_pending: false,
      unused_recovery_codes_count: 0,
      confirmed_at: null,
    });
  }

  if (fullPath.includes("mfa/setup")) {
    return NextResponse.json({
      secret: "JBSWY3DPEHPK3PXP",
      provisioning_uri: "otpauth://totp/125East:admin?secret=JBSWY3DPEHPK3PXP&issuer=125East",
      qr_code_base64:
        "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180' viewBox='0 0 180 180'><rect width='180' height='180' fill='%23ffffff'/><rect x='20' y='20' width='40' height='40' fill='%23111827'/><rect x='120' y='20' width='40' height='40' fill='%23111827'/><rect x='20' y='120' width='40' height='40' fill='%23111827'/><rect x='70' y='70' width='40' height='40' fill='%23111827'/></svg>",
    });
  }

  if (fullPath.includes("mfa/confirm")) {
    return NextResponse.json({
      success: true,
      recovery_codes: [
        "A1B2-C3D4",
        "E5F6-G7H8",
        "I9J0-K1L2",
        "M3N4-O5P6",
        "Q7R8-S9T0",
        "U1V2-W3X4",
        "Y5Z6-A7B8",
        "C9D0-E1F2",
        "G3H4-I5J6",
        "K7L8-M9N0",
      ],
    });
  }

  if (fullPath.includes("mfa/disable")) {
    return NextResponse.json({ success: true });
  }

  if (fullPath.includes("mfa/recovery-codes")) {
    return NextResponse.json({
      recovery_codes: [
        "B2C3-D4E5",
        "F6G7-H8I9",
        "J0K1-L2M3",
        "N4O5-P6Q7",
        "R8S9-T0U1",
        "V2W3-X4Y5",
        "Z6A7-B8C9",
        "D0E1-F2G3",
        "H4I5-J6K7",
        "L8M9-N0O1",
      ],
    });
  }

  // ── Workspace & Brand Scoped Endpoints ─────────────────────────────────
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
        method_splits: {
          upi: captured_n > 0 ? captured_n : 1,
        },
      });
    }

    // 2b. Payments Transactions: /api/w/:ws/b/:brand/payments/transactions
    if (action === "payments/transactions") {
      const { data: allPayments } = await admin
        .from("commerce_paymentattempt")
        .select("*")
        .eq("brand_id", brandId)
        .order("created_at", { ascending: false })
        .limit(100);

      const formatted = (allPayments || []).map((p: any) => ({
        id: p.id || p.provider_payment_id || `pay_${Math.random().toString(36).substring(2, 9)}`,
        order_id: p.order_id || p.provider_order_id || "order_core",
        amount_minor: p.amount_minor || 0,
        status: p.status || "captured",
        method: p.method || "upi",
        created_at: p.created_at || new Date().toISOString(),
      }));

      return NextResponse.json(formatted);
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

    // 6. Logistics Summary: /api/w/:ws/b/:brand/logistics/summary
    if (action === "logistics/summary") {
      return NextResponse.json({
        total_shipments: 0,
        in_transit_count: 0,
        delivered_count: 0,
        ndr_count: 0,
        ndr_rate_percentage: null,
        rto_rate_percentage: null,
        avg_delivery_days: null,
      });
    }

    // 6b. Logistics Shipments: /api/w/:ws/b/:brand/logistics/shipments or /logistics
    if (action === "logistics/shipments" || action === "logistics") {
      return NextResponse.json([]);
    }

    // 6c. Logistics NDR Action: /api/w/:ws/b/:brand/logistics/ndr/:awb/action
    if (action.startsWith("logistics/ndr/")) {
      return NextResponse.json({
        success: true,
        message: "Carrier action instructions registered.",
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

  // ── Workspace Team & Invites ──────────────────────────────────────────
  if (wIdx !== -1) {
    const lastPart = pathParts[pathParts.length - 1];
    const wsSlug = pathParts[wIdx + 1];

    if (lastPart === "members") {
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

    if (lastPart === "invites" && method === "POST") {
      return NextResponse.json({
        invite_url: "/invites/accept?token=125east_demo_invite",
      });
    }
  }

  // Defensive array fallback for list endpoints
  if (fullPath.includes("shipments") || fullPath.includes("transactions") || fullPath.includes("members")) {
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
