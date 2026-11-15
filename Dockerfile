# =============================================================================
# Stage 1: Build Next.js Frontend
# =============================================================================
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
RUN npm run build

# =============================================================================
# Stage 2: Build Python Backend & Unified Runtime
# =============================================================================
FROM python:3.12-slim AS runner

# Install Node.js runtime, curl, and system build essentials
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    libpq-dev \
    gcc \
    bash \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python requirements
COPY backend/requirements.txt ./backend/
RUN pip install --no-cache-dir -r backend/requirements.txt gunicorn

# Copy backend code
COPY backend/ ./backend/
COPY pyproject.toml README.md ./

# Copy frontend code and built production assets from Stage 1
COPY --from=frontend-builder /app/frontend /app/frontend

# Copy start scripts
COPY scripts/start-all-in-one.sh /app/scripts/start-all-in-one.sh
RUN chmod +x /app/scripts/start-all-in-one.sh

# Environment variables
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    DJANGO_SETTINGS_MODULE=config.settings.prod \
    NODE_ENV=production \
    PORT=8080

EXPOSE 8080

CMD ["/app/scripts/start-all-in-one.sh"]
