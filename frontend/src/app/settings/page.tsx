"use client";

import React, { useState } from "react";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { useAuth } from "@/context/AuthContext";
import {
  Settings,
  ShieldCheck,
  Building2,
  Key,
  Webhook,
  RefreshCw,
  CheckCircle2,
  Lock,
  Layers,
} from "lucide-react";

export default function SettingsPage() {
  const { currentWorkspace, currentBrand } = useAuth();
  const [copied, setCopied] = useState<string | null>(null);

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2500);
  };

  const webhookBase = typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:8000";

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
                Tenant &amp; Brand Settings
              </h2>
              <p className="text-xs text-charcoal-500 mt-0.5">
                Manage credentials, webhook configurations, and tenant isolation for{" "}
                <strong>{currentWorkspace?.name}</strong>.
              </p>
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
                  value={`${webhookBase}/api/webhooks/shopify/${currentBrand?.id}/`}
                  className="w-full font-mono text-[11px] bg-white border border-ivory-300 rounded px-3 py-1.5 text-charcoal-700"
                />
                <button
                  onClick={() => copyToClipboard(`${webhookBase}/api/webhooks/shopify/${currentBrand?.id}/`, "shopify")}
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
                  value={`${webhookBase}/api/webhooks/razorpay/${currentBrand?.id}/`}
                  className="w-full font-mono text-[11px] bg-white border border-ivory-300 rounded px-3 py-1.5 text-charcoal-700"
                />
                <button
                  onClick={() => copyToClipboard(`${webhookBase}/api/webhooks/razorpay/${currentBrand?.id}/`, "razorpay")}
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
            <span>Envelope Encryption &amp; RLS Guarantee</span>
          </div>
          <p className="text-[11px] text-charcoal-600 leading-relaxed">
            Provider credentials (OAuth access tokens, webhook secrets) are encrypted using AES-256-GCM envelope keys before storage. PostgreSQL Row-Level Security (RLS) ensures that queries under <code>{currentWorkspace?.slug}</code> can never leak across tenant boundaries.
          </p>
        </div>
      </div>
    </DashboardShell>
  );
}
