# 125East Inventory & Multi-Location Stock Module (Scale Module)

## Overview
This directory contains the Inventory Management interface.

## Features
- Multi-location stock monitoring.
- Safety stock thresholds and replenishment warnings.
- SKU catalog health and out-of-stock indicators.
- Backorder management tracking.

## Re-integration Instructions
1. Copy `app/inventory/` to `frontend/src/app/inventory/`.
2. Add navigation item `{ name: "Inventory", href: "/inventory", icon: Boxes }` back into `frontend/src/components/layout/DashboardShell.tsx`.
