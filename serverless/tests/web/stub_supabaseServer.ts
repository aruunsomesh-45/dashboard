// Test replacement for frontend/src/lib/supabaseServer.ts (mapped in ./deno.json).
// getAdminClient() returns the PGlite-backed service-role double installed by harness.ts.
// deno-lint-ignore no-explicit-any
export function getAdminClient(): any {
  // deno-lint-ignore no-explicit-any
  const admin = (globalThis as any).__webAdmin;
  if (!admin) throw new Error("harness: admin client not installed");
  return admin;
}

export function getUserClient(): never {
  throw new Error("harness: getUserClient is not used by the API routes");
}
