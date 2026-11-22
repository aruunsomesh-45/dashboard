"use client";

import React from "react";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { ShieldAlert, ArrowLeft, Lock } from "lucide-react";

interface ModuleGuardProps {
  moduleKey: string;
  moduleName?: string;
  children: React.ReactNode;
}

export function ModuleGuard({ moduleKey, moduleName, children }: ModuleGuardProps) {
  const { hasModule, isSuperAdmin, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="w-6 h-6 border-2 border-forest-900 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const allowed = isSuperAdmin || hasModule(moduleKey);

  if (!allowed) {
    return (
      <div className="p-8 max-w-2xl mx-auto my-12 bg-white rounded-2xl border border-ivory-300 shadow-sm text-center">
        <div className="w-14 h-14 mx-auto rounded-2xl bg-terracotta-100 flex items-center justify-center text-terracotta-600 mb-5">
          <Lock className="w-7 h-7" />
        </div>
        <h2 className="text-xl font-bold text-charcoal-900 mb-2">
          Module Access Restricted
        </h2>
        <p className="text-sm text-charcoal-500 mb-6 leading-relaxed">
          The <span className="font-semibold text-charcoal-800">{moduleName || moduleKey}</span> module has not been enabled for your user account or workspace. Please contact your platform Super Admin to request activation.
        </p>

        <div className="p-4 bg-ivory-50 rounded-xl border border-ivory-200 text-xs text-charcoal-600 mb-6 flex items-center justify-center space-x-2">
          <ShieldAlert className="w-4 h-4 text-terracotta-500 flex-shrink-0" />
          <span>Enforced server-side via 125East Per-User Module Permission Guard.</span>
        </div>

        <Link
          href="/dashboard"
          className="inline-flex items-center space-x-2 px-5 py-2.5 bg-forest-900 text-ivory-100 rounded-xl text-xs font-semibold hover:bg-forest-800 transition-colors shadow-sm"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Return to Dashboard</span>
        </Link>
      </div>
    );
  }

  return <>{children}</>;
}
