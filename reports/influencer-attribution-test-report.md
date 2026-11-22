# Influencer & UTM Attribution Test Report (Phase 11)

*2026-11-21.*

## Verdict: **NOT IMPLEMENTED: all functional checks BLOCKED**

`frontend/src/app/influencer/page.tsx` is a static page. There are **no** tables, APIs, functions or scripts for influencers, campaigns, tracking links, UTM generation, click tracking, click IDs, attribution windows, attributed orders or commissions anywhere in the repository (`grep -ri "influencer\|utm\|click_id"` over `backend/apps`, `serverless/supabase`, `supabase/migrations` matches only the module catalogue row and comments).

| Check | Result |
|---|---|
| Influencer creation | BLOCKED: not implemented |
| Campaign creation | BLOCKED: not implemented |
| Unique tracking-link creation | BLOCKED: not implemented |
| UTM parameter generation | BLOCKED: not implemented |
| Click tracking / unique click ID | BLOCKED: not implemented (no redirect endpoint, no click table) |
| Attribution persistence | BLOCKED: not implemented |
| Shopify checkout/order correlation | BLOCKED: no `note_attributes` / landing-site / discount-code correlation in order ingestion |
| Attribution window, first/last touch | BLOCKED: not implemented |
| Duplicate order prevention | n/a (order ingestion itself is idempotent ✓) |
| Refund / cancellation handling for commissions | BLOCKED: not implemented |
| Commission & revenue calculations | BLOCKED: not implemented |
| Influencer dashboard analytics | BLOCKED: not implemented |
| Journey: tracking URL → landing → click-ID persistence → checkout → order → webhook → attribution → DB → dashboard | BLOCKED: no step after "landing page" exists |

## Defect found and fixed

**P1-8: fabricated metrics.** The page displayed "Active Creators 18 / 5 campaigns live", "Coupon Revenue ₹4,82,500 / +24.5 % vs last month" and "Blended ROAS 4.2x / top performer 6.8x" as if they were live. They were replaced with "—" values and the notice *"Tracking links, click attribution and commissions are not implemented in this version. Nothing on this page reflects real creator sales."*

## Minimum viable design (for when it is built)

1. Tables: `influencer`, `influencer_campaign`, `tracking_link(slug unique, campaign_id, destination_url, utm_*)`, `link_click(click_id uuid pk, link_id, ts, ip_hash, ua_hash)`, `attributed_order(order_id unique, click_id, model, commission_minor, status)`, all with `workspace_id` / `brand_id` + RLS.
2. `GET /r/<slug>` (Edge Function): insert a click, set a first-party `_125c` cookie, 302 to the destination with UTMs **and** `?_125c=<click_id>`.
3. Shopify: persist the click id into the cart attribute (theme snippet or checkout extension). On `orders/create`, read `note_attributes._125c` (fallback: discount code ↔ campaign) → `attributed_order` inside the existing idempotent webhook pipeline.
4. `orders/cancelled` / refunds → reverse the commission; the attribution window is checked against the click timestamp.
5. Tests: missing click id, expired window, repeated clicks (last-touch), multiple influencers, duplicate webhook (unique `order_id`).
