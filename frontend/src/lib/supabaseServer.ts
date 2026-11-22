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

export function getUserClient(token: string): SupabaseClient {
  return createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
}
