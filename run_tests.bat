@echo off
title 125East - 5-App Integration & Webhook Verification
cls
echo =========================================================================
echo    125EAST: COMPLETE 5-APP API, DATA PULL AND WEBHOOK TEST RUNNER
echo =========================================================================
echo.
echo Running verification suite for:
echo   1. Shopify (Orders, Products, Pagination, Webhooks, HMAC)
echo   2. Razorpay (Payments, Captured Events, Hex Signatures, Refunds)
echo   3. Meta Ads (Graph API, Campaigns, Ad Spend Insights, Token Handling)
echo   4. Instagram (Media Posts, Followers, Social Metrics Sync)
echo   5. Security & Boundary Guard (Idempotency, Rejection of Tampered Signatures)
echo.
echo Please wait...
echo.

cd /d "%~dp0\serverless"
"%USERPROFILE%\.deno\bin\deno.exe" test -A tests/db/functions_sync.test.ts tests/db/webhooks.test.ts

echo.
echo =========================================================================
echo Test run complete!
echo =========================================================================
pause
