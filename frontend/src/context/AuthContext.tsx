"use client";

/**
 * Client-side view of the server session.
 *
 * The source of truth is the server session: Supabase Auth tokens in HTTP-only cookies, set by
 * /api/auth/login (or /api/v1/auth/mfa/verify for 2FA users) and validated on every API call.
 * This context only mirrors `GET /api/auth/me` so pages can render the user and their workspaces.
 * The browser never holds a Supabase session of its own: a client-side password sign-in would bypass
 * two-factor authentication, so Edge Functions are reached through the /api/fn proxy instead.
 */
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Brand, User, Workspace } from "@/types/auth";
import { ApiError, SESSION_EXPIRED_EVENT, apiFetch, ensureCsrf } from "@/lib/api";
import { DEFAULT_AFTER_LOGIN, isPublicPath, loginUrlFor, safeNextPath } from "@/lib/authRedirect";

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
    } catch {
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
        applyPayload(data);
        goAfterAuth(data.redirect);
        return { error: null };
      } catch (err) {
        return toResult(err, "Invalid email or password.");
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
        if ((data as any).confirmation_required) {
          // Email confirmation is on: there is no session until the emailed link is clicked.
          return { error: (data as any).message || "Check your email to confirm your address, then sign in." };
        }
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
