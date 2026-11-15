// Lamps, heaters, fans & co. linked to (simulated) entities. Temporary in-page config only; states are faked,
// service calls intercepted — nothing is switched or saved.
import { openHA, tapAt } from '../pw.mjs';
const out = process.argv[2] ?? '/tmp';
const scheme = process.argv[3] ?? 'light';
const { browser, page, errors, calls } = await openHA({ size: '1280x800', scheme, kiosk: true, block: ['light', 'climate', 'fan', 'switch', 'humidifier', 'media_player', 'homeassistant', 'input_boolean'] });
const ok = (c, m) => console.log(c ? '• ok:' : '• FAIL:', m);
const FIND = `const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } };`;
const card = (expr) => page.evaluate(`(() => { ${FIND} const card = find(document); const plan = card.shadowRoot.querySelector('fp-plan'); return ${expr}; })()`);

const FAKE = {
  'light.fp_floor': { state: 'on', attributes: { brightness: 230, color_mode: 'rgb', rgb_color: [255, 196, 120], friendly_name: 'Stehlampe' } },
  'light.fp_ceiling': { state: 'on', attributes: { brightness: 200, color_mode: 'rgb', rgb_color: [255, 240, 220], friendly_name: 'Deckenlampe' } },
  'light.fp_strip': { state: 'on', attributes: { brightness: 255, color_mode: 'rgb', rgb_color: [150, 90, 255], friendly_name: 'LED' } },
  'light.fp_table': { state: 'on', attributes: { brightness: 140, color_mode: 'rgb', rgb_color: [255, 170, 90], friendly_name: 'Tischlampe' } },
  'light.fp_wall': { state: 'off', attributes: { friendly_name: 'Wandlampe' } },
  'climate.fp_heat': { state: 'heat', attributes: { hvac_action: 'heating', friendly_name: 'Heizung' } },
  'fan.fp_ceiling': { state: 'on', attributes: { percentage: 70, friendly_name: 'Deckenventilator' } },
  'fan.fp_purifier': { state: 'on', attributes: { percentage: 40, friendly_name: 'Luftreiniger' } },
  'switch.fp_heater': { state: 'on', attributes: { friendly_name: 'Heizlüfter' } },
  'media_player.fp_tv': { state: 'playing', attributes: { friendly_name: 'TV' } },
};

await page.evaluate(`(() => { ${FIND} const card = find(document);
  const fake = ${JSON.stringify(FAKE)};
  const orig = card.optimistic.get.bind(card.optimistic);
  card.optimistic.get = (h, id) => fake[id] ? { entity_id: id, last_changed: '', last_updated: '', context: {}, ...fake[id] } : orig(h, id);
  window.__fpFake = fake;
  const f0 = card.rawConfig.floors[0];
  const room = (n) => f0.rooms.find((r) => r.name === n);
  const box = (r) => { const xs = r.points.map((p) => p[0]), ys = r.points.map((p) => p[1]); return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }; };
  const L = box(room('Wohnzimmer')), K = box(room('Küche'));
  const cx = (L.x0 + L.x1) / 2, cy = (L.y0 + L.y1) / 2;
  const kx = (K.x0 + K.x1) / 2, ky = (K.y0 + K.y1) / 2;
  const add = [
    { id: 'fx1', kind: 'floor_lamp', x: L.x0 + 40, y: L.y1 - 45, w: 40, h: 40, entity: 'light.fp_floor' },
    { id: 'fx2', kind: 'ceiling_lamp', x: cx, y: cy, w: 50, h: 50, entity: 'light.fp_ceiling' },
    // at 60 cm (e.g. under a shelf): below the 90 cm the overview cuts the walls at (its default 90 cm would hide it there)
    { id: 'fx3', kind: 'light_strip', x: cx, y: L.y0 + 6, w: 180, h: 3, elevation: 60, entity: 'light.fp_strip' },
    { id: 'fx4', kind: 'table_lamp', x: L.x1 - 40, y: L.y1 - 40, w: 30, h: 30, entity: 'light.fp_table' },
    { id: 'fx5', kind: 'wall_lamp', x: L.x1 - 10, y: cy, w: 22, h: 12, rotation: 90, entity: 'light.fp_wall' },
    { id: 'fx6', kind: 'radiator', x: kx, y: K.y0 + 9, w: 100, h: 10, entity: 'climate.fp_heat' },
    { id: 'fx7', kind: 'ceiling_fan', x: kx, y: ky + 20, w: 120, h: 120, entity: 'fan.fp_ceiling' },
    { id: 'fx8', kind: 'air_purifier', x: K.x0 + 35, y: K.y1 - 35, w: 30, h: 30, entity: 'fan.fp_purifier' },
    { id: 'fx10', kind: 'tv', variant: 'wall', x: cx, y: L.y0 + 8, w: 145, h: 6, entity: 'media_player.fp_tv' },
    { id: 'fx9', kind: 'space_heater', x: K.x1 - 40, y: K.y1 - 30, w: 34, h: 20, rotation: 180, entity: 'switch.fp_heater' },
  ];
  window.__fpAdd = add;
  // the plan's own device markers and linked pieces would sit on top of the test lamps: left out here
  card.setConfig({ ...card.rawConfig, floors: card.rawConfig.floors.map((f, i) => (i ? f : { ...f, devices: [], furniture: [...(f.furniture ?? []).filter((x) => !x.entity), ...add] })) });
})()`);
await page.waitForTimeout(1500);

// 3D models come from chunks and may arrive a moment later (software WebGL keeps the page busy)
const idle = () => card(`['fx1','fx2','fx3','fx4','fx6','fx7','fx8','fx9'].filter((id) => !plan.pieceInfo(id)?.fx)`);
for (let i = 0; i < 16 && (await idle()).length; i++) await page.waitForTimeout(250);
const off3 = await idle();
ok(!off3.length, `3D: pieces show their live state (${8 - off3.length} of 8 active${off3.length ? `; not: ${off3.join(', ')}` : ''})`);
ok(await card(`!plan.pieceRect('fx10') === ((card._config.wall_height ?? 90) <= 100)`), 'wall TV above the cut height is hidden in the overview');
ok(await card(`[...plan.shadowRoot.querySelectorAll('.ffxs .ffx')].length`) >= 9, 'floor effects for the 9 active pieces (wall lamp is off)');
ok(await card(`plan.pieceInfo('fx1').fx === 'light' && plan.pieceInfo('fx1').emissive > 0`), 'lamp shade emits light in 3D');
ok(await card(`!plan.pieceInfo('fx5')?.fx`), 'switched-off lamp stays neutral (wall lamp above the cut: hidden in the overview)');
ok(await card(`!!plan.shadowRoot.querySelector('.piece.fx-fan .blades')`), 'ceiling fan blades spin');
// the ceiling lamp floats above the cut-away walls
const z = await card(`plan.pieceInfo('fx2')?.z`);
ok(z > 90, `ceiling lamp floats above the cut-away walls (z=${z})`);
await page.screenshot({ path: `${out}/fx-3d-${scheme}.png` });
// 3D: tapping the floor below the floating ceiling lamp must not switch the lamp
const below = await card(`(() => { const r = plan.shadowRoot.querySelector('.piece[data-furniture="fx2"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
await tapAt(page, below[0], below[1]);
await page.waitForTimeout(600);
ok(!(await calls()).some((c) => JSON.stringify(c.target ?? c.data ?? {}).includes('fp_ceiling')), '3D: tap on the floor below the ceiling lamp does not switch it');
// tapping the lamp body itself does (back to the overview first: rooms may zoom on tap)
console.log('  room tap after floor tap:', await card(`plan.focused ? 'zoomed into the room' : 'no zoom'`));
await card(`(plan.resetView(), true)`);
await page.waitForTimeout(1200);
const body = await card(`(() => { const r = plan.pieceRect('fx2'); for (let fy = 0.5; fy > 0.1; fy -= 0.1) for (let fx = 0.5; fx < 0.9; fx += 0.1) { const x = r.x + r.w * fx, y = r.y + r.h * fy; if (plan.pieceAt(x, y) === 'fx2') return [x, y]; } })()`);
await tapAt(page, body[0], body[1]);
await page.waitForTimeout(600);
ok((await calls()).some((c) => JSON.stringify(c.target ?? c.data ?? {}).includes('fp_ceiling')), '3D: tap on the lamp itself switches it');
await page.evaluate(() => (window.__fpCalls.length = 0));

// 2D
await card(`(plan.viewMode = '2d', true)`);
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/fx-2d-${scheme}.png` });
// tap the floor lamp -> light.toggle (intercepted)
const pt = await card(`(() => { const r = plan.shadowRoot.querySelector('.piece[data-furniture="fx1"] .fhit').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
await tapAt(page, pt[0], pt[1]);
await page.waitForTimeout(600);
const c1 = (await calls()).filter((c) => c.domain === 'light');
ok(c1.length === 1 && c1[0].service === 'toggle' && JSON.stringify(c1[0].target ?? c1[0].data).includes('light.fp_floor'), `tap on the floor lamp toggles it (${JSON.stringify(c1.map((c) => c.domain + '.' + c.service))})`);
// tap the radiator -> climate popup (no service call)
const pr = await card(`(() => { const r = plan.shadowRoot.querySelector('.piece[data-furniture="fx6"] .fhit').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
await tapAt(page, pr[0], pr[1]);
await page.waitForTimeout(700);
const popup = await page.evaluate(() => !!document.querySelector('floorplan-card-layer')?.shadowRoot?.querySelector('.sheet, fp-popup-climate, [class*=popup]'));
ok(popup && !(await calls()).some((c) => c.domain === 'climate'), 'tap on the radiator opens the climate controls');
await page.screenshot({ path: `${out}/fx-popup-${scheme}.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
console.log(errors.length ? errors.join('\n') : 'console: keine Fehler/Warnungen');
await browser.close();
