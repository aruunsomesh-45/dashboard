import pytest
from apps.accounts.models import User
from apps.tenancy.models import AuditLog, WorkspaceMember
from rest_framework import status


@pytest.mark.django_db
class TestInvitesAndRBAC:
    def test_owner_can_invite_member(self, api_client, user_a, workspace_a):
        api_client.force_authenticate(user=user_a)

        invite_res = api_client.post(
            f"/api/w/{workspace_a.slug}/invites/", {"email": "newteammate@125east.com", "role": "analyst"}
        )
        assert invite_res.status_code == status.HTTP_201_CREATED
        invite_data = invite_res.json()
        assert "invite_token" in invite_data
        assert invite_data["invite"]["email"] == "newteammate@125east.com"
        assert invite_data["invite"]["role"] == "analyst"

        # Verify Audit Log recorded the invite
        assert AuditLog.objects.filter(workspace=workspace_a, action="invite_created").exists()

    def test_viewer_cannot_send_invites(self, api_client, workspace_a):
        # Create a viewer in workspace A
        viewer_user = User.objects.create_user(email="viewer@125east.com", password="SecurePassword123!")
        WorkspaceMember.objects.create(workspace=workspace_a, user=viewer_user, role=WorkspaceMember.Role.VIEWER)

        api_client.force_authenticate(user=viewer_user)
        res = api_client.post(f"/api/w/{workspace_a.slug}/invites/", {"email": "another@test.com", "role": "viewer"})
        assert res.status_code == status.HTTP_403_FORBIDDEN

    def test_invite_acceptance_flow(self, api_client, user_a, workspace_a):
        # 1. Owner creates invite
        api_client.force_authenticate(user=user_a)
        invite_res = api_client.post(
            f"/api/w/{workspace_a.slug}/invites/", {"email": "inviteduser@gmail.com", "role": "admin"}
        )
        token = invite_res.json()["invite_token"]

        # 2. New user signs up and accepts the invite
        new_user = User.objects.create_user(email="inviteduser@gmail.com", password="SecurePassword999!")
        api_client.force_authenticate(user=new_user)

        accept_res = api_client.post("/api/w/invites/accept/", {"token": token})
        assert accept_res.status_code == status.HTTP_200_OK

        # 3. New user is now an Admin in Workspace A
        membership = WorkspaceMember.objects.get(workspace=workspace_a, user=new_user)
        assert membership.role == WorkspaceMember.Role.ADMIN

        # 4. New user can now access Workspace A
        access_res = api_client.get(f"/api/w/{workspace_a.slug}/")
        assert access_res.status_code == status.HTTP_200_OK
        assert access_res.json()["role"] == "admin"
