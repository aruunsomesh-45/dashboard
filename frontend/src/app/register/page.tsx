"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { friendlyAuthError } from "@/lib/authErrors";
import { Building2, Mail, User as UserIcon, Lock, ArrowRight, Loader2, AlertCircle } from "lucide-react";

export default function RegisterPage() {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [orgName, setOrgName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const { signInWithGoogle, signUpWithEmail } = useAuth();

  // Google OAuth sign up
  const handleGoogleSignUp = async () => {
    setError(null);
    setIsLoading(true);
    const { error: oauthError } = await signInWithGoogle();
    if (oauthError) {
      setError(oauthError.message || friendlyAuthError(oauthError));
      setIsLoading(false);
    }
  };

  // Email + Password Workspace Registration
  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password || !orgName) {
      setError("Please fill in your email, password, and organization name.");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters long.");
      return;
    }

    setError(null);
    setIsLoading(true);

    const { error: regError } = await signUpWithEmail(email, password, fullName, orgName);
    setIsLoading(false);

    if (regError) {
      setError(friendlyAuthError(regError));
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
              Create Workspace
            </h1>
            <p className="text-xs text-charcoal-500">
              Onboard your D2C brand to unified intelligence
            </p>
          </div>
        </div>

        {/* Status Alerts */}
        {error && (
          <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 flex items-start space-x-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-red-600" />
            <span>{error}</span>
          </div>
        )}

        {/* Method 1: Google OAuth Button */}
        <div>
          <button
            type="button"
            onClick={handleGoogleSignUp}
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
            <span>Sign up with Google</span>
          </button>
        </div>

        <div className="relative flex items-center justify-center">
          <div className="border-t border-ivory-300 w-full" />
          <span className="bg-white px-3 text-[10px] uppercase tracking-wider text-charcoal-400 font-semibold absolute">
            or register with email
          </span>
        </div>

        <form onSubmit={handleRegister} className="space-y-3.5">
          <div>
            <label className="block text-xs font-semibold text-charcoal-700 mb-1">
              Full Name
            </label>
            <div className="relative">
              <input
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Rahul Mehta"
                className="w-full pl-9 pr-3 py-2 text-xs rounded-lg border border-ivory-300 bg-white focus:outline-none focus:ring-2 focus:ring-terracotta-500/20 focus:border-terracotta-500 text-charcoal-900"
              />
              <UserIcon className="w-4 h-4 text-charcoal-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-charcoal-700 mb-1">
              Organization / Brand Name
            </label>
            <div className="relative">
              <input
                type="text"
                required
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder="e.g. Acme Apparel"
                className="w-full pl-9 pr-3 py-2 text-xs rounded-lg border border-ivory-300 bg-white focus:outline-none focus:ring-2 focus:ring-terracotta-500/20 focus:border-terracotta-500 text-charcoal-900"
              />
              <Building2 className="w-4 h-4 text-charcoal-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>
          </div>

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
                placeholder="founder@brand.com"
                className="w-full pl-9 pr-3 py-2 text-xs rounded-lg border border-ivory-300 bg-white focus:outline-none focus:ring-2 focus:ring-terracotta-500/20 focus:border-terracotta-500 text-charcoal-900"
              />
              <Mail className="w-4 h-4 text-charcoal-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-charcoal-700 mb-1">
              Password
            </label>
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
            <p className="text-[10px] text-charcoal-400 mt-1">Minimum 6 characters</p>
          </div>

          <button
            type="submit"
            disabled={isLoading || !email || !password || !orgName}
            className="w-full flex items-center justify-center space-x-2 py-2.5 px-4 rounded-xl bg-forest-900 hover:bg-forest-800 text-ivory-100 text-xs font-bold transition-colors shadow-sm disabled:opacity-50 mt-2"
          >
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Creating Workspace...</span>
              </>
            ) : (
              <>
                <span>Create Workspace & Account</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>

        {/* Footer */}
        <div className="pt-2 border-t border-ivory-200 text-center text-xs text-charcoal-500">
          <span>Already have a workspace? </span>
          <Link href="/login" className="font-semibold text-terracotta-600 hover:underline">
            Sign In
          </Link>
        </div>
      </div>
    </div>
  );
}
