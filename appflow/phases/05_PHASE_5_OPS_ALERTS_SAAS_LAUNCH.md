# Phase 5: Operations, Alerts, Hardening & SaaS Launch

## Overview & Goal
Transform the system from an internal analytics viewer into an enterprise-ready, reliable, commercial B2B SaaS platform.

This phase implements:
1. Cross-platform universal order search using PostgreSQL trigram indexing.
2. A deterministic alert engine with deduplication keys.
3. Asynchronous background CSV exports via AWS S3 presigned URLs.
4. SaaS subscription gating and server-side limit enforcement.
5. Rigorous security hardening, automated backup restore drills, and India DPDP Act compliance.

---

## 1. Core Mental Models & Concepts to Learn

### A. Search Architecture: Postgres `pg_trgm` vs Elasticsearch
Many teams needlessly introduce Elasticsearch or OpenSearch early on, adding enormous infrastructure costs, cluster management overhead, and index synchronization bugs.
- **The Pragmatic Choice:** PostgreSQL's native `pg_trgm` (trigram) extension combined with GIN indexes provides blazing-fast fuzzy search across millions of orders, AWBs, payment IDs, and customer phone numbers.
- Zero synchronization lag: updates are indexed immediately within the same database transaction.

### B. Deterministic Alerting & The `dedupe_key` Pattern
Alert systems fail if they either miss critical events or spam users with 500 duplicate emails during an outage.
- **The Solution:** Every alert has a deterministic `dedupe_key`:
  ```python
  dedupe_key = f"{rule_name}:{brand_id}:{entity_id or date_bucket}"
  # Example: "stuck_payment:f8a9...:pay_N9X4k..."
  ```
- If the Celery beat task runs every 5 minutes and the condition is still true, it updates `last_checked_at` on the existing `open` alert instead of creating a new one or sending another email.
- **Alert States:** `OPEN` $\rightarrow$ `ACKNOWLEDGED` $\rightarrow$ `RESOLVED`.

### C. Asynchronous File Exports (Never in the Request Loop!)
Exporting 50,000 orders to CSV in an HTTP request will freeze the web worker and trigger a Gateway 504 Timeout.
- **Asynchronous Export Flow:**
  1. User clicks "Export CSV" $\rightarrow$ Backend creates `ExportJob(status='pending')` and returns job ID immediately.
  2. Celery worker streams database records in batches, writes the CSV to AWS S3 under `s3://bucket/{workspace_id}/{brand_id}/exports/{job_id}.csv`.
  3. Worker generates a temporary presigned S3 download URL (valid for 15 minutes) and marks job as `completed`.
  4. Frontend polls or receives WebSocket event with the download link.

### D. Server-Side SaaS Billing Enforcement
Never rely on the frontend to enforce subscription limits (e.g., hiding the "Add Brand" button).
- Define tier entitlements in `apps/billing/limits.py`:
  - `Starter`: 1 Brand, 2 Integrations, 3 Members, 30 days history.
  - `Growth`: 3 Brands, All Integrations, 10 Members, 365 days history.
  - `Enterprise`: Unlimited.
- Backend permission classes check:
  ```python
  if brand_count >= workspace.subscription.plan.max_brands:
      raise LimitExceededError("Upgrade plan to add more brands.")
  ```

---

## 2. Step-by-Step Implementation Guide

### Step 1: Universal Trigram Search Index
Enable Postgres Trigram in a migration:
```python
# apps/commerce/migrations/0003_add_search_index.py
from django.contrib.postgres.operations import TrigramExtension
from django.db import migrations

class Migration(migrations.Migration):
    dependencies = [('commerce', '0002_initial')]

    operations = [
        TrigramExtension(),
        migrations.RunSQL(
            sql="""
            CREATE INDEX idx_order_search_trgm ON commerce_order 
            USING gin (order_number gin_trgm_ops);
            """
        )
    ]
```

Build the search endpoint using Django's Q objects and trigram similarity:
```python
# apps/commerce/views.py
from django.contrib.postgres.search import TrigramSimilarity
from rest_framework.views import APIView
from rest_framework.response import Response
from .models import Order

class UniversalOrderSearchView(APIView):
    def get(self, request, workspace_slug, brand_id):
        query = request.query_params.get('q', '').strip()
        if len(query) < 2:
            return Response([])

        # Filtered by workspace and brand via TenantManager
        orders = Order.objects.for_tenant(request.tenant.workspace).filter(
            brand_id=brand_id,
            order_number__icontains=query
        )[:20]

        return Response([
            {
                "id": o.id,
                "order_number": o.order_number,
                "gross_amount": o.gross_amount,
                "currency": o.currency,
                "financial_status": o.financial_status,
                "created_at": o.source_created_at
            }
            for o in orders
        ])
```

### Step 2: Deterministic Alert Rules Engine
```python
# apps/alerts/engine.py
from django.utils import timezone
from datetime import timedelta
from .models import Alert, AlertRule
from apps.commerce.models import PaymentAttempt

def check_stuck_payments(brand):
    """Flags payments created >30 mins ago still in 'pending' status."""
    stuck_threshold = timezone.now() - timedelta(minutes=30)
    pending_payments = PaymentAttempt.objects.filter(
        brand=brand,
        status='pending',
        source_created_at__lte=stuck_threshold
    )

    for payment in pending_payments:
        dedupe_key = f"stuck_payment:{brand.id}:{payment.provider_id}"
        Alert.objects.get_or_create(
            workspace=brand.workspace,
            brand=brand,
            dedupe_key=dedupe_key,
            defaults={
                'title': f'Stuck Payment: {payment.provider_id}',
                'severity': 'warning',
                'description': f'Payment has been pending for over 30 minutes.',
                'status': 'open'
            }
        )
```

Configure Celery Beat to execute `run_all_alert_rules` every 10 minutes.

### Step 3: Asynchronous S3 CSV Export Worker
```python
# apps/commerce/tasks.py
import csv
import io
import boto3
from celery import shared_task
from django.conf import settings
from .models import Order, ExportJob

@shared_task
def generate_orders_csv(export_job_id: str):
    job = ExportJob.objects.get(id=export_job_id)
    job.status = 'processing'
    job.save()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(['Order Number', 'Net Sales (INR)', 'Status', 'Date'])

    orders = Order.objects.filter(workspace=job.workspace, brand=job.brand).iterator(chunk_size=1000)
    for o in orders:
        writer.writerow([o.order_number, o.net_sales / 100.0, o.financial_status, o.source_created_at])

    # Upload to S3
    s3 = boto3.client('s3')
    key = f"exports/{job.workspace.id}/{job.brand.id}/{job.id}.csv"
    s3.put_object(
        Bucket=settings.AWS_STORAGE_BUCKET_NAME,
        Key=key,
        Body=output.getvalue().encode('utf-8')
    )

    # Generate presigned download URL valid for 15 minutes
    download_url = s3.generate_presigned_url(
        'get_object',
        Params={'Bucket': settings.AWS_STORAGE_BUCKET_NAME, 'Key': key},
        ExpiresIn=900
    )

    job.download_url = download_url
    job.status = 'completed'
    job.save()
```

### Step 4: Security Hardening & DPDP Act Compliance
1. **Security Headers Middleware:**
   - Strict Content Security Policy (CSP)
   - `X-Frame-Options: DENY` (prevents clickjacking)
   - HTTP Strict Transport Security (`HSTS` max-age=31536000)
2. **Indian DPDP Act (Digital Personal Data Protection Act 2023) Checklist:**
   - **Right to Erasure:** Workspace deletion initiates a hard cascade purge of all customer raw JSON payloads, addresses, customer records, and API tokens.
   - **Purpose Limitation:** Shopify customer data used strictly for reporting calculations.
   - **PII Scrubbing:** Phone numbers and email addresses hashed or masked in Sentry and log files.

---

## 3. What the AI Frontend Needs (API Contract)

### 1. Alert Center Endpoints
- `GET /api/w/{ws}/alerts/` -> returns list of active alerts with severity badge (`critical`, `warning`, `info`).
- `POST /api/w/{ws}/alerts/{alert_id}/acknowledge/` -> marks alert acknowledged by current user.
- `POST /api/w/{ws}/alerts/{alert_id}/resolve/` -> manually resolves alert.

### 2. Export Job Polling
- `POST /api/w/{ws}/b/{brand}/exports/orders/` -> returns `{ "job_id": "9f2b..." }`
- `GET /api/w/{ws}/b/{brand}/exports/{job_id}/` -> returns `{ "status": "completed", "download_url": "https://s3..." }`

---

## 4. Verification & Exit Gate Checklist

- [ ] **Automated Tenant Isolation Suite in CI:**
  A comprehensive pytest suite attempts cross-tenant access against:
  - Every GET/POST endpoint
  - Search queries
  - File download URLs
  - Celery background tasks
  All unauthorized attempts must fail with `404` or permission denied.
- [ ] **Disaster Recovery Drill:**
  Perform a point-in-time restore from AWS RDS automated backup into a clean staging database. Measure and document the exact time to recovery (RTO).
- [ ] **Deduplication Check:** Run the alert engine 10 times consecutively against simulated stuck payments; verify that exactly 1 alert record is generated per payment.
- [ ] **Billing Gate Check:** Test that a workspace on a 1-brand limit receives HTTP 402/403 when trying to register a second brand.
