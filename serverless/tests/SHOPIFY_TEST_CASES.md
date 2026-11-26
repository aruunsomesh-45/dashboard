# Shopify connection: test cases

Status key: **PASS** = run and passing · **MANUAL** = needs your store and credentials (run once after you save them).

## A. Automated (run with `deno test -A tests/db/shopify_token.test.ts tests/db/functions_sync.test.ts`)

| ID | Case | Steps | Expected | Status |
|---|---|---|---|---|
| S-01 | Sync exchanges Client ID and secret for a token | Save Client ID and secret; run sync; Shopify token endpoint answers with a token | Token request sent as `client_credentials` with the right ID and secret; orders request uses the new token; order saved | PASS |
| S-02 | Each sync renews the token | Run sync twice, with a different token each time | The second run requests a new token and uses it | PASS |
| S-03 | Rejected Client secret | Token endpoint answers 400 with JSON error | Sync fails with 401 "rejected the Client ID or Client secret"; card shows the error; run marked failed | PASS |
| S-04 | Unknown Client ID | Token endpoint answers with the "application_cannot_be_found" error page | Sync fails with 401 "does not recognise this Client ID…" | PASS |
| S-05 | Connection test with new fields | Test button, Client ID and secret, shop check | Card shows Connected; the shop check uses the fresh token | PASS |
| S-06 | Legacy token still works | Stored `shpat_` token, no Client ID | Sync uses the stored token (existing behaviour) | PASS |
| S-07 | `shpss_` pasted as the token | Stored value starts with `shpss_` | Clear hint: the secret was pasted into the token box | PASS |
| S-08 | Paging stays on Shopify | Link header points to another host | Not followed; token never sent elsewhere | PASS |
| S-09 | Invalid token from an API call | Orders request answers 401 | Sync fails with 502; card shows the error | PASS |
| S-10 | Network failure during sync | Shopify unreachable | Failed result, not an unhandled crash | PASS |
| S-11 | Webhook verification uses the Client secret | Signed order webhook; secret = saved client secret | Accepted and stored; unsigned or wrong-signature refused with 401 | PASS (existing webhook suite) |

Full server suite: 29 of 29 test files passing.

## B. Live checks already run

| ID | Check | Result |
|---|---|---|
| L-01 | Store `qwqrk9-d0.myshopify.com` reachable | PASS (HTTP 302, redirects to the admin login) |
| L-02 | Token endpoint answers a placeholder Client ID | PASS. Shopify returns an HTML error "application_cannot_be_found", which the code now reports clearly |
| L-03 | Edge functions refuse unauthenticated calls (`shopify-sync`, `test-connection`) | PASS (401) |

## C. Manual: run these once with your real values

| ID | Steps | Expected | Result |
|---|---|---|---|
| M-01 | Connect Apps → Shopify → **Disconnect**. Then enter Store Domain, Client ID and Client Secret (`shpss_`). Click **Save & Connect**. | "Credentials encrypted & stored" | ☐ |
| M-02 | Click **Test** | Card shows **Connected** and the shop name | ☐ |
| M-03 | Click **Sync** | Message with orders created or updated; the Shopify Store page shows orders | ☐ |
| M-04 | Wait for the next scheduled run (every 15 minutes), or Sync again the next day | Still Connected; no 401 | ☐ |
| M-05 | Shopify admin → Settings → Notifications → Webhooks → send a test notification | Event appears in the dashboard; no signature error | ☐ |
| M-06 | Enter a wrong Client Secret, click Test | Card shows the rejection reason; no data changed | ☐ |
| M-07 | Restore the correct secret, Save & Connect, Test | Connected again | ☐ |

## What is not covered yet
- The live token exchange with your real Client ID and secret (needs M-01 first).
- Shopify's webhook signing for webhooks created in the admin (confirm with M-05).
