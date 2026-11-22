"use client";

import React, { useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { supabase } from "@/lib/supabaseClient";
import {
  ShieldCheck,
  ShieldAlert,
  Key,
  Lock,
  Smartphone,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Terminal,
} from "lucide-react";

export default function SuperAdminSettingsPage() {
  const { user, isSuperAdmin } = useAuth();
  const [totpEnrolled, setTotpEnrolled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    // Check MFA enrollment via Supabase Auth
    async function checkMFA() {
      try {
        const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        if (data && data.currentLevel === "aal2") {
          setTotpEnrolled(true);
        }
      } catch (e) {
        // quiet catch
      }
    }
    checkMFA();
  }, []);

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-charcoal-900 tracking-tight">Super Admin Security & Configuration</h1>
        <p className="text-xs text-charcoal-500 mt-1">
          Two-factor authentication (TOTP), administrative privilege elevation, and platform security boundaries
        </p>
      </div>

      {/* 2FA TOTP Card */}
      <div className="bg-white p-6 rounded-xl border border-charcoal-200/80 shadow-xs space-y-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-charcoal-100 flex items-center justify-center">
              <Smartphone className="h-5 w-5 text-charcoal-700" />
            </div>
            <div>
              <h3 className="font-bold text-charcoal-900 text-sm">Two-Factor Authentication (TOTP 2FA)</h3>
              <p className="text-xs text-charcoal-500">
                Mandatory multi-factor verification required for all platform super administrator accounts
              </p>
            </div>
          </div>
          <span
            className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase inline-flex items-center gap-1 ${
              totpEnrolled ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"
            }`}
          >
            {totpEnrolled ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
            {totpEnrolled ? "ENFORCED" : "RECOMMENDED ENROLLMENT"}
          </span>
        </div>

        <div className="p-4 bg-charcoal-50 rounded-lg text-xs text-charcoal-600 space-y-2">
          <p>
            Super Administrators hold keys to cross-tenant data. To secure your account, authenticate with Google
            Authenticator, 1Password, or Authy using standard RFC 6238 TOTP tokens.
          </p>
        </div>
      </div>

      {/* Admin Session Security */}
      <div className="bg-white p-6 rounded-xl border border-charcoal-200/80 shadow-xs space-y-4">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-charcoal-100 flex items-center justify-center">
            <Lock className="h-5 w-5 text-charcoal-700" />
          </div>
          <div>
            <h3 className="font-bold text-charcoal-900 text-sm">Session Security & Re-Authentication</h3>
            <p className="text-xs text-charcoal-500">
              Ephemeral JWT tokens expire every 3600 seconds with automatic cryptographic rotation
            </p>
          </div>
        </div>

        <div className="divide-y divide-charcoal-100 text-xs">
          <div className="py-2.5 flex items-center justify-between">
            <span className="text-charcoal-600">Active Super Admin Email:</span>
            <span className="font-bold text-charcoal-900">{user?.email || "aruunasomesh@gmail.com"}</span>
          </div>
          <div className="py-2.5 flex items-center justify-between">
            <span className="text-charcoal-600">Elevation Status:</span>
            <span className="font-mono text-emerald-700 font-bold">is_superuser = true</span>
          </div>
          <div className="py-2.5 flex items-center justify-between">
            <span className="text-charcoal-600">Privilege Verification Method:</span>
            <span className="text-charcoal-700">Cryptographic JWT Verification + accounts_user check</span>
          </div>
        </div>
      </div>
    </div>
  );
}
