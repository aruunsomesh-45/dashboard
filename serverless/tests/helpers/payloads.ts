/**
 * SYNTHETIC payloads shaped like the official API docs. They are test data, not captured
 * production responses, and are never used to claim live connectivity.
 */
export function shopifyOrder(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    name: `#${1000 + (id % 1000)}`,
    order_number: 1000 + (id % 1000),
    currency: "INR",
    total_price: "1180.00",
    subtotal_price: "1000.00",
    total_discounts: "100.00",
    total_tax: "130.00",
    financial_status: "paid",
    fulfillment_status: null,
    created_at: "2026-11-10T10:00:00+05:30",
    updated_at: "2026-11-10T11:00:00+05:30",
    cancelled_at: null,
    shipping_lines: [{ price: "50.00" }],
    customer: { id: 5000 + id, email: `buyer${id}@example.test`, first_name: "Test", last_name: "Buyer", phone: null },
    line_items: [
      { id: id * 10 + 1, title: "Linen Shirt", sku: "LS-01", quantity: 2, price: "450.00", total_discount: "50.00" },
      { id: id * 10 + 2, title: "Socks", sku: "SK-02", quantity: 1, price: "200.00", total_discount: "0.00" },
    ],
    ...over,
  };
}

export function razorpayPayment(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    entity: "payment",
    amount: 118000,
    currency: "INR",
    status: "captured",
    order_id: `order_${id.slice(4)}`,
    method: "upi",
    captured: true,
    error_code: null,
    error_description: null,
    created_at: 1763712000,
    ...over,
  };
}

export function razorpayWebhook(event: string, payment: Record<string, unknown>) {
  return {
    entity: "event",
    account_id: "acc_TEST000000000",
    event,
    contains: ["payment"],
    payload: { payment: { entity: payment } },
    created_at: 1763712001,
  };
}

export function metaInsightDay(date: string, over: Record<string, unknown> = {}) {
  return {
    date_start: date,
    date_stop: date,
    spend: "1500.25",
    impressions: "42000",
    clicks: "910",
    actions: [{ action_type: "omni_purchase", value: "6" }, { action_type: "purchase", value: "6" }],
    action_values: [{ action_type: "omni_purchase", value: "7200.00" }],
    ...over,
  };
}
