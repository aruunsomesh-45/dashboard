# Feature Inventory

Status key: **Live** = backed by real API or data; **Demo** = hardcoded front-end data; **Partial** = mixed; **Missing** = referenced but absent.

## 1. Pages (13 routes)
| # | Route | Purpose | Data source | Status |
|---|---|---|---|---|
| 1 | `/` Overview | KPI cards across Shopify, Meta, Delhivery, Razorpay, Instagram | `shopify/stats` for Shopify; rest are hardcoded defaults | Partial |
| 2 | `/pnl` P&L Statement | Profit waterfall (CM1) | `shopify/stats` plus assumed cost ratios | Partial |
| 3 | `/integrations` Connect Apps | Connect and status cards for 5 providers | Brand integrations list; "connect" simulated with `setTimeout`; sync calls `sync-now` | Partial |
| 4 | `/shopify` Shopify Store | Sales metrics, order funnel, paginated order feed, sync button | `shopify/stats`, `integrations`, `sync-now` | Live |
| 5 | `/marketing` Marketing & Ads | Campaign table | `DEMO_CAMPAIGNS` constant | Demo |
| 6 | `/payments` Payments | Payment attempts | `DEMO_PAYMENTS` constant | Demo |
| 7 | `/logistics` Logistics | Shipments and NDR | `DEMO_SHIPMENTS` constant | Demo |
| 8 | `/team` Team & Access | Member list, create invite link | `GET members`, `POST invites` | Live |
| 9 | `/settings` | Brand profile, webhook URLs, tenant info | Auth context only | Partial |
| 10 | `/mfa-setup` | TOTP enrolment, QR, recovery codes | `/api/auth/mfa/setup`, `/confirm` | Live (needs Django session) |
| 11 | `/login` | Email OTP and Google sign-in | Supabase Auth | Live |
| 12 | `/register` | Sign-up with org name via OTP or Google | Supabase Auth plus DB trigger | Live |
| 13 | `/auth/callback` | PKCE and token-hash exchange | Supabase Auth | Live |

Missing routes the code refers to: `/invites/accept` (the invite URL the API returns, and `AuthContext` marks `/invites*` public) and `/mfa-challenge` (listed as public in `AuthContext`). Neither page exists.

Shell: `DashboardShell` (sidebar with workspace switcher, brand switcher, 9 nav items, MFA link, sign out; header with a static "Last 30 Days" label).

## 2. API endpoints (Django)
Base: `/api`. Auth is Django session unless noted. CSRF is enforced on unsafe methods except the webhook.

| Method | Path | Auth / permission | Purpose |
|---|---|---|---|
| GET | `/` | none | Health JSON (redirects browsers to Swagger) |
| GET | `/api/schema/`, `/api/docs/` | none | OpenAPI, Swagger UI |
| GET | `/admin/` | staff | Django admin |
| GET | `/api/auth/csrf` | none | Set CSRF cookie |
| POST | `/api/auth/register` | none | Create user (min 10 chars, HIBP check) |
| POST | `/api/auth/login` | none | Password login; returns `mfa_required` or user and workspaces |
| POST | `/api/auth/mfa/challenge` | none (pre-MFA session) | TOTP or recovery code |
| POST | `/api/auth/mfa/setup` | session | Generate secret and QR |
| POST | `/api/auth/mfa/confirm` | session | Enable MFA, return recovery codes |
| POST | `/api/auth/logout` | session | Logout |
| GET | `/api/auth/me` | session | User, workspaces, brands |
| GET, POST | `/api/w/` | session | List or create workspace (creator is owner; default brand) |
| POST | `/api/w/invites/accept` | session | Accept invite by token |
| GET | `/api/w/{slug}/` | member | Workspace detail and brands |
| GET, POST | `/api/w/{slug}/brands/` | member / admin for POST | Brands |
| GET | `/api/w/{slug}/members/` | admin | Members |
| POST | `/api/w/{slug}/invites/` | admin | Create 72h single-use invite; token returned once |
| GET | `/api/w/{slug}/b/{brand}/integrations/` | member | Integration status |
| GET | `/api/w/{slug}/b/{brand}/shopify/stats/` | member | Aggregates, funnel, keyset-paginated orders; 5 min cache |
| POST | `/api/w/{slug}/b/{brand}/shopify/sync-now/` | member | **Stub**: flips status, clears cache, no Shopify call |
| GET | `/api/w/{slug}/b/{brand}/metrics/` | member | Metric formulas; includes simulated inputs |
| GET | `/api/w/{slug}/alerts/` | member | Alerts (status filter, last 50) |
| POST | `/api/w/{slug}/alerts/{id}/acknowledge/`, `/resolve/` | member | Alert state changes |
| POST | `/api/webhooks/shopify/{brand_id}/` | none, HMAC | Shopify webhook ingest |

Not present although planned: Razorpay and logistics webhooks, OAuth connect and callback endpoints, orders search, CSV export, payments and shipments APIs, billing, audit-log read endpoint.

## 3. Key workflows
1. **Sign-up and sign-in (as built in UI):** Supabase OTP or Google -> `/auth/callback` -> `AuthContext` loads profile, memberships and brands straight from Supabase tables -> dashboard.
2. **Sign-in (backend-native):** register -> login -> optional MFA challenge -> session cookie. The UI does not use it.
3. **Workspace creation:** shell modal -> `POST /api/w/` -> owner membership, default brand, audit log.
4. **Team invite:** admin creates invite -> link `/invites/accept?token=...` -> `POST invites/accept`. Supabase trigger also auto-accepts pending invites by email on sign-up.
5. **Shopify order sync:** webhook -> HMAC -> dedupe -> thread -> canonical order -> cache bust -> UI shows on next stats load.
6. **MFA enrolment:** setup -> scan QR -> confirm code -> recovery codes.
7. **Alert triage:** list -> acknowledge -> resolve (no producer of alerts found).

## 4. Metric catalogue (`analytics/catalogue.py`)
`revenue_per_day`, `blended_roas`, `blended_cac`, `delivery_success_pct`, `orders_to_be_shipped`, `number_of_disputes`, `organic_engagement`, `aov`, `cm1_profit`. Inputs are real only for Shopify order sums. COGS (32% of net), ad spend (24% of net, or a fixed fallback), gateway fee (2%), freight (6.5%), follower count and engagements are constants in the view.

## 5. Integrations
| Provider | Adapter | Webhook | OAuth | Sync | UI |
|---|---|---|---|---|---|
| Shopify | Yes (normalise order, customer, product; HMAC) | Yes | URL builder only; `exchange_code` is a placeholder | Stub | Live |
| Razorpay | Yes (HMAC, normalise payment) | No | n/a | No | Demo |
| Shiprocket | Yes (status map; webhook check only requires a non-empty `X-Api-Key`) | No | n/a | No | Demo |
| Meta Ads | No (`FactAdsDaily` model only) | No | No | No | Demo |
| Instagram | No | No | No | No | Demo |

## 6. Dependency list
- **Backend (pinned ranges):** Django, djangorestframework, django-environ, django-cors-headers, psycopg[binary], redis, django-redis, celery, argon2-cffi, pyotp, qrcode, pillow, cryptography, drf-spectacular, pytest, pytest-django, ruff.
- **Frontend:** next, react, react-dom, @supabase/supabase-js, tailwindcss, tailwind-merge, clsx, lucide-react, typescript, postcss, autoprefixer.
- **Docs claim but not installed:** TanStack Query, Recharts (README and master index mention them; `package.json` does not list them).
- **Infra:** Postgres 16-alpine, Redis 7-alpine (docker-compose); Supabase hosted.

## 7. Observations for Phase 2 to verify (not yet tested)
Listed so testing can target them. None are confirmed defects yet.

| # | Observation | Where |
|---|---|---|
| 1 | No bridge between Supabase login and Django session; business API calls may return 403 after a Supabase-only login | `AuthContext.tsx`, `settings/base.py` |
| 2 | `InviteAcceptView` never checks that `invite.email` matches the accepting user, so any signed-in holder of a token gets the invited role | `tenancy/views.py` |
| 3 | Alert acknowledge, resolve and `sync-now` need only membership, so a viewer can run them; ack and resolve also ignore brand restrictions | `alerts/views.py`, `integrations/views.py` |
| 4 | `RLSMiddleware` is not in `MIDDLEWARE`; local DB is SQLite, so RLS is untested | `settings/base.py` |
| 5 | Webhook runs processing in a daemon thread, not Celery; no retry survives a restart | `shopify/views.py` |
| 6 | Webhook `event_id` fallback uses a millisecond timestamp, and `event_id` is globally unique across brands | `shopify/views.py`, `integrations/models.py` |
| 7 | `days` and `limit` query params parse with `int()` and no guard on `limit` (ValueError gives 500); negative `days` gives odd windows | `integrations/views.py` |
| 8 | Login has no throttling or lockout; MFA challenge has no attempt limit | `accounts/views.py` |
| 9 | `mfa_secret` stored in plaintext on `User` | `accounts/models.py` |
| 10 | `get_client_ip` trusts `X-Forwarded-For` | `accounts/views.py` |
| 11 | Shiprocket `verify_webhook` accepts any non-empty header | `logistics/adapter.py` |
| 12 | Migration 001 hardcodes a password for the `app_user` DB role | `supabase/migrations/..._001` |
| 13 | `to_minor_units` truncates beyond 2 decimals and returns 0 on parse error (silent data loss) | `shopify/adapter.py` |
| 14 | Order ingest compares `source_updated_at` between orders only after the customer upsert, and lines are deleted and recreated each update | `shopify/service.py` |
| 15 | Money display in `metrics` divides paise by 100 and formats with a hardcoded rupee sign regardless of brand currency | `analytics/views.py` |
| 16 | Two schema sources (Django migrations and Supabase SQL) can drift; `billing_subscription` exists only in SQL | repo-wide |
| 17 | Frontend lists unbuilt routes; `alert()` is used for errors in the shell | `DashboardShell.tsx` |
| 18 | README paths and stack claims are out of date (`apps/web/`, TanStack Query, Recharts) | `README.md` |
