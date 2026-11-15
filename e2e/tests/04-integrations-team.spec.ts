import { test, expect, signedIn, goto, fx } from "./helpers";

test.describe("Connect Apps", () => {
  test("FE-INT-01 shows 5 provider cards", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/integrations");
    for (const n of ["Shopify", "Razorpay", "Meta", "Instagram"]) await expect(page.getByRole("heading", { name: new RegExp(n) }).first()).toBeVisible();
    await expect(page.getByRole("heading", { level: 3 })).toHaveCount(5);
  });

  test("FE-INT-02 configure modal opens with provider fields (password-type secrets) and closes via X / Cancel", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/integrations");
    await page.getByRole("button", { name: /Configure|Connect|Update/i }).first().click();
    const dlg = page.getByRole("heading", { name: /Configure/ });
    await expect(dlg).toBeVisible();
    await expect(page.locator('input[type="password"]').first()).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(dlg).toHaveCount(0);
  });

  test("FE-INT-03 required fields block submit (no success notice)", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/integrations");
    await page.getByRole("button", { name: /Configure|Connect|Update/i }).first().click();
    await page.locator("form button[type=submit]").click();
    await expect(page.getByText(/Credentials encrypted/)).toHaveCount(0);
  });

  test("FE-INT-04 saving credentials sends them to the backend (persisted, not just local state)", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/integrations");
    const posts: string[] = [];
    page.on("request", (r) => { if (r.method() !== "GET" && r.url().includes("/api/")) posts.push(r.url()); });
    await page.getByRole("button", { name: /Configure|Connect|Update/i }).first().click();
    for (const i of await page.locator("form input").all()) await i.fill("e2e-value");
    await page.locator("form button[type=submit]").click();
    await expect(page.getByText(/Credentials encrypted/)).toBeVisible();
    expect(posts, "UI claims credentials were 'encrypted & stored' but no API call was made").not.toEqual([]);
  });

  test("FE-INT-05 disconnect asks for confirmation and marks provider Not Connected; state survives reload", async ({ page, diag }) => {
    await signedIn(page);
    await goto(page, "/integrations");
    await page.getByRole("button", { name: /Disconnect/i }).first().click();
    expect(diag.dialogs.some((d) => d.startsWith("confirm"))).toBe(true);
    await expect(page.getByText("Not Connected").first()).toBeVisible();
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Not Connected").first(), "disconnect was not persisted").toBeVisible();
  });

  test("FE-INT-06 Shopify 'sync now' hits the API; other providers only simulate", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/integrations");
    const resp = page.waitForResponse((r) => r.url().includes("/shopify/sync-now") && r.status() !== 308);
    await page.getByRole("button", { name: /Sync/i }).first().click();
    expect((await resp).status()).toBe(200);
  });

  test("FE-INT-07 card status reflects backend integration status (not hardcoded defaults)", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/integrations");
    const list = await (await page.request.get(`/api/w/${fx.workspace.slug}/b/${fx.brands[0].id}/integrations/`)).json();
    expect(list).toHaveLength(1); // only Shopify exists server-side
    await expect(page.getByText("Connected")).toHaveCount(1); // Razorpay/Shiprocket/Meta/Instagram have no backend record
  });
});

test.describe("Team & Access", () => {
  test("FE-TEAM-01 owner sees member table with roles, MFA status and Invite button", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/team");
    await expect(page.getByText("Active Workspace Members (3)")).toBeVisible();
    await expect(page.locator("tbody tr")).toHaveCount(3);
    for (const r of ["owner", "admin", "viewer"]) await expect(page.locator("tbody").getByText(r, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Invite Teammate/ })).toBeVisible();
  });

  test("FE-TEAM-02 viewer does not see Invite button and gets a clear message instead of an empty table", async ({ page }) => {
    await signedIn(page, "viewer");
    await goto(page, "/team");
    await expect(page.getByRole("button", { name: /Invite Teammate/ })).toHaveCount(0);
    await expect(page.getByText(/permission|not allowed|admin|access/i).first(), "members API returns 403 for viewers; UI shows '(0)' silently").toBeVisible();
  });

  test("FE-TEAM-03 invite modal: email required, role selectable, link generated, copy works", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await signedIn(page);
    await goto(page, "/team");
    await page.getByRole("button", { name: /Invite Teammate/ }).click();
    await page.getByRole("button", { name: "Generate Invite Link" }).click(); // blocked by required
    await expect(page.getByText(/invite\?|accept\?token/)).toHaveCount(0);
    await page.getByPlaceholder("colleague@125east.com").fill("new.person@example.com");
    await page.locator("form select").selectOption("analyst");
    await page.getByRole("button", { name: "Generate Invite Link" }).click();
    const url = page.locator("input[readonly], code, pre").filter({ hasText: /accept\?token=|^http/ }).or(page.getByText(/\/invites\/accept\?token=/)).first();
    await expect(url).toBeVisible();
  });

  test("FE-TEAM-04 inviting an existing member shows the server error", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/team");
    await page.getByRole("button", { name: /Invite Teammate/ }).click();
    await page.getByPlaceholder("colleague@125east.com").fill(fx.users.viewer.email);
    await page.getByRole("button", { name: "Generate Invite Link" }).click();
    await expect(page.getByText("User is already a member of this workspace.")).toBeVisible();
  });

  test("FE-TEAM-05 generated invite link actually opens an accept-invite page", async ({ page }) => {
    await signedIn(page);
    await goto(page, "/team");
    await page.getByRole("button", { name: /Invite Teammate/ }).click();
    await page.getByPlaceholder("colleague@125east.com").fill("link.check@example.com");
    await page.getByRole("button", { name: "Generate Invite Link" }).click();
    await expect(page.getByText(/\/invites\/accept\?token=/).first()).toBeVisible();
    const txt = await page.locator("body").innerText();
    const link = txt.match(/\/invites\/accept\?token=[\w-]+/)![0];
    const resp = await page.goto(link);
    expect(resp?.status(), "invite URL returns 404 â€” no /invites/accept page exists").toBe(200);
    await expect(page.getByText(/accept/i).first()).toBeVisible();
  });

  test("FE-TEAM-06 members API failure shows an error rather than an empty list", async ({ page }) => {
    await signedIn(page);
    await page.route("**/members/**", (r) => r.fulfill({ status: 500, body: "{}" }));
    await page.goto("/team");
    await expect(page.getByText(/failed|error|unable|try again/i).first()).toBeVisible();
  });
});

