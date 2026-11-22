"use client";

import React from "react";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { ModuleGuard } from "@/components/auth/ModuleGuard";
import { useAuth } from "@/context/AuthContext";
import { Package, Boxes, AlertTriangle, ArrowUpRight, BarChart3, RefreshCw } from "lucide-react";

export default function InventoryPage() {
  const { currentBrand } = useAuth();

  return (
    <DashboardShell>
      <ModuleGuard moduleKey="inventory" moduleName="Inventory Management">
        <div className="space-y-6">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-2 border-b border-ivory-300">
            <div>
              <div className="flex items-center space-x-2">
                <div className="w-9 h-9 rounded-lg bg-emerald-50 border border-emerald-200 flex items-center justify-center p-1.5 flex-shrink-0">
                  <Boxes className="w-5 h-5 text-emerald-700" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-charcoal-900 tracking-tight">
                    Inventory & Stock Levels
                  </h2>
                  <p className="text-xs text-charcoal-500 mt-0.5">
                    Multi-location stock monitoring, safety stock thresholds, and replenishment warnings for{" "}
                    <strong>{currentBrand?.name || "Active Brand"}</strong>
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* QA 2026-11-21: this module has no backend (no tables, API or sync). The figures that used to be
              hardcoded here looked like live data, so they were replaced with an explicit empty state. */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-white p-5 rounded-xl border border-charcoal-200 shadow-xs">
              <span className="text-[11px] font-bold uppercase tracking-wider text-charcoal-400">Total SKUs</span>
              <p className="text-2xl font-bold text-charcoal-300 mt-1" aria-label="No data">—</p>
              <span className="text-[11px] text-charcoal-400 font-medium mt-1 block">No data source connected</span>
            </div>
            <div className="bg-white p-5 rounded-xl border border-charcoal-200 shadow-xs">
              <span className="text-[11px] font-bold uppercase tracking-wider text-charcoal-400">Low Stock Warnings</span>
              <p className="text-2xl font-bold text-charcoal-300 mt-1" aria-label="No data">—</p>
              <span className="text-[11px] text-charcoal-400 font-medium mt-1 block">No data source connected</span>
            </div>
            <div className="bg-white p-5 rounded-xl border border-charcoal-200 shadow-xs">
              <span className="text-[11px] font-bold uppercase tracking-wider text-charcoal-400">Out of Stock</span>
              <p className="text-2xl font-bold text-charcoal-300 mt-1" aria-label="No data">—</p>
              <span className="text-[11px] text-charcoal-400 font-medium mt-1 block">No data source connected</span>
            </div>
          </div>

          <div className="bg-white p-8 rounded-xl border border-charcoal-200 text-center" role="status">
            <Boxes className="w-12 h-12 text-charcoal-300 mx-auto mb-3" />
            <h3 className="text-base font-bold text-charcoal-900">Inventory sync is not available yet</h3>
            <p className="text-xs text-charcoal-500 max-w-md mx-auto mt-1">
              Stock levels are not synchronised from Shopify in this version. Nothing on this page reflects your real inventory.
            </p>
          </div>
        </div>
      </ModuleGuard>
    </DashboardShell>
  );
}
