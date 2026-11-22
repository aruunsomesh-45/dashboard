# 125East Platform Super Admin Control Plane (Scale Module)

## Overview
This directory contains the full implementation of the 125East Super Admin Dashboard. It is preserved in its entirety for platform administrators and enterprise tenant management.

## Module Structure
- `app/super-admin/`: 12 administration routes:
  - `/super-admin` (Executive Platform KPI Overview)
  - `/super-admin/users` (User Registry, Search & Status)
  - `/super-admin/users/[userId]` (Comprehensive 9-Tab User Dossier & Permission Editor)
  - `/super-admin/workspaces` (Workspace & Brand Multi-Tenant Management)
  - `/super-admin/modules` (Platform Modules Catalog & Global Kill Switches)
  - `/super-admin/integrations` (Cross-Tenant Integration Health & Credentials)
  - `/super-admin/data-flows` (5-Stage Ingestion Pipeline Telemetry)
  - `/super-admin/functions` (Serverless Edge Functions Monitor)
  - `/super-admin/webhooks` (Webhook Ingestion Table & HMAC Audits)
  - `/super-admin/database` (PostgreSQL Table Row Counts & RLS Checks)
  - `/super-admin/audit-logs` (Administrative Audit Trail)
  - `/super-admin/settings` (Super Admin Security & 2FA Configuration)
- `api/super-admin/`: 13 server-side Next.js route handlers backing the admin control plane.
- `components/super-admin/`: `SuperAdminShell.tsx` layout and navigation.
- `lib/serverAdmin.ts`: Server-side JWT verification, `is_superuser` validation, and audit logger.

## Re-integration Instructions
When ready to deploy the Super Admin Control Plane:
1. Copy `app/super-admin/` back to `frontend/src/app/super-admin/`.
2. Copy `api/super-admin/` back to `frontend/src/app/api/super-admin/`.
3. Copy `components/super-admin/` back to `frontend/src/components/super-admin/`.
4. Restore the Super Admin navigation link in `frontend/src/components/layout/DashboardShell.tsx`.
