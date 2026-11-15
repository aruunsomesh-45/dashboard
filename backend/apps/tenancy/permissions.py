from django.http import Http404
from rest_framework.permissions import BasePermission

from .middleware import resolve_tenant_context


class HasTenantAccess(BasePermission):
    """Requires request to have an active resolved tenant context."""

    message = "Workspace not found."

    def has_permission(self, request, view):
        # If tenant was already resolved by middleware
        if hasattr(request, "tenant") and request.tenant and request.tenant.workspace:
            return True

        # If user was authenticated at the DRF view level (e.g. token or force_authenticate)
        if hasattr(view, "kwargs") and "workspace_slug" in view.kwargs:
            request.tenant = resolve_tenant_context(request.user, view.kwargs)
            return True

        return False


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
