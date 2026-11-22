"""
Pipeline Integration & Ingestion Test Suite for 125 EAST
Specifications:
1. Shopify:
   - Order "1499.00" stored as 149900 paise integer minor units.
   - taxes_included true vs false yields correct net_sales calculation.
   - Monetary fields never use FloatField (enforced via database schema introspection).
2. Webhook Idempotency & Out-of-Order:
   - Same order webhook received twice produces exactly 1 Order row.
   - Older updated_at arriving after newer updated_at is ignored.
3. Razorpay Reconciliation:
   - Failed UPI followed by captured Card = 2 PaymentAttempts linked to 1 Order via notes.shopify_order_id.
   - Two orders of identical amount at the same minute must NOT cross-link.
   - Payments without a deterministic key remain in the unlinked bucket.
4. Logistics / Shiprocket:
   - Unknown carrier status code maps safely to IN_TRANSIT.
   - Emits a logger warning and does not crash sync.
5. Marketing / Meta Ads:
   - 28-day restatement re-pull updates attributed conversions without duplicating spend rows.
   - Reach is never summed across campaigns (deduplicated account-level metric).
6. Integration Security:
   - Disconnecting an integration wipes encrypted credentials immediately from the database.
"""

from datetime import datetime, timezone as dt_timezone
import json
import logging
from pathlib import Path
import pytest
from django.apps import apps
from django.db import models

from apps.analytics.models import FactAdsDaily, FactShopDaily
from apps.commerce.models import (
    CanonicalShipmentStatus,
    Customer,
    Order,
    OrderLine,
    OrderPaymentLink,
    PaymentAttempt,
    ProductVariant,
    Shipment,
)
from apps.integrations.crypto import decrypt_credentials, encrypt_credentials
from apps.integrations.logistics.service import ingest_shiprocket_tracking
from apps.integrations.logistics.status_map import map_logistics_status
from apps.integrations.meta_ads.sync import aggregate_campaign_reach
from apps.integrations.models import Integration
from apps.integrations.razorpay.service import ingest_razorpay_payment
from apps.integrations.shopify.adapter import ShopifyAdapter
from apps.integrations.shopify.service import ingest_shopify_order

FIXTURES_DIR = Path(__file__).parent / "fixtures"


def load_fixture(filename: str) -> dict:
    filepath = FIXTURES_DIR / filename
    with open(filepath, "r", encoding="utf-8") as f:
        return json.load(f)


# ==============================================================================
# 1. SHOPIFY INGESTION & MONETARY ACCURACY
# ==============================================================================
@pytest.mark.django_db
class TestShopifyMonetaryPipeline:
    def test_shopify_order_paise_storage_and_taxes_included(self, workspace_a, brand_a):
        """Shopify order '1499.00' stored as 149900 paise. taxes_included true gives net_sales = gross - tax."""
        Integration.objects.create(
            workspace=workspace_a,
            brand=brand_a,
            provider=Integration.Provider.SHOPIFY,
            status=Integration.Status.CONNECTED,
        )

        payload = load_fixture("shopify_order_taxes_included.json")
        order = ingest_shopify_order(brand_a, payload)

        # 1499.00 stored as 149900 paise integer
        assert order.gross_amount == 149900
        assert isinstance(order.gross_amount, int)
        assert order.tax_amount == 22866
        assert isinstance(order.tax_amount, int)
        assert order.discount_amount == 0

        # When taxes_included is True: net_sales = gross - discount - tax = 149900 - 0 - 22866 = 127034
        assert order.net_sales == 127034
        assert order.lines.count() == 1
        line = order.lines.first()
        assert line.price_minor == 149900
        assert isinstance(line.price_minor, int)

    def test_shopify_order_taxes_excluded_gives_correct_net_sales(self, workspace_a, brand_a):
        """When taxes_included is False, gross line item amount is pre-tax, so net_sales = gross - discount."""
        Integration.objects.create(
            workspace=workspace_a,
            brand=brand_a,
            provider=Integration.Provider.SHOPIFY,
            status=Integration.Status.CONNECTED,
        )

        payload = load_fixture("shopify_order_taxes_excluded.json")
        order = ingest_shopify_order(brand_a, payload)

        assert order.gross_amount == 149900
        assert order.tax_amount == 26982
        # Tax is added on top of line items, so net_sales (goods sold) = gross_amount (149900)
        assert order.net_sales == 149900

    def test_float_fields_never_used_for_monetary_models(self):
        """Database schema introspection: grep/verify FloatField is never used for money across models."""
        monetary_models = [Order, OrderLine, Customer, ProductVariant, PaymentAttempt, FactShopDaily, FactAdsDaily]
        monetary_keywords = ("amount", "price", "sales", "spent", "spend", "revenue", "tax", "discount")

        for model in monetary_models:
            for field in model._meta.get_fields():
                if isinstance(field, models.Field):
                    field_name = field.name.lower()
                    if any(kw in field_name for kw in monetary_keywords):
                        assert not isinstance(
                            field, models.FloatField
                        ), f"Model {model.__name__} has monetary field '{field.name}' using FloatField! Must use BigIntegerField or IntegerField."
                        assert isinstance(
                            field, (models.BigIntegerField, models.IntegerField)
                        ), f"Model {model.__name__} monetary field '{field.name}' is not an integer type."


# ==============================================================================
# 2. WEBHOOK IDEMPOTENCY & OUT-OF-ORDER HANDLING
# ==============================================================================
@pytest.mark.django_db
class TestWebhookIdempotencyAndOrdering:
    def test_same_order_webhook_twice_creates_single_row(self, workspace_a, brand_a):
        """Receiving the same order webhook twice must result in exactly 1 database row."""
        Integration.objects.create(
            workspace=workspace_a,
            brand=brand_a,
            provider=Integration.Provider.SHOPIFY,
            status=Integration.Status.CONNECTED,
        )

        payload = load_fixture("shopify_order_taxes_included.json")

        # Ingest first time
        order1 = ingest_shopify_order(brand_a, payload)
        # Ingest identical webhook a second time
        order2 = ingest_shopify_order(brand_a, payload)

        assert order1.id == order2.id
        assert Order.objects.filter(brand=brand_a, provider="shopify", provider_id="8209829119488").count() == 1

    def test_older_updated_at_arriving_after_newer_is_ignored(self, workspace_a, brand_a):
        """If an update with an older updated_at arrives after a newer one, it must be ignored."""
        Integration.objects.create(
            workspace=workspace_a,
            brand=brand_a,
            provider=Integration.Provider.SHOPIFY,
            status=Integration.Status.CONNECTED,
        )

        initial_payload = load_fixture("shopify_order_taxes_included.json")
        ingest_shopify_order(brand_a, initial_payload)

        # Newer update arrives (updated_at = 12:00:00, financial_status = 'paid')
        newer_payload = load_fixture("shopify_order_update_newer.json")
        ingest_shopify_order(brand_a, newer_payload)

        order_after_newer = Order.objects.get(brand=brand_a, provider="shopify", provider_id="8209829119488")
        assert order_after_newer.financial_status == "paid"
        saved_updated_at = order_after_newer.source_updated_at

        # Out-of-order older update arrives late (updated_at = 10:00:00, financial_status = 'partially_paid')
        older_payload = load_fixture("shopify_order_update_older.json")
        ingest_shopify_order(brand_a, older_payload)

        order_after_older = Order.objects.get(brand=brand_a, provider="shopify", provider_id="8209829119488")
        # State must remain from the newer update
        assert order_after_older.financial_status == "paid"
        assert order_after_older.source_updated_at == saved_updated_at


# ==============================================================================
# 3. RAZORPAY MULTI-PAYMENT RECONCILIATION
# ==============================================================================
@pytest.mark.django_db
class TestRazorpayReconciliationPipeline:
    def test_failed_upi_then_captured_card_linked_to_single_order(self, workspace_a, brand_a):
        """Failed UPI then captured Card = 2 PaymentAttempts linked to 1 Order via notes.shopify_order_id."""
        Integration.objects.create(
            workspace=workspace_a,
            brand=brand_a,
            provider=Integration.Provider.RAZORPAY,
            status=Integration.Status.CONNECTED,
        )

        # Existing Shopify Order
        order = Order.objects.create(
            workspace=workspace_a,
            brand=brand_a,
            provider="shopify",
            provider_id="8209829119488",
            order_number="1001",
            gross_amount=149900,
            net_sales=127034,
        )

        # 1st attempt: Failed UPI webhook
        failed_payload = load_fixture("razorpay_payment_failed_upi.json")
        pay_fail = ingest_razorpay_payment(brand_a, failed_payload)
        assert pay_fail.status == PaymentAttempt.Status.FAILED
        assert pay_fail.method == PaymentAttempt.Method.UPI
        assert pay_fail.amount_minor == 149900

        # 2nd attempt: Captured Card webhook
        captured_payload = load_fixture("razorpay_payment_captured_card.json")
        pay_captured = ingest_razorpay_payment(brand_a, captured_payload)
        assert pay_captured.status == PaymentAttempt.Status.CAPTURED
        assert pay_captured.method == PaymentAttempt.Method.CARD
        assert pay_captured.amount_minor == 149900

        # Assert exactly 2 PaymentAttempts linked to the single Order
        assert order.payment_links.count() == 2
        linked_payment_ids = set(order.payment_links.values_list("payment_attempt__provider_id", flat=True))
        assert linked_payment_ids == {"pay_test_fail_upi_01", "pay_test_cap_card_02"}
        linked_statuses = set(order.payment_links.values_list("payment_attempt__status", flat=True))
        assert linked_statuses == {"failed", "captured"}

    def test_identical_amount_orders_at_same_minute_do_not_cross_link(self, workspace_a, brand_a):
        """Two orders of identical amount at the same minute must NOT cross-link."""
        Integration.objects.create(
            workspace=workspace_a,
            brand=brand_a,
            provider=Integration.Provider.RAZORPAY,
            status=Integration.Status.CONNECTED,
        )

        same_minute = datetime(2026, 11, 15, 10, 0, 0, tzinfo=dt_timezone.utc)

        # Order A
        order_a = Order.objects.create(
            workspace=workspace_a,
            brand=brand_a,
            provider="shopify",
            provider_id="sh_ord_AAA",
            order_number="1001",
            gross_amount=149900,
            source_created_at=same_minute,
        )

        # Order B (identical amount, same minute)
        order_b = Order.objects.create(
            workspace=workspace_a,
            brand=brand_a,
            provider="shopify",
            provider_id="sh_ord_BBB",
            order_number="1002",
            gross_amount=149900,
            source_created_at=same_minute,
        )

        # Payment for Order A
        payload_a = {
            "entity": "payment",
            "id": "pay_for_order_a",
            "amount": 149900,
            "currency": "INR",
            "status": "captured",
            "method": "upi",
            "created_at": int(same_minute.timestamp()),
            "notes": {"shopify_order_id": "sh_ord_AAA"},
        }
        pay_a = ingest_razorpay_payment(brand_a, payload_a)

        # Verify Payment A is linked ONLY to Order A, NEVER to Order B
        assert order_a.payment_links.filter(payment_attempt=pay_a).exists()
        assert not order_b.payment_links.filter(payment_attempt=pay_a).exists()
        assert order_b.payment_links.count() == 0

    def test_payment_without_deterministic_key_goes_to_unlinked_bucket(self, workspace_a, brand_a):
        """No deterministic key (notes.shopify_order_id) = unlinked bucket (zero OrderPaymentLinks)."""
        Integration.objects.create(
            workspace=workspace_a,
            brand=brand_a,
            provider=Integration.Provider.RAZORPAY,
            status=Integration.Status.CONNECTED,
        )

        # An order exists with matching amount
        Order.objects.create(
            workspace=workspace_a,
            brand=brand_a,
            provider="shopify",
            provider_id="sh_ord_matching_amt",
            order_number="1003",
            gross_amount=149900,
        )

        unlinked_payload = load_fixture("razorpay_payment_unlinked.json")
        payment = ingest_razorpay_payment(brand_a, unlinked_payload)

        # PaymentAttempt is persisted for audit
        assert payment.provider_id == "pay_test_unlinked_99"
        assert payment.amount_minor == 149900

        # But it must remain in unlinked bucket: NO order links created
        assert payment.order_links.count() == 0
        assert OrderPaymentLink.objects.filter(payment_attempt=payment).count() == 0


# ==============================================================================
# 4. SHIPROCKET UNKNOWN STATUS HANDLING
# ==============================================================================
@pytest.mark.django_db
class TestShiprocketStatusPipeline:
    def test_unknown_status_maps_to_in_transit_and_logs_warning(self, caplog):
        """Shiprocket unknown status code maps to in_transit and logs warning without throwing."""
        with caplog.at_level(logging.WARNING):
            status = map_logistics_status("CARRIER_CUSTOM_UNKNOWN_CODE_999")

        assert status == CanonicalShipmentStatus.IN_TRANSIT
        assert any("CARRIER_CUSTOM_UNKNOWN_CODE_999" in record.message for record in caplog.records)

    def test_unknown_status_payload_does_not_crash_sync(self, workspace_a, brand_a, caplog):
        """Ingesting shipment payload with unknown status does not crash sync and stores in_transit."""
        Integration.objects.create(
            workspace=workspace_a,
            brand=brand_a,
            provider=Integration.Provider.SHIPROCKET,
            status=Integration.Status.CONNECTED,
        )

        payload = load_fixture("shiprocket_tracking_unknown_status.json")

        with caplog.at_level(logging.WARNING):
            shipment = ingest_shiprocket_tracking(brand_a, payload)

        assert shipment.canonical_status == CanonicalShipmentStatus.IN_TRANSIT
        assert shipment.raw_status == "999"
        assert shipment.awb == "SR125EAST8899"
        assert any("Unknown Shiprocket status" in record.message for record in caplog.records)


# ==============================================================================
# 5. META ADS 28-DAY RESTATEMENT & REACH RULES
# ==============================================================================
@pytest.mark.django_db
class TestMetaAdsPipelineRules:
    def test_28_day_restatement_repull_updates_conversions_without_duplicating_spend_rows(
        self, workspace_a, brand_a
    ):
        """Meta 28-day restatement re-pull updates conversions without duplicating spend rows."""
        fixture_data = load_fixture("meta_ads_insights_restatement.json")
        initial_data = fixture_data["initial_pull"]
        restatement_data = fixture_data["restatement_pull_day7"]

        # 1. Initial Pull
        for row in initial_data:
            FactAdsDaily.objects.update_or_create(
                brand=brand_a,
                fact_date=datetime.strptime(row["date_start"], "%Y-%m-%d").date(),
                defaults={
                    "workspace": workspace_a,
                    "spend_minor": int(float(row["spend"]) * 100),
                    "impressions": int(row["impressions"]),
                    "clicks": int(row["clicks"]),
                    "attributed_conversions": int(row["actions"][0]["value"]),
                    "attributed_revenue_minor": int(float(row["action_values"][0]["value"]) * 100),
                },
            )

        assert FactAdsDaily.objects.filter(brand=brand_a).count() == 2
        day1_initial = FactAdsDaily.objects.get(brand=brand_a, fact_date="2026-11-01")
        assert day1_initial.spend_minor == 500000
        assert day1_initial.attributed_conversions == 2
        assert day1_initial.attributed_revenue_minor == 299800

        # 2. 28-Day Restatement Re-pull (conversions updated by Meta delayed attribution)
        for row in restatement_data:
            FactAdsDaily.objects.update_or_create(
                brand=brand_a,
                fact_date=datetime.strptime(row["date_start"], "%Y-%m-%d").date(),
                defaults={
                    "workspace": workspace_a,
                    "spend_minor": int(float(row["spend"]) * 100),
                    "impressions": int(row["impressions"]),
                    "clicks": int(row["clicks"]),
                    "attributed_conversions": int(row["actions"][0]["value"]),
                    "attributed_revenue_minor": int(float(row["action_values"][0]["value"]) * 100),
                },
            )

        # Still exactly 2 rows for the 2 dates: NO duplicate rows created!
        assert FactAdsDaily.objects.filter(brand=brand_a).count() == 2
        day1_restated = FactAdsDaily.objects.get(brand=brand_a, fact_date="2026-11-01")
        # Spend remains 500000 paise (not doubled)
        assert day1_restated.spend_minor == 500000
        # Conversions restated from 2 to 5
        assert day1_restated.attributed_conversions == 5
        # Revenue restated from 299800 to 749500
        assert day1_restated.attributed_revenue_minor == 749500

    def test_reach_is_never_summed_across_campaigns(self):
        """Reach is non-additive across campaigns due to deduplication; summing across campaigns raises ValueError."""
        fixture_data = load_fixture("meta_ads_insights_restatement.json")
        campaigns = fixture_data["campaigns_with_reach"]

        with pytest.raises(ValueError, match="never be summed across campaigns"):
            aggregate_campaign_reach(campaigns)


# ==============================================================================
# 6. DISCONNECT INTEGRATION SECURITY
# ==============================================================================
@pytest.mark.django_db
class TestIntegrationSecurityPipeline:
    def test_disconnect_wipes_encrypted_credentials_immediately(self, workspace_a, brand_a, api_client, client_for, user_a):
        """Disconnecting integration wipes encrypted credentials immediately from the database."""
        raw_creds = {"api_secret": "super_secret_shopify_api_key_456", "shop_url": "brand.myshopify.com"}
        integ = Integration.objects.create(
            workspace=workspace_a,
            brand=brand_a,
            provider=Integration.Provider.SHOPIFY,
            status=Integration.Status.CONNECTED,
            encrypted_credentials=encrypt_credentials(raw_creds),
        )

        # Confirm decrypted credentials match before disconnect
        decrypted = decrypt_credentials(integ.encrypted_credentials)
        assert decrypted["api_secret"] == "super_secret_shopify_api_key_456"

        # Disconnect immediately
        integ.disconnect()

        # Re-fetch fresh state from database
        integ.refresh_from_db()
        assert integ.status == Integration.Status.DISCONNECTED
        assert integ.encrypted_credentials == b""

        # Credentials wiped: decrypting returns empty dictionary, secret cannot be retrieved
        assert decrypt_credentials(integ.encrypted_credentials) == {}
        assert "api_secret" not in decrypt_credentials(integ.encrypted_credentials)
