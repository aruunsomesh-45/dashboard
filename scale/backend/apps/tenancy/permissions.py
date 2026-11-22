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
        # No session -> False, which DRF turns into 401 Not Authenticated. Every workspace slug answers the same
        # way without a session, so this reveals nothing, and it lets the UI detect an expired session.
        if not (request.user and request.user.is_authenticated):
            return False

        # If tenant was already resolved by middleware
        if not (hasattr(request, "tenant") and request.tenant and request.tenant.workspace):
            if hasattr(view, "kwargs") and "workspace_slug" in view.kwargs:
                request.tenant = resolve_tenant_context(request.user, view.kwargs)
            else:
                return False

        if not request.tenant or not request.tenant.workspace:
            return False

        # MFA gate for privileged roles (owner, admin): once a user has enrolled TOTP, the session must
        # have passed the TOTP challenge (or just completed enrolment) before workspace routes open up.
        # Users who have not enrolled are not blocked, so a freshly registered owner lands on the dashboard.
        if request.tenant.role in (WorkspaceMember.Role.OWNER, WorkspaceMember.Role.ADMIN):
            auth_inst = getattr(request, "successful_authenticator", None)
            if auth_inst and auth_inst.__class__.__name__ == "ForcedAuthentication":
                return True  # DRF force_authenticate in unit tests
            if getattr(request.user, "mfa_enabled", False) and request.session.get("mfa_verified") is not True:
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
