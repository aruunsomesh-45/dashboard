-- ============================================================================
-- Migration: 20261110000008_grant_roles.sql
-- Description: Grant membership of application roles to postgres superuser
-- ============================================================================

GRANT app_user TO postgres;
GRANT authenticated TO postgres;
GRANT anon TO postgres;
