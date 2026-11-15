// UI test of the setup wizard's wall tablet step in the isolated test HA (port 8124): the floor plan card is faked
// (a custom element "floorplan-card" with getStubConfig), the wizard must create a NEW dashboard with a free url_path
// (grundriss-tablet is taken on purpose → grundriss-tablet-2), leave existing dashboards alone, and clean up afterwards.
// Usage: node tools/testha/test-wizard-ui.mjs [shotdir]
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { token, wsConnect, URL0, sleep, ok, failures, until } from './lib.mjs';
const require = createRequire(new URL('../../../package.json', import.meta.url));
const { chromium } = require('playwright');
const out = process.argv[2];
const tok = await token();
const ws = await wsConnect(tok);

// a dashboard that takes the first name, and the state of all dashboards before
const pre = await ws.call({ type: 'lovelace/dashboards/list' });
for (const d of pre.filter((x) => x.url_path.startsWith('grundriss-'))) await ws.call({ type: 'lovelace/dashboards/delete', dashboard_id: d.id });
const taken = await ws.call({ type: 'lovelace/dashboards/create', url_path: 'grundriss-tablet', title: 'Schon da', show_in_sidebar: false, require_admin: false });
await ws.call({ type: 'lovelace/config/save', url_path: 'grundriss-tablet', config: { title: 'Schon da', views: [{ title: 'X', cards: [] }] } });
const before = await ws.call({ type: 'lovelace/dashboards/list' });
// an already drawn floor plan in some dashboard is reused (only read), otherwise the card's template
let drawn = null;
for (const url_path of [null, ...before.filter((d) => d.mode !== 'yaml').map((d) => d.url_path)]) {
  const c = await ws.call({ type: 'lovelace/config', url_path }).catch(() => null);
  const m = c && JSON.stringify(c).match(/"type":"custom:floorplan-card"[^]*?"card_id":"([^"]+)"/);
  if (m && /"floors":\[\{/.test(JSON.stringify(c))) {
    drawn = m[1];
    break;
  }
}
await ws.call({ type: 'house_rules/setup/save', restart: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 900 }, colorScheme: 'light' });
await ctx.addInitScript(([u, t]) => {
  localStorage.setItem('hassTokens', JSON.stringify({ hassUrl: u, clientId: u + '/', access_token: t, refresh_token: '', expires_in: 1e9, expires: Date.now() + 1e12 }));
}, [URL0, tok]);
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(String(e)));
// the panel draws the live data (not stuck at „Lade Hausregeln …“) — also through a deep link into an area
await p.goto(URL0 + '/hausregeln/settings');
await p.waitForSelector('house-rules-panel', { timeout: 30000 });
const panelHas = (sel) => p.evaluate((sel) => { const f = (r) => { for (const el of r.querySelectorAll('*')) { if (el.tagName === 'HOUSE-RULES-PANEL') return el; if (el.shadowRoot) { const x = f(el.shadowRoot); if (x) return x; } } }; const el = f(document); return !!el?.shadowRoot?.querySelector(sel) && !el.shadowRoot.textContent.includes('Lade Hausregeln'); }, sel);
ok(await until(() => panelHas('hr-settings-view'), 15000), 'Panel zeichnet die Live-Daten (nicht „Lade Hausregeln …“) und der Direktlink /hausregeln/settings öffnet die Einstellungen');
// the window warning moved to the alarm area: its deep link (the floor plan card uses it) opens it there
await p.goto(URL0 + '/hausregeln/window-warning');
await p.waitForSelector('house-rules-panel', { timeout: 30000 });
ok(await until(() => p.evaluate(() => { const f = (r) => { for (const el of r.querySelectorAll('*')) { if (el.tagName === 'HOUSE-RULES-PANEL') return el; if (el.shadowRoot) { const x = f(el.shadowRoot); if (x) return x; } } }; const v = f(document)?.shadowRoot?.querySelector('hr-alarm-view'); return !!v?.shadowRoot?.querySelector('#window-warning'); }), 15000), 'Direktlink /hausregeln/window-warning öffnet die Fenster-Warnung unter „Alarmanlage“');
await p.goto(URL0 + '/hausregeln');
await p.waitForSelector('house-rules-panel', { timeout: 30000 });
// fake floor plan card (roomwise), defined after the page loaded like the card's own loader does: only what the wizard uses.
// Once the card's companion integration runs in this test HA (another test set it up), the real card is already
// registered — then the wizard takes the real card's template.
const faked = await p.evaluate(async () => {
  // the companion's loader imports the card right after the page
  const real = await Promise.race([customElements.whenDefined('floorplan-card').then(() => true), new Promise((r) => setTimeout(() => r(false), 4000))]);
  if (real) return false;
  customElements.define(
    'floorplan-card',
    class extends HTMLElement {
      static getStubConfig() {
        return { type: 'custom:floorplan-card', card_id: 'fp_test', floors: [{ id: 'floor_1', name: 'Wohnung', rooms: [], devices: [] }] };
      }
    },
  );
  return true;
});
// a fresh setup opens by itself
const wiz = p.locator('hr-setup-wizard');
ok(await until(async () => (await wiz.count()) > 0, 15000), 'Assistent öffnet sich von selbst (Einrichtung nicht abgeschlossen)');
await sleep(1500);
for (let i = 0; i < 14; i++) {
  const title = await wiz.locator('hr-pop').getAttribute('heading');
  if (/Wandtablet/.test(title)) break;
  const skip = wiz.locator('footer .btn.plain');
  await ((await skip.count()) ? skip : wiz.locator('footer .btn.primary')).click();
  await sleep(700);
}
ok(/Wandtablet/.test(await wiz.locator('hr-pop').getAttribute('heading')), 'Schritt „Hast du ein Wandtablet?“ erreicht (alles davor übersprungen)');
await wiz.locator('.choice button').first().click();
await sleep(1500);
if (out) await p.screenshot({ path: join(out, 'W01-tablet-step.png') });
await wiz.locator('button:has-text("Jetzt anlegen")').click();
ok(await until(async () => (await wiz.locator('text=Angelegt').count()) > 0, 10000), 'nach Bestätigung angelegt');
if (out) await p.screenshot({ path: join(out, 'W02-tablet-created.png') });
const after = await ws.call({ type: 'lovelace/dashboards/list' });
const made = after.find((d) => !before.some((b) => b.id === d.id));
ok(made?.url_path === 'grundriss-tablet-2' && made.title === 'Wandtablet', 'neues Dashboard mit freiem Pfad (grundriss-tablet war belegt)', made);
const cfg = await ws.call({ type: 'lovelace/config', url_path: made.url_path });
const card = cfg.views?.[0]?.cards?.[0];
ok(cfg.views[0].type === 'panel' && card?.type === 'custom:floorplan-card' && /100vh/.test(card.height) && (drawn ? card.card_id === drawn : faked ? card.card_id === 'fp_test' : /^fp/.test(card.card_id ?? '') && card.floors?.length), `Panel-Ansicht mit der Grundriss-Karte (${drawn ? 'gezeichneter Grundriss übernommen' : faked ? 'Vorlage der Karte' : 'Vorlage der echten Karte'}), volle Höhe fürs Tablet`, cfg);
const still = await ws.call({ type: 'lovelace/config', url_path: 'grundriss-tablet' });
ok(still.title === 'Schon da' && still.views[0].title === 'X' && before.every((b) => after.some((a) => a.id === b.id && a.title === b.title)), 'bestehende Dashboards unverändert');
// on to the summary (Reinschau-Licht / diagnostics may come in between, depending on what is on) and back to normal
for (let i = 0; i < 4 && !/Fertig/.test((await wiz.locator('footer .btn.primary').textContent()) ?? ''); i++) {
  await wiz.locator('footer .btn.primary').click();
  await sleep(800);
}
ok(/eingerichtet/.test(await wiz.locator('hr-pop').getAttribute('heading')), 'Übersicht erreicht');
if (out) await p.screenshot({ path: join(out, 'W03-summary.png') });
await wiz.locator('footer .btn.primary').click();
await sleep(800);
ok((await ws.call({ type: 'house_rules/snapshot' })).setup.done, 'Fertig → Einrichtung abgeschlossen');
ok(!errors.length, 'keine Fehler auf der Seite', errors);
await browser.close();
for (const d of after.filter((x) => x.url_path.startsWith('grundriss-'))) await ws.call({ type: 'lovelace/dashboards/delete', dashboard_id: d.id });
void taken;
ws.close();
console.log(`\n${failures() ? `${failures()} FEHLER` : 'alles ok'}`);
process.exit(failures() ? 1 : 0);
