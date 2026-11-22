import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://ybyroxyofqfpozvfedhc.supabase.co";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

let adminClientInstance: SupabaseClient | null = null;

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

export interface AdminAuthResult {
  authorized: boolean;
  user?: {
    id: string;
    email: string;
    is_superuser: boolean;
    first_name?: string;
    last_name?: string;
  };
  error?: string;
  status?: number;
}

/**
 * Server-side verification that the caller possesses a valid Supabase JWT AND has is_superuser = true.
 * NEVER trusts client-side state.
 */
export async function verifySuperAdmin(req: NextRequest): Promise<AdminAuthResult> {
  const authHeader = req.headers.get("Authorization") || "";
  const match = authHeader.match(/^Bearer\s+(\S+)$/i);
  if (!match) {
    return { authorized: false, error: "Missing or malformed Authorization header", status: 401 };
  }
  const token = match[1];

  const admin = getAdminClient();
  const { data: authData, error: authError } = await admin.auth.getUser(token);

  if (authError || !authData?.user) {
    return { authorized: false, error: "Invalid or expired session token", status: 401 };
  }

  const userId = authData.user.id;

  // Query accounts_user table with service role client to check is_superuser
  const { data: userProfile, error: profileError } = await admin
    .from("accounts_user")
    .select("id, email, is_active, is_superuser, first_name, last_name")
    .eq("id", userId)
    .single();

  if (profileError || !userProfile) {
    return { authorized: false, error: "User account not found", status: 403 };
  }

  if (!userProfile.is_active) {
    return { authorized: false, error: "User account is suspended", status: 403 };
  }

  if (!userProfile.is_superuser) {
    return { authorized: false, error: "Access Denied: Super Admin privileges required", status: 403 };
  }

  return {
    authorized: true,
    user: {
      id: userProfile.id,
      email: userProfile.email,
      is_superuser: userProfile.is_superuser,
      first_name: userProfile.first_name,
      last_name: userProfile.last_name,
    },
  };
}

/**
 * Logs an administrative action into the public.admin_audit_logs table.
 */
export async function logAdminAudit(
  adminUserId: string,
  action: string,
  options: {
    targetUserId?: string | null;
    targetWorkspaceId?: string | null;
    metadata?: Record<string, any>;
    ipAddress?: string | null;
  } = {}
) {
  try {
    const admin = getAdminClient();
    await admin.from("admin_audit_logs").insert({
      admin_user_id: adminUserId,
      action,
      target_user_id: options.targetUserId || null,
      target_workspace_id: options.targetWorkspaceId || null,
      metadata: options.metadata || {},
      ip_address: options.ipAddress || null,
    });
  } catch (err) {
    console.error("Failed to write admin audit log:", err);
  }
}
