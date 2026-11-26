// Marketing page API: campaigns are grouped from the ad-level daily rows (last 30 days).
// [LOCAL PGlite DB + real route code]
import { assertEquals } from "jsr:@std/assert@1";
import { hit, WebWorld } from "./harness.ts";

const opts = { sanitizeResources: false, sanitizeOps: false };

Deno.test({ ...opts, name: "Marketing campaigns API", fn: async (t) => {
  const ww = await WebWorld.create();
  const w = ww.w;
  const api = await import("../../../frontend/src/app/api/[[...path]]/route.ts");
  const M = await ww.tenant("campaigns-owner@example.test", "Campaign Org");
  await w.addIntegration(M, "meta_ads", { ad_account_id: "act_77", access_token: "EAAB_synthetic" }, "act_77");
  const cookies = { "sb-access-token": M.token };
  const path = `/api/w/${M.slug}/b/${M.brand_id}/marketing/stats/`;

  const ins = (date: string, ad: string, campaign: string | null, name: string | null, status: string | null,
    spend: number, impressions: number, clicks: number, purchases: number, revenue: number) =>
    w.db.query(
      `insert into analytics_meta_ad_daily (workspace_id, brand_id, ad_account_id, campaign_id, campaign_name, campaign_status,
          adset_id, ad_id, ad_name, report_date, attribution_setting, currency, spend_minor, impressions, clicks, purchases, purchase_value_minor)
        values ($1,$2,'act_77',$3,$4,$5,'9',$6,$6,$7::date,'account_default','INR',$8,$9,$10,$11,$12)`,
      [M.workspace_id, M.brand_id, campaign, name, status, ad, date, spend, impressions, clicks, purchases, revenue]);

  const recent = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  const older = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  const longAgo = new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10);

  await t.step("campaigns are grouped per campaign with totals, ratios and status", async () => {
    // Campaign 111: two ads over two days.
    await ins(older, "a1", "111", "Summer Sale (old name)", "paused", 10000, 20000, 400, 4, 40000);
    await ins(recent, "a1", "111", "Summer Sale", "active", 5000, 10000, 100, 2, 20000);
    await ins(recent, "a2", "111", "Summer Sale", "active", 5000, 10000, 100, 1, 10000);
    // Campaign 222: no clicks, so CTR and CPC must be null (not zero).
    await ins(recent, "b1", "222", "Winter Clearance", "paused", 3000, 5000, 0, 0, 0);
    // Outside the 30-day window: must not count.
    await ins(longAgo, "a1", "111", "Summer Sale", "active", 99999, 99999, 99999, 99, 99999);

    const r = await hit(api, path, { cookies });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    const cs = r.body.campaigns;
    assertEquals(cs.map((c: any) => c.id), ["111", "222"]); // sorted by spend, highest first

    const summer = cs[0];
    assertEquals(summer.name, "Summer Sale");           // the most recent name wins
    assertEquals(summer.status, "active");              // the most recent status wins
    assertEquals(summer.spend_minor, 20000);            // 10000 + 5000 + 5000, outside-window row excluded
    assertEquals(summer.impressions, 40000);
    assertEquals(summer.clicks, 600);
    assertEquals(summer.orders, 7);
    assertEquals(summer.attributed_revenue_minor, 70000);
    assertEquals(summer.ctr, 1.5);                      // 600 / 40000 * 100
    assertEquals(summer.cpc_minor, 33);                 // 20000 / 600 = 33.3 -> 33
    assertEquals(summer.roas, 3.5);                     // 70000 / 20000

    const winter = cs[1];
    assertEquals([winter.status, winter.spend_minor], ["paused", 3000]);
    assertEquals([winter.ctr, winter.cpc_minor, winter.roas], [0, null, 0]);

    // All-time: the row from 45 days ago is included (99999 spend on top of the 30-day 20000).
    const all = r.body.campaigns_lifetime;
    assertEquals(all.map((c: any) => c.id), ["111", "222"]);
    assertEquals(all[0].spend_minor, 119999);
    assertEquals(all[1].spend_minor, 3000);
  });

  await t.step("a connected account with no ad-level rows yet returns an empty campaign list (not an error)", async () => {
    const E = await ww.tenant("campaigns-empty@example.test", "Empty Campaign Org");
    await w.addIntegration(E, "meta_ads", { ad_account_id: "act_88", access_token: "EAAB_synthetic" }, "act_88");
    const r = await hit(api, `/api/w/${E.slug}/b/${E.brand_id}/marketing/stats/`, { cookies: { "sb-access-token": E.token } });
    assertEquals(r.status, 200);
    assertEquals(r.body.campaigns, []);
    assertEquals(r.body.campaigns_lifetime, []);
  });
}});
