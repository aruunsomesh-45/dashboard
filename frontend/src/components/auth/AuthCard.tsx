"use client";

import React from "react";
import { AlertCircle, Building2, CheckCircle2, Loader2 } from "lucide-react";

/** Centered, responsive card shared by the login / register / password pages. */
export function AuthCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <main className="min-h-screen flex items-center justify-center bg-ivory-100 px-4 py-8 sm:py-12 font-sans">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl border border-ivory-300 p-6 sm:p-8 space-y-6">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-terracotta-500 flex items-center justify-center shadow-sm flex-shrink-0">
            <Building2 className="w-5 h-5 text-white" aria-hidden />
          </div>
          <div>
            <h1 className="text-lg font-bold text-charcoal-900">{title}</h1>
            {subtitle && <p className="text-xs text-charcoal-500">{subtitle}</p>}
          </div>
        </div>
        {children}
      </div>
    </main>
  );
}

export function FormAlert({ kind = "error", children }: { kind?: "error" | "success"; children: React.ReactNode }) {
  const isError = kind === "error";
  return (
    <div
      role={isError ? "alert" : "status"}
      className={`p-3 rounded-lg border text-sm flex items-start space-x-2 ${
        isError ? "bg-red-50 border-red-200 text-red-700" : "bg-emerald-50 border-emerald-200 text-emerald-800"
      }`}
    >
      {isError ? (
        <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-red-600" aria-hidden />
      ) : (
        <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5 text-emerald-600" aria-hidden />
      )}
      <p className="leading-relaxed">{children}</p>
    </div>
  );
}

type FieldProps = React.InputHTMLAttributes<HTMLInputElement> & {
  id: string;
  label: string;
  error?: string;
  icon?: React.ReactNode;
  labelAside?: React.ReactNode;
};

/** Labelled input with inline error. 16px text on mobile so iOS doesn't zoom on focus. */
export function Field({ id, label, error, icon, labelAside, ...input }: FieldProps) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label htmlFor={id} className="text-xs font-semibold text-charcoal-700">
          {label}
        </label>
        {labelAside}
      </div>
      <div className="relative">
        <input
          id={id}
          name={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className={`w-full ${icon ? "pl-9" : "pl-3"} pr-3 py-2.5 text-base sm:text-sm rounded-lg border bg-white text-charcoal-900 focus:outline-none focus:ring-2 disabled:opacity-60 ${
            error
              ? "border-red-400 focus:ring-red-500/20 focus:border-red-500"
              : "border-ivory-300 focus:ring-terracotta-500/20 focus:border-terracotta-500"
          }`}
          {...input}
        />
        {icon && <span className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none text-charcoal-400">{icon}</span>}
      </div>
      {error && (
        <p id={`${id}-error`} className="mt-1 text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

export function SubmitButton({ loading, loadingText, children, disabled }: { loading: boolean; loadingText: string; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button
      type="submit"
      disabled={loading || disabled}
      aria-busy={loading}
      className="w-full flex items-center justify-center space-x-2 py-2.5 px-4 rounded-xl bg-forest-900 hover:bg-forest-800 text-ivory-100 text-sm font-bold transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {loading ? (
        <>
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
          <span>{loadingText}</span>
        </>
      ) : (
        children
      )}
    </button>
  );
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_PASSWORD = 10;

/** First message per field from a server `fields` map. */
export function firstErrors(fields?: Record<string, string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields || {})) if (v?.length) out[k] = v[0];
  return out;
}
