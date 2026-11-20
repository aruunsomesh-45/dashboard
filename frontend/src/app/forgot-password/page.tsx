"use client";

import React, { useState } from "react";
import Link from "next/link";
import { Mail } from "lucide-react";
import { apiFetch, ensureCsrf } from "@/lib/api";
import { AuthCard, EMAIL_RE, Field, FormAlert, SubmitButton } from "@/components/auth/AuthCard";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!EMAIL_RE.test(email.trim())) {
      setFieldError("Enter a valid email address.");
      return;
    }
    setFieldError(undefined);
    setIsLoading(true);
    try {
      await ensureCsrf();
      const res = await apiFetch<{ message: string }>("/api/auth/password-reset/", {
        method: "POST",
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      setSent(res.message);
    } catch (err: any) {
      setError(err?.status === 429 ? "Too many attempts. Please wait a minute and try again." : err?.message || "Something went wrong.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthCard title="Reset your password" subtitle="We'll email you a link to choose a new one">
      {sent ? (
        <FormAlert kind="success">{sent}</FormAlert>
      ) : (
        <>
          {error && <FormAlert>{error}</FormAlert>}
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <Field
              id="email"
              label="Email address"
              type="email"
              autoComplete="email"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              error={fieldError}
              disabled={isLoading}
              icon={<Mail className="w-4 h-4" />}
              autoFocus
            />
            <SubmitButton loading={isLoading} loadingText="Sending…">
              Send reset link
            </SubmitButton>
          </form>
        </>
      )}
      <p className="pt-2 border-t border-ivory-200 text-center text-sm text-charcoal-500">
        <Link href="/login" className="font-semibold text-terracotta-600 hover:underline">
          Back to sign in
        </Link>
      </p>
    </AuthCard>
  );
}
