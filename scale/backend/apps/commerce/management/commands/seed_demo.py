import random
from datetime import timedelta

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from apps.accounts.models import User
from apps.commerce.models import Customer, Order, OrderLine
from apps.integrations.crypto import encrypt_credentials
from apps.integrations.models import Integration
from apps.tenancy.models import Brand, Workspace, WorkspaceMember


class Command(BaseCommand):
    help = "Generates demo workspaces, brands, and 6 months of canonical commerce orders."

    def handle(self, *args, **options):
        if not settings.DEMO_MODE:
            raise CommandError("seed_demo creates fake users/orders and only runs with DEMO_MODE=true.")
        self.stdout.write("Seeding demo data...")

        # 1. Create Demo Users
        founder, _ = User.objects.get_or_create(
            email="founder@125east.com",
            defaults={
                "first_name": "Aarav",
                "last_name": "Mehta",
                "is_active": True,
            },
        )
        founder.set_password("DemoPassword123!")
        founder.save()

        # 2. Workspace 1: 125 East Retail
        ws1, _ = Workspace.objects.get_or_create(
            slug="125-east-retail", defaults={"name": "125 East Retail Ltd", "plan": Workspace.Plan.GROWTH}
        )
        WorkspaceMember.objects.get_or_create(
            workspace=ws1, user=founder, defaults={"role": WorkspaceMember.Role.OWNER}
        )

        # Brand 1: Apparel
        b_apparel, _ = Brand.objects.get_or_create(
            workspace=ws1, name="125 East Apparel", defaults={"currency": "INR", "timezone": "Asia/Kolkata"}
        )
        # Brand 2: Footwear
        b_footwear, _ = Brand.objects.get_or_create(
            workspace=ws1, name="125 East Footwear", defaults={"currency": "INR", "timezone": "Asia/Kolkata"}
        )

        # 3. Workspace 2: Acme Brands (for isolation testing)
        ws2, _ = Workspace.objects.get_or_create(
            slug="acme-brands", defaults={"name": "Acme Consumer Brands", "plan": Workspace.Plan.STARTER}
        )
        b_acme, _ = Brand.objects.get_or_create(
            workspace=ws2, name="Acme Home", defaults={"currency": "INR", "timezone": "Asia/Kolkata"}
        )

        # Set up Shopify Integrations
        for brand in [b_apparel, b_footwear, b_acme]:
            integ, _ = Integration.objects.get_or_create(
                workspace=brand.workspace,
                brand=brand,
                provider=Integration.Provider.SHOPIFY,
                defaults={
                    "status": Integration.Status.CONNECTED,
                    "account_identifier": f"{brand.name.lower().replace(' ', '-')}.myshopify.com",
                },
            )
            integ.encrypted_credentials = encrypt_credentials(
                {"api_secret": "test_shopify_webhook_secret_key", "access_token": "shpat_demo_secret_token_125east"}
            )
            integ.save()

        # 4. Generate 6 Months of Orders for 125 East Apparel
        now = timezone.now()
        catalog = [
            ("Linen Oversized Shirt", "SHIRT-LIN-01", 249900),  # ₹2,499.00
            ("Raw Denim Jeans", "JEANS-RAW-02", 349900),  # ₹3,499.00
            ("Pima Cotton Tee", "TEE-PIMA-03", 129900),  # ₹1,299.00
            ("Wool Overshirt", "WOOL-OVER-04", 499900),  # ₹4,999.00
            ("Canvas Tote Bag", "ACC-TOTE-05", 89900),  # ₹899.00
        ]

        customers = []
        for i in range(1, 26):
            c, _ = Customer.objects.get_or_create(
                workspace=ws1,
                brand=b_apparel,
                provider="shopify",
                provider_id=f"cust_{i}",
                defaults={
                    "first_name": "Customer",
                    "last_name": f"{i}",
                    "email": f"buyer{i}@example.com",
                    "phone": f"+919876543{i:03d}",
                },
            )
            customers.append(c)

        order_count = 0
        for days_ago in range(180, -1, -1):
            order_date = now - timedelta(days=days_ago)
            # 1 to 5 orders per day
            daily_orders = random.randint(1, 4)
            for _ in range(daily_orders):
                order_count += 1
                cust = random.choice(customers)
                item = random.choice(catalog)
                qty = random.randint(1, 2)
                gross = item[2] * qty
                discount = int(gross * 0.1) if random.random() < 0.3 else 0
                tax = int((gross - discount) * 0.12)  # 12% GST
                net = gross - discount - tax

                order = Order.objects.create(
                    workspace=ws1,
                    brand=b_apparel,
                    provider="shopify",
                    provider_id=f"demo_ord_{order_count}",
                    order_number=f"125E-{1000 + order_count}",
                    customer=cust,
                    currency="INR",
                    gross_amount=gross,
                    discount_amount=discount,
                    tax_amount=tax,
                    shipping_amount=0,
                    net_sales=net,
                    financial_status="paid",
                    fulfillment_status="fulfilled" if days_ago > 3 else "unfulfilled",
                    source_created_at=order_date,
                    source_updated_at=order_date,
                )

                OrderLine.objects.create(
                    order=order,
                    title=item[0],
                    sku=item[1],
                    quantity=qty,
                    price_minor=item[2],
                    total_discount_minor=discount,
                )

        self.stdout.write(
            self.style.SUCCESS(
                f"Successfully seeded demo data: 2 Workspaces, 3 Brands, and {order_count} canonical Orders across 6 months."
            )
        )
