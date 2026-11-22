/**
 * Injectable dependencies for every Edge Function handler. Production uses `defaultDeps()`;
 * tests substitute a PGlite-backed Supabase client and a scripted `fetch`.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.48.1";
import { createAdminClient, createUserClient } from "./supabase.ts";
import { defaultSleep, type FetchFn, type SleepFn } from "./upstream.ts";

export interface Deps {
  userClient: (req: Request) => SupabaseClient;
  adminClient: () => SupabaseClient;
  fetch: FetchFn;
  sleep: SleepFn;
}

export function defaultDeps(): Deps {
  return {
    userClient: createUserClient,
    adminClient: createAdminClient,
    fetch: (input, init) => fetch(input, init),
    sleep: defaultSleep,
  };
}
