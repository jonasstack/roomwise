// Playwright helpers: logged-in page, console capture, optional interception of service calls.
// Intercepted calls are recorded in window.__fpCalls and resolved without reaching HA.
import { chromium, firefox, webkit } from 'playwright';
import { testEnv } from './ha.mjs';

// Pre-existing issues of this instance (not caused by the card).
export const KNOWN = [/GPU stall due to ReadPixels/, /clock-weather-card/, /scoped-custom-element-registry/, /status of 404/, /Service Worker registration blocked/, /lit-virtualizer is loaded/];
// HA's own service-worker hook fails when tests block service workers (blocked to avoid HA's auto-reload).
const isSwArtifact = (e) => /reading 'addEventListener'/.test(e.message) && /frontend_latest\/app\./.test(e.stack ?? '');

/** A browser of the engine PW_ENGINE names: chromium (default: Chrome, Edge, Android WebView), webkit (Safari, every
 *  iOS browser, the HA iOS app) or firefox. PW_ARGS: extra Chromium flags (e.g. --disable-gpu). */
export async function launch() {
  const engine = process.env.PW_ENGINE ?? 'chromium';
  if (engine === 'webkit') return webkit.launch();
  // headless Firefox turns WebGL off without a GPU: force its software path (PW_NOGL=1 keeps it off)
  if (engine === 'firefox') return firefox.launch({ firefoxUserPrefs: process.env.PW_NOGL ? { 'webgl.disabled': true } : { 'webgl.force-enabled': true } });
  return chromium.launch({ args: (process.env.PW_ARGS ?? '').split(' ').filter(Boolean) });
}

export async function openHA({ path = process.env.FP_DASHBOARD ?? '/grundriss-test/grundriss', size = '1280x800', scheme = 'light', block = [], touch = false, kiosk = false, companion = false, hrOff = false, user = null } = {}) {
  const [width, height] = size.split('x').map(Number);
  const env = testEnv(); // never a real home (see tools/ha.mjs)
  const { url, test } = env;
  // user: the token of another (e.g. non-admin) user instead of the admin token
  const token = user ?? env.token;
  const browser = await launch();
  // the tests expect the German texts: HA takes the browser's language when the user has not chosen one (PW_LOCALE to change)
  const ctx = await browser.newContext({ deviceScaleFactor: Number(process.env.PW_DPR ?? 1), viewport: { width, height }, colorScheme: scheme, hasTouch: touch, isMobile: process.env.PW_ENGINE === 'firefox' ? undefined : false, serviceWorkers: 'block', locale: process.env.PW_LOCALE ?? 'de-DE' });
  // tests change the card's configuration in the page: without the companion, so its server data stays untouched
  if (!companion) await ctx.addInitScript(() => (window.__fpNoCompanion = true));
  // as if Hausregeln were not installed
  if (hrOff) await ctx.addInitScript(() => (window.__fpHrOff = true));
  await ctx.addInitScript(([u, t, blocked, kiosk]) => {
    if (kiosk) localStorage.setItem('dockedSidebar', JSON.stringify('always_hidden'));
    localStorage.setItem('hassTokens', JSON.stringify({ hassUrl: u, clientId: u + '/', access_token: t, refresh_token: '', expires_in: 1e9, expires: Date.now() + 1e12 }));
    window.__fpCalls = [];
    window.__fpBlock = blocked;
    // Patch the websocket connection once HA creates it.
    const iv = setInterval(() => {
      const ha = document.querySelector('home-assistant');
      const conn = ha?.hass?.connection;
      if (!conn || conn.__fpPatched) return;
      conn.__fpPatched = true;
      const orig = conn.sendMessagePromise.bind(conn);
      conn.sendMessagePromise = (msg) => {
        if (window.__fpHrOff && String(msg?.type).startsWith('house_rules/')) return Promise.reject({ code: 'unknown_command', message: 'Unknown command.' });
        if (msg?.type === 'call_service') {
          const rec = { domain: msg.domain, service: msg.service, data: msg.service_data, target: msg.target, blocked: window.__fpBlock.includes(msg.domain) || window.__fpBlock.includes(`${msg.domain}.${msg.service}`), t: Date.now() };
          window.__fpCalls.push(rec);
          if (rec.blocked) return Promise.resolve({ context: { id: 'fp-test' } });
        }
        return orig(msg);
      };
    }, 50);
  }, [url, token, block, kiosk]);
  // FP_LOCAL=1: the page gets the card from this checkout's dist/ (test before deploying)
  // the test HA has no companion integration: there the card always comes from dist/
  if (process.env.FP_LOCAL || test) {
    const { readFileSync, existsSync } = await import('node:fs');
    await ctx.route(/\/floorplan_card_files\/(.*?)(\?.*)?$/, (route) => {
      const m = route.request().url().match(/\/floorplan_card_files\/([^?]*)/);
      const f = `dist/${m[1]}`;
      if (!existsSync(f)) return route.continue();
      route.fulfill({ body: readFileSync(f), contentType: f.endsWith('.js') ? 'text/javascript' : f.endsWith('.glb') ? 'model/gltf-binary' : 'application/octet-stream' });
    });
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !KNOWN.some((r) => r.test(m.text()))) errors.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => {
    if (!KNOWN.some((r) => r.test(e.message)) && !isSwArtifact(e)) errors.push('[pageerror] ' + e.message);
  });
  await page.goto(url + path, { waitUntil: 'networkidle' });
  await page.waitForSelector('floorplan-card', { timeout: 15000 });
  await page.waitForTimeout(800);
  return { browser, ctx, page, errors, calls: () => page.evaluate(() => window.__fpCalls) };
}

/** Center of an element (pierces shadow DOM). */
export async function center(page, selector) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error('not found: ' + selector);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Tap at a point using pointer events (mouse). */
export async function tapAt(page, x, y, holdMs = 0) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  if (holdMs) await page.waitForTimeout(holdMs);
  await page.mouse.up();
}

export async function state(entityId) {
  const { connect } = await import('./ha.mjs');
  const ha = await connect({ test: true });
  try {
    return (await ha.call({ type: 'get_states' })).find((s) => s.entity_id === entityId);
  } finally {
    ha.close();
  }
}

const CARD = `const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } }; const card = find(document); const plan = card.shadowRoot.querySelector('fp-plan');`;

/** A screen point that hits the piece (furniture or device marker) bound to an entity, or matching a predicate
 *  on the entity id (e.g. 'light.' for the first light). Works in 2D and 3D. Null when there is none in view. */
export async function piecePoint(page, entity) {
  return page.evaluate(`(() => { ${CARD}
    const fl = card._config.floors.find((f) => f.id === plan.floor?.id) ?? card._config.floors[0];
    const hit = (e) => e && (e === ${JSON.stringify(entity)} || (${JSON.stringify(entity)}.endsWith('.') && e.startsWith(${JSON.stringify(entity)})));
    for (const f of (fl.furniture ?? []).filter((f) => hit(f.entity))) {
      const r = plan.pieceRect(f.id); if (!r || r.w < 2) continue;
      for (let fy = 0.5; fy < 0.95; fy += 0.1) for (let fx = 0.5; fx > 0.1; fx -= 0.1) { const x = r.x + r.w * fx, y = r.y + r.h * fy; if (plan.pieceAt(x, y) === f.id) return [x, y]; }
      for (let dy = -12; dy <= 12; dy += 3) for (let dx = -12; dx <= 12; dx += 3) { const x = r.x + r.w / 2 + dx, y = r.y + r.h / 2 + dy; if (plan.pieceAt(x, y) === f.id) return [x, y]; }
    }
    for (const d of (fl.devices ?? []).filter((d) => hit(d.entity))) {
      const el = plan.shadowRoot.querySelector('[data-device="' + d.id + '"]'); const r = el?.getBoundingClientRect(); if (r?.width) return [r.x + r.width / 2, r.y + r.height / 2];
    }
    return null; })()`);
}

/** A screen point on a room's floor, away from pieces and labels (room by name, or index). Works in 2D and 3D. */
export async function roomPoint(page, room) {
  return page.evaluate(`(() => { ${CARD}
    const fl = card._config.floors.find((f) => f.id === plan.floor?.id) ?? card._config.floors[0];
    const rm = typeof ${JSON.stringify(room)} === 'number' ? fl.rooms[${JSON.stringify(room)}] : fl.rooms.find((r) => r.name === ${JSON.stringify(room)});
    const vp = plan.getBoundingClientRect();
    // what the card itself makes of a press there (pieces, nearby devices, doors and windows, labels …)
    const hit = (x, y) => {
      const path = [];
      for (let n = plan.shadowRoot.elementFromPoint(x, y); n; n = n instanceof ShadowRoot ? n.host : n.parentNode) if (n.nodeType === 1) path.push(n);
      const t = plan.hitTestInner({ clientX: x, clientY: y, composedPath: () => path });
      return t.kind === 'room' && t.id === rm.id;
    };
    for (let fy = 0.2; fy <= 0.9; fy += 0.025) for (let fx = 0.1; fx <= 0.9; fx += 0.025) {
      const x = vp.left + vp.width * fx, y = vp.top + vp.height * fy;
      if (plan.roomAt(x, y) !== rm.id) continue;
      if ([[0, 0], [12, 0], [-12, 0], [0, 12], [0, -12]].every(([dx, dy]) => hit(x + dx, y + dy))) return [x, y];
    }
    return null; })()`);
}
