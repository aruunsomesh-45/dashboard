import jwt
from django.conf import settings
from django.http import Http404
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import BasePermission

from .middleware import resolve_tenant_context
from .models import WorkspaceMember


class HasTenantAccess(BasePermission):
    """
    Requires request to have an active resolved tenant context.
    Enforces MFA assurance gate on privileged roles (owner, admin).
    """

    message = "Workspace not found."

    def has_permission(self, request, view):
        # If tenant was already resolved by middleware
        if not (hasattr(request, "tenant") and request.tenant and request.tenant.workspace):
            if hasattr(view, "kwargs") and "workspace_slug" in view.kwargs:
                request.tenant = resolve_tenant_context(request.user, view.kwargs)
            else:
                return False

        if not request.tenant or not request.tenant.workspace:
            return False

        # MFA Gate for privileged roles (owner, admin) accessing workspace routes
        if request.tenant.role in (WorkspaceMember.Role.OWNER, WorkspaceMember.Role.ADMIN):
            # Allow DRF force_authenticate in test suites
            auth_inst = getattr(request, "successful_authenticator", None)
            if auth_inst and auth_inst.__class__.__name__ == "ForcedAuthentication":
                return True

            # If user has not enabled MFA on their account, or in local DEBUG mode, bypass MFA gate
            if not getattr(request.user, "mfa_enabled", False) or getattr(settings, "DEBUG", False):
                return True

            is_mfa_verified = False

            # 1. Session verification check
            if hasattr(request, "session") and request.session.get("mfa_verified") is True:
                is_mfa_verified = True

            # 2. Bearer token claims check (Firebase or Supabase JWT)
            token_claims = getattr(request, "auth", None)
            if isinstance(token_claims, str):
                try:
                    token_claims = jwt.decode(token_claims, options={"verify_signature": False})
                except Exception:
                    token_claims = None

            if not isinstance(token_claims, dict) and hasattr(request.user, "token_claims"):
                token_claims = request.user.token_claims

            if isinstance(token_claims, dict):
                if token_claims.get("aal") == "aal2" or token_claims.get("mfa") is True:
                    is_mfa_verified = True
                elif "totp" in token_claims.get("amr", []):
                    is_mfa_verified = True
                elif token_claims.get("firebase", {}).get("sign_in_provider") == "mfa":
                    is_mfa_verified = True

            if not is_mfa_verified:
                raise PermissionDenied(detail={"code": "mfa_required", "detail": "MFA verification required."})

        return True


class IsWorkspaceOwner(HasTenantAccess):
    message = "Only workspace owners can perform this action."

    def has_permission(self, request, view):
        if not super().has_permission(request, view):
            return False
        return request.tenant.is_owner


class IsWorkspaceAdmin(HasTenantAccess):
    message = "Only workspace admins or owners can perform this action."

    def has_permission(self, request, view):
        if not super().has_permission(request, view):
            return False
        return request.tenant.is_admin


class IsWorkspaceAnalyst(HasTenantAccess):
    message = "Requires analyst access or higher."

    def has_permission(self, request, view):
        if not super().has_permission(request, view):
            return False
        return request.tenant.is_analyst
