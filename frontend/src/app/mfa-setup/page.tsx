"use client";

import React, { useState } from "react";
import Image from "next/image";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { ShieldCheck, Copy, Check, AlertTriangle, Key } from "lucide-react";

export default function MFASetupPage() {
  const { user, refreshAuth } = useAuth();
  const [setupData, setSetupData] = useState<{
    secret: string;
    provisioning_uri: string;
    qr_code_base64: string;
  } | null>(null);

  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [copiedCodeIndex, setCopiedCodeIndex] = useState<number | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const startSetup = async () => {
    setError(null);
    setIsLoading(true);
    try {
      const data = await apiFetch<any>("/api/auth/mfa/setup/", { method: "POST" });
      setSetupData(data);
    } catch (err: any) {
      setError(err.message || "Failed to initiate MFA setup.");
    } finally {
      setIsLoading(false);
    }
  };

  const confirmSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const data = await apiFetch<any>("/api/auth/mfa/confirm/", {
        method: "POST",
        body: JSON.stringify({ code: code.trim() }),
      });
      setRecoveryCodes(data.recovery_codes || []);
      await refreshAuth();
    } catch (err: any) {
      setError(err.message || "Invalid code. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const copyAllRecoveryCodes = () => {
    navigator.clipboard.writeText(recoveryCodes.join("\n"));
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 2000);
  };

  return (
    <DashboardShell>
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <h2 className="text-xl font-bold text-charcoal-900">
            Multi-Factor Authentication (MFA)
          </h2>
          <p className="text-xs text-charcoal-500 mt-1">
            Enforce TOTP two-factor security for your workspace.
          </p>
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
            {error}
          </div>
        )}

        {/* State 1: MFA already enabled and no new enrollment active */}
        {user?.mfa_enabled && recoveryCodes.length === 0 && !setupData && (
          <div className="p-6 rounded-xl bg-white border border-ivory-300 shadow-sm flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center">
                <ShieldCheck className="w-5 h-5 text-emerald-600" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-charcoal-900">
                  MFA Protection is Active
                </h3>
                <p className="text-xs text-charcoal-500">
                  Your account requires a 6-digit authenticator code on each sign-in.
                </p>
              </div>
            </div>

            <button
              onClick={startSetup}
              className="px-3.5 py-2 rounded-lg border border-ivory-300 hover:bg-ivory-200 text-xs font-medium text-charcoal-700"
            >
              Reconfigure Authenticator
            </button>
          </div>
        )}

        {/* State 2: Enrolling Authenticator */}
        {(!user?.mfa_enabled || setupData) && recoveryCodes.length === 0 && (
          <div className="p-6 rounded-xl bg-white border border-ivory-300 shadow-sm space-y-6">
            {!setupData ? (
              <div className="text-center py-6 space-y-4">
                <div className="w-12 h-12 rounded-full bg-terracotta-100 flex items-center justify-center mx-auto">
                  <ShieldCheck className="w-6 h-6 text-terracotta-500" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-charcoal-900">
                    Set Up Authenticator App
                  </h3>
                  <p className="text-xs text-charcoal-500 max-w-sm mx-auto mt-1">
                    Use Google Authenticator, 1Password, or Authy to generate secure verification codes.
                  </p>
                </div>
                <button
                  onClick={startSetup}
                  disabled={isLoading}
                  className="px-5 py-2.5 rounded-lg bg-terracotta-500 hover:bg-terracotta-600 text-white font-medium text-xs disabled:opacity-50"
                >
                  {isLoading ? "Generating Key..." : "Begin MFA Enrollment"}
                </button>
              </div>
            ) : (
              <div className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-center">
                  <div className="flex flex-col items-center p-4 bg-ivory-50 rounded-xl border border-ivory-300">
                    {setupData.qr_code_base64 && (
                      <Image
                        src={setupData.qr_code_base64}
                        alt="TOTP QR Code"
                        width={180}
                        height={180}
                        unoptimized
                        className="rounded-lg shadow-sm"
                      />
                    )}
                    <span className="text-[11px] text-charcoal-500 mt-2">
                      Scan with your authenticator app
                    </span>
                  </div>

                  <div className="space-y-3">
                    <h4 className="text-xs font-semibold text-charcoal-900 uppercase tracking-wider">
                      Can&apos;t scan? Enter manually:
                    </h4>
                    <div className="p-2.5 rounded-lg bg-ivory-200 border border-ivory-300 font-mono text-xs text-charcoal-800 break-all select-all flex items-center justify-between">
                      <span>{setupData.secret}</span>
                      <button
                        onClick={() => navigator.clipboard.writeText(setupData.secret)}
                        className="p-1 hover:text-terracotta-500"
                        title="Copy Key"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <form onSubmit={confirmSetup} className="space-y-3 pt-2">
                      <div>
                        <label className="block text-xs font-semibold text-charcoal-700 mb-1">
                          Enter 6-digit confirmation code
                        </label>
                        <input
                          type="text"
                          required
                          placeholder="123456"
                          maxLength={6}
                          value={code}
                          onChange={(e) => setCode(e.target.value)}
                          className="w-full px-3.5 py-2 text-sm font-mono tracking-widest text-center rounded-lg border border-ivory-300 focus:outline-none focus:border-terracotta-500 bg-ivory-50 text-charcoal-900"
                        />
                      </div>

                      <button
                        type="submit"
                        disabled={isLoading || code.length !== 6}
                        className="w-full py-2.5 rounded-lg bg-forest-800 hover:bg-forest-900 text-white font-medium text-xs disabled:opacity-50"
                      >
                        {isLoading ? "Activating..." : "Verify & Activate MFA"}
                      </button>
                    </form>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* State 3: Recovery Codes Generated */}
        {recoveryCodes.length > 0 && (
          <div className="p-6 rounded-xl bg-white border border-ivory-300 shadow-sm space-y-4">
            <div className="flex items-center space-x-2 text-amber-700 bg-amber-50 p-3 rounded-lg border border-amber-200">
              <AlertTriangle className="w-5 h-5 flex-shrink-0" />
              <p className="text-xs">
                Save these 10 one-time recovery codes in a secure location. If you lose access to your authenticator, each code can be used once to access your workspace.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2 bg-ivory-50 p-4 rounded-xl border border-ivory-300">
              {recoveryCodes.map((rc, idx) => (
                <div
                  key={rc}
                  className="p-2 rounded bg-white border border-ivory-300 font-mono text-xs flex items-center justify-between text-charcoal-800"
                >
                  <span>{rc}</span>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(rc);
                      setCopiedCodeIndex(idx);
                      setTimeout(() => setCopiedCodeIndex(null), 1500);
                    }}
                    className="text-charcoal-400 hover:text-terracotta-500"
                  >
                    {copiedCodeIndex === idx ? (
                      <Check className="w-3.5 h-3.5 text-emerald-600" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between pt-2">
              <button
                onClick={copyAllRecoveryCodes}
                className="px-4 py-2 rounded-lg bg-ivory-200 hover:bg-ivory-300 text-xs font-semibold text-charcoal-800 flex items-center space-x-1.5"
              >
                {copiedAll ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Key className="w-3.5 h-3.5" />}
                <span>{copiedAll ? "Copied All Codes!" : "Copy All Recovery Codes"}</span>
              </button>

              <button
                onClick={() => {
                  setRecoveryCodes([]);
                  setSetupData(null);
                }}
                className="px-5 py-2 rounded-lg bg-forest-800 hover:bg-forest-900 text-white text-xs font-medium"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </DashboardShell>
  );
}
