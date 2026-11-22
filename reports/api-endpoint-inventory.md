# API Endpoint Inventory

*2026-11-21. Sources: `backend/config/urls.py`, `backend/apps/*/urls.py`, `frontend/src/app/api/**/route.ts`, `serverless/supabase/functions/*`, `serverless/supabase/config.toml`.*

Legend. **Auth**: `S` = Django session cookie (+ CSRF on unsafe methods); `J` = Supabase JWT (Bearer); `SA` = Supabase JWT + `accounts_user.is_superuser` (checked server-side with the service role); `H` = provider HMAC signature; `—` = public. **Role**: minimum workspace role enforced server-side.

## 1. Django (via Next proxy `/api/*`)

### 1.1 Health / docs
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/`, `/api/health` | — | JSON health, or a redirect to Swagger for browsers |
| GET | `/api/schema`, `/api/docs` | — | OpenAPI 3 / Swagger UI. **Publicly exposed** (P3: hide in production) |
| * | `/admin/` | Django admin login | Not proxied by Next (only `/api/*` is) |

### 1.2 Authentication — mounted at `/api/auth/`, `/api/v1/auth/` (and the MFA subset at `/api/security/`, `/api/v1/security/`)
| Method | Path | Auth | Throttle | Behaviour |
|---|---|---|---|---|
| GET | `csrf/` | — | — | Sets the `csrftoken` cookie |
| POST | `register/` | CSRF | auth 5/min/IP | Creates user + workspace + owner + brand atomically; Django password validators (min 10, common, numeric, similarity) + HIBP |
| POST | `login/` | CSRF | auth | No 2FA → session. 2FA on → `{mfa_required, challenge_token}`, **no session** |
| POST | `mfa/challenge/`, `mfa/verify/` | CSRF + challenge token or pre-MFA session | auth + **per-account lockout (new)** | TOTP ±1 step, anti-replay; recovery code accepted |
| POST | `mfa/recovery/` | CSRF + challenge | auth + lockout | Single-use recovery code |
| POST | `mfa/setup/` | S | auth (new) | Returns secret, `otpauth://` URI, QR PNG. **409 when 2FA is already on (new)** |
| POST | `mfa/confirm/` | S | auth (new) | Enables 2FA after a valid code; returns 10 recovery codes |
| POST | `mfa/disable/` | S | auth (new) + lockout | Password + fresh TOTP (anti-replay, new) or recovery code |
| GET | `mfa/status/` | S | — | `is_enabled`, `is_pending`, unused recovery-code count. Never the secret |
| POST | `mfa/recovery-codes/regenerate/` | S | auth (new) | Password required |
| POST | `logout/` | S | — | Deletes the server session |
| GET | `me/` | S | — | User (now incl. read-only `is_superuser`) + workspaces/brands |
| POST | `password-reset/` | CSRF | auth | Always the same 200 body (no account enumeration) |
| POST | `password-reset/confirm/` | CSRF | auth | Single-use signed token, 2 h |

### 1.3 Tenancy — `/api/w/`
| Method | Path | Auth | Role |
|---|---|---|---|
| GET/POST | `/api/w`, `/api/w/` | S | any member / authenticated (create) |
| POST | `/api/w/invites/accept/` | S | invitee |
| GET/PATCH/DELETE | `/api/w/<slug>/` | S | member / admin / owner |
| GET/POST | `/api/w/<slug>/brands/` | S | member / admin |
| GET | `/api/w/<slug>/members/` | S | member |
| PATCH/DELETE | `/api/w/<slug>/members/<uuid>/` | S | admin (owner rules enforced) |
| POST | `/api/w/<slug>/invites/` | S | admin |
| GET | `/api/w/<slug>/alerts/` | S | member |
| POST | `/api/w/<slug>/alerts/<uuid>/{acknowledge,resolve}/` | S | analyst+ |

### 1.4 Brand-scoped data — `/api/w/<slug>/b/<brand_uuid>/…`
| Method | Path | Auth | Role | Data source |
|---|---|---|---|---|
| GET/POST/DELETE | `integrations/` | S | member / admin | `integrations_integration` (credentials encrypted, never returned) |
| GET | `shopify/stats/`, `shopify/intelligence/` | S | member | `commerce_order` (cancelled orders now excluded from sales) |
| POST | `shopify/sync-now/` | S | admin, throttle sync 6/min | Shopify Admin REST |
| GET | `marketing/stats/` | S | member | `analytics_factadsdaily` |
| POST | `marketing/sync-now/` | S | admin, throttle sync | Meta Graph |
| GET | `metrics/` | S | member | metric catalogue |
| GET | `payments/stats/`, `payments/transactions/` | S | member | `commerce_paymentattempt` |
| GET | `logistics/summary/`, `logistics/shipments/`, `logistics/track/<awb>/` | S | member | `commerce_shipment` |
| POST | `logistics/ndr/<awb>/action/` | S | analyst+, throttle ndr 20/min | Delhivery |

### 1.5 Inbound webhooks — `/api/webhooks/<provider>/<brand_uuid>/`
| Method | Provider | Auth | Notes |
|---|---|---|---|
| POST | `shopify` | H (`X-Shopify-Hmac-Sha256`, base64) + `X-Shopify-Shop-Domain` must match | Dedupe key `shopify:<brand>:<X-Shopify-Webhook-Id or body hash>` |
| POST | `razorpay` | H (`X-Razorpay-Signature`, hex) | Dedupe on `X-Razorpay-Event-Id` |
| POST | `meta` | GET verify token + `X-Hub-Signature-256` | |
| POST | `shiprocket` | `x-api-key` token | |
| POST | `delhivery` | — | Returns **501** (not implemented, honest) |

## 2. Next.js route handlers

| Method | Path | Auth | Notes |
|---|---|---|---|
| ALL | `/api/[[...path]]` | passes cookies through | Proxy to Django. **Fallback to a hardcoded tunnel now limited to GET/HEAD/OPTIONS**; `DISABLE_BACKEND_FALLBACK=true` turns it off |
| GET | `/api/modules/effective` | J | Service-role RPC for the caller's own id |
| GET | `/api/super-admin/{overview,users,workspaces,integrations,webhooks,functions,database,data-flows,audit-logs,modules}` | SA | Service role; every handler calls `verifySuperAdmin` |
| GET | `/api/super-admin/users/<id>` | SA | |
| POST | `/api/super-admin/users/<id>/status`, `/api/super-admin/permissions` | SA | Writes `admin_audit_logs` |
| PATCH | `/api/super-admin/modules` | SA | |

**Gap:** no super-admin route requires a second factor (Supabase `aal2`). See the security audit.

## 3. Supabase Edge Functions — `POST {FUNCTIONS_URL}/<name>`

| Function | `verify_jwt` | Auth in code | Body | Upstream (read-only) |
|---|---|---|---|---|
| `test-connection` | true | J + membership (when `workspace_id`/`integration_id` given) | `{provider, credentials?}` or `{integration_id}` | Shopify `GET /shop.json`, Razorpay `GET /payments?count=1`, Meta `GET /act_x`, IG `GET /me` |
| `shopify-sync` | true | J + member + module `shopify` | `{workspace_id, brand_id}` | `GET /orders.json` (Link pagination, same-host only) |
| `razorpay-sync` | true | J + member + module `razorpay` | same | `GET /v1/payments` (count/skip) |
| `meta-ads-sync` | true | J + member + module `meta_ads` | same | `GET /act_x/insights` (`paging.next`, graph host only) |
| `instagram-sync` | true | J + member + module `instagram` | same | `GET /me/accounts`, IG media |
| `webhook-shopify` | **false** | H (raw bytes) | `?brand_id=<uuid>` | — |
| `webhook-razorpay` | **false** | H (raw bytes) | `?brand_id=<uuid>` | — |

CORS for all functions: `Access-Control-Allow-Origin: *`. Acceptable because authentication is a Bearer token, never cookies.

## 4. Browser → PostgREST (anon key)

Used by the super-admin pages and (until today's restore) by `AuthContext`: `tenancy_workspacemember`, `tenancy_workspace`, `tenancy_brand`, `accounts_user`, `rpc/get_user_effective_modules`. All protected by RLS. **But see `database-security-rls-report.md`: on the hosted DB the `authenticated` role has write privileges that let a user escalate on `accounts_user`.**
