#!/usr/bin/env node
import puppeteer from 'puppeteer';
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

const outDir = 'Chapter4&5/wireframes';
const tmpDir = '/tmp/wireframes_html';
mkdirSync(outDir, { recursive: true });
mkdirSync(tmpDir, { recursive: true });

const sysChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
import { existsSync } from 'fs';
const executablePath = existsSync(sysChrome) ? sysChrome : undefined;

function wireframeHTML(title, body) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Helvetica Neue', Arial, sans-serif; background: #f5f5f5; padding: 32px; }
.wireframe { background: white; border: 2px solid #ddd; border-radius: 8px; overflow: hidden; max-width: 1200px; margin: 0 auto; }
.wf-header { background: #1a1a2e; color: white; padding: 12px 24px; display: flex; align-items: center; justify-content: space-between; font-size: 13px; }
.wf-header .logo { font-weight: 700; font-size: 16px; }
.wf-header nav { display: flex; gap: 20px; }
.wf-header nav span { opacity: 0.7; }
.wf-header .actions { display: flex; gap: 12px; align-items: center; }
.wf-header .btn { padding: 6px 16px; border-radius: 20px; font-size: 12px; }
.btn-o { border: 1px solid rgba(255,255,255,0.4); color: white; background: none; }
.btn-f { background: white; color: #1a1a2e; border: none; padding: 6px 16px; border-radius: 20px; font-size: 12px; font-weight: 600; }
.wf-body { display: flex; min-height: 500px; }
.sidebar { width: 220px; border-right: 1px solid #eee; padding: 16px 0; background: #fafafa; }
.sidebar .gl { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #999; padding: 12px 20px 4px; font-weight: 600; }
.sidebar .ni { padding: 8px 20px; font-size: 13px; color: #555; }
.sidebar .ni.a { background: #e8f0fe; color: #1a1a2e; font-weight: 600; border-right: 3px solid #1a1a2e; }
.content { flex: 1; padding: 24px; }
.content h1 { font-size: 28px; font-weight: 700; color: #1a1a2e; margin-bottom: 4px; }
.stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 20px; }
.sc { background: white; border: 1px solid #e5e5e5; border-radius: 12px; padding: 16px; }
.sc .l { font-size: 11px; color: #888; margin-bottom: 4px; }
.sc .v { font-size: 28px; font-weight: 700; color: #1a1a2e; }
.sc .s { font-size: 11px; color: #aaa; margin-top: 4px; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 500; }
.bb { background: #e8f0fe; color: #1a73e8; }
.bg { background: #e6f4ea; color: #1e8e3e; }
.br { background: #fce8e6; color: #d93025; }
.btn-d { background: #1a1a2e; color: white; border: none; padding: 8px 20px; border-radius: 20px; font-size: 12px; }
.btn-o2 { background: white; color: #333; border: 1px solid #ddd; padding: 8px 20px; border-radius: 20px; font-size: 12px; }
.sb { display: flex; gap: 8px; margin-bottom: 16px; }
.sb input { flex: 1; border: 1px solid #ddd; border-radius: 20px; padding: 8px 16px; font-size: 13px; outline: none; }
.ab { background: #1a1a2e; color: white; border-radius: 12px; padding: 16px 20px; margin-bottom: 20px; }
.tc { display: grid; grid-template-columns: 2fr 1fr; gap: 20px; }
.ni { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-bottom: 1px solid #f0f0f0; }
.ni .ic { width: 36px; height: 36px; background: #f0f0f0; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: 600; color: #1a1a2e; }
.ni .inf { flex: 1; }
.ni .inf .t { font-size: 13px; font-weight: 600; color: #1a1a2e; }
.ni .inf .m { font-size: 11px; color: #888; margin-top: 2px; }
.st { font-size: 16px; font-weight: 700; color: #1a1a2e; margin-bottom: 12px; }
.ai { display: flex; gap: 10px; padding: 8px 0; font-size: 12px; color: #555; }
.ai .dot { width: 8px; height: 8px; border-radius: 50%; background: #a8c5d6; margin-top: 4px; flex-shrink: 0; }
.cl { display: flex; min-height: 500px; }
.ll { flex: 1; padding: 60px; display: flex; flex-direction: column; justify-content: center; }
.lr { flex: 1; background: #a8c5d6; display: flex; align-items: center; justify-content: center; padding: 40px; }
.lr .qb { background: white; border-radius: 16px; padding: 32px; max-width: 380px; }
.lr .qb q { font-size: 22px; font-weight: 500; color: #1a1a2e; line-height: 1.4; }
.gb { display: flex; align-items: center; gap: 12px; border: 1px solid #ddd; border-radius: 24px; padding: 12px 24px; font-size: 14px; background: white; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #888; padding: 8px 12px; border-bottom: 2px solid #eee; }
td { padding: 10px 12px; border-bottom: 1px solid #f0f0f0; font-size: 13px; color: #333; }
</style></head><body>
<div class="wireframe">
${body}
</div>
</body></html>`;
}

const wireframes = [
  {
    name: 'wf_login',
    html: wireframeHTML('Login', `
      <div class="wf-header">
        <span class="logo">SuchanaAI</span>
        <nav><span>Product</span><span>Notices</span><span>Documents</span><span>Pricing</span><span>About</span></nav>
        <div class="actions"><span class="btn btn-o">Contact</span><span style="color:#aaa">EN</span><span class="btn-f">Sign in</span></div>
      </div>
      <div class="cl">
        <div class="ll">
          <p style="font-size:13px;color:#888;margin-bottom:40px">Back</p>
          <h1 style="font-size:36px;font-weight:700;color:#1a1a2e;margin-bottom:8px">Suchana AI</h1>
          <h2 style="font-size:42px;font-weight:700;color:#1a1a2e;margin-bottom:12px">Welcome back.</h2>
          <p style="font-size:15px;color:#666;margin-bottom:32px">Sign in to track notices, set alerts, and search documents.</p>
          <div class="gb"><span style="font-size:20px;font-weight:700;color:#4285f4">G</span> Google</div>
          <p style="font-size:12px;color:#888;margin-top:20px;text-align:center">New here? Sign in with Google - your account is created automatically.</p>
          <p style="font-size:11px;color:#aaa;margin-top:16px;text-align:center">By signing in, you agree to our Privacy Policy.</p>
        </div>
        <div class="lr">
          <div class="qb">
            <q>Transparent governance starts with accessible public notices.</q>
            <p style="margin-top:16px;font-size:13px;color:#888">Suchana AI - Nepal's AI-powered notice platform</p>
            <div class="btn-d" style="margin-top:24px;text-align:center;padding:12px">Browse notices without signing in</div>
          </div>
        </div>
      </div>
    `),
  },
  {
    name: 'wf_dashboard',
    html: wireframeHTML('Dashboard', `
      <div class="wf-header">
        <span class="logo">SuchanaAI</span>
        <nav><span>Product</span><span>Notices</span><span>Documents</span><span>Pricing</span><span>About</span></nav>
        <div class="actions"><span class="btn btn-o">Contact</span><span style="color:#aaa">EN</span><span class="btn-f">Dashboard</span></div>
      </div>
      <div class="wf-body">
        <div class="sidebar">
          <div class="gl">Overview</div><div class="ni a">Dashboard</div>
          <div class="gl">My content</div><div class="ni">Saved notices</div><div class="ni">My alerts</div><div class="ni">Document search</div>
          <div class="gl">Account</div><div class="ni">Plan & billing</div><div class="ni">Activity</div><div class="ni">Settings</div>
        </div>
        <div class="content">
          <p style="font-size:12px;color:#888;margin-bottom:4px">Saturday, August 29</p>
          <h1>Good morning, Home.</h1>
          <div class="stat-grid">
            <div class="sc"><div class="l">Notices viewed</div><div class="v">47</div><div class="s">this month</div></div>
            <div class="sc"><div class="l">Saved</div><div class="v">8</div><div class="s">notices bookmarked</div></div>
            <div class="sc"><div class="l">Active alerts</div><div class="v">2</div><div class="s">13 total matches</div></div>
            <div class="sc"><div class="l">Member since</div><div class="v" style="font-size:22px">Aug 2026</div><div class="s">user</div></div>
          </div>
          <div class="ab"><span style="font-weight:600">Urgent notices</span> <span class="badge bb">2 active</span></div>
          <div class="tc">
            <div>
              <div class="st">Recommended for you</div>
              <div class="ni"><div class="ic">N</div><div class="inf"><div class="t">Nepal PSC - Section Officer Exam 2082</div><div class="m">Nepal Public Service Commission</div></div><span class="badge bb">Exams</span></div>
              <div class="ni"><div class="ic">M</div><div class="inf"><div class="t">Ministry of Education - Teacher Recruitment</div><div class="m">Ministry of Education</div></div><span class="badge bg">Vacancies</span></div>
              <div class="ni"><div class="ic">R</div><div class="inf"><div class="t">Road Division - Highway Construction Tender</div><div class="m">Road Division Office</div></div><span class="badge bb">Tenders</span></div>
            </div>
            <div>
              <div class="st">Activity log</div>
              <div class="ai"><div class="dot"></div><div>Viewed Section Officer Exam<br><span style="color:#aaa;font-size:11px">Jun 2, 02:00 PM</span></div></div>
              <div class="ai"><div class="dot"></div><div>Saved Teacher Recruitment<br><span style="color:#aaa;font-size:11px">Jun 1, 10:15 PM</span></div></div>
              <div class="ai"><div class="dot"></div><div>Searched tender kathmandu<br><span style="color:#aaa;font-size:11px">Jun 1, 08:05 PM</span></div></div>
            </div>
          </div>
        </div>
      </div>
    `),
  },
  {
    name: 'wf_notices',
    html: wireframeHTML('Notices', `
      <div class="wf-header">
        <span class="logo">SuchanaAI</span>
        <nav><span>Product</span><span>Notices</span><span>Documents</span><span>Pricing</span><span>About</span></nav>
        <div class="actions"><span class="btn btn-o">Contact</span><span style="color:#aaa">EN</span><span class="btn-f">Sign in</span></div>
      </div>
      <div class="content" style="max-width:1100px;margin:0 auto;padding:32px">
        <h1 style="margin-bottom:4px">Government notices.</h1>
        <p style="font-size:13px;color:#888;margin-bottom:20px">1,255 notices from government sources across Nepal</p>
        <div class="sb">
          <input placeholder="Search title or content..." style="flex:2">
          <button class="btn-d">Search</button>
          <button class="btn-o2">Filters</button>
        </div>
        <table>
          <thead><tr><th>Title</th><th>Category</th><th>Source</th><th>Published</th><th>Summary</th></tr></thead>
          <tbody>
            <tr><td style="font-weight:600">Section Officer Exam 2082</td><td><span class="badge bb">Exams</span></td><td>Nepal PSC</td><td>Aug 25</td><td style="color:#888;font-size:12px">Applications invited for Section Officer...</td></tr>
            <tr><td style="font-weight:600">Teacher Recruitment Drive</td><td><span class="badge bg">Vacancies</span></td><td>Ministry of Education</td><td>Aug 24</td><td style="color:#888;font-size:12px">2,500 teacher positions across 7 provinces...</td></tr>
            <tr><td style="font-weight:600">Highway Construction Tender</td><td><span class="badge bb">Tenders</span></td><td>Road Division</td><td>Aug 22</td><td style="color:#888;font-size:12px">Sealed bids for 45km highway...</td></tr>
            <tr><td style="font-weight:600">Monetary Policy Guidelines</td><td><span class="badge br">Policy</span></td><td>Nepal Rastra Bank</td><td>Aug 20</td><td style="color:#888;font-size:12px">Updated policy for fiscal year 2082/83...</td></tr>
          </tbody>
        </table>
      </div>
    `),
  },
  {
    name: 'wf_admin_dashboard',
    html: wireframeHTML('Admin Dashboard', `
      <div class="wf-header">
        <span class="logo">SuchanaAI</span>
        <nav><span>Product</span><span>Notices</span><span>Documents</span><span>Pricing</span><span>About</span></nav>
        <div class="actions"><span class="btn btn-o">Contact</span><span style="color:#aaa">EN</span><span class="btn-f">Dashboard</span></div>
      </div>
      <div class="wf-body">
        <div class="sidebar">
          <div style="padding:12px 20px;font-weight:700">Admin panel</div>
          <div class="gl">Overview</div><div class="ni a">Dashboard</div>
          <div class="gl">Content</div><div class="ni">Notices</div><div class="ni">Categories</div>
          <div class="gl">Automation</div><div class="ni">Web scraping</div><div class="ni">Alert channels</div><div class="ni">AI & Models</div>
          <div class="gl">Administration</div><div class="ni">Users</div><div class="ni">Settings</div><div class="ni">System</div>
        </div>
        <div class="content">
          <p style="font-size:12px;color:#888;margin-bottom:4px">Saturday, August 29</p>
          <h1>Admin dashboard.</h1>
          <div style="display:flex;gap:16px;margin:12px 0;font-size:12px;color:#555;align-items:center">
            <span>System status</span>
            <span style="display:flex;align-items:center;gap:4px"><span style="width:8px;height:8px;border-radius:50%;background:#1e8e3e"></span> API</span>
            <span style="display:flex;align-items:center;gap:4px"><span style="width:8px;height:8px;border-radius:50%;background:#d93025"></span> Scraper</span>
            <span style="display:flex;align-items:center;gap:4px"><span style="width:8px;height:8px;border-radius:50%;background:#1e8e3e"></span> Storage</span>
          </div>
          <div class="stat-grid">
            <div class="sc"><div class="l">Total notices</div><div class="v">1,255</div><div class="s">+3 today</div></div>
            <div class="sc"><div class="l">Active users</div><div class="v">4</div><div class="s">+1 this week</div></div>
            <div class="sc"><div class="l">Documents</div><div class="v">6</div><div class="s">Stable</div></div>
            <div class="sc"><div class="l">Active sources</div><div class="v">41</div><div class="s">1 error</div></div>
          </div>
          <div class="tc">
            <div style="background:white;border:1px solid #e5e5e5;border-radius:12px;padding:20px">
              <div class="st">Live system log</div>
              <div style="font-size:12px;color:#555;padding:6px 0;border-bottom:1px solid #f0f0f0">08:12 - Nepal Gazette scraping done (12 items)</div>
              <div style="font-size:12px;color:#555;padding:6px 0;border-bottom:1px solid #f0f0f0">08:00 - Procurement Portal scraping done (8 items)</div>
              <div style="font-size:12px;color:#d93025;padding:6px 0;border-bottom:1px solid #f0f0f0">07:45 - MoE Portal: timeout (retry 2/3)</div>
              <div style="font-size:12px;color:#888;padding:6px 0">06:00 - Daily scraping cycle started</div>
            </div>
            <div style="background:white;border:1px solid #e5e5e5;border-radius:12px;padding:20px">
              <div class="st">Scraping sources</div>
              <div class="ni"><div class="inf"><div class="t">Nepal Gazette Online</div></div><span style="font-size:12px;color:#888">1,245</span></div>
              <div class="ni"><div class="inf"><div class="t">Public Procurement Portal</div></div><span style="font-size:12px;color:#888">3,420</span></div>
              <div class="ni"><div class="inf"><div class="t">PSC Official Website</div></div><span style="font-size:12px;color:#888">890</span></div>
            </div>
          </div>
        </div>
      </div>
    `),
  },
  {
    name: 'wf_admin_notices',
    html: wireframeHTML('Admin Notices', `
      <div class="wf-header">
        <span class="logo">SuchanaAI</span>
        <nav><span>Product</span><span>Notices</span><span>Documents</span><span>Pricing</span><span>About</span></nav>
        <div class="actions"><span class="btn btn-o">Contact</span><span style="color:#aaa">EN</span><span class="btn-f">Dashboard</span></div>
      </div>
      <div class="wf-body">
        <div class="sidebar">
          <div style="padding:12px 20px;font-weight:700">Admin panel</div>
          <div class="gl">Overview</div><div class="ni">Dashboard</div>
          <div class="gl">Content</div><div class="ni a">Notices</div><div class="ni">Categories</div>
          <div class="gl">Automation</div><div class="ni">Web scraping</div><div class="ni">Alert channels</div>
          <div class="gl">Administration</div><div class="ni">Users</div><div class="ni">Settings</div>
        </div>
        <div class="content">
          <h1>Notice management.</h1>
          <p style="font-size:13px;color:#888;margin-bottom:16px">1,253 scraped notices & news</p>
          <div class="sb">
            <input placeholder="Search title or content..." style="flex:2">
            <button class="btn-o2">Filters</button>
            <button class="btn-d">Fix extractions</button>
          </div>
          <table>
            <thead><tr><th>Title</th><th>Category</th><th>Source</th><th>Published</th><th>Actions</th></tr></thead>
            <tbody>
              <tr><td style="font-weight:600">Section Officer Exam 2082</td><td><span class="badge bb">Exams</span></td><td>National Vigilance Center</td><td>8/29/2026</td><td style="color:#888">Edit | Delete</td></tr>
              <tr><td style="font-weight:600">B.Sc. Agriculture Admission</td><td><span class="badge bb">Exams</span></td><td>Ministry of Education</td><td>8/25/2026</td><td style="color:#888">Edit | Delete</td></tr>
              <tr><td style="font-weight:600">Foreign Minister Visit to India</td><td><span class="badge" style="background:#f5f5f5">Other</span></td><td>Ministry of Foreign Affairs</td><td>8/26/2026</td><td style="color:#888">Edit | Delete</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `),
  },
];

const browser = await puppeteer.launch({
  headless: 'new',
  ...(executablePath ? { executablePath } : {}),
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });

for (const wf of wireframes) {
  const htmlPath = join(tmpDir, `${wf.name}.html`);
  writeFileSync(htmlPath, wf.html);
  await page.goto('file://' + htmlPath, { waitUntil: 'load', timeout: 10000 });
  await new Promise(r => setTimeout(r, 500));
  const outPath = join(outDir, `${wf.name}.png`);
  await page.screenshot({ path: outPath, fullPage: true });
  console.log(`OK: ${outPath}`);
}

await browser.close();
console.log('All wireframes created');
