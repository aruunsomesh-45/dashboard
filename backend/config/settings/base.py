from pathlib import Path

import environ

# Build paths inside the project like this: BASE_DIR / 'subdir'.
BASE_DIR = Path(__file__).resolve().parent.parent.parent

env = environ.Env(
    DEBUG=(bool, False),
    ALLOWED_HOSTS=(list, ["localhost", "127.0.0.1"]),
)

# Read .env file if it exists
environ.Env.read_env(BASE_DIR / ".env")

# SECRET_KEY has no default: dev.py supplies a clearly-labelled throwaway key,
# prod.py refuses to start without one.
SECRET_KEY = env("SECRET_KEY", default="")
DEBUG = env("DEBUG")
ALLOWED_HOSTS = env("ALLOWED_HOSTS")

# Demo/seed/fallback data is OFF unless explicitly enabled. Never enable in production.
DEMO_MODE = env.bool("DEMO_MODE", default=False)

# Key used to encrypt stored integration credentials (Shopify/Meta/Razorpay/Delhivery tokens).
# Independent of SECRET_KEY so SECRET_KEY can be rotated without orphaning credentials.
INTEGRATION_ENCRYPTION_KEY = env("INTEGRATION_ENCRYPTION_KEY", default="")

# Application definition
DJANGO_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
]

THIRD_PARTY_APPS = [
    "rest_framework",
    "corsheaders",
    "drf_spectacular",
]

LOCAL_APPS = [
    "apps.accounts",
    "apps.tenancy",
    "apps.integrations",
    "apps.commerce",
    "apps.analytics",
    "apps.alerts",
    "apps.billing",
]

INSTALLED_APPS = DJANGO_APPS + THIRD_PARTY_APPS + LOCAL_APPS

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",  # serves collected static (admin) under gunicorn
    "corsheaders.middleware.CorsMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "apps.tenancy.middleware.TenancyMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

# Database configuration: DATABASE_URL drives everything (postgres:// in all real envs).
# SQLite is only used when DATABASE_URL is empty/sqlite (legacy local dev).
DATABASE_URL = env("DATABASE_URL", default="")
if not DATABASE_URL or DATABASE_URL.startswith("sqlite"):
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": BASE_DIR / "db.sqlite3",
        }
    }
else:
    DATABASES = {"default": env.db("DATABASE_URL")}
    DATABASES["default"]["CONN_MAX_AGE"] = env.int("DB_CONN_MAX_AGE", default=60)
    # DB_SSLMODE=require for managed Postgres (Supabase/RDS); leave unset for local Docker.
    _sslmode = env("DB_SSLMODE", default="")
    if _sslmode:
        DATABASES["default"].setdefault("OPTIONS", {})["sslmode"] = _sslmode
    if env.bool("DB_POOLER_TRANSACTION_MODE", default=False):
        # Supavisor / pgbouncer transaction pooling
        DATABASES["default"]["DISABLE_SERVER_SIDE_CURSORS"] = True
        DATABASES["default"]["CONN_MAX_AGE"] = 0

# Custom User Model
AUTH_USER_MODEL = "accounts.User"

# Password Hashing with Argon2
PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.Argon2PasswordHasher",
    "django.contrib.auth.hashers.PBKDF2PasswordHasher",
    "django.contrib.auth.hashers.PBKDF2SHA1PasswordHasher",
    "django.contrib.auth.hashers.BCryptSHA256PasswordHasher",
]

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {
        "NAME": "django.contrib.auth.password_validation.MinimumLengthValidator",
        "OPTIONS": {"min_length": 10},
    },
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

# Internationalization
LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

# Static files (CSS, JavaScript, Images)
STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"

# Default primary key field type
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# REST Framework Configuration
REST_FRAMEWORK = {
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "apps.accounts.firebase_auth.FirebaseAuthentication",
        "rest_framework.authentication.SessionAuthentication",
        "apps.accounts.authentication.SupabaseJWTAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
    # Rate limiting. Views opt in with `throttle_scope = "<scope>"` (ScopedRateThrottle).
    # Counters live in the Django cache (LocMemCache).
    "DEFAULT_THROTTLE_CLASSES": ["rest_framework.throttling.ScopedRateThrottle"],
    "DEFAULT_THROTTLE_RATES": {
        "auth": env("THROTTLE_AUTH", default="10/min"),
        "sync": env("THROTTLE_SYNC", default="6/min"),
        "ndr": env("THROTTLE_NDR", default="20/min"),
    },
}

# DRF Spectacular Settings (OpenAPI 3.0 generation for AI frontend)
SPECTACULAR_SETTINGS = {
    "TITLE": "125 East Commerce Intelligence API",
    "DESCRIPTION": "Multi-tenant Commerce Analytics & Operations Engine",
    "VERSION": "1.0.0",
    "SERVE_INCLUDE_SCHEMA": False,
}

# Security and routing
APPEND_SLASH = False
SECURE_CROSS_ORIGIN_OPENER_POLICY = "same-origin-allow-popups"

# Cache & Session Configuration (In-memory LocMemCache & DB sessions; no Redis required)
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "125east-cache",
    }
}
SESSION_ENGINE = "django.contrib.sessions.backends.db"

# Celery Configuration (runs tasks synchronously in-process without an external broker)
CELERY_TASK_ALWAYS_EAGER = True
CELERY_TASK_EAGER_PROPAGATES = True
CELERY_BROKER_URL = "memory://"
CELERY_RESULT_BACKEND = "cache+memory://"
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
SESSION_COOKIE_AGE = 60 * 60 * 24 * 7  # 7 days max

# CSRF — allow JS to read the csrftoken cookie so apiFetch can include X-CSRFToken
CSRF_COOKIE_HTTPONLY = False
CSRF_COOKIE_SAMESITE = "Lax"

# Supabase auth (all from env; nothing hard-coded). Set SUPABASE_JWT_SECRET for offline HS256 verification.
SUPABASE_TENANT_SYNC = env.bool("SUPABASE_TENANT_SYNC", default=True)


# ---------------------------------------------------------------------------
# Structured logging (JSON to stdout; ship with the container log driver)
# ---------------------------------------------------------------------------
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "json": {
            "()": "pythonjsonlogger.json.JsonFormatter",
            "format": "%(asctime)s %(levelname)s %(name)s %(message)s",
        },
        "plain": {"format": "%(asctime)s %(levelname)s %(name)s %(message)s"},
    },
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
            "formatter": "plain" if env.bool("LOG_PLAIN", default=False) else "json",
        },
    },
    "root": {"handlers": ["console"], "level": env("LOG_LEVEL", default="INFO")},
}

# ---------------------------------------------------------------------------
# Error tracking (no-op unless SENTRY_DSN is set)
# ---------------------------------------------------------------------------
SENTRY_DSN = env("SENTRY_DSN", default="")
if SENTRY_DSN:
    import sentry_sdk

    sentry_sdk.init(
        dsn=SENTRY_DSN,
        environment=env("SENTRY_ENVIRONMENT", default="production"),
        traces_sample_rate=env.float("SENTRY_TRACES_SAMPLE_RATE", default=0.0),
        send_default_pii=False,  # never ship emails/tokens/credentials to the error tracker
    )
