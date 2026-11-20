"use client";

import React, { Suspense, useState } from "react";
import Link from "next/link";
import { ArrowRight, Building2, Lock, Mail } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { AuthCard, EMAIL_RE, Field, FormAlert, MIN_PASSWORD, SubmitButton, firstErrors } from "@/components/auth/AuthCard";

type Form = { workspaceName: string; email: string; password: string; confirmPassword: string };

// Server field names -> form field names
const SERVER_FIELD: Record<string, keyof Form> = {
  workspace_name: "workspaceName",
  email: "email",
  password: "password",
  confirm_password: "confirmPassword",
};

function validate(f: Form): Partial<Record<keyof Form, string>> {
  const errs: Partial<Record<keyof Form, string>> = {};
  if (!f.workspaceName.trim()) errs.workspaceName = "Workspace name is required.";
  else if (f.workspaceName.trim().length > 255) errs.workspaceName = "Workspace name must be at most 255 characters.";
  if (!f.email.trim()) errs.email = "Email is required.";
  else if (!EMAIL_RE.test(f.email.trim())) errs.email = "Enter a valid email address.";
  if (!f.password) errs.password = "Password is required.";
  else if (f.password.length < MIN_PASSWORD) errs.password = `Password must be at least ${MIN_PASSWORD} characters.`;
  if (!f.confirmPassword) errs.confirmPassword = "Please confirm your password.";
  else if (f.password !== f.confirmPassword) errs.confirmPassword = "Passwords do not match.";
  return errs;
}

function RegisterContent() {
  const { register } = useAuth();
  const [form, setForm] = useState<Form>({ workspaceName: "", email: "", password: "", confirmPassword: "" });
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const set = (key: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs = validate(form);
    setFieldErrors(errs);
    setError(null);
    if (Object.keys(errs).length) return;

    setIsLoading(true);
    const result = await register(form);
    if (result.error) {
      const mapped: Partial<Record<keyof Form, string>> = {};
      for (const [k, v] of Object.entries(firstErrors(result.fields))) {
        if (SERVER_FIELD[k]) mapped[SERVER_FIELD[k]] = v;
      }
      setFieldErrors(mapped);
      setError(result.error);
      setIsLoading(false);
    }
    // On success AuthContext redirects to /dashboard.
  };

  return (
    <AuthCard title="Create your account" subtitle="Set up a workspace for your brand">
      {error && <FormAlert>{error}</FormAlert>}

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <Field
          id="workspaceName"
          label="Workspace name"
          autoComplete="organization"
          value={form.workspaceName}
          onChange={set("workspaceName")}
          placeholder="Acme Apparel"
          error={fieldErrors.workspaceName}
          disabled={isLoading}
          icon={<Building2 className="w-4 h-4" />}
          maxLength={255}
          autoFocus
        />
        <Field
          id="email"
          label="Email address"
          type="email"
          autoComplete="email"
          inputMode="email"
          value={form.email}
          onChange={set("email")}
          placeholder="you@company.com"
          error={fieldErrors.email}
          disabled={isLoading}
          icon={<Mail className="w-4 h-4" />}
        />
        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          value={form.password}
          onChange={set("password")}
          placeholder={`At least ${MIN_PASSWORD} characters`}
          error={fieldErrors.password}
          disabled={isLoading}
          icon={<Lock className="w-4 h-4" />}
        />
        <Field
          id="confirmPassword"
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          value={form.confirmPassword}
          onChange={set("confirmPassword")}
          error={fieldErrors.confirmPassword}
          disabled={isLoading}
          icon={<Lock className="w-4 h-4" />}
        />
        <SubmitButton loading={isLoading} loadingText="Creating account…">
          <span>Create account</span>
          <ArrowRight className="w-4 h-4" aria-hidden />
        </SubmitButton>
      </form>

      <p className="pt-2 border-t border-ivory-200 text-center text-sm text-charcoal-500">
        Already have an account?{" "}
        <Link href="/login" className="font-semibold text-terracotta-600 hover:underline">
          Sign in
        </Link>
      </p>
    </AuthCard>
  );
}

export default function RegisterPage() {
  return (
    <Suspense fallback={null}>
      <RegisterContent />
    </Suspense>
  );
}
