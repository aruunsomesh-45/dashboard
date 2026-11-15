import { test, expect } from "@playwright/test";
import { safeNextPath, loginUrlFor } from "../../frontend/src/lib/authRedirect";

const BS = String.fromCharCode(92); // backslash

test.describe("Redirect validation (open-redirect protection)", () => {
  const allowed: Array<[string, string]> = [
    ["/", "/"],
    ["/pnl", "/pnl"],
    ["/team?tab=members#top", "/team?tab=members#top"],
    ["%2Fpnl", "/pnl"],
  ];
  for (const [input, expected] of allowed) {
    test(`allows same-origin path ${JSON.stringify(input)}`, () => {
      expect(safeNextPath(input)).toBe(expected);
    });
  }

  const blocked: string[] = [
    "//evil.com",
    " //evil.com",
    "/" + BS + "evil.com",
    "/%5Cevil.com",
    "%2F%2Fevil.com",
    "https://evil.com",
    "http://evil.com/x",
    "javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "evil.com",
    "pnl",
    "/\n/evil.com",
    "/\t/evil.com",
    "/%zz",
    "/login",
    "/login?next=/x",
    "/register",
    "/auth/callback",
    "",
  ];
  for (const input of blocked) {
    test(`rejects ${JSON.stringify(input)} -> "/"`, () => {
      expect(safeNextPath(input)).toBe("/");
    });
  }

  test("null/undefined fall back to /", () => {
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath(undefined)).toBe("/");
  });

  test("loginUrlFor encodes the return path and expiry reason", () => {
    expect(loginUrlFor("/team", "expired")).toBe("/login?next=%2Fteam&reason=expired");
    expect(loginUrlFor("/")).toBe("/login");
    expect(loginUrlFor("//evil.com")).toBe("/login");
  });
});
