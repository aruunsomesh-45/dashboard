# Phase 1: Foundation, Tenancy, and Authentication

## Overview & Goal
Build the security backbone of your SaaS. At the conclusion of this phase, a user can securely register, verify their email, sign in with Multi-Factor Authentication (TOTP), access their authorized Workspace, switch between assigned Brands, and invite teammates with distinct roles.

**Crucial Milestone:** No live store data touches this platform yet. We prove complete tenant isolation before writing a single line of connector code.

---

## 1. Core Mental Models & Concepts to Learn

### A. Why Custom User Model *Before* First Migration?
In Django, changing `AUTH_USER_MODEL` midway through a project after running initial migrations is notoriously difficult because Django's migration history deeply embeds foreign keys to `auth.User`.
- **The Rule:** Define `class User(AbstractBaseUser, PermissionsMixin)` in `apps/accounts/models.py` with `id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)` before running `python manage.py migrate` for the first time.
- **Why UUIDs?** Integer auto-incrementing IDs (`/users/1`, `/workspaces/42`) allow attackers to guess IDs and enumerate your entire customer base. UUIDv4 prevents ID enumeration.

### B. The Tenancy Hierarchy
A company (customer) is represented as a **Workspace** (the tenant isolation boundary).
- Inside a Workspace, there are one or more **Brands** (e.g., "125 East Apparel", "125 East Footwear").
- A **User** belongs to a Workspace via `WorkspaceMember` with a specific role (`owner`, `admin`, `analyst`, `viewer`).
- A user can optionally be restricted to specific Brands via `BrandMember`.

```
                    +---------------------------+
                    |    Workspace (Tenant)     |
                    +-------------+-------------+
                                  |
            +---------------------+---------------------+
            |                                           |
            v                                           v
+-----------------------+                   +-----------------------+
|  Brand 1 (e.g. Mens)  |                   | Brand 2 (e.g. Womens) |
+-----------+-----------+                   +-----------+-----------+
            |                                           |
            +---------------------+---------------------+
                                  |
                                  v
                    +---------------------------+
                    |  WorkspaceMember (Roles)  |
                    |   (Owner, Admin, Viewer)  |
                    +---------------------------+
```

### C. The "Dual-Lock" Tenancy Model (App Layer + DB Layer)
Most security breaches in multi-tenant SaaS happen when a developer forgets `.filter(workspace_id=request.workspace.id)` in an endpoint. We implement **two independent locks**:
1. **Lock 1 (App Level):** Custom `TenantManager` and `TenantQuerySet` on every model so `Model.objects.all()` is disabled in views, combined with Tenancy Middleware.
2. **Lock 2 (Database Level):** PostgreSQL Row-Level Security (detailed in Phase 2) which denies queries at the Postgres process level if the workspace ID does not match.

### D. Why Return `404 Not Found` Instead of `403 Forbidden`?
If User A requests `/api/w/competitor-workspace/dashboard` and gets `403 Forbidden`, User A now knows that `competitor-workspace` exists. If you return `404 Not Found`, no information is leaked about whether that tenant exists or not.

### E. Session Cookies vs JWTs for SaaS
For a first-party web application (Next.js talking to Django on the same domain or parent domain), **server-side sessions stored in Redis with `HttpOnly`, `Secure`, `SameSite=Lax` cookies** are vastly superior to JWTs stored in `localStorage`:
- XSS cannot steal `HttpOnly` cookies from JavaScript.
- You can revoke a session instantly (e.g., on password reset, logout, or account compromise) simply by deleting the session key from Redis.

---

## 2. Step-by-Step Implementation Guide

### Step 1: Docker & Settings Setup
Set up `docker-compose.yml` with:
- PostgreSQL 16
- Redis 7
- Django Backend
- Celery Worker & Celery Beat

Organize Django settings using `django-environ`:
```
backend/config/settings/
├── __init__.py
├── base.py       # Installed apps, middleware, password validators, DRF settings
├── dev.py        # Local debugging, CORS allow localhost:3000
└── prod.py       # Strict SSL, HSTS, Secure cookies, Sentry
```

### Step 2: Custom User & Accounts Models (`apps/accounts/`)
```python
# apps/accounts/models.py
import uuid
from django.contrib.auth.models import AbstractBaseUser, BaseUserManager, PermissionsMixin
from django.db import models

class UserManager(BaseUserManager):
    def create_user(self, email, password=None, **extra_fields):
        if not email:
            raise ValueError("Email is required")
        email = self.normalize_email(email)
        user = self.model(email=email, **extra_fields)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_superuser(self, email, password=None, **extra_fields):
        extra_fields.setdefault('is_staff', True)
        extra_fields.setdefault('is_superuser', True)
        return self.create_user(email, password, **extra_fields)

class User(AbstractBaseUser, PermissionsMixin):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    email = models.EmailField(unique=True, db_index=True)
    is_active = models.BooleanField(default=False)  # Requires email verification
    is_staff = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    
    # MFA fields
    mfa_enabled = models.BooleanField(default=False)
    mfa_secret = models.CharField(max_length=64, blank=True)  # Base32 secret for TOTP
    
    objects = UserManager()
    USERNAME_FIELD = 'email'
```

### Step 3: Tenancy Models (`apps/tenancy/models.py`)
```python
# apps/tenancy/models.py
import uuid
from django.db import models
from django.conf import settings

class Workspace(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=255)
    slug = models.SlugField(unique=True, db_index=True)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

class WorkspaceMember(models.Model):
    class Role(models.TextChoices):
        OWNER = 'owner', 'Owner'
        ADMIN = 'admin', 'Admin'
        ANALYST = 'analyst', 'Analyst'
        VIEWER = 'viewer', 'Viewer'

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name='members')
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='workspace_memberships')
    role = models.CharField(max_length=20, choices=Role.choices, default=Role.VIEWER)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ('workspace', 'user')

class Brand(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name='brands')
    name = models.CharField(max_length=255)
    timezone = models.CharField(max_length=50, default='Asia/Kolkata')
    currency = models.CharField(max_length=3, default='INR')
    created_at = models.DateTimeField(auto_now_add=True)
```

### Step 4: Tenancy Resolution Middleware
Every request must establish tenant context from the URL:
```python
# apps/tenancy/middleware.py
from django.http import Http404
from django.utils.deprecation import MiddlewareMixin
from .models import WorkspaceMember, Brand

class TenancyMiddleware(MiddlewareMixin):
    def process_view(self, request, view_func, view_args, view_kwargs):
        workspace_slug = view_kwargs.get('workspace_slug')
        if not workspace_slug:
            request.tenant = None
            return None

        if not request.user.is_authenticated:
            raise Http404("Workspace not found")

        try:
            membership = WorkspaceMember.objects.select_related('workspace').get(
                workspace__slug=workspace_slug,
                user=request.user
            )
        except WorkspaceMember.DoesNotExist:
            # 404 to avoid leaking existence of the workspace
            raise Http404("Workspace not found")

        brand_id = view_kwargs.get('brand_id')
        active_brand = None
        if brand_id:
            try:
                active_brand = Brand.objects.get(id=brand_id, workspace=membership.workspace)
            except Brand.DoesNotExist:
                raise Http404("Brand not found")

        # Attach tenant context
        request.tenant = type('TenantContext', (), {
            'workspace': membership.workspace,
            'role': membership.role,
            'brand': active_brand
        })()
        return None
```

### Step 5: Base Tenant Manager & Model
```python
# apps/tenancy/managers.py
from django.db import models

class TenantQuerySet(models.QuerySet):
    def for_tenant(self, workspace):
        return self.filter(workspace=workspace)

class TenantManager(models.Manager):
    def get_queryset(self):
        return TenantQuerySet(self.model, using=self._db)

    def for_tenant(self, workspace):
        return self.get_queryset().for_tenant(workspace)

# apps/tenancy/base_models.py
class TenantAwareModel(models.Model):
    workspace = models.ForeignKey('tenancy.Workspace', on_delete=models.CASCADE)
    created_at = models.DateTimeField(auto_now_add=True)

    objects = TenantManager()

    class Meta:
        abstract = True
```

### Step 6: Authentication & MFA Flow
1. **Password Validation:** Use Argon2 hasher (`django[argon2]`). Integrate HaveIBeenPwned k-anonymity API in custom password validator.
2. **TOTP MFA:** Use `pyotp`. Generate a base32 secret, convert to QR code URL (`otpauth://...`), prompt user for 6-digit code.
3. **Recovery Codes:** Generate 10 random 8-character codes, store SHA-256 hashes in `MFARecoveryCode` table. Each code is one-time use.

---

## 3. What the AI Frontend Needs (API Contract)

The Next.js UI developer (or AI generating the UI) requires clean JSON contracts. Provide:

### 1. Auth Endpoints
- `POST /api/auth/register/` -> `{ email, password }`
- `POST /api/auth/login/` -> `{ email, password }` -> returns `{ mfa_required: true }` or `{ user, workspaces }`
- `POST /api/auth/mfa/challenge/` -> `{ code }` -> verifies TOTP, completes session
- `POST /api/auth/logout/` -> destroys Redis session

### 2. Tenancy Navigation Endpoints
- `GET /api/me/workspaces/` -> returns list of workspaces the user belongs to:
  ```json
  [
    {
      "id": "c1f7a0b3-...",
      "slug": "125-east-retail",
      "name": "125 East Retail",
      "role": "owner",
      "brands": [
        { "id": "f8a9...", "name": "Apparel", "currency": "INR", "timezone": "Asia/Kolkata" }
      ]
    }
  ]
  ```
- `GET /api/w/{workspace_slug}/members/` -> member list & invites (Owner/Admin only)
- `POST /api/w/{workspace_slug}/invites/` -> invite teammate by email & role

---

## 4. Verification & Exit Gate Checklist

Before moving to Phase 2, run these checks:

```bash
# Run pytest with coverage
pytest tests/accounts tests/tenancy --cov=apps
```

- [ ] **Cross-Tenant Test:** User A in Workspace 1 queries `/api/w/workspace-2/...` and receives `404 Not Found`.
- [ ] **MFA Enforcement:** An Admin or Owner cannot access tenant API routes until the MFA challenge is completed.
- [ ] **Recovery Codes:** Recovery code works once and is marked used; cannot be reused.
- [ ] **No Guessable IDs:** All API responses use UUIDs; auto-incrementing integer IDs are never exposed.
- [ ] **Rate Limiting:** Repeated failed login or MFA attempts trigger HTTP 429 Too Many Requests.
