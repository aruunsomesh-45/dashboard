# Security test work: what was changed and what it found

Three new test suites were written for the Django backend (`backend/`). **No application code was changed.**
Where a test fails, the application is missing the protection; each such failure is listed below as a bug to fix.

## Files changed

| File | Change |
|---|---|
| `backend/tests/test_auth.py` | New. 56 tests: registration, email verification, login, throttling, MFA, recovery codes, sessions, CSRF, passwords. |
| `backend/tests/test_org_control.py` | New. 248 tests: role x endpoint matrix, role changes, MFA gate, invites, brand restriction, plan limits. |
| `backend/tests/security/test_webhooks.py` | New. 126 tests across Shopify, Razorpay, Shiprocket, Meta. |
| `backend/tests/security/__init__.py` | New, empty (makes the folder a package). |
| `backend/tests/conftest.py` | Appended `user_factory` and `mfa_user_factory` fixtures. Existing fixtures untouched. |
| `backend/requirements.txt` | Added `freezegun>=1.5.0` (used for token and invite expiry tests). |

## How to run

The tests need real Postgres, because row-level security does not work on SQLite. `backend/.env` currently points at SQLite, so set a Postgres URL first:

```
cd backend
DATABASE_URL=postgres://<user>:<pw>@localhost:5432/commerce_intel pytest tests/test_auth.py tests/test_org_control.py tests/security
```

During this work Docker was not running and the local Postgres password did not match `.env`, so a throwaway Postgres 18 cluster was used (now stopped). The spec says Postgres 16; nothing in the tests depends on the minor version.

## Results

| Suite | Tests | Pass | Fail |
|---|---|---|---|
| `test_auth.py` | 56 | 40 | 16 |
| `test_org_control.py` | 248 | 184 | 64 |
| `security/test_webhooks.py` | 126 | 33 | 93 |

The rest of the existing suite: 89 pass, 1 fails (see "Pre-existing failure").

Each passing protection was checked by removing it in memory and confirming the matching tests then fail (admin check on brand creation, owner-only workspace delete, brand restriction, webhook signature comparison). A scanner test for `==` on signatures is itself tested against known-bad and known-good code.

## Bugs found: authentication (`test_auth.py`)

1. **Register enumerates users.** New email gets 201 with the user object, existing email gets 400 "already exists".
2. **No email verification.** New users are created active, no email is sent, no verify endpoint or token exists.
3. **Auth throttle is 10/min, not 5.** `THROTTLE_AUTH` defaults to `10/min`, so the 6th failed login and MFA challenge are not blocked.
4. **TOTP codes can be replayed.** A code that was just accepted works again.
5. **Pending MFA state never expires.** A challenge 5 min 1 s after the password step still succeeds.
6. **No CSRF check on login, register or MFA challenge.** DRF only enforces CSRF for already-authenticated sessions.
7. **Common passwords accepted.** `RegisterSerializer` does not run `AUTH_PASSWORD_VALIDATORS`; it depends on the HaveIBeenPwned lookup, which fails open offline.

Passing: identical login errors and comparable timing, inactive users refused, recovery codes (10, SHA-256 only, single use), session rotation on login and MFA, logout destroys the session, CSRF on all 15 session-authenticated state-changing routes, Argon2 in prod settings, 10-char minimum.

## Bugs found: organisation control (`test_org_control.py`)

1. **No member role-change or removal endpoint.** `PATCH`/`DELETE /api/w/{ws}/members/{id}/` returns 404, so none of these rules can be enforced: admin cannot promote to owner, admin cannot touch an owner, nobody changes their own role, last owner is protected.
2. **No MFA gate.** Owners and admins reach every workspace route with a password-only session or a plain Bearer token; nothing returns 403 `mfa_required`.
3. **Invites:**
   - an admin can invite as owner
   - anyone logged in can accept an invite sent to a different email
   - expiry is 72 hours, not 7 days
4. **No plan limits.** A starter workspace gets a 2nd brand, a 4th member (pending invites are not counted) and a 3rd integration; nothing returns 402.
5. **Brand restriction leaks.** `GET /api/w/` and `GET /api/auth/me` list brands the user is not assigned to, and restricted analysts can acknowledge or resolve another brand's alerts.
6. **Viewers can acknowledge and resolve alerts** (the tests assume viewers are read-only).

Passing: 98 of the other matrix cells (every other route, role and method with exact status), a guard that fails when a new `/api/w/` route has no matrix row, invite tokens hashed and single-use, expired invites refused, 404 on all 15 brand endpoints for a restricted user, and no brand leak through metrics, alert lists or the brand lists on `/{ws}/` and `/{ws}/brands/`.

## Bugs found: webhooks (`security/test_webhooks.py`)

- **Shiprocket and Meta webhooks do not exist** (no route), so all their tests fail with 404. That accounts for 67 of the 93 failures.
- **No enqueue on commit.** Shopify and Razorpay process inline; nothing reaches `process_webhook_event_task`, so "1 processing per replayed event" cannot be shown.
- **Razorpay dedupe is global.** One tenant sending an event id another tenant later uses causes the second tenant's real event to be dropped as `duplicate`. Shopify scopes by brand.
- **Disconnected integrations still answer.** 200 with the secret retained, 401 when credentials were wiped; the spec says 404.
- **Shopify ignores `X-Shopify-Shop-Domain`.** A wrong, suffix-trick or missing domain with a valid HMAC returns 200.
- **No body size limit.** Signed bodies over 1 MB return 200 instead of 413.
- **Malformed JSON returns 500** on Shopify, and non-object JSON (`[1,2,3]`) returns 500 on both views; the spec says 400.
- **Shopify logs no warning on a rejected request.** Razorpay does.

Passing: Shopify and Razorpay reject wrong, missing, tampered and other-tenant signatures with 401 and store nothing; secrets and signatures are not persisted; every signature check uses `compare_digest`.

## Pre-existing failure (not caused by this work)

`tests/test_no_fabricated_data.py::TestNoDebugBypass::test_dev_tokens_rejected_in_debug` fails, including when run alone. With `DEBUG=True`, `Bearer dev-mock-token` authenticates as the first user in the database (`apps/accounts/authentication.py`).

## Assumptions the tests make

These are also written at the top of each test file; change them there if the implementation chooses differently.

**Auth**
- Email verification: `POST /api/auth/verify-email/ {"token": ...}` activates the account; the email body contains `token=<token>`; tokens last at most 7 days.
- Logout: the old cookie is rejected with 401 or 403 (the API answers unauthenticated requests with 401).

**Organisation control**
- Member routes: `PATCH` takes `{"role": ...}`; `DELETE` returns 204.
- Last owner: removing or demoting the last owner returns 409.
- Viewers cannot acknowledge or resolve alerts.
- MFA gate: 403 `{"code": "mfa_required"}`; a Bearer token counts as verified only with the claim `aal=aal2`. Implementing the gate will also break existing tests that call `client_for(owner)`.
- Invites: a wrong-email accept returns 404, an expired invite returns 400.
- Starter plan: 1 brand, 3 members (pending invites count), 2 integrations. Re-saving credentials for an already-connected provider is not a new integration.

**Webhooks**
- URLs: `/api/webhooks/{shopify|razorpay|shiprocket|meta}/<brand uuid>/`; the Meta handshake is a GET on the same URL.
- Credential keys: Shopify `api_secret`, Razorpay `webhook_secret`, Shiprocket `webhook_token` (sent in `X-Api-Key`), Meta `app_secret` and `verify_token` with `X-Hub-Signature-256: sha256=<hex>`.
- Statuses the brief left open: failed Meta handshake is 403, Shopify domain mismatch is 401, and the signature is checked before the body is parsed.
- Shiprocket has no tampered-body test, because a static token does not cover the body.
