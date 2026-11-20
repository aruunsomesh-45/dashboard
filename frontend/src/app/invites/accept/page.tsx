"use client";

import React, { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/context/AuthContext";
import { Loader2, AlertCircle, CheckCircle2 } from "lucide-react";

const PENDING_KEY = "app_pending_invite";

function AcceptInviteContent() {
  const router = useRouter();
  const params = useSearchParams();
  const { refreshAuth } = useAuth();
  const [state, setState] = useState<"working" | "done" | "error">("working");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    async function run() {
      const urlToken = params.get("token");
      const token = urlToken || sessionStorage.getItem(PENDING_KEY);
      if (!token) {
        setState("error");
        return;
      }
      // Strip the token from the address bar / history right away.
      if (urlToken) window.history.replaceState({}, "", "/invites/accept");

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        // Stash across the login redirect, then come back here.
        sessionStorage.setItem(PENDING_KEY, token);
        router.replace("/login?next=" + encodeURIComponent("/invites/accept"));
        return;
      }

      const { error } = await supabase.rpc("accept_invite", { p_token: token });
      sessionStorage.removeItem(PENDING_KEY);
      if (error) {
        setState("error");
        return;
      }
      await refreshAuth();
      setState("done");
      setTimeout(() => router.replace("/"), 1200);
    }
    run();
  }, [params, router, refreshAuth]);

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
              Sign in with the address that was invited, or ask your admin for a new link.
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
    <Suspense fallback={null}>
      <AcceptInviteContent />
    </Suspense>
  );
}
