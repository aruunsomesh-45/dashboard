import logging
from datetime import datetime, timedelta
import requests
from django.db import transaction
from django.utils import timezone

from apps.analytics.models import FactAdsDaily
from apps.integrations.crypto import decrypt_credentials
from apps.integrations.models import Integration, RawPayload, SyncRun
from apps.integrations.shopify.adapter import to_minor_units

logger = logging.getLogger(__name__)

META_GRAPH_VERSION = "v21.0"
GRAPH_BASE_URL = f"https://graph.facebook.com/{META_GRAPH_VERSION}"


def normalize_ad_account_id(raw_id: str) -> str:
    """Ensures ad account ID has 'act_' prefix."""
    val = (raw_id or "").strip()
    if not val:
        return ""
    if not val.startswith("act_"):
        val = f"act_{val}"
    return val


def parse_action_stat(actions_list, action_names=("purchase", "omni_purchase")):
    """Extracts integer count for given action types from Meta actions list."""
    val = 0
    if not actions_list:
        return val
    for item in actions_list:
        if item.get("action_type") in action_names:
            try:
                val = max(val, int(float(item.get("value", 0))))
            except (ValueError, TypeError):
                pass
    return val


def parse_action_value(action_values_list, action_names=("purchase", "omni_purchase")):
    """Extracts float revenue for given action types from Meta action_values list."""
    val = 0.0
    if not action_values_list:
        return val
    for item in action_values_list:
        if item.get("action_type") in action_names:
            try:
                val = max(val, float(item.get("value", 0.0)))
            except (ValueError, TypeError):
                pass
    return val


def aggregate_campaign_reach(campaigns: list[dict]) -> None:
    """
    Enforces that reach is never summed across campaigns.
    Reach is non-additive across campaigns due to deduplicated audience overlap.
    Account-level reach must always be retrieved directly from account-level insights.
    """
    raise ValueError(
        "Reach is deduplicated at the ad account level and must never be summed across campaigns."
    )


def sync_meta_ads_data(integration: Integration, days: int = 30) -> dict:
    """
    Pulls campaigns, insights, and daily ad facts from Meta Marketing Graph API.
    Upserts into FactAdsDaily and updates integration records.
    """
    creds = decrypt_credentials(integration.encrypted_credentials or b"")
    ad_account_id = normalize_ad_account_id(creds.get("ad_account_id") or integration.account_identifier)
    access_token = (creds.get("access_token") or "").strip()

    if not ad_account_id or not access_token:
        raise ValueError("Meta Ad Account ID and Access Token are required.")

    sync_run = SyncRun.objects.create(
        workspace=integration.workspace,
        brand=integration.brand,
        integration=integration,
        status=SyncRun.Status.RUNNING,
        resource="meta_ads_insights",
    )

    try:
        # 1. Fetch Account Details
        acc_resp = requests.get(
            f"{GRAPH_BASE_URL}/{ad_account_id}",
            params={
                "access_token": access_token,
                "fields": "id,name,currency,timezone_name,amount_spent,account_status",
            },
            timeout=20,
        )
        if acc_resp.status_code == 401:
            raise ValueError("Meta rejected Access Token (401 Unauthorized / Token Expired).")
        if acc_resp.status_code == 403:
            raise ValueError(f"Meta Access Token lacks permission for {ad_account_id} (403 Forbidden).")
        if acc_resp.status_code >= 400:
            err_data = acc_resp.json().get("error", {})
            raise ValueError(f"Meta Graph API error: {err_data.get('message', acc_resp.text[:300])}")

        acc_data = acc_resp.json()

        # 2. Fetch 30-Day Account-Level Insights
        ins_30d_resp = requests.get(
            f"{GRAPH_BASE_URL}/{ad_account_id}/insights",
            params={
                "access_token": access_token,
                "fields": "spend,impressions,clicks,cpc,cpm,ctr,actions,action_values",
                "date_preset": "last_30d",
            },
            timeout=20,
        )
        ins_30d_list = ins_30d_resp.json().get("data", [])
        ins_30d = ins_30d_list[0] if ins_30d_list else {}

        spend_30d_f = float(ins_30d.get("spend", 0.0))
        spend_30d_paise = to_minor_units(spend_30d_f)
        orders_30d = parse_action_stat(ins_30d.get("actions"))
        rev_30d_f = parse_action_value(ins_30d.get("action_values"))
        rev_30d_paise = to_minor_units(rev_30d_f)
        roas_30d = round(rev_30d_f / spend_30d_f, 2) if spend_30d_f > 0 else 0.0

        summary_30d = {
            "spend_minor": spend_30d_paise,
            "impressions": int(ins_30d.get("impressions", 0)),
            "clicks": int(ins_30d.get("clicks", 0)),
            "ctr": round(float(ins_30d.get("ctr", 0.0)), 2),
            "cpc_minor": to_minor_units(ins_30d.get("cpc", 0.0)),
            "cpm_minor": to_minor_units(ins_30d.get("cpm", 0.0)),
            "orders": orders_30d,
            "attributed_revenue_minor": rev_30d_paise,
            "roas": roas_30d,
        }

        # 3. Fetch Lifetime Account-Level Insights
        ins_life_resp = requests.get(
            f"{GRAPH_BASE_URL}/{ad_account_id}/insights",
            params={
                "access_token": access_token,
                "fields": "spend,impressions,clicks,cpc,cpm,ctr,actions,action_values",
                "date_preset": "maximum",
            },
            timeout=20,
        )
        ins_life_list = ins_life_resp.json().get("data", [])
        ins_life = ins_life_list[0] if ins_life_list else {}
        spend_life_f = float(ins_life.get("spend", 0.0))
        orders_life = parse_action_stat(ins_life.get("actions"))
        rev_life_f = parse_action_value(ins_life.get("action_values"))

        summary_lifetime = {
            "spend_minor": to_minor_units(spend_life_f),
            "impressions": int(ins_life.get("impressions", 0)),
            "clicks": int(ins_life.get("clicks", 0)),
            "ctr": round(float(ins_life.get("ctr", 0.0)), 2),
            "cpc_minor": to_minor_units(ins_life.get("cpc", 0.0)),
            "cpm_minor": to_minor_units(ins_life.get("cpm", 0.0)),
            "orders": orders_life,
            "attributed_revenue_minor": to_minor_units(rev_life_f),
            "roas": round(rev_life_f / spend_life_f, 2) if spend_life_f > 0 else 0.0,
        }

        # 4. Fetch Daily Breakdown and Upsert FactAdsDaily
        daily_resp = requests.get(
            f"{GRAPH_BASE_URL}/{ad_account_id}/insights",
            params={
                "access_token": access_token,
                "time_increment": 1,
                "date_preset": "last_30d",
                "fields": "spend,impressions,clicks,actions,action_values",
                "limit": 100,
            },
            timeout=25,
        )
        daily_data = daily_resp.json().get("data", [])
        daily_list = []

        with transaction.atomic():
            for day_row in daily_data:
                day_str = day_row.get("date_start")
                if not day_str:
                    continue
                day_date = datetime.strptime(day_str, "%Y-%m-%d").date()
                d_spend_f = float(day_row.get("spend", 0.0))
                d_spend_paise = to_minor_units(d_spend_f)
                d_impr = int(day_row.get("impressions", 0))
                d_clicks = int(day_row.get("clicks", 0))
                d_orders = parse_action_stat(day_row.get("actions"))
                d_rev_f = parse_action_value(day_row.get("action_values"))
                d_rev_paise = to_minor_units(d_rev_f)

                FactAdsDaily.objects.update_or_create(
                    brand=integration.brand,
                    fact_date=day_date,
                    defaults={
                        "workspace": integration.workspace,
                        "spend_minor": d_spend_paise,
                        "impressions": d_impr,
                        "clicks": d_clicks,
                        "attributed_conversions": d_orders,
                        "attributed_revenue_minor": d_rev_paise,
                    },
                )

                daily_list.append({
                    "date": day_str,
                    "spend_minor": d_spend_paise,
                    "impressions": d_impr,
                    "clicks": d_clicks,
                    "orders": d_orders,
                    "attributed_revenue_minor": d_rev_paise,
                    "roas": round(d_rev_f / d_spend_f, 2) if d_spend_f > 0 else 0.0,
                })

        # 5. Fetch Campaign Metadata & Insights
        camp_resp = requests.get(
            f"{GRAPH_BASE_URL}/{ad_account_id}/campaigns",
            params={
                "access_token": access_token,
                "fields": "id,name,status,effective_status,objective,created_time,updated_time",
                "limit": 100,
            },
            timeout=20,
        )
        camp_meta_map = {c["id"]: c for c in camp_resp.json().get("data", [])}

        camp_ins_resp = requests.get(
            f"{GRAPH_BASE_URL}/{ad_account_id}/insights",
            params={
                "access_token": access_token,
                "level": "campaign",
                "fields": "campaign_id,campaign_name,spend,impressions,clicks,cpc,cpm,ctr,actions,action_values",
                "date_preset": "maximum",
                "limit": 100,
            },
            timeout=25,
        )
        camp_ins_data = camp_ins_resp.json().get("data", [])

        campaigns_result = []
        for c_row in camp_ins_data:
            cid = c_row.get("campaign_id")
            c_meta = camp_meta_map.get(cid, {})
            eff_status = c_meta.get("effective_status") or c_meta.get("status") or "PAUSED"

            c_spend_f = float(c_row.get("spend", 0.0))
            c_spend_paise = to_minor_units(c_spend_f)
            c_impr = int(c_row.get("impressions", 0))
            c_clicks = int(c_row.get("clicks", 0))
            c_ctr = round(float(c_row.get("ctr", 0.0)), 2)
            c_cpc_paise = to_minor_units(c_row.get("cpc", 0.0))
            c_orders = parse_action_stat(c_row.get("actions"))
            c_rev_f = parse_action_value(c_row.get("action_values"))
            c_rev_paise = to_minor_units(c_rev_f)
            c_roas = round(c_rev_f / c_spend_f, 2) if c_spend_f > 0 else 0.0

            campaigns_result.append({
                "id": cid,
                "name": c_row.get("campaign_name") or c_meta.get("name") or cid,
                "status": "active" if eff_status == "ACTIVE" else "paused",
                "effective_status": eff_status,
                "spend_minor": c_spend_paise,
                "impressions": c_impr,
                "clicks": c_clicks,
                "ctr": c_ctr,
                "cpc_minor": c_cpc_paise,
                "orders": c_orders,
                "attributed_revenue_minor": c_rev_paise,
                "roas": c_roas,
            })

        # Sort campaigns: active first, then highest spend
        campaigns_result.sort(key=lambda x: (x["status"] == "active", x["spend_minor"]), reverse=True)

        account_info = {
            "id": acc_data.get("id"),
            "name": acc_data.get("name"),
            "currency": acc_data.get("currency", "INR"),
            "timezone": acc_data.get("timezone_name"),
        }

        # Persist campaigns snapshot for resilient offline/expired-token view
        RawPayload.objects.update_or_create(
            brand=integration.brand,
            provider="meta_ads",
            topic="campaigns_snapshot",
            defaults={
                "workspace": integration.workspace,
                "entity_id": ad_account_id,
                "payload": {
                    "account": account_info,
                    "campaigns": campaigns_result,
                    "summary_30d": summary_30d,
                    "summary_lifetime": summary_lifetime,
                },
            },
        )

        # 6. Update SyncRun and Integration
        sync_run.status = SyncRun.Status.SUCCESS
        sync_run.finished_at = timezone.now()
        sync_run.records_processed = len(daily_data) + len(campaigns_result)
        sync_run.records_created = len(campaigns_result)
        sync_run.records_updated = len(daily_data)
        sync_run.save(update_fields=["status", "finished_at", "records_processed", "records_created", "records_updated"])

        integration.status = Integration.Status.CONNECTED
        integration.last_synced_at = timezone.now()
        integration.last_error_message = ""
        integration.save(update_fields=["status", "last_synced_at", "last_error_message"])

        return {
            "account": {
                "id": acc_data.get("id"),
                "name": acc_data.get("name"),
                "currency": acc_data.get("currency", "INR"),
                "timezone": acc_data.get("timezone_name"),
            },
            "summary_30d": summary_30d,
            "summary_lifetime": summary_lifetime,
            "campaigns": campaigns_result,
            "daily_trends": daily_list,
        }

    except Exception as exc:
        logger.exception("Meta Ads sync failed for brand %s", integration.brand_id)
        sync_run.status = SyncRun.Status.FAILED
        sync_run.finished_at = timezone.now()
        sync_run.error_message = str(exc)[:1000]
        sync_run.save(update_fields=["status", "finished_at", "error_message"])

        integration.status = Integration.Status.ERROR
        integration.last_error_message = str(exc)[:1000]
        integration.save(update_fields=["status", "last_error_message"])
        raise
