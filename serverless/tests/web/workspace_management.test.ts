// Workspace management through the REAL Next.js route handlers: create workspace, rename, delete (owner,
// slug confirmation), create brand (plan limit), change role and remove member (owner/admin rules, last-owner
// guard, leave), and switching between two workspaces of one user. [LOCAL PGlite DB + real route code]
import { assert, assertEquals } from "jsr:@std/assert@1";
import { hit, WebWorld } from "./harness.ts";

const opts = { sanitizeResources: false, sanitizeOps: false };

Deno.test({ ...opts, name: "Workspace management", fn: async (t) => {
  const ww = await WebWorld.create();
  const w = ww.w;
  const api = await import("../../../frontend/src/app/api/[[...path]]/route.ts");
  const me = await import("../../../frontend/src/app/api/auth/me/route.ts");

  const O = await ww.tenant("ws-owner@example.test", "Owner Org");   // owner of Owner Org
  const ADM = await ww.tenant("ws-admin@example.test", "Admin Home");
  const AN = await ww.tenant("ws-analyst@example.test", "Analyst Home");
  const VI = await ww.tenant("ws-viewer@example.test", "Viewer Home");
  const OUT = await ww.tenant("ws-outsider@example.test", "Outsider Org");
  await w.addMember(O.workspace_id, ADM.user.id, "admin");
  await w.addMember(O.workspace_id, AN.user.id, "analyst");
  await w.addMember(O.workspace_id, VI.user.id, "viewer");

  const c = (t2: { token: string; refresh?: string }) => ({ "sb-access-token": t2.token, ...(t2.refresh ? { "sb-refresh-token": t2.refresh } : {}) });
  const ws = `/api/w/${O.slug}`;

  await t.step("create workspace: caller becomes owner, starter plan, one brand, subscription and audit row", async () => {
    const r = await hit(api, "/api/workspaces", { method: "POST", cookies: c(O), body: { name: "  Second   Store  " } });
    assertEquals(r.status, 201, JSON.stringify(r.body));
    assertEquals(r.body.name, "Second Store");
    assertEquals(r.body.slug, "second-store");
    const [m] = await w.rows<any>("select role from tenancy_workspacemember where workspace_id=$1 and user_id=$2", [r.body.id, O.user.id]);
    assertEquals(m.role, "owner");
    assertEquals(await w.count("tenancy_brand", "workspace_id=$1", [r.body.id]), 1);
    const [sub] = await w.rows<any>("select plan, max_brands, max_members from billing_subscription where workspace_id=$1", [r.body.id]);
    assertEquals([sub.plan, Number(sub.max_brands), Number(sub.max_members)], ["starter", 1, 3]);
    assertEquals(await w.count("tenancy_auditlog", "workspace_id=$1 and action='workspace_created'", [r.body.id]), 1);
  });

  await t.step("create workspace: duplicate name gets a unique slug; short name -> 400; no session -> 401", async () => {
    const dup = await hit(api, "/api/workspaces", { method: "POST", cookies: c(O), body: { name: "Second Store" } });
    assertEquals(dup.status, 201);
    assertEquals(dup.body.slug, "second-store-1");
    assertEquals((await hit(api, "/api/workspaces", { method: "POST", cookies: c(O), body: { name: "x" } })).status, 400);
    assertEquals((await hit(api, "/api/workspaces", { method: "POST", body: { name: "Nope Store" } })).status, 401);
  });

  await t.step("create workspace: owning more than 5 is refused (409)", async () => {
    const Z = await ww.tenant("ws-many@example.test", "Many Home"); // already owns 1
    for (let i = 0; i < 4; i++) assertEquals((await hit(api, "/api/workspaces", { method: "POST", cookies: c(Z), body: { name: `Extra ${i}` } })).status, 201);
    assertEquals((await hit(api, "/api/workspaces", { method: "POST", cookies: c(Z), body: { name: "One Too Many" } })).status, 409);
  });

  await t.step("switching: one user sees both workspaces and can use each one's data; cross-workspace brand id -> 404", async () => {
    const list = await hit(me, "/api/auth/me", { cookies: c(O) });
    const slugs = (list.body.workspaces as any[]).map((x) => x.slug).sort();
    assert(slugs.includes(O.slug) && slugs.includes("second-store"), JSON.stringify(slugs));
    const second = (await w.rows<any>("select b.id from tenancy_brand b join tenancy_workspace x on x.id=b.workspace_id where x.slug='second-store'"))[0];
    const ok = await hit(api, `/api/w/second-store/b/${second.id}/metrics`, { cookies: c(O) });
    assertEquals(ok.status, 200);
    const mixed = await hit(api, `/api/w/${O.slug}/b/${second.id}/metrics`, { cookies: c(O) });
    assertEquals(mixed.status, 404);
  });

  await t.step("rename: owner and admin may; analyst and viewer may not; outsider sees 404", async () => {
    assertEquals((await hit(api, ws, { method: "PATCH", cookies: c(O), body: { name: "Owner Org Renamed" } })).body.name, "Owner Org Renamed");
    assertEquals((await hit(api, ws, { method: "PATCH", cookies: c(ADM), body: { name: "By Admin" } })).status, 200);
    assertEquals((await hit(api, ws, { method: "PATCH", cookies: c(AN), body: { name: "By Analyst" } })).status, 403);
    assertEquals((await hit(api, ws, { method: "PATCH", cookies: c(VI), body: { name: "By Viewer" } })).status, 403);
    assertEquals((await hit(api, ws, { method: "PATCH", cookies: c(OUT), body: { name: "Hijack" } })).status, 404);
    assertEquals((await hit(api, ws, { method: "PATCH", cookies: c(O), body: { name: "x" } })).status, 400);
  });

  await t.step("create brand: plan limit (starter = 1 brand) -> 409; after plan upgrade it works", async () => {
    const r = await hit(api, `${ws}/brands`, { method: "POST", cookies: c(O), body: { name: "Second Brand" } });
    assertEquals(r.status, 409);
    assert(String(r.body.error).includes("plan allows 1 brand"), r.body.error);
    await w.db.query("update billing_subscription set max_brands=3 where workspace_id=$1", [O.workspace_id]);
    const ok = await hit(api, `${ws}/brands`, { method: "POST", cookies: c(O), body: { name: "Second Brand", currency: "usd", timezone: "America/New_York" } });
    assertEquals(ok.status, 201, JSON.stringify(ok.body));
    assertEquals([ok.body.currency, ok.body.timezone], ["USD", "America/New_York"]);
    assertEquals((await hit(api, `${ws}/brands`, { method: "POST", cookies: c(O), body: { name: "Second Brand" } })).status, 409);
    assertEquals((await hit(api, `${ws}/brands`, { method: "POST", cookies: c(O), body: { name: "Bad Cur", currency: "RUPEE" } })).status, 400);
    assertEquals((await hit(api, `${ws}/brands`, { method: "POST", cookies: c(O), body: { name: "Bad Tz", timezone: "Mars/Olympus" } })).status, 400);
    assertEquals((await hit(api, `${ws}/brands`, { method: "POST", cookies: c(AN), body: { name: "Analyst Brand" } })).status, 403);
  });

  await t.step("change role: owner promotes a viewer; admin may move analyst<->viewer but not touch owner/admin", async () => {
    const pro = await hit(api, `${ws}/members/${VI.user.id}`, { method: "PATCH", cookies: c(O), body: { role: "analyst" } });
    assertEquals(pro.status, 200, JSON.stringify(pro.body));
    assertEquals(pro.body.role, "analyst");
    assertEquals((await hit(api, `${ws}/members/${VI.user.id}`, { method: "PATCH", cookies: c(ADM), body: { role: "viewer" } })).status, 200);
    assertEquals((await hit(api, `${ws}/members/${AN.user.id}`, { method: "PATCH", cookies: c(ADM), body: { role: "owner" } })).status, 403);
    assertEquals((await hit(api, `${ws}/members/${ADM.user.id}`, { method: "PATCH", cookies: c(ADM), body: { role: "viewer" } })).status, 403);
    assertEquals((await hit(api, `${ws}/members/${AN.user.id}`, { method: "PATCH", cookies: c(AN), body: { role: "viewer" } })).status, 403);
    assertEquals((await hit(api, `${ws}/members/${AN.user.id}`, { method: "PATCH", cookies: c(O), body: { role: "superuser" } })).status, 400);
    assertEquals((await hit(api, `${ws}/members/${OUT.user.id}`, { method: "PATCH", cookies: c(O), body: { role: "viewer" } })).status, 404);
    assertEquals((await hit(api, `${ws}/members/not-a-uuid`, { method: "PATCH", cookies: c(O), body: { role: "viewer" } })).status, 404);
    assert(await w.count("tenancy_auditlog", "workspace_id=$1 and action='member_role_changed'", [O.workspace_id]) >= 2);
  });

  await t.step("last owner cannot be demoted; a second owner makes demotion possible", async () => {
    const self = await hit(api, `${ws}/members/${O.user.id}`, { method: "PATCH", cookies: c(O), body: { role: "admin" } });
    assertEquals(self.status, 409, JSON.stringify(self.body));
    await w.db.query("update tenancy_workspacemember set role='owner' where workspace_id=$1 and user_id=$2", [O.workspace_id, ADM.user.id]);
    assertEquals((await hit(api, `${ws}/members/${O.user.id}`, { method: "PATCH", cookies: c(O), body: { role: "admin" } })).status, 200);
    await w.db.query("update tenancy_workspacemember set role='owner' where workspace_id=$1 and user_id=$2", [O.workspace_id, O.user.id]);
    await w.db.query("update tenancy_workspacemember set role='admin' where workspace_id=$1 and user_id=$2", [O.workspace_id, ADM.user.id]);
  });

  await t.step("remove member: admin removes analysts/viewers, not owners or admins; viewer cannot remove", async () => {
    assertEquals((await hit(api, `${ws}/members/${AN.user.id}`, { method: "DELETE", cookies: c(VI) })).status, 403);
    assertEquals((await hit(api, `${ws}/members/${O.user.id}`, { method: "DELETE", cookies: c(ADM) })).status, 403);
    const r = await hit(api, `${ws}/members/${VI.user.id}`, { method: "DELETE", cookies: c(ADM) });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals(await w.count("tenancy_workspacemember", "workspace_id=$1 and user_id=$2", [O.workspace_id, VI.user.id]), 0);
    assertEquals((await hit(api, `${ws}/members/${VI.user.id}`, { method: "DELETE", cookies: c(O) })).status, 404);
  });

  await t.step("removing a member also clears their brand access and per-user module overrides", async () => {
    await w.db.query(
      `insert into tenancy_brandmember (brand_id, user_id) select id, $2 from tenancy_brand where workspace_id=$1 on conflict do nothing`,
      [O.workspace_id, AN.user.id]);
    await w.db.query(
      `insert into user_module_permissions (workspace_id, user_id, module_key, enabled) values ($1,$2,'shopify',false) on conflict do nothing`,
      [O.workspace_id, AN.user.id]).catch(() => undefined);
    assertEquals((await hit(api, `${ws}/members/${AN.user.id}`, { method: "DELETE", cookies: c(O) })).status, 200);
    assertEquals(await w.count("tenancy_brandmember", "user_id=$1", [AN.user.id]), 0);
    assertEquals(await w.count("user_module_permissions", "workspace_id=$1 and user_id=$2", [O.workspace_id, AN.user.id]), 0);
  });

  await t.step("leave workspace: any member may leave themselves; the last owner may not", async () => {
    assertEquals((await hit(api, `${ws}/members/${VI.user.id}`, { method: "DELETE", cookies: c(VI) })).status, 404); // already removed
    const adminLeaves = await hit(api, `${ws}/members/${ADM.user.id}`, { method: "DELETE", cookies: c(ADM) });
    assertEquals(adminLeaves.status, 200);
    assertEquals(adminLeaves.body.self, true);
    assertEquals((await hit(api, `${ws}/members/${O.user.id}`, { method: "DELETE", cookies: c(O) })).status, 409);
  });

  await t.step("delete workspace: viewer/analyst/admin refused; owner without matching slug -> 400; wrong slug -> 400", async () => {
    // Earlier steps removed these members; add them back so the role checks below are really exercised.
    await w.addMember(O.workspace_id, ADM.user.id, "admin");
    await w.addMember(O.workspace_id, AN.user.id, "analyst");
    assertEquals((await hit(api, ws, { method: "DELETE", cookies: c(AN), body: { confirm: O.slug } })).status, 403);
    assertEquals((await hit(api, ws, { method: "DELETE", cookies: c(ADM), body: { confirm: O.slug } })).status, 403);
    assertEquals((await hit(api, ws, { method: "DELETE", cookies: c(O), body: {} })).status, 400);
    assertEquals((await hit(api, ws, { method: "DELETE", cookies: c(O), body: { confirm: "something-else" } })).status, 400);
    assertEquals(await w.count("tenancy_workspace", "id=$1", [O.workspace_id]), 1);
  });

  await t.step("delete workspace: owner with the slug removes the workspace, brands, members and history", async () => {
    const slug = (await w.rows<any>("select slug from tenancy_workspace where id=$1", [O.workspace_id]))[0].slug;
    const r = await hit(api, `/api/w/${slug}`, { method: "DELETE", cookies: c(O), body: { confirm: slug } });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals(await w.count("tenancy_workspace", "id=$1", [O.workspace_id]), 0);
    assertEquals(await w.count("tenancy_brand", "workspace_id=$1", [O.workspace_id]), 0);
    assertEquals(await w.count("tenancy_workspacemember", "workspace_id=$1", [O.workspace_id]), 0);
    assertEquals(await w.count("billing_subscription", "workspace_id=$1", [O.workspace_id]), 0);
    assertEquals((await hit(api, `/api/w/${slug}/members`, { cookies: c(O) })).status, 404);
  });

  await t.step("the other workspace of the same user is unaffected by the deletion", async () => {
    const still = await hit(api, "/api/w/second-store/members", { cookies: c(O) });
    assertEquals(still.status, 200);
  });
}});
