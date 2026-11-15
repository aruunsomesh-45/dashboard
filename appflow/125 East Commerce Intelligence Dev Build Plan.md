# 125 East Commerce Intelligence: Dev Build Plan

Nov 10, 2026 · @dev

## Overview

Build it as a multi-tenant SaaS in 5 phases, security first: tenant isolation and auth ship before any live store data touches the system. Business, pricing and GTM sections of the PRD are ignored here; this is the engineering path only.

**What you're building:** one dashboard that pulls Shopify, Razorpay, Meta Ads, Instagram and a logistics API per brand, normalises it, computes defined metrics, and raises alerts. A workspace (customer company) owns many brands; users only see brands they're members of.

### Stack (from PRD, kept)

| Layer | Tech | Notes |
| --- | --- | --- |
| Frontend | Next.js (App Router) + TypeScript, TanStack Query, Recharts, Tailwind | Talks only to your Django API, never to providers |
| Backend | Django + DRF, modular monolith | One app per domain: accounts, tenancy, integrations, commerce, analytics, alerts, billing |
| DB | PostgreSQL 16 | RLS on every tenant table |
| Jobs/cache | Celery + Redis | Separate queues: webhooks, sync, analytics, notifications |
| Infra | Docker, AWS ap-south-1 (Mumbai): RDS, ElastiCache, ECS Fargate or a single VM to start | India region for data residency |
| Monitoring | Sentry + structured JSON logs (workspace\_id on every line) |  |

### Repo layout (monorepo)

```
125east-ci/
  apps/web/            # Next.js
  backend/
    config/            # settings: base, dev, prod
    apps/accounts/     # users, auth, MFA
    apps/tenancy/      # workspace, brand, membership, RLS middleware
    apps/integrations/ # adapter base + shopify/, razorpay/, meta_ads/, instagram/, logistics/
    apps/commerce/     # canonical orders, payments, shipments
    apps/analytics/    # metric catalogue, fact tables, metric API
    apps/alerts/
    apps/billing/
  infra/               # docker-compose, Dockerfiles, terraform later
  .github/workflows/   # CI
```

### Phase map

| Phase | Goal | Exit gate |
| --- | --- | --- |
| 1. Foundation | Repo, CI, tenancy, auth, MFA, RBAC | Users sign in with MFA and only see their workspaces |
| 2. Data core | Canonical model, RLS, integration framework, Shopify | Shopify data syncs for one brand, isolation tests pass |
| 3. Connectors | Razorpay, logistics, Meta Ads, Instagram | All 5 sources sync with health status |
| 4. Analytics + UI | Metric engine, dashboard, source pages | Overview + 4 source pages on real data |
| 5. Ops + SaaS launch | Order search, alerts, hardening, billing, onboarding | Pilot on 125 East, then open to other brands |

Rule from the PRD worth tattooing: build every phase on dummy data first, connect live accounts only after isolation, secrets and backup tests pass.

## Phase 1: Foundation, tenancy and auth

Goal: a logged-in, MFA-protected user lands in a workspace and switches only between brands they're allowed to see. No provider data yet.

### 1.1 Project setup

1. Monorepo, `docker-compose.yml` with postgres, redis, backend, worker, beat, web.
2. Django settings split (base/dev/prod), all secrets from env vars. Use `django-environ`. Never commit `.env`.
3. CI on every PR: ruff + mypy, pytest, eslint + tsc, `pip-audit` / `npm audit`, gitleaks secret scan.
4. Three envs from day one: local, staging, prod. Separate databases and separate provider apps per env.

### 1.2 Tenancy models

| Model | Key fields | Rule |
| --- | --- | --- |
| User | id (UUID), email, is\_active | Custom user model, set before first migration |
| Workspace | id, name, slug, plan, status | Tenant boundary |
| WorkspaceMember | user, workspace, role (owner/admin/analyst/viewer), status | Unique (user, workspace) |
| Brand | workspace, name, timezone, currency | Belongs to exactly one workspace |
| BrandMember | user, brand, permissions | Optional narrower access |
| Invite | workspace, email, role, token\_hash, expires\_at | Store hash only, single use, 72h expiry |
| AuditLog | workspace, actor, action, target, ip, at | Append only |

Use UUIDs for every public ID so IDs can't be guessed or enumerated.

### 1.3 Authentication

- **Email + password:** Argon2 hashing, min 10 chars, breached-password check (HaveIBeenPwned k-anonymity API), email verification required.
- **Google sign-in:** OpenID Connect via `django-allauth`. Match on verified email only.
- **MFA:** TOTP (allauth MFA or `django-otp`), 10 one-time recovery codes stored hashed. Enforce MFA for Owner/Admin; let workspace owners enforce it for all.
- **Sessions:** server-side sessions in Redis, `HttpOnly`, `Secure`, `SameSite=Lax` cookies, CSRF on. Rotate session ID on login and MFA. Idle timeout 30 min, absolute 7 days. "Log out all devices" button.
- Put frontend and API on the same parent domain (`app.` and `api.`) so cookies work without storing tokens in localStorage.
- **Rate limit** login, MFA, password reset, invite endpoints (`django-ratelimit` or DRF throttles in Redis). Lock after repeated MFA failures.

### 1.4 Authorisation (the core rule)

The backend never trusts a workspace or brand ID from the client. Flow per request:

1. URL carries the slug: `/api/w/{workspace_slug}/b/{brand_id}/...`
2. Middleware loads the WorkspaceMember for `request.user` + slug. No row = 404 (not 403, so you don't leak existence).
3. Checks brand belongs to that workspace and the user has brand access.
4. Sets `request.tenant = (workspace_id, brand_ids_allowed, role)`.
5. DRF permission classes check role per action (e.g. only Owner/Admin manage integrations and billing).
6. Every queryset goes through a `TenantManager` that filters by `request.tenant`. Never use `Model.objects.all()` in views.

### 1.5 Frontend

Login, signup, verify email, MFA setup (QR) and challenge, recovery codes page, workspace + brand switcher, members and invites page, empty dashboard shell with the PRD palette (ivory surfaces, forest green nav, terracotta highlights).

### Exit gate

- [ ] Pytest proves user A gets 404 on every workspace B endpoint
- [ ] MFA enforced for admins, recovery codes work once
- [ ] Audit log records login, MFA change, invite, role change
- [ ] CI blocks merge on failing tests or leaked secrets

## Phase 2: Data core, RLS and Shopify

Goal: the canonical data model is locked down by Postgres RLS, a reusable connector framework exists, and Shopify syncs for one brand.

### 2.1 Canonical data model

Every table has `workspace_id`, `brand_id`, `provider`, `provider_id`, `source_created_at`, `source_updated_at`, `ingested_at`. Unique key: `(brand_id, provider, provider_id)`.

| Table | Holds |
| --- | --- |
| raw\_payload | Original JSON from provider, for replay and audits (retain 90 days) |
| customer, product, variant | Shopify catalogue and buyers |
| order, order\_line | Shopify orders, money as integer paise + currency code |
| payment\_attempt | Razorpay payments (many per order) |
| refund, dispute, settlement | Separate entities, never merged |
| shipment, tracking\_event | Logistics, many shipments per order |
| order\_payment\_link, order\_shipment\_link | Explicit link tables with `match_method` (e.g. razorpay\_order\_id, awb) and `confidence` |
| ads\_insight\_daily, ig\_account\_snapshot, ig\_media\_insight | Marketing data with level, attribution window, currency |

Money: always integer minor units, never floats. Time: store UTC, convert to brand timezone only for reporting.

Composite foreign keys `(workspace_id, brand_id, id)` so a link row can never join an order from brand A to a payment from brand B.

### 2.2 Row-level security

1. Two DB roles: `migrator` (owns tables, runs migrations) and `app_user` (`NOBYPASSRLS`, not owner). The app connects only as `app_user`.
2. On every tenant table: `ENABLE` + `FORCE ROW LEVEL SECURITY`, policy `USING (workspace_id = current_setting('app.workspace_id')::uuid)`.
3. Middleware opens a transaction per request (`ATOMIC_REQUESTS=True`) and runs `SET LOCAL app.workspace_id = ...`. `SET LOCAL` dies with the transaction, so it's safe with PgBouncer in transaction mode.
4. Celery tasks take `workspace_id` + `brand_id` as args, re-validate them, and set the same context before touching data.
5. Missing setting = zero rows, not an error that falls back to everything.

RLS is the safety net; the app-level `TenantManager` from Phase 1 stays. Two locks, not one.

### 2.3 Integration framework

One base class every provider implements:

```python
class ProviderAdapter:
    def get_auth_url(self, state): ...
    def exchange_code(self, code) -> Credentials: ...
    def refresh(self, creds) -> Credentials: ...
    def backfill(self, since) -> Iterator[RawRecord]: ...
    def incremental(self, cursor) -> Iterator[RawRecord]: ...
    def verify_webhook(self, headers, body) -> bool: ...
    def normalize(self, raw) -> list[CanonicalRecord]: ...
```

Supporting tables: `Integration` (brand, provider, status, scopes, encrypted credentials, token\_expires\_at), `SyncRun` (start, end, records, errors), `SyncCursor` (per resource checkpoint), `WebhookEvent` (provider, event\_id UNIQUE, received\_at, processed\_at).

**Secrets:** envelope encryption. A data key per integration encrypts tokens (AES-256-GCM); the master key lives in AWS KMS, never in the DB or repo. Support key rotation and "disconnect" which deletes the credentials. Tokens never reach the browser.

**OAuth:** signed `state` param bound to the user session + workspace + brand to stop CSRF and cross-tenant connects.

**Webhooks:** endpoint verifies signature on the raw body first, stores the event, returns 200 fast, processes in Celery. Dedupe on event ID. Handle out-of-order events by comparing `source_updated_at` before overwriting.

**Sync jobs:** idempotent upserts (`ON CONFLICT DO UPDATE`), exponential backoff with jitter, respect provider rate-limit headers, checkpoint after each page. Webhooks for freshness + a nightly reconciliation pull to catch missed events.

### 2.4 Shopify connector

- Create a Shopify Partner app (public app if other brands will install it). Scopes: `read_orders`, `read_all_orders` (for history beyond 60 days, needs approval), `read_products`, `read_customers`, `read_analytics`.
- Apply for **Protected Customer Data** access early: names, emails, phones need approval. Store only the PII you need.
- Backfill with GraphQL Admin API **bulk operations**; incremental with `updated_at` cursors.
- Webhooks: `orders/create`, `orders/updated`, `orders/cancelled`, `refunds/create`, `fulfillments/create`, `fulfillments/update`, `app/uninstalled`, plus the 3 mandatory GDPR webhooks. Verify `X-Shopify-Hmac-Sha256`.
- Sessions/conversion rate come from ShopifyQL analytics; validate availability on your plan before promising the metric.

### 2.5 Dummy data

A `seed_demo` management command that generates 2 workspaces, 3 brands, 6 months of fake orders, payments, shipments and ad data. All UI work in Phase 4 can run on this.

### Exit gate

- [ ] Isolation test: raw SQL as `app_user` with workspace A context returns zero rows of B
- [ ] Shopify backfill + webhooks run for 125 East on staging, re-running sync creates no duplicates
- [ ] Integration tokens encrypted at rest, verified by inspecting the DB
- [ ] Forged webhook (bad HMAC) rejected and logged

## Phase 3: Remaining connectors

Goal: Razorpay, logistics, Meta Ads and Instagram plug into the Phase 2 framework, each with its own adapter, status mapping and sync health. Start the Meta app review on day 1 of this phase; it is the slowest dependency.

### 3.1 Razorpay (payments)

- Auth: per-brand API key + secret entered by the owner (encrypted), or Razorpay partner OAuth if you want one-click connect later.
- Pull: payments, refunds, disputes, settlements, with `from`/`to` pagination.
- Webhooks: `payment.captured`, `payment.failed`, `refund.processed`, `dispute.*`, `settlement.processed`. Verify `X-Razorpay-Signature` (HMAC SHA256 with webhook secret).
- **Linking to Shopify:** match on the Shopify transaction's gateway reference (Razorpay payment ID) or Razorpay `order_id`/`notes`. Never match on name or amount alone (PRD rule). Unmatched payments go to an "unlinked" bucket, visible in UI.
- Success rate denominator: document which states count (exclude `created` attempts that never reached checkout).

### 3.2 Logistics

- Pick the provider 125 East actually uses (likely Shiprocket or a similar aggregator) and build one adapter; the interface lets you add more later.
- Pull shipments + tracking events, subscribe to status webhooks/push if offered.
- Normalise every carrier status into one enum:

| Canonical status | Meaning |
| --- | --- |
| created | Shipment booked |
| pickup\_pending | Awaiting pickup |
| in\_transit | Moving in network |
| out\_for\_delivery | Last mile |
| delivered | Proof of delivery |
| ndr | Failed attempt, needs action (store reason code) |
| rto\_initiated / rto\_delivered | Return to origin, tracked separately |
| cancelled | Voided |

Keep a `status_map` table (provider\_status to canonical) so new codes don't need a deploy. Unknown codes raise an alert, not a crash.

- Link to orders via AWB on the Shopify fulfillment's tracking number.

### 3.3 Meta Ads (paid)

- Create a Meta app, Facebook Login for Business, permission `ads_read` (plus `business_management` for account listing). Needs Business Verification + App Review for other brands to connect.
- Pull Insights at campaign, ad set and ad level, daily granularity. Always store: level, `action_attribution_windows`, account currency, action\_type. Never sum reach across campaigns.
- Use async report jobs for large date ranges; respect `x-business-use-case-usage` rate headers.
- User tokens expire (about 60 days for long-lived); track `token_expires_at`, warn the owner 7 days ahead, show "reconnect" status.
- Re-pull the last 28 days nightly; Meta restates conversions after the fact.

### 3.4 Instagram (organic)

- Instagram Graph API for professional accounts, through the same Meta app. Validate exact scopes and fields against the current API version before building (PRD flags this).
- Daily account snapshot (followers) to compute growth, since history isn't returned retroactively. Start snapshots as early as possible.
- Media list + per-post/Reel insights; audience demographics only as aggregates and only where the API returns them.
- Store in separate tables from Meta Ads. UI must never add organic reach to paid reach.

### 3.5 Integration health

Settings page per brand: each connector's status (connected, syncing, error, token expiring, disconnected), last successful sync, records synced, last error message (sanitised, no secrets), "sync now" and "disconnect" buttons.

### Exit gate

- [ ] All 5 sources sync for 125 East on staging, re-runs are duplicate-free
- [ ] Order detail shows Shopify order + N payment attempts + N shipments correctly linked
- [ ] Meta app review submitted (or approved)
- [ ] Expired or revoked token shows a clear status, never stale data labelled as fresh

## Phase 4: Analytics engine and dashboard

Goal: every metric in the PRD catalogue is computed from canonical data by a versioned formula, served by one metrics API, and shown on the overview + source pages. No AI, just SQL/Python (PRD).

### 4.1 Metric catalogue

A `MetricDefinition` table seeded from code (a YAML/py file in the repo, so changes are reviewed in PRs). Fields per PRD: key, display name, source, description, formula\_id, formula\_version, unit, currency behaviour, date grain, dimensions, refresh cadence, attribution basis, unavailable-data behaviour.

Each formula is a Python function, unit tested with fixed inputs. Example: `aov_v1 = net_sales / eligible_orders`. Changing a formula = new version, old one kept for audit.

### 4.2 Aggregation layer

1. Daily fact tables per brand, keyed by brand-local date: `fact_shop_daily`, `fact_payment_daily`, `fact_ads_daily`, `fact_ig_daily`, `fact_shipment_daily`.
2. A Celery task recomputes only the affected dates after each sync (incremental, not full rebuild).
3. Range metrics are computed from facts; ratio metrics are recomputed from sums (never average the daily ratios).
4. Unique metrics (customers, reach) can't be summed from days: compute from base tables or use provider's range value.
5. All-brands view: aggregate only brands the user can access; if currencies differ, show per currency, don't silently convert.

### 4.3 Metrics API

`GET /api/w/{ws}/metrics?keys=net_sales,aov&brand=..&from=..&to=..&compare=previous_period`

Returns per metric: value, comparison value and % change, daily series for the sparkline, source, currency, formula version, `last_synced_at`, freshness (fresh / stale / partial / unavailable). Cache in Redis with key `ws:{id}:brand:{id}:metric:{key}:{range}:v{n}`; bust on sync completion.

### 4.4 Frontend pages (match PRD screens)

| Page | Contents |
| --- | --- |
| Overview | Owner-selected KPI cards (reorder/hide, saved per user), revenue trend, platform summaries, alerts panel |
| Shopify | Orders, gross/net sales, AOV, conversion, returning rate, top products/variants |
| Marketing | Tabs: Meta Ads (spend, CTR, CPC, CPM, ROAS labelled Meta-attributed, level selector) and Instagram organic (followers, reach, engagement, top content) |
| Payments | Success rate, failures by reason, pending age, refunds, disputes, settlements |
| Logistics | Status funnel, delayed, NDR, RTO, delivery time median + mean |
| Settings | Brands, members, integrations health, metric definitions viewer |

Every card shows: value, comparison, trend, source, last updated, currency, and a definition tooltip. Global date picker in brand timezone. Responsive down to mobile.

Use TanStack Query for fetching, Recharts for charts, `dnd-kit` for card reordering. Keep all API calls through one typed client generated from the DRF OpenAPI schema (`drf-spectacular` + `openapi-typescript`).

### Exit gate

- [ ] Every metric has a unit test with hand-calculated expected values
- [ ] Overview numbers for 125 East match Shopify admin / Razorpay dashboard within documented differences
- [ ] Cache keys verified tenant-scoped (test: two workspaces, same range, different results)
- [ ] Stale or failed sources show a warning badge, never silent old numbers

## Phase 5: Orders, alerts, hardening and SaaS launch

Goal: ops features that make it daily-useful, then the security hardening and billing that make it sellable to other brands.

### 5.1 Order search and detail

- Search by Shopify order number, Razorpay payment ID, AWB/tracking ID, customer email/phone (exact match on a hashed or normalised column). Postgres `pg_trgm` index is enough at this scale; no Elasticsearch.
- Order detail = one timeline: order created, each payment attempt, refunds, each shipment and its tracking events, with source and link confidence on every row.
- Respect the PRD rule: one order can have many payments and many shipments. Never assume 1:1.

### 5.2 Alerts engine (deterministic)

| Rule | Trigger example |
| --- | --- |
| Payment success drop | Success rate below threshold over last N hours |
| Stuck payment | Pending older than X minutes |
| Delayed shipment | Past expected delivery, not delivered |
| Open NDR / RTO spike | NDR count or RTO rate above threshold |
| Sync stale | Source not synced in N hours |
| Token expiring | Integration token expires within 7 days |

Each alert has a `dedupe_key` (rule + brand + entity), state (open / acknowledged / resolved), who acknowledged, and a link to the source records. Rules run as Celery beat tasks; thresholds editable per brand. Notify via email first; WhatsApp/Slack later.

### 5.3 Exports

CSV exports generated in a Celery job, stored in S3 under `workspace_id/brand_id/` prefixes, downloaded via short-lived signed URLs, logged in audit log.

### 5.4 Hardening

- Automated tenant-isolation suite: for every endpoint, search, export, cache key and Celery task, prove user A cannot reach B. Run in CI.
- Security headers: HSTS, strict CSP, `X-Frame-Options: DENY`, no CORS wildcard.
- Dependency scanning (Dependabot), container image scanning, OWASP ZAP baseline scan on staging.
- Backups: RDS automated backups + point-in-time recovery. Do a real restore drill to a fresh DB and document the time it took.
- Logging: structured logs, never log tokens, PII redacted. Sentry with PII scrubbing.
- Load test the metrics API with k6 at, say, 10x 125 East's order volume.
- Get an external pentest before onboarding outside brands.

### 5.5 SaaS layer

- **Billing:** `apps/billing` with Plan (limits: brands, integrations, members, history days), Subscription, UsageCounter. Provider TBD per PRD; Razorpay Subscriptions fits Indian customers, Stripe if you go global. Webhook-driven status, enforce limits in the backend.
- **Onboarding wizard:** create workspace, add brand (timezone, currency), connect Shopify, then others, invite team.
- **Data lifecycle:** workspace deletion purges all tenant data and credentials within a set window; retention policy for raw payloads; handle Shopify GDPR webhooks.
- **Compliance:** India's DPDP Act 2023 applies: privacy policy, purpose limitation, deletion on request, breach notification process. Get a lawyer to review before public launch.
- **Platform admin:** internal staff panel (Django admin locked behind VPN/IP allowlist + MFA), with every staff access to tenant data audit-logged.

### 5.6 Rollout

1. Pilot on 125 East only, live data, 2 weeks of daily use.
2. Fix metric definition mismatches found against Shopify/Razorpay dashboards.
3. Onboard 2 to 3 friendly brands, watch sync health and support load.
4. Open signups.

### Exit gate

- [ ] Isolation suite green in CI, pentest findings fixed
- [ ] Restore drill done and timed
- [ ] A second brand onboards itself end to end without your help
- [ ] Billing limits enforced server side

## Security checklist (applies to every phase)

If any box is unchecked, the phase isn't done.

- [ ] Tenant derived from membership on the server, never from client input
- [ ] Two isolation locks: app-level TenantManager + Postgres RLS with a non-owner, NOBYPASSRLS role
- [ ] Composite tenant FKs on all link tables
- [ ] Every cache key, Celery task, S3 path, export and log line carries workspace\_id + brand\_id
- [ ] Provider tokens envelope-encrypted with KMS, never sent to the browser, rotatable, deleted on disconnect
- [ ] Webhook signatures verified on raw body, event IDs deduplicated, out-of-order safe
- [ ] OAuth state signed and bound to user + workspace + brand
- [ ] MFA enforced for Owner/Admin, recovery codes hashed, sessions rotated on login
- [ ] Rate limits on auth, invite, export, sync-now endpoints
- [ ] Audit log on logins, role changes, integration connect/disconnect, exports, staff access
- [ ] Money in integer minor units, time in UTC, metrics show currency + timezone + freshness
- [ ] Backups tested by an actual restore
- [ ] Secrets only in env/Secrets Manager, gitleaks in CI
