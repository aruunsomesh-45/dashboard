"use client";

import React, { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { apiFetch } from "@/lib/api";
import { Loader2, AlertCircle, CheckCircle2 } from "lucide-react";

const PENDING_KEY = "app_pending_invite";

function AcceptInviteContent() {
  const router = useRouter();
  const params = useSearchParams();
  const { user, isLoading, refreshAuth } = useAuth();
  const [state, setState] = useState<"working" | "done" | "error">("working");
  const started = useRef(false);

  useEffect(() => {
    if (isLoading || started.current) return; // wait until the session check has finished
    started.current = true;

    async function run() {
      const urlToken = params.get("token");
      const token = urlToken || sessionStorage.getItem(PENDING_KEY);
      if (!token) {
        setState("error");
        return;
      }
      if (urlToken) window.history.replaceState({}, "", "/invites/accept");

      if (!user) {
        sessionStorage.setItem(PENDING_KEY, token);
        router.replace("/login?next=" + encodeURIComponent("/invites/accept"));
        return;
      }

      let success = false;
      try {
        await apiFetch("/api/w/invites/accept/", {
          method: "POST",
          body: JSON.stringify({ token }),
        });
        success = true;
      } catch {
        success = false;
      }

      sessionStorage.removeItem(PENDING_KEY);

      if (!success) {
        setState("error");
        return;
      }

      await refreshAuth();
      setState("done");
      setTimeout(() => router.replace("/dashboard"), 1200);
    }
    run();
  }, [params, router, user, isLoading, refreshAuth]);

  return (
    <div className="min-h-screen bg-ivory-100 flex items-center justify-center p-4 font-sans">
      <div className="w-full max-w-md bg-white rounded-2xl border border-ivory-300 p-8 shadow-sm text-center space-y-3">
        {state === "working" && (
          <>
            <Loader2 className="w-8 h-8 text-terracotta-500 animate-spin mx-auto" />
            <h2 className="text-sm font-bold text-charcoal-900">Accepting invitation…</h2>
          </>
        )}
        {state === "done" && (
          <>
            <CheckCircle2 className="w-8 h-8 text-emerald-600 mx-auto" />
            <h2 className="text-sm font-bold text-charcoal-900">You&apos;re in. Redirecting…</h2>
          </>
        )}
        {state === "error" && (
          <>
            <AlertCircle className="w-8 h-8 text-rose-600 mx-auto" />
            <h2 className="text-sm font-bold text-charcoal-900">This invitation can&apos;t be used</h2>
            <p className="text-xs text-charcoal-500 leading-relaxed">
              It may have expired, been sent to a different email address, or already been used. If you signed in with the invited address, you were added automatically — check your workspace list.
            </p>
            <button
              onClick={() => router.replace("/")}
              className="px-4 py-2 bg-forest-900 text-ivory-100 rounded-xl text-xs font-bold hover:bg-forest-800"
            >
              Go to dashboard
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default function AcceptInvitePage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-ivory-100 flex items-center justify-center p-4 font-sans">
          <div className="w-full max-w-md bg-white rounded-2xl border border-ivory-300 p-8 shadow-sm text-center space-y-3">
            <Loader2 className="w-8 h-8 text-terracotta-500 animate-spin mx-auto" />
            <h2 className="text-sm font-bold text-charcoal-900">Loading invitation...</h2>
          </div>
        </div>
      }
    >
      <AcceptInviteContent />
    </Suspense>
  );
}
