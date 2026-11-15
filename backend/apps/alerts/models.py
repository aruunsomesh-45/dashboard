from django.db import models

from apps.tenancy.base_models import TenantAwareModel


class Alert(TenantAwareModel):
    class Severity(models.TextChoices):
        CRITICAL = "critical", "Critical"
        WARNING = "warning", "Warning"
        INFO = "info", "Info"

    class Status(models.TextChoices):
        OPEN = "open", "Open"
        ACKNOWLEDGED = "acknowledged", "Acknowledged"
        RESOLVED = "resolved", "Resolved"

    brand = models.ForeignKey("tenancy.Brand", on_delete=models.CASCADE, related_name="alerts")
    title = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    severity = models.CharField(max_length=20, choices=Severity.choices, default=Severity.WARNING)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.OPEN)

    # Deterministic deduplication key prevents spamming
    # e.g.: "stuck_payment:<brand_id>:<payment_id>"
    dedupe_key = models.CharField(max_length=255, db_index=True)

    acknowledged_by = models.ForeignKey(
        "accounts.User",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="acknowledged_alerts",
    )
    acknowledged_at = models.DateTimeField(null=True, blank=True)
    resolved_at = models.DateTimeField(null=True, blank=True)

    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Alert"
        verbose_name_plural = "Alerts"
        unique_together = ("workspace", "dedupe_key")
        indexes = [
            models.Index(fields=["workspace", "status"]),
            models.Index(fields=["brand", "severity"]),
        ]

    def __str__(self):
        return f"[{self.severity.upper()}] {self.title} ({self.status})"
