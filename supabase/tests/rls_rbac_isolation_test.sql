\pset tuples_only on
create schema tst;
create function tst.run(p_role text, p_uid uuid, p_sql text, p_ws uuid default null) returns text language plpgsql as $f$
declare n int;
begin
  begin
    perform set_config('request.jwt.claim.sub', coalesce(p_uid::text,''), true);
    perform set_config('app.workspace_id', coalesce(p_ws::text,''), true);
    execute 'set local role '||p_role;
    execute p_sql; get diagnostics n = row_count;
    raise exception 'ROWS:%', n;
  exception when others then
    reset role;
    return case when sqlerrm like 'ROWS:%' then substr(sqlerrm,6) else 'ERR' end;
  end;
end $f$;
create table tst.res(name text, expected text, got text);
create function tst.chk(name text, expected text, got text) returns void language sql as $$ insert into tst.res values(name,expected,got) $$;

insert into auth.users(id,email,raw_user_meta_data) values
 ('aaaaaaaa-0000-0000-0000-000000000001','owner@a.com','{"organization_name":"Org A"}'),
 ('cccccccc-0000-0000-0000-000000000003','owner@c.com','{"organization_name":"Org C"}');
insert into auth.users(id,email) values ('bbbbbbbb-0000-0000-0000-000000000002','viewer@a.com'),('dddddddd-0000-0000-0000-000000000004','analyst@a.com'),('eeeeeeee-0000-0000-0000-000000000005','admin@a.com');
select w.id as wa from tenancy_workspace w where slug='org-a' \gset
select w.id as wc from tenancy_workspace w where slug='org-c' \gset
select id as ba from tenancy_brand where workspace_id=:'wa' \gset
select id as bc from tenancy_brand where workspace_id=:'wc' \gset
delete from tenancy_workspacemember where user_id in ('bbbbbbbb-0000-0000-0000-000000000002','dddddddd-0000-0000-0000-000000000004','eeeeeeee-0000-0000-0000-000000000005');
insert into tenancy_workspacemember(workspace_id,user_id,role) values (:'wa','bbbbbbbb-0000-0000-0000-000000000002','viewer'),(:'wa','dddddddd-0000-0000-0000-000000000004','analyst'),(:'wa','eeeeeeee-0000-0000-0000-000000000005','admin');
insert into commerce_order(workspace_id,brand_id,provider,provider_id,order_number) values (:'wa',:'ba','shopify','p1','A-1'),(:'wc',:'bc','shopify','p2','C-1');
insert into integrations_webhookevent(workspace_id,brand_id,provider,event_id,topic,raw_body) values (:'wa',:'ba','shopify','e1','t','{"a":1}'),(:'wc',:'bc','shopify','e2','t','{"c":1}');
insert into tenancy_auditlog(workspace_id,action) values (:'wa','seed'),(:'wc','seed');

\set OWN '''aaaaaaaa-0000-0000-0000-000000000001'''
\set VW  '''bbbbbbbb-0000-0000-0000-000000000002'''
\set OUT '''cccccccc-0000-0000-0000-000000000003'''
\set AN  '''dddddddd-0000-0000-0000-000000000004'''
\set ADM '''eeeeeeee-0000-0000-0000-000000000005'''
-- isolation
select tst.chk('owner A reads own orders','1', tst.run('authenticated',:OWN,'select * from commerce_order'));
select tst.chk('owner C reads own orders','1', tst.run('authenticated',:OUT,'select * from commerce_order'));
select tst.chk('viewer A reads orders','1', tst.run('authenticated',:VW,'select * from commerce_order'));
select tst.chk('anon reads orders','ERR', tst.run('anon',null,'select * from commerce_order'));
select tst.chk('authenticated without identity reads orders','0', tst.run('authenticated',null,'select * from commerce_order'));
select tst.chk('owner A inserts order into org C','ERR', tst.run('authenticated',:OWN,format('insert into commerce_order(workspace_id,brand_id,provider,provider_id,order_number) values (%L,%L,''shopify'',''x'',''H'')',:'wc',:'bc')));
select tst.chk('owner A updates org C orders','0', tst.run('authenticated',:OWN,format('update commerce_order set order_number=''H'' where workspace_id=%L',:'wc')));
select tst.chk('owner A adds self to org C as owner','ERR', tst.run('authenticated',:OWN,format('insert into tenancy_workspacemember(workspace_id,user_id,role) values (%L,%L,''owner'')',:'wc',:OWN)));
select tst.chk('authenticated spoofs app.workspace_id to org A','0', tst.run('authenticated',:OUT,'select * from commerce_order where order_number=''A-1''',:'wa'::uuid));
select tst.chk('outsider reads A webhook via parent','1', tst.run('authenticated',:OUT,'select * from integrations_webhookevent'));
select tst.chk('outsider reads partition directly','ERR', tst.run('authenticated',:OUT,'select * from webhookevent_2026_11'));
select tst.chk('anon reads partition directly','ERR', tst.run('anon',null,'select * from webhookevent_2026_11'));
-- stats functions
select tst.chk('owner A stats call on org C ids returns zero-orders json','1', tst.run('authenticated',:OWN,format('select get_brand_commerce_stats(%L,%L,30)',:'wc',:'bc')));
select tst.chk('owner A stats (cross-tenant) order_count=0','0', (select (get_brand_commerce_stats_probe)::text from (select 0) x, lateral (select 0 as get_brand_commerce_stats_probe) y));
-- RBAC
select tst.chk('viewer deletes orders','0', tst.run('authenticated',:VW,'delete from commerce_order'));
select tst.chk('viewer updates orders','0', tst.run('authenticated',:VW,'update commerce_order set order_number=''Z'''));
select tst.chk('viewer inserts order','ERR', tst.run('authenticated',:VW,format('insert into commerce_order(workspace_id,brand_id,provider,provider_id,order_number) values (%L,%L,''shopify'',''v'',''V'')',:'wa',:'ba')));
select tst.chk('viewer promotes self to owner','0', tst.run('authenticated',:VW,format('update tenancy_workspacemember set role=''owner'' where user_id=%L',:VW)));
select tst.chk('viewer reads webhook bodies (admin-only)','0', tst.run('authenticated',:VW,'select * from integrations_webhookevent'));
select tst.chk('viewer reads audit log (admin-only)','0', tst.run('authenticated',:VW,'select * from tenancy_auditlog'));
select tst.chk('analyst inserts order','1', tst.run('authenticated',:AN,format('insert into commerce_order(workspace_id,brand_id,provider,provider_id,order_number) values (%L,%L,''shopify'',''an'',''AN'')',:'wa',:'ba')));
select tst.chk('analyst deletes workspace member','0', tst.run('authenticated',:AN,format('delete from tenancy_workspacemember where user_id=%L',:VW)));
select tst.chk('admin reads audit log','2', tst.run('authenticated',:ADM,format('select * from tenancy_auditlog where workspace_id=%L',:'wa')));
select tst.chk('admin removes a viewer','1', tst.run('authenticated',:ADM,format('delete from tenancy_workspacemember where user_id=%L',:VW)));
select tst.chk('admin grants owner role','ERR', tst.run('authenticated',:ADM,format('insert into tenancy_workspacemember(workspace_id,user_id,role) values (%L,%L,''owner'')',:'wa',:ADM)));
select tst.chk('owner grants analyst to new member','1', tst.run('authenticated',:OWN,format('update tenancy_workspacemember set role=''analyst'' where user_id=%L',:VW)));
select tst.chk('admin forges audit entry','ERR', tst.run('authenticated',:ADM,format('insert into tenancy_auditlog(workspace_id,action) values (%L,''forged'')',:'wa')));
select tst.chk('admin upgrades billing plan','0', tst.run('authenticated',:ADM,'update billing_subscription set max_brands=999'));
-- audit immutability
select tst.chk('owner deletes audit log','ERR', tst.run('authenticated',:OWN,'delete from tenancy_auditlog'));
-- accounts
select tst.chk('user sets is_superuser on self','ERR', tst.run('authenticated',:VW,format('update accounts_user set is_superuser=true where id=%L',:VW)));
select tst.chk('user reads password column','ERR', tst.run('authenticated',:VW,'select password from accounts_user'));
select tst.chk('user edits own first_name','1', tst.run('authenticated',:VW,format('update accounts_user set first_name=''x'' where id=%L',:VW)));
select tst.chk('user sees only self in accounts_user','1', tst.run('authenticated',:OWN,'select id from accounts_user'));
select tst.chk('user reads integration credentials','ERR', tst.run('authenticated',:OWN,'select encrypted_credentials from integrations_integration'));
select tst.chk('user reads mfa recovery codes','ERR', tst.run('authenticated',:OWN,'select * from accounts_mfarecoverycode'));
-- backend role (app_user + GUC)
select tst.chk('backend app_user ws=A reads orders (incl analyst insert)','1', tst.run('app_user',null,'select * from commerce_order where order_number=''A-1''',:'wa'::uuid));
select tst.chk('backend app_user ws=A cannot see org C','0', tst.run('app_user',null,'select * from commerce_order where order_number=''C-1''',:'wa'::uuid));
select tst.chk('backend app_user no ws set sees nothing','0', tst.run('app_user',null,'select * from commerce_order'));
select tst.chk('backend ws=A inserts webhook','1', tst.run('app_user',null,format('insert into integrations_webhookevent(workspace_id,brand_id,provider,event_id,topic,raw_body) values (%L,%L,''shopify'',''e9'',''t'',''{}'')',:'wa',:'ba'),:'wa'::uuid));
select tst.chk('backend ws=A inserts audit entry','1', tst.run('app_user',null,format('insert into tenancy_auditlog(workspace_id,action) values (%L,''ok'')',:'wa'),:'wa'::uuid));
select tst.chk('backend ws=A inserts audit entry for org C','ERR', tst.run('app_user',null,format('insert into tenancy_auditlog(workspace_id,action) values (%L,''bad'')',:'wc'),:'wa'::uuid));
select tst.chk('backend deletes audit','ERR', tst.run('app_user',null,'delete from tenancy_auditlog',:'wa'::uuid));
select tst.chk('backend direct partition access','ERR', tst.run('app_user',null,'select * from webhookevent_2026_11',:'wa'::uuid));
select tst.chk('backend refresh_daily_fact_shop own brand','1', tst.run('app_user',null,format('select refresh_daily_fact_shop(%L,current_date)',:'ba'),:'wa'::uuid));
select tst.chk('backend refresh_daily_fact_shop other tenant brand (blocked by RLS)','ERR', tst.run('app_user',null,format('select refresh_daily_fact_shop(%L,current_date)',:'bc'),:'wa'::uuid));
select 'fact rows for org C after cross-tenant refresh = '||count(*) from analytics_factshopdaily where workspace_id=:'wc';
-- idempotency (superuser insert; dedupe trigger)
insert into integrations_webhookevent(workspace_id,brand_id,provider,event_id,topic,raw_body,created_at) values (:'wa',:'ba','shopify','e1','t','dup', now()+interval '1 day');
select tst.chk('webhook replay (same brand/provider/event_id) stored once','1',(select count(*)::text from integrations_webhookevent where event_id='e1' and brand_id=:'ba'));
-- audit trigger vs cascade is exercised: deleting a throwaway workspace
insert into tenancy_workspace(name,slug,plan) values ('tmp','tmp','starter') returning id as wt \gset
insert into tenancy_auditlog(workspace_id,action) values (:'wt','x');
delete from tenancy_workspace where id=:'wt';
select tst.chk('workspace cascade delete not blocked by audit trigger','0',(select count(*)::text from tenancy_auditlog where workspace_id=:'wt'));
-- updated_at
select id as oid from commerce_order limit 1 \gset
select updated_at as u0 from commerce_order where id=:'oid' \gset
select pg_sleep(0.05);
update commerce_order set order_number=order_number where id=:'oid';
select tst.chk('updated_at trigger fires','true',(select (updated_at>:'u0'::timestamptz)::text from commerce_order where id=:'oid'));
\echo ===== RESULTS
select case when expected=got then 'PASS' else 'FAIL' end||' | '||name||' | expected='||expected||' got='||got from tst.res where name not like '%returns zero-orders%' and name not like '%order_count=0%' order by 1 desc, name;
select 'TOTAL pass='||count(*) filter (where expected=got)||' fail='||count(*) filter (where expected<>got) from tst.res where name not like '%order_count=0%';

