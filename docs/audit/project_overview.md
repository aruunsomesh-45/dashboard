# 125 East Commerce Intelligence: Project Overview

Phase 1 discovery, generated 2026-11-11. Source of truth is the code on disk. Where a planning doc and the code disagree, the code is used and the gap is noted.

## What it is
A multi-tenant commerce analytics and operations dashboard for the Indian jewellery brand 125 East (and, per the plan, other brands as a SaaS). It is meant to unify Shopify, Razorpay, a logistics provider (Shiprocket/Delhivery), Meta Ads and Instagram into one view. Money is stored as integer paise.

## Current maturity
Only **Shopify** is wired end to end (webhook, ingest, stats API, UI). Payments, Logistics and Marketing pages run on hardcoded demo data. Razorpay and Shiprocket have adapter code but no endpoints. Meta and Instagram have no adapter code. The `billing` app is empty.

## Stack
| Layer | Technology | Evidence |
|---|---|---|
| Frontend | Next.js 14.2 (App Router), React 18, TypeScript 5, Tailwind 3.4, lucide-react | `frontend/package.json` |
| Frontend auth | `@supabase/supabase-js` 2.x (email OTP and Google OAuth, PKCE) | `frontend/src/context/AuthContext.tsx` |
| Backend | Django 5.0–5.1, DRF 3.15, drf-spectacular, django-cors-headers, django-environ | `backend/requirements.txt` |
| Backend auth | Django sessions and CSRF, Argon2 hashing, TOTP MFA (pyotp), recovery codes | `apps/accounts` |
| Async | Celery 5.4 configured; broker and result backend point at Redis | `config/celery.py`, `.env` keys |
| Cache and sessions | django-redis if `REDIS_URL` set, otherwise LocMem and DB sessions | `settings/base.py` |
| Database | PostgreSQL 16 targeted (Supabase and docker-compose). **Actual local DB is SQLite.** | `.env` scheme=sqlite |
| Crypto | AES-256-GCM for integration credentials, key derived from `SECRET_KEY` | `integrations/crypto.py` |
| Quality | pytest, pytest-django, ruff (py312, line length 120) | `pytest.ini`, `pyproject.toml` |
| Python | 3.12.10 in `.venv` | observed |

## Repository layout
```
125east/
  appflow/        planning docs (phase guides, build plan, calculations.md)
  backend/        Django project: config/ (settings, urls, celery), apps/, tests/, db.sqlite3
  frontend/       Next.js app (src/app pages, context, lib, components)
  infra/          docker-compose.yml (Postgres 16, Redis 7 only)
  supabase/       10 SQL migrations (schema, RLS, auth trigger, perf functions)
  docs/database/  5 DB phase docs
  db.sqlite3      stray root-level SQLite file (0 usage found; backend/db.sqlite3 is the real one)
```
Not a git repository (no `.git`).

## Entry points
- Backend: `backend/manage.py` (dev settings `config.settings.dev`), `config/wsgi.py`, `config/asgi.py`, Celery app `config/celery.py`.
- Frontend: `npm run dev` on port 3000. `next.config.mjs` rewrites `/api/*` to `http://127.0.0.1:8000/api/*`.
- API docs: `/api/docs/` (Swagger), `/api/schema/`, `/admin/`.

## Local state observed (read-only)
- `pytest`: **29 passed** in about 5s (dev settings, SQLite).
- SQLite DB: 2 users, 2 workspaces, 3 brands, 460 orders, 25 customers, 3 integrations, 18 webhook events, 27 migrations applied. Payments, shipments, products, alerts, facts: empty.
- Docker and Node are installed. Whether Docker containers are running was not checked.

## Unknowns and inaccessible systems
- The hosted Supabase project (schema state, whether migrations are applied, auth provider config, RLS behaviour). Not accessed.
- Whether a real Shopify store, Razorpay account, Shiprocket account or Meta app are connected. Credentials are encrypted in the DB and were not decrypted.
- Production hosting and deployment target. No Dockerfile, CI config or hosting config exists in the repo.
- Contents of `backend/.env` and `frontend/.env.local` values (deliberately not read; only key names and URL schemes).
- Whether Redis and Celery workers are running locally.
- Browser behaviour of the frontend (not run in this phase).
