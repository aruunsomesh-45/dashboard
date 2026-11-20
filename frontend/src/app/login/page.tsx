"use client";

import React, { useState, useEffect, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { friendlyAuthError } from "@/lib/authErrors";
import {
  Mail,
  Lock,
  ArrowRight,
  Loader2,
  AlertCircle,
  Building2,
} from "lucide-react";

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { signInWithGoogle, signInWithEmail } = useAuth();

  const [email, setEmail] = useState("aruunsomesh@gmail.com");
  const [password, setPassword] = useState("125EastSecure2026!");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const paramEmail = searchParams.get("email");
    const storedEmail =
      typeof window !== "undefined" ? localStorage.getItem("app_pending_email") : null;

    const targetEmail = paramEmail || storedEmail || "";
    if (targetEmail) {
      setEmail(targetEmail);
    }

    if (searchParams.get("reason") === "expired") {
      setError("Your session expired. Please sign in again.");
    }
  }, [searchParams]);

  // Google OAuth Sign-In (Pure Firebase)
  const handleGoogleSignIn = async () => {
    setError(null);
    setIsLoading(true);
    const { error: oauthError } = await signInWithGoogle();
    if (oauthError) {
      setError(oauthError.message || friendlyAuthError(oauthError));
      setIsLoading(false);
    }
  };

  // Email + Password Sign-In
  const handlePasswordSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setError("Please enter both email and password.");
      return;
    }

    setError(null);
    setIsLoading(true);

    const { error: loginError } = await signInWithEmail(email, password);
    setIsLoading(false);

    if (loginError) {
      setError(loginError.message || "Invalid email or password.");
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-ivory-100 p-4 font-sans">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-xl border border-ivory-300 p-8 space-y-6">
        {/* Brand Header */}
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-terracotta-500 flex items-center justify-center text-white font-bold text-lg shadow-sm">
            <Building2 className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-charcoal-900">
              Dashboard
            </h1>
            <p className="text-xs text-charcoal-500">
              Multi-Tenant Workspace Cockpit
            </p>
          </div>
        </div>

        {/* Status Alerts */}
        {error && (
          <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 flex items-start space-x-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-red-600" />
            <div className="flex-1 space-y-1">
              <p className="font-semibold">Authentication Notice</p>
              <p className="text-[11px] leading-relaxed text-red-600">{error}</p>
            </div>
          </div>
        )}

        {/* Method 1: Google OAuth Button */}
        <div>
          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={isLoading}
            className="w-full flex items-center justify-center space-x-3 px-4 py-2.5 rounded-xl border border-ivory-300 bg-white hover:bg-ivory-50 text-xs font-semibold text-charcoal-800 transition-all shadow-sm hover:shadow"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24">
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="#FBBC05"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
              />
              <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
              />
            </svg>
            <span>Continue with Google</span>
          </button>
        </div>

        <div className="relative flex items-center justify-center">
          <div className="border-t border-ivory-300 w-full" />
          <span className="bg-white px-3 text-[10px] uppercase tracking-wider text-charcoal-400 font-semibold absolute">
            or sign in with credentials
          </span>
        </div>

        {/* Email + Password Form */}
        <form onSubmit={handlePasswordSignIn} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-charcoal-700 mb-1">
              Work Email Address
            </label>
            <div className="relative">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="aruunsomesh@gmail.com"
                className="w-full pl-9 pr-3 py-2 text-xs rounded-lg border border-ivory-300 bg-white focus:outline-none focus:ring-2 focus:ring-terracotta-500/20 focus:border-terracotta-500 text-charcoal-900"
              />
              <Mail className="w-4 h-4 text-charcoal-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-semibold text-charcoal-700">
                Password
              </label>
            </div>
            <div className="relative">
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                className="w-full pl-9 pr-3 py-2 text-xs rounded-lg border border-ivory-300 bg-white focus:outline-none focus:ring-2 focus:ring-terracotta-500/20 focus:border-terracotta-500 text-charcoal-900"
              />
              <Lock className="w-4 h-4 text-charcoal-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>
          </div>

          <button
            type="submit"
            disabled={isLoading || !email || !password}
            className="w-full flex items-center justify-center space-x-2 py-2.5 px-4 rounded-xl bg-forest-900 hover:bg-forest-800 text-ivory-100 text-xs font-bold transition-colors shadow-sm disabled:opacity-50"
          >
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Signing In...</span>
              </>
            ) : (
              <>
                <span>Sign In to Cockpit</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>

        {/* Footer Links */}
        <div className="pt-2 border-t border-ivory-200 text-center text-xs text-charcoal-500">
          <span>Don&apos;t have an account? </span>
          <Link href="/register" className="font-semibold text-terracotta-600 hover:underline">
            Register your Brand
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-ivory-100 p-4 font-sans">
          <div className="max-w-md w-full bg-white rounded-2xl shadow-xl border border-ivory-300 p-8 text-center space-y-4">
            <Loader2 className="w-8 h-8 text-terracotta-500 animate-spin mx-auto" />
            <h2 className="text-sm font-bold text-charcoal-900">Loading Cockpit...</h2>
          </div>
        </div>
      }
    >
      <LoginContent />
    </Suspense>
  );
}
