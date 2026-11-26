"use client";

import React, { useState, useEffect } from "react";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { useAuth } from "@/context/AuthContext";
import { apiFetch } from "@/lib/api";
import { QRCodeSVG } from "qrcode.react";
import {
  Settings,
  ShieldCheck,
  Building2,
  Key,
  Webhook,
  RefreshCw,
  CheckCircle2,
  Lock,
  Copy,
  AlertTriangle,
  X,
  Smartphone,
} from "lucide-react";

interface MFAStatus {
  is_enabled: boolean;
  is_pending: boolean;
  unused_recovery_codes_count: number;
  confirmed_at: string | null;
}

export default function SettingsPage() {
  const { currentWorkspace, currentBrand, user, refreshAuth } = useAuth();
  const [copied, setCopied] = useState<string | null>(null);

  // 2FA state
  const [mfaStatus, setMfaStatus] = useState<MFAStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [mfaModal, setMfaModal] = useState<"setup" | "disable" | "recovery" | null>(null);
  const [setupData, setSetupData] = useState<{
    secret: string;
    provisioning_uri: string;
    qr_code_base64: string;
  } | null>(null);
  const [verifyOtp, setVerifyOtp] = useState("");
  const [generatedCodes, setGeneratedCodes] = useState<string[]>([]);
  const [disablePassword, setDisablePassword] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [regenPassword, setRegenPassword] = useState("");
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [mfaSuccess, setMfaSuccess] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2500);
  };

  const fetchMfaStatus = async () => {
    try {
      setLoadingStatus(true);
      const res = await apiFetch<MFAStatus>("/api/v1/security/mfa/status/");
      if (res && typeof res.is_enabled === "boolean") {
        setMfaStatus(res);
      } else {
        setMfaStatus({
          is_enabled: !!user?.mfa_enabled,
          is_pending: false,
          unused_recovery_codes_count: 0,
          confirmed_at: null,
        });
      }
    } catch {
      // Fallback to user.mfa_enabled if status endpoint fails
      setMfaStatus({
        is_enabled: !!user?.mfa_enabled,
        is_pending: false,
        unused_recovery_codes_count: 0,
        confirmed_at: null,
      });
    } finally {
      setLoadingStatus(false);
    }
  };

  useEffect(() => {
    fetchMfaStatus();
  }, [user]);

  const handleStartSetup = async () => {
    setMfaError(null);
    setActionLoading(true);
    try {
      const data = await apiFetch<any>("/api/v1/security/mfa/setup/", { method: "POST" });
      setSetupData(data);
      setVerifyOtp("");
      setGeneratedCodes([]);
      setMfaModal("setup");
    } catch (err: any) {
      setMfaError(err?.message || "Failed to initiate MFA setup.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleConfirmSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!verifyOtp.trim()) return;
    setMfaError(null);
    setActionLoading(true);
    try {
      const res = await apiFetch<any>("/api/v1/security/mfa/confirm/", {
        method: "POST",
        body: JSON.stringify({ code: verifyOtp.trim() }),
      });
      setGeneratedCodes(res.recovery_codes || []);
      setMfaSuccess("Two-factor authentication successfully enabled!");
      await refreshAuth();
      await fetchMfaStatus();
    } catch (err: any) {
      setMfaError(err?.message || "Invalid OTP code. Please try again.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleDisableMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    setMfaError(null);
    setActionLoading(true);
    try {
      await apiFetch<any>("/api/v1/security/mfa/disable/", {
        method: "POST",
        body: JSON.stringify({
          password: disablePassword,
          code: disableCode.trim(),
        }),
      });
      setMfaModal(null);
      setDisablePassword("");
      setDisableCode("");
      setMfaSuccess("Two-factor authentication has been disabled.");
      await refreshAuth();
      await fetchMfaStatus();
    } catch (err: any) {
      setMfaError(err?.message || "Could not disable 2FA. Verify your password and code.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleRegenerateCodes = async (e: React.FormEvent) => {
    e.preventDefault();
    setMfaError(null);
    setActionLoading(true);
    try {
      const res = await apiFetch<any>("/api/v1/security/mfa/recovery-codes/regenerate/", {
        method: "POST",
        body: JSON.stringify({ password: regenPassword }),
      });
      setGeneratedCodes(res.recovery_codes || []);
      setRegenPassword("");
      setMfaSuccess("New recovery codes generated.");
      await fetchMfaStatus();
    } catch (err: any) {
      setMfaError(err?.message || "Could not regenerate codes. Verify password.");
    } finally {
      setActionLoading(false);
    }
  };

  // The webhook receivers are the Supabase Edge Functions; they take the brand as ?brand_id=.
  const functionsBase = (process.env.NEXT_PUBLIC_FUNCTIONS_URL || "").trim().replace(/\/+$/, "");
  const shopifyWebhookUrl = currentBrand?.id ? `${functionsBase}/webhook-shopify?brand_id=${currentBrand.id}` : "";
  const razorpayWebhookUrl = currentBrand?.id ? `${functionsBase}/webhook-razorpay?brand_id=${currentBrand.id}` : "";

  const isEnabled = mfaStatus?.is_enabled ?? !!user?.mfa_enabled;

  return (
    <DashboardShell>
      <div className="space-y-6 font-sans max-w-5xl">
        {/* Header */}
        <div className="pb-2 border-b border-ivory-300">
          <div className="flex items-center space-x-2">
            <div className="p-2 rounded-lg bg-forest-900 text-ivory-100">
              <Settings className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-charcoal-900 tracking-tight">
                Tenant &amp; Security Settings
              </h2>
              <p className="text-xs text-charcoal-500 mt-0.5">
                Manage credentials, two-factor authentication, and tenant isolation for{" "}
                <strong>{currentWorkspace?.name}</strong>.
              </p>
            </div>
          </div>
        </div>

        {mfaSuccess && (
          <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              <span>{mfaSuccess}</span>
            </div>
            <button onClick={() => setMfaSuccess(null)} className="text-emerald-700 hover:text-emerald-900">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Two-Factor Authentication Card */}
        <div className="bg-white rounded-xl border border-ivory-300 shadow-sm p-6 space-y-4">
          <div className="flex items-center justify-between border-b border-ivory-200 pb-3">
            <div className="flex items-center space-x-2.5">
              <div className="p-2 rounded-lg bg-ivory-100 text-forest-900">
                <ShieldCheck className="w-5 h-5 text-forest-800" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-charcoal-900 flex items-center space-x-2">
                  <span>Two-Factor Authentication (2FA)</span>
                </h3>
                <p className="text-xs text-charcoal-500">
                  Protect your account with Google Authenticator, Microsoft Authenticator, or Authy TOTP.
                </p>
              </div>
            </div>
            <span
              className={`text-[11px] font-semibold px-2.5 py-1 rounded-full ${
                isEnabled
                  ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                  : "bg-charcoal-100 text-charcoal-600 border border-ivory-300"
              }`}
            >
              {isEnabled ? "Enabled" : "Disabled"}
            </span>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pt-1">
            <div className="text-xs text-charcoal-600 space-y-1">
              {isEnabled ? (
                <>
                  <p className="font-medium text-charcoal-900 flex items-center space-x-1.5">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    <span>Authenticator app verified and active.</span>
                  </p>
                  <p className="text-charcoal-500">
                    Unused emergency recovery codes:{" "}
                    <strong className="font-mono text-charcoal-800">{mfaStatus?.unused_recovery_codes_count ?? 10}</strong>
                  </p>
                </>
              ) : (
                <p>
                  Two-factor authentication adds an extra layer of security. Every sign-in will require a 6-digit code from your authenticator app.
                </p>
              )}
            </div>

            <div className="flex items-center space-x-2 flex-shrink-0">
              {isEnabled ? (
                <>
                  <button
                    onClick={() => {
                      setMfaError(null);
                      setGeneratedCodes([]);
                      setMfaModal("recovery");
                    }}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-ivory-300 bg-white hover:bg-ivory-100 text-charcoal-700 transition-colors"
                  >
                    Recovery Codes
                  </button>
                  <button
                    onClick={() => {
                      setMfaError(null);
                      setDisablePassword("");
                      setDisableCode("");
                      setMfaModal("disable");
                    }}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-rose-200 bg-rose-50 hover:bg-rose-100 text-rose-700 transition-colors"
                  >
                    Disable 2FA
                  </button>
                </>
              ) : (
                <button
                  onClick={handleStartSetup}
                  disabled={actionLoading}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-forest-900 hover:bg-forest-800 text-ivory-100 transition-colors flex items-center space-x-1.5 shadow-sm disabled:opacity-50"
                >
                  <Smartphone className="w-4 h-4" />
                  <span>{actionLoading ? "Preparing..." : "Enable 2FA"}</span>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Brand Information */}
        <div className="bg-white rounded-xl border border-ivory-300 shadow-sm p-6 space-y-4">
          <div className="flex items-center justify-between border-b border-ivory-200 pb-3">
            <h3 className="text-sm font-bold text-charcoal-900 flex items-center space-x-2">
              <Building2 className="w-4 h-4 text-forest-700" />
              <span>Active Brand Profile</span>
            </h3>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 font-semibold">
              Isolated Brand
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
            <div>
              <label className="text-charcoal-500 font-medium">Brand Name</label>
              <div className="mt-1 font-semibold text-charcoal-900">{currentBrand?.name}</div>
            </div>
            <div>
              <label className="text-charcoal-500 font-medium">Reporting Currency</label>
              <div className="mt-1 font-mono font-semibold text-charcoal-900">{currentBrand?.currency || "INR"}</div>
            </div>
            <div>
              <label className="text-charcoal-500 font-medium">Brand Timezone</label>
              <div className="mt-1 font-mono font-semibold text-charcoal-900">{currentBrand?.timezone || "Asia/Kolkata"}</div>
            </div>
          </div>
        </div>

        {/* Webhooks Configuration Endpoints */}
        <div className="bg-white rounded-xl border border-ivory-300 shadow-sm p-6 space-y-4">
          <div className="flex items-center justify-between border-b border-ivory-200 pb-3">
            <div>
              <h3 className="text-sm font-bold text-charcoal-900 flex items-center space-x-2">
                <Webhook className="w-4 h-4 text-forest-700" />
                <span>Inbound Webhook Listeners</span>
              </h3>
              <p className="text-xs text-charcoal-500">
                Configure these endpoints in your provider portals to receive verified webhooks.
              </p>
            </div>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-ivory-100 text-charcoal-600 font-semibold">
              HMAC SHA-256
            </span>
          </div>

          <div className="space-y-4 text-xs">
            {/* Shopify Webhook */}
            <div className="p-4 rounded-lg bg-ivory-50 border border-ivory-200 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-bold text-charcoal-900">Shopify Webhook URL</span>
                <span className="text-[10px] text-emerald-700 font-semibold uppercase">orders/create &amp; orders/updated</span>
              </div>
              <div className="flex items-center space-x-2">
                <input
                  type="text"
                  readOnly
                  value={shopifyWebhookUrl}
                  className="w-full font-mono text-[11px] bg-white border border-ivory-300 rounded px-3 py-1.5 text-charcoal-700"
                />
                <button
                  onClick={() => copyToClipboard(shopifyWebhookUrl, "shopify")}
                  className="px-3 py-1.5 text-xs bg-forest-900 text-ivory-100 rounded hover:bg-forest-800 transition-colors flex-shrink-0"
                >
                  {copied === "shopify" ? "Copied!" : "Copy"}
                </button>
              </div>
            </div>

            {/* Razorpay Webhook */}
            <div className="p-4 rounded-lg bg-ivory-50 border border-ivory-200 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-bold text-charcoal-900">Razorpay Webhook URL</span>
                <span className="text-[10px] text-blue-700 font-semibold uppercase">payment.captured &amp; payment.dispute</span>
              </div>
              <div className="flex items-center space-x-2">
                <input
                  type="text"
                  readOnly
                  value={razorpayWebhookUrl}
                  className="w-full font-mono text-[11px] bg-white border border-ivory-300 rounded px-3 py-1.5 text-charcoal-700"
                />
                <button
                  onClick={() => copyToClipboard(razorpayWebhookUrl, "razorpay")}
                  className="px-3 py-1.5 text-xs bg-forest-900 text-ivory-100 rounded hover:bg-forest-800 transition-colors flex-shrink-0"
                >
                  {copied === "razorpay" ? "Copied!" : "Copy"}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Security & Cryptography Box */}
        <div className="p-5 rounded-xl bg-ivory-50 border border-ivory-300 space-y-2 text-xs">
          <div className="flex items-center space-x-2 font-bold text-charcoal-900">
            <Lock className="w-4 h-4 text-forest-700" />
            <span>How your account and data are protected</span>
          </div>
          <p className="text-[11px] text-charcoal-600 leading-relaxed">
            Sign-in and two-factor authentication (TOTP) are handled by Supabase Auth. Integration credentials are encrypted with AES-256-GCM before they are stored. Every request checks your workspace membership, and PostgreSQL Row-Level Security isolates the data of <code>{currentWorkspace?.slug}</code> from other workspaces.
          </p>
        </div>
      </div>

      {/* MODAL 1: SETUP 2FA */}
      {mfaModal === "setup" && setupData && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border border-ivory-300 space-y-5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-ivory-200 pb-3">
              <h3 className="text-sm font-bold text-charcoal-900 flex items-center space-x-2">
                <ShieldCheck className="w-5 h-5 text-forest-900" />
                <span>Enable Google Authenticator (TOTP)</span>
              </h3>
              <button onClick={() => setMfaModal(null)} className="text-charcoal-400 hover:text-charcoal-700">
                <X className="w-4 h-4" />
              </button>
            </div>

            {mfaError && (
              <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-800">
                {mfaError}
              </div>
            )}

            {generatedCodes.length === 0 ? (
              <div className="space-y-4">
                <div className="text-xs text-charcoal-600 space-y-2">
                  <p>1. Open Google Authenticator, Microsoft Authenticator, or Authy on your mobile device.</p>
                  <p>2. Scan this QR code or enter the setup key manually:</p>
                </div>

                <div className="flex justify-center p-4 bg-ivory-50 rounded-xl border border-ivory-200">
                  {setupData?.provisioning_uri ? (
                    // Drawn locally from the otpauth:// URI: Supabase's qr_code is an unencoded SVG data URI
                    // that browsers can fail to load, which left a broken image.
                    <QRCodeSVG
                      value={setupData.provisioning_uri}
                      size={176}
                      marginSize={2}
                      title="2FA QR Code"
                      className="rounded-lg bg-white shadow-sm"
                    />
                  ) : (
                    <div className="w-44 h-44 rounded-lg bg-white shadow-sm flex items-center justify-center text-[11px] text-charcoal-400">
                      Generating QR code…
                    </div>
                  )}
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-charcoal-700">Manual Setup Key:</label>
                  <div className="flex items-center space-x-2">
                    <input
                      type="text"
                      readOnly
                      value={setupData?.secret || ""}
                      placeholder="Generating key…"
                      className="w-full font-mono text-xs bg-ivory-50 border border-ivory-300 rounded px-2.5 py-1.5 text-charcoal-800 select-all"
                    />
                    <button
                      onClick={() => setupData?.secret && copyToClipboard(setupData.secret, "totp-secret")}
                      className="px-2.5 py-1.5 text-xs bg-forest-900 text-ivory-100 rounded hover:bg-forest-800 transition-colors flex-shrink-0"
                    >
                      {copied === "totp-secret" ? "Copied" : "Copy"}
                    </button>
                  </div>
                </div>

                <form onSubmit={handleConfirmSetup} className="space-y-3 pt-2 border-t border-ivory-200">
                  <label className="text-xs font-semibold text-charcoal-900 block">
                    3. Enter the 6-digit verification code from the app:
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={6}
                    value={verifyOtp}
                    onChange={(e) => setVerifyOtp(e.target.value.replace(/\D/g, ""))}
                    placeholder="000000"
                    className="w-full px-4 py-2 text-center text-lg font-mono tracking-widest border border-ivory-300 rounded-xl bg-ivory-50 text-charcoal-900 focus:outline-none focus:ring-2 focus:ring-forest-900"
                  />
                  <div className="flex items-center justify-end space-x-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setMfaModal(null)}
                      className="px-3.5 py-2 text-xs font-medium text-charcoal-600 hover:text-charcoal-900 rounded-lg"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={actionLoading || verifyOtp.length < 6}
                      className="px-4 py-2 text-xs font-semibold bg-forest-900 hover:bg-forest-800 text-ivory-100 rounded-lg shadow-sm disabled:opacity-50"
                    >
                      {actionLoading ? "Verifying..." : "Verify & Enable 2FA"}
                    </button>
                  </div>
                </form>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800 space-y-1">
                  <p className="font-semibold flex items-center space-x-1.5">
                    <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />
                    <span>Save your 10 backup recovery codes now!</span>
                  </p>
                  <p className="text-[11px]">
                    These codes will NOT be displayed again. Each can be used once if you lose access to your authenticator app.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-2 p-3 bg-ivory-50 rounded-xl border border-ivory-200 font-mono text-xs text-charcoal-800">
                  {generatedCodes.map((c, i) => (
                    <div key={i} className="p-1.5 bg-white border border-ivory-300 rounded text-center">
                      {c}
                    </div>
                  ))}
                </div>

                <div className="flex items-center justify-between pt-2">
                  <button
                    onClick={() => copyToClipboard(generatedCodes.join("\n"), "all-codes")}
                    className="px-3 py-1.5 text-xs font-medium border border-ivory-300 rounded-lg bg-white hover:bg-ivory-100 text-charcoal-700 flex items-center space-x-1"
                  >
                    <Copy className="w-3.5 h-3.5" />
                    <span>{copied === "all-codes" ? "Copied All!" : "Copy All Codes"}</span>
                  </button>
                  <button
                    onClick={() => setMfaModal(null)}
                    className="px-4 py-1.5 text-xs font-semibold bg-forest-900 hover:bg-forest-800 text-ivory-100 rounded-lg"
                  >
                    I have saved my codes
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* MODAL 2: DISABLE 2FA */}
      {mfaModal === "disable" && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border border-ivory-300 space-y-4">
            <div className="flex items-center justify-between border-b border-ivory-200 pb-3">
              <h3 className="text-sm font-bold text-rose-700 flex items-center space-x-2">
                <AlertTriangle className="w-4 h-4 text-rose-600" />
                <span>Disable Two-Factor Authentication</span>
              </h3>
              <button onClick={() => setMfaModal(null)} className="text-charcoal-400 hover:text-charcoal-700">
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-charcoal-600">
              For security, confirm your identity with your account password and a current 6-digit OTP code or recovery code.
            </p>

            {mfaError && (
              <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-800">
                {mfaError}
              </div>
            )}

            <form onSubmit={handleDisableMfa} className="space-y-3">
              <div>
                <label className="text-[11px] font-semibold text-charcoal-700 block mb-1">Account Password:</label>
                <input
                  type="password"
                  required
                  value={disablePassword}
                  onChange={(e) => setDisablePassword(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-ivory-300 rounded-lg bg-ivory-50 text-charcoal-900 focus:outline-none focus:ring-2 focus:ring-rose-600"
                />
              </div>

              <div>
                <label className="text-[11px] font-semibold text-charcoal-700 block mb-1">
                  6-Digit OTP or Recovery Code:
                </label>
                <input
                  type="text"
                  required
                  value={disableCode}
                  onChange={(e) => setDisableCode(e.target.value.replace(/\s+/g, ""))}
                  placeholder="e.g. 123456 or ABCD-123456"
                  className="w-full px-3 py-2 text-xs font-mono border border-ivory-300 rounded-lg bg-ivory-50 text-charcoal-900 focus:outline-none focus:ring-2 focus:ring-rose-600"
                />
              </div>

              <div className="flex items-center justify-end space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setMfaModal(null)}
                  className="px-3 py-1.5 text-xs text-charcoal-600 hover:text-charcoal-900"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={actionLoading || !disablePassword || !disableCode}
                  className="px-4 py-2 text-xs font-semibold bg-rose-600 hover:bg-rose-700 text-white rounded-lg disabled:opacity-50"
                >
                  {actionLoading ? "Disabling..." : "Confirm & Disable 2FA"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 3: RECOVERY CODES REGENERATE */}
      {mfaModal === "recovery" && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border border-ivory-300 space-y-4">
            <div className="flex items-center justify-between border-b border-ivory-200 pb-3">
              <h3 className="text-sm font-bold text-charcoal-900 flex items-center space-x-2">
                <Key className="w-4 h-4 text-forest-800" />
                <span>Recovery Backup Codes</span>
              </h3>
              <button onClick={() => setMfaModal(null)} className="text-charcoal-400 hover:text-charcoal-700">
                <X className="w-4 h-4" />
              </button>
            </div>

            {mfaError && (
              <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-800">
                {mfaError}
              </div>
            )}

            {generatedCodes.length === 0 ? (
              <form onSubmit={handleRegenerateCodes} className="space-y-3">
                <p className="text-xs text-charcoal-600">
                  Regenerating recovery codes will invalidate all existing ones. Enter your account password to generate 10 new codes:
                </p>
                <div>
                  <label className="text-[11px] font-semibold text-charcoal-700 block mb-1">Account Password:</label>
                  <input
                    type="password"
                    required
                    value={regenPassword}
                    onChange={(e) => setRegenPassword(e.target.value)}
                    className="w-full px-3 py-2 text-xs border border-ivory-300 rounded-lg bg-ivory-50 text-charcoal-900 focus:outline-none focus:ring-2 focus:ring-forest-900"
                  />
                </div>
                <div className="flex items-center justify-end space-x-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setMfaModal(null)}
                    className="px-3 py-1.5 text-xs text-charcoal-600 hover:text-charcoal-900"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={actionLoading || !regenPassword}
                    className="px-4 py-2 text-xs font-semibold bg-forest-900 hover:bg-forest-800 text-ivory-100 rounded-lg disabled:opacity-50"
                  >
                    {actionLoading ? "Generating..." : "Generate 10 New Codes"}
                  </button>
                </div>
              </form>
            ) : (
              <div className="space-y-4">
                <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800">
                  10 new recovery codes generated! Previous codes are now invalid.
                </div>
                <div className="grid grid-cols-2 gap-2 p-3 bg-ivory-50 rounded-xl border border-ivory-200 font-mono text-xs text-charcoal-800">
                  {generatedCodes.map((c, i) => (
                    <div key={i} className="p-1.5 bg-white border border-ivory-300 rounded text-center">
                      {c}
                    </div>
                  ))}
                </div>
                <div className="flex items-center justify-between pt-2">
                  <button
                    onClick={() => copyToClipboard(generatedCodes.join("\n"), "all-codes-regen")}
                    className="px-3 py-1.5 text-xs font-medium border border-ivory-300 rounded-lg bg-white hover:bg-ivory-100 text-charcoal-700 flex items-center space-x-1"
                  >
                    <Copy className="w-3.5 h-3.5" />
                    <span>{copied === "all-codes-regen" ? "Copied All!" : "Copy All Codes"}</span>
                  </button>
                  <button
                    onClick={() => setMfaModal(null)}
                    className="px-4 py-1.5 text-xs font-semibold bg-forest-900 hover:bg-forest-800 text-ivory-100 rounded-lg"
                  >
                    Done
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </DashboardShell>
  );
}
