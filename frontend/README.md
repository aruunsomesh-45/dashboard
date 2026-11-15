# 125 East Commerce Intelligence - Web Frontend

This directory is reserved for the Next.js (App Router) frontend.

## Architecture
- **Framework:** Next.js (App Router) + TypeScript
- **Styling:** Tailwind CSS + Radix UI / Shadcn UI components
- **State & Data Fetching:** TanStack Query (React Query)
- **Charts:** Recharts
- **Drag-and-Drop:** dnd-kit

## API Integration
The frontend talks strictly to the Django API:
- Base API URL: `http://localhost:8000/api` (or `http://api.125east.local:8000/api`)
- Authentication: Session-based via `HttpOnly` cookies (`credentials: "include"`)
- Type Generation: TypeScript client generated from `http://localhost:8000/api/schema/` using `openapi-typescript`
