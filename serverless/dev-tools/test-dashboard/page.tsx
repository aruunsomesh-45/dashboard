// DEVELOPMENT-ONLY test dashboard. Not linked from the app navigation and kept separate from
// production analytics. Returns 404 in production builds unless ENABLE_TEST_DASHBOARD=true.
import { notFound } from "next/navigation";
import { promises as fs } from "fs";
import path from "path";
import TestDashboard, { type TestSummary } from "./TestDashboard";

export const dynamic = "force-dynamic";

async function readSummary(): Promise<TestSummary | null> {
  // Written by `deno task report` in serverless/ (tests/results/summary.json).
  const file = path.join(process.cwd(), "..", "serverless", "tests", "results", "summary.json");
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as TestSummary;
  } catch {
    return null;
  }
}

export default async function DevTestsPage() {
  const enabled = process.env.NODE_ENV !== "production" || process.env.ENABLE_TEST_DASHBOARD === "true";
  if (!enabled) notFound();
  return <TestDashboard summary={await readSummary()} />;
}
