import React from "react";
import { SuperAdminShell } from "@/components/super-admin/SuperAdminShell";

export const metadata = {
  title: "125 EAST - Super Admin Dashboard",
  description: "Platform Administration and Per-User Module Control",
};

export default function SuperAdminLayout({ children }: { children: React.ReactNode }) {
  return <SuperAdminShell>{children}</SuperAdminShell>;
}
