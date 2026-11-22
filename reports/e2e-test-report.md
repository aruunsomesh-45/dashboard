# Frontend & End-to-End Test Report (Phase 12)

*2026-11-21. Framework: the repo's existing Playwright suite (`e2e/`, Chrome channel, desktop). Stack: **isolated** copies (Next production build on :3100 with `DISABLE_BACKEND_FALLBACK=true` → Django on :8011, fresh SQLite, `e2e/seed_e2e.py` synthetic data; `.env` files excluded from the copies). Supabase calls are mocked by the suite. The owner's dev servers (:3000/:8001, wired to the production DB) were not used for E2E.*

Command (after creating the isolated stack):
`cd e2e && set E2E_BASE_URL=http://localhost:3100 && npx playwright test`

## 1. Results

| Spec | Passed | Failed |
|---|---:|---:|
| `01-auth` (register, login, logout, guards, reset, mobile/tablet auth pages) | 19 | 0 |
| `02-shell-navigation` | 5 | 7 |
| `03-dashboards` (Shopify, overview, P&L) | 10 | 9 |
| `04-integrations-team` | 3 | 10 |
| `05-demo-pages-settings-mfa` (marketing, payments, logistics, settings, MFA) | 17 | 7 |
| `06-layout-routing` (5 desktop viewports, refresh, direct nav, CSRF, cross-tenant) | 25 | 1 |
| `07-auth-redirect-safety` (open-redirect suite) | 27 | 0 |
| **Total** | **106** | **34** |

First attempt: 47 passed / 93 failed. Every failure was the helper's Django login being rejected with 403, because `page.request` sends no `Origin`/`Referer` and Django applies strict HTTPS Referer checking behind the proxy's `X-Forwarded-Proto: https`. Fixed in `e2e/tests/helpers.ts` by sending the same headers a browser does. Real browsers always send `Origin` on POST, so this is not a product defect.

Additional browser probes (scratch scripts, not part of the suite):
- **Before the auth restore** (owner's dev server, Supabase + `/api` intercepted): a 2FA user's login skipped the second factor, and a fresh browser bounced back to `/login`. See `authentication-test-report.md`.
- **After the restore** (isolated stack): the 12-step 2FA login journey behaved as expected, and the direct-URL bypass ended on `/login` with no data. See `google-authenticator-2fa-report.md`.

## 2. Failure triage (34)

### A. Harness / test drift: not product defects (12)
| Test | Cause |
|---|---|
| `FE-SHOP-01`, `FE-OVR-01`, `FE-PNL-01` | test source holds a mis-encoded rupee sign (`â‚¹67,716`). The API returns exactly 6,771,600 paise = ₹67,716 for the seeded brand (verified with curl) |
| `FE-NAV-08` | expects a Supabase `/auth/v1/logout` call (from the pre-Django era). The property that matters (server session invalid after logout, old cookie → 401) was verified separately: PASS |
| `FE-NAV-12` | scenario ("Supabase table read failure") no longer applies: the shell no longer reads Supabase tables |
| `FE-MFA-04`, `FE-MFA-05` | `FE-MFA-03` leaves the shared admin fixture enrolled in 2FA, so later logins get `mfa_required`. Reseed between specs |
| `FE-SHOP-07` | `sync-now` returns 400 because the seeded Shopify credentials are synthetic (no live Shopify); the error is shown correctly |
| `FE-SET-03` | asserts the Shopify webhook URL is not 404. The backend deliberately answers 404 for a brand without a *connected* integration (anti-enumeration) |
| `FE-MKT-01` | heading copy changed ("Active Meta Ad Campaigns" not present) |
| `FE-INT-01`, `FE-INT-02` | the Integrations page was rewritten in the uncommitted work (716 lines changed); selectors (5 `h3` cards, "Configure" modal) no longer match |

### B. Product defects / gaps (13)
| Test | Defect | Severity |
|---|---|---|
| `FE-SHOP-11` | **static "+18.4 %" growth on KPI cards even with zero orders** (fabricated) | P2 |
| `FE-SHOP-09`, `FE-OVR-03`, `FE-PNL-04` | an API 500 leaves an empty dashboard instead of an error message | P2 |
| `FE-TEAM-06` | members API failure shows an empty list, not an error | P2 |
| `FE-RTE-07` | with the backend down, at least one dashboard page shows no connection error | P2 |
| `FE-LOG-05`, `FE-LOG-06` | NDR re-attempt: success / failure feedback not shown | P2 |
| `FE-SHOP-06` | no control to load orders beyond the first page (API supports a keyset cursor) | P3 |
| `FE-NAV-10` | "Date: Last 30 Days" chip is static text, not a control | P3 |
| `FE-NAV-11` | user with no workspace gets no usable empty state | P3 |
| `FE-SET-04` | brand profile is read-only in Settings | P3 |
| `FE-INT-07` | card status shows 3 matches where 1 was expected; may be the redesign or a real status-mapping issue (not root-caused) | P3 |

### C. Not root-caused: timeouts (9)
`FE-NAV-04`, `FE-NAV-06`, `FE-NAV-07` (workspace dropdown / create-workspace modal), `FE-INT-03`, `FE-INT-04`, `FE-INT-06` (integration card forms), `FE-TEAM-03`, `FE-TEAM-04`, `FE-TEAM-05` (invite modal). All are interactions inside UI that changed in the uncommitted work (`DashboardShell.tsx` +102 lines, Integrations rewrite). Some use `confirm()` / `alert()` dialogs, which stall headless runs. **Recommendation:** open the traces in `<scratch>/e2e_artifacts` (`npx playwright show-trace`) before relying on these flows.

## 3. Coverage of the requested journey

| # | Step | Status |
|---|---|---|
| 1–4 | Open, register, workspace created, log in | PASS |
| 5–7 | Enable Google Authenticator, QR, complete 2FA | PASS (enroll `FE-MFA-01..03`; login-with-2FA browser probe) |
| 8–9 | Dashboard, settings | PASS |
| 10–13 | Connect Shopify / Razorpay / Meta / Instagram | PARTIAL: save-credentials flow covered by `FE-INT-04` (timeout); connection tests need a Supabase JWT (P1-13); live creds invalid |
| 14 | Run sync | PARTIAL: Shopify `sync-now` reaches the backend; live sync BLOCKED |
| 15–17 | Orders, customers, analytics | PASS (orders/analytics); customers are shown inside orders only |
| 18 | Inventory | page loads; **feature not implemented** |
| 19–24 | Influencer, campaign, UTM link, tracked click, attributed order, analytics | **BLOCKED: not implemented** |
| 25–28 | Logout, protected pages, log back in, session behaviour | PASS |

Also: refresh / direct navigation ✓ (11 routes); desktop layouts at 1024 → 2560 px ✓; mobile/tablet only for auth pages ✓ (**dashboard pages untested on mobile**); empty states partial (B); error states failing (B); filters/search ✓ (payments, logistics); pagination ✗ (`FE-SHOP-06`); no missing chunks or hydration crashes observed in the passing specs (`06-layout-routing` asserts no page errors).
