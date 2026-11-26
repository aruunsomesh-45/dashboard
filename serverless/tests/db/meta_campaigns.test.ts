// Meta campaign-level sync: the sync also stores one row per ad per day (campaign, ad set, ad names and
// metrics), tagged with each campaign's status. [MOCKED Graph API (scripted, synthetic) + LOCAL DB (real schema)]
import { assert, assertEquals } from "jsr:@std/assert@1";
import { call, json, type Tenant, World } from "../helpers/world.ts";
import { metaInsightDay } from "../helpers/payloads.ts";
import { createHandler as metaSync } from "../../supabase/functions/meta-ads-sync/handler.ts";

const opts = { sanitizeResources: false, sanitizeOps: false };
const body = (t: Tenant, extra: Record<string, unknown> = {}) => ({ workspace_id: t.workspace_id, brand_id: t.brand_id, ...extra });

/** One ad-level row: an ad inside a campaign, for one day. */
const adRow = (date: string, campaign: [string, string], ad: [string, string], spend = "150.25", over: Record<string, unknown> = {}) => ({
  date_start: date,
  date_stop: date,
  campaign_id: campaign[0],
  campaign_name: campaign[1],
  adset_id: "900",
  adset_name: "Broad 18-34",
  ad_id: ad[0],
  ad_name: ad[1],
  spend,
  impressions: "20000",
  reach: "15000",
  clicks: "400",
  cpm: "7.51",
  cpc: "0.38",
  ctr: "2.0",
  actions: [{ action_type: "purchase", value: "3" }],
  action_values: [{ action_type: "purchase", value: "5400.00" }],
  ...over,
});

const CAMPAIGNS = {
  data: [
    { id: "111", name: "Summer Sale", effective_status: "ACTIVE" },
    { id: "222", name: "Winter Clearance", effective_status: "PAUSED" },
  ],
};

Deno.test({ ...opts, name: "Meta campaign-level sync", fn: async (t) => {
  const w = await World.create();
  const A = await w.signUp("owner-meta@example.test", "Meta Org");
  const integ = await w.addIntegration(A, "meta_ads", { ad_account_id: "1234567890", access_token: "EAAB_synthetic" });
  const h = () => metaSync(w.deps());

  await t.step("stores one row per ad per day with its campaign name and status", async () => {
    w.http.on(/\/campaigns\?/, () => json(CAMPAIGNS));
    w.http.on(/insights\?level=account/, () => json({ data: [metaInsightDay("2026-11-01")] }));
    w.http.on(/insights\?level=ad/, () => json({ data: [
      adRow("2026-11-01", ["111", "Summer Sale"], ["5001", "Hero video"]),
      adRow("2026-11-01", ["111", "Summer Sale"], ["5002", "Carousel"], "99.00"),
      adRow("2026-11-01", ["222", "Winter Clearance"], ["6001", "Static"]),
    ] }));
    const r = await call(h(), "meta-ads-sync", { token: A.token, body: body(A) });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals([r.body.data.ad_rows_processed, r.body.data.ad_rows_saved, r.body.data.ad_rows_failed], [3, 3, 0]);

    const rows = await w.rows<any>(
      `select campaign_id, campaign_name, campaign_status, ad_id, ad_name, adset_name, spend_minor, clicks, purchases, purchase_value_minor
         from analytics_meta_ad_daily where brand_id=$1 order by ad_id`, [A.brand_id]);
    assertEquals(rows.map((x) => [x.ad_id, x.campaign_name, x.campaign_status, Number(x.spend_minor), x.adset_name]), [
      ["5001", "Summer Sale", "active", 15025, "Broad 18-34"],
      ["5002", "Summer Sale", "active", 9900, "Broad 18-34"],
      ["6001", "Winter Clearance", "paused", 15025, "Broad 18-34"],
    ]);
    assertEquals(Number(rows[0].purchase_value_minor), 540000);
    // the ad-level request asks for campaign and ad fields
    const adCall = w.http.calls.find((c) => c.url.includes("level=ad"))!;
    assert(new URL(adCall.url).searchParams.get("fields")!.includes("campaign_id"), adCall.url);
  });

  await t.step("re-running the sync updates the same rows (no duplicates)", async () => {
    w.http.routes = [];
    w.http.on(/\/campaigns\?/, () => json({ data: [{ id: "111", name: "Summer Sale (renamed)", effective_status: "PAUSED" }] }));
    w.http.on(/insights\?level=account/, () => json({ data: [metaInsightDay("2026-11-01")] }));
    w.http.on(/insights\?level=ad/, () => json({ data: [adRow("2026-11-01", ["111", "Summer Sale (renamed)"], ["5001", "Hero video"])] }));
    const r = await call(h(), "meta-ads-sync", { token: A.token, body: body(A) });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals(await w.count("analytics_meta_ad_daily", "brand_id=$1", [A.brand_id]), 3);
    const [row] = await w.rows<any>("select campaign_name, campaign_status from analytics_meta_ad_daily where ad_id='5001' and brand_id=$1", [A.brand_id]);
    assertEquals([row.campaign_name, row.campaign_status], ["Summer Sale (renamed)", "paused"]);
  });

  await t.step("if the campaign list cannot be read, rows are still stored (status unknown) and the sync succeeds", async () => {
    w.http.routes = [];
    w.http.on(/\/campaigns\?/, () => new Response("boom", { status: 500 }));
    w.http.on(/insights\?level=account/, () => json({ data: [metaInsightDay("2026-11-02")] }));
    w.http.on(/insights\?level=ad/, () => json({ data: [adRow("2026-11-02", ["222", "Winter Clearance"], ["6001", "Static"])] }));
    const r = await call(h(), "meta-ads-sync", { token: A.token, body: body(A) });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    const [row] = await w.rows<any>("select campaign_status from analytics_meta_ad_daily where ad_id='6001' and report_date='2026-11-02'");
    assertEquals(row.campaign_status, null);
  });

  await t.step("a window (days, end_offset_days) asks Meta for exactly that date range", async () => {
    w.http.routes = [];
    w.http.calls = [];
    w.http.on(/\/campaigns\?/, () => json({ data: [] }));
    w.http.on(/insights\?level=/, () => json({ data: [] }));
    const r = await call(h(), "meta-ads-sync", { token: A.token, body: body(A, { days: 30, end_offset_days: 30 }) });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
    const tr = JSON.parse(new URL(w.http.calls.find((c) => c.url.includes("level=account"))!.url).searchParams.get("time_range")!);
    assertEquals(tr, { since: day(60), until: day(30) });
  });

  await t.step("a rejected token on the ad-level call fails the run and marks the connection in error", async () => {
    w.http.routes = [];
    w.http.on(/\/campaigns\?/, () => json(CAMPAIGNS));
    w.http.on(/insights\?level=account/, () => json({ data: [metaInsightDay("2026-11-03")] }));
    w.http.on(/insights\?level=ad/, () => json({ error: { message: "Invalid OAuth access token - Cannot parse access token", type: "OAuthException", code: 190 } }, 400));
    const r = await call(h(), "meta-ads-sync", { token: A.token, body: body(A) });
    assertEquals(r.status, 502, JSON.stringify(r.body));
    const [st] = await w.rows<any>("select status from integrations_integration where id=$1", [integ]);
    assertEquals(st.status, "error");
  });
}});
