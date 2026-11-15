-- ============================================================================
-- Migration: 20261110000003_commerce_core.sql
-- Description: Canonical E-Commerce Core, Line Items, Gateways & Logistics Links
-- ============================================================================

-- 1. Customers
CREATE TABLE IF NOT EXISTS public.commerce_customer (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    brand_id UUID NOT NULL REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL,
    provider_id VARCHAR(255) NOT NULL,
    source_created_at TIMESTAMPTZ NULL,
    source_updated_at TIMESTAMPTZ NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    first_name VARCHAR(150) NOT NULL DEFAULT '',
    last_name VARCHAR(150) NOT NULL DEFAULT '',
    email VARCHAR(254) NOT NULL DEFAULT '',
    phone VARCHAR(30) NOT NULL DEFAULT '',
    orders_count INTEGER NOT NULL DEFAULT 0 CHECK (orders_count >= 0),
    total_spent_minor BIGINT NOT NULL DEFAULT 0 CHECK (total_spent_minor >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_commerce_customer_brand_provider UNIQUE (brand_id, provider, provider_id)
);

CREATE TRIGGER trg_commerce_customer_updated_at
BEFORE UPDATE ON public.commerce_customer
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 2. Products & Variants
CREATE TABLE IF NOT EXISTS public.commerce_product (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    brand_id UUID NOT NULL REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL,
    provider_id VARCHAR(255) NOT NULL,
    source_created_at TIMESTAMPTZ NULL,
    source_updated_at TIMESTAMPTZ NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    title VARCHAR(255) NOT NULL,
    handle VARCHAR(255) NOT NULL DEFAULT '',
    product_type VARCHAR(100) NOT NULL DEFAULT '',
    vendor VARCHAR(100) NOT NULL DEFAULT '',
    status VARCHAR(50) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_commerce_product_brand_provider UNIQUE (brand_id, provider, provider_id)
);

CREATE TRIGGER trg_commerce_product_updated_at
BEFORE UPDATE ON public.commerce_product
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.commerce_productvariant (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    brand_id UUID NOT NULL REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL,
    provider_id VARCHAR(255) NOT NULL,
    product_id UUID NOT NULL REFERENCES public.commerce_product(id) ON DELETE CASCADE,
    source_created_at TIMESTAMPTZ NULL,
    source_updated_at TIMESTAMPTZ NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    title VARCHAR(255) NOT NULL,
    sku VARCHAR(100) NOT NULL DEFAULT '',
    price_minor BIGINT NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
    inventory_quantity INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_commerce_variant_brand_provider UNIQUE (brand_id, provider, provider_id)
);

CREATE TRIGGER trg_commerce_productvariant_updated_at
BEFORE UPDATE ON public.commerce_productvariant
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 3. Orders & Order Lines
CREATE TABLE IF NOT EXISTS public.commerce_order (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    brand_id UUID NOT NULL REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL,
    provider_id VARCHAR(255) NOT NULL,
    source_created_at TIMESTAMPTZ NULL,
    source_updated_at TIMESTAMPTZ NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    order_number VARCHAR(100) NOT NULL,
    customer_id UUID NULL REFERENCES public.commerce_customer(id) ON DELETE SET NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'INR',
    gross_amount BIGINT NOT NULL DEFAULT 0,
    discount_amount BIGINT NOT NULL DEFAULT 0,
    tax_amount BIGINT NOT NULL DEFAULT 0,
    shipping_amount BIGINT NOT NULL DEFAULT 0,
    net_sales BIGINT NOT NULL DEFAULT 0,
    financial_status VARCHAR(50) NOT NULL DEFAULT 'pending',
    fulfillment_status VARCHAR(50) NOT NULL DEFAULT 'unfulfilled',
    cancelled_at TIMESTAMPTZ NULL,
    raw_payload_ref VARCHAR(255) NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_commerce_order_brand_provider UNIQUE (brand_id, provider, provider_id),
    CONSTRAINT chk_commerce_order_financial_status CHECK (financial_status IN ('pending', 'paid', 'partially_refunded', 'refunded', 'voided')),
    CONSTRAINT chk_commerce_order_fulfillment_status CHECK (fulfillment_status IN ('unfulfilled', 'partial', 'fulfilled', 'restocked'))
);

CREATE TRIGGER trg_commerce_order_updated_at
BEFORE UPDATE ON public.commerce_order
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.commerce_orderline (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES public.commerce_order(id) ON DELETE CASCADE,
    variant_id UUID NULL REFERENCES public.commerce_productvariant(id) ON DELETE SET NULL,
    title VARCHAR(255) NOT NULL,
    sku VARCHAR(100) NOT NULL DEFAULT '',
    quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
    price_minor BIGINT NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
    total_discount_minor BIGINT NOT NULL DEFAULT 0 CHECK (total_discount_minor >= 0)
);

-- 4. Payment Attempts
CREATE TABLE IF NOT EXISTS public.commerce_paymentattempt (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    brand_id UUID NOT NULL REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL,
    provider_id VARCHAR(255) NOT NULL,
    source_created_at TIMESTAMPTZ NULL,
    source_updated_at TIMESTAMPTZ NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    amount_minor BIGINT NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
    currency VARCHAR(3) NOT NULL DEFAULT 'INR',
    status VARCHAR(30) NOT NULL DEFAULT 'authorized',
    method VARCHAR(30) NOT NULL DEFAULT 'upi',
    gateway_order_id VARCHAR(255) NOT NULL DEFAULT '',
    error_code VARCHAR(100) NOT NULL DEFAULT '',
    error_description TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_commerce_payment_brand_provider UNIQUE (brand_id, provider, provider_id),
    CONSTRAINT chk_commerce_payment_status CHECK (status IN ('authorized', 'captured', 'failed', 'refunded')),
    CONSTRAINT chk_commerce_payment_method CHECK (method IN ('upi', 'card', 'netbanking', 'wallet', 'emi', 'other'))
);

CREATE TRIGGER trg_commerce_paymentattempt_updated_at
BEFORE UPDATE ON public.commerce_paymentattempt
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 5. Shipments & Tracking
CREATE TABLE IF NOT EXISTS public.commerce_shipment (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES public.tenancy_workspace(id) ON DELETE CASCADE,
    brand_id UUID NOT NULL REFERENCES public.tenancy_brand(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL,
    provider_id VARCHAR(255) NOT NULL,
    source_created_at TIMESTAMPTZ NULL,
    source_updated_at TIMESTAMPTZ NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    awb VARCHAR(100) NOT NULL,
    courier_name VARCHAR(100) NOT NULL DEFAULT '',
    canonical_status VARCHAR(30) NOT NULL DEFAULT 'created',
    raw_status VARCHAR(100) NOT NULL DEFAULT '',
    shipped_at TIMESTAMPTZ NULL,
    delivered_at TIMESTAMPTZ NULL,
    ndr_count INTEGER NOT NULL DEFAULT 0 CHECK (ndr_count >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_commerce_shipment_brand_provider UNIQUE (brand_id, provider, provider_id),
    CONSTRAINT chk_commerce_shipment_canonical_status CHECK (canonical_status IN (
        'created', 'pickup_pending', 'in_transit', 'out_for_delivery', 
        'delivered', 'ndr', 'rto_initiated', 'rto_delivered', 'cancelled'
    ))
);

CREATE TRIGGER trg_commerce_shipment_updated_at
BEFORE UPDATE ON public.commerce_shipment
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.commerce_trackingevent (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id UUID NOT NULL REFERENCES public.commerce_shipment(id) ON DELETE CASCADE,
    location VARCHAR(255) NOT NULL DEFAULT '',
    status_description TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL
);

-- 6. Decoupled Deterministic Reconciliation Links
CREATE TABLE IF NOT EXISTS public.commerce_orderpaymentlink (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES public.commerce_order(id) ON DELETE CASCADE,
    payment_attempt_id UUID NOT NULL REFERENCES public.commerce_paymentattempt(id) ON DELETE CASCADE,
    match_method VARCHAR(50) NOT NULL,
    confidence NUMERIC(3, 2) NOT NULL DEFAULT 1.00 CHECK (confidence >= 0.00 AND confidence <= 1.00),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_commerce_orderpaymentlink UNIQUE (order_id, payment_attempt_id)
);

CREATE TABLE IF NOT EXISTS public.commerce_ordershipmentlink (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES public.commerce_order(id) ON DELETE CASCADE,
    shipment_id UUID NOT NULL REFERENCES public.commerce_shipment(id) ON DELETE CASCADE,
    match_method VARCHAR(50) NOT NULL,
    confidence NUMERIC(3, 2) NOT NULL DEFAULT 1.00 CHECK (confidence >= 0.00 AND confidence <= 1.00),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_commerce_ordershipmentlink UNIQUE (order_id, shipment_id)
);
