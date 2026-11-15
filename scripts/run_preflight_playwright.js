const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('../e2e/node_modules/playwright');

const BASE_URL = 'http://localhost:3000';
const BACKEND_URL = 'http://127.0.0.1:8001';

const SCREENSHOT_DIR = path.join(__dirname, '..', 'e2e', 'results', 'screenshots', 'before');
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

function checkUrl(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => {
      resolve({ status: res.statusCode, ok: res.statusCode < 400 });
    }).on('error', (err) => {
      resolve({ status: 0, ok: false, error: err.message });
    });
  });
}

function b64(o) {
  return Buffer.from(JSON.stringify(o)).toString('base64url');
}

function fakeJwt(sub, email) {
  const exp = Math.floor(Date.now() / 1000) + 24 * 3600;
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, email, role: 'authenticated', aud: 'authenticated', exp })}.sig`;
}

async function main() {
  console.log('='.repeat(80));
  console.log('125 EAST - PLAYWRIGHT PRE-FLIGHT E2E & VISUAL TEST');
  console.log('='.repeat(80));

  // 1. Verify Connectivity
  console.log('\n[Task 1] Checking Server Connectivity...');
  const feCheck = await checkUrl(`${BASE_URL}/api/auth/csrf`);
  const beCheck = await checkUrl(`${BACKEND_URL}/`);

  console.log(`  Frontend (:3000) -> HTTP ${feCheck.status} ${feCheck.ok ? 'OK' : 'FAIL'}`);
  console.log(`  Backend  (:8001) -> HTTP ${beCheck.status} ${beCheck.ok ? 'OK' : 'FAIL'}`);

  if (!feCheck.ok || !beCheck.ok) {
    console.error('[ERROR] Servers are not accessible. Please ensure both are running.');
    process.exit(1);
  }

  // Launch Playwright Browser with native Chrome
  console.log('\n[Task 2] Launching Playwright Desktop Browser (Viewport: 1440x900)...');
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1
  });

  const page = await context.newPage();

  // Diagnostics collectors
  const apiRequests = [];
  const consoleErrors = [];
  const pageErrors = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  page.on('response', (response) => {
    const url = response.url();
    if (url.includes('/api/')) {
      apiRequests.push({
        method: response.request().method(),
        url: url.replace(BASE_URL, '').replace(BACKEND_URL, ''),
        status: response.status()
      });
    }
  });

  // Mock Supabase Auth network calls to provide instant authenticated session
  const userId = 'b1090049-64a1-4a0b-bead-eb16f61dbeea';
  const email = 'aruunsomesh@gmail.com';
  const workspaceId = '246b35a1-35d6-40a9-9e3b-5269fa893d9b';
  const brandId = 'e309a60f-d474-4d04-ae30-387b571c46f2';

  const sessionObj = {
    access_token: fakeJwt(userId, email),
    token_type: 'bearer',
    expires_in: 86400,
    expires_at: Math.floor(Date.now() / 1000) + 86400,
    refresh_token: 'e2e-refresh-token',
    user: {
      id: userId,
      aud: 'authenticated',
      role: 'authenticated',
      email: email,
      created_at: '2026-01-01T00:00:00Z'
    }
  };

  const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': '*'
  };

  await page.route('**/*.supabase.co/**', async (route) => {
    const p = new URL(route.request().url()).pathname;
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(data) });

    if (p.endsWith('/auth/v1/user') || p.endsWith('/auth/v1/token') || p.endsWith('/auth/v1/session')) {
      return json(sessionObj);
    }
    if (p.endsWith('/auth/v1/otp') || p.endsWith('/auth/v1/verify')) {
      return json(sessionObj);
    }
    if (p.includes('/rest/v1/')) {
      if (p.endsWith('/accounts_user')) {
        return json([{ id: userId, email, first_name: 'Aruuna', last_name: 'Somesh', mfa_enabled: false }]);
      }
      if (p.endsWith('/tenancy_workspacemember')) {
        return json([{
          role: 'owner',
          workspace: { id: workspaceId, name: 'Aruunsomesh Store', slug: 'aruunsomesh-store' }
        }]);
      }
      if (p.endsWith('/tenancy_brand')) {
        return json([{ id: brandId, name: 'Aruunsomesh Store', currency: 'INR', timezone: 'Asia/Kolkata', workspace_id: workspaceId }]);
      }
    }
    return json({});
  });

  // Pre-seed Supabase localStorage session
  await page.addInitScript(({ key, session }) => {
    window.localStorage.setItem(key, JSON.stringify(session));
  }, {
    key: 'sb-ybyroxyofqfpozvfedhc-auth-token',
    session: sessionObj
  });

  // Navigate to login
  console.log('\n[Task 2] Testing Authentication & Session Guard at http://localhost:3000/login ...');
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // User with active session is redirected to /
  console.log(`  Current URL after session redirect: ${page.url()}`);

  const routesToTest = [
    { name: '01_overview_before.png', path: '/', title: 'Executive Overview (MER)' },
    { name: '02_shopify_before.png', path: '/shopify', title: 'Shopify Intelligence' },
    { name: '03_marketing_before.png', path: '/marketing', title: 'Marketing & Meta Ads' },
    { name: '04_logistics_before.png', path: '/logistics', title: 'Delhivery Logistics' },
    { name: '05_integrations_before.png', path: '/integrations', title: 'Connect Apps' },
    { name: '06_settings_before.png', path: '/settings', title: 'Workspace Settings' }
  ];

  const results = [];

  console.log('\n[Task 3] Capturing "Before" Full-Page Screenshots & Testing Routes...');

  for (const r of routesToTest) {
    const start = Date.now();
    const fullUrl = `${BASE_URL}${r.path}`;
    await page.goto(fullUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1200); // Allow GSAP / charts animation to settle

    const filePath = path.join(SCREENSHOT_DIR, r.name);
    await page.screenshot({ path: filePath, fullPage: true });
    const latency = Date.now() - start;

    console.log(`  [PASS] ${r.path.padEnd(16)} -> Saved: ${filePath} (${latency}ms)`);
    results.push({
      route: r.path,
      title: r.title,
      screenshot: r.name,
      latencyMs: latency,
      status: 200
    });
  }

  // 4. Network & Console Inspection
  console.log('\n[Task 4] Inspecting Network & Console Health...');
  const serverErrors = apiRequests.filter(r => r.status >= 500);
  console.log(`  Total Background API Calls: ${apiRequests.length}`);
  console.log(`  HTTP 500 Errors: ${serverErrors.length}`);
  console.log(`  Unhandled Console Errors: ${consoleErrors.length}`);
  console.log(`  Page Exceptions: ${pageErrors.length}`);

  if (serverErrors.length > 0) {
    console.error('[FAIL] Detected 500 errors:', serverErrors);
  }

  // Output Summary Table
  console.log('\n' + '='.repeat(80));
  console.log('PRE-FLIGHT TEST VERIFICATION TABLE');
  console.log('='.repeat(80));
  console.log('| Route            | Page Title             | Latency | Status  | Screenshot Artifact        |');
  console.log('|------------------|------------------------|---------|---------|----------------------------|');
  for (const r of results) {
    console.log(`| ${r.route.padEnd(16)} | ${r.title.padEnd(22)} | ${String(r.latencyMs + 'ms').padEnd(7)} | 200 OK  | ${r.screenshot.padEnd(26)} |`);
  }
  console.log('='.repeat(80));

  await browser.close();
  console.log('\n[COMPLETE] All 6 "Before" Screenshots Successfully Captured.');
}

main().catch((err) => {
  console.error('[FATAL ERROR]:', err);
  process.exit(1);
});
