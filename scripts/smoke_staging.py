#!/usr/bin/env python3
"""
Staging smoke test. Read-only except for one unsigned-webhook probe that MUST be rejected.
Never calls third-party APIs. Exit code 0 = all checks passed.

  API_URL=https://api-staging.125east.in WEB_URL=https://staging.125east.in \
  SMOKE_JWT=<access token of a staging test user> SMOKE_FOREIGN_SLUG=<slug of a workspace that user is NOT in> \
  python scripts/smoke_staging.py

  Local run (plain http):  python scripts/smoke_staging.py --allow-http
Optional: SMOKE_WORKSPACE_SLUG + SMOKE_BRAND_ID (a brand the token's user belongs to) enable brand endpoint checks;
          SMOKE_RAZORPAY_BRAND_ID enables the unsigned-webhook probe against a brand with Razorpay connected.
"""
import os
import sys
import uuid

import requests

API = os.environ.get("API_URL", "").rstrip("/")
WEB = os.environ.get("WEB_URL", "").rstrip("/")
JWT = os.environ.get("SMOKE_JWT", "")
ALLOW_HTTP = "--allow-http" in sys.argv

results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' - ' + detail) if detail else ''}")


def get(path, token=None, **kw):
    h = {"Authorization": f"Bearer {token}"} if token else {}
    return requests.get(API + path, headers=h, timeout=20, allow_redirects=False, **kw)


def main():
    if not API:
        sys.exit("API_URL is required")
    if not ALLOW_HTTP and not API.startswith("https://"):
        sys.exit("API_URL must be https:// (use --allow-http for local runs)")

    # --- transport security -------------------------------------------------
    if API.startswith("https://"):
        r = requests.get(API.replace("https://", "http://", 1) + "/", timeout=20, allow_redirects=False)
        check("http -> https redirect", r.status_code in (301, 302, 308) and r.headers.get("Location", "").startswith("https://"),
              f"{r.status_code} {r.headers.get('Location', '')}")
        r = get("/")
        check("HSTS header present", "max-age=" in r.headers.get("Strict-Transport-Security", ""),
              r.headers.get("Strict-Transport-Security", "missing"))
        check("nosniff header", r.headers.get("X-Content-Type-Options") == "nosniff")

    # --- liveness -------------------------------------------------------------
    r = requests.get(API + "/", timeout=20, headers={"Accept": "application/json"})
    check("API root healthy", r.status_code == 200 and r.json().get("status") == "healthy", str(r.status_code))
    check("DEBUG is off (404 page has no stack/settings dump)", "You're seeing this error because you have" not in
          requests.get(API + f"/{uuid.uuid4()}", timeout=20).text)

    # --- auth: nothing is returned without a valid token ------------------------
    for label, tok in [("no token", None), ("malformed token", "not.a.jwt"), ("dev bypass token", "dev-mock-token")]:
        r = get("/api/w/", tok)
        check(f"/api/w/ rejects {label}", r.status_code in (401, 403) and "slug" not in r.text, str(r.status_code))
    r = get("/api/auth/me", "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiIxIn0.")
    check("alg=none token rejected", r.status_code == 401, str(r.status_code))

    # --- authenticated + tenant isolation ----------------------------------------
    if JWT:
        r = get("/api/w/", JWT)
        check("valid token lists own workspaces", r.status_code == 200 and isinstance(r.json(), list), str(r.status_code))
        foreign = os.environ.get("SMOKE_FOREIGN_SLUG")
        if foreign:
            r = get(f"/api/w/{foreign}/", JWT)
            check("foreign workspace is 404", r.status_code in (403, 404), str(r.status_code))
        slug, brand = os.environ.get("SMOKE_WORKSPACE_SLUG"), os.environ.get("SMOKE_BRAND_ID")
        if slug and brand:
            for tail in ("shopify/stats/", "payments/stats/", "logistics/summary/", "metrics/"):
                r = get(f"/api/w/{slug}/b/{brand}/{tail}", JWT)
                check(f"GET {tail}", r.status_code == 200, f"{r.status_code} {r.elapsed.total_seconds() * 1000:.0f}ms")
            if foreign:
                r = get(f"/api/w/{foreign}/b/{brand}/shopify/stats/", JWT)
                check("own brand id under foreign slug is 404", r.status_code in (403, 404), str(r.status_code))
    else:
        print("[SKIP] authenticated checks (set SMOKE_JWT)")

    # --- webhooks must reject unsigned payloads -----------------------------------
    rz = os.environ.get("SMOKE_RAZORPAY_BRAND_ID")
    if rz:
        r = requests.post(f"{API}/api/webhooks/razorpay/{rz}/", data=b'{"event":"payment.captured"}',
                          headers={"Content-Type": "application/json"}, timeout=20)
        check("unsigned Razorpay webhook -> 401", r.status_code == 401, str(r.status_code))
        r = requests.post(f"{API}/api/webhooks/razorpay/{rz}/", data=b'{"event":"payment.captured"}',
                          headers={"Content-Type": "application/json", "X-Razorpay-Signature": "0" * 64}, timeout=20)
        check("tampered Razorpay webhook -> 401", r.status_code == 401, str(r.status_code))

    # --- frontend --------------------------------------------------------------------
    if WEB:
        r = requests.get(WEB + "/login", timeout=30)
        check("frontend /login renders", r.status_code == 200 and "<html" in r.text.lower(), str(r.status_code))
        r = requests.get(WEB + "/api/w/", timeout=20)
        check("frontend proxy forwards /api and rejects anonymous", r.status_code in (401, 403), str(r.status_code))

    failed = results.count(False)
    print(f"\n{len(results) - failed}/{len(results)} checks passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
