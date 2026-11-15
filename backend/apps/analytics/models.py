from django.db import models

from apps.tenancy.base_models import TenantAwareModel


class FactShopDaily(TenantAwareModel):
    """
    Daily aggregated facts for Shopify orders converted to the brand's local timezone.
    All monetary fields stored in integer minor units (paise).
    """

    brand = models.ForeignKey("tenancy.Brand", on_delete=models.CASCADE, related_name="fact_shop_daily")
    fact_date = models.DateField(db_index=True)

    # Financials (Paise)
    gross_sales = models.BigIntegerField(default=0)
    discount_amount = models.BigIntegerField(default=0)
    tax_amount = models.BigIntegerField(default=0)
    shipping_amount = models.BigIntegerField(default=0)
    net_sales = models.BigIntegerField(default=0)  # gross - discount - tax

    # Counts
    orders_count = models.IntegerField(default=0)
    customers_count = models.IntegerField(default=0)
    items_count = models.IntegerField(default=0)

    # Fulfillment pipeline snapshots
    fulfilled_orders_count = models.IntegerField(default=0)
    unfulfilled_orders_count = models.IntegerField(default=0)

    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Fact Shop Daily"
        verbose_name_plural = "Fact Shop Daily"
        unique_together = ("brand", "fact_date")
        indexes = [
            models.Index(fields=["brand", "fact_date"]),
        ]

    def __str__(self):
        return f"{self.brand.name} Facts ({self.fact_date})"


class FactAdsDaily(TenantAwareModel):
    """
    Daily marketing facts for Meta Ads (restated over 28-day window).
    """

    brand = models.ForeignKey("tenancy.Brand", on_delete=models.CASCADE, related_name="fact_ads_daily")
    fact_date = models.DateField(db_index=True)

    spend_minor = models.BigIntegerField(default=0)  # Paise
    impressions = models.BigIntegerField(default=0)
    clicks = models.BigIntegerField(default=0)
    attributed_conversions = models.IntegerField(default=0)
    attributed_revenue_minor = models.BigIntegerField(default=0)  # Paise

    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Fact Ads Daily"
        verbose_name_plural = "Fact Ads Daily"
        unique_together = ("brand", "fact_date")
