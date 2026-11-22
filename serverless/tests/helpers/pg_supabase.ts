/**
 * A small supabase-js compatible client backed by PGlite, so the REAL Edge Function handlers can be
 * exercised end-to-end against the REAL migrated schema (constraints, triggers, RLS policies).
 *
 *  - admin client  -> runs as the PGlite superuser (BYPASSRLS, like service_role)
 *  - user client   -> every statement runs in a transaction as role `authenticated` with
 *                     request.jwt.claim.sub = <user id>, exactly how PostgREST applies RLS.
 *
 * Only the query-builder surface the functions use is implemented. This is a TEST DOUBLE for
 * PostgREST, not a claim about the hosted project. Live behaviour is covered by tests/smoke + tests/live.
 */
import type { PGlite, Transaction } from "npm:@electric-sql/pglite@0.3";

type Row = Record<string, unknown>;
interface PgError { message: string; code: string; details: string | null; hint: string | null }
interface Result<T> { data: T; error: PgError | null; count?: number | null; status?: number }

export interface Identity { id: string; email: string }

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

function columns(sel: string): string {
  const s = sel.trim();
  if (s === "" || s === "*") return "*";
  return s.split(",").map((c) => c.trim()).filter(Boolean).map((c) => {
    if (!/^[a-z_][a-z0-9_]*$/i.test(c)) throw new Error(`pg_supabase: unsupported select "${c}"`);
    return q(c);
  }).join(", ");
}

const DATE_OID = 1082;
const BYTEA_OID = 17;

function toJsonish(rows: Row[], fields: { name: string; dataTypeID: number }[]): Row[] {
  const types = new Map(fields.map((f) => [f.name, f.dataTypeID]));
  return rows.map((r) => {
    const out: Row = {};
    for (const [k, v] of Object.entries(r)) {
      const t = types.get(k);
      if (v instanceof Date) out[k] = t === DATE_OID ? v.toISOString().slice(0, 10) : v.toISOString();
      else if (v instanceof Uint8Array && t === BYTEA_OID) out[k] = "\\x" + Array.from(v, (b) => b.toString(16).padStart(2, "0")).join("");
      else if (typeof v === "bigint") out[k] = Number(v);
      else out[k] = v;
    }
    return out;
  });
}

function param(v: unknown): unknown {
  if (v === undefined) return null;
  if (v instanceof Uint8Array || v instanceof Date || v === null) return v;
  if (typeof v === "object") return JSON.stringify(v);
  return v;
}

function asPgError(e: unknown): PgError {
  const err = e as { message?: string; code?: string; detail?: string; hint?: string };
  return { message: err.message ?? String(e), code: err.code ?? "XX000", details: err.detail ?? null, hint: err.hint ?? null };
}

type Mode = { kind: "admin" } | { kind: "user"; identity: Identity | null };

class Builder<T = any> implements PromiseLike<Result<T>> {
  private op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
  private selectCols: string | null = null;
  private returning = false;
  private filters: { sql: string; val: unknown }[] = [];
  private _limit: number | null = null;
  private orderBy: string | null = null;
  private payload: Row[] = [];
  private onConflict: string | null = null;
  private cardinality: "one" | "maybe" | null = null;

  constructor(private db: PGlite, private mode: Mode, private table: string) {}

  select(cols = "*") {
    if (this.op === "select") this.selectCols = cols;
    else {
      this.returning = true;
      this.selectCols = cols;
    }
    return this;
  }
  insert(rows: Row | Row[]) {
    this.op = "insert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  upsert(rows: Row | Row[], opts: { onConflict?: string } = {}) {
    this.op = "upsert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    this.onConflict = opts.onConflict ?? "id";
    return this;
  }
  update(patch: Row) {
    this.op = "update";
    this.payload = [patch];
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  private f(col: string, opr: string, val: unknown) {
    this.filters.push({ sql: `${q(col)} ${opr}`, val });
    return this;
  }
  eq(c: string, v: unknown) { return this.f(c, "=", v); }
  neq(c: string, v: unknown) { return this.f(c, "<>", v); }
  gt(c: string, v: unknown) { return this.f(c, ">", v); }
  gte(c: string, v: unknown) { return this.f(c, ">=", v); }
  lt(c: string, v: unknown) { return this.f(c, "<", v); }
  lte(c: string, v: unknown) { return this.f(c, "<=", v); }
  limit(n: number) { this._limit = n; return this; }
  order(c: string, o: { ascending?: boolean } = {}) {
    this.orderBy = `${q(c)} ${o.ascending === false ? "DESC" : "ASC"}`;
    return this;
  }
  maybeSingle() { this.cardinality = "maybe"; return this; }
  single() { this.cardinality = "one"; return this; }

  private build(): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    const where = this.filters.length
      ? " WHERE " + this.filters.map((f) => { params.push(param(f.val)); return `${f.sql} $${params.length}`; }).join(" AND ")
      : "";
    const ret = this.returning ? ` RETURNING ${columns(this.selectCols ?? "*")}` : "";
    const t = `public.${q(this.table)}`;

    if (this.op === "select") {
      let sql = `SELECT ${columns(this.selectCols ?? "*")} FROM ${t}${where}`;
      if (this.orderBy) sql += ` ORDER BY ${this.orderBy}`;
      if (this._limit !== null) sql += ` LIMIT ${Math.trunc(this._limit)}`;
      return { sql, params };
    }
    if (this.op === "delete") return { sql: `DELETE FROM ${t}${where}${ret}`, params };
    if (this.op === "update") {
      // SET placeholders must be numbered before the WHERE placeholders.
      const patch = this.payload[0];
      const p2: unknown[] = [];
      const setSql = Object.keys(patch).map((k) => { p2.push(param(patch[k])); return `${q(k)} = $${p2.length}`; }).join(", ");
      const w2 = this.filters.length ? " WHERE " + this.filters.map((f) => { p2.push(param(f.val)); return `${f.sql} $${p2.length}`; }).join(" AND ") : "";
      return { sql: `UPDATE ${t} SET ${setSql}${w2}${ret}`, params: p2 };
    }
    // insert / upsert
    const cols = Array.from(new Set(this.payload.flatMap((r) => Object.keys(r))));
    const values = this.payload.map((r) => "(" + cols.map((c) => {
      if (!(c in r)) return "DEFAULT";
      params.push(param(r[c]));
      return `$${params.length}`;
    }).join(", ") + ")").join(", ");
    let sql = `INSERT INTO ${t} (${cols.map(q).join(", ")}) VALUES ${values}`;
    if (this.op === "upsert") {
      const conflict = this.onConflict!.split(",").map((c) => c.trim());
      const upd = cols.filter((c) => !conflict.includes(c)).map((c) => `${q(c)} = EXCLUDED.${q(c)}`);
      sql += ` ON CONFLICT (${conflict.map(q).join(", ")}) ` + (upd.length ? `DO UPDATE SET ${upd.join(", ")}` : "DO NOTHING");
    }
    return { sql: sql + ret, params };
  }

  private async run(): Promise<Result<T>> {
    let built: { sql: string; params: unknown[] };
    try {
      built = this.build();
    } catch (e) {
      return { data: null as T, error: asPgError(e) };
    }
    const exec = async (tx: PGlite | Transaction) => tx.query<Row>(built.sql, built.params);
    let rows: Row[];
    try {
      if (this.mode.kind === "admin") {
        const r = await exec(this.db);
        rows = toJsonish(r.rows, r.fields);
      } else {
        const ident = this.mode.identity;
        rows = await this.db.transaction(async (tx) => {
          await tx.exec("SET LOCAL ROLE authenticated");
          await tx.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true), set_config('request.jwt.claim.role', 'authenticated', true)", [
            ident?.id ?? "",
            JSON.stringify(ident ? { sub: ident.id, email: ident.email, role: "authenticated" } : { role: "anon" }),
          ]);
          const r = await exec(tx);
          return toJsonish(r.rows, r.fields);
        });
      }
    } catch (e) {
      return { data: null as T, error: asPgError(e) };
    }

    const wantsRows = this.op === "select" || this.returning;
    if (!wantsRows) return { data: null as T, error: null, status: 204 };
    if (this.cardinality === "one") {
      if (rows.length !== 1) {
        return { data: null as T, error: { message: `JSON object requested, multiple (or no) rows returned`, code: "PGRST116", details: `${rows.length} rows`, hint: null } };
      }
      return { data: rows[0] as T, error: null };
    }
    if (this.cardinality === "maybe") {
      if (rows.length > 1) return { data: null as T, error: { message: "multiple rows returned", code: "PGRST116", details: null, hint: null } };
      return { data: (rows[0] ?? null) as T, error: null };
    }
    return { data: rows as T, error: null };
  }

  then<R1 = Result<T>, R2 = never>(ok?: ((v: Result<T>) => R1 | PromiseLike<R1>) | null, ko?: ((e: unknown) => R2 | PromiseLike<R2>) | null) {
    return this.run().then(ok, ko);
  }
}

export interface FakeAuthDirectory {
  /** token -> identity. Tokens not in the map (or mapped to null) are rejected like an invalid/expired JWT. */
  tokens: Map<string, Identity | null>;
}

// deno-lint-ignore no-explicit-any
export function pgAdminClient(db: PGlite): any {
  return {
    from: (t: string) => new Builder(db, { kind: "admin" }, t),
    auth: { getUser: () => Promise.resolve({ data: { user: null }, error: { message: "admin client has no user" } }) },
  };
}

// deno-lint-ignore no-explicit-any
export function pgUserClient(db: PGlite, dir: FakeAuthDirectory, req: Request): any {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const identity = dir.tokens.get(token) ?? null;
  return {
    from: (t: string) => new Builder(db, { kind: "user", identity }, t),
    /** PostgREST /rpc/<fn> with named arguments, executed as the authenticated user. */
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      if (!/^[a-z_][a-z0-9_]*$/i.test(fn)) throw new Error("bad rpc name");
      const keys = Object.keys(args);
      const sql = `SELECT public.${q(fn)}(${keys.map((k, i) => `${q(k)} => $${i + 1}`).join(", ")}) AS result`;
      try {
        const result = await db.transaction(async (tx) => {
          await tx.exec("SET LOCAL ROLE authenticated");
          await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [identity?.id ?? ""]);
          return (await tx.query<{ result: unknown }>(sql, keys.map((k) => param(args[k])))).rows[0]?.result;
        });
        return { data: result, error: null };
      } catch (e) {
        return { data: null, error: asPgError(e) };
      }
    },
    auth: {
      getUser: () =>
        Promise.resolve(
          identity
            ? { data: { user: { id: identity.id, email: identity.email } }, error: null }
            : { data: { user: null }, error: { message: "invalid JWT: unable to parse or verify signature, token is expired" } },
        ),
    },
  };
}
