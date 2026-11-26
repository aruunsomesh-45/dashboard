// Phase 3 performance: query plans + timings at synthetic volume.
// [SYNTHETIC data in LOCAL PGlite (single-threaded WASM Postgres). Timings are RELATIVE evidence
//  only; hosted Postgres is typically much faster. Plans (index usage) are what transfers.]
// Run: deno task test:perf   (set PERF_OUT=<file> to save the JSON results)
import { assert, assertEquals } from "jsr:@std/assert@1";
import { World } from "../helpers/world.ts";

const opts = { sanitizeResources: false, sanitizeOps: false };
const N_ORDERS = Number(Deno.env.get("PERF_ORDERS") ?? 50_000);
const N_PAYMENTS = Number(Deno.env.get("PERF_PAYMENTS") ?? 50_000);

async function timed<T>(fn: () => Promise<T>, runs = 3): Promise<{ ms: number; result: T }> {
  const times: number[] = [];
  let result!: T;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    result = await fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return { ms: Math.round(times[Math.floor(runs / 2)]), result };
}

Deno.test({ ...opts, name: "Phase 3 performance (synthetic volume)", fn: async (t) => {
  const w = await World.create();
  const A = await w.signUp("perf-a@example.test", "Perf A");
  const B = await w.signUp("perf-b@example.test", "Perf B");
  const results: Record<string, unknown> = { orders: N_ORDERS, payments: N_PAYMENTS, engine: "PGlite (WASM, single connection)" };
  const plan = async (sql: string, params: unknown[] = []) =>
    (await w.rows<any>(`explain ${sql}`, params)).map((r) => r["QUERY PLAN"]).join("\n");

  const log = (m: string) => console.error(`[perf ${new Date().toISOString().slice(11, 19)}] ${m}`);
  await t.step("seed", async () => {
    log("seeding");
    const t0 = performance.now();
    // deterministic ids (md5 -> uuid) so orders can reference customers without a join
    await w.rows(`insert into commerce_customer (id, workspace_id, brand_id, provider, provider_id, email)
                  select md5('c' || g)::uuid, $1, $2, 'shopify', 'c' || g, 'c' || g || '@example.test' from generate_series(1, 20000) g`, [A.workspace_id, A.brand_id]);
    await w.rows(`insert into commerce_order (workspace_id, brand_id, provider, provider_id, order_number, currency, gross_amount, net_sales,
                    discount_amount, tax_amount, shipping_amount, financial_status, fulfillment_status, payment_gateways, source_created_at, source_updated_at, customer_id)
                  select $1, $2, 'shopify', g::text, (1000 + g)::text, 'INR', 100000 + (g % 50) * 1000, 90000, 5000, 13000, 5000,
                         case when g % 20 = 0 then 'refunded' else 'paid' end, case when g % 3 = 0 then 'fulfilled' else 'unfulfilled' end,
                         '{Razorpay}', now() - (g % 400) * interval '1 day' - (g % 1440) * interval '1 minute', now(), md5('c' || (1 + g % 20000))::uuid
                    from generate_series(1, $3::int) g`, [A.workspace_id, A.brand_id, N_ORDERS]);
    await w.rows(`insert into commerce_order (workspace_id, brand_id, provider, provider_id, order_number, currency, gross_amount, net_sales, source_created_at)
                  select $1, $2, 'shopify', g::text, (1000 + g)::text, 'INR', 1000, 1000, now() - (g % 30) * interval '1 day'
                    from generate_series(1, 5000) g`, [B.workspace_id, B.brand_id]);
    await w.rows(`insert into commerce_orderline (order_id, title, quantity, price_minor, provider_variant_id)
                  select o.id, 'Item', 1, 50000, 'v' || (o.provider_id::int % 300) from commerce_order o, generate_series(1, 2)
                   where o.brand_id = $1`, [A.brand_id]);
    await w.rows(`insert into commerce_paymentattempt (workspace_id, brand_id, provider, provider_id, amount_minor, currency, status, method, source_created_at, merchant_order_ref)
                  select $1, $2, 'razorpay', 'pay_' || g, 100000 + (g % 50) * 1000, 'INR',
                         case when g % 10 = 0 then 'failed' else 'captured' end, 'upi',
                         now() - (g % 400) * interval '1 day' - (g % 1440) * interval '1 minute',
                         case when g % 4 = 0 then '' else g::text end
                    from generate_series(1, $3::int) g`, [A.workspace_id, A.brand_id, N_PAYMENTS]);
    log("seeded, analyzing");
    await w.db.exec("analyze");
    results.seed_ms = Math.round(performance.now() - t0);
    assertEquals(await w.count("commerce_order", "brand_id=$1", [A.brand_id]), N_ORDERS);
  });

  log("measuring");
  await t.step("dashboard order window uses the (brand_id, source_created_at) index", async () => {
    const sql = `select id, net_sales, source_created_at from commerce_order
                  where brand_id = $1 and source_created_at >= now() - interval '60 days'
                  order by source_created_at desc limit 1000`;
    const p = await plan(sql, [A.brand_id]);
    assert(/Index (Only )?Scan.*commerce_order/.test(p) && !/Seq Scan on commerce_order/.test(p), p);
    results.order_page_plan = p.split("\n")[0];
    results.order_first_page_ms = (await timed(() => w.rows(sql, [A.brand_id]))).ms;
  });

  await t.step("current dashboard pattern (page-through + sum in app) vs one SQL aggregate", async () => {
    // Mirrors frontend fetchAll(): 1000-row pages with OFFSET over the 2x30-day window.
    const pageThrough = async () => {
      let total = 0, rows = 0, pages = 0;
      for (let off = 0; ; off += 1000) {
        const page = await w.rows<any>(`select net_sales from commerce_order where brand_id = $1 and source_created_at >= now() - interval '60 days'
                                          order by source_created_at desc limit 1000 offset ${off}`, [A.brand_id]);
        pages++;
        rows += page.length;
        for (const r of page) total += Number(r.net_sales);
        if (page.length < 1000) break;
      }
      return { total, rows, pages };
    };
    const aggregate = () => w.rows<any>(`select count(*)::int rows, sum(net_sales)::bigint total from commerce_order
                                          where brand_id = $1 and source_created_at >= now() - interval '60 days'`, [A.brand_id]);
    const a = await timed(pageThrough);
    const b = await timed(aggregate);
    assertEquals(Number(b.result[0].total), a.result.total, "same answer");
    results.window_rows = a.result.rows;
    results.page_through = { pages: a.result.pages, ms: a.ms, note: "each page is a separate HTTP round trip in production (not included here)" };
    results.sql_aggregate_ms = b.ms;

    // Payment stats today read every payment of the brand (no date filter).
    const payPages = Math.ceil(N_PAYMENTS / 1000);
    const payAgg = await timed(() => w.rows<any>(`select status, method, count(*), sum(amount_minor) from commerce_paymentattempt
                                                   where brand_id = $1 group by 1, 2`, [A.brand_id]));
    results.payment_stats = { current_pattern_pages: payPages, sql_aggregate_ms: payAgg.ms };
  });

  await t.step("fetchAll's 50,000-row cap truncates totals beyond that size", async () => {
    const [{ n }] = await w.rows<any>("select count(*)::int n from commerce_paymentattempt where brand_id = $1", [A.brand_id]);
    results.fetchall_cap_note = n >= 50_000 ? `brand has ${n} payments: fetchAll(cap=50000) would stop at 50000 and under-report` : `below cap (${n})`;
  });

  await t.step("reconciliation + data quality at volume", async () => {
    const r = await timed<any>(() => w.admin.rpc("reconcile_brand", { p_brand_id: A.brand_id }), 1);
    assertEquals(r.result.error, null, JSON.stringify(r.result.error));
    results.reconcile_first_run_ms = r.ms;
    results.reconcile_summary = r.result.data;
    const r2 = await timed<any>(() => w.admin.rpc("reconcile_brand", { p_brand_id: A.brand_id }), 1);
    results.reconcile_second_run_ms = r2.ms;
    assertEquals(r2.result.data.new_payment_links, 0, "idempotent at volume");
    const dq = await timed<any>(() => w.admin.rpc("run_data_quality_checks", { p_brand_id: A.brand_id }), 1);
    assertEquals(dq.result.error, null, JSON.stringify(dq.result.error));
    results.data_quality_ms = dq.ms;
    results.data_quality_open = dq.result.data.open;
  });

  await t.step("reconciliation lookups and queues use their indexes", async () => {
    const p1 = await plan("select id from commerce_order where brand_id = $1 and order_number = $2", [A.brand_id, "1500"]);
    assert(!/Seq Scan on commerce_order/.test(p1), p1);
    const p2 = await plan("select id from commerce_paymentattempt where brand_id = $1 and merchant_order_ref = $2 and merchant_order_ref <> ''", [A.brand_id, "1500"]);
    assert(!/Seq Scan on commerce_paymentattempt/.test(p2), p2);
    const p3 = await plan("select status from commerce_reconciliation where brand_id = $1 and entity_type = 'payment' and status = 'NEEDS_REVIEW'", [A.brand_id]);
    assert(!/Seq Scan on commerce_reconciliation/.test(p3), p3);
    results.index_plans = { order_number: p1.split("\n")[0], merchant_ref: p2.split("\n")[0], reconciliation: p3.split("\n")[0] };
  });

  await t.step("customer metrics for one customer", async () => {
    const [{ id }] = await w.rows<any>("select customer_id as id from commerce_order where brand_id=$1 and customer_id is not null limit 1", [A.brand_id]);
    const r = await timed(() => w.rows<any>("select * from commerce_customer_metrics where customer_id = $1", [id]));
    assert(r.result[0].order_count >= 1);
    results.customer_metrics_one_ms = r.ms;
  });

  console.log(JSON.stringify(results, null, 2));
  const out = Deno.env.get("PERF_OUT");
  if (out) await Deno.writeTextFile(out, JSON.stringify(results, null, 2));
  await w.close();
}});
