#!/usr/bin/env bash
set -e

PORT=${PORT:-8080}
BACKEND_PORT=8001

echo "=========================================================="
echo " Starting 125 East Unified Platform (All-In-One)         "
echo " Backend (Django/Gunicorn):  http://127.0.0.1:${BACKEND_PORT}"
echo " Frontend (Next.js):         http://0.0.0.0:${PORT}       "
echo "=========================================================="

# 1. Apply database migrations
echo "[1/3] Running database migrations..."
python backend/manage.py migrate --noinput || echo "Migrations finished or skipped."

# 2. Start Django Gunicorn in background
echo "[2/3] Starting Django backend on port ${BACKEND_PORT}..."
export DJANGO_SETTINGS_MODULE=${DJANGO_SETTINGS_MODULE:-config.settings.prod}
gunicorn \
    --chdir backend \
    config.wsgi:application \
    --bind 127.0.0.1:${BACKEND_PORT} \
    --workers ${WEB_CONCURRENCY:-2} \
    --threads 4 \
    --timeout 60 \
    --access-logfile - \
    --error-logfile - &
BACKEND_PID=$!

# Wait briefly for backend to initialize
sleep 2

# 3. Start Next.js frontend on public PORT
echo "[3/3] Starting Next.js frontend on port ${PORT}..."
export BACKEND_URL="http://127.0.0.1:${BACKEND_PORT}"
export PORT=${PORT}
export HOSTNAME="0.0.0.0"

if [ -f "frontend/server.js" ]; then
    node frontend/server.js &
elif [ -d "frontend/.next/standalone" ]; then
    node frontend/.next/standalone/frontend/server.js &
else
    npm --prefix frontend run start -- -p ${PORT} -H 0.0.0.0 &
fi
FRONTEND_PID=$!

# Trap signals for graceful shutdown
trap "kill -TERM $BACKEND_PID $FRONTEND_PID" SIGINT SIGTERM

wait -n $BACKEND_PID $FRONTEND_PID
