// Cars with all their remote functions, the slide confirmation before anything opens, manual entities with icons and
// correcting what the card detects — on the mock harness (no Home Assistant; neutral demo car on a fake device).
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/car-access.mjs [outDir] [light|dark]
// Checks:
//  - the car's functions are found from its device (sunroof, tailgate, frunk, windows, charge flap, lock, doors, horn,
//    lights, pre-climatisation, seat heating, charge limit / current, departure, tyres) and grouped in the overview;
//    the drawing shows the open door and window
//  - opening (popup buttons, the lock, a direct toggle / perform-action on the plan, the garage door) never sends
//    anything on a tap: the sheet names what opens, a tap on its knob or "cancel" sends nothing, sliding sends exactly
//    one call; closing and locking send at once
//  - a manual device with its own icon shows that icon on the plan; the editor's icon picker sets it
//  - car: exclude an entity and put another into a group with own name and icon → stored in the config, shown so
//  - room suggestions from the area: the car's doors never, removing a suggestion keeps it out
//  - front door warning: a window can be left out (stored in the config)
//  - open / closed of numeric status codes (Mercedes-style: window 2 / sunroof 0 / charge flap 1 = closed), text states,
//    covers and "… closed" binary sensors without device class: closed never counts as open (no red on the car)
import * as esbuild from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openMock, demoHome, demoStates, demoEntities, demoCar } from './mock.mjs';
import { KNOWN } from '../pw.mjs';

const out = process.argv[2] ?? '/tmp';
const scheme = process.argv[3] ?? 'light';
let fails = 0;
const ok = (c, m) => {
  if (!c) fails++;
  console.log(c ? '• ok:' : '• FAIL:', m);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const LAYER = `document.querySelector('floorplan-card-layer').shadowRoot`;
const POP = `${LAYER}.querySelector('fp-car-popup').shadowRoot`;

// ---------- open / closed interpretation (no browser) ----------
{
  const dir = mkdtempSync(join(tmpdir(), 'fp-car-'));
  await esbuild.build({ entryPoints: [resolve('src/car-info.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'car-info.mjs'), logLevel: 'warning' });
  const { carOpen, carOpenSig, isOpenState } = await import(join(dir, 'car-info.mjs'));
  // a neutral car whose integration reports like mbapi2020 (numeric codes, an inverted "windows closed" sensor)
  const mk = (over = {}) => {
    const S = {
      'sensor.test_car_state_of_charge': ['80', { unit_of_measurement: '%', device_class: 'battery' }],
      'sensor.test_car_window_status_front_left': ['2', {}],
      'sensor.test_car_window_status_front_right': ['2', {}],
      'sensor.test_car_window_status_rear_left': ['2', {}],
      'sensor.test_car_window_status_rear_right': ['2', {}],
      'sensor.test_car_window_status_rear_left_blind': ['1', {}],
      'binary_sensor.test_car_windows_closed': ['on', { friendly_name: 'Test car Windows Closed', windowstatusfrontleft: 2 }],
      'cover.test_car_windows': ['closed', { device_class: 'window', current_position: 0 }],
      'sensor.test_car_sunroof_status': ['0', {}],
      'sensor.test_car_charge_flap_dc_status': ['1', {}],
      'sensor.test_car_charge_coupler_ac_status': ['2', {}],
      'sensor.test_car_charge_coupler_ac_lock_status': ['1', {}],
      'binary_sensor.test_car_deck_lid': ['off', { device_class: 'opening' }],
      ...over,
    };
    const states = {};
    const entities = {};
    for (const [id, [state, attributes]] of Object.entries(S)) {
      states[id] = { entity_id: id, state, attributes };
      entities[id] = { entity_id: id, device_id: 'dev_test_car', platform: 'mbapi2020' };
    }
    return { states, entities };
  };
  const f = { id: 'tc', type: 'car', entity: 'sensor.test_car_state_of_charge' };
  const run = (over) => {
    const hass = mk(over);
    return carOpen(hass, f, (id) => hass.states[id]);
  };
  const shut = run();
  ok(carOpenSig(shut) === '0'.repeat(12) && shut.windows.every((w) => w === false) && shut.sunroof === false && shut.flap === false && shut.trunk === false, `numeric codes, all closed → nothing open (${JSON.stringify(shut)})`);
  const open = run({ 'sensor.test_car_window_status_rear_left': ['1', {}], 'sensor.test_car_window_status_front_right': ['0', {}], 'sensor.test_car_sunroof_status': ['2', {}], 'sensor.test_car_charge_flap_dc_status': ['0', {}] });
  ok(open.windows[2] === true && open.windows[1] === true && open.windows[0] === false && open.sunroof === true && open.flap === true, `open codes (window 1 / 0, sunroof 2, flap 0) → open (${JSON.stringify(open)})`);
  const odd = run({ 'sensor.test_car_window_status_front_left': ['7', {}], 'sensor.test_car_sunroof_status': ['unavailable', {}] });
  ok(odd.windows[0] === false && odd.sunroof === undefined, `unknown code → never open (falls back to the closed "windows" entity), unavailable → unknown (${JSON.stringify(odd)})`);
  // per-window values missing: the aggregated entity counts
  const agg = run(Object.fromEntries(['front_left', 'front_right', 'rear_left', 'rear_right'].map((p) => [`sensor.test_car_window_status_${p}`, ['unknown', {}]])));
  ok(agg.windows.every((w) => w === false), `no per-window values → the "windows" entity decides (closed) (${JSON.stringify(agg.windows)})`);
  const st = (id, state, attributes = {}) => isOpenState({ entity_id: id, state, attributes });
  ok(st('sensor.x_charge_flap', 'closed') === false && st('sensor.x_charge_flap', 'Geschlossen') === false && st('sensor.x_lid', 'offen') === true && st('sensor.x_lid', 'open') === true, 'text states: closed / geschlossen → closed, open / offen → open');
  ok(st('binary_sensor.x_windows_closed', 'on') === false && st('binary_sensor.x_windows_closed', 'off') === true && st('binary_sensor.x_window', 'on', { device_class: 'window' }) === true && st('binary_sensor.x_window', 'off', { device_class: 'window' }) === false, 'binary sensors: "… closed" on = closed, device class window on = open');
  ok(st('cover.x_windows', 'closed', { current_position: 0 }) === false && st('sensor.x_window', '2') === undefined && st('sensor.x_window', '30', { unit_of_measurement: '%' }) === true, 'covers by state, numeric codes of unknown integrations → unknown, percent > 0 → open');
}

const car = demoCar();
const cfg = demoHome();
const floor = cfg.floors[0];
floor.rooms.find((r) => r.id === 'garage').area = 'garage';
floor.furniture = floor.furniture.map((p) => (p.id === 'car' ? { ...p, entity: 'sensor.demo_car_state_of_charge', entities: undefined } : p));
floor.openings = floor.openings.map((o) => (o.id === 'door1' ? { ...o, entity: 'binary_sensor.demo_front_door' } : o.id === 'win1' ? { ...o, entity: 'binary_sensor.demo_window_living' } : o));
floor.openings.push({ id: 'win2', type: 'window', a: [700, 0], b: [820, 0], entity: 'binary_sensor.demo_window_kitchen' });
floor.devices = [
  { id: 'dev_rocket', entity: 'light.demo_garage', icon: 'mdi:rocket-launch', x: 1250, y: 120 },
  { id: 'dev_trunk', entity: 'cover.demo_car_trunk', x: 1300, y: 500, tap_action: { action: 'toggle' } },
  { id: 'dev_lock', entity: 'lock.demo_car_door_lock', x: 1400, y: 500, tap_action: { action: 'toggle' } },
  { id: 'dev_pa', entity: 'light.demo_garden', x: 400, y: 600, tap_action: { action: 'perform-action', perform_action: 'lock.unlock', target: { entity_id: 'lock.demo_car_door_lock' } } },
];
cfg.entry_alert = { door: 'door1', server: false };
const states = {
  ...demoStates(),
  ...car.states,
  'binary_sensor.demo_front_door': { state: 'off', attributes: { friendly_name: 'Haustür', device_class: 'door' } },
  'binary_sensor.demo_window_living': { state: 'off', attributes: { friendly_name: 'Fenster Wohnen', device_class: 'window' } },
  'binary_sensor.demo_window_kitchen': { state: 'off', attributes: { friendly_name: 'Fenster Küche', device_class: 'window' } },
};
const m = await openMock({ config: { ...cfg, view_mode: '2d' }, states, entities: { ...demoEntities, ...car.entities }, devices: car.devices, areas: car.areas, size: '1280x1000', scheme });
const { page } = m;
await wait(1200);

const calls = () => m.calls();
const sheet = () => page.evaluate(`(() => { const a = ${LAYER}.querySelector('.open-confirm'); return a ? { title: a.querySelector('.alert-text').textContent.trim(), text: a.querySelector('.open-text').textContent.trim() } : null; })()`);
const knobBox = () => page.evaluate(`(() => { const s = ${LAYER}.querySelector('fp-slide-confirm'); const k = s.shadowRoot.querySelector('.knob').getBoundingClientRect(); const tr = s.shadowRoot.querySelector('.track').getBoundingClientRect(); return { x: k.x + k.width / 2, y: k.y + k.height / 2, end: tr.right - 6 }; })()`);
const slide = async (portion = 1) => {
  const b = await knobBox();
  await page.mouse.move(b.x, b.y);
  await page.mouse.down();
  const steps = 12;
  for (let i = 1; i <= steps; i++) await page.mouse.move(b.x + ((b.end - b.x) * portion * i) / steps, b.y);
  await page.mouse.up();
  await wait(350);
};
const tapKnob = async () => {
  const b = await knobBox();
  await page.mouse.click(b.x, b.y);
  await page.mouse.dblclick(b.x, b.y);
  await wait(300);
};
const cancelSheet = async () => {
  await page.evaluate(`${LAYER}.querySelector('.open-cancel').click()`);
  await wait(300);
};

// ---------- the plan: manual device with its own icon ----------
const rocket = await m.card(`plan.shadowRoot.querySelector('[data-device="dev_rocket"] ha-icon')?.icon`);
ok(rocket === 'mdi:rocket-launch', `manual device shows its own icon on the plan (${rocket})`);
// the car on the plan shows what is open (front left door, rear left window)
const marks = await m.card(`plan.shadowRoot.querySelectorAll('[data-furniture="car"] .car-open').length`);
ok(marks === 2, `2D car: open door and window drawn (${marks})`);
await m.setStates({ 'cover.demo_car_trunk': { state: 'open' } });
const marks2 = await m.card(`plan.shadowRoot.querySelectorAll('[data-furniture="car"] .car-open').length`);
ok(marks2 === 3, `2D car: tailgate opened → drawn open (${marks2})`);
await m.setStates({ 'cover.demo_car_trunk': { state: 'closed' } });

// ---------- car overview ----------
await m.card(`(card.actionHost.openPopup({ car: card.rawConfig.floors[0].furniture.find((f) => f.id === 'car') }), true)`);
await wait(900);
const txt = await page.evaluate(`${POP}.textContent.replace(/\\s+/g, ' ')`);
ok(/76/.test(txt) && /312 km/.test(txt), 'battery and range');
const groups = await page.evaluate(`[...${POP}.querySelectorAll('[data-group]')].map((g) => g.dataset.group)`);
ok(['access', 'climate', 'charge', 'status'].every((g) => groups.includes(g)), `groups Öffnen & Schließen, Klima, Laden, Zustand (${groups.join(', ')})`);
const parts = await page.evaluate(`[...${POP}.querySelectorAll('[data-part]')].map((p) => p.dataset.part)`);
ok(['lock', 'trunk', 'frunk', 'sunroof', 'windows', 'charge_flap'].every((p) => parts.includes(p)), `open & close: ${parts.join(', ')}`);
const ents = await page.evaluate(`[...${POP}.querySelectorAll('[data-entity]')].map((p) => p.dataset.entity)`);
for (const id of ['button.demo_car_honk_horn', 'button.demo_car_flash_lights', 'switch.demo_car_preconditioning', 'switch.demo_car_seat_heater_left', 'select.demo_car_seat_heater_right', 'number.demo_car_charging_current', 'time.demo_car_departure_time', 'sensor.demo_car_interior_temperature'])
  ok(ents.includes(id), `found ${id}`);
ok(await page.evaluate(`!!${POP}.querySelector('[data-limit="80"][aria-pressed="true"]')`), 'charge limit chips (80 % chosen)');
ok(/2,4 bar|2.4 bar/.test(txt) && /Reifendruck/.test(txt), 'tyre pressures');
const drawing = await page.evaluate(`({ door: ${POP}.querySelector('[data-door="fl"]')?.getAttribute('class'), door2: ${POP}.querySelector('[data-door="fr"]')?.getAttribute('class'), win: ${POP}.querySelector('[data-window="rl"]')?.getAttribute('class'), roof: ${POP}.querySelector('[data-lid="sunroof"]')?.getAttribute('class') })`);
ok(/open/.test(drawing.door) && /shut/.test(drawing.door2) && /open/.test(drawing.win) && /shut/.test(drawing.roof), `drawing: front left door + rear left window open, rest closed (${JSON.stringify(drawing)})`);
await page.waitForFunction(`getComputedStyle(${LAYER}.querySelector('.sheet')).opacity === '1'`, null, { timeout: 8000 }).catch(() => {});
await page.waitForFunction(`!!${POP}.querySelector('.shot')`, null, { timeout: 8000 }).catch(() => {});
ok((await page.evaluate(`${POP}.querySelector('.shot')?.src?.slice(0, 22) ?? ''`)).startsWith('data:image/png'), 'overview shows a rendering of the 3D model');
await page.screenshot({ path: `${out}/car-popup-${scheme}.png` });
// pre-climatisation and charge limit: exactly one call each, no sheet
await m.clearCalls();
await page.evaluate(`${POP}.querySelector('.action[data-action="pre"]').click()`);
await wait(300);
let c0 = await calls();
ok(c0.length === 1 && c0[0].domain === 'switch' && c0[0].service === 'turn_on' && c0[0].target?.entity_id === 'switch.demo_car_preconditioning' && !(await sheet()), 'pre-climatisation: one switch.turn_on');
await m.clearCalls();
await page.evaluate(`${POP}.querySelector('[data-limit="70"]').click()`);
await wait(300);
c0 = await calls();
ok(c0.length === 1 && c0[0].domain === 'number' && c0[0].data?.value === 70, 'charge limit 70 %: one number.set_value');

// ---------- opening needs the slide ----------
await m.clearCalls();
await page.evaluate(`${POP}.querySelector('[data-part="sunroof"] [data-op="open"]').click()`);
await wait(400);
let sh = await sheet();
ok(!!sh && /Schiebedach/.test(sh.title) && /Auto/.test(sh.text) && (await calls()).length === 0, `sunroof: tap shows the sheet, nothing sent ("${sh?.title}" – "${sh?.text}")`);
await page.screenshot({ path: `${out}/car-open-confirm-${scheme}.png` });
await tapKnob();
ok((await calls()).length === 0 && !!(await sheet()), 'tap / double tap on the knob: nothing sent, sheet stays');
await slide(0.6);
ok((await calls()).length === 0 && !!(await sheet()), 'slid only part of the way: nothing sent');
await cancelSheet();
ok((await calls()).length === 0 && !(await sheet()), 'cancel: nothing sent');
await page.evaluate(`${POP}.querySelector('[data-part="sunroof"] [data-op="open"]').click()`);
await wait(400);
await slide(1);
let c = await calls();
ok(c.length === 1 && c[0].domain === 'cover' && c[0].service === 'open_cover' && c[0].target?.entity_id === 'cover.demo_car_sunroof', `slid to the end: exactly one call (${c.map((x) => `${x.domain}.${x.service} ${x.target?.entity_id}`).join(', ')})`);
ok(!(await sheet()), 'sheet closes after confirming');
await m.clearCalls();
await page.evaluate(`${POP}.querySelector('[data-part="sunroof"] [data-op="close"]').click()`);
await wait(300);
c = await calls();
ok(c.length === 1 && c[0].service === 'close_cover' && !(await sheet()), 'closing: one call at once, no sheet');
// frunk: a button that opens
await m.clearCalls();
await page.evaluate(`${POP}.querySelector('[data-part="frunk"] [data-op="open"]').click()`);
await wait(300);
ok(/Frunk/.test((await sheet())?.title ?? '') && (await calls()).length === 0, 'frunk button: sheet first');
await slide(1);
c = await calls();
ok(c.length === 1 && c[0].domain === 'button' && c[0].target?.entity_id === 'button.demo_car_open_frunk', 'frunk: one button.press after sliding');
// lock: unlock needs the slide, locking is one tap
await m.clearCalls();
await page.evaluate(`${POP}.querySelector('.action[data-action="lock"]').click()`);
await wait(300);
sh = await sheet();
ok(!!sh && (await calls()).length === 0, `unlock: sheet first ("${sh?.title}")`);
await slide(1);
c = await calls();
ok(c.length === 1 && c[0].domain === 'lock' && c[0].service === 'unlock', 'unlocked after sliding: one lock.unlock');
await m.setStates({ 'lock.demo_car_door_lock': { state: 'unlocked' } });
await m.clearCalls();
await page.evaluate(`${POP}.querySelector('.action[data-action="lock"]').click()`);
await wait(300);
c = await calls();
ok(c.length === 1 && c[0].service === 'lock' && !(await sheet()), 'locking: one tap, no sheet');
await m.setStates({ 'lock.demo_car_door_lock': { state: 'locked' } });
// horn: no opening, no sheet
await m.clearCalls();
await page.evaluate(`${POP}.querySelector('[data-entity="button.demo_car_honk_horn"] button').click()`);
await wait(300);
c = await calls();
ok(c.length === 1 && !(await sheet()), `horn: one press, no sheet (${c.map((x) => x.domain + '.' + x.service + ' ' + x.target?.entity_id).join(', ')}; sheet ${JSON.stringify(await sheet())})`);
await page.evaluate(`${POP}.querySelector('.close').click()`);
await wait(600);

// ---------- direct actions on the plan cannot bypass it ----------
for (const [id, label] of [
  ['dev_trunk', 'toggle of the tailgate'],
  ['dev_lock', 'toggle of the car lock'],
  ['dev_pa', 'perform-action lock.unlock'],
]) {
  await m.clearCalls();
  await m.card(`(card.gesture({ kind: 'device', id: '${id}' }, 'tap'), true)`);
  await wait(400);
  ok(!!(await sheet()) && (await calls()).length === 0, `${label} on the plan: sheet, nothing sent`);
  await cancelSheet();
  ok((await calls()).length === 0, `${label}: cancelled, nothing sent`);
}
await m.clearCalls();
await m.card(`(card.gesture({ kind: 'device', id: 'dev_lock' }, 'tap'), true)`);
await wait(400);
await slide(1);
c = await calls();
ok(c.length === 1 && c[0].domain === 'lock' && c[0].service === 'unlock', 'plan toggle of the lock after sliding: exactly one lock.unlock');
// the garage door popup uses the same sheet
await m.clearCalls();
await m.card(`(card.actionHost.openPopup({ entity: 'cover.demo_garage' }), true)`);
await wait(700);
await page.evaluate(`${LAYER}.querySelector('fp-cover-popup').shadowRoot.querySelector('[data-action="open"]').click()`);
await wait(300);
sh = await sheet();
ok(!!sh && /Garagentor/.test(sh.title) && (await calls()).length === 0, `garage door: same sheet ("${sh?.title}")`);
await slide(1);
c = await calls();
ok(c.length === 1 && c[0].service === 'open_cover' && c[0].target?.entity_id === 'cover.demo_garage', 'garage door: one open_cover after sliding');
await page.evaluate(`${LAYER}.querySelector('fp-cover-popup').shadowRoot.querySelector('.close').click()`);
await wait(600);

// ---------- editor ----------
await page.evaluate(() => window.__fpCard.shadowRoot.querySelector('.chrome .icon-btn[aria-label="Grundriss bearbeiten"]')?.click());
await wait(1200);
const ED = `${LAYER}.querySelector('floorplan-card-editor-ui')`;
const EDR = `${ED}.shadowRoot`;
ok(await page.evaluate(`!!${ED}`), 'editor open');
const draft = (expr) => page.evaluate(`(() => { const d = ${ED}._draft; const f = d.floors[0]; return ${expr}; })()`);

// device icon through the picker
await page.evaluate(`${ED}.select({ kind: 'device', id: 'dev_rocket' })`);
await wait(400);
const IP = `${EDR}.querySelector('fp-icon-picker[data-device-icon]').shadowRoot`;
await page.evaluate(`${IP}.querySelector('[data-icon-input]').focus()`);
await wait(200);
await page.evaluate(`(() => { const i = ${IP}.querySelector('[data-icon-input]'); i.value = 'auto'; i.dispatchEvent(new Event('input')); })()`);
await wait(200);
const offered = await page.evaluate(`[...${IP}.querySelectorAll('.ic')].map((b) => b.dataset.icon)`);
ok(offered.includes('mdi:car') && offered.length < 80, `icon search "auto" offers car icons (${offered.length})`);
await page.evaluate(`${IP}.querySelector('.ic[data-icon="mdi:car-side"]').click()`);
await wait(300);
ok((await draft(`f.devices.find((d) => d.id === 'dev_rocket').icon`)) === 'mdi:car-side', 'icon picker sets the device icon in the config');
const planIcon = await page.evaluate(`${EDR}.querySelector('fp-plan').shadowRoot.querySelector('[data-device="dev_rocket"] ha-icon')?.icon`);
ok(planIcon === 'mdi:car-side', `editor plan shows the new icon (${planIcon})`);

// car: exclude, re-categorise, add by hand
await page.evaluate(`${ED}.select({ kind: 'furniture', id: 'car' })`);
await wait(500);
const roles = await page.evaluate(`[...${EDR}.querySelectorAll('[data-car-role]')].map((r) => r.dataset.carRole)`);
ok(['sunroof', 'trunk', 'lock', 'door_fl', 'window_rl', 'preclimate', 'limit', 'tire_rr'].every((r) => roles.includes(r)), `editor lists the detected functions (${roles.length})`);
await page.evaluate(`${EDR}.querySelector('[data-car-role="sunroof"] [data-car-exclude]').click()`);
await wait(300);
ok((await draft(`f.furniture.find((x) => x.id === 'car').exclude`))?.includes('cover.demo_car_sunroof'), 'exclude: stored in the config (exclude)');
ok(!(await page.evaluate(`!!${EDR}.querySelector('[data-car-role="sunroof"]')`)), 'excluded entity no longer detected');
await page.screenshot({ path: `${out}/car-editor-${scheme}.png` });
// re-categorise the odometer: own entry in "Klima" with a name and an icon
await page.evaluate(`${EDR}.querySelector('[data-car-role="odometer"] .pick').click()`);
await wait(300);
const EE = `${EDR}.querySelector('.ent-edit')`;
ok(await page.evaluate(`!!${EE}`), 'entry sheet opens');
await page.evaluate(`(() => { const s = ${EE}.querySelector('[data-ent-role]'); s.value = 'climate'; s.dispatchEvent(new Event('change')); })()`);
await page.evaluate(`(() => { const i = ${EE}.querySelector('[data-ent-name]'); i.value = 'Gefahrene km'; i.dispatchEvent(new Event('input')); })()`);
await wait(150);
const EIP = `${EE}.querySelector('fp-icon-picker').shadowRoot`;
await page.evaluate(`${EIP}.querySelector('[data-icon-input]').focus()`);
await wait(150);
await page.evaluate(`${EIP}.querySelector('.ic[data-icon="mdi:counter"]').click()`);
await wait(150);
await page.screenshot({ path: `${out}/car-entry-sheet-${scheme}.png` });
await page.evaluate(`${EE}.querySelector('[data-ent-save]').click()`);
await wait(300);
const extra = await draft(`f.furniture.find((x) => x.id === 'car').extra`);
ok(extra?.some((x) => x.entity === 'sensor.demo_car_odometer' && x.role === 'climate' && x.name === 'Gefahrene km' && x.icon === 'mdi:counter'), `re-categorised: stored with group, name and icon (${JSON.stringify(extra)})`);
// add any entity by hand (the garden light as an "open & close" entry)
await page.evaluate(`${EDR}.querySelector('[data-car-add]').click()`);
await wait(300);
await page.evaluate(`${EE}.querySelector('.pick').click()`);
await wait(300);
await page.evaluate(`${EDR}.querySelector('.picker fp-entity-list').dispatchEvent(new CustomEvent('entity-select', { detail: { entity: 'switch.demo_socket' } }))`);
await wait(300);
await page.evaluate(`(() => { const s = ${EE}.querySelector('[data-ent-role]'); s.value = 'charge'; s.dispatchEvent(new Event('change')); })()`);
await page.evaluate(`(() => { const i = ${EE}.querySelector('[data-ent-name]'); i.value = 'Wallbox-Strom'; i.dispatchEvent(new Event('input')); })()`);
await wait(150);
await page.evaluate(`${EE}.querySelector('[data-ent-save]').click()`);
await wait(300);
const extra2 = await draft(`f.furniture.find((x) => x.id === 'car').extra`);
ok(extra2?.some((x) => x.entity === 'switch.demo_socket' && x.role === 'charge' && x.name === 'Wallbox-Strom'), 'manual entity added with group and name');

// room: suggestions from the area leave the car out, a removed suggestion stays out
await page.evaluate(`${ED}.select({ kind: 'room', id: 'garage' })`);
await wait(400);
await page.evaluate(`${EDR}.querySelector('.suggest').click()`);
await wait(300);
const room = await draft(`f.rooms.find((r) => r.id === 'garage')`);
const sensors = (room.sensors ?? []).map((s) => s.entity);
ok(sensors.includes('binary_sensor.demo_garage_side_door') && !sensors.some((s) => s.includes('demo_car')) && !String(room.temperature ?? '').includes('demo_car'), `room suggestions: the house door, never the car's doors/sensors (${sensors.join(', ')}; temp ${room.temperature})`);
ok((room.lights ?? []).includes('light.demo_garage'), 'room suggestions: the garage light');
await page.evaluate(`[...${EDR}.querySelectorAll('.icon-btn')].find((b) => b.closest('.row')?.textContent.includes('Garagenlicht'))?.click()`);
await wait(300);
await page.evaluate(`${EDR}.querySelector('.suggest').click()`);
await wait(300);
const room2 = await draft(`f.rooms.find((r) => r.id === 'garage')`);
ok(room2.exclude?.includes('light.demo_garage') && !(room2.lights ?? []).includes('light.demo_garage'), `removed suggestion is remembered (exclude) and not suggested again (${JSON.stringify(room2.exclude)})`);
// re-categorise a room value: the side door gets its own name and icon
await page.evaluate(`${EDR}.querySelector('[data-room-value="binary_sensor.demo_garage_side_door"] .pick').click()`);
await wait(300);
await page.evaluate(`(() => { const i = ${EE}.querySelector('[data-ent-name]'); i.value = 'Seiteneingang'; i.dispatchEvent(new Event('input')); })()`);
await page.evaluate(`${EIP}.querySelector('[data-icon-input]').focus()`);
await wait(150);
await page.evaluate(`${EIP}.querySelector('.ic[data-icon="mdi:door"]').click()`);
await wait(150);
await page.evaluate(`${EE}.querySelector('[data-ent-save]').click()`);
await wait(300);
const room3 = await draft(`f.rooms.find((r) => r.id === 'garage')`);
ok(room3.sensors?.some((s) => s.entity === 'binary_sensor.demo_garage_side_door' && s.name === 'Seiteneingang' && s.icon === 'mdi:door'), 'room value with own name and icon');

// front door warning: leave a window out
await page.evaluate(`${EDR}.querySelector('.tool[data-panel="settings"]')?.click()`);
await wait(400);
await page.evaluate(`[...${EDR}.querySelectorAll('details.fold')].forEach((d) => (d.open = true))`);
await wait(300);
const winRows = await page.evaluate(`${EDR}.querySelectorAll('[data-ea-windows] .row').length`);
ok(winRows === 2, `warning lists the plan's windows (${winRows})`);
await page.evaluate(`${EDR}.querySelector('[data-ea-windows] .row .switch').click()`);
await wait(300);
const ex = await draft(`d.entry_alert?.exclude`);
ok(Array.isArray(ex) && ex.length === 1, `window left out of the warning: stored (${JSON.stringify(ex)})`);

// the corrected car in the overview: sunroof gone, own entries in their groups
const finalCfg = await page.evaluate(`JSON.parse(JSON.stringify(${ED}._draft))`);
await page.evaluate(`${LAYER}.host.closeEditor()`);
await wait(500);
await m.card(`(card.setConfig(${JSON.stringify({ ...finalCfg, view_mode: '2d' })}), true)`);
await wait(800);
await m.card(`(card.actionHost.openPopup({ car: card.rawConfig.floors[0].furniture.find((f) => f.id === 'car') }), true)`);
await wait(900);
const parts2 = await page.evaluate(`[...${POP}.querySelectorAll('[data-part]')].map((p) => p.dataset.part)`);
ok(!parts2.includes('sunroof'), `overview without the excluded sunroof (${parts2.join(', ')})`);
const climateTxt = await page.evaluate(`${POP}.querySelector('[data-group="climate"]')?.textContent.replace(/\\s+/g, ' ') ?? ''`);
ok(/Gefahrene km/.test(climateTxt), 'own entry "Gefahrene km" shown under Klima');
const chargeTxt = await page.evaluate(`${POP}.querySelector('[data-group="charge"]')?.textContent.replace(/\\s+/g, ' ') ?? ''`);
ok(/Wallbox-Strom/.test(chargeTxt), 'manual entity "Wallbox-Strom" shown under Laden');
const icon = await page.evaluate(`${POP}.querySelector('[data-group="climate"] [data-entity="sensor.demo_car_odometer"] ha-icon')?.icon`);
ok(icon === 'mdi:counter', `own icon used (${icon})`);

const errs = m.errors.filter((e) => !KNOWN.some((r) => r.test(e)));
ok(!errs.length, errs.length ? `console: ${errs.join(' | ')}` : 'console: no errors or warnings');
await m.browser.close();
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
