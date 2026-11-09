#!/usr/bin/env node
// UX mechanics stress walk: runs the automatable checks of checklist.md against a live app.
// Usage:
//   node stress-walk.mjs <config.json> [--out <dir>]
//   node stress-walk.mjs --self-test            (runs against built-in good and bad fixture apps)
// Needs the `playwright` package where it is run (npm i -D playwright@1.64.1) and Chrome or
// Playwright's Chromium. Exit code 1 when any check FAILs.
//
// Config (JSON):
// {
//   "baseUrl": "http://localhost:8788",
//   "home": { "path": "/", "ready": "#home" },              // selector visible only on home
//   "screens": [ { "name": "Alert", "steps": [{ "click": ".row" }], "ready": "#detail" } ],
//   "backSelector": "[aria-label=Back]",                     // on-screen back control, if the app has one
//   "lists": [ { "name": "Near you", "path": "/", "api": "/api/items", "empty": "#empty", "content": ".row" } ],
//   "sends": [ { "name": "Confirm", "steps": [{ "click": ".row" }], "button": "#confirm",
//                "api": "/api/vote", "method": "POST", "form": "#confirm" } ],
//   "layerSelector": "dialog[open], [aria-modal=true]:not([hidden])",
//   "throttleMs": 2500,
//   "geolocation": { "latitude": 47.61, "longitude": -122.33 },   // grants location to the page
//   "setup": [{ "click": "#welcomeOk", "ifVisible": true }],         // run after each page load
//   "contextHeaders": { "CF-Connecting-IP": "10.{r}.{r}.{r}" }       // local dev only: {r} = random 1-254 per browser
// }
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const req = createRequire(path.join(process.cwd(), 'noop.js'));
let chromium;
try { ({ chromium } = req('playwright')); } catch {
  try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch {
    console.error('Install Playwright where you run this: npm i -D playwright@1.64.1'); process.exit(2);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const DEFAULT_LAYERS = 'dialog[open], [aria-modal="true"]:not([hidden]), [role="dialog"]:not([hidden])';

async function launch() {
  try { return await chromium.launch({ channel: 'chrome' }); } catch { return chromium.launch(); }
}

async function visible(page, sel) {
  if (!sel) return false;
  return page.locator(sel).first().isVisible().catch(() => false);
}

async function runSteps(page, steps = [], layers, results, label) {
  for (const s of steps) {
    if (s.click && s.ifVisible && !(await visible(page, s.click))) continue;
    if (s.click) {
      try {
        // Wait for the target to exist and settle first, so slow data is not reported as a broken control.
        await page.locator(s.click).first().waitFor({ state: 'visible', timeout: 10000 });
        await page.locator(s.click).first().click({ timeout: 4000 });
      }
      catch (e) {
        const msg = String(e);
        const why = /intercepts pointer events/.test(msg) ? 'covered by another layer'
          : /waitFor/.test(msg) ? 'never appeared within 10 s'
          : /detached|not attached/.test(msg) ? 're-rendered while being clicked (unstable element)'
          : 'not clickable: ' + msg.split(/\r?\n/)[0].slice(0, 120);
        results.push({ id: 'N0', check: 'Every step can be done', target: label, status: 'FAIL', detail: `"${s.click}" ${why}`, shot: await shot(page, outDir, `N0-${label}`) });
        return false;
      }
    }
    if (s.fill) await page.locator(s.fill).first().fill(s.value ?? 'test');
    if (s.wait) await page.locator(s.wait).first().waitFor({ timeout: 8000 });
    await sleep(s.pause ?? 350);
    const open = await page.locator(layers).evaluateAll(els => els.filter(e => {
      const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
    }).length);
    if (open > 1) results.push({ id: 'L1', check: 'At most one layer over a screen', target: label, status: 'FAIL', detail: `${open} layers open after ${JSON.stringify(s)}` });
  }
  return true;
}

async function setup(page, cfg) {
  for (const s of cfg.setup ?? []) {
    if (s.click) { const l = page.locator(s.click).first(); await l.waitFor({ timeout: s.ifVisible ? 4000 : 15000 }).catch(() => {}); if (await l.isVisible().catch(() => false)) await l.click().catch(() => {}); }
    await sleep(s.pause ?? 400);
  }
}

async function freshPage(browser, cfg) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true,
    ...(cfg.geolocation ? { geolocation: cfg.geolocation, permissions: ['geolocation'] } : {}) });
  if (cfg.contextHeaders) {
    const h = {};
    for (const [k, v] of Object.entries(cfg.contextHeaders)) h[k] = String(v).replace(/\{r\}/g, () => String(1 + Math.floor(Math.random() * 254)));
    // Same-origin only: a custom header on third-party calls (bot checks, fonts) fails their CORS check.
    const origin = new URL(cfg.baseUrl).origin;
    await ctx.route(u => u.origin === origin, r => r.continue({ headers: { ...r.request().headers(), ...h } }));
  }
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__cls = 0;
    try {
      new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; })
        .observe({ type: 'layout-shift', buffered: true });
    } catch {}
  });
  return { ctx, page };
}

async function shot(page, out, name) {
  if (!out) return '';
  const f = path.join(out, name.replace(/[^a-z0-9-]+/gi, '_') + '.png');
  await page.screenshot({ path: f }).catch(() => {});
  return f;
}

let outDir = null;
export async function walk(cfg, out) {
  outDir = out;
  const results = [];
  const layers = cfg.layerSelector || DEFAULT_LAYERS;
  const base = cfg.baseUrl.replace(/\/$/, '');
  const browser = await launch();
  try {
    // N1/N2: back from every screen reaches home within 2 presses (system back), and the on-screen back works.
    for (const sc of cfg.screens ?? []) {
      for (const mode of ['system', cfg.backSelector ? 'on-screen' : null].filter(Boolean)) {
        const { ctx, page } = await freshPage(browser, cfg);
        await page.goto(base + cfg.home.path); await setup(page, cfg); await page.locator(cfg.home.ready).first().waitFor({ timeout: 20000 });
        if (!(await runSteps(page, sc.steps, layers, results, sc.name))) { await ctx.close(); continue; }
        if (sc.ready && !(await visible(page, sc.ready))) {
          results.push({ id: 'N0', check: 'Screen reachable', target: sc.name, status: 'FAIL', detail: `"${sc.ready}" not visible after steps`, shot: await shot(page, out, `N0-${sc.name}`) });
          await ctx.close(); continue;
        }
        let presses = 0;
        while (presses < 5 && !(await visible(page, cfg.home.ready))) {
          presses++;
          if (mode === 'system') await page.goBack({ timeout: 3000 }).catch(() => {});
          else if (await visible(page, cfg.backSelector)) {
            const ok = await page.locator(cfg.backSelector).first().click({ timeout: 3000 }).then(() => true, () => false);
            if (!ok) { results.push({ id: 'L2', check: 'On-screen back is never covered', target: sc.name, status: 'FAIL', detail: 'back control covered by a layer', shot: await shot(page, out, `L2-${sc.name}`) }); break; }
          }
          else await page.goBack({ timeout: 3000 }).catch(() => {});
          await sleep(400);
        }
        const home = await visible(page, cfg.home.ready);
        const ok = home && presses <= 2;
        results.push({ id: 'N2', check: `Back (${mode}) reaches home within 2 presses`, target: sc.name, status: ok ? 'PASS' : 'FAIL',
          detail: home ? `${presses} press(es)` : `not home after ${presses} presses (left app or stuck)`, shot: ok ? '' : await shot(page, out, `N2-${mode}-${sc.name}`) });
        await ctx.close();
      }
    }

    // D1/D3: no empty state before the first answer; no layout shift when data lands.
    for (const li of cfg.lists ?? []) {
      const { ctx, page } = await freshPage(browser, cfg);
      let answered = false;
      await page.route(u => u.toString().includes(li.api), async r => { await sleep(cfg.throttleMs ?? 2500); answered = true; await r.continue(); });
      await page.goto(base + li.path);
      let falseEmpty = false;
      for (let t = 0; t < (cfg.throttleMs ?? 2500) + 1500 && !answered; t += 100) {
        if (await visible(page, li.empty)) { falseEmpty = true; break; }
        await sleep(100);
      }
      const fe = falseEmpty ? await shot(page, out, `D1-${li.name}`) : '';
      results.push({ id: 'D1', check: 'No empty state before the first answer', target: li.name, status: falseEmpty ? 'FAIL' : 'PASS', detail: falseEmpty ? `"${li.empty}" visible while loading` : 'skeleton, cache or loading shown', shot: fe });
      await sleep(1800);
      const cls = await page.evaluate(() => window.__cls || 0);
      results.push({ id: 'M1', check: 'No layout shift when data lands (CLS ≤ 0.1)', target: li.name, status: cls <= 0.1 ? 'PASS' : 'FAIL', detail: `CLS ${cls.toFixed(3)}` });
      await ctx.close();
    }

    // A1/A2/N3: press responds within 100 ms; a double tap sends once; a finished send leaves history.
    for (const s of cfg.sends ?? []) {
      const { ctx, page } = await freshPage(browser, cfg);
      let sent = 0;
      page.on('request', r => { if (r.url().includes(s.api) && r.method() === (s.method || 'POST')) sent++; });
      await page.goto(base + cfg.home.path); await setup(page, cfg); await page.locator(cfg.home.ready).first().waitFor({ timeout: 20000 });
      if (!(await runSteps(page, s.steps, layers, results, s.name))) { await ctx.close(); continue; }
      const btn = page.locator(s.button).first();
      await page.evaluate(sel => {
        window.__ack = 0; const t0 = { v: 0 }; window.__t0 = t0;
        const el = document.querySelector(sel);
        new MutationObserver(() => { if (!window.__ack && t0.v) window.__ack = performance.now() - t0.v; })
          .observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
        el?.addEventListener('pointerdown', () => { t0.v = performance.now(); }, { capture: true, once: true });
      }, s.button);
      await btn.click({ timeout: 5000 });
      await btn.click({ timeout: 1000, force: true }).catch(() => {});
      await sleep(1500);
      const ack = await page.evaluate(() => window.__ack || 0);
      results.push({ id: 'A1', check: 'Press shows a response within 100 ms', target: s.name, status: ack > 0 && ack <= 100 ? 'PASS' : 'FAIL', detail: ack ? `${Math.round(ack)} ms` : 'no visible change' });
      results.push({ id: 'A2', check: 'A double tap sends once', target: s.name, status: sent === 1 ? 'PASS' : 'FAIL', detail: `${sent} request(s)`, shot: sent === 1 ? '' : await shot(page, out, `A2-${s.name}`) });
      if (s.form) {
        // Press back up to twice: a result screen left in history (or pushed twice) must not hide the form coming back.
        let back = false;
        for (let i = 0; i < 2 && !back; i++) { await page.goBack({ timeout: 3000 }).catch(() => {}); await sleep(400); back = await visible(page, s.form); }
        results.push({ id: 'N3', check: 'Back after sending does not reopen the form', target: s.name, status: back ? 'FAIL' : 'PASS', detail: back ? `"${s.form}" visible after back` : 'form left history', shot: back ? await shot(page, out, `N3-${s.name}`) : '' });
      }
      await ctx.close();
    }
  } finally { await browser.close(); }
  for (const id of ['L1']) if (!results.some(r => r.id === id)) results.push({ id, check: 'At most one layer over a screen', target: 'all walked steps', status: 'PASS', detail: 'never more than one' });
  return results;
}

export function table(results) {
  const rows = results.map(r => `| ${r.id} | ${r.check} | ${r.target} | ${r.status} | ${r.detail}${r.shot ? ` ([shot](${r.shot}))` : ''} |`);
  const fails = results.filter(r => r.status === 'FAIL').length;
  return [`| # | Check | Target | Result | Detail |`, `|---|---|---|---|---|`, ...rows, '',
    `${results.length - fails} PASS, ${fails} FAIL. Manual items in checklist.md (L2–L4, D2, D4, D5, A3–A6, M2–M5, N4–N6) are NOT TESTED by this script.`].join('\n');
}

// ---------- self-test: one bad and one good fixture app ----------
function serve() {
  const fx = path.join(HERE, 'fixtures');
  const server = createServer((rq, rs) => {
    const u = new URL(rq.url, 'http://x');
    if (u.pathname.endsWith('/api/items')) { rs.setHeader('content-type', 'application/json'); return rs.end('[{"id":1,"t":"Fire"},{"id":2,"t":"Crash"}]'); }
    if (u.pathname.endsWith('/api/send')) { rs.setHeader('content-type', 'application/json'); return setTimeout(() => rs.end('{"ok":true}'), 300); }
    const app = u.pathname.startsWith('/bad') ? 'bad.html' : 'good.html';
    rs.setHeader('content-type', 'text/html'); rs.end(fs.readFileSync(path.join(fx, app)));
  });
  return new Promise(r => server.listen(0, () => r(server)));
}

async function selfTest() {
  const server = await serve(), port = server.address().port;
  const cfg = app => ({
    baseUrl: `http://localhost:${port}`, home: { path: `/${app}/`, ready: '#home:not([hidden])' }, backSelector: '#back:not([hidden])',
    screens: [{ name: 'Detail', steps: [{ click: '.row' }], ready: '#detail:not([hidden])' }, { name: 'Report sheet', steps: [{ click: '.row' }, { click: '#report' }, { click: '#more' }], ready: '#sheet:not([hidden])' }],
    lists: [{ name: 'List', path: `/${app}/`, api: '/api/items', empty: '#empty:not([hidden])' }],
    sends: [{ name: 'Send', steps: [{ click: '.row' }, { click: '#report' }], button: '#send', api: '/api/send', method: 'POST', form: '#sheet:not([hidden])' }],
    throttleMs: 1500,
  });
  try {
    const bad = await walk(cfg('bad')), good = await walk(cfg('good'));
    console.log('## Bad fixture\n\n' + table(bad) + '\n\n## Good fixture\n\n' + table(good));
    const failIds = new Set(bad.filter(r => r.status === 'FAIL').map(r => r.id));
    const missing = ['N2', 'D1', 'M1', 'A1', 'A2', 'N3', 'L1'].filter(id => !failIds.has(id));
    const goodFails = good.filter(r => r.status === 'FAIL');
    if (missing.length || goodFails.length) {
      console.error(`\nSELF-TEST FAILED. Bad fixture not caught: ${missing.join(', ') || 'none'}. Good fixture failures: ${goodFails.map(r => r.id + ' ' + r.target).join(', ') || 'none'}.`);
      process.exitCode = 1;
    } else console.log('\nSELF-TEST PASSED: every bad mechanic was caught and the good app passed.');
  } finally { server.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === '--self-test') await selfTest();
  else if (!args[0]) { console.error('Usage: node stress-walk.mjs <config.json> [--out <dir>] | --self-test'); process.exit(2); }
  else {
    const cfg = JSON.parse(fs.readFileSync(args[0], 'utf8'));
    const oi = args.indexOf('--out'), out = oi > -1 ? args[oi + 1] : null;
    if (out) fs.mkdirSync(out, { recursive: true });
    const res = await walk(cfg, out);
    const md = table(res); console.log(md);
    if (out) fs.writeFileSync(path.join(out, 'stress-walk.md'), md + '\n');
    process.exitCode = res.some(r => r.status === 'FAIL') ? 1 : 0;
  }
}
