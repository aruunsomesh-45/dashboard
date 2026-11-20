"use client";

import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import { User, Workspace, Brand, UserRole } from "@/types/auth";
import { supabase } from "@/lib/supabaseClient";
import { firebaseAuth, googleAuthProvider } from "@/lib/firebaseClient";
import {
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as firebaseSignOut,
  onIdTokenChanged,
  User as FirebaseUser,
} from "firebase/auth";
import { useRouter, usePathname } from "next/navigation";
import { ensureCsrf, apiFetch, setAuthBearerToken } from "@/lib/api";
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
  signInWithEmail: (email: string, password: string) => Promise<{ error: Error | null }>;
  signUpWithEmail: (email: string, password: string) => Promise<{ error: Error | null }>;
  signInWithOtp: (email: string) => Promise<{ error: Error | null }>;
  verifyOtp: (email: string, token: string) => Promise<{ error: Error | null }>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const getAppOrigin = (): string => {
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  }
  if (typeof window !== "undefined" && window.location.origin) {
    return window.location.origin;
  }
  return "https://125east-dashboard.vercel.app";
};

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [currentWorkspace, setCurrentWorkspace] = useState<Workspace | null>(null);
  const [currentBrand, setCurrentBrand] = useState<Brand | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const router = useRouter();
  const pathname = usePathname();
  const explicitLogout = useRef(false);
  const isRefreshingRef = useRef(false);
  const currentWorkspaceRef = useRef<Workspace | null>(null);
  const currentBrandRef = useRef<Brand | null>(null);

  useEffect(() => {
    currentWorkspaceRef.current = currentWorkspace;
  }, [currentWorkspace]);

  useEffect(() => {
    currentBrandRef.current = currentBrand;
  }, [currentBrand]);

  const isPublicRoute =
    pathname === "/login" ||
    pathname === "/register" ||
    pathname === "/mfa-challenge" ||
    pathname === "/auth/callback" ||
    pathname.startsWith("/invites");

  // Load workspace and user profile given a user ID & email
  const loadUserData = useCallback(async (userId: string, email: string) => {
    try {
      // 1. Fetch user profile from Django /api/auth/me (fast single DB query)
      try {
        const meData = await apiFetch<any>("/api/auth/me");
        if (meData?.user) {
          setUser(meData.user);
          if (Array.isArray(meData.workspaces) && meData.workspaces.length > 0) {
            setWorkspaces(meData.workspaces);
            const activeWs = currentWorkspaceRef.current
              ? meData.workspaces.find((w: any) => w.id === currentWorkspaceRef.current?.id || w.slug === currentWorkspaceRef.current?.slug) || meData.workspaces[0]
              : meData.workspaces[0];
            setCurrentWorkspace(activeWs);

            if (activeWs.brands && activeWs.brands.length > 0) {
              const activeBrand = currentBrandRef.current
                ? activeWs.brands.find((b: any) => b.id === currentBrandRef.current?.id) || activeWs.brands[0]
                : activeWs.brands[0];
              setCurrentBrand(activeBrand);
            }
            return;
          }
        }
      } catch {
        // Fallback to direct DB query if Django me endpoint was unreachable
      }

      const { data: profile } = await supabase
        .from("accounts_user")
        .select("id, email, first_name, last_name, mfa_enabled, created_at")
        .eq("email", email)
        .single();

      const resolvedUser: User = {
        id: profile?.id || userId,
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
        .eq("user_id", resolvedUser.id);

      if (!memberErr && memberRows && memberRows.length > 0) {
        const loadedWorkspaces: Workspace[] = [];

        for (const row of memberRows as any[]) {
          if (!row.workspace) continue;

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
          const activeWs = currentWorkspaceRef.current
            ? loadedWorkspaces.find((w) => w.id === currentWorkspaceRef.current?.id || w.slug === currentWorkspaceRef.current?.slug) || loadedWorkspaces[0]
            : loadedWorkspaces[0];
          setCurrentWorkspace(activeWs);

          if (activeWs.brands && activeWs.brands.length > 0) {
            const activeBrand = currentBrandRef.current
              ? activeWs.brands.find((b) => b.id === currentBrandRef.current?.id) || activeWs.brands[0]
              : activeWs.brands[0];
            setCurrentBrand(activeBrand);
          }
        }
      }
    } catch (err) {
      console.error("Error loading user organizations:", err);
    }
  }, []);

  const refreshAuth = useCallback(async () => {
    if (isRefreshingRef.current) return;
    isRefreshingRef.current = true;
    try {
      // Check Firebase auth first
      if (firebaseAuth.currentUser) {
        const token = await firebaseAuth.currentUser.getIdToken();
        setAuthBearerToken(token);
        await loadUserData(firebaseAuth.currentUser.uid, firebaseAuth.currentUser.email || "");
        return;
      }

      // Check Django session /api/auth/me
      try {
        const meData = await apiFetch<any>("/api/auth/me");
        if (meData?.user) {
          setUser(meData.user);
          if (meData.workspaces && meData.workspaces.length > 0) {
            setWorkspaces(meData.workspaces);
            const activeWs = currentWorkspaceRef.current
              ? meData.workspaces.find((w: any) => w.id === currentWorkspaceRef.current?.id || w.slug === currentWorkspaceRef.current?.slug) || meData.workspaces[0]
              : meData.workspaces[0];
            setCurrentWorkspace(activeWs);
            if (activeWs.brands && activeWs.brands.length > 0) {
              const activeBrand = currentBrandRef.current
                ? activeWs.brands.find((b: any) => b.id === currentBrandRef.current?.id) || activeWs.brands[0]
                : activeWs.brands[0];
              setCurrentBrand(activeBrand);
            }
          }
          return;
        }
      } catch {}

      // Check Supabase session
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        await loadUserData(session.user.id, session.user.email || "");
        return;
      }

      setUser(null);
      setWorkspaces([]);
      setCurrentWorkspace(null);
      setCurrentBrand(null);
      if (!isPublicRoute) {
        router.replace(loginUrlFor(pathname));
      }
    } catch {
      setUser(null);
      if (!isPublicRoute) {
        router.replace(loginUrlFor(pathname));
      }
    } finally {
      setIsLoading(false);
      isRefreshingRef.current = false;
    }
  }, [isPublicRoute, pathname, router, loadUserData]);

  useEffect(() => {
    ensureCsrf();
    refreshAuth();

    // Listen to Firebase ID token changes
    const unsubscribeFirebase = onIdTokenChanged(firebaseAuth, async (fbUser: FirebaseUser | null) => {
      if (fbUser) {
        const token = await fbUser.getIdToken();
        setAuthBearerToken(token);
        await loadUserData(fbUser.uid, fbUser.email || "");
        if (pathname === "/login" || pathname === "/register") {
          const next = safeNextPath(new URLSearchParams(window.location.search).get("next"));
          router.push(next);
        }
      } else {
        setAuthBearerToken(null);
      }
    });

    // Listen to Supabase Auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
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
            router.replace(loginUrlFor(pathname, explicitLogout.current ? undefined : "expired"));
            explicitLogout.current = false;
          }
        }
      }
    );

    return () => {
      unsubscribeFirebase();
      subscription.unsubscribe();
    };
  }, []); // Only runs ONCE on mount!

  // Firebase / Google OAuth Sign-In
  const signInWithGoogle = async () => {
    try {
      try {
        const cred = await signInWithPopup(firebaseAuth, googleAuthProvider);
        if (cred.user) {
          await loadUserData(cred.user.uid, cred.user.email || "");
          const next = safeNextPath(new URLSearchParams(window.location.search).get("next"));
          router.push(next);
          return { error: null };
        }
      } catch (fbErr: any) {
        if (fbErr?.code === "auth/popup-closed-by-user") {
          return { error: null }; // User closed popup intentionally
        }
        if (fbErr?.code === "auth/unauthorized-domain") {
          const currentHost = typeof window !== "undefined" ? window.location.hostname : "this domain";
          return {
            error: new Error(
              `'${currentHost}' is not in Firebase authorized domains. Please add '${currentHost}' in Firebase Console -> Authentication -> Settings -> Authorized domains.`
            ),
          };
        }
        console.warn("Firebase Google popup error:", fbErr);
        if (fbErr?.code && !fbErr.message?.includes("API key not valid")) {
          return { error: new Error(friendlyAuthError(fbErr)) };
        }
      }

      // Fallback to Supabase OAuth if Firebase not configured
      const origin = getAppOrigin();
      const next = safeNextPath(new URLSearchParams(window.location.search).get("next"));
      const nextQuery = next === "/" ? "" : `?next=${encodeURIComponent(next)}`;
      const { data: oauthData, error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${origin}/auth/callback${nextQuery}`,
          queryParams: { prompt: "select_account" },
          skipBrowserRedirect: true,
        },
      });

      if (oauthError) {
        return {
          error: new Error(
            "Google Sign-In is not enabled yet in your Supabase project (Authentication -> Providers -> Google). Please sign in with Email & Password or Email OTP."
          ),
        };
      }

      if (oauthData?.url) {
        try {
          const probe = await fetch(oauthData.url);
          if (!probe.ok) {
            const errJson = await probe.json().catch(() => null);
            if (errJson?.msg?.includes("not enabled") || errJson?.error_code === "validation_failed") {
              return {
                error: new Error(
                  "Google Sign-In is not enabled yet in your Supabase project (Authentication -> Providers -> Google). Please sign in using Email OTP or Email & Password below."
                ),
              };
            }
          }
        } catch {
          // Non-fatal probe fallback
        }
        window.location.href = oauthData.url;
        return { error: null };
      }

      return { error: null };
    } catch (err: any) {
      return { error: err };
    }
  };

  // Email/Password Sign-In (Unified Django Backend + Supabase + Firebase sync)
  const signInWithEmail = async (email: string, password: string) => {
    try {
      const cleanEmail = email.trim().toLowerCase();

      // 1. Authenticate with Django Backend directly (if available)
      try {
        await ensureCsrf();
        const res = await apiFetch<any>("/api/auth/login/", {
          method: "POST",
          body: JSON.stringify({ email: cleanEmail, password }),
        });

        if (res?.mfa_required) {
          router.push(`/mfa-challenge?email=${encodeURIComponent(cleanEmail)}`);
          return { error: null };
        }

        if (res?.user) {
          setUser(res.user);
          if (Array.isArray(res.workspaces) && res.workspaces.length > 0) {
            setWorkspaces(res.workspaces);
            const activeWs = res.workspaces[0];
            setCurrentWorkspace(activeWs);
            if (activeWs.brands && activeWs.brands.length > 0) {
              setCurrentBrand(activeWs.brands[0]);
            }
          }
          const next = safeNextPath(new URLSearchParams(window.location.search).get("next"));
          router.push(next);
          return { error: null };
        }
      } catch (backendErr: any) {
        console.warn("Backend password login error, trying Supabase fallback:", backendErr);
      }

      // 2. Supabase Email/Password Direct Sign-In (Works on Vercel deployment)
      try {
        const { data: supaData, error: supaErr } = await supabase.auth.signInWithPassword({
          email: cleanEmail,
          password,
        });

        if (!supaErr && supaData?.user) {
          await loadUserData(supaData.user.id, supaData.user.email || "");
          const next = safeNextPath(new URLSearchParams(window.location.search).get("next"));
          router.push(next);
          return { error: null };
        }
        if (supaErr && !supaErr.message.toLowerCase().includes("invalid login credentials")) {
          console.warn("Supabase auth notice:", supaErr.message);
        }
      } catch (supaEx: any) {
        console.warn("Supabase login exception:", supaEx);
      }

      // 3. Firebase Email/Password Fallback
      try {
        const cred = await signInWithEmailAndPassword(firebaseAuth, cleanEmail, password);
        if (cred.user) {
          await loadUserData(cred.user.uid, cred.user.email || "");
          const next = safeNextPath(new URLSearchParams(window.location.search).get("next"));
          router.push(next);
          return { error: null };
        }
      } catch (fbErr: any) {
        return { error: new Error(friendlyAuthError(fbErr)) };
      }

      return { error: new Error("Invalid email or password. Please verify your credentials or use Email OTP.") };
    } catch (err: any) {
      return { error: new Error(friendlyAuthError(err)) };
    }
  };

  // Firebase Email/Password Sign-Up
  const signUpWithEmail = async (email: string, password: string) => {
    try {
      const cred = await createUserWithEmailAndPassword(firebaseAuth, email.trim().toLowerCase(), password);
      if (cred.user) {
        await loadUserData(cred.user.uid, cred.user.email || "");
        const next = safeNextPath(new URLSearchParams(window.location.search).get("next"));
        router.push(next);
        return { error: null };
      }
      return { error: null };
    } catch (err: any) {
      return { error: new Error(friendlyAuthError(err)) };
    }
  };

  // Email OTP Sign-In Request (Supabase Passwordless)
  const signInWithOtp = async (email: string) => {
    try {
      const origin = getAppOrigin();
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

  // Email OTP Verification (Supabase Passwordless)
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
      await firebaseSignOut(firebaseAuth);
    } catch {}
    try {
      await supabase.auth.signOut();
    } catch {}
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch {}
    setUser(null);
    setWorkspaces([]);
    setCurrentWorkspace(null);
    setCurrentBrand(null);
    router.push("/login");
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
        signInWithEmail,
        signUpWithEmail,
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
