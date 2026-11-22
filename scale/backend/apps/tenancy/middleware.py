import uuid
from dataclasses import dataclass
from typing import Any

from django.http import Http404
from django.utils.deprecation import MiddlewareMixin

from .models import Brand, BrandMember, WorkspaceMember


@dataclass
class TenantContext:
    workspace: Any
    role: str
    brand: Any | None = None
    allowed_brand_ids: set[uuid.UUID] | None = None

    @property
    def is_owner(self) -> bool:
        return self.role == WorkspaceMember.Role.OWNER

    @property
    def is_admin(self) -> bool:
        return self.role in [WorkspaceMember.Role.OWNER, WorkspaceMember.Role.ADMIN]

    @property
    def is_analyst(self) -> bool:
        return self.role in [
            WorkspaceMember.Role.OWNER,
            WorkspaceMember.Role.ADMIN,
            WorkspaceMember.Role.ANALYST,
        ]


def resolve_tenant_context(user, view_kwargs) -> TenantContext:
    """
    Resolves TenantContext from URL kwargs and User membership.
    Raises Http404 if not found or unauthorized to prevent tenant enumeration.
    """
    workspace_slug = view_kwargs.get("workspace_slug")
    if not workspace_slug:
        return None

    if not user or not user.is_authenticated:
        # No development bypass: unauthenticated callers never resolve a tenant.
        raise Http404("Workspace not found")

    try:
        membership = WorkspaceMember.objects.select_related("workspace").get(
            workspace__slug=workspace_slug,
            workspace__is_active=True,
            user=user,
        )
    except WorkspaceMember.DoesNotExist:
        raise Http404("Workspace not found") from None

    # Check brand restrictions if any
    user_brand_memberships = BrandMember.objects.filter(
        brand__workspace=membership.workspace,
        user=user,
    ).values_list("brand_id", flat=True)

    allowed_brand_ids = set(user_brand_memberships) if user_brand_memberships.exists() else None

    active_brand = None
    brand_id = view_kwargs.get("brand_id")
    if brand_id:
        try:
            active_brand = Brand.objects.get(
                id=brand_id,
                workspace=membership.workspace,
            )
        except (Brand.DoesNotExist, ValueError):
            raise Http404("Brand not found") from None

        if allowed_brand_ids is not None and active_brand.id not in allowed_brand_ids:
            raise Http404("Brand not found") from None

    return TenantContext(
        workspace=membership.workspace,
        role=membership.role,
        brand=active_brand,
        allowed_brand_ids=allowed_brand_ids,
    )


class TenancyMiddleware(MiddlewareMixin):
    def process_view(self, request, view_func, view_args, view_kwargs):
        workspace_slug = view_kwargs.get("workspace_slug")
        if not workspace_slug:
            request.tenant = None
            return None

        # If user is authenticated via session, resolve tenant immediately
        if request.user.is_authenticated:
            request.tenant = resolve_tenant_context(request.user, view_kwargs)
        else:
            request.tenant = None

        return None
