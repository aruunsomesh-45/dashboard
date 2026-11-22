import pytest
from rest_framework import status


@pytest.mark.django_db
class TestTenantIsolation:
    def test_unauthenticated_request_does_not_leak_tenant_existence(self, api_client, workspace_a):
        """Without a session every tenant URL answers the same 401 (real or made-up slug), so the response
        reveals nothing about which workspaces exist, while still telling the UI the session is gone."""
        real = api_client.get(f"/api/w/{workspace_a.slug}/")
        fake = api_client.get("/api/w/does-not-exist/")
        assert real.status_code == fake.status_code == status.HTTP_401_UNAUTHORIZED
        assert real.content == fake.content

    def test_user_a_gets_404_on_workspace_b_endpoints(self, api_client, user_a, workspace_b, brand_b):
        """User A must receive 404 for any resource belonging to Workspace B."""
        api_client.force_authenticate(user=user_a)

        # Workspace details
        res_ws = api_client.get(f"/api/w/{workspace_b.slug}/")
        assert res_ws.status_code == status.HTTP_404_NOT_FOUND

        # Brands list
        res_brands = api_client.get(f"/api/w/{workspace_b.slug}/brands/")
        assert res_brands.status_code == status.HTTP_404_NOT_FOUND

        # Members list
        res_members = api_client.get(f"/api/w/{workspace_b.slug}/members/")
        assert res_members.status_code == status.HTTP_404_NOT_FOUND

        # Invites endpoint
        res_invites = api_client.post(f"/api/w/{workspace_b.slug}/invites/", {"email": "intruder@evil.com"})
        assert res_invites.status_code == status.HTTP_404_NOT_FOUND

    def test_user_a_can_access_own_workspace(self, api_client, user_a, workspace_a, brand_a):
        """User A can access their own workspace successfully."""
        api_client.force_authenticate(user=user_a)

        response = api_client.get(f"/api/w/{workspace_a.slug}/")
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["workspace"]["slug"] == workspace_a.slug
        assert data["role"] == "owner"
        assert len(data["brands"]) >= 1

    def test_create_workspace_assigns_creator_as_owner(self, api_client, user_a):
        """Creating a new workspace automatically assigns the creator as Owner."""
        api_client.force_authenticate(user=user_a)

        response = api_client.post("/api/w/", {"name": "New Enterprise Brand"})
        assert response.status_code == status.HTTP_201_CREATED
        new_slug = response.json()["slug"]

        # Creator can immediately access it
        detail_res = api_client.get(f"/api/w/{new_slug}/")
        assert detail_res.status_code == status.HTTP_200_OK
        assert detail_res.json()["role"] == "owner"
