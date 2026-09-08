#!/usr/bin/env node
// Persistent screenshot helper - reuses system Chrome, no npx download
// Usage: node scripts/capture.mjs http://localhost:3535/ /tmp/out.png
import puppeteer from 'puppeteer';
const sysChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
import { existsSync } from 'fs';
const executablePath = existsSync(sysChrome) ? sysChrome : undefined;
const [url, out] = process.argv.slice(2);
if (!url || !out) {
  console.log('Usage: node scripts/capture.mjs <url> <out.png> [--full]');
  process.exit(1);
}
const fullPage = process.argv.includes('--full');
const browser = await puppeteer.launch({
  headless: 'new',
  ...(executablePath ? { executablePath } : {}),
  args: ['--no-sandbox', '--disable-setuid-sandbox']
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: 'networkidle2', timeout: 40000 });
await new Promise(r => setTimeout(r, 2500));
await page.screenshot({ path: out, fullPage });
console.log(`Saved ${out}`);
await browser.close();
