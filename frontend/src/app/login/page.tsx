"use client";

import React, { useState, useEffect, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import {
  Mail,
  Lock,
  ArrowRight,
  Loader2,
  KeyRound,
  CheckCircle2,
  RotateCw,
  AlertCircle,
  Zap,
} from "lucide-react";

const RESEND_SECONDS = 60;
const MAX_VERIFY_ATTEMPTS = 5;
const COOLDOWN_KEY = "125east_otp_next_at";

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { signInWithGoogle, signInWithEmail, signInWithOtp, verifyOtp } = useAuth();

  const [authMode, setAuthMode] = useState<"password" | "otp">("password");
  const [email, setEmail] = useState("aruunsomesh@gmail.com");
  const [password, setPassword] = useState("125EastSecure2026!");
  const [otpSent, setOtpSent] = useState(false);
  const [otpToken, setOtpToken] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [failedAttempts, setFailedAttempts] = useState(0);

  // Initialize from searchParams or localStorage
  useEffect(() => {
    const paramEmail = searchParams.get("email");
    const paramStep = searchParams.get("step");
    const storedEmail =
      typeof window !== "undefined" ? localStorage.getItem("125east_pending_email") : null;

    const targetEmail = paramEmail || storedEmail || "";
    if (targetEmail) {
      setEmail(targetEmail);
    }

    if (searchParams.get("reason") === "expired") {
      setError("Your session expired. Please sign in again.");
    }

    // Cooldown survives reloads
    const [cdEmail, cdAt] = (localStorage.getItem(COOLDOWN_KEY) || "|0").split("|");
    const remaining = cdEmail === targetEmail.trim().toLowerCase() ? Math.ceil((Number(cdAt) - Date.now()) / 1000) : 0;
    if (remaining > 0) setCountdown(Math.min(remaining, RESEND_SECONDS));

    if (paramStep === "verify") {
      setAuthMode("otp");
      setOtpSent(true);
      setSuccessMsg("Enter the 6-digit code from your email to complete sign in.");
    }
  }, [searchParams]);

  // Timer for OTP resend cooldown
  useEffect(() => {
    if (countdown > 0) {
      const timer = setTimeout(() => setCountdown(countdown - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [countdown]);

  // A. Google OAuth Trigger
  const handleGoogleSignIn = async () => {
    setError(null);
    setIsLoading(true);
    const { error: oauthError } = await signInWithGoogle();
    if (oauthError) {
      setError(oauthError.message || "Failed to initiate Google authentication.");
      setIsLoading(false);
    }
  };

  // B. Email + Password Sign-In
  const handlePasswordSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setError("Please enter both email and password.");
      return;
    }

    setError(null);
    setSuccessMsg(null);
    setIsLoading(true);

    const { error: loginError } = await signInWithEmail(email, password);
    setIsLoading(false);

    if (loginError) {
      setError(loginError.message || "Invalid email or password.");
    }
  };

  // C. 1-Click Quick Dev Login
  const handleQuickDevLogin = async () => {
    setError(null);
    setSuccessMsg("Logging in to Aruunsomesh Store workspace...");
    setIsLoading(true);
    setEmail("aruunsomesh@gmail.com");
    setPassword("125EastSecure2026!");
    const { error: loginError } = await signInWithEmail("aruunsomesh@gmail.com", "125EastSecure2026!");
    setIsLoading(false);
    if (loginError) {
      setError(loginError.message || "Failed quick demo login.");
    }
  };

  // D. Email OTP Request
  const handleSendOtp = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!email) {
      setError("Please enter a valid email address.");
      return;
    }

    if (countdown > 0 && otpSent) return;
    setError(null);
    setSuccessMsg(null);
    setIsLoading(true);

    if (typeof window !== "undefined") {
      localStorage.setItem("125east_pending_email", email.trim().toLowerCase());
    }

    const { error: otpError } = await signInWithOtp(email);
    setIsLoading(false);

    if (otpError) {
      setError(otpError.message || "Failed to send login code. Please try again.");
    } else {
      setOtpSent(true);
      setCountdown(RESEND_SECONDS);
      setFailedAttempts(0);
      setOtpToken("");
      localStorage.setItem(COOLDOWN_KEY, `${email.trim().toLowerCase()}|${Date.now() + RESEND_SECONDS * 1000}`);
      setSuccessMsg(`We sent a 6-digit verification code to ${email}. Check your inbox or spam folder.`);
    }
  };

  // E. Email OTP Verification
  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) {
      setError("Please specify the email address associated with this code.");
      return;
    }
    if (!otpToken || otpToken.trim().length < 6) {
      setError("Please enter the complete 6-digit code sent to your email.");
      return;
    }

    if (failedAttempts >= MAX_VERIFY_ATTEMPTS) {
      setError("Too many incorrect codes. Request a new code to continue.");
      return;
    }

    setError(null);
    setIsLoading(true);

    const { error: verifyError } = await verifyOtp(email, otpToken);
    setIsLoading(false);

    if (verifyError) {
      setFailedAttempts((n) => n + 1);
      setOtpToken("");
      setError(verifyError.message || "Invalid or expired code. Please request a new one.");
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-ivory-100 p-4 font-sans">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-xl border border-ivory-300 p-8 space-y-6">
        {/* Brand Header */}
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-terracotta-500 flex items-center justify-center text-white font-bold text-lg shadow-sm">
            125
          </div>
          <div>
            <h1 className="text-lg font-bold text-charcoal-900">
              125 East Commerce Intelligence
            </h1>
            <p className="text-xs text-charcoal-500">
              Multi-Tenant Workspace Cockpit
            </p>
          </div>
        </div>

        {/* 1-Click Quick Demo Login (Instant Access) */}
        <div className="p-3.5 rounded-xl bg-amber-50/80 border border-amber-200/90 text-xs space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-amber-900 flex items-center space-x-1.5">
              <Zap className="w-3.5 h-3.5 text-amber-600 fill-amber-600" />
              <span>1-Click Dev Workspace Access</span>
            </span>
            <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-amber-200 text-amber-800">
              Localhost
            </span>
          </div>
          <p className="text-[11px] text-amber-800">
            Instantly enters the <strong>Aruunsomesh Store</strong> cockpit with Owner privileges.
          </p>
          <button
            type="button"
            onClick={handleQuickDevLogin}
            disabled={isLoading}
            className="w-full flex items-center justify-center space-x-2 py-2 px-3 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-semibold text-xs transition-colors shadow-sm disabled:opacity-50"
          >
            {isLoading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Zap className="w-3.5 h-3.5" />
            )}
            <span>Enter Cockpit (1-Click Demo)</span>
          </button>
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

        {successMsg && (
          <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-700 flex items-start space-x-2">
            <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5 text-emerald-600" />
            <span>{successMsg}</span>
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

        {/* Tab Switcher: Password vs OTP */}
        <div className="flex rounded-lg bg-ivory-200/80 p-1 border border-ivory-300 text-xs">
          <button
            type="button"
            onClick={() => {
              setAuthMode("password");
              setError(null);
            }}
            className={`flex-1 py-1.5 rounded-md font-semibold transition-all ${
              authMode === "password"
                ? "bg-white text-charcoal-900 shadow-sm"
                : "text-charcoal-600 hover:text-charcoal-900"
            }`}
          >
            Password
          </button>
          <button
            type="button"
            onClick={() => {
              setAuthMode("otp");
              setError(null);
            }}
            className={`flex-1 py-1.5 rounded-md font-semibold transition-all ${
              authMode === "otp"
                ? "bg-white text-charcoal-900 shadow-sm"
                : "text-charcoal-600 hover:text-charcoal-900"
            }`}
          >
            Email OTP Code
          </button>
        </div>

        {/* Mode A: Password Login Form */}
        {authMode === "password" && (
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
        )}

        {/* Mode B: Email OTP Form */}
        {authMode === "otp" && !otpSent && (
          <form onSubmit={handleSendOtp} className="space-y-4">
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
              <p className="text-[11px] text-charcoal-400 mt-1">
                We will email you a secure 6-digit one-time code. No password required.
              </p>
            </div>

            <button
              type="submit"
              disabled={isLoading || !email}
              className="w-full flex items-center justify-center space-x-2 py-2.5 px-4 rounded-xl bg-forest-900 hover:bg-forest-800 text-ivory-100 text-xs font-bold transition-colors shadow-sm disabled:opacity-50"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Sending Code...</span>
                </>
              ) : (
                <>
                  <span>Send Login Code</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>

            {/* Direct code entry trigger */}
            <div className="text-center pt-1">
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setOtpSent(true);
                }}
                className="text-xs text-terracotta-600 font-medium hover:underline inline-flex items-center space-x-1"
              >
                <KeyRound className="w-3.5 h-3.5" />
                <span>Already have a 6-digit code in your email? Enter it here</span>
              </button>
            </div>
          </form>
        )}

        {/* Mode B2: Enter 6-digit OTP */}
        {authMode === "otp" && otpSent && (
          <form onSubmit={handleVerifyOtp} className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-semibold text-charcoal-700">
                  Target Email
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setOtpSent(false);
                    setOtpToken("");
                    setError(null);
                  }}
                  className="text-[11px] text-terracotta-600 hover:underline"
                >
                  Change Email
                </button>
              </div>
              <div className="relative mb-3">
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="aruunsomesh@gmail.com"
                  className="w-full pl-9 pr-3 py-1.5 text-xs rounded-lg border border-ivory-300 bg-ivory-50 text-charcoal-800 focus:outline-none focus:ring-1 focus:ring-terracotta-500"
                />
                <Mail className="w-4 h-4 text-charcoal-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              </div>

              <label className="block text-xs font-semibold text-charcoal-700 mb-1">
                Enter 6-Digit Code
              </label>
              <div className="relative">
                <input
                  type="text"
                  required
                  maxLength={6}
                  value={otpToken}
                  onChange={(e) => setOtpToken(e.target.value.replace(/\D/g, ""))}
                  placeholder="123456"
                  autoFocus
                  className="w-full text-center tracking-[0.5em] text-lg font-mono py-2 rounded-lg border border-ivory-300 bg-white focus:outline-none focus:ring-2 focus:ring-terracotta-500/20 focus:border-terracotta-500 font-bold"
                />
                <KeyRound className="w-4 h-4 text-charcoal-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              </div>

              <div className="flex items-center justify-between text-[11px] text-charcoal-500 mt-1.5">
                <span>Code is valid for 10 minutes</span>
                {countdown > 0 ? (
                  <span className="text-charcoal-400">Resend in {countdown}s</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleSendOtp()}
                    disabled={isLoading || !email}
                    className="text-terracotta-600 font-medium hover:underline flex items-center space-x-1"
                  >
                    <RotateCw className="w-3 h-3" />
                    <span>Resend Code</span>
                  </button>
                )}
              </div>
            </div>

            <button
              type="submit"
              disabled={isLoading || otpToken.length < 6 || !email}
              className="w-full flex items-center justify-center space-x-2 py-2.5 px-4 rounded-xl bg-forest-900 hover:bg-forest-800 text-ivory-100 text-xs font-bold transition-colors shadow-sm disabled:opacity-50"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Verifying Code...</span>
                </>
              ) : (
                <>
                  <span>Verify & Enter Cockpit</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>
        )}

        {/* Footer Links */}
        <div className="pt-2 border-t border-ivory-200 text-center text-xs text-charcoal-500">
          <span>New to 125 East? </span>
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