# Scale Modules — 125East Future Architecture

This directory houses non-production / enterprise scale modules that are isolated from the lightweight production Serverless Dashboard deployment.

## Isolated Modules:
1. `admin-dashboard/` — Platform Multi-Tenant Super Admin Control Plane (12 routes, audit trails, user & workspace management, permission matrix).
2. `influencer-management/` — Creator performance hub, UTM campaign attribution, and affiliate coupon tracking.
3. `inventory-management/` — Multi-location stock monitoring, SKU alerts, and replenishment warnings.

## Deployment Policy:
- These modules are **STRICTLY EXCLUDED** from the initial serverless deployment to Vercel.
- Do NOT import from `scale/` within `frontend/src/` or `serverless/`.
- To re-enable any of these modules in a future enterprise release, see each module's internal `README.md` for integration steps.
