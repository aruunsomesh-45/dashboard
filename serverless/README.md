# 125 EAST Serverless Architecture (Supabase Edge Functions)

This directory contains the serverless backend architecture for 125 EAST, replacing traditional monolithic Django servers with event-driven Supabase Edge Functions running on Deno.

---

## 1. Directory Structure

```
serverless/
├── supabase/
│   ├── config.toml                 # Edge function routing & JWT verification config
│   └── functions/
│       ├── _shared/                # Modular shared utilities
│       │   ├── auth.ts             # JWT validation & workspace tenancy extraction
│       │   ├── cors.ts             # Standardized CORS headers & preflight handler
│       │   ├── crypto.ts           # AES-256-GCM Web Crypto (Django bit-compatible)
│       │   ├── logger.ts           # Redacted logging (no secrets in logs)
│       │   ├── response.ts         # Standardized JSON response envelope
│       │   └── supabase.ts         # User RLS & Admin Supabase client factory
│       ├── test-connection/        # Live API ping & validation for all 4 platforms
│       ├── shopify-sync/           # Orders, products & customers ingestion
│       ├── razorpay-sync/          # Payments & settlements ingestion
│       ├── meta-ads-sync/          # Marketing campaigns & daily ROAS insights
│       ├── instagram-sync/         # Organic media metrics & follower insights
│       ├── webhook-shopify/        # HMAC-SHA256 verified Shopify webhook handler
│       └── webhook-razorpay/       # HMAC-SHA256 verified Razorpay webhook handler
├── tests/                          # Deno test suite for crypto and integrations
├── .env.example                    # Environment secrets template
└── README.md                       # This document
```

---

## 2. Localhost Development & Serving

To run the functions locally on your development machine:

```bash
# Start local Supabase Edge Functions server
supabase functions serve --workdir serverless/supabase --env-file serverless/.env.example
```

The functions will be available at:
`http://127.0.0.1:54321/functions/v1/<function-name>`

### Available Local Endpoints:
- `POST http://127.0.0.1:54321/functions/v1/test-connection`
- `POST http://127.0.0.1:54321/functions/v1/shopify-sync`
- `POST http://127.0.0.1:54321/functions/v1/razorpay-sync`
- `POST http://127.0.0.1:54321/functions/v1/meta-ads-sync`
- `POST http://127.0.0.1:54321/functions/v1/instagram-sync`
- `POST http://127.0.0.1:54321/functions/v1/webhook-shopify?brand_id=<id>`
- `POST http://127.0.0.1:54321/functions/v1/webhook-razorpay?brand_id=<id>`

---

## 3. Deployment (When Approved)

When ready to deploy to production:

```bash
# Deploy all functions to remote Supabase project
supabase functions deploy test-connection --project-ref ybyroxyofqfpozvfedhc
supabase functions deploy shopify-sync --project-ref ybyroxyofqfpozvfedhc
supabase functions deploy razorpay-sync --project-ref ybyroxyofqfpozvfedhc
supabase functions deploy meta-ads-sync --project-ref ybyroxyofqfpozvfedhc
supabase functions deploy instagram-sync --project-ref ybyroxyofqfpozvfedhc
supabase functions deploy webhook-shopify --project-ref ybyroxyofqfpozvfedhc --no-verify-jwt
supabase functions deploy webhook-razorpay --project-ref ybyroxyofqfpozvfedhc --no-verify-jwt

# Set remote secrets
supabase secrets set --project-ref ybyroxyofqfpozvfedhc INTEGRATION_ENCRYPTION_KEY="your-secret-key"
```

---

## 4. Security & Cryptographic Compliance

- **AES-256-GCM:** 100% interoperable with tokens previously encrypted by Django.
- **Timing-Safe Webhooks:** HMAC comparison uses constant-time byte comparisons to prevent timing attacks.
- **Zero Secrets in Logs:** Automatic log sanitization redacts access tokens, passwords, authorization headers, and cookies.

---

## 5. Testing

See **[TEST_REPORT.md](./TEST_REPORT.md)** for the latest results and findings.

```bash
deno task test        # unit + isolated-database suites (PGlite built from supabase/migrations)
deno task smoke       # read-only live checks of the hosted project (deployment, auth, schema contract)
deno task test:live   # live third-party API tests; skipped unless LIVE_* credentials are set
deno task report      # everything -> tests/results/summary.json (shown at /dev/tests in `next dev`)
```

Layout: `tests/unit` (pure functions), `tests/db` (real handlers + real schema/RLS, mocked upstream APIs),
`tests/live` (real APIs, isolated DB), `tests/smoke` (hosted project), `tests/helpers` (PGlite-backed supabase-js double).

Required function secrets: `SUPABASE_SERVICE_ROLE_KEY` and `INTEGRATION_ENCRYPTION_KEY` (no fallbacks — functions fail loudly if missing).
