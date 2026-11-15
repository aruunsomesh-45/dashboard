# 125 East Commerce Intelligence (125east-ci)

Enterprise-grade multi-tenant e-commerce intelligence & operations platform unifying Shopify, Razorpay, Logistics, Meta Ads, and Instagram Organic into a single real-time dashboard.

## Architecture

- **Frontend:** Next.js (App Router), TypeScript, Tailwind CSS, TanStack Query, Recharts (`apps/web/`)
- **Backend:** Django 5.x + Django REST Framework modular monolith (`backend/`)
- **Database:** PostgreSQL 16 with Row-Level Security (RLS)
- **Job Queues & Cache:** Celery + Redis 7
- **Infra:** Docker Compose (`infra/`)

## Quickstart

### 1. Start Infrastructure
```bash
docker compose -f infra/docker-compose.yml up -d
```

### 2. Activate Virtual Environment
```bash
# Windows
.venv\Scripts\activate
```

### 3. Run Migrations & Start Server
```bash
cd backend
python manage.py makemigrations accounts tenancy
python manage.py migrate
python manage.py runserver
```

## Documentation & Learning Roadmap
Detailed phase guides and architectural explanations are available in:
- [`appflow/phases/00_MASTER_INDEX.md`](./appflow/phases/00_MASTER_INDEX.md)
- [`appflow/phases/01_PHASE_1_FOUNDATION_TENANCY_AUTH.md`](./appflow/phases/01_PHASE_1_FOUNDATION_TENANCY_AUTH.md)
- [`appflow/phases/02_PHASE_2_DATA_CORE_RLS_SHOPIFY.md`](./appflow/phases/02_PHASE_2_DATA_CORE_RLS_SHOPIFY.md)
- [`appflow/phases/03_PHASE_3_CONNECTORS_ECOSYSTEM.md`](./appflow/phases/03_PHASE_3_CONNECTORS_ECOSYSTEM.md)
- [`appflow/phases/04_PHASE_4_ANALYTICS_METRICS_ENGINE.md`](./appflow/phases/04_PHASE_4_ANALYTICS_METRICS_ENGINE.md)
- [`appflow/phases/05_PHASE_5_OPS_ALERTS_SAAS_LAUNCH.md`](./appflow/phases/05_PHASE_5_OPS_ALERTS_SAAS_LAUNCH.md)
- [`appflow/phases/06_BACKEND_DEVELOPER_PLAYBOOK.md`](./appflow/phases/06_BACKEND_DEVELOPER_PLAYBOOK.md)
