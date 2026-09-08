#!/usr/bin/env node
import puppeteer from 'puppeteer';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const outDir = 'Chapter4&5/wireframes';
const tmpDir = '/tmp/wf_html';
mkdirSync(outDir, { recursive: true });
mkdirSync(tmpDir, { recursive: true });

const sysChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
import { existsSync } from 'fs';
const executablePath = existsSync(sysChrome) ? sysChrome : undefined;

// Common wireframe styles
const S = `
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family: Arial, Helvetica, sans-serif; background: #fff; padding: 20px; }
.w { border: 2px solid #333; max-width: 800px; margin: 0 auto; background: #fff; }
.h { border-bottom: 2px solid #333; padding: 10px 16px; display: flex; align-items: center; justify-content: space-between; }
.h .logo { font-weight: bold; font-size: 14px; border: 1px solid #999; padding: 3px 10px; }
.h nav { display: flex; gap: 18px; font-size: 11px; color: #666; }
.h nav span { border-bottom: 1px solid transparent; }
.h .btn { border: 1.5px solid #333; padding: 4px 14px; font-size: 10px; border-radius: 3px; }
.h .btnf { background: #333; color: #fff; border: none; padding: 4px 14px; font-size: 10px; border-radius: 3px; }
.b { padding: 16px; }
.line { height: 2px; background: #bbb; margin: 4px 0; border-radius: 1px; }
.line.l { width: 80%; }
.line.m { width: 60%; }
.line.s { width: 40%; }
.line.xs { width: 25%; }
.box { border: 1.5px solid #999; background: #f5f5f5; display: flex; align-items: center; justify-content: center; position: relative; }
.box::before, .box::after { content: ''; position: absolute; background: #ccc; }
.box.x::before { width: 70%; height: 1.5px; transform: rotate(45deg); }
.box.x::after { width: 70%; height: 1.5px; transform: rotate(-45deg); }
.label { font-size: 9px; color: #999; text-transform: uppercase; letter-spacing: 0.5px; }
.title { font-size: 18px; font-weight: bold; color: #333; margin-bottom: 6px; }
.subtitle { font-size: 10px; color: #999; margin-bottom: 12px; }
.row { display: flex; gap: 12px; }
.col { flex: 1; }
.card { border: 1.5px solid #bbb; border-radius: 4px; padding: 10px; margin-bottom: 10px; }
.nav-item { padding: 6px 12px; font-size: 10px; color: #666; border-left: 2px solid transparent; }
.nav-item.a { border-left: 2px solid #333; color: #333; font-weight: bold; background: #f0f0f0; }
.sep { border-top: 1px solid #ddd; margin: 6px 0; }
.badge { display: inline-block; border: 1px solid #999; border-radius: 8px; padding: 1px 6px; font-size: 8px; }
.btn-dark { background: #333; color: #fff; border: none; padding: 6px 14px; font-size: 10px; border-radius: 10px; }
.btn-light { background: #fff; color: #333; border: 1.5px solid #999; padding: 6px 14px; font-size: 10px; border-radius: 10px; }
.sb { border: 1.5px solid #999; padding: 6px 10px; font-size: 10px; border-radius: 12px; flex: 1; }
table { width: 100%; border-collapse: collapse; font-size: 10px; }
th { border-bottom: 2px solid #999; padding: 6px 8px; text-align: left; font-size: 9px; text-transform: uppercase; color: #666; }
td { border-bottom: 1px solid #ddd; padding: 6px 8px; }
.sidebar { width: 160px; border-right: 1.5px solid #bbb; padding: 10px 0; background: #fafafa; flex-shrink: 0; }
.sidebar .gl { font-size: 8px; text-transform: uppercase; letter-spacing: 1px; color: #999; padding: 8px 12px 3px; font-weight: bold; }
.content { flex: 1; padding: 16px; }
.wf-body { display: flex; min-height: 350px; }
.split { display: flex; min-height: 350px; }
.split-l { flex: 1; padding: 40px 30px; display: flex; flex-direction: column; justify-content: center; }
.split-r { flex: 1; border-left: 2px solid #333; background: #e8e8e8; display: flex; align-items: center; justify-content: center; padding: 30px; }
.form-row { display: flex; gap: 12px; margin-bottom: 8px; }
.form-field { flex: 1; }
.form-field label { font-size: 9px; color: #666; display: block; margin-bottom: 3px; }
.form-field .inp { border: 1.5px solid #999; border-radius: 3px; height: 24px; width: 100%; }
.alert-bar { border: 1.5px solid #333; border-radius: 4px; padding: 8px 12px; display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; font-size: 10px; }
`;

function wf(title, body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${S}</style></head><body>
<div class="w">
${body}
</div></body></html>`;
}

const pages = [
  // 1. LOGIN PAGE
  { name: 'wf_01_login', html: wf('Login', `
    <div class="h">
      <div class="logo">LOGO</div>
      <nav><span>Home</span><span>Notices</span><span>Documents</span><span>Pricing</span><span>About</span></nav>
      <div><span class="btn">Contact</span> <span class="btnf">Sign in</span></div>
    </div>
    <div class="split">
      <div class="split-l">
        <div style="margin-bottom:30px"><div class="line xs"></div></div>
        <div class="title" style="font-size:22px;margin-bottom:4px">Brand Name</div>
        <div style="font-size:24px;font-weight:bold;margin-bottom:8px">Welcome back.</div>
        <div class="line l" style="margin-bottom:4px"></div>
        <div class="line m" style="margin-bottom:20px"></div>
        <div class="box" style="height:32px;border-radius:16px;margin-bottom:12px"><span style="font-size:10px;color:#999">[ Google Sign-In Button ]</span></div>
        <div class="line s" style="margin:0 auto;margin-top:16px"></div>
        <div class="line xs" style="margin:4px auto"></div>
      </div>
      <div class="split-r">
        <div style="background:#fff;border:1.5px solid #bbb;border-radius:6px;padding:20px;max-width:300px">
          <div class="line l" style="margin-bottom:6px"></div>
          <div class="line m" style="margin-bottom:6px"></div>
          <div class="line s" style="margin-bottom:12px"></div>
          <div class="line xs"></div>
        </div>
      </div>
    </div>
  `)},

  // 2. HOMEPAGE
  { name: 'wf_02_homepage', html: wf('Homepage', `
    <div class="h">
      <div class="logo">LOGO</div>
      <nav><span>Home</span><span>Notices</span><span>Documents</span><span>Pricing</span><span>About</span></nav>
      <div><span class="btn">Contact</span> <span class="btnf">Sign in</span></div>
    </div>
    <div class="b">
      <div style="border:1.5px solid #bbb;border-radius:4px;padding:24px;margin-bottom:16px">
        <div style="font-size:20px;font-weight:bold;margin-bottom:6px">Every public notice.<br>One place.</div>
        <div class="line l" style="margin-bottom:4px"></div>
        <div class="line m" style="margin-bottom:12px"></div>
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <div class="sb"></div>
          <div class="btn-dark">Search</div>
        </div>
        <div style="display:flex;gap:6px">
          <div class="badge">Exams</div>
          <div class="badge">Vacancies</div>
          <div class="badge">Tenders</div>
          <div class="badge">Policy</div>
        </div>
      </div>
      <div class="row" style="margin-bottom:16px">
        <div class="card" style="flex:1;text-align:center"><div class="label">Documents</div><div style="font-size:18px;font-weight:bold">41+</div></div>
        <div class="card" style="flex:1;text-align:center"><div class="label">Notices indexed</div><div style="font-size:18px;font-weight:bold">1,228</div></div>
        <div class="card" style="flex:1;text-align:center"><div class="label">Monitoring</div><div style="font-size:18px;font-weight:bold">24/7</div></div>
        <div class="card" style="flex:1;text-align:center"><div class="label">Categories</div><div style="font-size:18px;font-weight:bold">7</div></div>
      </div>
      <div class="title" style="font-size:14px">Latest from the portals.</div>
      <div class="row">
        <div class="card" style="flex:1"><div class="box x" style="height:60px;margin-bottom:6px"></div><div class="line m"></div><div class="line xs"></div></div>
        <div class="card" style="flex:1"><div class="box x" style="height:60px;margin-bottom:6px"></div><div class="line m"></div><div class="line xs"></div></div>
        <div class="card" style="flex:1"><div class="box x" style="height:60px;margin-bottom:6px"></div><div class="line m"></div><div class="line xs"></div></div>
      </div>
      <div class="title" style="font-size:14px;margin-top:16px">Features</div>
      <div class="row">
        <div class="card" style="flex:1"><div class="box x" style="height:40px;margin-bottom:6px"></div><div class="line m"></div><div class="line xs"></div></div>
        <div class="card" style="flex:1"><div class="box x" style="height:40px;margin-bottom:6px"></div><div class="line m"></div><div class="line xs"></div></div>
        <div class="card" style="flex:1"><div class="box x" style="height:40px;margin-bottom:6px"></div><div class="line m"></div><div class="line xs"></div></div>
        <div class="card" style="flex:1"><div class="box x" style="height:40px;margin-bottom:6px"></div><div class="line m"></div><div class="line xs"></div></div>
      </div>
    </div>
  `)},

  // 3. NOTICES LISTING
  { name: 'wf_03_notices', html: wf('Notices Listing', `
    <div class="h">
      <div class="logo">LOGO</div>
      <nav><span>Home</span><span>Notices</span><span>Documents</span><span>Pricing</span><span>About</span></nav>
      <div><span class="btn">Contact</span> <span class="btnf">Sign in</span></div>
    </div>
    <div class="b">
      <div class="title">Government notices.</div>
      <div class="line m" style="margin-bottom:12px"></div>
      <div style="display:flex;gap:8px;margin-bottom:12px">
        <div class="sb"></div>
        <div class="btn-dark">Search</div>
        <div class="btn-light">Filters</div>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:12px">
        <div class="badge" style="background:#333;color:#fff">All</div>
        <div class="badge">Exams</div>
        <div class="badge">Vacancies</div>
        <div class="badge">Tenders</div>
        <div class="badge">Policy</div>
        <div class="badge">Announcements</div>
      </div>
      <table>
        <thead><tr><th>Title</th><th>Category</th><th>Source</th><th>Published</th><th>Summary</th></tr></thead>
        <tbody>
          <tr><td><div class="line m"></div></td><td><div class="badge">Exams</div></td><td><div class="line xs"></div></td><td><div class="line xs"></div></td><td><div class="line s"></div></td></tr>
          <tr><td><div class="line m"></div></td><td><div class="badge">Vacancies</div></td><td><div class="line xs"></div></td><td><div class="line xs"></div></td><td><div class="line s"></div></td></tr>
          <tr><td><div class="line m"></div></td><td><div class="badge">Tenders</div></td><td><div class="line xs"></div></td><td><div class="line xs"></div></td><td><div class="line s"></div></td></tr>
          <tr><td><div class="line m"></div></td><td><div class="badge">Policy</div></td><td><div class="line xs"></div></td><td><div class="line xs"></div></td><td><div class="line s"></div></td></tr>
          <tr><td><div class="line m"></div></td><td><div class="badge">Other</div></td><td><div class="line xs"></div></td><td><div class="line xs"></div></td><td><div class="line s"></div></td></tr>
        </tbody>
      </table>
    </div>
  `)},

  // 4. USER DASHBOARD
  { name: 'wf_04_dashboard', html: wf('User Dashboard', `
    <div class="h">
      <div class="logo">LOGO</div>
      <nav><span>Home</span><span>Notices</span><span>Documents</span><span>Pricing</span><span>About</span></nav>
      <div><span class="btn">Contact</span> <span class="btnf">Dashboard</span></div>
    </div>
    <div class="wf-body">
      <div class="sidebar">
        <div class="gl">Overview</div>
        <div class="nav-item a">Dashboard</div>
        <div class="gl">My content</div>
        <div class="nav-item">Saved notices</div>
        <div class="nav-item">My alerts</div>
        <div class="nav-item">Document search</div>
        <div class="gl">Account</div>
        <div class="nav-item">Plan & billing</div>
        <div class="nav-item">Activity</div>
        <div class="nav-item">Settings</div>
      </div>
      <div class="content">
        <div class="line xs" style="margin-bottom:4px"></div>
        <div class="title">Good morning, User.</div>
        <div class="row" style="margin-bottom:12px">
          <div class="card" style="flex:1"><div class="label">Notices viewed</div><div style="font-size:18px;font-weight:bold">47</div><div class="line xs"></div></div>
          <div class="card" style="flex:1"><div class="label">Saved</div><div style="font-size:18px;font-weight:bold">8</div><div class="line xs"></div></div>
          <div class="card" style="flex:1"><div class="label">Active alerts</div><div style="font-size:18px;font-weight:bold">2</div><div class="line xs"></div></div>
          <div class="card" style="flex:1"><div class="label">Member since</div><div style="font-size:16px;font-weight:bold">Aug 2026</div></div>
        </div>
        <div class="alert-bar">
          <div><span style="font-weight:bold">Urgent notices</span> <div class="badge" style="border-color:#fff;color:#fff">2 active</div></div>
          <div class="btn-dark" style="font-size:8px;padding:4px 10px">Browse notices</div>
        </div>
        <div class="row">
          <div style="flex:2">
            <div style="font-size:11px;font-weight:bold;margin-bottom:8px">Recommended for you</div>
            <div class="card"><div class="row"><div class="box" style="width:28px;height:28px;flex-shrink:0;border-radius:4px"></div><div style="flex:1"><div class="line m"></div><div class="line xs"></div></div><div class="badge">Exams</div></div></div>
            <div class="card"><div class="row"><div class="box" style="width:28px;height:28px;flex-shrink:0;border-radius:4px"></div><div style="flex:1"><div class="line m"></div><div class="line xs"></div></div><div class="badge">Vacancies</div></div></div>
            <div class="card"><div class="row"><div class="box" style="width:28px;height:28px;flex-shrink:0;border-radius:4px"></div><div style="flex:1"><div class="line m"></div><div class="line xs"></div></div><div class="badge">Tenders</div></div></div>
          </div>
          <div style="flex:1">
            <div style="font-size:11px;font-weight:bold;margin-bottom:8px">Activity log</div>
            <div class="card">
              <div style="margin-bottom:6px"><div class="line m"></div><div class="line xs"></div></div>
              <div style="margin-bottom:6px"><div class="line m"></div><div class="line xs"></div></div>
              <div><div class="line m"></div><div class="line xs"></div></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `)},

  // 5. SAVED NOTICES
  { name: 'wf_05_saved', html: wf('Saved Notices', `
    <div class="h">
      <div class="logo">LOGO</div>
      <nav><span>Home</span><span>Notices</span><span>Documents</span><span>Pricing</span><span>About</span></nav>
      <div><span class="btn">Contact</span> <span class="btnf">Dashboard</span></div>
    </div>
    <div class="wf-body">
      <div class="sidebar">
        <div class="gl">Overview</div><div class="nav-item">Dashboard</div>
        <div class="gl">My content</div><div class="nav-item a">Saved notices</div><div class="nav-item">My alerts</div><div class="nav-item">Document search</div>
        <div class="gl">Account</div><div class="nav-item">Plan & billing</div><div class="nav-item">Activity</div><div class="nav-item">Settings</div>
      </div>
      <div class="content">
        <div class="title">Saved notices.</div>
        <div class="line xs" style="margin-bottom:16px"></div>
        <div class="card"><div class="row"><div class="box" style="width:28px;height:28px;flex-shrink:0;border-radius:4px"></div><div style="flex:1"><div class="line m"></div><div class="line l" style="margin-top:4px"></div><div class="row" style="margin-top:4px"><div class="badge">Exams</div><div class="line xs" style="width:80px;margin-left:8px"></div></div></div><div style="font-size:14px;color:#ccc">[X]</div></div></div>
        <div class="card"><div class="row"><div class="box" style="width:28px;height:28px;flex-shrink:0;border-radius:4px"></div><div style="flex:1"><div class="line m"></div><div class="line l" style="margin-top:4px"></div><div class="row" style="margin-top:4px"><div class="badge">Vacancies</div><div class="line xs" style="width:80px;margin-left:8px"></div></div></div><div style="font-size:14px;color:#ccc">[X]</div></div></div>
        <div class="card"><div class="row"><div class="box" style="width:28px;height:28px;flex-shrink:0;border-radius:4px"></div><div style="flex:1"><div class="line m"></div><div class="line l" style="margin-top:4px"></div><div class="row" style="margin-top:4px"><div class="badge">Tenders</div><div class="line xs" style="width:80px;margin-left:8px"></div></div></div><div style="font-size:14px;color:#ccc">[X]</div></div></div>
        <div class="card"><div class="row"><div class="box" style="width:28px;height:28px;flex-shrink:0;border-radius:4px"></div><div style="flex:1"><div class="line m"></div><div class="line l" style="margin-top:4px"></div><div class="row" style="margin-top:4px"><div class="badge">Policy</div><div class="line xs" style="width:80px;margin-left:8px"></div></div></div><div style="font-size:14px;color:#ccc">[X]</div></div></div>
      </div>
    </div>
  `)},

  // 6. MY ALERTS
  { name: 'wf_06_alerts', html: wf('My Alerts', `
    <div class="h">
      <div class="logo">LOGO</div>
      <nav><span>Home</span><span>Notices</span><span>Documents</span><span>Pricing</span><span>About</span></nav>
      <div><span class="btn">Contact</span> <span class="btnf">Dashboard</span></div>
    </div>
    <div class="wf-body">
      <div class="sidebar">
        <div class="gl">Overview</div><div class="nav-item">Dashboard</div>
        <div class="gl">My content</div><div class="nav-item">Saved notices</div><div class="nav-item a">My alerts</div><div class="nav-item">Document search</div>
        <div class="gl">Account</div><div class="nav-item">Plan & billing</div><div class="nav-item">Activity</div><div class="nav-item">Settings</div>
      </div>
      <div class="content">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <div class="title" style="margin-bottom:0">My alerts.</div>
          <div class="btn-dark">+ New alert</div>
        </div>
        <div class="card" style="margin-bottom:12px">
          <div style="font-size:11px;font-weight:bold;margin-bottom:6px">WhatsApp alerts</div>
          <div class="line l" style="margin-bottom:6px"></div>
          <div style="display:flex;gap:8px"><div class="sb"></div><div class="btn-light" style="font-size:9px">Send code</div></div>
        </div>
        <div class="card" style="margin-bottom:8px"><div class="row"><div class="box" style="width:24px;height:24px;flex-shrink:0;border-radius:50%"></div><div class="box" style="width:24px;height:24px;flex-shrink:0;border-radius:50%"></div><div style="flex:1"><div class="line m"></div><div style="display:flex;gap:4px;margin-top:4px"><div class="badge">Notice</div><div class="badge">Job</div></div></div><div style="font-size:9px;color:#999">0 matches</div></div></div>
        <div class="card"><div class="row"><div class="box" style="width:24px;height:24px;flex-shrink:0;border-radius:50%"></div><div class="box" style="width:24px;height:24px;flex-shrink:0;border-radius:50%"></div><div style="flex:1"><div class="line m"></div><div style="display:flex;gap:4px;margin-top:4px"><div class="badge">Notice</div></div></div><div style="font-size:9px;color:#999">13 matches</div></div></div>
      </div>
    </div>
  `)},

  // 7. USER SETTINGS
  { name: 'wf_07_settings', html: wf('User Settings', `
    <div class="h">
      <div class="logo">LOGO</div>
      <nav><span>Home</span><span>Notices</span><span>Documents</span><span>Pricing</span><span>About</span></nav>
      <div><span class="btn">Contact</span> <span class="btnf">Dashboard</span></div>
    </div>
    <div class="wf-body">
      <div class="sidebar">
        <div class="gl">Overview</div><div class="nav-item">Dashboard</div>
        <div class="gl">My content</div><div class="nav-item">Saved notices</div><div class="nav-item">My alerts</div><div class="nav-item">Document search</div>
        <div class="gl">Account</div><div class="nav-item">Plan & billing</div><div class="nav-item">Activity</div><div class="nav-item a">Settings</div>
      </div>
      <div class="content">
        <div class="title">Settings.</div>
        <div class="line m" style="margin-bottom:16px"></div>
        <div class="card" style="margin-bottom:12px">
          <div style="font-size:11px;font-weight:bold;margin-bottom:8px">Profile</div>
          <div class="line xs" style="margin-bottom:8px"></div>
          <div class="row">
            <div style="flex:1"><div class="label">Username</div><div class="line s"></div></div>
            <div style="flex:1"><div class="label">Email</div><div class="line s"></div></div>
          </div>
          <div class="row" style="margin-top:8px">
            <div style="flex:1"><div class="label">Role</div><div class="line xs"></div></div>
            <div style="flex:1"><div class="label">Member since</div><div class="line xs"></div></div>
          </div>
        </div>
        <div class="card">
          <div style="font-size:11px;font-weight:bold;margin-bottom:8px">Alert preferences</div>
          <div class="line l" style="margin-bottom:10px"></div>
          <div class="card" style="margin-bottom:6px"><div class="row"><div class="box" style="width:24px;height:24px;flex-shrink:0;border-radius:4px"></div><div style="flex:1"><div class="line m"></div><div class="line xs"></div></div><div class="badge">Enabled</div></div></div>
          <div class="card"><div class="row"><div class="box" style="width:24px;height:24px;flex-shrink:0;border-radius:4px"></div><div style="flex:1"><div class="line m"></div><div class="line xs"></div></div><div class="badge">Verify</div></div></div>
        </div>
      </div>
    </div>
  `)},

  // 8. ADMIN DASHBOARD
  { name: 'wf_08_admin', html: wf('Admin Dashboard', `
    <div class="h">
      <div class="logo">LOGO</div>
      <nav><span>Home</span><span>Notices</span><span>Documents</span><span>Pricing</span><span>About</span></nav>
      <div><span class="btn">Contact</span> <span class="btnf">Dashboard</span></div>
    </div>
    <div class="wf-body">
      <div class="sidebar">
        <div style="padding:6px 12px;font-size:11px;font-weight:bold">Admin panel</div>
        <div class="gl">Overview</div><div class="nav-item a">Dashboard</div>
        <div class="gl">Content</div><div class="nav-item">Notices</div><div class="nav-item">Categories</div>
        <div class="gl">Automation</div><div class="nav-item">Web scraping</div><div class="nav-item">Alert channels</div><div class="nav-item">AI & Models</div>
        <div class="gl">Administration</div><div class="nav-item">Users</div><div class="nav-item">Plans & usage</div><div class="nav-item">Settings</div><div class="nav-item">System</div>
      </div>
      <div class="content">
        <div class="line xs" style="margin-bottom:4px"></div>
        <div class="title">Admin dashboard.</div>
        <div style="display:flex;gap:12px;font-size:9px;color:#666;margin:8px 0 12px;align-items:center">
          <span>System status</span>
          <span>[. API</span><span>. Scraper</span><span>. Storage</span><span>. Auth</span><span>. RAG</span><span>. Notifier]</span>
        </div>
        <div class="row" style="margin-bottom:12px">
          <div class="card" style="flex:1"><div class="label">Total notices</div><div style="font-size:18px;font-weight:bold">1,255</div><div class="line xs"></div></div>
          <div class="card" style="flex:1"><div class="label">Active users</div><div style="font-size:18px;font-weight:bold">4</div><div class="line xs"></div></div>
          <div class="card" style="flex:1"><div class="label">Documents</div><div style="font-size:18px;font-weight:bold">6</div><div class="line xs"></div></div>
          <div class="card" style="flex:1"><div class="label">Active sources</div><div style="font-size:18px;font-weight:bold">41</div><div class="line xs"></div></div>
        </div>
        <div class="row">
          <div style="flex:2">
            <div class="card">
              <div style="font-size:11px;font-weight:bold;margin-bottom:8px">Live system log</div>
              <div style="font-size:9px;padding:4px 0;border-bottom:1px solid #eee">08:12 - Nepal Gazette scraping done (12 items)</div>
              <div style="font-size:9px;padding:4px 0;border-bottom:1px solid #eee">08:00 - Procurement Portal scraping done (8 items)</div>
              <div style="font-size:9px;padding:4px 0;border-bottom:1px solid #eee;color:#c00">07:45 - MoE Portal: timeout</div>
              <div style="font-size:9px;padding:4px 0">06:00 - Daily scraping cycle started</div>
            </div>
          </div>
          <div style="flex:1">
            <div class="card">
              <div style="font-size:11px;font-weight:bold;margin-bottom:8px">Scraping sources</div>
              <div style="font-size:9px;padding:4px 0;border-bottom:1px solid #eee;display:flex;justify-content:space-between"><span>Nepal Gazette Online</span><span>1,245</span></div>
              <div style="font-size:9px;padding:4px 0;border-bottom:1px solid #eee;display:flex;justify-content:space-between"><span>Public Procurement</span><span>3,420</span></div>
              <div style="font-size:9px;padding:4px 0;border-bottom:1px solid #eee;display:flex;justify-content:space-between"><span>PSC Website</span><span>890</span></div>
              <div style="font-size:9px;padding:4px 0;display:flex;justify-content:space-between"><span>MoE Job Portal</span><span>456</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `)},

  // 9. ADMIN NOTICES
  { name: 'wf_09_admin_notices', html: wf('Admin - Notices', `
    <div class="h">
      <div class="logo">LOGO</div>
      <nav><span>Home</span><span>Notices</span><span>Documents</span><span>Pricing</span><span>About</span></nav>
      <div><span class="btn">Contact</span> <span class="btnf">Dashboard</span></div>
    </div>
    <div class="wf-body">
      <div class="sidebar">
        <div style="padding:6px 12px;font-size:11px;font-weight:bold">Admin panel</div>
        <div class="gl">Overview</div><div class="nav-item">Dashboard</div>
        <div class="gl">Content</div><div class="nav-item a">Notices</div><div class="nav-item">Categories</div>
        <div class="gl">Automation</div><div class="nav-item">Web scraping</div><div class="nav-item">Alert channels</div><div class="nav-item">AI & Models</div>
        <div class="gl">Administration</div><div class="nav-item">Users</div><div class="nav-item">Settings</div>
      </div>
      <div class="content">
        <div class="title">Notice management.</div>
        <div class="line xs" style="margin-bottom:12px"></div>
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <div class="sb"></div>
          <div class="btn-light">Filters</div>
          <div class="btn-dark">Re-extract all</div>
        </div>
        <table>
          <thead><tr><th>Title</th><th>Category</th><th>Source</th><th>Published</th><th>Actions</th></tr></thead>
          <tbody>
            <tr><td><div class="line m"></div></td><td><div class="badge">Other</div></td><td><div class="line xs"></div></td><td><div class="line xs"></div></td><td><div class="line xs"></div></td></tr>
            <tr><td><div class="line m"></div></td><td><div class="badge">Other</div></td><td><div class="line xs"></div></td><td><div class="line xs"></div></td><td><div class="line xs"></div></td></tr>
            <tr><td><div class="line m"></div></td><td><div class="badge">Other</div></td><td><div class="line xs"></div></td><td><div class="line xs"></div></td><td><div class="line xs"></div></td></tr>
            <tr><td><div class="line m"></div></td><td><div class="badge">Other</div></td><td><div class="line xs"></div></td><td><div class="line xs"></div></td><td><div class="line xs"></div></td></tr>
            <tr><td><div class="line m"></div></td><td><div class="badge">Other</div></td><td><div class="line xs"></div></td><td><div class="line xs"></div></td><td><div class="line xs"></div></td></tr>
          </tbody>
        </table>
      </div>
    </div>
  `)},

  // 10. ADMIN WEB SCRAPING
  { name: 'wf_10_admin_scraping', html: wf('Admin - Web Scraping', `
    <div class="h">
      <div class="logo">LOGO</div>
      <nav><span>Home</span><span>Notices</span><span>Documents</span><span>Pricing</span><span>About</span></nav>
      <div><span class="btn">Contact</span> <span class="btnf">Dashboard</span></div>
    </div>
    <div class="wf-body">
      <div class="sidebar">
        <div style="padding:6px 12px;font-size:11px;font-weight:bold">Admin panel</div>
        <div class="gl">Overview</div><div class="nav-item">Dashboard</div>
        <div class="gl">Content</div><div class="nav-item">Notices</div><div class="nav-item">Categories</div>
        <div class="gl">Automation</div><div class="nav-item a">Web scraping</div><div class="nav-item">Alert channels</div><div class="nav-item">AI & Models</div>
        <div class="gl">Administration</div><div class="nav-item">Users</div><div class="nav-item">Settings</div>
      </div>
      <div class="content">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <div class="title" style="margin-bottom:0">Web scraping.</div>
          <div class="btn-dark">+ Add source</div>
        </div>
        <div class="line l" style="margin-bottom:12px"></div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
          <div class="btn-dark">Run all sources</div>
          <div class="line xs"></div>
          <div style="margin-left:auto"><div class="label">Auto-scraping</div> <div style="display:inline-block;width:28px;height:14px;background:#333;border-radius:7px;position:relative;vertical-align:middle"><div style="width:10px;height:10px;background:#fff;border-radius:50%;position:absolute;right:2px;top:2px"></div></div></div>
        </div>
        <div class="row" style="margin-bottom:12px">
          <div class="card" style="flex:1;text-align:center"><div style="font-size:16px;font-weight:bold">41</div><div class="label">Active sources</div></div>
          <div class="card" style="flex:1;text-align:center"><div style="font-size:16px;font-weight:bold">41</div><div class="label">Total sources</div></div>
          <div class="card" style="flex:1;text-align:center"><div style="font-size:16px;font-weight:bold">1,255</div><div class="label">Scraped items</div></div>
          <div class="card" style="flex:1;text-align:center"><div style="font-size:16px;font-weight:bold">40</div><div class="label">Errors</div></div>
        </div>
        <div class="row">
          <div class="card" style="flex:1">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><div style="font-size:11px;font-weight:bold">Ministry of Foreign Affairs</div><div class="badge" style="border-color:#c00;color:#c00">Failed</div></div>
            <div class="line xs" style="margin-bottom:4px"></div>
            <div style="font-size:9px;color:#666;margin-bottom:4px">Category: Notice + News</div>
            <div style="font-size:9px;color:#666;margin-bottom:4px">Items scraped: 422</div>
            <div style="display:flex;gap:4px"><div class="btn-dark" style="font-size:8px;padding:3px 8px">Run now</div><div class="btn-light" style="font-size:8px;padding:3px 8px">Edit</div></div>
          </div>
          <div class="card" style="flex:1">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><div style="font-size:11px;font-weight:bold">Nepal Rastra Bank</div><div class="badge" style="border-color:#c00;color:#c00">Failed</div></div>
            <div class="line xs" style="margin-bottom:4px"></div>
            <div style="font-size:9px;color:#666;margin-bottom:4px">Category: Notice + News</div>
            <div style="font-size:9px;color:#666;margin-bottom:4px">Items scraped: 180</div>
            <div style="display:flex;gap:4px"><div class="btn-dark" style="font-size:8px;padding:3px 8px">Run now</div><div class="btn-light" style="font-size:8px;padding:3px 8px">Edit</div></div>
          </div>
        </div>
      </div>
    </div>
  `)},

  // 11. ADMIN USERS
  { name: 'wf_11_admin_users', html: wf('Admin - Users', `
    <div class="h">
      <div class="logo">LOGO</div>
      <nav><span>Home</span><span>Notices</span><span>Documents</span><span>Pricing</span><span>About</span></nav>
      <div><span class="btn">Contact</span> <span class="btnf">Dashboard</span></div>
    </div>
    <div class="wf-body">
      <div class="sidebar">
        <div style="padding:6px 12px;font-size:11px;font-weight:bold">Admin panel</div>
        <div class="gl">Overview</div><div class="nav-item">Dashboard</div>
        <div class="gl">Content</div><div class="nav-item">Notices</div><div class="nav-item">Categories</div>
        <div class="gl">Automation</div><div class="nav-item">Web scraping</div><div class="nav-item">Alert channels</div>
        <div class="gl">Administration</div><div class="nav-item a">Users</div><div class="nav-item">Settings</div>
      </div>
      <div class="content">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <div class="title" style="margin-bottom:0">User management.</div>
          <div class="btn-dark">+ Add user</div>
        </div>
        <div class="line xs" style="margin-bottom:12px"></div>
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <div class="sb"></div>
          <div class="btn-light" style="font-size:9px">All roles v</div>
          <div class="btn-light" style="font-size:9px">All statuses v</div>
        </div>
        <table>
          <thead><tr><th>User</th><th>Email</th><th>Role</th><th>Status</th><th>Last login</th><th>Actions</th></tr></thead>
          <tbody>
            <tr><td><div class="row" style="align-items:center"><div class="box" style="width:20px;height:20px;border-radius:50%;flex-shrink:0"></div><div class="line s"></div></div></td><td><div class="line s"></div></td><td><div class="badge">User</div></td><td><div class="badge">Active</div></td><td><div class="line xs"></div></td><td><div class="line xs"></div></td></tr>
            <tr><td><div class="row" style="align-items:center"><div class="box" style="width:20px;height:20px;border-radius:50%;flex-shrink:0"></div><div class="line s"></div></div></td><td><div class="line s"></div></td><td><div class="badge">User</div></td><td><div class="badge">Active</div></td><td><div class="line xs"></div></td><td><div class="line xs"></div></td></tr>
            <tr><td><div class="row" style="align-items:center"><div class="box" style="width:20px;height:20px;border-radius:50%;flex-shrink:0"></div><div class="line s"></div></div></td><td><div class="line s"></div></td><td><div class="badge" style="background:#333;color:#fff">Admin</div></td><td><div class="badge">Active</div></td><td><div class="line xs"></div></td><td><div class="line xs"></div></td></tr>
          </tbody>
        </table>
      </div>
    </div>
  `)},

  // 12. ADMIN ALERT CHANNELS
  { name: 'wf_12_admin_alerts', html: wf('Admin - Alert Channels', `
    <div class="h">
      <div class="logo">LOGO</div>
      <nav><span>Home</span><span>Notices</span><span>Documents</span><span>Pricing</span><span>About</span></nav>
      <div><span class="btn">Contact</span> <span class="btnf">Dashboard</span></div>
    </div>
    <div class="wf-body">
      <div class="sidebar">
        <div style="padding:6px 12px;font-size:11px;font-weight:bold">Admin panel</div>
        <div class="gl">Overview</div><div class="nav-item">Dashboard</div>
        <div class="gl">Content</div><div class="nav-item">Notices</div>
        <div class="gl">Automation</div><div class="nav-item">Web scraping</div><div class="nav-item a">Alert channels</div><div class="nav-item">AI & Models</div>
        <div class="gl">Administration</div><div class="nav-item">Users</div><div class="nav-item">Settings</div>
      </div>
      <div class="content">
        <div class="title">Alert channels.</div>
        <div class="line l" style="margin-bottom:16px"></div>
        <div class="card" style="margin-bottom:12px">
          <div class="row" style="align-items:center;margin-bottom:8px">
            <div class="box" style="width:32px;height:32px;border-radius:50%;flex-shrink:0"></div>
            <div style="flex:1"><div style="font-size:12px;font-weight:bold">WhatsApp (shared sender)</div><div class="badge" style="margin-top:2px">Connected</div></div>
            <div class="btn-light" style="font-size:9px">Disconnect</div>
          </div>
          <div class="line l"></div>
        </div>
        <div class="card">
          <div class="row" style="align-items:center;margin-bottom:8px">
            <div class="box" style="width:32px;height:32px;border-radius:50%;flex-shrink:0"></div>
            <div style="flex:1"><div style="font-size:12px;font-weight:bold">Email (SMTP)</div><div class="badge" style="margin-top:2px">Not configured</div></div>
            <div class="btn-light" style="font-size:9px">Disabled</div>
          </div>
          <div class="line l" style="margin-bottom:10px"></div>
          <div class="form-row">
            <div class="form-field"><label>SMTP host</label><div class="inp"></div></div>
            <div class="form-field"><label>Port & encryption</label><div class="inp"></div></div>
          </div>
          <div class="form-row">
            <div class="form-field"><label>Username</label><div class="inp"></div></div>
            <div class="form-field"><label>Password</label><div class="inp"></div></div>
          </div>
          <div class="form-row">
            <div class="form-field"><label>From address</label><div class="inp"></div></div>
            <div class="form-field"><label>From name</label><div class="inp"></div></div>
          </div>
          <div style="display:flex;gap:8px;margin-top:8px"><div class="btn-dark">Save</div><div class="btn-light">Send test</div></div>
        </div>
      </div>
    </div>
  `)},
];

const browser = await puppeteer.launch({
  headless: 'new',
  ...(executablePath ? { executablePath } : {}),
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});

const page = await browser.newPage();
await page.setViewport({ width: 900, height: 700, deviceScaleFactor: 2 });

for (const p of pages) {
  const htmlPath = join(tmpDir, `${p.name}.html`);
  writeFileSync(htmlPath, p.html);
  await page.goto('file://' + htmlPath, { waitUntil: 'load', timeout: 10000 });
  await new Promise(r => setTimeout(r, 300));
  const outPath = join(outDir, `${p.name}.png`);
  await page.screenshot({ path: outPath, fullPage: true });
  console.log(`OK: ${p.name}.png`);
}

await browser.close();
console.log('All wireframes created');
