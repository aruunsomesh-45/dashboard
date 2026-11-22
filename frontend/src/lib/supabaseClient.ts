import { createClient } from "@supabase/supabase-js";

const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://ybyroxyofqfpozvfedhc.supabase.co";

const supabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlieXJveHlvZnFmcG96dmZlZGhjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQzMjg2NjksImV4cCI6MjEwOTkwNDY2OX0.tGUf2QP8SpmS0ml19cCRPJ4wdV5hW8NeWwgPCe7rA4s";

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
