import { test, expect, mockSupabase, signedIn, goto, fx } from "./helpers";

test.describe("Auth & route guards", () => {
  test("FE-AUTH-01 login page renders all controls", async ({ page }) => {
    await mockSupabase(page);
    await goto(page, "/login");
    await expect(page.getByRole("heading", { name: "125 East Commerce Intelligence" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Google/ })).toBeVisible();
    await expect(page.getByPlaceholder("founder@125east.com")).toBeVisible();
    await expect(page.getByRole("button", { name: /Send Login Code/ })).toBeDisabled();
    await expect(page.getByRole("link", { name: /Create|Sign up|Register/i }).first()).toHaveAttribute("href", "/register");
  });

  test("FE-AUTH-02 login: send-code button enables only with email; invalid email blocked by browser validation", async ({ page }) => {
    const sb = await mockSupabase(page);
    await goto(page, "/login");
    const email = page.getByPlaceholder("founder@125east.com");
    const btn = page.getByRole("button", { name: /Send Login Code/ });
    await email.fill("not-an-email");
    await expect(btn).toBeEnabled();
    await btn.click();
    expect(await email.evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(false);
    expect(sb.log.filter((l) => l.includes("/auth/v1/otp"))).toHaveLength(0);
  });

  test("FE-AUTH-03 login: request OTP success moves to code step, stores pending email, resend countdown shown", async ({ page }) => {
    const sb = await mockSupabase(page);
    await goto(page, "/login");
    await page.getByPlaceholder("founder@125east.com").fill("Someone@Example.com");
    await page.getByRole("button", { name: /Send Login Code/ }).click();
    await expect(page.getByText("Enter 6-Digit Code")).toBeVisible();
    await expect(page.getByText(/Resend in \d+s/)).toBeVisible();
    expect(sb.bodies["/auth/v1/otp"][0].email).toBe("someone@example.com"); // lower-cased
    expect(await page.evaluate(() => localStorage.getItem("125east_pending_email"))).toBe("someone@example.com");
  });

  test("FE-AUTH-04 login: OTP request failure shows error message", async ({ page }) => {
    await mockSupabase(page, { otpStatus: 429 });
    await goto(page, "/login");
    await page.getByPlaceholder("founder@125east.com").fill("a@b.com");
    await page.getByRole("button", { name: /Send Login Code/ }).click();
    await expect(page.getByText(/too many attempts/i)).toBeVisible();
    await expect(page.getByText("Enter 6-Digit Code")).toHaveCount(0);
  });

  test("FE-AUTH-05 login: code input accepts digits only, max 6; verify disabled until 6 digits", async ({ page }) => {
    await mockSupabase(page);
    await goto(page, "/login?step=verify&email=a@b.com");
    const code = page.getByPlaceholder("123456");
    const verify = page.getByRole("button", { name: /Verify & Enter Cockpit/ });
    await code.pressSequentially("12ab34567890"); // typed char-by-char like a user
    await expect(code).toHaveValue("123456");
    await code.fill("123");
    await expect(verify).toBeDisabled();
    await code.fill("123456");
    await expect(verify).toBeEnabled();
  });

  test("FE-AUTH-06 login: wrong/expired code shows error and stays on login", async ({ page }) => {
    await mockSupabase(page, { verifyFail: true });
    await goto(page, "/login?step=verify&email=a@b.com");
    await page.getByPlaceholder("123456").fill("000000");
    await page.getByRole("button", { name: /Verify & Enter Cockpit/ }).click();
    await expect(page.getByText(/has expired/i)).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/login");
  });

  test("FE-AUTH-07 login: valid code signs in and lands on dashboard", async ({ page }) => {
    await mockSupabase(page, { verifyAs: "owner" });
    await goto(page, "/login?step=verify&email=" + fx.users.owner.email);
    await page.getByPlaceholder("123456").fill("123456");
    await page.getByRole("button", { name: /Verify & Enter Cockpit/ }).click();
    await page.waitForURL((u) => u.pathname === "/", { timeout: 15000 });
    await expect(page.getByText(fx.workspace.name).first()).toBeVisible();
  });

  test("FE-AUTH-08 login: 'Change Email' returns to email step", async ({ page }) => {
    await mockSupabase(page);
    await goto(page, "/login?step=verify&email=a@b.com");
    await page.getByRole("button", { name: "Change Email" }).click();
    await expect(page.getByRole("button", { name: /Send Login Code/ })).toBeVisible();
  });

  test("FE-AUTH-09 login: Google button starts OAuth redirect (stubbed)", async ({ page }) => {
    const sb = await mockSupabase(page);
    await goto(page, "/login");
    await page.getByRole("button", { name: /Google/ }).click();
    await page.waitForURL(/supabase\.co.*authorize/);
    expect(sb.log.some((l) => l.includes("/auth/v1/authorize"))).toBe(true);
  });

  test("FE-AUTH-10 register: required fields, button gating and OTP request with org metadata", async ({ page }) => {
    const sb = await mockSupabase(page);
    await goto(page, "/register");
    const submit = page.getByRole("button", { name: /Create Workspace & Send Code/ });
    await expect(submit).toBeDisabled();
    await page.getByPlaceholder("Rahul Mehta").fill("Asha Rao");
    await page.getByPlaceholder("125 East Apparel").fill("Acme Jewels");
    await expect(submit).toBeDisabled(); // email still missing
    await page.getByPlaceholder("founder@brand.com").fill("asha@acme.test");
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByPlaceholder("123456")).toBeVisible();
    const body = sb.bodies["/auth/v1/otp"][0];
    expect(body.data.organization_name).toBe("Acme Jewels");
    expect(body.data.full_name).toBe("Asha Rao");
  });

  test("FE-AUTH-11 register: OTP failure shows error", async ({ page }) => {
    await mockSupabase(page, { otpStatus: 429 });
    await goto(page, "/register");
    await page.getByPlaceholder("Rahul Mehta").fill("Asha Rao");
    await page.getByPlaceholder("125 East Apparel").fill("Acme");
    await page.getByPlaceholder("founder@brand.com").fill("asha@acme.test");
    await page.getByRole("button", { name: /Create Workspace & Send Code/ }).click();
    await expect(page.getByText(/too many attempts/i)).toBeVisible();
  });

  test("FE-AUTH-12 register: sign-in link goes to /login", async ({ page }) => {
    await mockSupabase(page);
    await goto(page, "/register");
    await page.locator('a[href="/login"]').first().click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("FE-AUTH-13 auth callback: explicit error param is displayed", async ({ page }) => {
    await mockSupabase(page);
    await goto(page, "/auth/callback?error=access_denied&error_description=User+cancelled");
    await expect(page.getByText("User cancelled")).toBeVisible();
  });

  test("FE-AUTH-14 auth callback: PKCE/verifier error offers recovery action", async ({ page }) => {
    await mockSupabase(page);
    await goto(page, "/auth/callback?error=x&error_description=PKCE+code+verifier+not+found");
    await expect(page.getByText("Email Link Opened in a Different Browser")).toBeVisible();
    await page.getByRole("button", { name: /Enter 6-Digit Code from Email/ }).click();
    await expect(page).toHaveURL(/\/login/);
  });

  test("FE-AUTH-15 auth callback: no code and no session shows error, not a blank page", async ({ page }) => {
    await mockSupabase(page);
    await goto(page, "/auth/callback");
    await expect(page.getByText(/could not be established|session/i).first()).toBeVisible();
  });

  for (const route of ["/", "/shopify", "/pnl", "/integrations", "/marketing", "/payments", "/logistics", "/team", "/settings", "/mfa-setup"]) {
    test(`FE-AUTH-16 unauthenticated direct navigation to ${route} redirects to /login`, async ({ page }) => {
      await mockSupabase(page); // no session
      await page.goto(route);
      await page.waitForURL(/\/login/, { timeout: 15000 });
    });
  }

  test("FE-AUTH-17 signed-in user visiting /login is redirected to dashboard", async ({ page }) => {
    await signedIn(page);
    await page.goto("/login");
    await page.waitForTimeout(2500);
    expect(new URL(page.url()).pathname, "signed-in user should not stay on /login").not.toBe("/login");
  });

  test("FE-AUTH-18 no unmocked Supabase endpoints are hit during sign-in flow", async ({ page }) => {
    const sb = await signedIn(page);
    await goto(page, "/");
    expect(sb.unmocked()).toEqual([]);
  });
});

