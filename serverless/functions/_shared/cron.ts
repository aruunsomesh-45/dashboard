import { HttpError } from "./http.ts";
import { timingSafeEqual } from "./signatures.ts";

/**
 * Scheduled-sync (Supabase Cron) authorization.
 *
 * pg_cron -> public.enqueue_scheduled_syncs() -> pg_net POST with header `x-cron-secret`.
 * The secret lives in Supabase Vault (`cron_secret`) and as the Edge Function secret CRON_SECRET;
 * both must hold the same value.
 *
 * Cron mode is DISABLED unless CRON_SECRET is set and at least 32 characters long. A request that
 * presents the header with a wrong value is rejected outright (it never falls through to user auth).
 */
export const CRON_HEADER = "x-cron-secret";
const MIN_SECRET_LENGTH = 32;

export function cronSecret(): string {
  return (Deno.env.get("CRON_SECRET") ?? "").trim();
}

/** true = authenticated cron call; false = no cron header (use normal user auth); throws 401 on a bad secret. */
export function isCronRequest(req: Request, secret: string = cronSecret()): boolean {
  const presented = req.headers.get(CRON_HEADER);
  if (presented === null) return false;
  if (secret.length < MIN_SECRET_LENGTH || !timingSafeEqual(presented.trim(), secret)) {
    throw new HttpError(401, "Invalid scheduler credentials");
  }
  return true;
}
