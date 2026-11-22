import uuid

from django.db import models

from apps.tenancy.base_models import TenantAwareModel


class CanonicalBaseModel(TenantAwareModel):
    brand = models.ForeignKey("tenancy.Brand", on_delete=models.CASCADE, related_name="%(app_label)s_%(class)s_set")
    provider = models.CharField(max_length=50, db_index=True)  # 'shopify', 'razorpay', etc.
    provider_id = models.CharField(max_length=255, db_index=True)
    source_created_at = models.DateTimeField(null=True, blank=True, db_index=True)
    source_updated_at = models.DateTimeField(null=True, blank=True)
    ingested_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        abstract = True
        unique_together = ("brand", "provider", "provider_id")


class Customer(CanonicalBaseModel):
    first_name = models.CharField(max_length=150, blank=True)
    last_name = models.CharField(max_length=150, blank=True)
    email = models.EmailField(blank=True, db_index=True)
    phone = models.CharField(max_length=30, blank=True, db_index=True)
    orders_count = models.IntegerField(default=0)
    total_spent_minor = models.BigIntegerField(default=0)  # Paise/minor units

    class Meta:
        verbose_name = "Customer"
        verbose_name_plural = "Customers"
        indexes = [
            models.Index(fields=["brand", "provider", "provider_id"]),
        ]

    def __str__(self):
        return f"{self.email or self.phone or self.provider_id} ({self.brand.name})"


class Product(CanonicalBaseModel):
    title = models.CharField(max_length=255)
    handle = models.CharField(max_length=255, blank=True)
    product_type = models.CharField(max_length=100, blank=True)
    vendor = models.CharField(max_length=100, blank=True)
    status = models.CharField(max_length=50, default="active")

    class Meta:
        verbose_name = "Product"
        verbose_name_plural = "Products"

    def __str__(self):
        return self.title


class ProductVariant(CanonicalBaseModel):
    product = models.ForeignKey(Product, on_delete=models.CASCADE, related_name="variants")
    title = models.CharField(max_length=255)
    sku = models.CharField(max_length=100, blank=True, db_index=True)
    price_minor = models.BigIntegerField(default=0)  # paise
    inventory_quantity = models.IntegerField(default=0)

    class Meta:
        verbose_name = "Product Variant"
        verbose_name_plural = "Product Variants"

    def __str__(self):
        return f"{self.product.title} - {self.title}"


class Order(CanonicalBaseModel):
    order_number = models.CharField(max_length=100, db_index=True)
    customer = models.ForeignKey(Customer, on_delete=models.SET_NULL, null=True, blank=True, related_name="orders")
    currency = models.CharField(max_length=3, default="INR")

    # All monetary amounts stored as integer minor units (paise)
    gross_amount = models.BigIntegerField(default=0)
    discount_amount = models.BigIntegerField(default=0)
    tax_amount = models.BigIntegerField(default=0)
    shipping_amount = models.BigIntegerField(default=0)
    net_sales = models.BigIntegerField(default=0)  # gross - discount - tax

    financial_status = models.CharField(max_length=50, default="pending")  # paid, pending, refunded, voided
    fulfillment_status = models.CharField(max_length=50, default="unfulfilled")  # fulfilled, partial, unfulfilled
    cancelled_at = models.DateTimeField(null=True, blank=True)

    raw_payload_ref = models.CharField(max_length=255, blank=True)

    class Meta:
        verbose_name = "Order"
        verbose_name_plural = "Orders"
        indexes = [
            models.Index(fields=["brand", "source_created_at"]),
            models.Index(fields=["order_number"]),
        ]

    def __str__(self):
        return f"Order #{self.order_number} ({self.brand.name})"


class OrderLine(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    order = models.ForeignKey(Order, on_delete=models.CASCADE, related_name="lines")
    variant = models.ForeignKey(
        ProductVariant, on_delete=models.SET_NULL, null=True, blank=True, related_name="order_lines"
    )
    title = models.CharField(max_length=255)
    sku = models.CharField(max_length=100, blank=True)
    quantity = models.IntegerField(default=1)
    price_minor = models.BigIntegerField(default=0)
    total_discount_minor = models.BigIntegerField(default=0)

    class Meta:
        verbose_name = "Order Line"
        verbose_name_plural = "Order Lines"


class PaymentAttempt(CanonicalBaseModel):
    class Status(models.TextChoices):
        AUTHORIZED = "authorized", "Authorized"
        CAPTURED = "captured", "Captured"
        FAILED = "failed", "Failed"
        REFUNDED = "refunded", "Refunded"

    class Method(models.TextChoices):
        CARD = "card", "Card"
        UPI = "upi", "UPI"
        NETBANKING = "netbanking", "Net Banking"
        WALLET = "wallet", "Wallet"
        OTHER = "other", "Other"

    amount_minor = models.BigIntegerField(default=0)  # Always paise
    currency = models.CharField(max_length=3, default="INR")
    status = models.CharField(max_length=30, choices=Status.choices, default=Status.AUTHORIZED)
    method = models.CharField(max_length=30, choices=Method.choices, default=Method.UPI)

    # Gateway specific reference IDs
    gateway_order_id = models.CharField(max_length=255, blank=True, db_index=True)
    error_code = models.CharField(max_length=100, blank=True)
    error_description = models.TextField(blank=True)

    class Meta:
        verbose_name = "Payment Attempt"
        verbose_name_plural = "Payment Attempts"
        indexes = [
            models.Index(fields=["brand", "source_created_at"]),
            models.Index(fields=["status"]),
        ]

    def __str__(self):
        return f"{self.provider.upper()} Payment {self.provider_id} ({self.status})"


class CanonicalShipmentStatus(models.TextChoices):
    CREATED = "created", "Shipment Booked"
    PICKUP_PENDING = "pickup_pending", "Awaiting Pickup"
    IN_TRANSIT = "in_transit", "In Transit"
    OUT_FOR_DELIVERY = "out_for_delivery", "Out for Delivery"
    DELIVERED = "delivered", "Delivered"
    NDR = "ndr", "Non-Delivery Report (Action Required)"
    RTO_INITIATED = "rto_initiated", "Return to Origin Initiated"
    RTO_DELIVERED = "rto_delivered", "Returned to Origin"
    CANCELLED = "cancelled", "Cancelled"


class Shipment(CanonicalBaseModel):
    awb = models.CharField(max_length=100, db_index=True)
    courier_name = models.CharField(max_length=100, blank=True)
    canonical_status = models.CharField(
        max_length=30,
        choices=CanonicalShipmentStatus.choices,
        default=CanonicalShipmentStatus.CREATED,
    )
    raw_status = models.CharField(max_length=100, blank=True)

    shipped_at = models.DateTimeField(null=True, blank=True)
    delivered_at = models.DateTimeField(null=True, blank=True)
    ndr_count = models.IntegerField(default=0)

    class Meta:
        verbose_name = "Shipment"
        verbose_name_plural = "Shipments"
        indexes = [
            models.Index(fields=["brand", "awb"]),
            models.Index(fields=["canonical_status"]),
        ]

    def __str__(self):
        return f"Shipment AWB #{self.awb} ({self.canonical_status})"


class TrackingEvent(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    shipment = models.ForeignKey(Shipment, on_delete=models.CASCADE, related_name="events")
    location = models.CharField(max_length=255, blank=True)
    status_description = models.TextField()
    occurred_at = models.DateTimeField(db_index=True)

    class Meta:
        ordering = ["-occurred_at"]
        verbose_name = "Tracking Event"
        verbose_name_plural = "Tracking Events"


class OrderPaymentLink(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    order = models.ForeignKey(Order, on_delete=models.CASCADE, related_name="payment_links")
    payment_attempt = models.ForeignKey(PaymentAttempt, on_delete=models.CASCADE, related_name="order_links")
    match_method = models.CharField(max_length=50)  # 'shopify_gateway_ref', 'notes_order_id'
    confidence = models.FloatField(default=1.0)  # 1.0 = exact deterministic match
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = "Order Payment Link"
        verbose_name_plural = "Order Payment Links"
        unique_together = ("order", "payment_attempt")


class OrderShipmentLink(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    order = models.ForeignKey(Order, on_delete=models.CASCADE, related_name="shipment_links")
    shipment = models.ForeignKey(Shipment, on_delete=models.CASCADE, related_name="order_links")
    match_method = models.CharField(max_length=50)  # 'awb_shopify_fulfillment'
    confidence = models.FloatField(default=1.0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = "Order Shipment Link"
        verbose_name_plural = "Order Shipment Links"
        unique_together = ("order", "shipment")
