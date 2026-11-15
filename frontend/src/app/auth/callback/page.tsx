"use client";

import React, { useEffect, useRef, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { safeNextPath } from "@/lib/authRedirect";
import { Loader2, AlertCircle, KeyRound, ArrowRight } from "lucide-react";

// Email link types we are willing to verify. Anything else in the URL is ignored.
const ALLOWED_OTP_TYPES = new Set(["email", "magiclink", "signup"]);

function AuthCallbackContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [isPkceError, setIsPkceError] = useState(false);
  // React StrictMode runs effects twice in dev; a PKCE code is single-use, so the
  // second exchange would fail and mask a successful login.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    function fail(desc: string) {
      setError(desc);
      const d = desc.toLowerCase();
      if (d.includes("pkce") || d.includes("verifier") || d.includes("invalid or has expired") || d.includes("flow state")) {
        setIsPkceError(true);
      }
    }

    async function handleAuthCallback() {
      // Providers may report errors in the query string or the URL fragment.
      const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      const errorParam = searchParams.get("error") || hash.get("error");
      if (errorParam) {
        fail(searchParams.get("error_description") || hash.get("error_description") || errorParam);
        return;
      }

      const next = safeNextPath(searchParams.get("next"));

      // Email link (token_hash) verification
      const tokenHash = searchParams.get("token_hash");
      const type = searchParams.get("type");
      if (tokenHash && type && ALLOWED_OTP_TYPES.has(type)) {
        const { error: verifyError } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: type as "email" | "magiclink" | "signup" });
        if (verifyError) {
          fail(verifyError.message);
          return;
        }
        router.replace(next);
        return;
      }

      // PKCE authorization code exchange (Google OAuth + magic link)
      const code = searchParams.get("code");
      if (code) {
        const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
        if (exchangeError) {
          fail(exchangeError.message);
          return;
        }
      }

      const { data: { session }, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !session) {
        fail(sessionError?.message || "Authentication session could not be established.");
        return;
      }
      router.replace(next);
    }

    handleAuthCallback();
  }, [router, searchParams]);

  return (
    <div className="min-h-screen bg-ivory-100 flex items-center justify-center p-4 font-sans">
      <div className="w-full max-w-md bg-white rounded-2xl border border-ivory-300 p-8 shadow-sm text-center space-y-4">
        {error ? (
          <div className="space-y-4">
            <div className="w-12 h-12 rounded-full bg-rose-50 text-rose-600 flex items-center justify-center mx-auto">
              <AlertCircle className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-base font-bold text-charcoal-900">
                {isPkceError ? "Email Link Opened in a Different Browser" : "Authentication Failed"}
              </h2>
              <p className="text-xs text-charcoal-500 mt-2 leading-relaxed">
                {isPkceError
                  ? "For security, one-time email links only open in the exact browser tab where you requested them. Since you opened this link elsewhere, simply use the 6-digit verification code from your email to sign in."
                  : error}
              </p>
            </div>

            <div className="pt-2 space-y-2">
              <button
                onClick={() => router.push("/login?step=verify")}
                className="w-full flex items-center justify-center space-x-2 px-4 py-2.5 bg-forest-900 text-ivory-100 rounded-xl text-xs font-bold hover:bg-forest-800 transition-colors shadow-sm"
              >
                <KeyRound className="w-4 h-4 text-terracotta-400" />
                <span>Enter 6-Digit Code from Email</span>
                <ArrowRight className="w-4 h-4" />
              </button>

              <button
                onClick={() => router.push("/login")}
                className="w-full px-4 py-2 text-xs font-semibold text-charcoal-500 hover:text-charcoal-900 transition-colors"
              >
                Back to Sign In
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <Loader2 className="w-8 h-8 text-terracotta-500 animate-spin mx-auto" />
            <h2 className="text-sm font-bold text-charcoal-900">Completing Sign In...</h2>
            <p className="text-xs text-charcoal-500">
              Verifying your credentials and establishing your encrypted workspace session.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function AuthCallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-ivory-100 flex items-center justify-center p-4 font-sans">
          <div className="w-full max-w-md bg-white rounded-2xl border border-ivory-300 p-8 shadow-sm text-center space-y-3">
            <Loader2 className="w-8 h-8 text-terracotta-500 animate-spin mx-auto" />
            <h2 className="text-sm font-bold text-charcoal-900">Loading...</h2>
          </div>
        </div>
      }
    >
      <AuthCallbackContent />
    </Suspense>
  );
}
