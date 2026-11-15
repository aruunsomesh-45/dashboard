# Phase 3: Connectors Ecosystem (Razorpay, Logistics, Meta)

## Overview & Goal
Extend the Phase 2 `ProviderAdapter` architecture to ingest and normalize data from the remaining four platforms:
1. **Razorpay** (Payments, refunds, disputes, settlements)
2. **Logistics** (Shiprocket/Carrier tracking, NDR, RTO)
3. **Meta Ads** (Campaigns, ad sets, spend, impressions, CTR, ROAS)
4. **Instagram Organic** (Follower snapshots, post/Reel reach & engagement)

By the end of this phase, all 5 sources sync cleanly into canonical tables, multi-source records link deterministically, and credentials are protected by envelope encryption.

---

## 1. Core Mental Models & Concepts to Learn

### A. Envelope Encryption for Provider Credentials
Never store plain OAuth tokens or API secrets in your database.
- **Envelope Encryption Pattern:**
  1. Generate a unique local Data Encryption Key (DEK) for each brand integration.
  2. Encrypt the provider tokens with AES-256-GCM using this DEK.
  3. Encrypt the DEK using a Master Key stored in AWS KMS (Key Management Service) or an environment master secret.
  4. Store the encrypted token + encrypted DEK in the `Integration` table.
- **Why?** If the database is compromised, an attacker cannot decrypt tokens without access to the KMS Master Key. When a user clicks "Disconnect", immediately delete the encrypted keys and tokens.

```
+-------------------------------------------------------+
|                    AWS KMS Master Key                 |
+---------------------------+---------------------------+
                            | Encrypts / Decrypts
                            v
+-------------------------------------------------------+
|         Data Encryption Key (DEK - per integration)   |
+---------------------------+---------------------------+
                            | Encrypts / Decrypts
                            v
+-------------------------------------------------------+
|  Provider Access Token / Secret (Stored in Postgres)   |
+-------------------------------------------------------+
```

### B. Payment Reconciliation: The "Never Match on Name or Amount" Rule
In India, multiple customers may place orders of identical amounts (e.g., ₹1,499) at the same minute. Matching a Razorpay payment to a Shopify order based on amount, customer name, or timestamp will lead to catastrophic data corruption.
- **Strict Matching Hierarchy:**
  1. Primary: Shopify transaction gateway reference == Razorpay `payment_id`.
  2. Secondary: Razorpay `order_id` or `notes.shopify_order_id`.
  3. If no deterministic key matches: Store in the **`unlinked_payments`** bucket and flag for manual merchant review.

### C. Logistics State Machine & the `status_map` Pattern
Every carrier uses cryptic, varying status codes (e.g., Shiprocket may emit `6`, `17`, `RAD`, `OUT-DEL`).
- **The Pattern:** Do not hardcode `if status == 'RAD'` in Python!
- Maintain a database table `LogisticsStatusMap`:
  ```
  provider: 'shiprocket' | raw_status: 'RAD' | canonical_status: 'out_for_delivery'
  ```
- If an unknown status appears, the adapter defaults to a safe fallback (`in_transit`) and fires an alert to map the new code—without crashing the sync or requiring a code deploy.

### D. Meta Ads: Restatements and the "Never Sum Reach" Rule
1. **The 28-Day Restatement Window:** Meta's attribution window attributes conversions (purchases) up to 7 or 28 days after an ad impression was served. An ad shown on Day 1 might get credited for a purchase on Day 5.
   - *Rule:* Your Celery sync task must re-pull the last 28 days of Meta Ads insights nightly to capture retroactively attributed conversions.
2. **Never Sum Reach:** If Campaign A reaches 10,000 people and Campaign B reaches 15,000 people, the total reach is NOT 25,000, because thousands of users saw ads from both campaigns. Store reach per entity; never use `SUM(reach)` across campaigns in SQL.

### E. Paid vs Organic Separation
Instagram Organic followers and impressions must live in separate tables (`ig_account_snapshot`, `ig_media_insight`) from Meta Ads (`ads_insight_daily`). Never combine paid and organic reach into a single metric without clear visual disclaimers.

---

## 2. Step-by-Step Implementation Guide

### Step 1: Secure Credential Storage Model
```python
# apps/integrations/models.py
import uuid
from django.db import models
from .crypto import encrypt_secret, decrypt_secret

class Integration(models.Model):
    class Provider(models.TextChoices):
        SHOPIFY = 'shopify', 'Shopify'
        RAZORPAY = 'razorpay', 'Razorpay'
        SHIPROCKET = 'shiprocket', 'Shiprocket'
        META_ADS = 'meta_ads', 'Meta Ads'
        INSTAGRAM = 'instagram', 'Instagram'

    class Status(models.TextChoices):
        DISCONNECTED = 'disconnected', 'Disconnected'
        CONNECTED = 'connected', 'Connected'
        SYNCING = 'syncing', 'Syncing'
        ERROR = 'error', 'Error'
        TOKEN_EXPIRING = 'token_expiring', 'Token Expiring'

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    brand = models.ForeignKey('tenancy.Brand', on_delete=models.CASCADE, related_name='integrations')
    provider = models.CharField(max_length=50, choices=Provider.choices)
    status = models.CharField(max_length=30, choices=Status.choices, default=Status.DISCONNECTED)
    
    # Encrypted blob (AES-GCM ciphertext + IV + tag)
    encrypted_credentials = models.BinaryField(null=True, blank=True)
    token_expires_at = models.DateTimeField(null=True, blank=True)
    last_synced_at = models.DateTimeField(null=True, blank=True)
    last_error_message = models.TextField(blank=True)

    def set_credentials(self, credentials_dict: dict):
        self.encrypted_credentials = encrypt_secret(credentials_dict)

    def get_credentials(self) -> dict:
        return decrypt_secret(self.encrypted_credentials)
```

### Step 2: Razorpay Adapter (`apps/integrations/razorpay/adapter.py`)
```python
# apps/integrations/razorpay/adapter.py
import hmac
import hashlib
from ..base import ProviderAdapter
from apps.commerce.models import PaymentAttempt

class RazorpayAdapter(ProviderAdapter):
    def verify_webhook(self, headers: dict, raw_body: bytes) -> bool:
        signature = headers.get('X-Razorpay-Signature')
        if not signature:
            return False
        secret = self.integration.get_credentials().get('webhook_secret')
        expected = hmac.new(
            secret.encode('utf-8'),
            raw_body,
            hashlib.sha256
        ).hexdigest()
        return hmac.compare_digest(signature, expected)

    def normalize_payment(self, payload: dict) -> dict:
        # Razorpay sends amounts in paise already!
        entity = payload.get('entity', {})
        return {
            'provider': 'razorpay',
            'provider_id': entity.get('id'),
            'amount': entity.get('amount'), # Already paise
            'currency': entity.get('currency', 'INR'),
            'status': entity.get('status'), # captured, failed, refunded
            'method': entity.get('method'), # card, upi, netbanking
            'error_code': entity.get('error_code'),
            'error_description': entity.get('error_description'),
            'gateway_order_id': entity.get('order_id'),
            'source_created_at': entity.get('created_at'),
        }
```

### Step 3: Canonical Reconciliation Links
Create explicit relational link models with confidence scores:
```python
# apps/commerce/models_links.py
from django.db import models

class OrderPaymentLink(models.Model):
    order = models.ForeignKey('commerce.Order', on_delete=models.CASCADE, related_name='payment_links')
    payment_attempt = models.ForeignKey('commerce.PaymentAttempt', on_delete=models.CASCADE)
    match_method = models.CharField(max_length=50) # 'shopify_gateway_ref', 'notes_order_id'
    confidence = models.FloatField(default=1.0)    # 1.0 = exact deterministic match
    created_at = models.DateTimeField(auto_now_add=True)

class OrderShipmentLink(models.Model):
    order = models.ForeignKey('commerce.Order', on_delete=models.CASCADE, related_name='shipment_links')
    shipment = models.ForeignKey('commerce.Shipment', on_delete=models.CASCADE)
    match_method = models.CharField(max_length=50) # 'awb_shopify_fulfillment'
    confidence = models.FloatField(default=1.0)
    created_at = models.DateTimeField(auto_now_add=True)
```

### Step 4: Canonical Logistics Enum & Status Mapping
Define the canonical logistics states:
```python
class CanonicalShipmentStatus(models.TextChoices):
    CREATED = 'created', 'Shipment Booked'
    PICKUP_PENDING = 'pickup_pending', 'Awaiting Pickup'
    IN_TRANSIT = 'in_transit', 'In Transit'
    OUT_FOR_DELIVERY = 'out_for_delivery', 'Out for Delivery'
    DELIVERED = 'delivered', 'Delivered'
    NDR = 'ndr', 'Non-Delivery Report (Action Required)'
    RTO_INITIATED = 'rto_initiated', 'Return to Origin Initiated'
    RTO_DELIVERED = 'rto_delivered', 'Returned to Origin'
    CANCELLED = 'cancelled', 'Cancelled'
```

### Step 5: Meta Ads & Instagram Snapshot Worker
- Configure Celery Beat to execute:
  1. `sync_meta_ads_28_days`: Runs at 02:00 AM UTC, refreshes past 28 days of ad spend and conversions.
  2. `capture_instagram_daily_snapshot`: Runs at 23:59 local brand time, records follower count and aggregate profile metrics.

---

## 3. What the AI Frontend Needs (API Contract)

### 1. Integration Health Grid (`/api/w/{ws}/b/{brand}/integrations/health/`)
```json
[
  {
    "provider": "shopify",
    "name": "Shopify Store",
    "status": "connected",
    "last_sync": "2026-11-10T12:00:00Z",
    "records_synced_today": 142
  },
  {
    "provider": "meta_ads",
    "name": "Meta Ads Account",
    "status": "token_expiring",
    "token_expires_in_days": 5,
    "last_sync": "2026-11-10T02:00:00Z",
    "records_synced_today": 890
  }
]
```

### 2. Multi-Source Order Detail Timeline (`/api/w/{ws}/b/{brand}/orders/{order_id}/timeline/`)
Returns a chronological timeline joining:
- Shopify order creation & items
- Razorpay payment attempt(s) (success or failure reasons)
- Logistics dispatch, carrier scans, NDR attempts, delivery confirmation

---

## 4. Verification & Exit Gate Checklist

- [ ] **No Unencrypted Secrets:** Inspect PostgreSQL using `psql`; verify that tokens in the `Integration` table are raw encrypted bytes, never plain strings.
- [ ] **Multi-Payment Linking:** An order with an initial failed UPI attempt followed by a successful Card payment shows 2 `PaymentAttempt` records properly linked to 1 `Order`.
- [ ] **Logistics Normalization:** An unknown status code from a courier emits a warning in logs, maps to `in_transit`, and does not interrupt the sync job.
- [ ] **Restatement Integrity:** Meta Ads sync successfully updates past week purchase conversion counts without duplicating spend rows.
