from django.core.exceptions import ImproperlyConfigured

from .base import *  # noqa: F401,F403

DEBUG = False

if not SECRET_KEY or SECRET_KEY.startswith("django-insecure") or len(SECRET_KEY) < 50:  # noqa: F405
    raise ImproperlyConfigured("SECRET_KEY env var must be set to a random value of at least 50 chars.")
if len(INTEGRATION_ENCRYPTION_KEY) < 32:  # noqa: F405
    raise ImproperlyConfigured(
        "INTEGRATION_ENCRYPTION_KEY must be set (>=32 chars). To keep decrypting credentials stored before this "
        "setting existed, set it to the old SECRET_KEY value."
    )
if DEMO_MODE:  # noqa: F405
    raise ImproperlyConfigured("DEMO_MODE must never be enabled with production settings.")

ALLOWED_HOSTS = env.list("ALLOWED_HOSTS")  # noqa: F405  (required, no default)
if not ALLOWED_HOSTS or "*" in ALLOWED_HOSTS:
    raise ImproperlyConfigured("ALLOWED_HOSTS must list the real API hostnames (no wildcard).")

# CORS / CSRF restricted to the real frontend origin(s), e.g. https://app.125east.in
CORS_ALLOWED_ORIGINS = env.list("CORS_ALLOWED_ORIGINS")  # noqa: F405
CORS_ALLOW_CREDENTIALS = True
CSRF_TRUSTED_ORIGINS = env.list("CSRF_TRUSTED_ORIGINS", default=CORS_ALLOWED_ORIGINS)  # noqa: F405

# HTTPS everywhere. The proxy (nginx/ALB/Cloudflare) must set X-Forwarded-Proto.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_SSL_REDIRECT = env.bool("SECURE_SSL_REDIRECT", default=True)
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SECURE_HSTS_SECONDS = 31536000
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_HSTS_PRELOAD = True
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "same-origin"
X_FRAME_OPTIONS = "DENY"
