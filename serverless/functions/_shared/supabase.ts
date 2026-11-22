import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.48.1";

export function getSupabaseUrl(): string {
  return (
    Deno.env.get("SUPABASE_URL") ||
    Deno.env.get("NEXT_PUBLIC_SUPABASE_URL") ||
    "https://ybyroxyofqfpozvfedhc.supabase.co"
  );
}

export function getSupabaseAnonKey(): string {
  return (
    Deno.env.get("SUPABASE_ANON_KEY") ||
    Deno.env.get("NEXT_PUBLIC_SUPABASE_ANON_KEY") ||
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlieXJveHlvZnFmcG96dmZlZGhjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQzMjg2NjksImV4cCI6MjEwOTkwNDY2OX0.tGUf2QP8SpmS0ml19cCRPJ4wdV5hW8NeWwgPCe7rA4s"
  );
}

export function getSupabaseServiceRoleKey(): string {
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_KEY") || "";
}

/**
 * Creates a user-scoped Supabase client that respects Row Level Security (RLS).
 * Requires the Authorization header (Bearer JWT) from the incoming request.
 */
export function createUserClient(req: Request): SupabaseClient {
  return createClient(getSupabaseUrl(), getSupabaseAnonKey(), {
    global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
    auth: { persistSession: false },
  });
}

/**
 * Creates an admin Supabase client with the service role key (bypasses RLS) for webhook
 * ingestion, sync writes and credential decryption.
 *
 * Fails loudly when the key is missing. (Previously this silently fell back to the anon key,
 * so every admin read/write was blocked by RLS while functions still reported success.)
 */
export function createAdminClient(): SupabaseClient {
  const serviceRoleKey = getSupabaseServiceRoleKey();
  if (!serviceRoleKey) {
    throw new Error("Server misconfiguration: SUPABASE_SERVICE_ROLE_KEY is not set");
  }
  return createClient(getSupabaseUrl(), serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
