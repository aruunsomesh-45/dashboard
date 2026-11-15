from django.db import models

from apps.tenancy.base_models import TenantAwareModel


class Integration(TenantAwareModel):
    class Provider(models.TextChoices):
        SHOPIFY = "shopify", "Shopify"
        RAZORPAY = "razorpay", "Razorpay"
        SHIPROCKET = "shiprocket", "Shiprocket"
        DELHIVERY = "delhivery", "Delhivery"
        META_ADS = "meta_ads", "Meta Ads"
        INSTAGRAM = "instagram", "Instagram"

    class Status(models.TextChoices):
        DISCONNECTED = "disconnected", "Disconnected"
        CONNECTED = "connected", "Connected"
        SYNCING = "syncing", "Syncing"
        ERROR = "error", "Error"
        TOKEN_EXPIRING = "token_expiring", "Token Expiring"

    brand = models.ForeignKey("tenancy.Brand", on_delete=models.CASCADE, related_name="integrations")
    provider = models.CharField(max_length=50, choices=Provider.choices)
    status = models.CharField(max_length=30, choices=Status.choices, default=Status.DISCONNECTED)

    # Scopes & metadata (e.g. shop URL, partner account ID)
    account_identifier = models.CharField(max_length=255, blank=True)
    scopes = models.JSONField(default=list, blank=True)

    # Encrypted credentials (AES-GCM encrypted bytes)
    encrypted_credentials = models.BinaryField(null=True, blank=True)
    token_expires_at = models.DateTimeField(null=True, blank=True)

    last_synced_at = models.DateTimeField(null=True, blank=True)
    last_error_message = models.TextField(blank=True)

    class Meta:
        verbose_name = "Integration"
        verbose_name_plural = "Integrations"
        unique_together = ("brand", "provider")

    def __str__(self):
        return f"{self.brand.name} - {self.get_provider_display()} ({self.status})"

    def disconnect(self):
        """Immediately disconnects integration and wipes encrypted credentials."""
        self.status = self.Status.DISCONNECTED
        self.encrypted_credentials = b""
        self.last_error_message = ""
        self.save(update_fields=["status", "encrypted_credentials", "last_error_message"])


class RawPayload(TenantAwareModel):
    brand = models.ForeignKey("tenancy.Brand", on_delete=models.CASCADE, related_name="raw_payloads")
    provider = models.CharField(max_length=50, db_index=True)
    topic = models.CharField(max_length=100, db_index=True)
    entity_id = models.CharField(max_length=255, blank=True, db_index=True)
    payload = models.JSONField()
    replayed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        verbose_name = "Raw Payload"
        verbose_name_plural = "Raw Payloads"
        indexes = [
            models.Index(fields=["brand", "provider", "created_at"]),
        ]


class SyncRun(TenantAwareModel):
    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        RUNNING = "running", "Running"
        SUCCESS = "success", "Success"
        FAILED = "failed", "Failed"
        PARTIAL = "partial", "Partial"

    integration = models.ForeignKey(Integration, on_delete=models.CASCADE, related_name="sync_runs")
    brand = models.ForeignKey("tenancy.Brand", on_delete=models.CASCADE, related_name="sync_runs")
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING)
    resource = models.CharField(max_length=50)  # 'orders', 'products', 'customers'
    started_at = models.DateTimeField(auto_now_add=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    records_processed = models.IntegerField(default=0)
    records_created = models.IntegerField(default=0)
    records_updated = models.IntegerField(default=0)
    error_message = models.TextField(blank=True)

    class Meta:
        verbose_name = "Sync Run"
        verbose_name_plural = "Sync Runs"
        ordering = ["-started_at"]


class SyncCursor(TenantAwareModel):
    integration = models.ForeignKey(Integration, on_delete=models.CASCADE, related_name="cursors")
    brand = models.ForeignKey("tenancy.Brand", on_delete=models.CASCADE, related_name="sync_cursors")
    resource = models.CharField(max_length=50)
    cursor_value = models.CharField(max_length=255)
    last_checkpoint = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = ("integration", "resource")


class WebhookEvent(TenantAwareModel):
    brand = models.ForeignKey("tenancy.Brand", on_delete=models.CASCADE, related_name="webhook_events")
    provider = models.CharField(max_length=50, db_index=True)
    event_id = models.CharField(max_length=255, unique=True)
    topic = models.CharField(max_length=100, db_index=True)
    raw_body = models.TextField()
    headers = models.JSONField(default=dict)
    processed = models.BooleanField(default=False)
    processed_at = models.DateTimeField(null=True, blank=True)
    error = models.TextField(blank=True)

    class Meta:
        verbose_name = "Webhook Event"
        verbose_name_plural = "Webhook Events"
        indexes = [
            models.Index(fields=["provider", "event_id"]),
            models.Index(fields=["processed", "created_at"]),
        ]
