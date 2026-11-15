"""Local prod-settings probe: 500 handling, security headers, cookies, CORS, exposed routes."""
import django, json, sys
django.setup()
from django.conf import settings
from django.test import Client
from django.urls import path
from unittest import mock

H = dict(HTTP_HOST="api.example.test", HTTP_X_FORWARDED_PROTO="https")
c = Client(raise_request_exception=False)

print("settings:", dict(DEBUG=settings.DEBUG, hashers0=settings.PASSWORD_HASHERS[0].rsplit(".",1)[-1],
      SESSION_ENGINE=settings.SESSION_ENGINE, cache=settings.CACHES["default"]["BACKEND"].rsplit(".",1)[-1],
      SESSION_COOKIE_DOMAIN=getattr(settings,"SESSION_COOKIE_DOMAIN",None), CSRF_COOKIE_DOMAIN=getattr(settings,"CSRF_COOKIE_DOMAIN",None),
      throttle=settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"], num_proxies=settings.REST_FRAMEWORK.get("NUM_PROXIES"),
      DATA_UPLOAD_MAX=settings.DATA_UPLOAD_MAX_MEMORY_SIZE))

# 1.1 forced 500: make a real view raise
with mock.patch("apps.tenancy.views.WorkspaceListCreateView.get", side_effect=RuntimeError("probe-secret-detail-XYZ")), \
     mock.patch("rest_framework.views.APIView.permission_classes", []), \
     mock.patch("apps.tenancy.views.WorkspaceListCreateView.permission_classes", []):
    r = c.get("/api/w/", **H)
body = r.content.decode(errors="replace")
print("500 probe:", r.status_code, "len", len(body), "| leaks exception text:", "probe-secret-detail-XYZ" in body,
      "| traceback:", "Traceback" in body, "| body:", body[:120].replace("\n", " "))

# 3.1 http -> https
r = c.get("/api/auth/csrf/", HTTP_HOST="api.example.test")
print("plain http:", r.status_code, r.headers.get("Location"))

# 3.2 headers on API
r = c.get("/api/auth/csrf/", **H)
want = ["Strict-Transport-Security", "X-Content-Type-Options", "X-Frame-Options", "Content-Security-Policy",
        "Referrer-Policy", "Cache-Control", "Cross-Origin-Opener-Policy"]
print("api headers:", r.status_code, json.dumps({k: r.headers.get(k) for k in want}))
for name, m in r.cookies.items():
    print("cookie", name, {k: m[k] for k in ("secure", "httponly", "samesite", "domain", "path")})

# 3.4 CORS
for origin in ("https://evil.com", "https://app.example.test"):
    r = c.get("/api/auth/csrf/", HTTP_ORIGIN=origin, **H)
    print("CORS", origin, "->", r.headers.get("Access-Control-Allow-Origin"), r.headers.get("Access-Control-Allow-Credentials"))
r = c.options("/api/auth/login/", HTTP_ORIGIN="https://evil.com", HTTP_ACCESS_CONTROL_REQUEST_METHOD="POST", **H)
print("CORS preflight evil ->", r.status_code, r.headers.get("Access-Control-Allow-Origin"))

# 3.5 exposed routes
for p in ("/api/schema/", "/api/docs/", "/admin/", "/admin/login/", "/", "/api/health/", "/api/health", "/healthz", "/api/does-not-exist/"):
    r = c.get(p, **H)
    print("route", p, "->", r.status_code, r.headers.get("Location", ""))

# bad host
r = c.get("/api/auth/csrf/", HTTP_HOST="evil.test", HTTP_X_FORWARDED_PROTO="https")
print("bad Host ->", r.status_code)

# dev token bypass under prod
r = c.get("/api/w/", HTTP_AUTHORIZATION="Bearer dev-mock-token", **H)
print("dev-mock-token under prod ->", r.status_code)
