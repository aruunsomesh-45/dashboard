export type UserRole = "owner" | "admin" | "analyst" | "viewer";

export interface User {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  mfa_enabled: boolean;
  created_at: string;
}

export interface Brand {
  id: string;
  name: string;
  currency: string;
  timezone: string;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  role: UserRole;
  brands: Brand[];
}

export interface WorkspaceMember {
  id: string;
  user: User;
  role: UserRole;
  created_at: string;
}

export interface Invite {
  id: string;
  email: string;
  role: UserRole;
  expires_at: string;
  accepted_at: string | null;
  created_by_email: string;
  created_at: string;
}
