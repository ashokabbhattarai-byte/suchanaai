#!/usr/bin/env node
import puppeteer from 'puppeteer';
import { mkdirSync } from 'fs';

const outDir = process.argv[2] || 'Chapter4&5';
mkdirSync(outDir, { recursive: true });

const sysChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
import { existsSync } from 'fs';
const executablePath = existsSync(sysChrome) ? sysChrome : undefined;

const mockUser = {
  id: '1', username: 'admin', name: 'Admin User',
  email: 'admin@suchana.ai', avatarUrl: null,
  role: 'admin', status: 'active',
  createdAt: '2024-01-15T00:00:00Z',
  lastLogin: new Date().toISOString(),
};

const browser = await puppeteer.launch({
  headless: 'new',
  ...(executablePath ? { executablePath } : {}),
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });

// Set auth via localStorage
console.log('Loading homepage to set auth...');
await page.goto('http://localhost:3535/', { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise(r => setTimeout(r, 2000));
await page.evaluate((user) => {
  localStorage.setItem('pnm_user', JSON.stringify(user));
  localStorage.setItem('pnm_token', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIiwicm9sZSI6ImFkbWluIiwiZXhwIjoxODE5NTI5MjY3fQ.fake');
}, mockUser);
console.log('Auth set');

// Navigate using client-side router (preserves localStorage)
async function clientNav(path) {
  await page.evaluate((p) => {
    window.history.pushState({}, '', p);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
  await new Promise(r => setTimeout(r, 2500));
}

const pages = [
  { name: '01_homepage', url: '/' },
  { name: '02_login', url: '/login' },
  { name: '03_notices', url: '/notices' },
  { name: '04_dashboard', url: '/dashboard' },
  { name: '05_dashboard_activity', url: '/dashboard/activity' },
  { name: '06_dashboard_alerts', url: '/dashboard/alerts' },
  { name: '07_dashboard_saved', url: '/dashboard/saved' },
  { name: '08_dashboard_settings', url: '/dashboard/settings' },
  { name: '09_admin', url: '/admin' },
  { name: '10_admin_notices', url: '/admin/notices' },
  { name: '11_admin_users', url: '/admin/users' },
  { name: '12_admin_sources', url: '/admin/sources' },
  { name: '13_admin_categories', url: '/admin/categories' },
  { name: '14_admin_scraping', url: '/admin/scraping' },
  { name: '15_admin_ai', url: '/admin/ai' },
  { name: '16_admin_settings', url: '/admin/settings' },
  { name: '17_about', url: '/about' },
  { name: '18_documents', url: '/documents' },
];

for (const p of pages) {
  try {
    // Full page navigation (middleware is patched to allow all)
    await page.goto(`http://localhost:3535${p.url}`, { waitUntil: 'networkidle2', timeout: 20000 });
    await new Promise(r => setTimeout(r, 3000));
    
    const finalUrl = page.url();
    const redirected = finalUrl.includes('/login') && !p.url.includes('/login');
    
    if (redirected) {
      console.log(`  ${p.name} redirected to login, trying client nav...`);
      // Try client-side navigation from current page
      await page.evaluate((path) => {
        window.location.href = path;
      }, p.url);
      await new Promise(r => setTimeout(r, 3000));
    }
    
    const path = `${outDir}/${p.name}.png`;
    await page.screenshot({ path, fullPage: true });
    const finalUrl2 = page.url();
    const stillRedirected = finalUrl2.includes('/login') && !p.url.includes('/login');
    console.log(`${stillRedirected ? 'WARN' : 'OK'}: ${path}`);
  } catch (e) {
    console.log(`FAIL: ${p.name} - ${e.message.slice(0, 100)}`);
  }
}

await browser.close();
console.log('Done');
