"use client";

import React, { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowRight, Lock, Mail } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { AuthCard, EMAIL_RE, Field, FormAlert, SubmitButton, firstErrors } from "@/components/auth/AuthCard";

function LoginContent() {
  const searchParams = useSearchParams();
  const { login } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const paramEmail = searchParams.get("email");
    if (paramEmail) setEmail(paramEmail);
    if (searchParams.get("reason") === "expired") setError("Your session expired. Please sign in again.");
    if (searchParams.get("reset") === "1") setNotice("Your password has been reset. Sign in with your new password.");
  }, [searchParams]);

  const validate = () => {
    const errs: Record<string, string> = {};
    if (!email.trim()) errs.email = "Email is required.";
    else if (!EMAIL_RE.test(email.trim())) errs.email = "Enter a valid email address.";
    if (!password) errs.password = "Password is required.";
    return errs;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs = validate();
    setFieldErrors(errs);
    setNotice(null);
    if (Object.keys(errs).length) {
      setError(null);
      return;
    }
    setError(null);
    setIsLoading(true);
    const result = await login(email, password);
    if (result.error) {
      setError(result.error);
      setFieldErrors(firstErrors(result.fields));
      setIsLoading(false);
    }
    // On success AuthContext navigates away; keep the button in its loading state until it does.
  };

  return (
    <AuthCard title="Sign in" subtitle="Welcome back to your dashboard">
      {notice && <FormAlert kind="success">{notice}</FormAlert>}
      {error && <FormAlert>{error}</FormAlert>}

      <form onSubmit={handleSubmit} method="POST" className="space-y-4" noValidate>
        <Field
          id="email"
          label="Email address"
          type="email"
          autoComplete="email"
          inputMode="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          error={fieldErrors.email}
          disabled={isLoading}
          icon={<Mail className="w-4 h-4" />}
          autoFocus
        />
        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fieldErrors.password}
          disabled={isLoading}
          icon={<Lock className="w-4 h-4" />}
          labelAside={
            <Link href="/forgot-password" className="text-xs font-semibold text-terracotta-600 hover:underline">
              Forgot password?
            </Link>
          }
        />
        <SubmitButton loading={isLoading} loadingText="Signing in…">
          <span>Sign in</span>
          <ArrowRight className="w-4 h-4" aria-hidden />
        </SubmitButton>
      </form>

      <p className="pt-2 border-t border-ivory-200 text-center text-sm text-charcoal-500">
        Don&apos;t have an account?{" "}
        <Link
          href={searchParams.get("next") ? `/register?next=${encodeURIComponent(searchParams.get("next") as string)}` : "/register"}
          className="font-semibold text-terracotta-600 hover:underline"
        >
          Create account
        </Link>
      </p>
    </AuthCard>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginContent />
    </Suspense>
  );
}
