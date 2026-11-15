// One source with Hausregeln, on the mock harness (no Home Assistant; neutral demo home, Hausregeln faked):
// a room's lights and thermostat come from Hausregeln' room assignment (the stored card config stays as it is),
// a person's phone from its person list, the editor shows those instead of its own lists, offers the window
// warning only through Hausregeln, and changes an object's kind with categories and search.
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/hr-sources.mjs [outDir]
import * as esbuild from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openMock, demoHome, demoStates } from './mock.mjs';
import { KNOWN } from '../pw.mjs';

const out = process.argv[2] ?? '/tmp';
let fails = 0;
const ok = (c, m, extra) => {
  if (!c) fails++;
  console.log(c ? '• ok:' : '• FAIL:', m, !c && extra !== undefined ? JSON.stringify(extra) : '');
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the bridge on its own (node): rooms, groups vs. lamps, phones ----------
const dir = mkdtempSync(join(tmpdir(), 'fphr-'));
writeFileSync(
  join(dir, 'e.ts'),
  `import { houseRules, hrRoom, hrPhone, withHrRooms } from ${JSON.stringify(resolve('src/house-rules.ts'))};
import { phoneOf } from ${JSON.stringify(resolve('src/walk-notify.ts'))};
let push: (m: unknown) => void = () => {};
const states: Record<string, unknown> = {
  'light.grp': { state: 'off', attributes: { entity_id: ['light.a', 'light.b'] } },
  'light.a': { state: 'off', attributes: {} }, 'light.b': { state: 'off', attributes: {} },
  'person.demo': { state: 'home', attributes: { device_trackers: [] } },
};
const hass: any = { states, entities: {}, devices: {}, services: { notify: { mobile_app_other: {} } }, connection: { subscribeMessage: (cb: any) => ((push = cb), Promise.resolve(() => {})) }, callWS: (m: any) => (m.type === 'house_rules/info' ? Promise.resolve({ loaded: true, api: 1 }) : Promise.reject(new Error('no'))) };
const room = { id: 'r', area: 'wz', points: [], lights: ['light.own'], climate: 'climate.own', temperature: 'sensor.own' };
const cfg: any = { type: 'x', floors: [{ id: 'f', rooms: [room, { id: 'o', points: [] }], devices: [] }] };
const before = { room: hrRoom(room as any, hass), phone: phoneOf(hass, 'person.demo') ?? null };
await houseRules(hass).start();
push({ kind: 'snapshot', devices: [{ entity_id: 'light.grp', kind: 'light', room: 'wz' }, { entity_id: 'light.a', kind: 'light', room: 'wz' }, { entity_id: 'light.b', kind: 'light', room: 'wz' }, { entity_id: 'climate.hr', kind: 'climate', room: 'wz' }, { entity_id: 'light.x', kind: 'light', room: null }],
  plans: { heat: { wz: { on: true, thermostats: [], sensor: 'sensor.hr' } } }, persons: [{ id: 'demo', entity_id: 'person.demo', phone: 'mobile_app_demo' }] });
const after = hrRoom(room as any, hass);
const v1 = houseRules(hass).roomsVersion;
push({ kind: 'update', plans: { heat: { wz: { on: true, thermostats: [], sensor: 'sensor.hr' } } } });
const shown = withHrRooms(cfg, hass);
console.log(JSON.stringify({ before, after, same: hrRoom(room as any, hass) === after, v1, v2: houseRules(hass).roomsVersion, phone: hrPhone(hass, 'person.demo'), viaWalk: phoneOf(hass, 'person.demo'), stored: room.lights, other: shown.floors[0].rooms[1] === cfg.floors[0].rooms[1] }));`,
);
await esbuild.build({ entryPoints: [join(dir, 'e.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'e.mjs'), logLevel: 'warning' });
const u = JSON.parse(execFileSync('node', [join(dir, 'e.mjs')]).toString());
ok(u.before.room.lights[0] === 'light.own' && u.before.phone === null, 'ohne Hausregeln: die eigenen Listen der Karte', u.before);
ok(JSON.stringify(u.after.lights) === '["light.a","light.b"]' && u.after.climate === 'climate.hr' && u.after.temperature === 'sensor.hr', 'mit Hausregeln: Lichter (Lampen statt Gruppe), Thermostat und Raumthermometer aus Hausregeln', u.after);
ok(u.same && u.v1 === u.v2, 'unverändertes Update: dieselben Objekte (nichts zeichnet neu)', u);
ok(u.phone === 'notify.mobile_app_demo' && u.viaWalk === 'notify.mobile_app_demo', 'Handy einer Person aus Hausregeln (auch für die Gassi-Erinnerung)', u);
ok(u.stored[0] === 'light.own' && u.other, 'die gespeicherte Konfiguration bleibt unverändert, Räume ohne Bereich auch', u);

// ---------- in the card ----------
const cfg = demoHome();
const living = cfg.floors[0].rooms.find((r) => r.id === 'living');
Object.assign(living, { area: 'wohnen', lights: ['light.demo_own'], climate: 'climate.demo_own' });
const states = {
  ...demoStates(),
  'light.demo_own': { state: 'off', attributes: { friendly_name: 'Eigene Lampe' } },
  'light.demo_hr1': { state: 'on', attributes: { friendly_name: 'Deckenlicht' } },
  'light.demo_hr2': { state: 'off', attributes: { friendly_name: 'Stehlampe' } },
  'climate.demo_own': { state: 'heat', attributes: { friendly_name: 'Altes Thermostat', current_temperature: 19 } },
  'climate.demo_hr': { state: 'heat', attributes: { friendly_name: 'Thermostat Wohnen', current_temperature: 21 } },
  'sensor.demo_hr_temp': { state: '21.5', attributes: { friendly_name: 'Thermometer Wohnen', device_class: 'temperature', unit_of_measurement: '°C' } },
};
const areas = { wohnen: { area_id: 'wohnen', name: 'Wohnen' } };
const snapshot = (features) => ({
  kind: 'snapshot',
  mode: 'home',
  rules: [],
  active: {},
  occupancy: {},
  features,
  devices: [
    { entity_id: 'light.demo_hr1', kind: 'light', room: 'wohnen' },
    { entity_id: 'light.demo_hr2', kind: 'light', room: 'wohnen' },
    { entity_id: 'climate.demo_hr', kind: 'climate', room: 'wohnen' },
  ],
  plans: { light: {}, heat: { wohnen: { on: true, thermostats: [], sensor: 'sensor.demo_hr_temp' } } },
  persons: [],
});
const LAYER = `document.querySelector('floorplan-card-layer').shadowRoot`;
const ED = `${LAYER}.querySelector('floorplan-card-editor-ui')`;
const openEditor = async (page) => {
  await page.evaluate(() => window.__fpCard.shadowRoot.querySelector('.chrome .icon-btn[aria-label="Grundriss bearbeiten"]')?.click());
  await wait(1200);
};
const settingsFold = (page) =>
  page.evaluate(`(async () => { const ed = ${ED}; if (ed._panel !== 'settings') ed.shadowRoot.querySelector('.tool[data-panel="settings"]').click(); await ed.updateComplete; await new Promise((r) => setTimeout(r, 300));
    const f = [...ed.shadowRoot.querySelectorAll('details.fold')].find((d) => /Fenster-Warnung beim Gehen/.test(d.querySelector('summary').textContent)); if (!f) return null; f.open = true; await new Promise((r) => setTimeout(r, 200));
    return { text: f.textContent.replace(/\\s+/g, ' '), button: [...f.querySelectorAll('button.btn')].map((b) => b.textContent.trim()) }; })()`);

for (const run of ['ohne', 'aus', 'an']) {
  const hr = run !== 'ohne';
  const m = await openMock({
    config: { ...cfg, view_mode: '2d' },
    states,
    areas,
    size: '1280x900',
    ...(hr ? { ws: { 'house_rules/info': { version: 'test', api: 1, loaded: true } }, subscribe: { 'house_rules/subscribe': snapshot({ window_warning: run === 'an', alarm: true }) } } : {}),
  });
  const { page } = m;
  await wait(1200);
  if (run !== 'aus') {
    const shown = await m.card(`card._config.floors[0].rooms.find((r) => r.id === 'living')`);
    const stored = await m.card(`card._base.floors[0].rooms.find((r) => r.id === 'living')`);
    const tapLights = await m.card(`card.actionHost.roomLights(card._config.floors[0].rooms.find((r) => r.id === 'living'))`);
    if (hr) {
      ok(JSON.stringify(shown.lights) === '["light.demo_hr1","light.demo_hr2"]' && shown.climate === 'climate.demo_hr' && shown.temperature === 'sensor.demo_hr_temp', 'Karte zeigt Lichter, Thermostat und Thermometer aus Hausregeln', shown);
      ok(JSON.stringify(tapLights) === '["light.demo_hr1","light.demo_hr2"]', '„Raum antippen“ schaltet dieselben Lichter wie der Lichtplan von Hausregeln', tapLights);
      ok(JSON.stringify(stored.lights) === '["light.demo_own"]', 'gespeicherte Konfiguration unverändert (Rückfall ohne Hausregeln)', stored);
    } else ok(JSON.stringify(shown.lights) === '["light.demo_own"]' && shown.climate === 'climate.demo_own', 'ohne Hausregeln: die eigenen Listen der Karte', shown);
  }
  await openEditor(page);
  if (run !== 'aus') {
    await page.evaluate(`${ED}.select({ kind: 'room', id: 'living' })`);
    await wait(500);
    const insp = await page.evaluate(`(() => { const r = ${ED}.shadowRoot; const g = r.querySelector('[data-hr-room]'); return { hr: g ? g.querySelectorAll('.row').length : 0, add: !!r.querySelector('.row.add .title.accent') && [...r.querySelectorAll('.row.add .title')].some((t) => /Licht/.test(t.textContent)), draft: ${ED}._draft.floors[0].rooms.find((x) => x.id === 'living').lights }; })()`);
    if (hr) ok(insp.hr === 4 && !insp.add && JSON.stringify(insp.draft) === '["light.demo_own"]', 'Editor: „Aus Hausregeln“ mit 2 Lichtern, Thermostat, Thermometer – keine eigene Lichterliste, Entwurf unverändert', insp);
    else ok(insp.hr === 0 && insp.add, 'Editor ohne Hausregeln: eigene Lichterliste wie bisher', insp);
    if (hr) await page.screenshot({ path: `${out}/hr-sources-room.png` });
  }
  const fold = await settingsFold(page);
  if (run === 'ohne') ok(fold && /Haustür/.test(fold.text) && !/Hausregeln/.test(fold.text), 'Fenster-Warnung ohne Hausregeln: eigene Einstellungen der Karte', fold?.text.slice(0, 120));
  if (run === 'aus') ok(fold && fold.button.includes('In Hausregeln einschalten') && !/Haustür/.test(fold.text), 'Hausregeln da, Warnung aus: nur „In Hausregeln einschalten“, keine zweite Einrichtung in der Karte', fold);
  if (run === 'an') ok(fold && fold.button.includes('In Hausregeln einstellen') && !/Haustür/.test(fold.text), 'Hausregeln warnt: nur der Verweis', fold);
  if (run === 'aus') {
    // a warning the card already has stays editable until Hausregeln takes over
    await page.evaluate(`${ED}.mutate((x) => (x.entry_alert = { door: 'door1' }))`);
    await wait(300);
    const f2 = await settingsFold(page);
    ok(f2 && f2.button.includes('In Hausregeln einschalten') && /Eigene Warnung der Karte/.test(f2.text) && /Haustür/.test(f2.text), 'schon eingerichtete Warnung der Karte bleibt bearbeitbar, mit Hinweis auf Hausregeln', f2?.text.slice(0, 160));
    await page.screenshot({ path: `${out}/hr-sources-warning.png` });
  }
  if (run === 'ohne') {
    // kind picker: categories and search instead of one long list
    await page.evaluate(`${ED}.select({ kind: 'furniture', id: 'sofa' })`);
    await wait(500);
    await page.evaluate(`${ED}.shadowRoot.querySelector('.kind-pick').click()`);
    await wait(400);
    const pk = await page.evaluate(`(() => { const p = ${ED}.shadowRoot.querySelector('.picker.kinds'); return p && { chips: p.querySelectorAll('.cat-chips .chip').length, tiles: p.querySelectorAll('.furn').length, current: p.querySelector('.furn[aria-pressed="true"]')?.dataset.kind, cat: p.querySelector('.cat-chips .chip[aria-pressed="true"]')?.textContent.trim() }; })()`);
    ok(pk && pk.chips > 10 && pk.tiles > 3 && pk.current === 'sofa' && pk.cat === 'Wohnen', 'Art wählen: öffnet bei der Kategorie der jetzigen Art, die jetzige ist markiert', pk);
    await page.screenshot({ path: `${out}/hr-sources-kind.png` });
    await page.evaluate(`(() => { const i = ${ED}.shadowRoot.querySelector('.kind-search'); i.value = 'kühlschrank'; i.dispatchEvent(new Event('input')); })()`);
    await wait(300);
    const hit = await page.evaluate(`[...${ED}.shadowRoot.querySelectorAll('.picker.kinds .furn')].map((b) => b.dataset.kind)`);
    ok(hit.includes('fridge') || hit.some((k) => /fridge/.test(k)), 'Suche über alle Arten', hit);
    await page.evaluate(`[...${ED}.shadowRoot.querySelectorAll('.picker.kinds .furn')].find((b) => /fridge/.test(b.dataset.kind)).click()`);
    await wait(300);
    const sofa = await page.evaluate(`${ED}._draft.floors[0].furniture.find((f) => f.id === 'sofa')`);
    ok(/fridge/.test(sofa.kind) && !(await page.evaluate(`!!${ED}.shadowRoot.querySelector('.picker.kinds')`)), 'Tipp wechselt die Art und schließt die Auswahl', sofa);
  }
  const errs = m.errors.filter((e) => !KNOWN.some((r) => r.test(e)));
  ok(!errs.length, errs.length ? `${run}: console: ${errs.join(' | ')}` : `${run}: keine Fehler oder Warnungen`);
  await m.browser.close();
}
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
