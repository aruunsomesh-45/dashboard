# Backend Developer Playbook & Daily Engineering Habits

## Overview
This playbook contains the day-to-day development workflows, commands, and best practices to follow while building the backend for **125 East Commerce Intelligence**.

---

## 1. Daily Development Commands

Ensure your Docker environment is up and running before starting local work:

```bash
# 1. Start all infrastructure services (Postgres, Redis)
docker compose up -d db redis

# 2. Run Django local development server
python manage.py runserver 0.0.0.0:8000

# 3. In a separate terminal, run Celery worker with debugging
celery -A config worker -l info -Q webhooks,sync,analytics,default

# 4. In a separate terminal, run Celery Beat for scheduled jobs
celery -A config beat -l info
```

---

## 2. The Multi-Tenant Pytest Test Pattern

Every time you write a test, you should write it using reusable pytest fixtures that simulate multi-tenant boundaries.

Create `tests/conftest.py`:

```python
import pytest
from apps.accounts.models import User
from apps.tenancy.models import Workspace, WorkspaceMember, Brand

@pytest.fixture
def workspace_a(db):
    ws = Workspace.objects.create(name="125 East Apparel", slug="125-east")
    return ws

@pytest.fixture
def workspace_b(db):
    ws = Workspace.objects.create(name="Competitor Retail", slug="competitor")
    return ws

@pytest.fixture
def user_a(db, workspace_a):
    user = User.objects.create_user(email="owner@125east.com", password="SecurePassword123!")
    WorkspaceMember.objects.create(user=user, workspace=workspace_a, role=WorkspaceMember.Role.OWNER)
    return user

@pytest.fixture
def brand_a(db, workspace_a):
    return Brand.objects.create(workspace=workspace_a, name="Apparel", currency="INR")
```

Now, write isolation tests with ease:

```python
# tests/test_tenant_isolation.py
def test_user_cannot_access_other_workspace(client, user_a, workspace_b):
    client.force_login(user_a)
    # Attempting to access Workspace B endpoints must return 404, NOT 403
    response = client.get(f"/api/w/{workspace_b.slug}/metrics/")
    assert response.status_code == 404
```

---

## 3. OpenAPI Schema Generation for Your AI Frontend

To make sure your AI frontend builder (or agent generating Next.js pages) always has 100% accurate TypeScript interfaces, use `drf-spectacular`:

```bash
# Generate the latest OpenAPI 3.0 schema YAML/JSON from your Django views
python manage.py spectacular --file schema.yml

# In apps/web, generate TypeScript types automatically
npx openapi-typescript ../backend/schema.yml -o ./src/types/api.ts
```

This guarantees that:
- You never write manual TypeScript interfaces for API payloads.
- If you change a field in Django, the frontend types update instantly.

---

## 4. The 5-Point Checklist for Every New Endpoint

Before committing any new Django API endpoint:
1. **URL check:** Does the route start with `/api/w/{workspace_slug}/` or `/api/w/{workspace_slug}/b/{brand_id}/`?
2. **Permission check:** Is `request.tenant` verified by `TenancyMiddleware`?
3. **Queryset check:** Is the query filtered using `Model.objects.for_tenant(request.tenant.workspace)` or scoped to `brand_id`?
4. **Money / Date check:** Are currencies stored as minor units (paise) and timestamps parsed in UTC?
5. **Pytest check:** Is there an isolation test proving another user gets a 404?
