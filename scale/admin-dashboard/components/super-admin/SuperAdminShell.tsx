"use client";

import React, { useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import {
  ShieldAlert,
  ShieldCheck,
  Users,
  Building2,
  Boxes,
  PlugZap,
  Activity,
  Cpu,
  Webhook,
  Database,
  History,
  Settings,
  ArrowLeft,
  Search,
  ExternalLink,
  Lock,
  LogOut,
  Bell,
} from "lucide-react";

const adminNav = [
  { name: "Executive Overview", href: "/super-admin", icon: Activity },
  { name: "User Management", href: "/super-admin/users", icon: Users },
  { name: "Workspaces & Brands", href: "/super-admin/workspaces", icon: Building2 },
  { name: "Module Permissions", href: "/super-admin/modules", icon: Boxes },
  { name: "Connected Integrations", href: "/super-admin/integrations", icon: PlugZap },
  { name: "Data Flow Pipelines", href: "/super-admin/data-flows", icon: Activity },
  { name: "Edge Functions", href: "/super-admin/functions", icon: Cpu },
  { name: "Webhooks Ingestion", href: "/super-admin/webhooks", icon: Webhook },
  { name: "Database Health", href: "/super-admin/database", icon: Database },
  { name: "Administrative Audit Logs", href: "/super-admin/audit-logs", icon: History },
  { name: "Platform Settings & 2FA", href: "/super-admin/settings", icon: Settings },
];

export function SuperAdminShell({ children }: { children: React.ReactNode }) {
  const { user, isSuperAdmin, isLoading, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  // Strict route guard: non-super-admins cannot access /super-admin
  if (isLoading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-forest-950 font-sans">
        <div className="flex flex-col items-center space-y-3">
          <div className="w-8 h-8 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
          <div className="text-xs text-ivory-300 font-medium">Verifying Platform Super Admin Access…</div>
        </div>
      </div>
    );
  }

  if (!user || !isSuperAdmin) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-forest-950 font-sans p-4">
        <div className="max-w-md w-full bg-forest-900 border border-forest-800 rounded-2xl p-8 text-center shadow-2xl">
          <div className="w-16 h-16 mx-auto rounded-2xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400 mb-5">
            <Lock className="w-8 h-8" />
          </div>
          <h1 className="text-xl font-bold text-ivory-100 mb-2">Access Denied</h1>
          <p className="text-xs text-ivory-300 leading-relaxed mb-6">
            You do not possess the required Super Admin privileges to view the platform administration area. This action has been logged in security audit logs.
          </p>
          <div className="space-y-3">
            <Link
              href="/dashboard"
              className="w-full flex items-center justify-center space-x-2 px-4 py-2.5 rounded-xl bg-forest-800 hover:bg-forest-700 text-ivory-100 text-xs font-semibold transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Return to Standard Dashboard</span>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-ivory-100 font-sans">
      {/* Super Admin Sidebar (Dark Obsidian / Forest) */}
      <aside className="w-64 flex-shrink-0 flex flex-col justify-between bg-forest-950 text-ivory-200 border-r border-forest-800">
        <div className="flex flex-col overflow-y-auto">
          {/* Brand & Badge Header */}
          <div className="p-4 border-b border-forest-800/80">
            <div className="flex items-center space-x-2.5 mb-2">
              <div className="w-8 h-8 rounded-lg bg-amber-500 flex items-center justify-center text-forest-950 font-bold shadow-md">
                <ShieldCheck className="w-5 h-5 text-forest-950" />
              </div>
              <div>
                <div className="text-sm font-bold text-ivory-100 tracking-tight">125 EAST</div>
                <div className="text-[10px] text-amber-400 font-semibold uppercase tracking-wider">Super Admin</div>
              </div>
            </div>
            <div className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-forest-900 border border-forest-800 text-[11px] text-ivory-300">
              <span className="flex items-center space-x-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span className="font-medium">System Online</span>
              </span>
              <span className="text-[10px] text-forest-400">v1.2-sec</span>
            </div>
          </div>

          {/* Navigation Links */}
          <nav className="p-3 space-y-1">
            <div className="text-[10px] font-bold text-forest-500 uppercase tracking-wider px-2 py-1">
              Platform Controls
            </div>
            {adminNav.map((item) => {
              const Icon = item.icon;
              const isActive = pathname === item.href || (item.href !== "/super-admin" && pathname.startsWith(item.href));
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  className={`flex items-center space-x-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                    isActive
                      ? "bg-amber-500 text-forest-950 font-bold shadow-sm"
                      : "text-ivory-300 hover:bg-forest-900 hover:text-ivory-100"
                  }`}
                >
                  <Icon className={`w-4 h-4 ${isActive ? "text-forest-950" : "text-amber-400/80"}`} />
                  <span className="truncate">{item.name}</span>
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Footer: Return to store & profile */}
        <div className="p-3 border-t border-forest-800/80 bg-forest-900/60">
          <Link
            href="/dashboard"
            className="flex items-center space-x-2 px-3 py-2 rounded-lg text-xs text-amber-300 hover:bg-forest-800 transition-colors mb-2 font-medium"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Switch to Brand Store</span>
          </Link>
          <div className="flex items-center justify-between pt-2 border-t border-forest-800/60 px-1">
            <div className="truncate">
              <div className="text-xs font-medium text-ivory-100 truncate">{user.email}</div>
              <div className="text-[10px] text-emerald-400 font-semibold uppercase">Super Administrator</div>
            </div>
            <button
              onClick={logout}
              title="Sign Out"
              className="p-1.5 rounded-lg text-forest-400 hover:text-rose-400 hover:bg-forest-800 transition-colors"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top Header */}
        <header className="h-14 border-b border-ivory-300 bg-white flex items-center justify-between px-6 flex-shrink-0 shadow-xs">
          <div className="flex items-center space-x-3">
            <div className="text-xs font-bold uppercase tracking-wider text-charcoal-500">
              Platform Administration
            </div>
            <span className="text-ivory-400">/</span>
            <div className="text-xs font-bold text-charcoal-900 capitalize">
              {pathname === "/super-admin"
                ? "Executive Overview"
                : pathname.split("/")[2]?.replace(/-/g, " ") || "Control Panel"}
            </div>
          </div>

          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2 px-3 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-800 text-[11px] font-semibold">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              <span>Multi-Tenant Guard Active</span>
            </div>
            <div className="h-4 w-px bg-ivory-300" />
            <div className="text-xs text-charcoal-500">
              Admin: <span className="font-semibold text-charcoal-800">{user.email}</span>
            </div>
          </div>
        </header>

        {/* Scrollable View Container */}
        <main className="flex-1 overflow-y-auto p-6 md:p-8 bg-ivory-100">
          <div className="max-w-7xl mx-auto">{children}</div>
        </main>
      </div>
    </div>
  );
}
