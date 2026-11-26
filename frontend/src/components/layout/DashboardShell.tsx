"use client";

import React, { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { Briefcase, Link2,
  LayoutDashboard,
  ShoppingBag,
  Megaphone,
  CreditCard,
  Truck,
  Users,
  Settings,
  LogOut,
  ChevronDown,
  Plus,
  ShieldCheck,
  Building2,
  Tag,
  ReceiptText,
  PlugZap,
  Boxes,
  Award,
  ShieldAlert,
} from "lucide-react";
import { apiFetch } from "@/lib/api";

interface NavItem {
  name: string;
  href: string;
  icon: any;
  module?: string;
}

const navItems: NavItem[] = [
  { name: "Overview", href: "/dashboard", icon: LayoutDashboard },
  { name: "P&L Statement", href: "/pnl", icon: ReceiptText },
  { name: "Connect Apps", href: "/integrations", icon: PlugZap },
  { name: "Shopify Store", href: "/shopify", icon: ShoppingBag, module: "shopify" },
  { name: "Marketing & Ads", href: "/marketing", icon: Megaphone, module: "meta_ads" },
  { name: "Campaign Links", href: "/marketing/links", icon: Link2 },
  { name: "Payments", href: "/payments", icon: CreditCard, module: "razorpay" },
  { name: "Logistics", href: "/logistics", icon: Truck, module: "delivery" },
  { name: "Workspace", href: "/workspace", icon: Briefcase },
  { name: "Team & Access", href: "/team", icon: Users },
  { name: "Settings", href: "/settings", icon: Settings },
];

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const {
    user,
    workspaces,
    currentWorkspace,
    currentBrand,
    setCurrentWorkspace,
    setCurrentBrand,
    logout,
    refreshAuth,
    isLoading,
    isSuperAdmin,
    hasModule,
  } = useAuth();

  const pathname = usePathname();
  const [showWsMenu, setShowWsMenu] = useState(false);
  // Phone and tablet: the sidebar opens as a drawer from the header's menu button.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [showBrandMenu, setShowBrandMenu] = useState(false);
  const [showNewWsModal, setShowNewWsModal] = useState(false);
  const [newWsName, setNewWsName] = useState("");
  const [isCreatingWs, setIsCreatingWs] = useState(false);

  const handleCreateWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newWsName.trim()) return;
    setIsCreatingWs(true);
    try {
      await apiFetch("/api/w", {
        method: "POST",
        body: JSON.stringify({ name: newWsName }),
      });
      setNewWsName("");
      setShowNewWsModal(false);
      await refreshAuth();
    } catch (err: any) {
      alert(err.message || "Failed to create workspace");
    } finally {
      setIsCreatingWs(false);
    }
  };

  // Route guard: nothing from a protected page renders until the server confirms the session.
  // (AuthContext performs the redirect to /login; this prevents a flash of protected UI.)
  if (isLoading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-ivory-100 font-sans" role="status" aria-live="polite">
        <div className="flex flex-col items-center space-y-3">
          <div className="w-6 h-6 border-2 border-forest-900 border-t-transparent rounded-full animate-spin" />
          <div className="text-xs text-charcoal-500 font-medium">Verifying your session…</div>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-ivory-100 font-sans" role="status" aria-live="polite">
        <div className="flex flex-col items-center space-y-3 text-center p-6 bg-white rounded-xl border border-ivory-300 shadow-sm max-w-sm">
          <div className="text-sm font-bold text-charcoal-900">Sign In Required</div>
          <p className="text-xs text-charcoal-500">
            Please log in with your account to access the dashboard and manage integrations.
          </p>
          <a
            href="/login"
            className="px-4 py-2 bg-forest-900 text-ivory-100 rounded-lg text-xs font-semibold hover:bg-forest-800 transition-colors"
          >
            Go to Login
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-ivory-100 font-sans">
      {/* Backdrop for the phone drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 bg-black/40 z-30 md:hidden" onClick={() => setMobileNavOpen(false)} aria-hidden="true" />
      )}
      {/* Sidebar (Forest Green): fixed column on desktop, drawer on phones */}
      <aside
        className={`w-64 flex-shrink-0 flex flex-col justify-between bg-forest-900 text-ivory-200 border-r border-forest-800 fixed md:static inset-y-0 left-0 z-40 transform transition-transform duration-200 md:translate-x-0 ${
          mobileNavOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div>
          {/* Logo & Platform Header */}
          <div className="px-5 py-4 border-b border-forest-800 flex items-center justify-between">
            <div className="flex items-center space-x-2.5">
              <div className="w-8 h-8 rounded-lg bg-terracotta-500 flex items-center justify-center text-white font-bold text-base shadow-sm">
                <Building2 className="w-4 h-4 text-white" />
              </div>
              <div>
                <h1 className="text-sm font-semibold tracking-wide text-ivory-100">
                  Dashboard
                </h1>
              </div>
            </div>
          </div>

          {/* Workspace Switcher */}
          <div className="p-3 border-b border-forest-800 relative">
            <div className="text-[10px] font-semibold tracking-wider text-forest-500 uppercase px-2 mb-1">
              Workspace
            </div>
            <button
              aria-label="Workspace switcher"
              data-testid="workspace-switcher-btn"
              onClick={() => {
                setShowWsMenu(!showWsMenu);
                setShowBrandMenu(false);
              }}
              className="w-full flex items-center justify-between px-3 py-2 rounded-md bg-forest-800 hover:bg-forest-700 text-left text-xs font-medium text-ivory-100 transition-colors"
            >
              <div className="flex items-center space-x-2 truncate">
                <Building2 className="w-4 h-4 text-terracotta-400 flex-shrink-0" />
                <span className="truncate">
                  {currentWorkspace?.name || "Select Workspace"}
                </span>
              </div>
              <ChevronDown className="w-3.5 h-3.5 text-forest-500 flex-shrink-0" />
            </button>

            {/* Dropdown */}
            {showWsMenu && (
              <div className="absolute left-3 right-3 top-16 z-30 bg-forest-800 border border-forest-700 rounded-lg shadow-xl p-1.5 space-y-1">
                {workspaces.map((ws) => (
                  <button
                    key={ws.id}
                    onClick={() => {
                      setCurrentWorkspace(ws);
                      setShowWsMenu(false);
                    }}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded text-xs text-left ${
                      currentWorkspace?.id === ws.id
                        ? "bg-terracotta-500 text-white font-semibold"
                        : "text-ivory-200 hover:bg-forest-700"
                    }`}
                  >
                    <span className="truncate">{ws.name}</span>
                    <span className="text-[10px] uppercase opacity-75">{ws.role}</span>
                  </button>
                ))}
                <button
                  onClick={() => {
                    setShowWsMenu(false);
                    setShowNewWsModal(true);
                  }}
                  className="w-full flex items-center space-x-1.5 px-2.5 py-1.5 text-xs text-terracotta-400 hover:bg-forest-700 rounded text-left font-medium mt-1 border-t border-forest-700"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>+ New Workspace</span>
                </button>
              </div>
            )}
          </div>

          {/* Brand Switcher */}
          {currentWorkspace && currentWorkspace.brands && currentWorkspace.brands.length > 0 && (
            <div className="px-3 py-2 border-b border-forest-800 relative">
              <div className="text-[10px] font-semibold tracking-wider text-forest-500 uppercase px-2 mb-1">
                Active Brand
              </div>
              <button
                onClick={() => {
                  setShowBrandMenu(!showBrandMenu);
                  setShowWsMenu(false);
                }}
                className="w-full flex items-center justify-between px-3 py-1.5 rounded-md bg-forest-900 border border-forest-700 hover:border-forest-600 text-left text-xs font-medium text-ivory-200 transition-colors"
              >
                <div className="flex items-center space-x-2 truncate">
                  <Tag className="w-3.5 h-3.5 text-forest-500 flex-shrink-0" />
                  <span className="truncate">
                    {currentBrand?.name || "All Brands"}
                  </span>
                </div>
                <ChevronDown className="w-3 h-3 text-forest-500 flex-shrink-0" />
              </button>

              {showBrandMenu && (
                <div className="absolute left-3 right-3 top-14 z-30 bg-forest-800 border border-forest-700 rounded-lg shadow-xl p-1.5 space-y-1">
                  {currentWorkspace.brands.map((b) => (
                    <button
                      key={b.id}
                      onClick={() => {
                        setCurrentBrand(b);
                        setShowBrandMenu(false);
                      }}
                      className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded text-xs text-left ${
                        currentBrand?.id === b.id
                          ? "bg-forest-700 text-terracotta-400 font-semibold"
                          : "text-ivory-200 hover:bg-forest-700"
                      }`}
                    >
                      <span className="truncate">{b.name}</span>
                      <span className="text-[10px] opacity-75">{b.currency}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Navigation Links */}
          <nav className="p-3 space-y-1">
            {navItems
              .filter((item) => !item.module || hasModule(item.module))
              .map((item) => {
                const Icon = item.icon;
                const isActive = pathname === item.href || (item.href === "/dashboard" && pathname === "/");
                return (
                  <Link
                    key={item.name}
                    href={item.href}
                    onClick={() => setMobileNavOpen(false)}
                    className={`flex items-center space-x-3 px-3 py-2 rounded-md text-xs font-medium transition-all ${
                      isActive
                        ? "bg-terracotta-500 text-white shadow-sm"
                        : "text-ivory-300 hover:bg-forest-800 hover:text-ivory-100"
                    }`}
                  >
                    <Icon className={`w-4 h-4 ${isActive ? "text-white" : "text-forest-500"}`} />
                    <span>{item.name}</span>
                  </Link>
                );
              })}
          </nav>
        </div>

        {/* User Profile & Security Footer */}
        <div className="p-3 border-t border-forest-800 bg-forest-950">
          <div className="flex items-center justify-between mb-2 px-1">
            <div className="flex items-center space-x-1.5 truncate">
              <span className="w-2 h-2 rounded-full bg-emerald-500" />
              <span className="text-xs font-medium text-ivory-100 truncate">
                {user?.email || "User"}
              </span>
            </div>
            {currentWorkspace && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-forest-800 text-terracotta-400">
                {currentWorkspace.role}
              </span>
            )}
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-forest-800/60 text-xs">
            <Link
              href="/mfa-setup"
              className="flex items-center space-x-1.5 text-forest-500 hover:text-ivory-200 text-[11px]"
            >
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              <span>{user?.mfa_enabled ? "MFA Active" : "Enable MFA"}</span>
            </Link>

            <button
              onClick={() => logout()}
              className="flex items-center space-x-1 text-red-400 hover:text-red-300 text-[11px]"
              title="Sign Out"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Sign Out</span>
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content Area (Ivory Surfaces) */}
      <main className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        {/* Header Bar */}
        <header className="h-14 border-b border-ivory-300 bg-white px-3 md:px-6 flex items-center justify-between gap-2 sticky top-0 z-10 shadow-sm">
          <div className="flex items-center gap-2 md:space-x-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="md:hidden flex-shrink-0 px-2.5 py-1.5 rounded-md border border-ivory-300 text-charcoal-700 text-sm font-semibold"
              aria-label="Open menu"
            >
              ☰
            </button>
            <span className="hidden sm:inline text-xs font-semibold uppercase tracking-wider text-charcoal-500 truncate">
              {currentWorkspace?.name}
            </span>
            <span className="hidden sm:inline text-charcoal-400">/</span>
            <span className="text-sm font-semibold text-charcoal-900 truncate">
              {currentBrand ? currentBrand.name : "All Brands"}
            </span>
            <span className="hidden md:inline text-[10px] font-mono px-2 py-0.5 rounded bg-ivory-200 text-charcoal-700 border border-ivory-300">
              {currentBrand?.currency || "INR"} ({currentBrand?.timezone || "Asia/Kolkata"})
            </span>
          </div>

          <div className="flex items-center space-x-3">
            <div className="px-3 py-1 rounded-md bg-ivory-200 border border-ivory-300 text-xs font-medium text-charcoal-700">
              Date: Last 30 Days
            </div>
            <div className="w-2.5 h-2.5 rounded-full bg-emerald-500" title="Engine Healthy" />
          </div>
        </header>

        {/* Dynamic Page Content */}
        <div className="p-6 max-w-7xl w-full mx-auto">{children}</div>
      </main>

      {/* New Workspace Modal */}
      {showNewWsModal && (
        <div className="fixed inset-0 z-50 bg-charcoal-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6 border border-ivory-300">
            <h3 className="text-base font-semibold text-charcoal-900 mb-1">
              Create New Workspace
            </h3>
            <p className="text-xs text-charcoal-500 mb-4">
              A workspace isolates your company&apos;s brands, integrations, and members.
            </p>

            <form onSubmit={handleCreateWorkspace} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-charcoal-700 mb-1">
                  Workspace Company Name
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Acme Retail Ltd"
                  value={newWsName}
                  onChange={(e) => setNewWsName(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-md border border-ivory-300 focus:outline-none focus:border-terracotta-500 bg-ivory-50 text-charcoal-900"
                />
              </div>

              <div className="flex justify-end space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowNewWsModal(false)}
                  className="px-3 py-1.5 rounded-md text-xs font-medium text-charcoal-500 hover:bg-ivory-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isCreatingWs}
                  className="px-4 py-1.5 rounded-md text-xs font-medium bg-terracotta-500 hover:bg-terracotta-600 text-white disabled:opacity-50"
                >
                  {isCreatingWs ? "Creating..." : "Create Workspace"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
