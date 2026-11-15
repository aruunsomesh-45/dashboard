"""TC002: /api/w/ lists exactly the caller's active workspaces (with brands), never anyone else's."""
import uuid

from apps.accounts.models import User
from apps.tenancy.models import Brand, Workspace, WorkspaceMember


def test_lists_own_active_workspaces_only(api, ws, tc_user):
    # Another tenant exists in the same DB; it must never show up for tc_user.
    other_user = User.objects.create(email=f"other-{uuid.uuid4().hex[:6]}@tc.test")
    other_ws = Workspace.objects.create(name="other tenant", slug=f"tc-other-{uuid.uuid4().hex[:8]}")
    WorkspaceMember.objects.create(workspace=other_ws, user=other_user, role="owner")
    Brand.objects.create(workspace=other_ws, name="other brand")
    inactive = Workspace.objects.create(name="inactive", slug=f"tc-inactive-{uuid.uuid4().hex[:8]}", is_active=False)
    WorkspaceMember.objects.create(workspace=inactive, user=tc_user, role="owner")
    try:
        r = api.get("/api/w/")
        assert r.status_code == 200, r.text
        slugs = {w["slug"] for w in r.json()}
        assert ws.slug in slugs
        assert other_ws.slug not in slugs, "leaked another tenant's workspace"
        assert inactive.slug not in slugs, "inactive workspace listed"
        mine = next(w for w in r.json() if w["slug"] == ws.slug)
        assert mine["role"] == "owner" and mine["brands"][0]["id"] == ws.brand_id
    finally:
        other_ws.delete()
        inactive.delete()
        other_user.delete()
