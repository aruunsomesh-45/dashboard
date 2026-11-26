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

/** Splits a PostgREST select list on top-level commas (commas inside embedded `rel(...)` are kept). */
function splitTop(sel: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of sel) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

interface Embed { alias: string; table: string; inner: string }

/** Parses `a, b, alias:table(cols), table(cols)` into plain columns + embedded resources. */
function parseSelect(sel: string): { plain: string[] | "*"; embeds: Embed[] } {
  const parts = splitTop(sel.trim() || "*");
  const embeds: Embed[] = [];
  const plain: string[] = [];
  let star = false;
  for (const p of parts) {
    const m = /^(?:([a-z_][a-z0-9_]*):)?([a-z_][a-z0-9_]*)\((.*)\)$/is.exec(p);
    if (m) { embeds.push({ alias: m[1] ?? m[2], table: m[2], inner: m[3] }); continue; }
    if (p === "*") { star = true; continue; }
    if (!/^[a-z_][a-z0-9_]*$/i.test(p)) throw new Error(`pg_supabase: unsupported select "${p}"`);
    plain.push(p);
  }
  return { plain: star || plain.length === 0 ? "*" : plain, embeds };
}

function columns(sel: string): string {
  const { plain, embeds } = parseSelect(sel);
  if (embeds.length || plain === "*") return "*"; // embeds need the FK columns; projected afterwards
  return plain.map(q).join(", ");
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
  // PostgREST sends JSON strings to Postgres as text, so a `\x..` hex string is valid bytea input there.
  // PGlite binds typed params and needs bytes for bytea: convert, as Postgres' text input would.
  if (typeof v === "string" && /^\\x(?:[0-9a-f]{2})+$/i.test(v)) {
    return Uint8Array.from(v.slice(2).match(/../g)!, (h) => parseInt(h, 16));
  }
  // PostgREST turns a JSON array into a Postgres array for array columns (e.g. text[]).
  // Top-level arrays of plain values are only ever written to array columns in this codebase.
  if (Array.isArray(v) && v.every((x) => x === null || ["string", "number", "boolean"].includes(typeof x))) {
    return `{${v.map((x) => (x === null ? "NULL" : `"${String(x).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)).join(",")}}`;
  }
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
  private filters: ((params: unknown[]) => string)[] = [];
  private orders: string[] = [];
  private _offset: number | null = null;
  private countOnly = false;
  private _limit: number | null = null;
  private payload: Row[] = [];
  private onConflict: string | null = null;
  private cardinality: "one" | "maybe" | null = null;

  constructor(private db: PGlite, private mode: Mode, private table: string) {}

  select(cols = "*", opts: { count?: string; head?: boolean } = {}) {
    if (opts.head) this.countOnly = true;
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
    this.filters.push((params) => { params.push(param(val)); return `${q(col)} ${opr} $${params.length}`; });
    return this;
  }
  is(c: string, v: null | boolean) {
    this.filters.push(() => `${q(c)} IS ${v === null ? "NULL" : v ? "TRUE" : "FALSE"}`);
    return this;
  }
  in(c: string, vals: unknown[]) {
    this.filters.push((params) => {
      if (!vals.length) return "FALSE";
      return `${q(c)} IN (${vals.map((v) => { params.push(param(v)); return `$${params.length}`; }).join(", ")})`;
    });
    return this;
  }
  range(from: number, to: number) {
    this._offset = Math.trunc(from);
    this._limit = Math.trunc(to - from + 1);
    return this;
  }
  eq(c: string, v: unknown) { return this.f(c, "=", v); }
  neq(c: string, v: unknown) { return this.f(c, "<>", v); }
  gt(c: string, v: unknown) { return this.f(c, ">", v); }
  gte(c: string, v: unknown) { return this.f(c, ">=", v); }
  lt(c: string, v: unknown) { return this.f(c, "<", v); }
  lte(c: string, v: unknown) { return this.f(c, "<=", v); }
  limit(n: number) { this._limit = n; return this; }
  order(c: string, o: { ascending?: boolean; nullsFirst?: boolean } = {}) {
    const nulls = o.nullsFirst === undefined ? "" : o.nullsFirst ? " NULLS FIRST" : " NULLS LAST";
    this.orders.push(`${q(c)} ${o.ascending === false ? "DESC" : "ASC"}${nulls}`);
    return this;
  }
  maybeSingle() { this.cardinality = "maybe"; return this; }
  single() { this.cardinality = "one"; return this; }

  private build(): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    const where = this.filters.length ? " WHERE " + this.filters.map((f) => f(params)).join(" AND ") : "";
    const ret = this.returning ? ` RETURNING ${columns(this.selectCols ?? "*")}` : "";
    const t = `public.${q(this.table)}`;

    if (this.op === "select") {
      if (this.countOnly) return { sql: `SELECT count(*)::int AS count FROM ${t}${where}`, params };
      let sql = `SELECT ${columns(this.selectCols ?? "*")} FROM ${t}${where}`;
      if (this.orders.length) sql += ` ORDER BY ${this.orders.join(", ")}`;
      if (this._limit !== null) sql += ` LIMIT ${Math.trunc(this._limit)}`;
      if (this._offset !== null) sql += ` OFFSET ${this._offset}`;
      return { sql, params };
    }
    if (this.op === "delete") return { sql: `DELETE FROM ${t}${where}${ret}`, params };
    if (this.op === "update") {
      // SET placeholders must be numbered before the WHERE placeholders.
      const patch = this.payload[0];
      const p2: unknown[] = [];
      const setSql = Object.keys(patch).map((k) => { p2.push(param(patch[k])); return `${q(k)} = $${p2.length}`; }).join(", ");
      const w2 = this.filters.length ? " WHERE " + this.filters.map((f) => f(p2)).join(" AND ") : "";
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

    if (this.countOnly && this.op === "select") return { data: null as T, error: null, count: Number(rows[0]?.count ?? 0) };
    const wantsRows = this.op === "select" || this.returning;
    if (!wantsRows) return { data: null as T, error: null, status: 204 };
    if (this.selectCols) {
      try {
        rows = await this.project(rows, this.selectCols);
      } catch (e) {
        return { data: null as T, error: asPgError(e) };
      }
    }
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

  /**
   * Resolves embedded resources the way PostgREST does for this schema's FK naming:
   * many-to-one when the row has `<alias>_id` (customer:commerce_customer -> customer_id),
   * otherwise one-to-many through `<parent entity>_id` (tenancy_workspace -> tenancy_brand.workspace_id).
   */
  private async project(rows: Row[], sel: string): Promise<Row[]> {
    const { plain, embeds } = parseSelect(sel);
    if (!embeds.length) return rows;
    const parentFk = this.table.split("_").slice(1).join("_") + "_id";
    const out: Row[] = [];
    for (const r of rows) {
      const o: Row = {};
      if (plain === "*") Object.assign(o, r);
      else for (const c of plain) o[c] = r[c];
      for (const e of embeds) {
        const child = new Builder(this.db, this.mode, e.table).select(e.inner);
        if (`${e.alias}_id` in r) {
          const { data, error } = await child.eq("id", r[`${e.alias}_id`]).maybeSingle();
          if (error) throw error;
          o[e.alias] = data;
        } else {
          const { data, error } = await child.eq(parentFk, r.id);
          if (error) throw error;
          o[e.alias] = data;
        }
      }
      out.push(o);
    }
    return out;
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
    /** PostgREST /rpc/<fn> as service_role: set-returning functions yield an array of rows, others the scalar. */
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      if (!/^[a-z_][a-z0-9_]*$/i.test(fn)) throw new Error("bad rpc name");
      const keys = Object.keys(args);
      const call = `public.${q(fn)}(${keys.map((k, i) => `${q(k)} => $${i + 1}`).join(", ")})`;
      try {
        const { rows: meta } = await db.query<{ retset: boolean }>(
          "select bool_or(proretset) as retset from pg_proc where proname = $1 and pronamespace = 'public'::regnamespace",
          [fn],
        );
        const params = keys.map((k) => param(args[k]));
        if (meta[0]?.retset) return { data: (await db.query(`SELECT * FROM ${call}`, params)).rows, error: null };
        return { data: (await db.query<{ result: unknown }>(`SELECT ${call} AS result`, params)).rows[0]?.result ?? null, error: null };
      } catch (e) {
        return { data: null, error: asPgError(e) };
      }
    },
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
