import { createClient, SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://ybyroxyofqfpozvfedhc.supabase.co";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

let adminClientInstance: SupabaseClient | null = null;

/**
 * Server-only Supabase client initialized with the SERVICE_ROLE_KEY.
 * Never leaks to the browser bundle.
 */
export function getAdminClient(): SupabaseClient {
  if (!adminClientInstance) {
    if (!serviceRoleKey) {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured on the server");
    }
    adminClientInstance = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return adminClientInstance;
}

/**
 * Base URL of the Supabase Edge Functions, without a trailing slash. Env values are trimmed: a stray space
 * pasted into the Vercel dashboard once turned every call into `/functions/v1%20/<name>` (a silent 404).
 */
export function functionsBaseUrl(): string {
  const explicit = (process.env.NEXT_PUBLIC_FUNCTIONS_URL || "").trim();
  const project = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
  const base = explicit || (project ? `${project.replace(/\/+$/, "")}/functions/v1` : "");
  return base.replace(/\/+$/, "");
}

export function getUserClient(token: string): SupabaseClient {
  return createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
}
