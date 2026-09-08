#!/usr/bin/env node
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const outDir = process.argv[2] || 'Chapter4&5';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});

const JWT_PAYLOAD = {
  sub: '1',
  role: 'admin',
  email: 'admin@suchana.ai',
  username: 'admin',
  name: 'Admin User',
  exp: Math.floor(Date.now() / 1000) + 86400 * 365,
};
const fakeJwt = `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify(JWT_PAYLOAD))}.fakesig`;

const mockUser = {
  id: '1',
  username: 'admin',
  name: 'Admin User',
  email: 'admin@suchana.ai',
  avatarUrl: null,
  role: 'admin',
  status: 'active',
  createdAt: '2024-01-15T00:00:00Z',
  lastLogin: new Date().toISOString(),
};

async function setupAuth(page) {
  await page.goto('http://localhost:3535/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.evaluate(({ token, user }) => {
    localStorage.setItem('pnm_token', token);
    localStorage.setItem('pnm_user', JSON.stringify(user));
    document.cookie = `pnm_token=${token}; path=/; max-age=${86400 * 365}; SameSite=Lax`;
  }, { token: fakeJwt, user: mockUser });
}

const pages = [
  { name: '01_homepage', url: '/', full: true },
  { name: '02_login', url: '/login', full: false },
  { name: '03_notices', url: '/notices', full: true },
  { name: '04_dashboard', url: '/dashboard', full: true, auth: true },
  { name: '05_dashboard_activity', url: '/dashboard/activity', full: true, auth: true },
  { name: '06_dashboard_alerts', url: '/dashboard/alerts', full: true, auth: true },
  { name: '07_dashboard_saved', url: '/dashboard/saved', full: true, auth: true },
  { name: '08_dashboard_settings', url: '/dashboard/settings', full: true, auth: true },
  { name: '09_admin', url: '/admin', full: true, auth: true },
  { name: '10_admin_notices', url: '/admin/notices', full: true, auth: true },
  { name: '11_admin_users', url: '/admin/users', full: true, auth: true },
  { name: '12_admin_sources', url: '/admin/sources', full: true, auth: true },
  { name: '13_admin_categories', url: '/admin/categories', full: true, auth: true },
  { name: '14_admin_scraping', url: '/admin/scraping', full: true, auth: true },
  { name: '15_admin_ai', url: '/admin/ai', full: true, auth: true },
  { name: '16_admin_settings', url: '/admin/settings', full: true, auth: true },
  { name: '17_about', url: '/about', full: true },
];

const page = await context.newPage();

// Setup auth first
await setupAuth(page);
console.log('Auth configured');

for (const p of pages) {
  const url = `http://localhost:3535${p.url}`;
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(1500);
    const path = `${outDir}/${p.name}.png`;
    await page.screenshot({ path, fullPage: p.full });
    console.log(`OK: ${path}`);
  } catch (e) {
    console.log(`FAIL: ${p.name} - ${e.message.slice(0, 80)}`);
  }
}

await browser.close();
console.log('Done');
