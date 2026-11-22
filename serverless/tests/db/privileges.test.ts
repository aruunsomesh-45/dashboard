// Client-role privilege tests for accounts_user / MFA recovery codes / integration credentials.
// [LOCAL DB: PGlite built from supabase/migrations — never the hosted project]
//
// Regression for QA-2026-11-21 P0: the hosted database never applied 20261110000011_security_hardening.sql,
// so `authenticated` kept table-level UPDATE on accounts_user (self-row RLS) and could set is_superuser /
// mfa_enabled on itself, insert MFA recovery codes, and read encrypted credentials.
// Each scenario runs twice: on the clean migration replay, and after re-creating the hosted drift
// (broad GRANTs) and re-applying 20261121150100 — proving the migration repairs the live shape.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { World, type Tenant } from "../helpers/world.ts";

const opts = { sanitizeResources: false, sanitizeOps: false };
const FIX = new URL("../../../supabase/migrations/20261121150100_reassert_client_column_privileges.sql", import.meta.url);

async function asUser(w: World, t: Tenant, sql: string, params: unknown[] = []) {
  try {
    const rows = await w.db.transaction(async (tx) => {
      await tx.exec("SET LOCAL ROLE authenticated");
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [t.user.id]);
      return (await tx.query(sql, params)).rows;
    });
    return { ok: true as const, rows };
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
}

async function assertLockedDown(w: World, A: Tenant, label: string) {
  for (const [col, val] of [["is_superuser", "true"], ["is_staff", "true"], ["mfa_enabled", "true"], ["is_active", "false"], ["password", "'x'"], ["email", "'evil@example.test'"]]) {
    const r = await asUser(w, A, `UPDATE public.accounts_user SET ${col} = ${val} WHERE id = $1 RETURNING id`, [A.user.id]);
    assert(!r.ok || r.rows.length === 0, `${label}: client could change accounts_user.${col}`);
  }
  const su = await w.rows<{ is_superuser: boolean; mfa_enabled: boolean }>(`SELECT is_superuser, mfa_enabled FROM public.accounts_user WHERE id = $1`, [A.user.id]);
  assertEquals(su[0], { is_superuser: false, mfa_enabled: false }, `${label}: privileged flags changed`);

  const name = await asUser(w, A, `UPDATE public.accounts_user SET first_name = 'Renamed' WHERE id = $1 RETURNING id`, [A.user.id]);
  assert(name.ok && name.rows.length === 1, `${label}: editing own first_name must still work (${!name.ok ? name.error : ""})`);

  const secretRead = await asUser(w, A, `SELECT password, mfa_secret FROM public.accounts_user WHERE id = $1`, [A.user.id]);
  assert(!secretRead.ok, `${label}: client could read password / mfa_secret`);
  const ownRead = await asUser(w, A, `SELECT id, email, is_superuser, mfa_enabled FROM public.accounts_user WHERE id = $1`, [A.user.id]);
  assert(ownRead.ok && ownRead.rows.length === 1, `${label}: reading own non-secret profile must still work`);

  const rc = await asUser(w, A, `INSERT INTO public.accounts_mfarecoverycode (id, user_id, code_hash, created_at) VALUES (gen_random_uuid(), $1, 'deadbeef', now()) RETURNING id`, [A.user.id]);
  assert(!rc.ok, `${label}: client could insert an MFA recovery code`);

  const creds = await asUser(w, A, `SELECT encrypted_credentials FROM public.integrations_integration WHERE workspace_id = $1`, [A.workspace_id]);
  assert(!creds.ok, `${label}: client could read encrypted_credentials`);
  const meta = await asUser(w, A, `SELECT id, provider, status FROM public.integrations_integration WHERE workspace_id = $1`, [A.workspace_id]);
  assert(meta.ok && meta.rows.length === 1, `${label}: members must still see integration status`);
}

Deno.test({ ...opts, name: "Client privileges on accounts_user / recovery codes / credentials", fn: async (t) => {
  const w = await World.create();
  const A = await w.signUp("priv-a@example.test", "Org A");
  await w.addIntegration(A, "shopify", { shop_domain: "a.myshopify.com", access_token: "shpat_synthetic" });

  await t.step("clean migration replay: escalation paths are closed", async () => {
    await assertLockedDown(w, A, "clean");
  });

  await t.step("hosted-DB drift (broad GRANTs) + 20261121150100 re-applied: still closed", async () => {
    // Re-create the grants observed on the hosted project on 2026-11-21.
    await w.db.exec(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.accounts_user TO authenticated;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.accounts_mfarecoverycode TO authenticated;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.integrations_integration TO authenticated;
      DROP TRIGGER IF EXISTS trg_accounts_user_guard_privileged ON public.accounts_user;
    `);
    // Sanity: the drift really is exploitable before the fix (proves the test can fail).
    const before = await asUser(w, A, `UPDATE public.accounts_user SET is_superuser = true WHERE id = $1 RETURNING id`, [A.user.id]);
    assert(before.ok && before.rows.length === 1, "drift simulation did not reproduce the hosted vulnerability");
    await w.db.exec(`UPDATE public.accounts_user SET is_superuser = false WHERE id = '${A.user.id}'`);

    await w.db.exec(await Deno.readTextFile(FIX));
    await assertLockedDown(w, A, "after-fix");
  });

  await t.step("trigger alone blocks privileged changes even if a broad UPDATE grant comes back", async () => {
    await w.db.exec(`GRANT UPDATE ON public.accounts_user TO authenticated;`);
    const r = await asUser(w, A, `UPDATE public.accounts_user SET is_superuser = true WHERE id = $1 RETURNING id`, [A.user.id]);
    assert(!r.ok && /server/i.test(r.error), "guard trigger must reject the change");
    await w.db.exec(await Deno.readTextFile(FIX)); // restore least privilege
  });

  await t.step("server role (table owner) can still change privileged columns", async () => {
    await w.db.exec(`UPDATE public.accounts_user SET mfa_enabled = true WHERE id = '${A.user.id}'`);
    const r = await w.rows<{ mfa_enabled: boolean }>(`SELECT mfa_enabled FROM public.accounts_user WHERE id = $1`, [A.user.id]);
    assertEquals(r[0].mfa_enabled, true);
  });

  await w.close();
}});
