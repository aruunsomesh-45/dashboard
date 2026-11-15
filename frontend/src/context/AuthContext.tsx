"use client";

import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import { User, Workspace, Brand, UserRole } from "@/types/auth";
import { supabase } from "@/lib/supabaseClient";
import { useRouter, usePathname } from "next/navigation";
import { ensureCsrf, apiFetch } from "@/lib/api";
import { loginUrlFor, safeNextPath } from "@/lib/authRedirect";
import { friendlyAuthError } from "@/lib/authErrors";

interface AuthContextType {
  user: User | null;
  workspaces: Workspace[];
  currentWorkspace: Workspace | null;
  currentBrand: Brand | null;
  isLoading: boolean;
  setCurrentWorkspace: (workspace: Workspace) => void;
  setCurrentBrand: (brand: Brand) => void;
  refreshAuth: () => Promise<void>;
  signInWithGoogle: () => Promise<{ error: Error | null }>;
  signInWithOtp: (email: string) => Promise<{ error: Error | null }>;
  verifyOtp: (email: string, token: string) => Promise<{ error: Error | null }>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [currentWorkspace, setCurrentWorkspace] = useState<Workspace | null>(null);
  const [currentBrand, setCurrentBrand] = useState<Brand | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const router = useRouter();
  const pathname = usePathname();
  const explicitLogout = useRef(false);

  const isPublicRoute =
    pathname === "/login" ||
    pathname === "/register" ||
    pathname === "/mfa-challenge" ||
    pathname === "/auth/callback" ||
    pathname.startsWith("/invites");

  // Load workspace and user profile given a Supabase session
  const loadUserData = useCallback(async (sessionUserId: string, email: string) => {
    try {
      // 1. Fetch user profile from public.accounts_user
      const { data: profile } = await supabase
        .from("accounts_user")
        .select("id, email, first_name, last_name, mfa_enabled, created_at")
        .eq("id", sessionUserId)
        .single();

      const resolvedUser: User = {
        id: sessionUserId,
        email: profile?.email || email,
        first_name: profile?.first_name || "",
        last_name: profile?.last_name || "",
        mfa_enabled: profile?.mfa_enabled || false,
        created_at: profile?.created_at || new Date().toISOString(),
      };
      setUser(resolvedUser);

      // 2. Fetch memberships and workspaces
      const { data: memberRows, error: memberErr } = await supabase
        .from("tenancy_workspacemember")
        .select(`
          role,
          workspace:tenancy_workspace (
            id,
            name,
            slug
          )
        `)
        .eq("user_id", sessionUserId);

      if (!memberErr && memberRows && memberRows.length > 0) {
        const loadedWorkspaces: Workspace[] = [];

        for (const row of memberRows as any[]) {
          if (!row.workspace) continue;
          
          // Fetch brands for this workspace
          const { data: brandRows } = await supabase
            .from("tenancy_brand")
            .select("id, name, currency, timezone")
            .eq("workspace_id", row.workspace.id);

          loadedWorkspaces.push({
            id: row.workspace.id,
            name: row.workspace.name,
            slug: row.workspace.slug,
            role: row.role as UserRole,
            brands: brandRows || [],
          });
        }

        setWorkspaces(loadedWorkspaces);

        if (loadedWorkspaces.length > 0) {
          const activeWs = currentWorkspace
            ? loadedWorkspaces.find((w) => w.id === currentWorkspace.id) || loadedWorkspaces[0]
            : loadedWorkspaces[0];
          setCurrentWorkspace(activeWs);

          if (activeWs.brands && activeWs.brands.length > 0) {
            const activeBrand = currentBrand
              ? activeWs.brands.find((b) => b.id === currentBrand.id) || activeWs.brands[0]
              : activeWs.brands[0];
            setCurrentBrand(activeBrand);
          }
        }
      } else {
        // Fallback to Django API /api/w for local development / SQLite
        try {
          const wsList = await apiFetch<any[]>("/api/w");
          if (Array.isArray(wsList) && wsList.length > 0) {
            const loadedWorkspaces: Workspace[] = wsList.map((ws: any) => ({
              id: ws.id,
              name: ws.name,
              slug: ws.slug,
              role: (ws.role || "owner") as UserRole,
              brands: ws.brands || [],
            }));
            setWorkspaces(loadedWorkspaces);
            const activeWs = currentWorkspace
              ? loadedWorkspaces.find((w) => w.id === currentWorkspace.id) || loadedWorkspaces[0]
              : loadedWorkspaces[0];
            setCurrentWorkspace(activeWs);
            if (activeWs.brands && activeWs.brands.length > 0) {
              const activeBrand = currentBrand
                ? activeWs.brands.find((b) => b.id === currentBrand.id) || activeWs.brands[0]
                : activeWs.brands[0];
              setCurrentBrand(activeBrand);
            }
          }
        } catch {
          // Non-fatal fallback
        }
      }
    } catch (err) {
      console.error("Error loading user organizations:", err);
    }
  }, [currentWorkspace, currentBrand]);

  const refreshAuth = useCallback(async () => {
    try {
      const { data: { session }, error } = await supabase.auth.getSession();
      if (error || !session?.user) {
        // Fallback to Django /api/auth/me in development
        try {
          const meData = await apiFetch<any>("/api/auth/me");
          if (meData?.user) {
            setUser(meData.user);
            if (meData.workspaces && meData.workspaces.length > 0) {
              setWorkspaces(meData.workspaces);
              const activeWs = currentWorkspace
                ? meData.workspaces.find((w: any) => w.id === currentWorkspace.id) || meData.workspaces[0]
                : meData.workspaces[0];
              setCurrentWorkspace(activeWs);
              if (activeWs.brands && activeWs.brands.length > 0) {
                const activeBrand = currentBrand
                  ? activeWs.brands.find((b: any) => b.id === currentBrand.id) || activeWs.brands[0]
                  : activeWs.brands[0];
                setCurrentBrand(activeBrand);
              }
            }
            return;
          }
        } catch {}

        setUser(null);
        setWorkspaces([]);
        setCurrentWorkspace(null);
        setCurrentBrand(null);
        if (!isPublicRoute) {
          router.replace(loginUrlFor(pathname));
        }
        return;
      }

      await loadUserData(session.user.id, session.user.email || "");
    } catch {
      setUser(null);
      if (!isPublicRoute) {
        router.replace(loginUrlFor(pathname));
      }
    } finally {
      setIsLoading(false);
    }
  }, [isPublicRoute, loadUserData, router, pathname]);

  useEffect(() => {
    ensureCsrf();
    refreshAuth();

    // Listen to Supabase Auth state changes (OAuth redirects, token refresh, logout)
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        // Never await Supabase calls directly inside this callback (it holds the auth
        // lock); defer to the next tick instead.
        if (event === "SIGNED_IN" && session?.user) {
          const uid = session.user.id;
          const mail = session.user.email || "";
          setTimeout(async () => {
            await loadUserData(uid, mail);
            if (pathname === "/login" || pathname === "/register") {
              const next = safeNextPath(new URLSearchParams(window.location.search).get("next"));
              router.push(next);
            }
          }, 0);
        } else if (event === "SIGNED_OUT") {
          setUser(null);
          setWorkspaces([]);
          setCurrentWorkspace(null);
          setCurrentBrand(null);
          if (!isPublicRoute) {
            // Session ended without an explicit logout (expired / revoked refresh token).
            router.replace(loginUrlFor(pathname, explicitLogout.current ? undefined : "expired"));
            explicitLogout.current = false;
          }
        } else if (event === "TOKEN_REFRESHED" && session?.user) {
          const uid = session.user.id;
          const mail = session.user.email || "";
          setTimeout(() => { loadUserData(uid, mail); }, 0);
        }
      }
    );

    return () => {
      subscription.unsubscribe();
    };
  }, [pathname]);

  // A. Google OAuth Sign-In
  const signInWithGoogle = async () => {
    try {
      const origin = window.location.origin;
      const next = safeNextPath(new URLSearchParams(window.location.search).get("next"));
      const nextQuery = next === "/" ? "" : `?next=${encodeURIComponent(next)}`;
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${origin}/auth/callback${nextQuery}`,
          queryParams: {
            // Identity only: no offline refresh token is needed (we never call Google APIs),
            // and select_account avoids silently reusing the wrong Google session.
            prompt: "select_account",
          },
        },
      });
      return { error: error ? new Error(friendlyAuthError(error)) : null };
    } catch (err: any) {
      return { error: err };
    }
  };

  // B. Email OTP Sign-In Request
  const signInWithOtp = async (email: string) => {
    try {
      const origin = window.location.origin;
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim().toLowerCase(),
        options: {
          emailRedirectTo: `${origin}/auth/callback`,
          shouldCreateUser: true,
        },
      });
      return { error: error ? new Error(friendlyAuthError(error)) : null };
    } catch (err: any) {
      return { error: new Error(friendlyAuthError(err)) };
    }
  };

  // B. Email OTP Verification
  const verifyOtp = async (email: string, token: string) => {
    try {
      const { data, error } = await supabase.auth.verifyOtp({
        email: email.trim().toLowerCase(),
        token: token.trim(),
        type: "email",
      });

      if (error) {
        return { error: new Error(friendlyAuthError(error)) };
      }

      if (data.session?.user) {
        await loadUserData(data.session.user.id, data.session.user.email || "");
        router.push(safeNextPath(new URLSearchParams(window.location.search).get("next")));
      }

      return { error: null };
    } catch (err: any) {
      return { error: new Error(friendlyAuthError(err)) };
    }
  };

  // Logout
  const logout = async () => {
    explicitLogout.current = true;
    try {
      await supabase.auth.signOut();
    } finally {
      setUser(null);
      setWorkspaces([]);
      setCurrentWorkspace(null);
      setCurrentBrand(null);
      router.push("/login");
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        workspaces,
        currentWorkspace,
        currentBrand,
        isLoading,
        setCurrentWorkspace,
        setCurrentBrand,
        refreshAuth,
        signInWithGoogle,
        signInWithOtp,
        verifyOtp,
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
