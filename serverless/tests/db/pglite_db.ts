/**
 * Isolated, in-process PostgreSQL (PGlite / WASM) built from the project's real
 * migrations in supabase/migrations. Nothing here touches the hosted Supabase
 * project or any local server: every test gets a brand-new throwaway database.
 */
import { PGlite } from "npm:@electric-sql/pglite@0.3";
import { uuid_ossp } from "npm:@electric-sql/pglite@0.3/contrib/uuid_ossp";
import { pgcrypto } from "npm:@electric-sql/pglite@0.3/contrib/pgcrypto";
import { pg_trgm } from "npm:@electric-sql/pglite@0.3/contrib/pg_trgm";
import { btree_gist } from "npm:@electric-sql/pglite@0.3/contrib/btree_gist";

const MIGRATIONS_DIR = new URL("../../../supabase/migrations/", import.meta.url);

/** Minimal stand-in for the parts of Supabase's auth schema the migrations reference. */
const SUPABASE_STUB = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users(id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}', raw_app_meta_data jsonb default '{}', email_confirmed_at timestamptz, last_sign_in_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now());
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ select coalesce(nullif(current_setting('request.jwt.claims', true),''),'{}')::jsonb $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ select nullif(current_setting('request.jwt.claim.role', true),'')::text $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT SELECT ON auth.users TO service_role;
`;

/**
 * Replay shims for KNOWN migration defects (documented in TEST_REPORT.md). The migrations
 * themselves are not edited because they are already applied to the hosted project.
 *  - public._schema_migrations is referenced by 20261112000011+ but never created by any migration.
 *  - 20261112000011 re-declares has_workspace_role() with a renamed parameter (roles -> allowed_roles),
 *    which PostgreSQL rejects with CREATE OR REPLACE. We keep the original parameter name.
 */
const PRE_SHIMS: Record<string, string> = {
  "20261112000011_rbac_rls_and_security_hardening.sql":
    "CREATE TABLE IF NOT EXISTS public._schema_migrations (version text primary key, name text, execution_time_ms int, applied_at timestamptz default now());",
};
const TEXT_SHIMS: Record<string, (sql: string) => string> = {
  "20261112000011_rbac_rls_and_security_hardening.sql": (sql) =>
    sql.replace(/has_workspace_role\(ws_id UUID, allowed_roles TEXT\[\]\)/, "has_workspace_role(ws_id UUID, roles TEXT[])")
       .replace(/role = ANY\(allowed_roles\)/g, "role = ANY(roles)"),
};

export const APPLIED_SHIMS = Object.keys(TEXT_SHIMS).concat(Object.keys(PRE_SHIMS));

export interface MigrationResult {
  file: string;
  ok: boolean;
  error?: string;
}

export async function createTestDatabase(opts: { strict?: boolean } = {}): Promise<{ db: PGlite; migrations: MigrationResult[] }> {
  const db = new PGlite({ extensions: { uuid_ossp, pgcrypto, pg_trgm, btree_gist } });
  await db.exec(SUPABASE_STUB);

  const files: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS_DIR)) if (e.isFile && e.name.endsWith(".sql")) files.push(e.name);
  files.sort();

  const migrations: MigrationResult[] = [];
  for (const f of files) {
    let sql = await Deno.readTextFile(new URL(f, MIGRATIONS_DIR));
    sql = sql.replace(/^﻿/, "");
    if (TEXT_SHIMS[f]) sql = TEXT_SHIMS[f](sql);
    try {
      if (PRE_SHIMS[f]) await db.exec(PRE_SHIMS[f]);
      await db.exec(sql);
      migrations.push({ file: f, ok: true });
    } catch (e) {
      migrations.push({ file: f, ok: false, error: (e as Error).message });
      if (opts.strict) throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
    }
  }
  return { db, migrations };
}

if (import.meta.main) {
  const { migrations } = await createTestDatabase();
  for (const m of migrations) console.log(m.ok ? "OK  " : "FAIL", m.file, m.error ?? "");
}
