"""Test settings: fast in-memory/isolated SQLite for unit tests, no external calls or cloud DB drops."""
from .dev import *  # noqa: F401,F403

DEMO_MODE = False

# Automated unit tests use isolated SQLite so cloud Supabase DB does not receive CREATE/DROP DATABASE commands
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": BASE_DIR / "test_db.sqlite3",
    }
}

# Throttle limits are asserted in dedicated tests; keep other tests unthrottled.
REST_FRAMEWORK = {**REST_FRAMEWORK, "DEFAULT_THROTTLE_RATES": {k: "100000/min" for k in REST_FRAMEWORK.get("DEFAULT_THROTTLE_RATES", {})}}  # noqa: F405
EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
