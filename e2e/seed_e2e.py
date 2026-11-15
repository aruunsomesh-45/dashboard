"""Seed an ISOLATED e2e database (run from a COPY of backend/, never the real one).

Usage:  python seed_e2e.py <fixtures_out.json>   (cwd = backend copy)
Creates: owner/admin/viewer users, 2 workspaces, brands, shopify integration, 60 orders.
"""
import json
import os
import sys
from datetime import timedelta

sys.path.insert(0, os.getcwd())
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.dev")
import django  # noqa: E402

django.setup()

from django.utils import timezone  # noqa: E402

from apps.accounts.models import User  # noqa: E402
from apps.alerts.models import Alert  # noqa: E402
from apps.commerce.models import Customer, Order, OrderLine, PaymentAttempt, Shipment  # noqa: E402
from apps.integrations.crypto import encrypt_credentials  # noqa: E402
from apps.integrations.models import Integration  # noqa: E402
from apps.tenancy.models import Brand, Workspace, WorkspaceMember  # noqa: E402

PW = "E2eTestPassw0rd!"
now = timezone.now()


def user(email, first):
    u, _ = User.objects.get_or_create(email=email, defaults={"first_name": first, "last_name": "Tester"})
    u.set_password(PW)
    u.save()
    return u


owner = user("e2e-owner@test.local", "Olive")
admin = user("e2e-admin@test.local", "Adam")
viewer = user("e2e-viewer@test.local", "Vera")
outsider = user("e2e-outsider@test.local", "Otto")

ws = Workspace.objects.create(name="E2E Retail", slug="e2e-retail")
ws2 = Workspace.objects.create(name="Other Co", slug="other-co")
b1 = Brand.objects.create(workspace=ws, name="E2E Apparel")
b2 = Brand.objects.create(workspace=ws, name="E2E Footwear")
b3 = Brand.objects.create(workspace=ws2, name="Other Brand")
WorkspaceMember.objects.create(workspace=ws, user=owner, role="owner")
WorkspaceMember.objects.create(workspace=ws, user=admin, role="admin")
WorkspaceMember.objects.create(workspace=ws, user=viewer, role="viewer")
WorkspaceMember.objects.create(workspace=ws2, user=outsider, role="owner")

for b in (b1, b2, b3):
    i = Integration.objects.create(
        workspace=b.workspace, brand=b, provider="shopify", status="connected",
        account_identifier=f"{b.name.lower().replace(' ', '-')}.myshopify.com",
    )
    i.encrypted_credentials = encrypt_credentials({"api_secret": "e2e_webhook_secret"})
    i.save()

custs = [
    Customer.objects.create(workspace=ws, brand=b1, provider="shopify", provider_id=f"c{n}",
                            first_name="Cust", last_name=str(n), email=f"buyer{n}@example.com")
    for n in range(1, 4)
]
for n in range(60):
    c = custs[n % 3]
    gross = 100000 + n * 1000
    disc = 5000 if n % 4 == 0 else 0
    tax = int((gross - disc) * 0.12)
    o = Order.objects.create(
        workspace=ws, brand=b1, provider="shopify", provider_id=f"o{n}", order_number=f"E2E-{1000 + n}",
        customer=c, gross_amount=gross, discount_amount=disc, tax_amount=tax, net_sales=gross - disc - tax,
        financial_status="paid" if n % 5 else "pending",
        fulfillment_status=["fulfilled", "unfulfilled", "partial"][n % 3],
        source_created_at=now - timedelta(hours=n * 5), source_updated_at=now,
    )
    OrderLine.objects.create(order=o, title="Item", sku="SKU", quantity=1, price_minor=gross)

RZP_SECRET = "e2e_rzp_webhook_secret"
Integration.objects.create(workspace=ws, brand=b1, provider="razorpay", status="connected",
                           encrypted_credentials=encrypt_credentials({"webhook_secret": RZP_SECRET}))
Integration.objects.create(workspace=ws, brand=b1, provider="delhivery", status="connected",
                           encrypted_credentials=encrypt_credentials({"api_token": "e2e-stub-token"}))
for n, (st, method, amt) in enumerate([("captured", "upi", 150000), ("captured", "upi", 220000), ("captured", "card", 310000),
                                       ("captured", "netbanking", 90000), ("failed", "card", 120000), ("failed", "upi", 80000)]):
    PaymentAttempt.objects.create(workspace=ws, brand=b1, provider="razorpay", provider_id=f"pay_E2E{n:03d}",
                                  amount_minor=amt, status=st, method=method, gateway_order_id=f"order_E2E{n:03d}",
                                  error_code="BAD_REQUEST_ERROR" if st == "failed" else "")
for n, st in enumerate(["delivered", "delivered", "delivered", "in_transit", "out_for_delivery", "ndr", "ndr"]):
    Shipment.objects.create(workspace=ws, brand=b1, provider="delhivery", provider_id=f"s{n}", awb=f"E2EAWB{n:04d}",
                            courier_name="Delhivery", canonical_status=st, ndr_count=1 if st == "ndr" else 0,
                            shipped_at=now - timedelta(days=5), delivered_at=(now - timedelta(days=2)) if st == "delivered" else None)

Alert.objects.create(workspace=ws, brand=b1, title="Stuck payment", severity="critical", dedupe_key="e2e:1")

fx = {
    "password": PW,
    "users": {k: {"id": str(u.id), "email": u.email, "first_name": u.first_name}
              for k, u in dict(owner=owner, admin=admin, viewer=viewer, outsider=outsider).items()},
    "workspace": {"id": str(ws.id), "name": ws.name, "slug": ws.slug},
    "other_workspace": {"id": str(ws2.id), "slug": ws2.slug},
    "brands": [{"id": str(b.id), "name": b.name, "currency": b.currency, "timezone": b.timezone} for b in (b1, b2)],
    "other_brand_id": str(b3.id),
    "rzp_secret": RZP_SECRET,
}
json.dump(fx, open(sys.argv[1], "w"), indent=2)
print("seeded", Order.objects.count(), "orders")
