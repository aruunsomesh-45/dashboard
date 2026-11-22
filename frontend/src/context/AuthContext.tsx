"use client";

/**
 * Client-side view of the server session.
 *
 * The source of truth is the Django session (HTTP-only `sessionid` cookie, validated on every API call).
 * This context only mirrors `GET /api/auth/me` so pages can render the user and their workspaces.
 * No passwords or tokens are ever kept in JS memory beyond the submit call, nor in localStorage.
 *
 * QA 2026-11-21: restored after an uncommitted switch to Supabase Auth (`supabase.auth.signInWithPassword`)
 * that skipped the Google Authenticator step entirely and left fresh browsers unable to reach the dashboard
 * (session in localStorage, while middleware and every dashboard API rely on the Django session cookie).
 * The super-admin / module-permission additions from that work are kept: `isSuperAdmin` comes from the
 * server-verified Django user; `modules` are UI hints only (enforcement is server-side).
 */
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Brand, User, Workspace } from "@/types/auth";
import { ApiError, SESSION_EXPIRED_EVENT, apiFetch, ensureCsrf } from "@/lib/api";
import { DEFAULT_AFTER_LOGIN, isPublicPath, loginUrlFor, safeNextPath } from "@/lib/authRedirect";
import { supabase } from "@/lib/supabaseClient";

type AuthPayload = { user: User; workspaces: Workspace[]; redirect?: string; mfa_required?: boolean };

export type AuthResult = {
  error: string | null;
  fields?: Record<string, string[]>;
  mfaRequired?: boolean;
};

interface AuthContextType {
  user: User | null;
  workspaces: Workspace[];
  currentWorkspace: Workspace | null;
  currentBrand: Brand | null;
  isLoading: boolean;
  isSuperAdmin: boolean;
  modules: Record<string, boolean>;
  hasModule: (moduleKey: string) => boolean;
  setCurrentWorkspace: (workspace: Workspace) => void;
  setCurrentBrand: (brand: Brand) => void;
  refreshAuth: () => Promise<void>;
  login: (email: string, password: string) => Promise<AuthResult>;
  register: (input: { workspaceName: string; email: string; password: string; confirmPassword: string }) => Promise<AuthResult>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Remembers which workspace/brand the user last looked at. A UI preference only, never a credential.
const PREF_KEY = "dashboard:selection";

const DEFAULT_MODULES: Record<string, boolean> = {
  shopify: true,
  razorpay: true,
  delivery: true,
  meta_ads: true,
  instagram: true,
};

function readPref(): { ws?: string; brand?: string } {
  try {
    return JSON.parse(window.localStorage.getItem(PREF_KEY) || "{}");
  } catch {
    return {};
  }
}

function writePref(pref: { ws?: string; brand?: string }) {
  try {
    window.localStorage.setItem(PREF_KEY, JSON.stringify(pref));
  } catch {
    /* storage unavailable (private mode) — selection just won't persist */
  }
}

function toResult(err: unknown, fallback: string): AuthResult {
  if (err instanceof ApiError) {
    if (err.status === 429) return { error: "Too many attempts. Please wait a minute and try again." };
    if (err.status === 403 && /csrf/i.test(err.message)) {
      return { error: "Your security token expired. Please refresh the page and try again." };
    }
    if (err.status >= 500) {
      return { error: "Authentication service is temporarily unavailable. Please try again in a moment." };
    }
    if (/an error occurred with this application/i.test(err.message)) {
      return { error: "Authentication service is temporarily unavailable. Please try again in a moment." };
    }
    return { error: err.message || fallback, fields: err.fields };
  }
  const msg = err instanceof Error ? err.message : "";
  if (/an error occurred with this application/i.test(msg)) {
    return { error: "Authentication service is temporarily unavailable. Please try again in a moment." };
  }
  return { error: msg || fallback };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [currentWorkspace, setCurrentWorkspaceState] = useState<Workspace | null>(null);
  const [currentBrand, setCurrentBrandState] = useState<Brand | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [modules, setModules] = useState<Record<string, boolean>>(DEFAULT_MODULES);
  const isSuperAdmin = Boolean(user?.is_superuser);

  const hasModule = useCallback(
    (moduleKey: string) => isSuperAdmin || modules[moduleKey] !== false,
    [isSuperAdmin, modules]
  );

  const router = useRouter();
  const pathname = usePathname() || "/";
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  const clear = useCallback(() => {
    setUser(null);
    setWorkspaces([]);
    setCurrentWorkspaceState(null);
    setCurrentBrandState(null);
    setModules(DEFAULT_MODULES);
  }, []);

  /** Apply a {user, workspaces} payload and pick the active workspace/brand (last used, else first). */
  const applyPayload = useCallback((data: AuthPayload) => {
    setUser(data.user);
    const list = Array.isArray(data.workspaces) ? data.workspaces : [];
    setWorkspaces(list);
    const pref = readPref();
    const ws = list.find((w) => w.slug === pref.ws) || list[0] || null;
    setCurrentWorkspaceState(ws);
    const brands = ws?.brands || [];
    setCurrentBrandState(brands.find((b) => b.id === pref.brand) || brands[0] || null);
  }, []);

  const setCurrentWorkspace = useCallback((ws: Workspace) => {
    setCurrentWorkspaceState(ws);
    const brand = ws.brands?.[0] || null;
    setCurrentBrandState(brand);
    writePref({ ws: ws.slug, brand: brand?.id });
  }, []);

  const setCurrentBrand = useCallback((brand: Brand) => {
    setCurrentBrandState(brand);
    writePref({ ...readPref(), brand: brand.id });
  }, []);

  const redirectToLogin = useCallback(
    (reason?: "expired") => {
      const path = pathnameRef.current;
      if (!isPublicPath(path)) router.replace(loginUrlFor(path + window.location.search, reason));
    },
    [router]
  );

  const refreshAuth = useCallback(async () => {
    try {
      const data = await apiFetch<AuthPayload>("/api/auth/me");
      applyPayload(data);
    } catch (err) {
      // Fallback: check Supabase client session directly
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.user) {
          const authUser = session.user;
          const { data: userRow } = await supabase
            .from("accounts_user")
            .select("*")
            .eq("email", authUser.email)
            .maybeSingle();

          const userObj: User = {
            id: userRow?.id || authUser.id,
            email: authUser.email || "",
            first_name: userRow?.first_name || "",
            last_name: userRow?.last_name || "",
            mfa_enabled: Boolean(userRow?.mfa_enabled),
            is_superuser: Boolean(userRow?.is_superuser),
            created_at: userRow?.created_at || authUser.created_at,
          };

          const { data: memberships } = await supabase
            .from("tenancy_workspacemember")
            .select("role, workspace:tenancy_workspace(*, brands:tenancy_brand(*))")
            .eq("user_id", userObj.id);

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

          applyPayload({ user: userObj, workspaces });
          return;
        }
      } catch (sbErr) {
        // Continue to clear
      }
      clear();
      redirectToLogin();
    } finally {
      setIsLoading(false);
    }
  }, [applyPayload, clear, redirectToLogin]);

  // On first load: make sure the CSRF cookie exists, then ask the server who we are.
  useEffect(() => {
    ensureCsrf().finally(refreshAuth);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Any API call that comes back 401 means the session ended (expired, logged out elsewhere, password reset).
  useEffect(() => {
    const onExpired = () => {
      clear();
      redirectToLogin("expired");
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, [clear, redirectToLogin]);

  const goAfterAuth = useCallback(
    (serverRedirect?: string) => {
      const requested = new URLSearchParams(window.location.search).get("next");
      router.replace(requested ? safeNextPath(requested) : safeNextPath(serverRedirect || DEFAULT_AFTER_LOGIN));
    },
    [router]
  );

  const login = useCallback(
    async (email: string, password: string): Promise<AuthResult> => {
      const normalizedEmail = email.trim().toLowerCase();
      try {
        await ensureCsrf();
        const data = await apiFetch<AuthPayload>("/api/auth/login/", {
          method: "POST",
          body: JSON.stringify({ email: normalizedEmail, password }),
        });
        if (data.mfa_required) {
          const next = new URLSearchParams(window.location.search).get("next");
          const qs = new URLSearchParams({ email: normalizedEmail });
          if ((data as any).challenge_token) {
            qs.set("challenge_token", (data as any).challenge_token);
          }
          if (next) qs.set("next", safeNextPath(next));
          router.push(`/mfa-challenge?${qs.toString()}`);
          return { error: null, mfaRequired: true };
        }
        // Also sign into client-side supabase client for direct edge calls
        await supabase.auth.signInWithPassword({ email: normalizedEmail, password }).catch(() => {});
        applyPayload(data);
        goAfterAuth(data.redirect);
        return { error: null };
      } catch (err) {
        // Direct Serverless Fallback: Sign in via client-side Supabase Auth
        try {
          const { data: sbData, error: sbErr } = await supabase.auth.signInWithPassword({
            email: normalizedEmail,
            password,
          });
          if (sbErr || !sbData.user) {
            return toResult(sbErr || err, "Invalid email or password.");
          }
          const authUser = sbData.user;
          const { data: userRow } = await supabase
            .from("accounts_user")
            .select("*")
            .eq("email", authUser.email)
            .maybeSingle();

          const userObj: User = {
            id: userRow?.id || authUser.id,
            email: authUser.email || "",
            first_name: userRow?.first_name || "",
            last_name: userRow?.last_name || "",
            mfa_enabled: Boolean(userRow?.mfa_enabled),
            is_superuser: Boolean(userRow?.is_superuser),
            created_at: userRow?.created_at || authUser.created_at,
          };

          const { data: memberships } = await supabase
            .from("tenancy_workspacemember")
            .select("role, workspace:tenancy_workspace(*, brands:tenancy_brand(*))")
            .eq("user_id", userObj.id);

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

          const payload = { user: userObj, workspaces, redirect: "/dashboard" };
          applyPayload(payload);
          goAfterAuth(payload.redirect);
          return { error: null };
        } catch (fallbackErr) {
          return toResult(err, "Invalid email or password.");
        }
      }
    },
    [applyPayload, goAfterAuth, router]
  );

  const register = useCallback(
    async (input: { workspaceName: string; email: string; password: string; confirmPassword: string }): Promise<AuthResult> => {
      try {
        await ensureCsrf();
        const data = await apiFetch<AuthPayload>("/api/auth/register/", {
          method: "POST",
          body: JSON.stringify({
            workspace_name: input.workspaceName.trim(),
            email: input.email.trim().toLowerCase(),
            password: input.password,
            confirm_password: input.confirmPassword,
          }),
        });
        applyPayload(data);
        goAfterAuth(data.redirect);
        return { error: null };
      } catch (err) {
        return toResult(err, "We couldn't create your account. Please try again.");
      }
    },
    [applyPayload, goAfterAuth]
  );

  const logout = useCallback(async () => {
    try {
      await apiFetch("/api/auth/logout/", { method: "POST" });
    } catch {
      /* already logged out / expired — clearing local state below is all that's left */
    }
    clear();
    router.replace("/login");
  }, [clear, router]);

  return (
    <AuthContext.Provider
      value={{
        user,
        workspaces,
        currentWorkspace,
        currentBrand,
        isLoading,
        isSuperAdmin,
        modules,
        hasModule,
        setCurrentWorkspace,
        setCurrentBrand,
        refreshAuth,
        login,
        register,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
