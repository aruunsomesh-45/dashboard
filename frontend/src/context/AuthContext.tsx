"use client";

import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import { User, Workspace, Brand, UserRole } from "@/types/auth";
import { supabase } from "@/lib/supabaseClient";
import { firebaseAuth, googleAuthProvider } from "@/lib/firebaseClient";
import {
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
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
  signUpWithEmail: (email: string, password: string, fullName?: string, orgName?: string) => Promise<{ error: Error | null }>;
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

  const isRefreshingRef = useRef(false);
  const explicitLogout = useRef(false);

  // Preserve workspace and brand selections across reloads
  const currentWorkspaceRef = useRef<Workspace | null>(null);
  currentWorkspaceRef.current = currentWorkspace;
  const currentBrandRef = useRef<Brand | null>(null);
  currentBrandRef.current = currentBrand;

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

      // 2. Fetch directly from database
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

      // 3. Fetch memberships and workspaces
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
      // 1. Check Firebase Auth session
      if (firebaseAuth.currentUser) {
        const token = await firebaseAuth.currentUser.getIdToken();
        setAuthBearerToken(token);
        await loadUserData(firebaseAuth.currentUser.uid, firebaseAuth.currentUser.email || "");
        return;
      }

      // 2. Check Django session /api/auth/me
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

    // Listen to Firebase ID token changes (authoritative auth state)
    const unsubscribeFirebase = onIdTokenChanged(firebaseAuth, async (fbUser: FirebaseUser | null) => {
      if (fbUser) {
        try {
          const token = await fbUser.getIdToken();
          setAuthBearerToken(token);
          await loadUserData(fbUser.uid, fbUser.email || "");
          if (pathname === "/login" || pathname === "/register") {
            const next = safeNextPath(new URLSearchParams(window.location.search).get("next"));
            router.push(next);
          }
        } catch (e) {
          console.warn("Failed fetching Firebase token:", e);
        }
      } else {
        setAuthBearerToken(null);
        if (explicitLogout.current) {
          setUser(null);
          setWorkspaces([]);
          setCurrentWorkspace(null);
          setCurrentBrand(null);
          if (!isPublicRoute) {
            router.replace(loginUrlFor(pathname, "expired"));
          }
          explicitLogout.current = false;
        } else {
          await refreshAuth();
        }
      }
      setIsLoading(false);
    });

    return () => {
      unsubscribeFirebase();
    };
  }, []);

  // Firebase Google OAuth Sign-In (Pure Firebase, no Supabase redirect)
  const signInWithGoogle = async () => {
    try {
      const cred = await signInWithPopup(firebaseAuth, googleAuthProvider);
      if (cred.user) {
        const token = await cred.user.getIdToken();
        setAuthBearerToken(token);
        await loadUserData(cred.user.uid, cred.user.email || "");
        const next = safeNextPath(new URLSearchParams(window.location.search).get("next"));
        router.push(next);
        return { error: null };
      }
      return { error: null };
    } catch (fbErr: any) {
      if (fbErr?.code === "auth/popup-closed-by-user") {
        return { error: null };
      }
      if (fbErr?.code === "auth/unauthorized-domain") {
        const currentHost = typeof window !== "undefined" ? window.location.hostname : "this domain";
        return {
          error: new Error(
            `'${currentHost}' is not in Firebase authorized domains. Please add '${currentHost}' in Firebase Console -> Authentication -> Settings -> Authorized domains.`
          ),
        };
      }
      return { error: new Error(friendlyAuthError(fbErr)) };
    }
  };

  // Email/Password Sign-In (Firebase Auth primary + Django fallback)
  const signInWithEmail = async (email: string, password: string) => {
    try {
      const cleanEmail = email.trim().toLowerCase();

      // 1. Firebase Email/Password Sign-In
      try {
        const cred = await signInWithEmailAndPassword(firebaseAuth, cleanEmail, password);
        if (cred.user) {
          const token = await cred.user.getIdToken();
          setAuthBearerToken(token);
          await loadUserData(cred.user.uid, cred.user.email || "");
          const next = safeNextPath(new URLSearchParams(window.location.search).get("next"));
          router.push(next);
          return { error: null };
        }
      } catch (fbErr: any) {
        // If not credentials error (e.g. network/rate limit), abort early
        if (
          fbErr?.code !== "auth/user-not-found" &&
          fbErr?.code !== "auth/invalid-credential" &&
          fbErr?.code !== "auth/wrong-password"
        ) {
          return { error: new Error(friendlyAuthError(fbErr)) };
        }
      }

      // 2. Fallback to Django backend password authentication
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
        console.warn("Backend login check:", backendErr);
      }

      return { error: new Error("Invalid email or password.") };
    } catch (err: any) {
      return { error: new Error(friendlyAuthError(err)) };
    }
  };

  // Firebase Email/Password Sign-Up
  const signUpWithEmail = async (
    email: string,
    password: string,
    fullName?: string,
    orgName?: string
  ) => {
    try {
      const cleanEmail = email.trim().toLowerCase();
      const cred = await createUserWithEmailAndPassword(firebaseAuth, cleanEmail, password);
      if (cred.user) {
        if (fullName && fullName.trim()) {
          try {
            await updateProfile(cred.user, { displayName: fullName.trim() });
          } catch {}
        }
        const token = await cred.user.getIdToken();
        setAuthBearerToken(token);

        // If organization name provided, create workspace
        if (orgName && orgName.trim()) {
          try {
            await apiFetch("/api/w/", {
              method: "POST",
              body: JSON.stringify({ name: orgName.trim() }),
            });
          } catch (wsErr) {
            console.warn("Workspace creation on sign up:", wsErr);
          }
        }

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

  // Backward-compatibility stubs for OTP
  const signInWithOtp = async (_email: string) => {
    return {
      error: new Error("Email OTP sign-in has been upgraded to Firebase Authentication. Please sign in with your Email & Password or Google above."),
    };
  };

  const verifyOtp = async (_email: string, _token: string) => {
    return {
      error: new Error("Email OTP verification has been upgraded to Firebase Authentication. Please sign in with your Email & Password or Google."),
    };
  };

  // Logout
  const logout = async () => {
    explicitLogout.current = true;
    try {
      await firebaseSignOut(firebaseAuth);
    } catch {}
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch {}
    setAuthBearerToken(null);
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
