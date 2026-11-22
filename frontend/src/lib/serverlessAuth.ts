import { getAdminClient } from "./supabaseServer";
import { createClient } from "@supabase/supabase-js";
import { User, Workspace } from "@/types/auth";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://ybyroxyofqfpozvfedhc.supabase.co";
const anonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlieXJveHlvZnFmcG96dmZlZGhjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQzMjg2NjksImV4cCI6MjEwOTkwNDY2OX0.tGUf2QP8SpmS0ml19cCRPJ4wdV5hW8NeWwgPCe7rA4s";

export function getPublicAuthClient() {
  return createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false },
  });
}

export async function getAuthPayloadForUser(authUser: { id: string; email?: string | null; created_at: string }): Promise<{
  user: User;
  workspaces: Workspace[];
}> {
  const admin = getAdminClient();
  const email = authUser.email || "";

  // Fetch user record from accounts_user
  let { data: userRow } = await admin
    .from("accounts_user")
    .select("*")
    .eq("email", email)
    .maybeSingle();

  if (!userRow) {
    const { data: newUser } = await admin
      .from("accounts_user")
      .insert({
        id: authUser.id,
        email,
        password: "supabase_auth_managed",
        is_active: true,
        is_staff: false,
        is_superuser: false,
      })
      .select()
      .maybeSingle();
    userRow = newUser;
  }

  const user: User = {
    id: userRow?.id || authUser.id,
    email,
    first_name: userRow?.first_name || "",
    last_name: userRow?.last_name || "",
    mfa_enabled: Boolean(userRow?.mfa_enabled),
    is_superuser: Boolean(userRow?.is_superuser),
    created_at: userRow?.created_at || authUser.created_at,
  };

  // Fetch workspaces & brands
  const { data: memberships } = await admin
    .from("tenancy_workspacemember")
    .select("role, workspace:tenancy_workspace(*, brands:tenancy_brand(*))")
    .eq("user_id", user.id);

  const workspaces: Workspace[] = (memberships || [])
    .filter((m: any) => m.workspace)
    .map((m: any) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      slug: m.workspace.slug,
      role: m.role,
      brands: (m.workspace.brands || []).map((b: any) => ({
        id: b.id,
        name: b.name,
        currency: b.currency,
        timezone: b.timezone,
      })),
    }));

  return { user, workspaces };
}
