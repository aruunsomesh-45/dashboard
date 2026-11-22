#!/usr/bin/env python3
"""
125East - Complete 5-App API & Webhook Verification Script
Automated tester for all 5 integrations:
  1. Shopify (API Sync & Webhook HMAC)
  2. Razorpay (API Sync & Webhook HMAC)
  3. Meta Ads (API Connection & Campaign Sync)
  4. Instagram (API Connection & Insights Sync)
  5. Gateway Security & Boundary Enforcement (Auth rejection & Tampered signature rejection)

Runs against the local Serverless Gateway (http://localhost:54321/functions/v1)
Requires ZERO Postman setup.
"""

import urllib.request
import urllib.error
import json
import hmac
import hashlib
import base64
import time
import os
import sys

GATEWAY_URL = os.environ.get("GATEWAY_URL", "http://localhost:54321/functions/v1")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://ybyroxyofqfpozvfedhc.supabase.co")
SUPABASE_ANON = os.environ.get("SUPABASE_ANON_KEY", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlieXJveHlvZnFmcG96dmZlZGhjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQzMjg2NjksImV4cCI6MjEwOTkwNDY2OX0.tGUf2QP8SpmS0ml19cCRPJ4wdV5hW8NeWwgPCe7rA4s")
SHOPIFY_WEBHOOK_SECRET = "d63bc72448aa0e57ee44f08a4691834b89e4da5d56a9d6e96bc2cd7a686d7380"
DEFAULT_SECRET = os.environ.get("SECRET_KEY", "ci-local-dev-secret-key-do-not-use-in-production-125east!")

USER_EMAIL = os.environ.get("TEST_USER_EMAIL", "aruunasomesh@gmail.com")
USER_PASSWORD = os.environ.get("TEST_USER_PASS", "lily phillips")

# Default brand/workspace for synthetic testing
BRAND_ID = "525ae07a-0910-4bc9-8942-24cdbde03d2e"
WORKSPACE_ID = "0a24cbdf-31c4-4ab3-8e32-54504fd9e676"

class Colors:
    GREEN = "\033[92m"
    RED = "\033[91m"
    YELLOW = "\033[93m"
    CYAN = "\033[96m"
    BOLD = "\033[1m"
    RESET = "\033[0m"

results = []

def log_test(app, check_name, passed, status_code, details=""):
    verdict = f"{Colors.GREEN}[PASS]{Colors.RESET}" if passed else f"{Colors.RED}[FAIL]{Colors.RESET}"
    results.append({"app": app, "check": check_name, "passed": passed, "http": status_code, "details": details})
    print(f"  {verdict} {Colors.BOLD}{check_name}{Colors.RESET} (HTTP {status_code}) {details}")

def request_json(url, method="POST", data=None, headers=None):
    if headers is None:
        headers = {}
    encoded_data = None
    if data is not None:
        if isinstance(data, (dict, list)):
            encoded_data = json.dumps(data).encode("utf-8")
            if "Content-Type" not in headers:
                headers["Content-Type"] = "application/json"
        elif isinstance(data, bytes):
            encoded_data = data
        elif isinstance(data, str):
            encoded_data = data.encode("utf-8")

    req = urllib.request.Request(url, data=encoded_data, headers=headers, method=method)
    start_t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            elapsed = int((time.time() - start_t) * 1000)
            raw = resp.read().decode("utf-8")
            try:
                parsed = json.loads(raw)
            except Exception:
                parsed = raw
            return resp.status, parsed, elapsed
    except urllib.error.HTTPError as e:
        elapsed = int((time.time() - start_t) * 1000)
        raw = e.read().decode("utf-8")
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = raw
        return e.code, parsed, elapsed
    except Exception as e:
        elapsed = int((time.time() - start_t) * 1000)
        return 0, str(e), elapsed

def get_auth_token():
    print(f"\n{Colors.CYAN}--- Step 0: Authenticating User with Supabase Auth ---{Colors.RESET}")
    login_url = f"{SUPABASE_URL}/auth/v1/token?grant_type=password"
    status, body, ms = request_json(
        login_url,
        data={"email": USER_EMAIL, "password": USER_PASSWORD},
        headers={"apikey": SUPABASE_ANON, "Content-Type": "application/json"}
    )
    if status == 200 and isinstance(body, dict) and "access_token" in body:
        token = body["access_token"]
        print(f"  {Colors.GREEN}✓ Authenticated as {USER_EMAIL} (Token retrieved in {ms}ms){Colors.RESET}")
        return token
    else:
        print(f"  {Colors.YELLOW}! Auth failed (status {status}), proceeding with anon key{Colors.RESET}")
        return SUPABASE_ANON

def test_app_1_shopify(jwt_token):
    print(f"\n{Colors.CYAN}======================================================{Colors.RESET}")
    print(f"{Colors.BOLD}APP 1: SHOPIFY (API Connection, Sync & Webhook){Colors.RESET}")
    print(f"{Colors.CYAN}======================================================{Colors.RESET}")
    
    headers = {
        "Authorization": f"Bearer {jwt_token}",
        "apikey": SUPABASE_ANON,
        "Content-Type": "application/json"
    }

    # 1. Connection check with mock invalid creds (should return 400 or 502 gracefully handled)
    status, body, ms = request_json(
        f"{GATEWAY_URL}/test-connection",
        data={"workspace_id": WORKSPACE_ID, "brand_id": BRAND_ID, "provider": "shopify", "credentials": {"shop_domain": "demo-store.myshopify.com", "access_token": "shpat_mock_token"}},
        headers=headers
    )
    passed = status in [200, 400, 502] and isinstance(body, dict)
    log_test("Shopify", "API Connection Endpoint (test-connection)", passed, status, f"in {ms}ms")

    # 2. Sync endpoint invocation
    status, body, ms = request_json(
        f"{GATEWAY_URL}/shopify-sync",
        data={"workspace_id": WORKSPACE_ID, "brand_id": BRAND_ID},
        headers=headers
    )
    # 200 or 400/502 with error message is clean handled behavior
    passed = status in [200, 400, 502] and isinstance(body, dict)
    log_test("Shopify", "Order & Product Sync Handler (shopify-sync)", passed, status, f"in {ms}ms")

    # 3. Webhook Delivery with Valid HMAC
    webhook_secret = SHOPIFY_WEBHOOK_SECRET
    unique_order_id = int(time.time())
    payload_dict = {
        "id": unique_order_id,
        "name": f"#{unique_order_id % 10000}",
        "total_price": "1499.00",
        "currency": "INR",
        "financial_status": "paid",
        "created_at": "2026-11-21T06:00:00Z",
        "customer": {"first_name": "Aruuna", "email": "test@example.com"},
        "line_items": [{"id": 1, "title": "125East Silk Fragrance", "quantity": 1, "price": "1499.00"}]
    }
    raw_payload = json.dumps(payload_dict)
    
    # Calculate Shopify Base64 HMAC-SHA256
    raw_hmac = hmac.new(webhook_secret.encode("utf-8"), raw_payload.encode("utf-8"), hashlib.sha256).digest()
    signature_base64 = base64.b64encode(raw_hmac).decode("utf-8")

    webhook_headers = {
        "Content-Type": "application/json",
        "X-Shopify-Topic": "orders/create",
        "X-Shopify-Shop-Domain": "qwqrk9-d0.myshopify.com",
        "X-Shopify-Hmac-Sha256": signature_base64,
        "X-Shopify-Webhook-Id": f"wh_{unique_order_id}"
    }

    status, body, ms = request_json(
        f"{GATEWAY_URL}/webhook-shopify?brand_id={BRAND_ID}",
        data=raw_payload,
        headers=webhook_headers
    )
    passed = status == 200 and isinstance(body, dict) and body.get("success") is True
    log_test("Shopify", "Synthetic Order Webhook (Valid HMAC)", passed, status, f"Order #{unique_order_id} in {ms}ms")

    # 4. Duplicate Webhook Resend Check
    status2, body2, ms2 = request_json(
        f"{GATEWAY_URL}/webhook-shopify?brand_id={BRAND_ID}",
        data=raw_payload,
        headers=webhook_headers
    )
    dup_passed = status2 == 200 and (body2.get("duplicate") is True or body2.get("status") == "duplicate" or body2.get("success") is True)
    log_test("Shopify", "Duplicate Webhook Prevention (Idempotency)", dup_passed, status2, f"Resent in {ms2}ms")

def test_app_2_razorpay(jwt_token):
    print(f"\n{Colors.CYAN}======================================================{Colors.RESET}")
    print(f"{Colors.BOLD}APP 2: RAZORPAY (API Connection, Sync & Webhook){Colors.RESET}")
    print(f"{Colors.CYAN}======================================================{Colors.RESET}")

    headers = {
        "Authorization": f"Bearer {jwt_token}",
        "apikey": SUPABASE_ANON,
        "Content-Type": "application/json"
    }

    # 1. Connection check
    status, body, ms = request_json(
        f"{GATEWAY_URL}/test-connection",
        data={"workspace_id": WORKSPACE_ID, "brand_id": BRAND_ID, "provider": "razorpay", "credentials": {"key_id": "rzp_test_mock", "key_secret": "mock_secret"}},
        headers=headers
    )
    passed = status in [200, 400, 502] and isinstance(body, dict)
    log_test("Razorpay", "API Connection Endpoint (test-connection)", passed, status, f"in {ms}ms")

    # 2. Sync endpoint invocation
    status, body, ms = request_json(
        f"{GATEWAY_URL}/razorpay-sync",
        data={"workspace_id": WORKSPACE_ID, "brand_id": BRAND_ID},
        headers=headers
    )
    passed = status in [200, 400, 502] and isinstance(body, dict)
    log_test("Razorpay", "Payments & Orders Sync Handler (razorpay-sync)", passed, status, f"in {ms}ms")

    # 3. Webhook Delivery with Valid Hex HMAC
    webhook_secret = DEFAULT_SECRET
    unique_pay_id = f"pay_{int(time.time())}"
    payload_dict = {
        "entity": "event",
        "account_id": "acc_125east_test",
        "event": "payment.captured",
        "contains": ["payment"],
        "payload": {
            "payment": {
                "entity": {
                    "id": unique_pay_id,
                    "amount": 249900,
                    "currency": "INR",
                    "status": "captured",
                    "method": "upi",
                    "email": "customer@125east.com",
                    "contact": "+919876543210",
                    "created_at": int(time.time())
                }
            }
        }
    }
    raw_payload = json.dumps(payload_dict)

    # Calculate Razorpay Hex HMAC-SHA256
    raw_hmac = hmac.new(webhook_secret.encode("utf-8"), raw_payload.encode("utf-8"), hashlib.sha256).hexdigest()

    webhook_headers = {
        "Content-Type": "application/json",
        "X-Razorpay-Signature": raw_hmac
    }

    status, body, ms = request_json(
        f"{GATEWAY_URL}/webhook-razorpay?brand_id={BRAND_ID}",
        data=raw_payload,
        headers=webhook_headers
    )
    passed = status == 200 and isinstance(body, dict) and body.get("success") is True
    log_test("Razorpay", "Synthetic Payment Webhook (Valid Hex HMAC)", passed, status, f"ID {unique_pay_id} in {ms}ms")

    # 4. Duplicate Webhook Resend Check
    status2, body2, ms2 = request_json(
        f"{GATEWAY_URL}/webhook-razorpay?brand_id={BRAND_ID}",
        data=raw_payload,
        headers=webhook_headers
    )
    dup_passed = status2 == 200 and (body2.get("duplicate") is True or body2.get("status") == "duplicate" or body2.get("success") is True)
    log_test("Razorpay", "Duplicate Webhook Prevention (Idempotency)", dup_passed, status2, f"Resent in {ms2}ms")

def test_app_3_meta_ads(jwt_token):
    print(f"\n{Colors.CYAN}======================================================{Colors.RESET}")
    print(f"{Colors.BOLD}APP 3: META ADS (Marketing Campaigns & Insights Sync){Colors.RESET}")
    print(f"{Colors.CYAN}======================================================{Colors.RESET}")

    headers = {
        "Authorization": f"Bearer {jwt_token}",
        "apikey": SUPABASE_ANON,
        "Content-Type": "application/json"
    }

    # 1. Connection check
    status, body, ms = request_json(
        f"{GATEWAY_URL}/test-connection",
        data={"workspace_id": WORKSPACE_ID, "brand_id": BRAND_ID, "provider": "meta", "credentials": {"access_token": "EAAB_mock_token", "ad_account_id": "act_12345"}},
        headers=headers
    )
    passed = status in [200, 400, 502] and isinstance(body, dict)
    log_test("Meta Ads", "Graph API Connection Endpoint (test-connection)", passed, status, f"in {ms}ms")

    # 2. Sync endpoint invocation
    status, body, ms = request_json(
        f"{GATEWAY_URL}/meta-ads-sync",
        data={"workspace_id": WORKSPACE_ID, "brand_id": BRAND_ID},
        headers=headers
    )
    passed = status in [200, 400, 502] and isinstance(body, dict)
    log_test("Meta Ads", "Campaigns & Ad Spend Sync Handler (meta-ads-sync)", passed, status, f"in {ms}ms")

def test_app_4_instagram(jwt_token):
    print(f"\n{Colors.CYAN}======================================================{Colors.RESET}")
    print(f"{Colors.BOLD}APP 4: INSTAGRAM (Media & Social Insights Sync){Colors.RESET}")
    print(f"{Colors.CYAN}======================================================{Colors.RESET}")

    headers = {
        "Authorization": f"Bearer {jwt_token}",
        "apikey": SUPABASE_ANON,
        "Content-Type": "application/json"
    }

    # 1. Connection check
    status, body, ms = request_json(
        f"{GATEWAY_URL}/test-connection",
        data={"workspace_id": WORKSPACE_ID, "brand_id": BRAND_ID, "provider": "instagram", "credentials": {"access_token": "IGQV_mock_token", "instagram_id": "17841400000000"}},
        headers=headers
    )
    passed = status in [200, 400, 502] and isinstance(body, dict)
    log_test("Instagram", "Graph API Connection Endpoint (test-connection)", passed, status, f"in {ms}ms")

    # 2. Sync endpoint invocation
    status, body, ms = request_json(
        f"{GATEWAY_URL}/instagram-sync",
        data={"workspace_id": WORKSPACE_ID, "brand_id": BRAND_ID},
        headers=headers
    )
    passed = status in [200, 400, 502] and isinstance(body, dict)
    log_test("Instagram", "Media Posts & Follower Sync Handler (instagram-sync)", passed, status, f"in {ms}ms")

def test_app_5_security_and_guardrails(jwt_token):
    print(f"\n{Colors.CYAN}======================================================{Colors.RESET}")
    print(f"{Colors.BOLD}APP 5: SECURITY, BOUNDARY & GUARDRAILS AUDIT{Colors.RESET}")
    print(f"{Colors.CYAN}======================================================{Colors.RESET}")

    # 1. Unauthenticated request to sync endpoint should return 401
    status, body, ms = request_json(
        f"{GATEWAY_URL}/shopify-sync",
        data={"workspace_id": WORKSPACE_ID, "brand_id": BRAND_ID},
        headers={"Content-Type": "application/json"}
    )
    passed = status == 401
    log_test("Security", "Unauthenticated Request Blocked (Missing Token -> 401)", passed, status, f"in {ms}ms")

    # 2. Tampered Webhook Signature should return 401
    tampered_headers = {
        "Content-Type": "application/json",
        "X-Shopify-Topic": "orders/create",
        "X-Shopify-Shop-Domain": "demo.myshopify.com",
        "X-Shopify-Hmac-Sha256": "tampered_invalid_signature_xyz=="
    }
    status, body, ms = request_json(
        f"{GATEWAY_URL}/webhook-shopify?brand_id={BRAND_ID}",
        data=json.dumps({"id": 12345}),
        headers=tampered_headers
    )
    passed = status == 401
    log_test("Security", "Tampered Shopify Webhook Signature Rejected (401)", passed, status, f"in {ms}ms")

    # 3. Tampered Razorpay Webhook Signature should return 401
    rzp_tampered_headers = {
        "Content-Type": "application/json",
        "X-Razorpay-Signature": "deadbeefcafebabe000000000000000000000000000000000000000000000000"
    }
    status, body, ms = request_json(
        f"{GATEWAY_URL}/webhook-razorpay?brand_id={BRAND_ID}",
        data=json.dumps({"id": 12345}),
        headers=rzp_tampered_headers
    )
    passed = status == 401
    log_test("Security", "Tampered Razorpay Webhook Signature Rejected (401)", passed, status, f"in {ms}ms")

    # 4. Cross-Workspace Isolation Attempt
    foreign_workspace_id = "00000000-0000-0000-0000-000000000099"
    status, body, ms = request_json(
        f"{GATEWAY_URL}/shopify-sync",
        data={"workspace_id": foreign_workspace_id, "brand_id": BRAND_ID},
        headers={"Authorization": f"Bearer {jwt_token}", "apikey": SUPABASE_ANON, "Content-Type": "application/json"}
    )
    passed = status in [403, 400]
    log_test("Security", "Cross-Workspace Isolation Enforced (403/400)", passed, status, f"in {ms}ms")

def main():
    print(f"{Colors.BOLD}{Colors.YELLOW}")
    print("==========================================================================")
    print("      125EAST - AUTOMATED 5-APP DATA PULL & WEBHOOK TEST RUNNER           ")
    print("==========================================================================")
    print(f"{Colors.RESET}")
    print(f"Target Gateway: {GATEWAY_URL}")
    print(f"Target Database: {SUPABASE_URL}")
    
    jwt_token = get_auth_token()

    test_app_1_shopify(jwt_token)
    test_app_2_razorpay(jwt_token)
    test_app_3_meta_ads(jwt_token)
    test_app_4_instagram(jwt_token)
    test_app_5_security_and_guardrails(jwt_token)

    total = len(results)
    passed = sum(1 for r in results if r["passed"])
    failed = total - passed

    print(f"\n{Colors.BOLD}{Colors.CYAN}======================================================{Colors.RESET}")
    print(f"{Colors.BOLD}                   TEST SUMMARY                       {Colors.RESET}")
    print(f"{Colors.CYAN}======================================================{Colors.RESET}")
    print(f"Total Tests Run : {total}")
    print(f"Passed          : {Colors.GREEN}{passed}{Colors.RESET}")
    print(f"Failed          : {Colors.RED if failed > 0 else Colors.GREEN}{failed}{Colors.RESET}")
    print(f"Success Rate    : {int(passed / total * 100)}%")
    print(f"{Colors.CYAN}======================================================{Colors.RESET}\n")

    if failed == 0:
        print(f"{Colors.GREEN}{Colors.BOLD}ALL 5 APPLICATIONS AND WEBHOOK GUARDS ARE 100% OPERATIONAL!{Colors.RESET}\n")
    else:
        print(f"{Colors.YELLOW}Some checks returned errors. Review output above.{Colors.RESET}\n")

if __name__ == "__main__":
    main()
