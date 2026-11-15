// Screenshots of the heating view (Reiter Heizung) in the isolated test HA (port 8124), desktop and phone.
// Usage: node tools/testha/heat-shots.mjs <outdir>   (after test-heating.mjs: areas and fake devices are in place)
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { token, wsConnect, URL0, sleep } from './lib.mjs';
const require = createRequire(new URL('../../../package.json', import.meta.url));
const { chromium } = require('playwright');
const out = process.argv[2] || 'dist/shots-heat';
mkdirSync(out, { recursive: true });
const tok = await token();
const ws = await wsConnect(tok);
const set = (entity_id, state, attributes = {}) => ws.call({ type: 'hr_fake/set', entity_id, state, attributes });
const snap = await ws.call({ type: 'house_rules/snapshot' });
const R = Object.fromEntries(snap.rooms.map((r) => [r.name, r.id]));
const cur = (rid) => snap.plans.heat[rid];
await ws.call({ type: 'house_rules/heating/set', config: { outside: null, summer: { on: true, above: 18, hold: 60 }, demand: { on: true, entity: 'switch.heizkessel', above: 20, min_on: 10, min_off: 10 }, quiet: { on: true, from: '22:00', to: '07:00' }, gap: 5 } });
const plan = (rid, p) => ws.call({ type: 'house_rules/plan/set', kind: 'heat', room: rid, plan: { ...cur(rid), ...p } });
const blocks = [
  { from: '06:00', to: '08:30', days: 'workdays', level: 'comfort', temp: 21 },
  { from: '16:30', to: '22:30', days: 'all', level: 'comfort', temp: 21 },
  { from: '08:00', to: '23:00', days: 'weekend', level: 'comfort', temp: 21 },
];
await set('sensor.temp_aussen', '4');
await set('climate.heizung_kueche', 'heat', { current_temperature: 19.6, valve: 45 });
await set('climate.heizung_wohnzimmer', 'heat', { current_temperature: 20.4 });
await set('sensor.heizung_wohnzimmer_ventil', '30');
await set('sensor.feuchte_bad', '68');
await plan(R['Küche'], { on: true, blocks, sensor: null, window: { ...cur(R['Küche']).window, on: true, delay: 2, resume: 5 } });
await plan(R.Bad, { on: true, blocks: [{ from: '05:45', to: '08:00', days: 'all', level: 'custom', temp: 23 }, ...blocks.slice(1)], sensor: null, vent: { ...cur(R.Bad).vent, on: true, humidity: 65, wait: 0.05, times: ['08:00', '19:00'] } });
await plan(R.Wohnzimmer, { on: true, blocks, sensor: 'sensor.temp_wohnzimmer', calibrate: 'auto' });
await set('binary_sensor.fenster_kueche', 'on');
ws.close();
await sleep(3000);

const browser = await chromium.launch();
const errors = [];
async function open(w, h, scheme) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme });
  await ctx.addInitScript(([u, t]) => {
    localStorage.setItem('hassTokens', JSON.stringify({ hassUrl: u, clientId: u + '/', access_token: t, refresh_token: '', expires_in: 1e9, expires: Date.now() + 1e12 }));
  }, [URL0, tok]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('console', (m) => m.type() === 'error' && !/favicon|manifest/.test(m.text()) && errors.push(m.text()));
  await p.goto(URL0 + '/hausregeln');
  await p.waitForSelector('house-rules-panel', { timeout: 30000 });
  await sleep(2500);
  await p.locator('house-rules-panel nav button:has-text("Heizung")').click();
  await sleep(800);
  return p;
}
const shot = (p, name, full = false) => p.screenshot({ path: join(out, name + '.png'), fullPage: full });
const hv = (p) => p.locator('hr-heat-plans');
const openAll = (p) => hv(p).locator('details').evaluateAll((ds) => ds.forEach((d) => (d.open = true)));
const scrollW = (p) => p.evaluate(() => document.documentElement.scrollWidth - innerWidth);

let p = await open(1280, 900, 'light');
await shot(p, 'H01-overview');
await hv(p).locator('details summary:has-text("Für das ganze Haus")').click();
await sleep(400);
await shot(p, 'H02-house', true);
await hv(p).locator('details summary:has-text("Für das ganze Haus")').click();
await hv(p).locator('.roomrow:has-text("Bad")').click();
await sleep(600);
await shot(p, 'H03-bad');
await openAll(p);
await sleep(400);
await shot(p, 'H04-bad-all', true);
await hv(p).locator('button:has-text("Alle Räume")').click();
await hv(p).locator('.roomrow:has-text("Wohnzimmer")').click();
await sleep(500);
await openAll(p);
await sleep(300);
await shot(p, 'H05-wohnzimmer-all', true);
await p.close();

p = await open(390, 844, 'dark');
await shot(p, 'H06-phone-overview', true);
console.log('phone overflow x:', await scrollW(p));
await hv(p).locator('.roomrow:has-text("Küche")').click();
await sleep(600);
await shot(p, 'H07-phone-kueche');
await openAll(p);
await sleep(300);
await shot(p, 'H08-phone-kueche-all', true);
console.log('phone detail overflow x:', await scrollW(p));
await p.close();
await browser.close();
console.log(errors.length ? 'ERRORS:\n' + [...new Set(errors)].join('\n') : 'no console errors');
