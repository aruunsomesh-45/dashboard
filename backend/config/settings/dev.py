from .base import *  # noqa: F401,F403

DEBUG = True

# Throwaway key for local development only. Production (prod.py) refuses to boot without a real one.
if not SECRET_KEY:  # noqa: F405
    SECRET_KEY = "dev-only-insecure-key-do-not-use-outside-local-development-0123456789"

ALLOWED_HOSTS = env.list("ALLOWED_HOSTS", default=["localhost", "127.0.0.1", "testserver"])  # noqa: F405

# Only the local Next.js frontend, never "allow all".
CORS_ALLOWED_ORIGINS = env.list(  # noqa: F405
    "CORS_ALLOWED_ORIGINS",
    default=["http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:3100", "http://127.0.0.1:3100"],
)
CORS_ALLOW_CREDENTIALS = True
CSRF_TRUSTED_ORIGINS = list(CORS_ALLOWED_ORIGINS)

# Generous throttle rates in local development so local testing is never delayed
REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"] = {  # noqa: F405
    "auth": "1000/min",
    "sync": "1000/min",
    "ndr": "1000/min",
}
