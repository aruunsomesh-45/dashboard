"use client";

import React, { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Lock } from "lucide-react";
import { ApiError, apiFetch, ensureCsrf } from "@/lib/api";
import { AuthCard, Field, FormAlert, MIN_PASSWORD, SubmitButton } from "@/components/auth/AuthCard";

function ResetPasswordContent() {
  const router = useRouter();
  // Supabase's emailed recovery link lands here as /reset-password#access_token=...&type=recovery
  // (or #error=...&error_description=... when the link expired). The fragment never reaches a server.
  const [token, setToken] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const accessToken = hash.get("access_token");
    if (hash.get("error") || hash.get("error_code")) {
      setLinkError((hash.get("error_description") || "This password reset link is invalid or has expired.").replace(/\+/g, " "));
    } else if (accessToken && hash.get("type") === "recovery") {
      setToken(accessToken);
    }
    // Drop the token from the address bar and history.
    if (window.location.hash) window.history.replaceState({}, "", window.location.pathname);
    setReady(true);
  }, []);

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  if (!ready) return null;

  if (!token) {
    return (
      <AuthCard title="Reset your password">
        <FormAlert>{linkError || "This password reset link is incomplete. Please request a new one."}</FormAlert>
        <Link href="/forgot-password" className="block text-center text-sm font-semibold text-terracotta-600 hover:underline">
          Request a new link
        </Link>
      </AuthCard>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (password.length < MIN_PASSWORD) errs.password = `Password must be at least ${MIN_PASSWORD} characters.`;
    if (password !== confirmPassword) errs.confirmPassword = "Passwords do not match.";
    setFieldErrors(errs);
    setError(null);
    if (Object.keys(errs).length) return;

    setIsLoading(true);
    try {
      await ensureCsrf();
      await apiFetch("/api/auth/password-reset/confirm/", {
        method: "POST",
        body: JSON.stringify({ access_token: token, password, confirm_password: confirmPassword }),
      });
      router.replace("/login?reset=1");
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.status === 429 ? "Too many attempts. Please wait a minute and try again." : err.message);
        setFieldErrors({ password: err.fields.password?.[0] || "", confirmPassword: err.fields.confirm_password?.[0] || "" });
      } else {
        setError("Something went wrong. Please try again.");
      }
      setIsLoading(false);
    }
  };

  return (
    <AuthCard title="Choose a new password">
      {error && <FormAlert>{error}</FormAlert>}
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <Field
          id="password"
          label="New password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={`At least ${MIN_PASSWORD} characters`}
          error={fieldErrors.password || undefined}
          disabled={isLoading}
          icon={<Lock className="w-4 h-4" />}
          autoFocus
        />
        <Field
          id="confirmPassword"
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          error={fieldErrors.confirmPassword || undefined}
          disabled={isLoading}
          icon={<Lock className="w-4 h-4" />}
        />
        <SubmitButton loading={isLoading} loadingText="Saving…">
          Set new password
        </SubmitButton>
      </form>
    </AuthCard>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordContent />
    </Suspense>
  );
}
