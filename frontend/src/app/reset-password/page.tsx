"use client";

import React, { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Lock } from "lucide-react";
import { ApiError, apiFetch, ensureCsrf } from "@/lib/api";
import { AuthCard, Field, FormAlert, MIN_PASSWORD, SubmitButton } from "@/components/auth/AuthCard";

function ResetPasswordContent() {
  const router = useRouter();
  const params = useSearchParams();
  const uid = params.get("uid") || "";
  const token = params.get("token") || "";

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  if (!uid || !token) {
    return (
      <AuthCard title="Reset your password">
        <FormAlert>This password reset link is incomplete. Please request a new one.</FormAlert>
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
        body: JSON.stringify({ uid, token, password, confirm_password: confirmPassword }),
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
