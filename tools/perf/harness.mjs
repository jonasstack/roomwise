// Runs the built card in a bare page with a fake Home Assistant (no HA at all, nothing is called anywhere):
// the page loads dist/floorplan-card.js through the same URL the companion serves (/floorplan_card_files/),
// so lazily loaded chunks are fetched exactly as on a dashboard. Used by the performance budget test.
//   const run = await openCard({ view: '3d', weak: false, rooms: 16, extra: 2500 });
//   run.page, run.cdp, run.card(expr), run.setStates({ id: state }), run.close()
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { house } from './house.mjs';

const ORIGIN = 'http://fp.test';

// The page: minimal stand-ins for the HA elements the card uses, a fake hass object, the card.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>html,body{margin:0;height:100%;background:#f2f2f7}floorplan-card{display:block}ha-icon,ha-state-icon{display:inline-block;width:24px;height:24px}</style>
<script>
customElements.define('ha-card', class extends HTMLElement { connectedCallback() { this.style.display = 'block'; this.style.position = 'relative'; } });
customElements.define('ha-icon', class extends HTMLElement {});
customElements.define('ha-state-icon', class extends HTMLElement {});
</script></head><body><script type="module">
const h = window.__house;
const fp = (window.__fp = { subs: [], calls: [], ws: [], firstPlan: 0 });
const unknown = () => Promise.reject({ code: 'unknown_command', message: 'Unknown command.' });
const connection = {
  subscribeMessage(cb, msg) { fp.subs.push(msg.type); if (/^(floorplan_card|house_rules)\\//.test(msg.type)) return unknown(); return Promise.resolve(() => { fp.subs.splice(fp.subs.indexOf(msg.type), 1); }); },
  subscribeEvents() { fp.subs.push('events'); return Promise.resolve(() => fp.subs.splice(fp.subs.indexOf('events'), 1)); },
  sendMessagePromise(msg) { fp.ws.push(msg.type); return /^(floorplan_card|house_rules)\\//.test(msg.type) ? unknown() : Promise.resolve({}); },
};
const base = {
  entities: h.entities, devices: h.devices, areas: h.areas, floors: h.floors,
  user: { id: 'u1', name: 'Demo', is_admin: true, is_owner: true },
  language: 'de', locale: { language: 'de', number_format: 'language' }, themes: { darkMode: false },
  config: { unit_system: { temperature: '°C', length: 'km' }, time_zone: 'Europe/Berlin', latitude: 52.5, longitude: 13.4, location_name: 'Demo' },
  services: {}, connection,
  callService(domain, service, data, target) { fp.calls.push({ domain, service, data, target }); return Promise.resolve({ context: { id: 'x' } }); },
  callWS(msg) { return connection.sendMessagePromise(msg); },
  callApi() { return Promise.reject(new Error('no api')); },
  hassUrl: (p = '') => p,
};
let states = h.states;
let card;
fp.hass = () => card._hass;
// what HA does on every state change: a new hass object, unchanged entities keep their identity
fp.setStates = (changes) => {
  states = { ...states };
  const now = new Date().toISOString();
  for (const [id, s] of Object.entries(changes)) states[id] = { ...states[id], state: s, last_changed: now, last_updated: now };
  card.hass = { ...base, states };
};
const t0 = performance.now();
await import('/floorplan_card_files/floorplan-card.js');
fp.loaded = performance.now() - t0;
card = fp.card = document.createElement('floorplan-card');
card.setConfig(h.config);
card.hass = { ...base, states };
document.body.appendChild(card);
// the plan is on screen: its first floor geometry exists
const ready = () => card.shadowRoot?.querySelector('fp-plan')?.shadowRoot?.querySelector('svg path');
await new Promise((res) => { const tick = () => (ready() ? res() : requestAnimationFrame(tick)); tick(); });
fp.firstPlan = performance.now();
</script></body></html>`;

/** dist directory to serve the card from ('dist' = split build, 'dist/single' = one file) */
/** fail(path): answer this file with 404 (e.g. a chunk deleted by an update while the page stayed open) */
export async function openCard({ dist = 'dist', size = '1280x800', view = 'auto', weak = false, rooms = 16, extra = 2500, calm = false, config = {}, throttle = 1, init, fail } = {}) {
  const [width, height] = size.split('x').map(Number);
  // headless Chromium renders WebGL in software (SwiftShader), like a tablet without a usable GPU driver
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const h = house({ rooms, extra, calm });
  Object.assign(h.config, { view_mode: view }, config);
  const bytes = { total: 0, files: [], missing: [] };
  await ctx.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ body: PAGE, contentType: 'text/html' });
    const m = url.pathname.match(/^\/floorplan_card_files\/(.*)$/);
    const file = m && join(dist, m[1]);
    if (!file || !existsSync(file) || fail?.(m[1])) {
      bytes.missing.push(url.pathname);
      return route.fulfill({ status: 404, body: '' });
    }
    const body = readFileSync(file);
    bytes.total += body.length;
    bytes.files.push(m[1]);
    route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
  });
  await ctx.addInitScript(
    ([hh, weak]) => {
      window.__house = hh;
      if (weak) {
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 2 });
        Object.defineProperty(navigator, 'deviceMemory', { get: () => 2 });
      }
      // count animation frames the page itself asks for (the render loop must sleep when nothing moves)
      const raf = window.requestAnimationFrame.bind(window);
      window.__rafCount = 0;
      window.requestAnimationFrame = (cb) => {
        window.__rafCount++;
        return raf(cb);
      };
    },
    [h, weak],
  );
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  if (process.env.PERF_DEBUG) page.on('console', (m) => console.error('[page]', m.type(), m.text()));
  if (process.env.PERF_DEBUG) page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  const t0 = Date.now();
  await page.goto(ORIGIN + '/');
  await page.waitForFunction(() => window.__fp?.firstPlan > 0, null, { timeout: 60000 });
  const wall = Date.now() - t0;
  const card = (expr) => page.evaluate(`(async () => { const card = window.__fp.card; const plan = card.shadowRoot.querySelector('fp-plan'); return ${expr}; })()`);
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  return {
    browser,
    ctx,
    page,
    cdp,
    errors,
    house: h,
    bytes,
    wall,
    card,
    metrics,
    setStates: (changes) => page.evaluate((c) => window.__fp.setStates(c), changes),
    throttle: (rate) => cdp.send('Emulation.setCPUThrottlingRate', { rate }),
    close: () => browser.close(),
  };
}

/** Frame times while `during` runs (own rAF loop, so it measures what the user sees) */
export async function frames(run, ms, during) {
  await run.page.evaluate(() => {
    window.__ft = [];
    window.__ftOn = true;
    const loop = (t) => {
      window.__ft.push(t);
      if (window.__ftOn) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  const m0 = await run.metrics();
  const t0 = Date.now();
  if (during) await during();
  const rest = ms - (Date.now() - t0);
  if (rest > 0) await run.page.waitForTimeout(rest);
  const m1 = await run.metrics();
  const f = await run.page.evaluate(() => {
    window.__ftOn = false;
    return window.__ft;
  });
  const d = f.slice(1).map((t, i) => t - f[i]).sort((a, b) => a - b);
  const sec = (Date.now() - t0) / 1000;
  const q = (p) => +(d[Math.min(d.length - 1, Math.floor(d.length * p))] ?? 0).toFixed(1);
  return { fps: +(f.length / sec).toFixed(1), p50: q(0.5), p95: q(0.95), scriptMsPerS: +(((m1.ScriptDuration - m0.ScriptDuration) * 1000) / sec).toFixed(0), taskMsPerS: +(((m1.TaskDuration - m0.TaskDuration) * 1000) / sec).toFixed(0) };
}

/** CPU the page uses while nobody touches it, and how many animation frames it requests */
export async function idle(run, ms = 10000) {
  const r0 = await run.page.evaluate(() => window.__rafCount);
  const m0 = await run.metrics();
  await run.page.waitForTimeout(ms);
  const m1 = await run.metrics();
  const r1 = await run.page.evaluate(() => window.__rafCount);
  const sec = ms / 1000;
  return { rafPerS: +((r1 - r0) / sec).toFixed(1), taskMsPerS: +(((m1.TaskDuration - m0.TaskDuration) * 1000) / sec).toFixed(1), scriptMsPerS: +(((m1.ScriptDuration - m0.ScriptDuration) * 1000) / sec).toFixed(1) };
}

/** Heap after a forced garbage collection (MB) */
export async function heap(run) {
  await run.cdp.send('HeapProfiler.collectGarbage');
  await run.cdp.send('HeapProfiler.collectGarbage');
  const m = await run.metrics();
  return +(m.JSHeapUsedSize / 1048576).toFixed(2);
}

/** Pan with the mouse across the middle of the plan */
export async function pan(run, steps = 60) {
  const box = await run.page.locator('floorplan-card').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await run.page.mouse.move(cx, cy);
  await run.page.mouse.down();
  for (let i = 0; i < steps; i++) await run.page.mouse.move(cx + Math.sin(i / 8) * 160, cy + Math.cos(i / 8) * 80);
  await run.page.mouse.up();
}

/** Zoom with the mouse wheel in and out */
export async function zoom(run, steps = 20) {
  const box = await run.page.locator('floorplan-card').boundingBox();
  await run.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < steps; i++) {
    await run.page.mouse.wheel(0, i < steps / 2 ? -120 : 120);
    await run.page.waitForTimeout(30);
  }
}

/** Scroll the open popup with the mouse wheel down and back up (a long popup such as the car's) */
export async function scrollPopup(run, steps = 16) {
  const box = await run.page.evaluate(() => {
    const r = document.querySelector('floorplan-card-layer').shadowRoot.querySelector('.sheet').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await run.page.mouse.move(box.x, box.y);
  for (let i = 0; i < steps; i++) {
    await run.page.mouse.wheel(0, i < steps / 2 ? 160 : -160);
    await run.page.waitForTimeout(40);
  }
}
