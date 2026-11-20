# 125 East — Cloudflare & All-in-One Deployment Architecture Report

## 1. Executive Summary & Compatibility Matrix

| Component | Cloudflare Native (Pages/Workers) | Unified Container (Docker / Cloudflare Tunnel) | Recommended Architecture |
| :--- | :--- | :--- | :--- |
| **Frontend (Next.js 14)** | **Fully Supported** (Cloudflare Pages / OpenNext) | **Fully Supported** (Node.js in Docker) | Cloudflare Pages or Unified Container |
| **Backend (Django 5)** | **Not Supported on Workers** (Pyodide lacks raw TCP for PostgreSQL ORM & C-extensions) | **Fully Supported** (Python 3.12 + Gunicorn) | Unified Container or Dedicated Container behind Cloudflare |
| **Database (PostgreSQL)** | External (Supabase / Neon / Hyperdrive) | External (Supabase DB with SSL) | Supabase PostgreSQL |
| **Reverse Proxy / Routing** | Cloudflare Pages `_redirects` / Rewrites | Next.js internal `/api/*` rewrites to Gunicorn | Next.js internal rewrites |
| **Edge Security & CDN** | Cloudflare DDoS, WAF, SSL, Edge Cache | Cloudflare Tunnel (`cloudflared`) | Cloudflare Edge Network |

---

## 2. Deployment Architecture Options

### Option A: Unified "All-in-One" Container (Recommended for Single-Host Deployments)
In this setup, a single container runs both **Next.js** and **Django (Gunicorn)**.
Next.js listens on the public `PORT` (e.g. `8080`) and automatically reverse-proxies `/api/*` requests to the internal Django server on `http://127.0.0.1:8001`.
You connect this container to **Cloudflare Tunnel (`cloudflared`)**, exposing your app globally on your Cloudflare domain with zero open firewall ports.

```
 [ Browser / Client ]
          │
          ▼ HTTPS
 [ Cloudflare Edge Network ] (WAF, DDoS Protection, SSL)
          │
          ▼ Cloudflare Tunnel
 [ Unified Container (Port 8080) ]
    ├─ Next.js (Serves React UI & static assets)
    │     └─ Rewrites `/api/*` ──► http://127.0.0.1:8001
    └─ Django Gunicorn (Port 8001)
          └─ Connects via SSL ──► [ Supabase PostgreSQL ]
```

### Option B: Cloudflare Pages (Frontend) + Container Backend (Decoupled)
- **Frontend:** Deployed to Cloudflare Pages directly from GitHub.
- **Backend:** Deployed via `Dockerfile` to any container host (Railway, Render, Fly.io, or VPS).
- **Domain:** Both hosted under Cloudflare DNS (`app.yourdomain.com` and `api.yourdomain.com`).

---

## 3. Cloudflare Pages Configuration (Frontend)

If connecting this repository to **Cloudflare Pages**:

| Setting | Value | Notes |
| :--- | :--- | :--- |
| **Framework Preset** | `Next.js` | Cloudflare Pages autodetects Next.js |
| **Build System Version** | `2` (recommended) | Modern Node.js build image |
| **Root Directory** | `frontend` | Prevents Cloudflare from attempting `pip install .` |
| **Build Command** | `npm run build` | Compiles Next.js 14 production bundle |
| **Build Output Directory** | `.next` | Or `out` if using static export |
| **Node.js Version** | `20.x` | Set `NODE_VERSION=20` in Environment Variables |

---

## 4. Environment Variables Checklist

### Frontend Environment Variables (Cloudflare Pages or Next.js)
| Variable | Required | Example / Default | Description |
| :--- | :---: | :--- | :--- |
| `BACKEND_URL` | **Yes** | `http://127.0.0.1:8001` (Unified) or `https://api.domain.com` | Destination URL for `/api/*` rewrites |
| `SESSION_COOKIE_NAME` | Optional | `sessionid` | Must match Django's session cookie name (used by the route-guard middleware) |

### Backend Environment Variables (Django / Container)
| Variable | Required | Example / Default | Description |
| :--- | :---: | :--- | :--- |
| `DJANGO_SETTINGS_MODULE` | **Yes** | `config.settings.prod` | Django settings module |
| `SECRET_KEY` | **Yes** | `>= 50 random characters` | Cryptographic secret for Django |
| `INTEGRATION_ENCRYPTION_KEY` | **Yes** | `>= 32 random characters` | AES key for encrypting merchant tokens |
| `DATABASE_URL` | **Yes** | `postgres://user:pass@host:5432/postgres` | Supabase PostgreSQL connection string |
| `DB_SSLMODE` | **Yes** | `require` | Enforces SSL encryption to database |
| `ALLOWED_HOSTS` | **Yes** | `localhost,127.0.0.1,yourdomain.com` | Hostname header validation |
| `CORS_ALLOWED_ORIGINS` | **Yes** | `https://yourdomain.com` | Allowed frontend origins for CORS |
| `CSRF_TRUSTED_ORIGINS` | **Yes** | `https://yourdomain.com` | Trusted origins for CSRF POST validation |
| `SECURE_SSL_REDIRECT` | Optional | `false` (in unified) or `true` | Set `false` when internal proxy terminates SSL |
| `SESSION_COOKIE_AGE` | Optional | `604800` | Session lifetime in seconds (absolute; default 7 days) |
| `FRONTEND_URL` | **Yes** | `https://yourdomain.com` | Base URL used in password-reset emails |
| `EMAIL_BACKEND` | **Yes** | `django.core.mail.backends.smtp.EmailBackend` | Defaults to console (prints emails to logs) |
| `EMAIL_HOST` / `EMAIL_PORT` / `EMAIL_HOST_USER` / `EMAIL_HOST_PASSWORD` | **Yes** (SMTP) | `smtp.example.com` / `587` | SMTP credentials for password-reset emails |
| `DEFAULT_FROM_EMAIL` | **Yes** | `no-reply@yourdomain.com` | Sender address for password-reset emails |

> Authentication is email/password with server-side Django sessions (HTTP-only `sessionid` cookie).
> The frontend must reach the API on the **same origin** (the Next.js `/api/*` rewrite) so the cookie is sent.

---

## 5. Step-by-Step Instructions to Deploy

### Option 1: Deploying with Docker (All-in-One Container)
```bash
# 1. Build the unified Docker image
docker build -t 125east-platform:latest .

# 2. Run the all-in-one container
docker run -d \
  -p 8080:8080 \
  --env-file backend/.env \
  -e PORT=8080 \
  -e DJANGO_SETTINGS_MODULE=config.settings.prod \
  -e SECURE_SSL_REDIRECT=false \
  --name 125east-app \
  125east-platform:latest

# 3. Connect to Cloudflare Tunnel
cloudflared tunnel --url http://localhost:8080
```

### Option 2: Deploying Frontend to Cloudflare Pages
1. Go to the **Cloudflare Dashboard** > **Workers & Pages** > **Create application** > **Pages** > **Connect to Git**.
2. Select repository: `aruunsomesh-45/dashboard`.
3. Configure build settings:
   - **Root directory:** `frontend`
   - **Framework preset:** `Next.js`
   - **Build command:** `npm run build`
   - **Build output directory:** `.next`
4. Add the frontend environment variables listed above.
5. Click **Save and Deploy**.
