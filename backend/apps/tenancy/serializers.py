from rest_framework import serializers

from apps.accounts.serializers import UserSerializer

from .models import AuditLog, Brand, Invite, Workspace, WorkspaceMember


class WorkspaceSerializer(serializers.ModelSerializer):
    class Meta:
        model = Workspace
        fields = ["id", "name", "slug", "plan", "is_active", "created_at"]
        read_only_fields = ["id", "created_at"]


class BrandSerializer(serializers.ModelSerializer):
    class Meta:
        model = Brand
        fields = ["id", "workspace", "name", "timezone", "currency", "created_at"]
        read_only_fields = ["id", "workspace", "created_at"]


class WorkspaceMemberSerializer(serializers.ModelSerializer):
    user = UserSerializer(read_only=True)

    class Meta:
        model = WorkspaceMember
        fields = ["id", "user", "role", "created_at"]
        read_only_fields = ["id", "created_at"]


class InviteSerializer(serializers.ModelSerializer):
    created_by_email = serializers.EmailField(source="created_by.email", read_only=True)

    class Meta:
        model = Invite
        fields = ["id", "email", "role", "expires_at", "accepted_at", "created_by_email", "created_at"]
        read_only_fields = ["id", "expires_at", "accepted_at", "created_at"]


class AuditLogSerializer(serializers.ModelSerializer):
    actor_email = serializers.EmailField(source="actor.email", read_only=True)

    class Meta:
        model = AuditLog
        fields = ["id", "actor_email", "action", "target", "ip_address", "metadata", "created_at"]
        read_only_fields = ["id", "created_at"]
