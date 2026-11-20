from .base import *  # noqa: F401,F403

DEBUG = True

# Throwaway key for local development only. Production (prod.py) refuses to boot without a real one.
if not SECRET_KEY:  # noqa: F405
    SECRET_KEY = "dev-only-insecure-key-do-not-use-outside-local-development-0123456789"

ALLOWED_HOSTS = env.list("ALLOWED_HOSTS", default=["localhost", "127.0.0.1", "testserver", ".trycloudflare.com", "*"])  # noqa: F405

# Only the local Next.js frontend and deployed Vercel dashboard, never "allow all".
CORS_ALLOWED_ORIGINS = env.list(  # noqa: F405
    "CORS_ALLOWED_ORIGINS",
    default=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:3100",
        "http://127.0.0.1:3100",
        "https://125east-dashboard.vercel.app",
    ],
)
CORS_ALLOW_CREDENTIALS = True
CSRF_TRUSTED_ORIGINS = list(CORS_ALLOWED_ORIGINS) + ["https://*.trycloudflare.com"]
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

# Generous throttle rates in local development so local testing is never delayed
# Copy, don't mutate: base.REST_FRAMEWORK is the same dict object, and mutating it would silently
# replace the shipped production rates for anything that reads config.settings.base.
REST_FRAMEWORK = {  # noqa: F405
    **REST_FRAMEWORK,  # noqa: F405
    "DEFAULT_THROTTLE_RATES": {"auth": "1000/min", "sync": "1000/min", "ndr": "1000/min"},
}
