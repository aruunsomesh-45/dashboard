import { createClient } from "@supabase/supabase-js";

// Only the public anon key is ever used in the browser. The service-role key must
// never be referenced from frontend code. No hard-coded fallbacks: a missing
// configuration should fail loudly instead of silently pointing at another project.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. Set them in frontend/.env.local."
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false, // the /auth/callback page performs the PKCE exchange explicitly
    flowType: "pkce",
  },
});
