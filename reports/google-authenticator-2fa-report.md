# Google Authenticator / TOTP Two-Factor Report (Phase 4)

*2026-11-21. Implementation: Django (`backend/apps/accounts/{views,services,models}.py`), UI in `/settings`, `/mfa-setup`, `/mfa-challenge`. Tested with pyotp-generated codes (the same RFC 6238 algorithm Google Authenticator uses) in the Django suite, and in a real Chrome against the isolated stack with an independent Node HMAC-SHA1 TOTP implementation. **No secret, QR payload or OTP value appears in this report or in test output.***

> A phone camera scan of the QR code could not be performed in this environment. Instead, the provisioning URI inside the QR was validated (`otpauth://totp/<issuer>:<email>?secret=…&issuer=…`) and codes were derived from that exact secret, which is equivalent to what the app does after scanning. A manual phone scan is listed as a remaining step.

## 1. Status summary

| Area | Status | Notes |
|---|---|---|
| QR generation | **PASS** | PNG data URL; valid `otpauth://totp` URI with issuer + account; unique secret per enrollment |
| QR scanning (physical phone) | **BLOCKED** | needs a human with a phone (see §6) |
| OTP verification | **PASS** | server-side, pyotp `valid_window=1` (±30 s) |
| 2FA enrollment | **PASS** | enabled only after a correct code; 10 single-use recovery codes |
| **Login enforcement** | **FAIL → PASS** | **was bypassed entirely** by the uncommitted Supabase login (P0-1); after the restore: password → challenge, no authenticated session until the code is verified |
| Invalid OTP rejection | **PASS** | empty / 5 / 7 digits / letters / wrong code → 400, no session |
| Replay prevention | **PASS** | same code cannot be reused (per-secret step tracking + `last_used_step`) |
| Rate limiting / brute force | **FAIL → PASS** | was IP-only (spoofable) with unlimited fresh challenges; now **per-account lockout after 10 failures for 15 min**, independent of IP |
| Recovery | **PASS** | recovery codes single-use; regenerate requires password |
| Disable | **FAIL → PASS** | required password + code, but the code had no replay protection; now uses anti-replay; unauthenticated disable → 401 |
| Re-enrollment | **FAIL → PASS** | (a) **re-running setup while enabled overwrote the confirmed secret** and the login challenge then accepted the attacker-known pending secret (P1-5); now **409** until 2FA is disabled. (b) re-enrolling within the same 30 s step was rejected (P2-10), fixed |
| Secret storage | **FAIL → PASS** | confirm step wrote the **plaintext secret** into `accounts_user.mfa_secret` (P1-6) as well as the encrypted `accounts_usermfa` row; now encrypted only (Fernet). Hosted DB: 0 rows with a plaintext secret |
| Bypass protection | **PASS (app) / FAIL (hosted DB, open)** | direct URL / API during the challenge → 401 / `/login`. **But** on the hosted DB any Supabase-authenticated user can set its own `mfa_enabled=false` or insert recovery codes via PostgREST (P0-4, fix written, not deployed) |

## 2. Enrollment (A)

| Step | Result | Evidence |
|---|---|---|
| Open security settings / request enrollment | PASS | e2e `FE-MFA-01` (QR image, secret, 6-digit input visible) |
| Unique TOTP secret | PASS | `test_each_enrollment_gets_a_unique_secret` |
| QR + valid provisioning URI | PASS | `test_provisioning_uri_and_qr_are_valid_for_authenticator_apps` (scheme, type, account, issuer, secret ≥ 16 base32 chars, PNG magic bytes) |
| Real time-based code accepted | PASS | `test_not_enabled_until_a_correct_code_is_confirmed`; e2e `FE-MFA-03` (10 recovery codes shown) |
| Enabled only after verification | PASS | `mfa_enabled` false after setup and after a wrong code; e2e `FE-MFA-02` |

## 3. OTP verification (B)

| Case | Result |
|---|---|
| Correct OTP | PASS |
| Incorrect OTP | PASS (400) |
| Expired OTP (2+ steps old) | PASS (rejected) — `TestClockSkewPolicy` (−60 s, −300 s) |
| Previous window (−30 s) | PASS (accepted, per policy) |
| Next window (+30 s) | PASS (accepted, per policy) |
| Two windows ahead (+60 s) | PASS (rejected) |
| Reused OTP | PASS (rejected) — `test_code_reuse_is_rejected` |
| Empty / invalid format | PASS (400) — 6 parametrised cases |
| Excessive attempts | PASS — 5 per challenge token; **10 per account / 15 min (new)**, holds across rotated `X-Forwarded-For` (`test_per_account_lockout_survives_ip_rotation`) |
| Expired challenge token (> 5 min) | PASS (401) |
| Another user's challenge token | PASS (rejected) |

## 4. Login with 2FA (C) — real browser, isolated stack

| Step | Result |
|---|---|
| Email + password | → `/mfa-challenge`; the only cookie is an anonymous pre-MFA session |
| Second factor required | PASS |
| Protected APIs before the code (`/api/auth/me`, `/api/w/`) | **401 / 401** |
| Direct `/dashboard` during the challenge | page shell loads, `/api/auth/me` → 401, browser ends on **`/login`**, no dashboard data rendered |
| Wrong code | stays on the challenge, error shown, `/me` still 401 |
| Browser refresh mid-flow | stays on `/mfa-challenge` |
| Correct code | → `/dashboard`, `/me` 200 |
| Refresh after login | session kept |

## 5. Security verification (E)

| Requirement | Result |
|---|---|
| QR / URI shown only during enrollment | PASS — only `setup` returns them; `status` and `me` never contain the secret or `otpauth` (`test_status_endpoint_never_returns_the_secret`) |
| Secret not in normal API responses | PASS |
| Secret encrypted at rest with a server-side key | PASS after fix — Fernet. Key = `MFA_ENCRYPTION_KEY` if set, else derived from `SECRET_KEY` (**recommend setting a dedicated `MFA_ENCRYPTION_KEY`** so `SECRET_KEY` rotation doesn't lock users out) |
| QR not stored publicly | PASS — generated in memory, returned as a data URL, never persisted |
| OTPs not logged | PASS — no logging of codes in `views.py` / `services.py` (reviewed) |
| Verification server-side | PASS |
| Frontend cannot mark 2FA enabled | PASS — `test_frontend_cannot_mark_mfa_enabled_by_itself` |
| DB flag not blindly trusted | PASS in the app (login reads the flag server-side, the challenge uses only the *confirmed* secret). **FAIL on the hosted DB** until `20261121150100` is applied — clients could flip `mfa_enabled` |
| Time-window handling | PASS — ±1 step; see §3 |
| Ciphertext with wrong key | fails closed (empty secret → rejection, not a 500) — `test_wrong_key_ciphertext_fails_closed_not_500` |

## 6. Remaining / manual

1. **Physical scan:** on staging, open Settings → Security → Enable, scan with Google Authenticator, confirm, sign out, sign in with the app's code, then try a code from 2 minutes earlier (must fail).
2. Apply `supabase/migrations/20261121150100_reassert_client_column_privileges.sql` to the hosted DB (closes the PostgREST 2FA-disable path).
3. Set `MFA_ENCRYPTION_KEY` (32-byte url-safe base64 Fernet key) in production. Existing secrets were encrypted with the `SECRET_KEY`-derived key, so either keep it unset or re-encrypt during rollout.
4. The challenge token travels in the URL query (`/mfa-challenge?challenge_token=…`). It is short-lived (5 min), single-use and useless without the TOTP, but moving it to `sessionStorage` or a POST body is recommended (P3).
5. Super-admin console: no 2FA requirement (P1-12).
6. `FE-MFA-04/05` e2e failures: the shared admin fixture stays enrolled after `FE-MFA-03`. Reseed between specs (test-isolation defect, not a product defect).

**Tests:** `backend/tests/test_mfa_hardening.py` (30, new) + `test_totp_mfa.py` + `test_auth_and_mfa.py`: **all pass**. e2e MFA: 3/5 pass (2 fixture-ordering failures). Browser 2FA login probe: 12/12 checks as expected.
