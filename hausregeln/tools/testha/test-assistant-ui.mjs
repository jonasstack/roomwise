// UI test of a feature assistant in the isolated test HA (port 8124): opening the area "Licht" while nothing is set up
// opens the light assistant by itself; it is walked step by step (rooms pre-filled from the detected sensors,
// "Intelligent" chosen, Probelauf), "Einrichten" sets the room up for real, and the area then shows the intelligent
// light and "Assistent erneut starten". Sets up what it needs itself (integration, room "Flur" with its light and
// presence sensor), so it runs on a fresh test HA as well as after the other suites (which move devices around).
// Usage: node tools/testha/test-assistant-ui.mjs [shotdir]
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { token, wsConnect, rest, URL0, sleep, ok, failures, until } from './lib.mjs';
const require = createRequire(new URL('../../../package.json', import.meta.url));
const { chromium } = require('playwright');
const out = process.argv[2];
const tok = await token();
const ws = await wsConnect(tok);
const api = rest(tok);
const snapshot = () => ws.call({ type: 'house_rules/snapshot' });

// ---------------------------------------------------------------- setup (idempotent)
let info = await ws.call({ type: 'house_rules/info' }).catch(() => null);
if (!info?.loaded) {
  const flow = await api('POST', '/api/config/config_entries/flow', { handler: 'house_rules' });
  await api('POST', `/api/config/config_entries/flow/${flow.body.flow_id}`, {});
  info = await until(async () => {
    const i = await ws.call({ type: 'house_rules/info' }).catch(() => null);
    return i?.loaded && i;
  }, 30000);
}
ok(info?.loaded, 'Hausregeln läuft');
await until(async () => (await snapshot()).devices.length > 10, 90000, 1000);
// the hallway with its light and presence sensor (other suites may have moved the light to another room)
const areas = await ws.call({ type: 'config/area_registry/list' });
const flurArea = (areas.find((a) => a.name === 'Flur') ?? (await ws.call({ type: 'config/area_registry/create', name: 'Flur' }))).area_id;
for (const e of ['light.flurlicht', 'binary_sensor.praesenz_flur', 'sensor.lux_flur']) await ws.call({ type: 'config/entity_registry/update', entity_id: e, area_id: flurArea }).catch((err) => console.log('area', e, err.message));
// the room counts once Hausregeln rebuilds (3 s after the last registry change)
const hasFlur = async () => {
  const sug = await ws.call({ type: 'house_rules/assistant/suggest', feature: 'light' });
  const r = sug.rooms?.find((x) => x.name === 'Flur');
  return r?.lights.some((l) => l.entity_id === 'light.flurlicht') && r.presence.length > 0;
};
ok(await until(hasFlur, 20000, 500), 'Raum Flur mit Licht und Präsenzmelder');

// nothing set up for light yet, the first setup wizard is finished
let snap = await snapshot();
const flur = snap.rooms.find((r) => r.name === 'Flur');
const features0 = snap.features;
await ws.call({ type: 'house_rules/setup/save', done: true });
await ws.call({ type: 'house_rules/features/set', features: { light: true } });
for (const r of snap.rooms) await ws.call({ type: 'house_rules/plan/set', kind: 'light', room: r.id, plan: { ...snap.plans.light[r.id], on: false, rules: [], smart: { mode: 'off' } } });
await ws.call({ type: 'house_rules/assistant/mark', feature: 'light', done: false, dismissed: false });
// the vacation assistant would follow in the same area: not part of this walk
await ws.call({ type: 'house_rules/assistant/mark', feature: 'vacation', dismissed: true });
snap = await snapshot();
ok(!snap.setup.assistants.light.configured && !snap.setup.assistants.light.done, 'Licht: noch nicht eingerichtet');

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 900 }, colorScheme: 'light' });
await ctx.addInitScript(([u, t]) => {
  localStorage.setItem('hassTokens', JSON.stringify({ hassUrl: u, clientId: u + '/', access_token: t, refresh_token: '', expires_in: 1e9, expires: Date.now() + 1e12 }));
}, [URL0, tok]);
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(String(e)));
await p.goto(URL0 + '/hausregeln/light');
await p.waitForSelector('house-rules-panel', { timeout: 30000 });
const as = p.locator('hr-assistant-light');
ok(await until(async () => (await as.count()) > 0, 20000), 'Bereich „Licht“ ohne Einrichtung: Licht-Assistent öffnet sich von selbst');
await until(async () => !(await as.locator('text=Lade …').count()), 10000);
const title = async () => (await as.locator('h2').textContent())?.trim();
ok(/Assistent · Licht · 1 von 7/.test(await as.locator('.count').textContent()), 'Kopf: „Assistent · Licht · 1 von 7“ mit Fortschritt', await as.locator('.count').textContent());
ok((await title()) === 'In welchen Räumen?', 'Schritt 1: Räume', await title());
const flurRow = as.locator('button.row', { hasText: 'Flur' });
ok((await flurRow.getAttribute('aria-checked')) === 'true', 'Flur vorgeschlagen (hat einen Präsenzmelder)');
if (out) await p.screenshot({ path: join(out, 'A01-licht-raeume.png') });
const next = () => as.locator('footer .btn.primary').click();
await next();
await sleep(300);
ok((await title()) === 'Wer ist da?' && (await as.locator('text=Präsenz').count()) + (await as.locator('.row', { hasText: 'Flur' }).count()) > 0, 'Schritt 2: gefundene Sensoren', await title());
await next();
await sleep(300);
ok((await title()) === 'Intelligent oder eigene Regeln?', 'Schritt 3: Intelligent oder eigene Regeln', await title());
ok((await as.locator('.choice button[aria-pressed="true"]').textContent()).includes('Intelligent'), 'Intelligent vorgewählt');
ok((await as.locator('.seg button[aria-pressed="true"]').textContent()).includes('Probelauf'), 'Erst Probelauf vorgewählt');
if (out) await p.screenshot({ path: join(out, 'A02-licht-intelligent.png') });
await next();
await sleep(300);
ok((await title()) === 'Wie hell, welche Farbe?' && (await as.locator('.slot').count()) === 5, 'Schritt 4: fünf Tageszeiten', await title());
// evening a bit darker
const evening = as.locator('.slot').nth(2); // Abends
await evening.locator('button[aria-label="weniger"]').click();
ok((await evening.locator('output').textContent()).includes('75 %'), 'abends auf 75 % gestellt');
await next();
await sleep(300);
ok((await title()) === 'Wenn niemand mehr da ist', 'Schritt 5: niemand mehr da', await title());
await next();
await sleep(300);
ok((await title()) === 'Grenzen, die immer gelten', 'Schritt 6: Grenzen', await title());
await as.locator('.row', { hasText: 'Nie heller als' }).locator('button[aria-label="weniger"]').click();
ok((await as.locator('.row', { hasText: 'Nie heller als' }).locator('output').textContent()).includes('95 %'), '„nie heller als“ auf 95 %');
await next();
await sleep(300);
ok((await title()) === 'Zusammenfassung' && (await as.locator('.sum .row').count()) >= 5, 'Zusammenfassung', await title());
ok((await as.locator('.sum').textContent()).includes('Abends ab 18:00: 75 %'), 'Zusammenfassung zeigt die Antworten');
if (out) await p.screenshot({ path: join(out, 'A03-licht-zusammenfassung.png') });
await as.locator('footer .btn.primary', { hasText: 'Einrichten' }).click();
ok(await until(async () => (await as.locator('text=Eingerichtet.').count()) > 0, 8000), 'eingerichtet');
snap = await snapshot();
const pl = snap.plans.light[flur.id];
ok(pl.on && pl.smart.mode === 'shadow' && pl.smart.guards.max === 95 && pl.smart.slots.find((s) => s.id === 'evening').brightness === 75, 'Server: Flur mit intelligentem Licht im Probelauf, Werte übernommen', pl.smart);
ok(snap.setup.assistants.light.done, 'Server: Licht als eingerichtet markiert');
await as.locator('footer .btn.primary', { hasText: 'Fertig' }).click();
ok(await until(async () => (await as.count()) === 0, 5000), 'Fertig schließt den Assistenten');
// the area: intelligent light of the room and a way back into the assistant
// the room's tile opens its pop-up, "Intelligentes Licht" in there the smart light
await p.locator('hr-light-plans .rl-tile', { hasText: 'Flur' }).locator('.rl-open').click();
await sleep(500);
await p.locator('hr-light-plans .rl-item', { hasText: 'Intelligentes Licht' }).first().click();
await sleep(500);
const smart = p.locator('hr-light-smart');
ok(await until(async () => (await p.locator('hr-pop[heading*="Intelligentes Licht"]').count()) > 0 && (await smart.count()) > 0, 5000), 'Bereich zeigt „Intelligentes Licht“');
ok((await smart.locator('.seg button[aria-pressed="true"]').textContent()).includes('Probelauf'), 'im Probelauf');
ok((await smart.locator('text=Warum ist das Licht so?').count()) > 0, '„Warum ist das Licht so?“ je Licht');
if (out) await p.screenshot({ path: join(out, 'A04-licht-bereich.png'), fullPage: true });
// "Assistent erneut starten" sits behind the page's gear
for (let i = 0; i < 4 && (await p.locator('hr-sheet').count()); i++) await p.keyboard.press('Escape');
await p.locator('house-rules-panel .page-gear').click();
await sleep(500);
const again = p.locator('hr-light-plans button', { hasText: 'Assistent erneut starten' });
ok((await again.count()) > 0, '„Assistent erneut starten“ im Seiten-Zahnrad');
await again.first().click();
ok(await until(async () => (await as.count()) > 0, 5000), 'startet den Assistenten erneut');
await as.locator('header .icon-btn').click();
ok(await until(async () => (await as.count()) === 0, 5000), '✕ schließt');
await p.reload();
await p.waitForSelector('house-rules-panel', { timeout: 30000 });
await sleep(4000);
ok((await as.count()) === 0, 'eingerichtet: öffnet sich nicht mehr von selbst');
ok(!errors.length, 'keine Fehler auf der Seite', errors);
await browser.close();

// back to neutral
snap = await snapshot();
for (const r of snap.rooms) await ws.call({ type: 'house_rules/plan/set', kind: 'light', room: r.id, plan: { ...snap.plans.light[r.id], on: false, rules: [], smart: { mode: 'off' } } });
await ws.call({ type: 'house_rules/assistant/mark', feature: 'light', done: false, dismissed: false });
await ws.call({ type: 'house_rules/assistant/mark', feature: 'vacation', dismissed: false });
await ws.call({ type: 'house_rules/features/set', features: features0 });
ws.close();
console.log(`\n${failures() ? `${failures()} FEHLER` : 'alles ok'}`);
process.exit(failures() ? 1 : 0);
