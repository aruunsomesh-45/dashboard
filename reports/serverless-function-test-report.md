# Serverless Function Test Report (Phase 6)

*2026-11-21. `serverless/` was preserved (no files moved or renamed). Handlers were exercised in-process through their exported `createHandler(deps)` with a scripted `fetch` (MOCKED upstream) and a PGlite database built from the real migrations (real constraints, triggers, RLS). Command: `cd serverless && deno task test`.*

**Result: 64 tests / 120 steps passed, 0 failed** (baseline 53 passed / 7 failed). Line coverage of `supabase/functions/**`: 92.5 %.

## 1. Inventory

| Function | Method | JWT gate (`config.toml`) | In-code authN / authZ |
|---|---|---|---|
| `test-connection` | POST | yes | `requireAuth`; membership when `workspace_id`/`integration_id` given |
| `shopify-sync` | POST | yes | `requireAuth` → `requireWorkspaceAccess` (owner/admin) → `requireModuleAccess('shopify')` |
| `razorpay-sync` | POST | yes | same, module `razorpay` |
| `meta-ads-sync` | POST | yes | same, module `meta_ads` |
| `instagram-sync` | POST | yes | same, module `instagram` |
| `webhook-shopify` | POST | **no** (by design) | HMAC-SHA256 base64 over raw bytes, per-brand secret |
| `webhook-razorpay` | POST | **no** (by design) | HMAC-SHA256 hex over raw bytes, per-brand secret |

Plus 13 Next.js super-admin handlers (service role, `verifySuperAdmin` on every one) and `/api/modules/effective`. These have **no automated tests** (open).

## 2. Function-by-function matrix

✓ = tested & passing · ✗ = defect found (status in notes) · — = not applicable · ○ = not tested

| Check | test-connection | shopify-sync | razorpay-sync | meta-ads-sync | instagram-sync | webhook-shopify | webhook-razorpay |
|---|---|---|---|---|---|---|---|
| Wrong HTTP method → 405 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| CORS preflight | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| No / invalid / expired JWT → 401 | ✓ (no open proxy: 0 upstream calls) | ✓ | ✓ | ✓ | ✓ | — | — |
| Non-member → 403, foreign `integration_id` → 404 | ✓ | ✓ | ✓ | ✓ | ✓ | — | — |
| Module disabled → 403 before any upstream call | — | ✓ (new) | ○ (same code path) | ○ | ○ | — | — |
| Request validation (UUIDs, JSON object, size) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (1 MiB, brand UUID) | ✓ |
| Response envelope / status codes | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Persists to DB, idempotent re-run | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Partial failure reported as `partial`, not success | — | ✓ | ○ | ○ | ✓ (per capability) | — | — |
| Upstream 401 / expired token → 502 + integration `error` | ✓ | ✓ | ✓ | ✓ (code 190) | ✓ | — | — |
| Permission error (Meta code 200) | — | — | — | ✓ | ✓ | — | — |
| 429 → Retry-After honoured | — | ✓ | ○ | ○ | ○ | — | — |
| Timeout → 504 | — | ✓ | ○ | ○ | ○ | — | — |
| Malformed upstream JSON → 502 | — | ✓ | ✓ (missing `items`) | ○ | ○ | ✓ (400 on bad body) | ✓ |
| Pagination follows only the provider host (token never leaves) | — | ✓ | ✓ | ✓ | — | — | — |
| Secrets never in responses or logs | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| No stack trace / internal error to client | ✗ → ✓ | ✗ → ✓ | ✗ → ✓ | ✗ → ✓ | ✗ → ✓ | ✓ | ✓ |
| DB failure → error, not silent success | — | ✓ | ✓ | ✓ | ✓ | ✓ (500 so the provider retries) | ✓ |
| Duplicate delivery → no duplicate rows | — | — | — | — | — | ✓ | ✓ |
| Missing service-role key → 500 misconfiguration | ○ | ✓ | ○ | ○ | ○ | ✓ | ✓ |
| Rate limiting (per caller) | ○ | ○ | ○ | ○ | ○ | ○ | ○ |

## 3. Defects

| ID | Function(s) | Defect | Fix | Retest |
|---|---|---|---|---|
| **P0-2** | all 4 sync functions | `requireModuleAccess` crashed (`(moduleList \|\| []).find is not a function`) because the RPC returns a JSONB object → **every non-superuser sync returned 500** | `_shared/auth.ts` → `isModuleEnabled()` (object or array, fail-closed) | 30 steps fixed + `module_permissions.test.ts` |
| P3-16 | all (via `wrapHandler`) | unexpected 500s echoed `err.message` (could expose SQL/library internals) | generic `internal error` (operator "Server misconfiguration" still passed through) | `security.test.ts` |
| P2-17 | `requireModuleAccess` | RPC `get_user_effective_modules` accepted any `p_user_id` and was executable by `anon` | migration `20261121150000` (self-only unless super admin; anon revoked) | `module_permissions.test.ts` |
| open, P1-13 | all user-invoked functions | the frontend now holds a Django session, not a Supabase JWT → browser calls get 401 | Shopify/Meta fall back to Django; a test-connection/sync bridge is needed | — |
| open, P3 | all | no per-caller rate limit (relies on the Supabase platform) | add a limit for `test-connection` (it can be used to probe third-party credentials) | — |
| open, P3 | `NEXT_PUBLIC_FUNCTIONS_URL` | points at a LAN IP (`192.168.1.12:54321`); the fallback builds `http://<hostname>:54321` | set to `https://<ref>.supabase.co/functions/v1` in production | — |

## 4. Not tested / blocked

- **Deployed functions** (Supabase project): BLOCKED. No staging function URL was configured and the hosted project's function deployment state is unknown. Steps: `supabase functions deploy <name> --project-ref <ref>` (webhooks with `--no-verify-jwt`), then run `deno task smoke` against it.
- Super-admin Next handlers: authorization reviewed in code (all call `verifySuperAdmin`); no automated tests.
