"use client";

import React, { useEffect, useRef, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { firebaseAuth } from "@/lib/firebaseClient";
import { safeNextPath } from "@/lib/authRedirect";
import { Loader2, AlertCircle } from "lucide-react";

function AuthCallbackContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    async function handleAuthCallback() {
      const next = safeNextPath(searchParams.get("next"));

      // 1. If Firebase already has an active user
      if (firebaseAuth.currentUser) {
        router.replace(next);
        return;
      }

      // 2. Wait up to 1.5 seconds for Firebase auth listener to resolve
      const timeout = setTimeout(() => {
        if (firebaseAuth.currentUser) {
          router.replace(next);
        } else {
          router.replace(`/login?next=${encodeURIComponent(next)}`);
        }
      }, 1500);

      const unsubscribe = firebaseAuth.onAuthStateChanged((user) => {
        if (user) {
          clearTimeout(timeout);
          unsubscribe();
          router.replace(next);
        }
      });
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
                Authentication Notice
              </h2>
              <p className="text-xs text-charcoal-500 mt-2 leading-relaxed">
                {error}
              </p>
            </div>
            <button
              onClick={() => router.push("/login")}
              className="w-full px-4 py-2 bg-forest-900 text-ivory-100 rounded-xl text-xs font-bold hover:bg-forest-800 transition-colors shadow-sm"
            >
              Back to Sign In
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <Loader2 className="w-8 h-8 text-terracotta-500 animate-spin mx-auto" />
            <h2 className="text-sm font-bold text-charcoal-900">Entering Cockpit...</h2>
            <p className="text-xs text-charcoal-500">
              Verifying your credentials and loading your workspace.
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
