// Mock harness: the card from this checkout's dist/ in a plain page with a fake `hass` — no Home Assistant at all.
// Demo data only (neutral example home). Service calls are recorded in window.__fpCalls and never leave the page.
//   import { openMock } from './mock.mjs';
//   const m = await openMock({ config, states, size: '1280x800', scheme: 'light' });
//   await m.setStates({ 'cover.demo_garage': { state: 'open' } }); await m.calls(); await m.browser.close();
// Optional fake websocket answers (e.g. a fake Hausregeln): ws: { 'house_rules/info': {...} } for callWS (every message sent is in
// window.__fpWs),
// subscribe: { 'house_rules/subscribe': { kind: 'snapshot', ... } } is sent once to a subscription of that type.
// fake: { companion: true } adds an in-page stand-in for the dashboard storage (lovelace/config[/save]) and the companion's
// shared plans and trace images (window.__fpFake holds its data); m.addCard(config) puts a second card on the page.
// Build first: node tools/build.mjs
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGIN = 'http://fp-mock.test';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>html,body{margin:0;height:100%;background:var(--bg)}:root{--bg:#f2f2f7}@media (prefers-color-scheme:dark){:root{--bg:#000}}
#wrap{height:100vh;box-sizing:border-box;padding:8px}floorplan-card{display:block;height:100%}</style></head>
<body><div id="wrap"></div><script type="module" src="/boot.js"></script></body></html>`;

// the page's side: fake hass, a stand-in <ha-icon>, the card
const BOOT = `
customElements.define('ha-icon', class extends HTMLElement {
  connectedCallback() { this.style.cssText = 'display:inline-block;width:var(--mdc-icon-size,24px);height:var(--mdc-icon-size,24px);border-radius:30%;background:currentColor;opacity:.28;flex:none'; }
  set icon(v) { this.dataset.icon = v; } get icon() { return this.dataset.icon; }
});
customElements.define('ha-card', class extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<style>:host{display:block}</style><slot></slot>'; }
});
customElements.define('ha-state-icon', class extends HTMLElement {
  connectedCallback() { this.style.cssText = 'display:inline-block;width:24px;height:24px;border-radius:30%;background:currentColor;opacity:.28'; }
});
const init = window.__fpInit;
window.__fpCalls = [];
// every websocket message the card sent (callWS), for tests that check what goes to the server
window.__fpWs = [];
const now = new Date().toISOString();
const st = (id, s) => ({ entity_id: id, state: String(s.state ?? 'unknown'), attributes: s.attributes ?? {}, last_changed: s.last_changed ?? now, last_updated: now, context: { id: 'mock' } });
let states = Object.fromEntries(Object.entries(init.states).map(([id, s]) => [id, st(id, s)]));
const reject = () => Promise.reject({ code: 'unknown_command', message: 'Unknown command.' });
// stand-in for the dashboard storage and the companion integration (option fake): data in window.__fpFake
const fake = init.fake && (window.__fpFake = { dash: { views: [{ title: 'Demo', cards: [init.config] }] }, plans: {}, images: {}, subs: [], saves: 0, ws: [] });
const fail = (code, message) => Promise.reject({ code, message });
const push = (id) => { for (const s of fake.subs) if (s.id === id) s.cb(structuredClone(fake.plans[id] ?? { id, deleted: true })); };
const fakeWS = async (msg) => {
  fake.ws.push(msg.type);
  const c = fake.companion;
  switch (msg.type) {
    case 'lovelace/config': return structuredClone(fake.dash);
    case 'lovelace/config/save': fake.dash = structuredClone(msg.config); fake.saves++; return null;
    case 'floorplan_card/info': return c ? { version: 'mock', loaded: true, entry_alert: [], pets: {}, vacuums: {}, entry_alert_sig: {}, features: ['plans', 'images'] } : fail('unknown_command', 'Unknown command.');
    case 'floorplan_card/plans/list': return { plans: Object.values(fake.plans).map((p) => ({ id: p.id, name: p.name, rev: p.rev, updated: p.updated, floors: p.plan.floors.length, rooms: p.plan.floors.reduce((n, f) => n + (f.rooms ?? []).length, 0) })) };
    case 'floorplan_card/plans/get': return fake.plans[msg.plan_id] ? structuredClone(fake.plans[msg.plan_id]) : fail('not_found', 'No shared plan with this id');
    case 'floorplan_card/plans/save': {
      const cur = msg.plan_id && fake.plans[msg.plan_id];
      if (cur && msg.rev != null && msg.rev !== cur.rev && !msg.force) return fail('conflict', 'plan was saved elsewhere');
      const id = msg.plan_id ?? 'plan_' + Math.random().toString(16).slice(2, 10);
      const rec = { id, name: msg.name, rev: cur ? cur.rev + 1 : 1, updated: new Date().toISOString(), plan: structuredClone(msg.plan) };
      fake.plans[id] = rec;
      setTimeout(() => push(id), 0);
      return { id, name: rec.name, rev: rec.rev, updated: rec.updated, floors: rec.plan.floors.length, rooms: 0 };
    }
    case 'floorplan_card/plans/delete': { const had = !!fake.plans[msg.plan_id]; delete fake.plans[msg.plan_id]; setTimeout(() => push(msg.plan_id), 0); return { deleted: had }; }
    case 'floorplan_card/images/get': return fake.images[msg.image_id] ? { id: msg.image_id, ...fake.images[msg.image_id] } : fail('not_found', 'No image');
    case 'floorplan_card/images/save': { const id = 'img_' + Math.random().toString(16).slice(2, 10); fake.images[id] = { data: msg.data, width: msg.width, height: msg.height }; return { id, bytes: msg.data.length }; }
    case 'floorplan_card/images/delete': { const had = !!fake.images[msg.image_id]; delete fake.images[msg.image_id]; return { deleted: had }; }
    case 'floorplan_card/entry_alert/remove': case 'floorplan_card/pets/set': case 'floorplan_card/vacuums/set': return { ok: true };
    default: return reject();
  }
};
const fakeSub = (cb, msg) => {
  if (msg.type !== 'floorplan_card/plans/subscribe') return Promise.resolve(() => {});
  const s = { id: msg.plan_id, cb };
  fake.subs.push(s);
  setTimeout(() => cb(structuredClone(fake.plans[msg.plan_id] ?? { id: msg.plan_id, deleted: true })), 0);
  return Promise.resolve(() => (fake.subs = fake.subs.filter((x) => x !== s)));
};
// option subscribe: a first message for a subscription of that type (e.g. a fake Hausregeln snapshot)
const firstMessage = (cb, msg) => {
  const first = init.subscribe?.[msg?.type];
  if (!first) return null;
  setTimeout(() => cb(structuredClone(first)), 0);
  return Promise.resolve(() => {});
};
const connection = { subscribeMessage: (cb, msg) => firstMessage(cb, msg) ?? (fake ? fakeSub(cb, msg) : Promise.resolve(() => {})), sendMessagePromise: reject };
if (fake) fake.companion = !!init.fake.companion;
const makeHass = () => ({
  states,
  entities: init.entities ?? {},
  devices: init.devices ?? {},
  areas: init.areas ?? {},
  floors: {},
  user: { id: 'demo', name: 'Demo', is_admin: true },
  language: init.language,
  locale: { language: init.language, number_format: 'language' },
  themes: { darkMode: init.dark },
  services: {},
  connection,
  callService: (domain, service, data, target) => { window.__fpCalls.push({ domain, service, data, target, t: Date.now() }); return Promise.resolve({ context: { id: 'mock' } }); },
  callWS: (msg) => (window.__fpWs.push(msg), init.ws && msg.type in init.ws ? Promise.resolve(structuredClone(init.ws[msg.type])) : fake ? fakeWS(msg) : reject()),
  callApi: reject,
  hassUrl: (p = '') => p,
  formatEntityState: (s, v) => String(v ?? s.state),
});
window.__fpSetStates = (patch) => {
  const next = { ...states };
  for (const [id, s] of Object.entries(patch)) next[id] = st(id, { ...(next[id] ?? {}), ...s, attributes: { ...(next[id]?.attributes ?? {}), ...(s.attributes ?? {}) }, last_changed: new Date().toISOString() });
  states = next;
  const h = makeHass();
  for (const c of document.querySelectorAll('floorplan-card')) c.hass = h;
};
// a second card on the same page (another dashboard showing a shared plan, say): both share the height
window.__fpAddCard = (config) => {
  const c = document.createElement('floorplan-card');
  c.setConfig(config);
  c.hass = makeHass();
  for (const x of document.querySelectorAll('floorplan-card')) x.style.height = '50%';
  c.style.height = '50%';
  document.getElementById('wrap').appendChild(c);
  return true;
};
await import('/floorplan-card.js');
const el = document.createElement('floorplan-card');
el.setConfig(init.config);
el.hass = makeHass();
document.getElementById('wrap').appendChild(el);
window.__fpCard = el;
`;

export async function openMock({ config, states = {}, entities, devices, areas, size = '1280x800', scheme = 'light', language = 'de', touch = false, fake = null, reducedMotion = 'no-preference', ws, subscribe } = {}) {
  if (!existsSync(join(ROOT, 'dist/floorplan-card.js'))) throw new Error('build first: node tools/build.mjs');
  const [width, height] = size.split('x').map(Number);
  const browser = await chromium.launch({ args: (process.env.PW_ARGS ?? '').split(' ').filter(Boolean) });
  const ctx = await browser.newContext({ deviceScaleFactor: Number(process.env.PW_DPR ?? 1), viewport: { width, height }, colorScheme: scheme, hasTouch: touch, reducedMotion });
  // the companion integration and Hausregeln are absent here (unless `fake` stands in for the companion)
  await ctx.addInitScript((init) => {
    if (!init.fake?.companion) window.__fpNoCompanion = true;
    window.__fpInit = init;
  }, { config, states, entities, devices, areas, language, dark: scheme === 'dark', fake, ws, subscribe });
  await ctx.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ body: PAGE, contentType: 'text/html' });
    if (path === '/boot.js') return route.fulfill({ body: BOOT, contentType: 'text/javascript' });
    const file = join(ROOT, 'dist', path.replace(/^\/+/, ''));
    if (!file.startsWith(join(ROOT, 'dist')) || !existsSync(file)) return route.fulfill({ status: 404, body: '' });
    route.fulfill({ body: readFileSync(file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.glb') ? 'model/gltf-binary' : file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' });
  });
  // nothing else is reachable from the page
  await ctx.route((url) => !url.href.startsWith(ORIGIN), (route) => route.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => window.__fpCard?.shadowRoot?.querySelector('fp-plan, .plan-state'), null, { timeout: 15000 });
  await page.waitForTimeout(600);
  return {
    browser,
    page,
    errors,
    calls: () => page.evaluate(() => window.__fpCalls),
    clearCalls: () => page.evaluate(() => (window.__fpCalls = [])),
    setStates: async (patch) => {
      await page.evaluate((p) => window.__fpSetStates(p), patch);
      await page.waitForTimeout(80);
    },
    addCard: (cfg) => page.evaluate((c) => window.__fpAddCard(c), cfg),
    fake: () => page.evaluate(() => window.__fpFake),
    /** evaluate `expr` with `card` (the card element) and `plan` (its fp-plan) in scope */
    card: (expr) => page.evaluate(`(async () => { const card = window.__fpCard; const plan = card.shadowRoot.querySelector('fp-plan'); return ${expr}; })()`),
  };
}

/** A small neutral demo home: a house, a detached garage with a garage door, a garden on its plot */
export function demoHome() {
  const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  return {
    type: 'custom:floorplan-card',
    card_id: 'demo',
    title: 'Demo',
    height: 'calc(100vh - 16px)',
    view_mode: 'auto',
    effects: 'off',
    floors: [
      {
        id: 'eg',
        name: 'Erdgeschoss',
        rooms: [
          { id: 'plot', name: 'Grundstück', outdoor: true, kind: 'plot', hide_label: true, points: rect(-300, -200, 1700, 1000) },
          { id: 'lawn', name: 'Rasen', outdoor: true, floor: { type: 'grass' }, points: rect(-200, 650, 1100, 990) },
          { id: 'terrace', name: 'Terrasse', outdoor: true, floor: { type: 'decking' }, points: rect(0, 500, 500, 650) },
          { id: 'drive', name: 'Einfahrt', outdoor: true, floor: { type: 'paving' }, points: rect(1150, 600, 1500, 1000) },
          { id: 'living', name: 'Wohnen', floor: { type: 'planks' }, points: rect(0, 0, 600, 500) },
          { id: 'kitchen', name: 'Küche', floor: { type: 'tiles' }, points: rect(600, 0, 1000, 500) },
          { id: 'garage', name: 'Garage', kind: 'garage', floor: { type: 'concrete' }, points: rect(1150, 0, 1500, 600) },
        ],
        devices: [],
        openings: [
          { id: 'door1', type: 'door', a: [250, 500], b: [340, 500] },
          { id: 'win1', type: 'window', a: [100, 0], b: [220, 0] },
          { id: 'gd1', type: 'garage', entity: 'cover.demo_garage', a: [1200, 600], b: [1450, 600] },
        ],
        furniture: [
          { id: 'sofa', kind: 'sofa', x: 300, y: 380, w: 220, h: 95 },
          { id: 'car', kind: 'car', variant: 'compact', name: 'Auto', entities: { location: 'device_tracker.demo_car' }, x: 1325, y: 300, w: 420, h: 180, rotation: 90 },
          { id: 'gate', kind: 'gate', entity: 'cover.demo_gate', x: 1325, y: 960, w: 300, h: 8 },
          { id: 'fence', kind: 'fence', x: 450, y: 996, w: 1300, h: 8 },
          { id: 'dock', kind: 'mower_dock', x: 1000, y: 690, w: 70, h: 60 },
          { id: 'mower', kind: 'lawn_mower', entity: 'lawn_mower.demo_mower', x: 1005, y: 700, w: 62, h: 48 },
          { id: 'zone1', kind: 'irrigation_zone', entity: 'valve.demo_zone_1', x: 300, y: 830, w: 460, h: 300 },
          { id: 'zone2', kind: 'irrigation_zone', variant: 'round', entity: 'valve.demo_zone_2', x: 850, y: 830, w: 260, h: 260 },
          { id: 'tree', kind: 'tree', x: -120, y: 750, w: 260, h: 260 },
          { id: 'hedge', kind: 'bush', variant: 'hedge', x: -250, y: 500, w: 60, h: 600 },
          { id: 'pond', kind: 'pond', x: 1000, y: 940, w: 160, h: 90 },
          { id: 'glight', kind: 'garden_light', entity: 'light.demo_garden', x: 520, y: 640, w: 15, h: 15 },
          { id: 'socket', kind: 'garden_socket', variant: 'post', entity: 'switch.demo_socket', x: 520, y: 690, w: 14, h: 12 },
        ],
      },
    ],
  };
}

export function demoStates() {
  return {
    'cover.demo_garage': { state: 'closed', attributes: { friendly_name: 'Garagentor', device_class: 'garage', supported_features: 15, current_position: 0 } },
    'cover.demo_gate': { state: 'closed', attributes: { friendly_name: 'Einfahrtstor', device_class: 'gate', supported_features: 11 } },
    'device_tracker.demo_car': { state: 'home', attributes: { friendly_name: 'Auto' } },
    'lawn_mower.demo_mower': { state: 'docked', attributes: { friendly_name: 'Mähroboter', supported_features: 7 } },
    'sensor.demo_mower_battery': { state: '84', attributes: { friendly_name: 'Mähroboter Akku', device_class: 'battery', unit_of_measurement: '%' } },
    'valve.demo_zone_1': { state: 'closed', attributes: { friendly_name: 'Rasen vorne', supported_features: 3 } },
    'valve.demo_zone_2': { state: 'closed', attributes: { friendly_name: 'Beet', supported_features: 3 } },
    'light.demo_garden': { state: 'off', attributes: { friendly_name: 'Gartenlicht' } },
    'switch.demo_socket': { state: 'off', attributes: { friendly_name: 'Außensteckdose' } },
  };
}

export const demoEntities = {
  'lawn_mower.demo_mower': { entity_id: 'lawn_mower.demo_mower', device_id: 'dev_mower' },
  'sensor.demo_mower_battery': { entity_id: 'sensor.demo_mower_battery', device_id: 'dev_mower' },
};

/**
 * A neutral demo car with many remote functions on one device (`dev_car`, parked in the garage's area): battery,
 * range, charging, sunroof, tailgate, frunk, windows, charge flap, lock, doors, horn / lights, pre-climatisation,
 * seat heating, charge limit and current, departure time, tyre pressures, location. Names in German like a German
 * HA would show them. Also one house door and a light in the same area (the only ones to suggest for the room).
 */
export function demoCar() {
  const S = {
    'device_tracker.demo_car': ['home', { friendly_name: 'Demo-Auto Standort' }, 'device_tracker'],
    'sensor.demo_car_state_of_charge': ['76', { friendly_name: 'Demo-Auto Ladestand', unit_of_measurement: '%', device_class: 'battery' }, 'state_of_charge'],
    'sensor.demo_car_range': ['312', { friendly_name: 'Demo-Auto Reichweite', unit_of_measurement: 'km', device_class: 'distance' }, 'range_electric'],
    'binary_sensor.demo_car_charging': ['off', { friendly_name: 'Demo-Auto Laden', device_class: 'battery_charging' }, 'charging_active'],
    'sensor.demo_car_odometer': ['23456', { friendly_name: 'Demo-Auto Kilometerstand', unit_of_measurement: 'km', device_class: 'distance' }, 'odometer'],
    'cover.demo_car_sunroof': ['closed', { friendly_name: 'Demo-Auto Schiebedach', supported_features: 3 }, 'sunroof'],
    'cover.demo_car_trunk': ['closed', { friendly_name: 'Demo-Auto Kofferraum', supported_features: 3 }, 'trunk'],
    'button.demo_car_open_frunk': ['unknown', { friendly_name: 'Demo-Auto Frunk öffnen' }, 'open_frunk'],
    'binary_sensor.demo_car_frunk': ['off', { friendly_name: 'Demo-Auto Frunk', device_class: 'opening' }, 'frunk'],
    'cover.demo_car_windows': ['closed', { friendly_name: 'Demo-Auto Fenster', supported_features: 3, device_class: 'window' }, 'windows'],
    'cover.demo_car_charge_port_door': ['closed', { friendly_name: 'Demo-Auto Ladeklappe', supported_features: 3, device_class: 'door' }, 'charge_port_door'],
    'lock.demo_car_door_lock': ['locked', { friendly_name: 'Demo-Auto Türschloss', supported_features: 0 }, 'door_lock'],
    // a car door named like a front door: must never become the house's front door
    'binary_sensor.demo_car_door_front_left': ['on', { friendly_name: 'Demo-Auto Tür vorne links', device_class: 'door' }, 'door_front_left'],
    'binary_sensor.demo_car_door_front_right': ['off', { friendly_name: 'Demo-Auto Tür vorne rechts', device_class: 'door' }, 'door_front_right'],
    'binary_sensor.demo_car_window_rear_left': ['on', { friendly_name: 'Demo-Auto Fenster hinten links', device_class: 'window' }, 'window_rear_left'],
    'button.demo_car_flash_lights': ['unknown', { friendly_name: 'Demo-Auto Lichthupe' }, 'flash_lights'],
    'button.demo_car_honk_horn': ['unknown', { friendly_name: 'Demo-Auto Hupen' }, 'honk_horn'],
    'switch.demo_car_preconditioning': ['off', { friendly_name: 'Demo-Auto Vorklimatisierung' }, 'preconditioning'],
    'switch.demo_car_seat_heater_left': ['off', { friendly_name: 'Demo-Auto Sitzheizung links' }, 'seat_heater_left'],
    'select.demo_car_seat_heater_right': ['off', { friendly_name: 'Demo-Auto Sitzheizung rechts', options: ['off', 'low', 'medium', 'high'] }, 'seat_heater_right'],
    'number.demo_car_charge_limit': ['80', { friendly_name: 'Demo-Auto Ladelimit', min: 50, max: 100, step: 10, unit_of_measurement: '%' }, 'charge_limit'],
    'number.demo_car_charging_current': ['16', { friendly_name: 'Demo-Auto Ladestrom', min: 6, max: 32, step: 1, unit_of_measurement: 'A' }, 'charging_current'],
    'time.demo_car_departure_time': ['07:30:00', { friendly_name: 'Demo-Auto Abfahrtszeit' }, 'departure_time'],
    'sensor.demo_car_tire_pressure_front_left': ['2.8', { friendly_name: 'Demo-Auto Reifendruck vorne links', unit_of_measurement: 'bar', device_class: 'pressure' }, 'tire_pressure_front_left'],
    'sensor.demo_car_tire_pressure_front_right': ['2.8', { friendly_name: 'Demo-Auto Reifendruck vorne rechts', unit_of_measurement: 'bar', device_class: 'pressure' }, 'tire_pressure_front_right'],
    'sensor.demo_car_tire_pressure_rear_left': ['2.9', { friendly_name: 'Demo-Auto Reifendruck hinten links', unit_of_measurement: 'bar', device_class: 'pressure' }, 'tire_pressure_rear_left'],
    'sensor.demo_car_tire_pressure_rear_right': ['2.4', { friendly_name: 'Demo-Auto Reifendruck hinten rechts', unit_of_measurement: 'bar', device_class: 'pressure' }, 'tire_pressure_rear_right'],
    'sensor.demo_car_interior_temperature': ['14.5', { friendly_name: 'Demo-Auto Innenraumtemperatur', unit_of_measurement: '°C', device_class: 'temperature' }, 'interior_temperature'],
  };
  const states = {};
  const entities = {};
  for (const [id, [state, attributes, key]] of Object.entries(S)) {
    states[id] = { state, attributes };
    entities[id] = { entity_id: id, device_id: 'dev_car', platform: 'demo_cars', translation_key: key };
  }
  // the house's side door into the garage and the garage light, in the same area
  states['binary_sensor.demo_garage_side_door'] = { state: 'off', attributes: { friendly_name: 'Seitentür Garage', device_class: 'door' } };
  entities['binary_sensor.demo_garage_side_door'] = { entity_id: 'binary_sensor.demo_garage_side_door', device_id: 'dev_side_door', platform: 'zigbee_demo' };
  states['light.demo_garage'] = { state: 'off', attributes: { friendly_name: 'Garagenlicht' } };
  entities['light.demo_garage'] = { entity_id: 'light.demo_garage', area_id: 'garage', platform: 'zigbee_demo' };
  const devices = { dev_car: { id: 'dev_car', name: 'Demo-Auto', area_id: 'garage' }, dev_side_door: { id: 'dev_side_door', name: 'Seitentür', area_id: 'garage' } };
  const areas = { garage: { area_id: 'garage', name: 'Garage' } };
  return { states, entities, devices, areas };
}
