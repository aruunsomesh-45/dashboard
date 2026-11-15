"""Test settings: DATABASE_URL driven (Postgres in CI/local), no external calls."""
from .dev import *  # noqa: F401,F403

DEMO_MODE = False
# Throttle limits are asserted in dedicated tests; keep other tests unthrottled.
REST_FRAMEWORK = {**REST_FRAMEWORK, "DEFAULT_THROTTLE_RATES": {k: "100000/min" for k in REST_FRAMEWORK.get("DEFAULT_THROTTLE_RATES", {})}}  # noqa: F405
SUPABASE_TENANT_SYNC = False
