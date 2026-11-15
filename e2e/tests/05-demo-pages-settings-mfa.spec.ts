import { test, expect, signedIn, goto, fx, brand1 } from "./helpers";
import { totp } from "./totp";

test.describe("Marketing page", () => {
  test("FE-MKT-01 renders and tabs switch between Meta Ads and Organic", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/marketing");
    await expect(page.getByText("Active Meta Ad Campaigns")).toBeVisible();
    const tabs = page.getByRole("button", { name: "Instagram Organic Growth" });
    await tabs.click();
    await expect(page.getByText("Active Meta Ad Campaigns")).toHaveCount(0);
    await page.getByRole("button", { name: /Meta Paid Ads/ }).click();
    await expect(page.getByText("Active Meta Ad Campaigns")).toBeVisible();
  });
  test("FE-MKT-02 data is sourced from the backend metrics API, not constants", async ({ page }) => {
    await signedIn(page);
    const calls: string[] = [];
    page.on("request", (r) => { if (r.url().includes("/api/w/")) calls.push(r.url()); });
    await goto(page, "/marketing");
    expect(calls.length, "page makes no API calls; campaigns are DEMO_CAMPAIGNS").toBeGreaterThan(0);
  });
});

test.describe("Payments page", () => {
  test("FE-PAY-01 renders attempts table, method volume and decline reasons", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/payments");
    await expect(page.getByText("Payment Attempts & Webhook Log")).toBeVisible();
    expect(await page.locator("tbody tr").count()).toBeGreaterThan(0);
  });
  test("FE-PAY-02 status filter shows only matching rows", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/payments");
    await page.locator("select").first().selectOption("failed");
    const rows = page.locator("tbody tr");
    const n = await rows.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) await expect(rows.nth(i)).toContainText(/failed/i);
  });
  test("FE-PAY-03 method filter shows only matching rows", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/payments");
    await page.locator("select").nth(1).selectOption("upi");
    const rows = page.locator("tbody tr");
    const n = await rows.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) await expect(rows.nth(i)).toContainText(/upi/i);
  });
  test("FE-PAY-04 search narrows rows; no match shows empty state", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/payments");
    const before = await page.locator("tbody tr").count();
    const token = (await page.locator("tbody tr").first().locator("td").first().innerText()).trim().split(/\s+/)[0];
    await page.getByPlaceholder(/Search pay_id/).fill(token);
    const after = await page.locator("tbody tr").count();
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThanOrEqual(before);
    await page.getByPlaceholder(/Search pay_id/).fill("zzz-nothing");
    await expect(page.getByText(/no (payments|results|attempts|records)/i).first()).toBeVisible();
  });
  test("FE-PAY-05 data comes from the backend (payment_attempt API) not constants", async ({ page }) => {
    await signedIn(page);
    const calls: string[] = [];
    page.on("request", (r) => { if (r.url().includes("/api/w/")) calls.push(r.url()); });
    await goto(page, "/payments");
    expect(calls.length, "no API calls; DEMO_PAYMENTS constant used").toBeGreaterThan(0);
  });
});

test.describe("Razorpay write flow (signed webhook -> payments page)", () => {
  const sign = (body: string) => require("crypto").createHmac("sha256", fx.rzp_secret).update(body).digest("hex");
  const event = (id: string) =>
    JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id, amount: 777700, currency: "INR", status: "captured", method: "wallet", order_id: "order_WH1", created_at: 1790000000 } } } });

  test("FE-PAY-06 unsigned and tampered webhooks are rejected and write nothing", async ({ page }) => {
    const path = `/api/webhooks/razorpay/${brand1().id}/`;
    const body = event("pay_REJECTED");
    const headers = { "content-type": "application/json" };
    expect((await page.request.post(path, { data: body, headers, failOnStatusCode: false })).status()).toBe(401);
    expect((await page.request.post(path, { data: body, headers: { ...headers, "x-razorpay-signature": sign(event("pay_OTHER")) }, failOnStatusCode: false })).status()).toBe(401);
    await signedIn(page);
    await goto(page, "/payments");
    await expect(page.getByText("pay_REJECTED")).toHaveCount(0);
  });

  test("FE-PAY-07 signed webhook appears on the payments page once, even if delivered twice", async ({ page }) => {
    const path = `/api/webhooks/razorpay/${brand1().id}/`;
    const body = event("pay_WEBHOOK1");
    const headers = { "content-type": "application/json", "x-razorpay-signature": sign(body), "x-razorpay-event-id": "evt_e2e_1" };
    expect((await page.request.post(path, { data: body, headers })).status()).toBe(200);
    const again = await page.request.post(path, { data: body, headers });
    expect((await again.json()).status).toBe("duplicate");
    await signedIn(page);
    await goto(page, "/payments");
    await expect(page.locator("tbody tr", { hasText: "pay_WEBHOOK1" })).toHaveCount(1);
    await expect(page.locator("tbody tr", { hasText: "pay_WEBHOOK1" })).toContainText("7,777");
  });
});

test.describe("Logistics page", () => {
  test("FE-LOG-01 renders shipments, KPIs and the NDR queue from stored shipments", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/logistics");
    await expect(page.getByText("Shipments & AWB Dispatch Log")).toBeVisible();
    await expect(page.getByText("Delivery Success %")).toBeVisible();
    await expect(page.getByRole("button", { name: "Request re-attempt" })).toHaveCount(2); // the two seeded NDR shipments
  });
  test("FE-LOG-02 status filter shows only matching rows", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/logistics");
    await page.locator("select").first().selectOption("delivered");
    const rows = page.locator("tbody tr");
    const n = await rows.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) await expect(rows.nth(i)).toContainText(/delivered/i);
  });
  test("FE-LOG-03 search by AWB narrows rows; no match shows empty state", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/logistics");
    const before = await page.locator("tbody tr").count();
    const token = (await page.locator("tbody tr").first().locator("td").first().innerText()).trim().split(/\s+/)[0];
    await page.getByPlaceholder(/Search AWB/).fill(token);
    const after = await page.locator("tbody tr").count();
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThanOrEqual(before);
    await page.getByPlaceholder(/Search AWB/).fill("zzz-nothing");
    await expect(page.getByText(/no (shipments|results|records)/i).first()).toBeVisible();
  });
  test("FE-LOG-04 data comes from the backend not constants", async ({ page }) => {
    await signedIn(page);
    const calls: string[] = [];
    page.on("request", (r) => { if (r.url().includes("/api/w/")) calls.push(r.url()); });
    await goto(page, "/logistics");
    expect(calls.length, "no API calls; DEMO_SHIPMENTS constant used").toBeGreaterThan(0);
    await expect(page.locator("tbody tr")).toHaveCount(7); // exactly the seeded shipments, nothing invented
  });
  test("FE-LOG-05 NDR re-attempt: courier instruction sent, status updated from the server", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/logistics");
    const row = page.locator("tbody tr", { hasText: "E2EAWB0005" });
    await row.getByRole("button", { name: "Request re-attempt" }).click();
    await expect(page.getByText("Re-attempt requested from the courier for E2EAWB0005")).toBeVisible();
    await expect(row).toContainText("In Transit");
  });
  test("FE-LOG-06 courier failure is surfaced and status is NOT changed optimistically", async ({ page }) => {
    await signedIn(page);
    await page.route("**/logistics/ndr/**", (r) => r.fulfill({ status: 502, contentType: "application/json", body: '{"error":"Courier rejected or failed the instruction."}' }));
    await goto(page, "/logistics");
    const row = page.locator("tbody tr", { hasText: "E2EAWB0006" });
    await row.getByRole("button", { name: "Request re-attempt" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(row).toContainText("NDR");
  });
});

test.describe("Settings page", () => {
  test("FE-SET-01 shows active brand profile (name, currency, timezone)", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/settings");
    await expect(page.getByText(fx.brands[0].name).first()).toBeVisible();
    await expect(page.getByText("INR").first()).toBeVisible();
    await expect(page.getByText("Asia/Kolkata").first()).toBeVisible();
  });
  test("FE-SET-02 webhook URLs include brand id and copy button gives feedback", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await signedIn(page);
    await goto(page, "/settings");
    const input = page.locator("input[readonly]").first();
    await expect(input).toHaveValue(new RegExp(`/api/webhooks/shopify/${brand1().id}/`));
    await page.getByRole("button", { name: "Copy" }).first().click();
    await expect(page.getByRole("button", { name: "Copied!" })).toBeVisible();
  });
  test("FE-SET-03 every listed webhook endpoint exists on the backend (not 404)", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/settings");
    const urls = await page.locator("input[readonly]").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    expect(urls.length).toBeGreaterThan(1);
    for (const u of urls) {
      const path = new URL(u, "http://x").pathname;
      const res = await page.request.post(path, { data: {}, failOnStatusCode: false });
      expect(res.status(), `${path} should exist (401/400 acceptable, 404 not)`).not.toBe(404);
    }
  });
  test("FE-SET-04 brand profile fields are editable by admins (settings page is not read-only)", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/settings");
    await expect(page.getByRole("button", { name: /save|update/i }).first()).toBeVisible();
  });
});

test.describe("MFA setup", () => {
  test("FE-MFA-01 start setup shows QR image, secret and 6-digit confirm input", async ({ page }) => {
    await signedIn(page, "admin"); // dedicated user: enabling MFA must not affect other tests
    await goto(page, "/mfa-setup");
    await page.getByRole("button", { name: /Enable|Start|Set up|Begin/i }).first().click();
    await expect(page.locator('img[src^="data:image/png"]')).toBeVisible();
    await expect(page.getByPlaceholder("123456")).toBeVisible();
    await expect(page.getByRole("button", { name: /Verify|Confirm|Enable/i }).last()).toBeDisabled();
  });
  test("FE-MFA-02 wrong code shows error and MFA stays disabled", async ({ page }) => {
    await signedIn(page, "admin"); // dedicated user: enabling MFA must not affect other tests
    await goto(page, "/mfa-setup");
    await page.getByRole("button", { name: /Enable|Start|Set up|Begin/i }).first().click();
    await page.getByPlaceholder("123456").fill("000000");
    await page.getByRole("button", { name: /Verify|Confirm|Enable/i }).last().click();
    await expect(page.getByText(/Invalid verification code/)).toBeVisible();
  });
  test("FE-MFA-03 correct TOTP enables MFA and shows 10 recovery codes", async ({ page }) => {
    await signedIn(page, "admin"); // dedicated user: enabling MFA must not affect other tests
    await goto(page, "/mfa-setup");
    await page.getByRole("button", { name: /Enable|Start|Set up|Begin/i }).first().click();
    await expect(page.locator('img[src^="data:image/png"]')).toBeVisible();
    const secret = (await page.locator("code, .font-mono").filter({ hasText: /^[A-Z2-7]{16,}$/ }).first().innerText()).trim();
    await page.getByPlaceholder("123456").fill(totp(secret));
    await page.getByRole("button", { name: /Verify|Confirm|Enable/i }).last().click();
    await expect(page.getByText(/[A-Z0-9]{4}-[A-Z0-9]{6}/).first()).toBeVisible();
    expect(await page.getByText(/^[A-Z0-9]{4}-[A-Z0-9]{6}$/).count()).toBe(10);
  });
  test("FE-MFA-04 non-digits are not accepted in code field (max 6)", async ({ page }) => {
    await signedIn(page, "admin"); // dedicated user: enabling MFA must not affect other tests
    await goto(page, "/mfa-setup");
    await page.getByRole("button", { name: /Enable|Start|Set up|Begin/i }).first().click();
    const c = page.getByPlaceholder("123456");
    await c.pressSequentially("12ab3456789");
    expect(await c.inputValue()).toMatch(/^\d{0,6}$/);
  });
  test("FE-MFA-05 unauthenticated Django session: setup call failure is surfaced", async ({ page }) => {
    await signedIn(page, "admin"); // dedicated user: enabling MFA must not affect other tests
    await goto(page, "/mfa-setup");
    await page.route("**/api/auth/mfa/setup/**", (r) => r.fulfill({ status: 403, contentType: "application/json", body: '{"detail":"Authentication credentials were not provided."}' }));
    await page.getByRole("button", { name: /Enable|Start|Set up|Begin/i }).first().click();
    await expect(page.getByText("Authentication credentials were not provided.")).toBeVisible();
  });
});

