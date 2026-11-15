"""TC003: creating a workspace yields an isolated tenant owned by the creator; it is removable and leaves nothing behind."""
import uuid

from apps.tenancy.models import Brand, Workspace


def test_create_workspace_is_isolated_and_cleaned_up(api):
    name = f"tc3-{uuid.uuid4().hex[:8]}"
    assert api.post("/api/w/", json={"name": ""}).status_code == 400
    assert api.post("/api/w/", json={"name": 123}).status_code == 400

    r = api.post("/api/w/", json={"name": name})
    assert r.status_code == 201, r.text
    data = r.json()
    slug = data["slug"]
    try:
        assert data["role"] == "owner" and len(data["brands"]) == 1
        brand_id = data["brands"][0]["id"]
        assert api.get(f"/api/w/{slug}/").status_code == 200
        # brand belongs only to the new workspace
        assert Brand.objects.get(id=brand_id).workspace.slug == slug
        # same name twice => distinct slug, distinct tenant
        r2 = api.post("/api/w/", json={"name": name})
        assert r2.status_code == 201 and r2.json()["slug"] != slug
        api.delete(f"/api/w/{r2.json()['slug']}/")
    finally:
        assert api.delete(f"/api/w/{slug}/").status_code == 204
    assert api.get(f"/api/w/{slug}/").status_code == 404
    assert not Workspace.objects.filter(slug__startswith="tc3-").exists(), "test workspace left behind"
