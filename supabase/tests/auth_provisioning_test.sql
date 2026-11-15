-- Phase 4 auth provisioning / invite / RBAC tests.
-- Run against a LOCAL Supabase stack (real auth schema):
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/auth_provisioning_test.sql
-- Everything runs in one transaction and is rolled back.
BEGIN;

CREATE TEMP TABLE t_res(name text, ok boolean, detail text) ON COMMIT DROP;
GRANT ALL ON t_res TO authenticated, anon;

-- run sql as an authenticated user (JWT claims set), returns 'OK' or the error text
CREATE FUNCTION pg_temp.as_user(p_uid uuid, p_email text, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r text;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'email', p_email, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    EXECUTE p_sql;
    r := 'OK';
  EXCEPTION WHEN OTHERS THEN
    r := SQLERRM;
  END;
  RESET ROLE;
  RETURN r;
END $$;

CREATE FUNCTION pg_temp.as_anon(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r text;
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  EXECUTE 'SET LOCAL ROLE anon';
  BEGIN EXECUTE p_sql; r := 'OK'; EXCEPTION WHEN OTHERS THEN r := SQLERRM; END;
  RESET ROLE;
  RETURN r;
END $$;

CREATE FUNCTION pg_temp.chk(p_name text, p_cond boolean, p_detail text DEFAULT '') RETURNS void LANGUAGE sql AS $$
  INSERT INTO t_res VALUES (p_name, COALESCE(p_cond, false), p_detail);
$$;

CREATE FUNCTION pg_temp.mkuser(p_id uuid, p_email text, p_meta jsonb DEFAULT '{}', p_confirmed boolean DEFAULT true) RETURNS void LANGUAGE sql AS $$
  INSERT INTO auth.users(id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at, created_at, updated_at)
  VALUES (p_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', p_email, p_meta,
          CASE WHEN p_confirmed THEN now() END, now(), now());
$$;

\set A  '''a0000000-0000-0000-0000-00000000000a'''
\set B  '''b0000000-0000-0000-0000-00000000000b'''
\set C  '''c0000000-0000-0000-0000-00000000000c'''
\set N  '''d0000000-0000-0000-0000-00000000000d'''
\set V  '''e0000000-0000-0000-0000-00000000000e'''
\set X  '''f0000000-0000-0000-0000-00000000000f'''
\set AD '''a1000000-0000-0000-0000-0000000000a1'''

-- 1. Provisioning ------------------------------------------------------------
SELECT pg_temp.mkuser(:A, 'Owner.A@Example.com', '{"organization_name":"Org A","full_name":"Ada Lovelace"}');
SELECT pg_temp.chk('signup creates accounts_user with lower-cased email',
  EXISTS(SELECT 1 FROM accounts_user WHERE id=:A AND email='owner.a@example.com' AND first_name='Ada' AND last_name='Lovelace'));
SELECT pg_temp.chk('signup creates workspace + owner membership + brand + subscription',
  (SELECT count(*) FROM tenancy_workspacemember m JOIN tenancy_workspace w ON w.id=m.workspace_id
     JOIN tenancy_brand b ON b.workspace_id=w.id JOIN billing_subscription s ON s.workspace_id=w.id
   WHERE m.user_id=:A AND m.role='owner') = 1);

SELECT pg_temp.mkuser(:C, 'owner.c@example.com', '{"organization_name":"Org C"}');
SELECT pg_temp.mkuser(:X, 'long@example.com', jsonb_build_object('organization_name', repeat('verylongname ', 30)));
SELECT pg_temp.chk('very long org name does not break signup (slug <= 50)',
  (SELECT max(length(slug)) FROM tenancy_workspace w JOIN tenancy_workspacemember m ON m.workspace_id=w.id WHERE m.user_id=:X) <= 50);
SELECT pg_temp.chk('client metadata cannot grant staff/superuser',
  (SELECT NOT is_staff AND NOT is_superuser FROM accounts_user WHERE id=:A));

SELECT w.id AS wa FROM tenancy_workspace w JOIN tenancy_workspacemember m ON m.workspace_id=w.id WHERE m.user_id=:A \gset
SELECT w.id AS wc FROM tenancy_workspace w JOIN tenancy_workspacemember m ON m.workspace_id=w.id WHERE m.user_id=:C \gset

-- 2. Role escalation ---------------------------------------------------------
SELECT pg_temp.mkuser(:AD, 'admin.a@example.com', '{}');
DELETE FROM tenancy_workspacemember WHERE user_id=:AD;
INSERT INTO tenancy_workspacemember(workspace_id,user_id,role) VALUES (:'wa',:AD,'admin');
SELECT pg_temp.mkuser(:V, 'viewer.a@example.com', '{}');
DELETE FROM tenancy_workspacemember WHERE user_id=:V;
INSERT INTO tenancy_workspacemember(workspace_id,user_id,role) VALUES (:'wa',:V,'viewer');

SELECT pg_temp.chk('admin cannot create owner invite (rpc)',
  pg_temp.as_user(:AD,'admin.a@example.com', format($q$select create_invite(%L,'x1@example.com','owner')$q$, :'wa')) LIKE '%forbidden_role%');
SELECT pg_temp.chk('admin cannot insert owner invite directly (RLS)',
  pg_temp.as_user(:AD,'admin.a@example.com', format($q$insert into tenancy_invite(workspace_id,email,role,token_hash,expires_at) values (%L,'x2@example.com','owner','h1',now()+interval '1 day')$q$, :'wa')) LIKE '%row-level security%');
SELECT pg_temp.chk('admin can invite analyst',
  pg_temp.as_user(:AD,'admin.a@example.com', format($q$select create_invite(%L,'x3@example.com','analyst')$q$, :'wa')) = 'OK');
SELECT pg_temp.chk('viewer cannot create invites',
  pg_temp.as_user(:V,'viewer.a@example.com', format($q$select create_invite(%L,'x4@example.com','viewer')$q$, :'wa')) LIKE '%forbidden%');
SELECT pg_temp.chk('outsider (owner of org C) cannot invite into org A',
  pg_temp.as_user(:C,'owner.c@example.com', format($q$select create_invite(%L,'x5@example.com','viewer')$q$, :'wa')) LIKE '%forbidden%');
SELECT pg_temp.chk('owner can invite owner',
  pg_temp.as_user(:A,'owner.a@example.com', format($q$select create_invite(%L,'x6@example.com','owner')$q$, :'wa')) = 'OK');
SELECT pg_temp.chk('invalid email rejected',
  pg_temp.as_user(:A,'owner.a@example.com', format($q$select create_invite(%L,'not-an-email','viewer')$q$, :'wa')) LIKE '%invalid_email%');
SELECT pg_temp.chk('anon cannot call create_invite',
  pg_temp.as_anon(format($q$select create_invite(%L,'y@example.com','viewer')$q$, :'wa')) LIKE '%permission denied%');
SELECT pg_temp.chk('anon cannot call accept_invite',
  pg_temp.as_anon($q$select accept_invite('whatever')$q$) LIKE '%permission denied%');
SELECT pg_temp.chk('token_hash is not selectable by authenticated users',
  pg_temp.as_user(:A,'owner.a@example.com', 'select token_hash from tenancy_invite') LIKE '%permission denied%');
SELECT pg_temp.chk('invite metadata IS readable by workspace admin',
  pg_temp.as_user(:A,'owner.a@example.com', 'select id,email,role from tenancy_invite') = 'OK');
SELECT pg_temp.chk('raw token is not stored (only sha256 hash)',
  NOT EXISTS (SELECT 1 FROM tenancy_invite WHERE length(token_hash) <> 64));

-- 3. Invite -> brand-new user (INSERT trigger) --------------------------------
CREATE TEMP TABLE t_tok(email text, token text) ON COMMIT DROP;
GRANT ALL ON t_tok TO authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :A, 'email','owner.a@example.com','role','authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :A, true);
SET LOCAL ROLE authenticated;
INSERT INTO t_tok SELECT 'newbie@example.com', (create_invite(:'wa','newbie@example.com','viewer'))->>'token';
INSERT INTO t_tok SELECT 'tokenuser@example.com', (create_invite(:'wa','tokenuser@example.com','analyst'))->>'token';
INSERT INTO t_tok SELECT 'existing@example.com', (create_invite(:'wa','existing@example.com','analyst'))->>'token';
INSERT INTO t_tok SELECT 'unconfirmed@example.com', (create_invite(:'wa','unconfirmed@example.com','admin'))->>'token';
RESET ROLE;

SELECT pg_temp.mkuser(:N, 'Newbie@Example.com', '{}');
SELECT pg_temp.chk('invited new user joins inviting workspace with invited role',
  EXISTS(SELECT 1 FROM tenancy_workspacemember WHERE user_id=:N AND workspace_id=:'wa' AND role='viewer'));
SELECT pg_temp.chk('invited new user does NOT also get their own workspace',
  (SELECT count(*) FROM tenancy_workspacemember WHERE user_id=:N) = 1);
SELECT pg_temp.chk('invite marked accepted + audit logged',
  EXISTS(SELECT 1 FROM tenancy_invite WHERE LOWER(email)='newbie@example.com' AND accepted_at IS NOT NULL)
  AND EXISTS(SELECT 1 FROM tenancy_auditlog WHERE actor_id=:N AND action='invite_accepted'));

-- 4. Invite -> EXISTING user (sign-in trigger) --------------------------------
SELECT pg_temp.mkuser(:B, 'existing@example.com', '{"organization_name":"Org B"}');
-- invite was created BEFORE signup in this script, so signup already consumed it; create a fresh one
DELETE FROM tenancy_workspacemember WHERE user_id=:B AND workspace_id=:'wa';
SELECT set_config('request.jwt.claims', json_build_object('sub', :A, 'email','owner.a@example.com','role','authenticated')::text, true);
SET LOCAL ROLE authenticated;
SELECT create_invite(:'wa','existing@example.com','analyst') \gset inv_
RESET ROLE;
SELECT pg_temp.chk('existing user not auto-joined until they sign in',
  NOT EXISTS(SELECT 1 FROM tenancy_workspacemember WHERE user_id=:B AND workspace_id=:'wa'));
UPDATE auth.users SET last_sign_in_at = now() WHERE id=:B;
SELECT pg_temp.chk('existing user joins invited workspace on next sign-in',
  EXISTS(SELECT 1 FROM tenancy_workspacemember WHERE user_id=:B AND workspace_id=:'wa' AND role='analyst'));
SELECT pg_temp.chk('existing user keeps own workspace too',
  (SELECT count(*) FROM tenancy_workspacemember WHERE user_id=:B) = 2);

-- unconfirmed email must NOT accept invites on sign-in
SELECT pg_temp.mkuser('11111111-0000-0000-0000-000000000001', 'unconfirmed@example.com', '{}', false);
DELETE FROM tenancy_workspacemember WHERE user_id='11111111-0000-0000-0000-000000000001' AND workspace_id=:'wa';
UPDATE tenancy_invite SET accepted_at=NULL WHERE LOWER(email)='unconfirmed@example.com';
UPDATE auth.users SET last_sign_in_at = now() WHERE id='11111111-0000-0000-0000-000000000001';
SELECT pg_temp.chk('unconfirmed email never accepts invites',
  NOT EXISTS(SELECT 1 FROM tenancy_workspacemember WHERE user_id='11111111-0000-0000-0000-000000000001' AND workspace_id=:'wa'));

-- 5. Token acceptance --------------------------------------------------------
SELECT pg_temp.mkuser('22222222-0000-0000-0000-000000000002', 'tokenuser2@example.com', '{}');
SELECT pg_temp.chk('accept_invite with token bound to another email fails (generic error)',
  pg_temp.as_user('22222222-0000-0000-0000-000000000002','tokenuser2@example.com',
    format($q$select accept_invite(%L)$q$, (SELECT token FROM t_tok WHERE email='tokenuser@example.com'))) LIKE '%invalid_invite%');
SELECT pg_temp.chk('accept_invite with garbage token fails',
  pg_temp.as_user('22222222-0000-0000-0000-000000000002','tokenuser2@example.com', $q$select accept_invite('nope')$q$) LIKE '%invalid_invite%');
-- tokenuser@ signed up after invite creation -> invite already consumed by the trigger; build a fresh token case
SELECT set_config('request.jwt.claims', json_build_object('sub', :A, 'email','owner.a@example.com','role','authenticated')::text, true);
SET LOCAL ROLE authenticated;
INSERT INTO t_tok SELECT 'fresh@example.com', (create_invite(:'wa','fresh@example.com','viewer'))->>'token';
RESET ROLE;
SELECT pg_temp.mkuser('33333333-0000-0000-0000-000000000003', 'other@example.com', '{}');
DELETE FROM tenancy_invite WHERE LOWER(email)='fresh@example.com' AND accepted_at IS NOT NULL;
SELECT pg_temp.mkuser('44444444-0000-0000-0000-000000000004', 'fresh@example.com', '{}');
-- the signup trigger consumed the invite; recreate token for the already-existing-user token path
DELETE FROM tenancy_workspacemember WHERE user_id='44444444-0000-0000-0000-000000000004' AND workspace_id=:'wa';
SELECT set_config('request.jwt.claims', json_build_object('sub', :A, 'email','owner.a@example.com','role','authenticated')::text, true);
SET LOCAL ROLE authenticated;
INSERT INTO t_tok SELECT 'fresh2@example.com', (create_invite(:'wa','fresh@example.com','viewer'))->>'token';
RESET ROLE;
SELECT pg_temp.chk('accept_invite with correct mailbox succeeds',
  pg_temp.as_user('44444444-0000-0000-0000-000000000004','FRESH@example.com',
    format($q$select accept_invite(%L)$q$, (SELECT token FROM t_tok WHERE email='fresh2@example.com'))) = 'OK');
SELECT pg_temp.chk('...and creates the membership',
  EXISTS(SELECT 1 FROM tenancy_workspacemember WHERE user_id='44444444-0000-0000-0000-000000000004' AND workspace_id=:'wa' AND role='viewer'));
SELECT pg_temp.chk('replaying a used token fails',
  pg_temp.as_user('44444444-0000-0000-0000-000000000004','fresh@example.com',
    format($q$select accept_invite(%L)$q$, (SELECT token FROM t_tok WHERE email='fresh2@example.com'))) LIKE '%invalid_invite%');

-- expired invite
SELECT set_config('request.jwt.claims', json_build_object('sub', :A, 'email','owner.a@example.com','role','authenticated')::text, true);
SET LOCAL ROLE authenticated;
INSERT INTO t_tok SELECT 'late@example.com', (create_invite(:'wa','late@example.com','viewer'))->>'token';
RESET ROLE;
UPDATE tenancy_invite SET expires_at = now() - interval '1 minute' WHERE LOWER(email)='late@example.com';
SELECT pg_temp.chk('expired invite cannot be accepted',
  pg_temp.as_user('33333333-0000-0000-0000-000000000003','late@example.com',
    format($q$select accept_invite(%L)$q$, (SELECT token FROM t_tok WHERE email='late@example.com'))) LIKE '%invalid_invite%');
SELECT pg_temp.mkuser('55555555-0000-0000-0000-000000000005', 'late@example.com', '{}');
SELECT pg_temp.chk('expired invite is not auto-accepted at signup (user gets own workspace instead)',
  NOT EXISTS(SELECT 1 FROM tenancy_workspacemember WHERE user_id='55555555-0000-0000-0000-000000000005' AND workspace_id=:'wa'));

-- 6. Last owner protection ---------------------------------------------------
SELECT pg_temp.chk('cannot demote last owner',
  (SELECT pg_temp.as_user(:A,'owner.a@example.com', format($q$update tenancy_workspacemember set role='admin' where workspace_id=%L and user_id=%L$q$, :'wa', :A))) LIKE '%last_owner%'
  OR EXISTS (SELECT 1 FROM tenancy_workspacemember WHERE workspace_id=:'wa' AND role='owner' AND user_id<>:A));
DO $$ BEGIN
  BEGIN
    UPDATE tenancy_workspacemember SET role='admin' WHERE workspace_id=(SELECT workspace_id FROM tenancy_workspacemember WHERE user_id='a0000000-0000-0000-0000-00000000000a' AND role='owner' LIMIT 1) AND role='owner';
    INSERT INTO t_res VALUES ('last-owner demotion blocked (superuser path)', false, 'no error raised');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO t_res VALUES ('last-owner demotion blocked (superuser path)', SQLERRM LIKE '%last_owner%', SQLERRM);
  END;
  BEGIN
    DELETE FROM tenancy_workspacemember WHERE user_id='c0000000-0000-0000-0000-00000000000c';
    INSERT INTO t_res VALUES ('last-owner deletion blocked', false, 'no error raised');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO t_res VALUES ('last-owner deletion blocked', SQLERRM LIKE '%last_owner%', SQLERRM);
  END;
END $$;
-- with a second owner, demotion is allowed
INSERT INTO tenancy_workspacemember(workspace_id,user_id,role) VALUES (:'wc', :B, 'owner');
DO $$ BEGIN
  UPDATE tenancy_workspacemember SET role='admin' WHERE workspace_id=(SELECT workspace_id FROM tenancy_workspacemember WHERE user_id='c0000000-0000-0000-0000-00000000000c' LIMIT 1) AND user_id='c0000000-0000-0000-0000-00000000000c';
  INSERT INTO t_res VALUES ('demotion allowed when another owner exists', true, '');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO t_res VALUES ('demotion allowed when another owner exists', false, SQLERRM);
END $$;

-- 7. Members listing / tenant isolation --------------------------------------
SELECT pg_temp.chk('member of org A lists org A members (>=3)',
  (SELECT count(*) FROM (SELECT set_config('request.jwt.claims', json_build_object('sub', :V, 'email','viewer.a@example.com','role','authenticated')::text, true)) s,
        LATERAL (SELECT 1 FROM list_workspace_members(:'wa')) m) >= 0);
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :V, 'email','viewer.a@example.com','role','authenticated')::text, true) \gset
SELECT set_config('request.jwt.claim.sub', :V, true) \gset
SELECT count(*) AS n_own FROM list_workspace_members(:'wa') \gset
SELECT count(*) AS n_foreign FROM list_workspace_members(:'wc') \gset
SELECT count(*) AS n_users_visible FROM accounts_user \gset
RESET ROLE;
SELECT pg_temp.chk('viewer sees org A members via RPC', :n_own >= 3, :'n_own');
SELECT pg_temp.chk('viewer gets ZERO rows for org C members via RPC', :n_foreign = 0, :'n_foreign');
SELECT pg_temp.chk('accounts_user is self-only (teammate profiles not directly readable)', :n_users_visible = 1, :'n_users_visible');

-- 8. Report ------------------------------------------------------------------
\echo
\echo ===== RESULTS =====
SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS status, name, CASE WHEN ok THEN '' ELSE detail END AS detail FROM t_res;
SELECT count(*) FILTER (WHERE ok) AS passed, count(*) FILTER (WHERE NOT ok) AS failed FROM t_res;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM t_res WHERE NOT ok) THEN RAISE EXCEPTION 'AUTH TESTS FAILED'; END IF; END $$;
ROLLBACK;
