/**
 * Test world: fresh PGlite database from the real migrations + users provisioned through the real
 * handle_new_auth_user() trigger + a scripted fetch that refuses any un-scripted URL.
 *
 * EVERYTHING HERE IS MOCKED/ISOLATED. No request leaves the process.
 */
import type { PGlite } from "npm:@electric-sql/pglite@0.3";
import { createTestDatabase } from "../db/pglite_db.ts";
import { pgAdminClient, pgUserClient, type FakeAuthDirectory, type Identity } from "./pg_supabase.ts";
import { encryptCredentials } from "../../supabase/functions/_shared/crypto.ts";
import type { Deps } from "../../supabase/functions/_shared/deps.ts";

export const TEST_ENCRYPTION_KEY = "unit-test-only-key-not-a-real-secret";
Deno.env.set("INTEGRATION_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);

export interface Tenant {
  user: Identity;
  token: string;
  workspace_id: string;
  brand_id: string;
}

export interface FetchCall { url: string; method: string; headers: Headers }
export type Route = { match: RegExp; respond: (url: string, call: number) => Response | Promise<Response> };

/** fetch double: answers only scripted routes, records every call, throws on anything else. */
export class ScriptedFetch {
  calls: FetchCall[] = [];
  private hits = new Map<Route, number>();
  constructor(public routes: Route[] = []) {}
  on(match: RegExp, respond: Route["respond"]) {
    this.routes.push({ match, respond });
    return this;
  }
  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    this.calls.push({ url, method: init?.method ?? "GET", headers });
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    for (const r of this.routes) {
      if (r.match.test(url)) {
        const n = (this.hits.get(r) ?? 0) + 1;
        this.hits.set(r, n);
        return await r.respond(url, n);
      }
    }
    throw new Error(`ScriptedFetch: unexpected outbound request to ${new URL(url).host}${new URL(url).pathname}`);
  };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

export class World {
  auth: FakeAuthDirectory = { tokens: new Map() };
  http = new ScriptedFetch();
  sleeps: number[] = [];
  private constructor(public db: PGlite) {}

  static async create(): Promise<World> {
    const { db } = await createTestDatabase({ strict: true });
    return new World(db);
  }

  get admin() {
    return pgAdminClient(this.db);
  }

  deps(): Deps {
    return {
      userClient: (req) => pgUserClient(this.db, this.auth, req),
      adminClient: () => pgAdminClient(this.db),
      fetch: this.http.fetch,
      sleep: (ms) => {
        this.sleeps.push(ms);
        return Promise.resolve();
      },
    };
  }

  /** Signs a user up via auth.users (fires the real provisioning trigger) and issues a session token. */
  async signUp(email: string, org: string): Promise<Tenant> {
    const id = crypto.randomUUID();
    await this.db.query(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, $3)`, [id, email, JSON.stringify({ organization_name: org })]);
    const { rows } = await this.db.query<{ workspace_id: string; brand_id: string }>(
      `SELECT m.workspace_id, b.id AS brand_id FROM public.tenancy_workspacemember m
         JOIN public.tenancy_brand b ON b.workspace_id = m.workspace_id WHERE m.user_id = $1 LIMIT 1`,
      [id],
    );
    if (!rows[0]) throw new Error(`provisioning trigger did not create a workspace for ${email}`);
    const token = `tok_${id}`;
    const user = { id, email };
    this.auth.tokens.set(token, user);
    return { user, token, ...rows[0] };
  }

  /** Adds an existing user to another workspace with a role (e.g. viewer). */
  async addMember(workspaceId: string, userId: string, role: string) {
    await this.db.query(`INSERT INTO public.tenancy_workspacemember (workspace_id, user_id, role) VALUES ($1,$2,$3)`, [workspaceId, userId, role]);
  }

  async addIntegration(t: { workspace_id: string; brand_id: string }, provider: string, creds: Record<string, unknown>, account = ""): Promise<string> {
    const enc = await encryptCredentials(creds);
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO public.integrations_integration (workspace_id, brand_id, provider, status, account_identifier, encrypted_credentials)
       VALUES ($1,$2,$3,'connected',$4,$5) RETURNING id`,
      [t.workspace_id, t.brand_id, provider, account, enc],
    );
    return rows[0].id;
  }

  async count(table: string, where = "true", params: unknown[] = []): Promise<number> {
    const { rows } = await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${table} WHERE ${where}`, params);
    return rows[0].n;
  }

  async rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.db.query<T>(sql, params)).rows;
  }

  async close() {
    await this.db.close();
  }
}

export interface CallOpts {
  token?: string | null;
  body?: unknown;
  rawBody?: string | Uint8Array;
  method?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
}

export async function call(handler: (r: Request) => Promise<Response>, fn: string, o: CallOpts = {}) {
  const url = new URL(`http://localhost/functions/v1/${fn}`);
  for (const [k, v] of Object.entries(o.query ?? {})) url.searchParams.set(k, v);
  const headers = new Headers(o.headers ?? {});
  if (o.token) headers.set("Authorization", `Bearer ${o.token}`);
  const method = o.method ?? "POST";
  let body: BodyInit | undefined;
  if (method !== "GET" && method !== "OPTIONS") {
    body = o.rawBody !== undefined ? (o.rawBody as BodyInit) : JSON.stringify(o.body ?? {});
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  }
  const started = performance.now();
  const res = await handler(new Request(url, { method, headers, body }));
  const text = await res.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch { payload = text; }
  return { status: res.status, body: payload, headers: res.headers, ms: performance.now() - started };
}
