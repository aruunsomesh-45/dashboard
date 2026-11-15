import hashlib
import secrets
from datetime import timedelta

from django.conf import settings
from django.utils import timezone
from django.utils.text import slugify
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import User

from .models import AuditLog, Brand, Invite, Workspace, WorkspaceMember
from .permissions import (
    HasTenantAccess,
    IsWorkspaceAdmin,
    IsWorkspaceOwner,
)
from .serializers import (
    BrandSerializer,
    InviteSerializer,
    WorkspaceMemberSerializer,
    WorkspaceSerializer,
)


class WorkspaceListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    def get_user(self, request):
        return request.user

    def get(self, request):
        user = self.get_user(request)
        if not user:
            return Response({"detail": "Authentication credentials were not provided."}, status=status.HTTP_401_UNAUTHORIZED)

        memberships = (
            WorkspaceMember.objects.filter(user=user, workspace__is_active=True)
            .select_related("workspace")
            .prefetch_related("workspace__brands")
        )

        data = []
        for m in memberships:
            ws_data = WorkspaceSerializer(m.workspace).data
            ws_data["role"] = m.role
            ws_data["brands"] = [
                {
                    "id": str(b.id),
                    "name": b.name,
                    "currency": b.currency,
                    "timezone": b.timezone,
                }
                for b in m.workspace.brands.all()
            ]
            data.append(ws_data)

        return Response(data)

    def post(self, request):
        user = self.get_user(request)
        if not user:
            return Response({"detail": "Authentication credentials were not provided."}, status=status.HTTP_401_UNAUTHORIZED)

        raw_name = request.data.get("name")
        if not isinstance(raw_name, str) or not raw_name.strip():
            return Response({"error": "Workspace name is required and must be a string."}, status=status.HTTP_400_BAD_REQUEST)
        name = raw_name.strip()

        # Generate unique slug
        base_slug = slugify(name) or "workspace"
        slug = base_slug
        counter = 1
        while Workspace.objects.filter(slug=slug).exists():
            slug = f"{base_slug}-{counter}"
            counter += 1

        workspace = Workspace.objects.create(name=name, slug=slug)

        # Creator is Owner
        WorkspaceMember.objects.create(workspace=workspace, user=user, role=WorkspaceMember.Role.OWNER)

        brand = Brand.objects.create(workspace=workspace, name=f"{name} Brand", currency="INR", timezone="Asia/Kolkata")

        AuditLog.objects.create(
            workspace=workspace,
            actor=user,
            action="workspace_created",
            target=workspace.name,
        )

        resp_data = WorkspaceSerializer(workspace).data
        resp_data["role"] = WorkspaceMember.Role.OWNER
        resp_data["brands"] = [
            {
                "id": str(brand.id),
                "name": brand.name,
                "currency": brand.currency,
                "timezone": brand.timezone,
            }
        ]
        return Response(resp_data, status=status.HTTP_201_CREATED)


class WorkspaceDetailView(APIView):
    def get_permissions(self):
        # Deleting a workspace is destructive: owners only (previously any member, even viewers, could).
        if self.request.method == "DELETE":
            return [IsWorkspaceOwner()]
        return [HasTenantAccess()]

    def get(self, request, workspace_slug):
        workspace = request.tenant.workspace
        brands = workspace.brands.all()
        if request.tenant.allowed_brand_ids is not None:
            brands = brands.filter(id__in=request.tenant.allowed_brand_ids)

        return Response(
            {
                "workspace": WorkspaceSerializer(workspace).data,
                "role": request.tenant.role,
                "brands": BrandSerializer(brands, many=True).data,
            }
        )

    def delete(self, request, workspace_slug):
        workspace = request.tenant.workspace
        workspace.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class BrandListCreateView(APIView):
    def get_permissions(self):
        if self.request.method == "POST":
            return [IsWorkspaceAdmin()]
        return [HasTenantAccess()]

    def get(self, request, workspace_slug):
        workspace = request.tenant.workspace
        brands = workspace.brands.all()
        if request.tenant.allowed_brand_ids is not None:
            brands = brands.filter(id__in=request.tenant.allowed_brand_ids)
        return Response(BrandSerializer(brands, many=True).data)

    def post(self, request, workspace_slug):
        serializer = BrandSerializer(data=request.data)
        if serializer.is_valid():
            brand = serializer.save(workspace=request.tenant.workspace)
            AuditLog.objects.create(
                workspace=request.tenant.workspace,
                actor=request.user,
                action="brand_created",
                target=brand.name,
            )
            return Response(BrandSerializer(brand).data, status=status.HTTP_201_CREATED)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)


class MemberListView(APIView):
    permission_classes = [IsWorkspaceAdmin]

    def get(self, request, workspace_slug):
        members = WorkspaceMember.objects.filter(workspace=request.tenant.workspace).select_related("user")
        return Response(WorkspaceMemberSerializer(members, many=True).data)


class InviteCreateView(APIView):
    permission_classes = [IsWorkspaceAdmin]

    def post(self, request, workspace_slug):
        email = request.data.get("email", "").strip().lower()
        role = request.data.get("role", WorkspaceMember.Role.VIEWER)

        if not email:
            return Response({"error": "Email is required."}, status=status.HTTP_400_BAD_REQUEST)

        if role not in WorkspaceMember.Role.values:
            return Response(
                {"error": f"Invalid role. Must be one of {WorkspaceMember.Role.values}"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Check if already a member
        if WorkspaceMember.objects.filter(workspace=request.tenant.workspace, user__email=email).exists():
            return Response(
                {"error": "User is already a member of this workspace."}, status=status.HTTP_400_BAD_REQUEST
            )

        # Generate single-use token and store hash
        raw_token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
        expires_at = timezone.now() + timedelta(hours=72)

        # Invalidate any prior active invite for this email
        Invite.objects.filter(workspace=request.tenant.workspace, email=email, accepted_at__isnull=True).delete()

        invite = Invite.objects.create(
            workspace=request.tenant.workspace,
            email=email,
            role=role,
            token_hash=token_hash,
            expires_at=expires_at,
            created_by=request.user,
        )

        AuditLog.objects.create(
            workspace=request.tenant.workspace,
            actor=request.user,
            action="invite_created",
            target=email,
            metadata={"role": role},
        )

        return Response(
            {
                "invite": InviteSerializer(invite).data,
                "invite_token": raw_token,  # Returned once to send via email/link
                "invite_url": f"/invites/accept?token={raw_token}",
            },
            status=status.HTTP_201_CREATED,
        )


class InviteAcceptView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        raw_token = request.data.get("token", "").strip()
        if not raw_token:
            return Response({"error": "Token is required."}, status=status.HTTP_400_BAD_REQUEST)

        token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
        try:
            invite = Invite.objects.get(token_hash=token_hash, accepted_at__isnull=True)
        except Invite.DoesNotExist:
            return Response({"error": "Invalid or already accepted invite token."}, status=status.HTTP_404_NOT_FOUND)

        if invite.is_expired():
            return Response({"error": "This invite link has expired."}, status=status.HTTP_400_BAD_REQUEST)

        # Create or update WorkspaceMember
        membership, created = WorkspaceMember.objects.get_or_create(
            workspace=invite.workspace, user=request.user, defaults={"role": invite.role}
        )
        if not created:
            membership.role = invite.role
            membership.save(update_fields=["role"])

        invite.accepted_at = timezone.now()
        invite.save(update_fields=["accepted_at"])

        AuditLog.objects.create(
            workspace=invite.workspace,
            actor=request.user,
            action="invite_accepted",
            target=request.user.email,
        )

        return Response(
            {
                "message": "Invite accepted successfully.",
                "workspace": WorkspaceSerializer(invite.workspace).data,
                "role": invite.role,
            }
        )
