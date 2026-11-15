"""
Helper utility to update Meta Ads Access Token & Ad Account ID
across the SQLite database, Postman Environment, and Postman Collection.
"""

import argparse
import json
import os
import sys
import urllib.request

# Setup Django
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.dev")

import django
django.setup()

from apps.integrations.models import Integration
from apps.integrations.crypto import encrypt_credentials, decrypt_credentials
from apps.tenancy.models import Workspace, Brand

POSTMAN_API_KEY = os.environ.get("POSTMAN_API_KEY", "")  # never hard-code; export it in your shell
POSTMAN_ENV_UID = "58819832-c9b5458e-e21b-42f6-9f14-bcae4922b407"
POSTMAN_COL_UID = "58819832-8342b6e1-5be7-428d-9e15-574d7b94d571"


def update_database(access_token: str, ad_account_id: str | None = None, brand_id: str | None = None):
    integ_qs = Integration.objects.filter(provider=Integration.Provider.META_ADS)
    if brand_id:
        integ_qs = integ_qs.filter(brand_id=brand_id)
    integ = integ_qs.first()

    if not integ:
        print("[ERROR] No Meta Ads integration found in database.")
        return False

    creds = decrypt_credentials(integ.encrypted_credentials or b"")
    if ad_account_id:
        creds["ad_account_id"] = ad_account_id
        integ.account_identifier = ad_account_id
    elif not creds.get("ad_account_id"):
        creds["ad_account_id"] = integ.account_identifier or "1030684559469520"

    creds["access_token"] = access_token.strip()
    integ.encrypted_credentials = encrypt_credentials(creds)
    integ.status = Integration.Status.CONNECTED
    integ.last_error_message = ""
    integ.save(update_fields=["encrypted_credentials", "status", "last_error_message", "account_identifier"])

    print(f"[OK] Database updated for Brand: {integ.brand_id}")
    print(f"     Ad Account ID: {creds['ad_account_id']}")
    print(f"     Token Length: {len(access_token)} (starts with '{access_token[:15]}...')")
    return True


def update_postman_env(access_token: str, ad_account_id: str | None = None):
    url = f"https://api.getpostman.com/environments/{POSTMAN_ENV_UID}"
    get_req = urllib.request.Request(url, headers={"X-Api-Key": POSTMAN_API_KEY})
    try:
        with urllib.request.urlopen(get_req) as resp:
            env_data = json.loads(resp.read().decode())
    except Exception as e:
        print(f"[WARN] Failed to fetch Postman environment: {e}")
        return False

    values = env_data.get("environment", {}).get("values", [])
    token_updated = False
    acc_updated = False

    for v in values:
        if v.get("key") == "meta_access_token":
            v["value"] = access_token.strip()
            token_updated = True
        elif v.get("key") == "ad_account_id" and ad_account_id:
            v["value"] = ad_account_id.strip()
            acc_updated = True

    if not token_updated:
        values.append({"key": "meta_access_token", "value": access_token.strip(), "enabled": True})
    if ad_account_id and not acc_updated:
        values.append({"key": "ad_account_id", "value": ad_account_id.strip(), "enabled": True})

    put_data = json.dumps({"environment": {"values": values}}).encode("utf-8")
    put_req = urllib.request.Request(
        url,
        data=put_data,
        headers={"X-Api-Key": POSTMAN_API_KEY, "Content-Type": "application/json"},
        method="PUT"
    )
    try:
        with urllib.request.urlopen(put_req) as resp:
            print("[OK] Postman Environment '125 EAST - Local Dev' updated.")
            return True
    except Exception as e:
        print(f"[WARN] Failed to update Postman environment: {e}")
        return False


def main():
    parser = argparse.ArgumentParser(description="Update Meta Ads Access Token")
    parser.add_argument("--token", type=str, help="Valid Meta Graph API Access Token")
    parser.add_argument("--account", type=str, default="1030684559469520", help="Meta Ad Account ID")
    parser.add_argument("--brand", type=str, default="e309a60f-d474-4d04-ae30-387b571c46f2", help="Brand ID")
    parser.add_argument("--show", action="store_true", help="Display current stored credentials info")
    args = parser.parse_args()

    if args.show or not args.token:
        integ = Integration.objects.filter(provider=Integration.Provider.META_ADS).first()
        if integ:
            creds = decrypt_credentials(integ.encrypted_credentials or b"")
            tok = creds.get("access_token", "")
            print("--- CURRENT META CREDENTIALS ---")
            print(f"Brand ID: {integ.brand_id}")
            print(f"Ad Account ID: {creds.get('ad_account_id') or integ.account_identifier}")
            print(f"Token length: {len(tok)}")
            print(f"Token preview: {tok[:18]}...")
            print(f"Status: {integ.status}")
        else:
            print("No integration found.")
        if not args.token:
            print("\nUsage: python scripts/update_meta_credentials.py --token <NEW_VALID_META_TOKEN>")
            return

    update_database(args.token, args.account, args.brand)
    update_postman_env(args.token, args.account)


if __name__ == "__main__":
    main()
