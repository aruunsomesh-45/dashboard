"""TC001: /api/auth/me returns the caller's identity + workspaces, and NOTHING for bad credentials."""
import jwt  # noqa: F401
import pytest
import requests

from conftest import BASE_URL, make_jwt


def test_me_returns_user_and_own_workspaces(api, ws, tc_user):
    r = api.get("/api/auth/me")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["user"]["email"] == tc_user.email
    mine = [w for w in body["workspaces"] if w["slug"] == ws.slug]
    assert len(mine) == 1 and mine[0]["role"] == "owner"
    assert [b["id"] for b in mine[0]["brands"]] == [ws.brand_id]


@pytest.mark.parametrize(
    "label,token",
    [("none", None), ("garbage", "invalid"), ("dev bypass", "dev-mock-token"), ("expired", "EXPIRED"), ("wrong secret", "WRONG")],
)
def test_me_rejects_bad_credentials_with_no_data(tc_user, label, token):
    if token == "EXPIRED":
        token = make_jwt(tc_user, exp_delta=-60)
    elif token == "WRONG":
        token = make_jwt(tc_user, secret="another-secret-0123456789-abcdefghijklmnopqrstuv")
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    r = requests.get(f"{BASE_URL}/api/auth/me", headers=headers, timeout=30)
    assert r.status_code in (401, 403), f"{label}: {r.status_code} {r.text}"
    assert tc_user.email not in r.text and "workspaces" not in r.text
