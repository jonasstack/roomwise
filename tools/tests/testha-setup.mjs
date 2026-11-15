// Prepares the isolated test Home Assistant (127.0.0.1:8124, container hr-test-ha from hausregeln/tools/testha/start.sh)
// for the card's browser tests: rooms as areas, a few extra entities, a shopping list, the card resource (answered from
// dist/ by the test browser) and the dashboard /grundriss-test/grundriss with a neutral demo flat. Idempotent.
// The browser tests always run against it (tools/pw.mjs never opens the production instance; FP_HA_URL + FP_HA_TOKEN
// point them at another test instance).
// Usage (holds the test HA lock together with the tests):
//   sh tools/heavy.sh testha sh -c 'sh hausregeln/tools/testha/start.sh && node tools/tests/testha-setup.mjs && node tools/tests/popups.mjs'
import { token, wsConnect, rest, sleep } from '../../hausregeln/tools/testha/lib.mjs';

// wait until the test HA answers (start.sh only starts the container)
for (let i = 0; ; i++) {
  const up = await fetch('http://127.0.0.1:8124/api/').then((r) => r.status === 401 || r.status === 200, () => false);
  if (up) break;
  if (i > 150) throw new Error('test HA does not come up');
  await sleep(2000);
}
const tok = await token();
const api = rest(tok);
// until Home Assistant has fully started (a connection opened earlier may be dropped during the start)
for (let i = 0; i < 90 && (await api('GET', '/api/config').catch(() => null))?.body?.state !== 'RUNNING'; i++) await sleep(2000);
const ws = await wsConnect(tok);
// the fake devices register a moment after HA answers
for (let i = 0; i < 60 && (await api('GET', '/api/states/light.sofalicht')).status !== 200; i++) await sleep(1000);

// rooms as HA areas (same names as the Hausregeln tests use), with their devices
const areas = await ws.call({ type: 'config/area_registry/list' });
const area = async (name) => (areas.find((a) => a.name === name) ?? (await ws.call({ type: 'config/area_registry/create', name }))).area_id;
const A = { wohnzimmer: await area('Wohnzimmer'), kueche: await area('Küche'), flur: await area('Flur'), bad: await area('Bad'), schlafzimmer: await area('Schlafzimmer') };
const place = {
  wohnzimmer: ['light.sofalicht', 'light.kleines_licht', 'media_player.homepod', 'climate.heizung_wohnzimmer', 'sensor.temp_wohnzimmer', 'binary_sensor.fenster_wohnzimmer'],
  kueche: ['light.kuechenlicht', 'climate.heizung_kueche', 'binary_sensor.fenster_kueche', 'switch.wasserkocher', 'vacuum.robo'],
  flur: ['light.flurlicht', 'binary_sensor.haustuer', 'binary_sensor.praesenz_flur', 'sensor.lux_flur'],
  bad: ['light.badlicht', 'climate.heizung_bad', 'binary_sensor.fenster_bad', 'sensor.temp_bad', 'sensor.feuchte_bad'],
};
const reg = new Set((await ws.call({ type: 'config/entity_registry/list' })).map((e) => e.entity_id));
for (const [r, ents] of Object.entries(place)) for (const e of ents) if (reg.has(e)) await ws.call({ type: 'config/entity_registry/update', entity_id: e, area_id: A[r] }).catch(() => {});

// a shopping list (built-in "Local To-do" integration, no download)
if (!(await api('GET', '/api/states/todo.einkauf')).body?.state) {
  const flow = await api('POST', '/api/config/config_entries/flow', { handler: 'local_todo' });
  if (flow.body?.flow_id) await api('POST', `/api/config/config_entries/flow/${flow.body.flow_id}`, { todo_list_name: 'Einkauf' });
  for (let i = 0; i < 20 && !(await api('GET', '/api/states/todo.einkauf')).body?.state; i++) await sleep(500);
}
// a few items on it (the todo popup shows them live)
const items = await ws.call({ type: 'todo/item/list', entity_id: 'todo.einkauf' }).catch(() => ({ items: [] }));
if (!items.items?.length) for (const item of ['Brot', 'Äpfel', 'Kaffee']) await api('POST', '/api/services/todo/add_item', { entity_id: 'todo.einkauf', item });
// entities only shown, never switched by the tests (service calls to them are intercepted in the test browser)
const extra = {
  'light.schlafzimmer': ['off', { friendly_name: 'Schlafzimmer Decke', supported_color_modes: ['color_temp'], color_mode: null, min_color_temp_kelvin: 2200, max_color_temp_kelvin: 6500 }],
  'fan.luftreiniger': ['off', { friendly_name: 'Luftreiniger', percentage: 0, supported_features: 1 }],
  'sensor.temp_schlafzimmer': ['19.5', { friendly_name: 'Temperatur Schlafzimmer', unit_of_measurement: '°C', device_class: 'temperature' }],
  'weather.forecast_home': ['cloudy', { friendly_name: 'Wetter', temperature: 8, humidity: 70, wind_speed: 12, temperature_unit: '°C', wind_speed_unit: 'km/h' }],
};
for (const [e, [state, attributes]] of Object.entries(extra)) await api('POST', `/api/states/${e}`, { state, attributes });

// the card: resource (the test browser answers it from dist/) and the demo dashboard
const res = await ws.call({ type: 'lovelace/resources' });
if (!res.some((x) => x.url.startsWith('/floorplan_card_files/'))) await ws.call({ type: 'lovelace/resources/create', res_type: 'module', url: '/floorplan_card_files/floorplan-card.js' });
const dashes = await ws.call({ type: 'lovelace/dashboards/list' });
if (!dashes.some((d) => d.url_path === 'grundriss-test')) await ws.call({ type: 'lovelace/dashboards/create', url_path: 'grundriss-test', title: 'Grundriss', icon: 'mdi:floor-plan', show_in_sidebar: true, require_admin: false, mode: 'storage' });

// a neutral demo flat (1 unit = 1 cm): living room, kitchen, bedroom, hallway, bathroom
export const DEMO = {
  type: 'custom:floorplan-card',
  card_id: 'fp_demo',
  height: 'calc(100vh - var(--header-height, 56px))',
  floors: [{
    id: 'floor_demo', name: 'Wohnung',
    rooms: [
      { id: 'room_wohnzimmer', name: 'Wohnzimmer', area: A.wohnzimmer, points: [[0, 0], [600, 0], [600, 450], [0, 450]], lights: ['light.sofalicht', 'light.kleines_licht'], climate: 'climate.heizung_wohnzimmer', temperature: 'sensor.temp_wohnzimmer', floor: { type: 'herringbone' } },
      { id: 'room_kueche', name: 'Küche', area: A.kueche, points: [[600, 0], [950, 0], [950, 320], [600, 320]], lights: ['light.kuechenlicht'], climate: 'climate.heizung_kueche', floor: { type: 'tiles', size: 30 } },
      { id: 'room_schlafzimmer', name: 'Schlafzimmer', area: A.schlafzimmer, points: [[0, 450], [600, 450], [600, 760], [0, 760]], lights: ['light.schlafzimmer'], temperature: 'sensor.temp_schlafzimmer', floor: { type: 'planks' } },
      { id: 'room_flur', name: 'Flur', area: A.flur, points: [[600, 320], [780, 320], [780, 760], [600, 760]], lights: ['light.flurlicht'] },
      { id: 'room_bad', name: 'Bad', area: A.bad, points: [[780, 320], [950, 320], [950, 760], [780, 760]], lights: ['light.badlicht'], climate: 'climate.heizung_bad', temperature: 'sensor.temp_bad', humidity: 'sensor.feuchte_bad', floor: { type: 'tiles', size: 20 } },
    ],
    openings: [
      { id: 'o_front', type: 'door', a: [640, 760], b: [730, 760], entity: 'binary_sensor.haustuer', name: 'Haustür' },
      { id: 'o_wz', type: 'door', a: [600, 340], b: [600, 425] },
      { id: 'o_ku', type: 'door', a: [640, 320], b: [725, 320] },
      { id: 'o_sz', type: 'door', a: [600, 560], b: [600, 645] },
      { id: 'o_bad', type: 'door', a: [780, 500], b: [780, 580], hinge_b: true },
      { id: 'w_wz1', type: 'window', a: [120, 0], b: [300, 0], entity: 'binary_sensor.fenster_wohnzimmer' },
      { id: 'w_wz2', type: 'window', a: [380, 0], b: [540, 0] },
      { id: 'w_ku', type: 'window', a: [700, 0], b: [860, 0], entity: 'binary_sensor.fenster_kueche' },
      { id: 'w_bad', type: 'window', a: [950, 520], b: [950, 620], entity: 'binary_sensor.fenster_bad' },
      { id: 'w_sz', type: 'window', a: [0, 540], b: [0, 680] },
    ],
    devices: [
      { id: 'd_hp', entity: 'media_player.homepod', x: 540, y: 400 },
      { id: 'd_vac', entity: 'vacuum.robo', x: 660, y: 260 },
      { id: 'd_todo', entity: 'todo.einkauf', x: 910, y: 60, icon: 'mdi:fridge-outline', name: 'Kühlschrank' },
      { id: 'd_fan', entity: 'fan.luftreiniger', x: 60, y: 700 },
      { id: 'd_lamp', entity: 'light.badlicht', x: 830, y: 600 },
      { id: 'd_heat', entity: 'climate.heizung_bad', x: 900, y: 600 },
    ],
    furniture: [
      { id: 'f_sofa', kind: 'sofa', x: 280, y: 380, w: 220, h: 95 },
      { id: 'f_rug', kind: 'rug', x: 280, y: 250, w: 200, h: 140 },
      { id: 'f_tv', kind: 'tv', x: 280, y: 40, w: 140, h: 20 },
      { id: 'f_chair', kind: 'armchair', x: 500, y: 230, w: 80, h: 80, rotation: 270 },
      { id: 'f_lamp', kind: 'floor_lamp', x: 50, y: 50, w: 40, h: 40, entity: 'light.sofalicht' },
      { id: 'f_wz_ceiling', kind: 'ceiling_lamp', x: 280, y: 200, w: 50, h: 50, entity: 'light.kleines_licht' },
      { id: 'f_wz_heat', kind: 'radiator', x: 460, y: 12, w: 100, h: 10, entity: 'climate.heizung_wohnzimmer' },
      { id: 'f_counter', kind: 'counter', x: 775, y: 35, w: 250, h: 60 },
      { id: 'f_kettle', kind: 'kettle', x: 700, y: 35, w: 20, h: 20, entity: 'switch.wasserkocher' },
      { id: 'f_table', kind: 'round_table', x: 760, y: 200, w: 100, h: 100 },
      { id: 'f_ku_ceiling', kind: 'ceiling_lamp', x: 860, y: 200, w: 45, h: 45, entity: 'light.kuechenlicht' },
      { id: 'f_ku_heat', kind: 'radiator', x: 900, y: 308, w: 80, h: 10, entity: 'climate.heizung_kueche' },
      { id: 'f_bed', kind: 'bed', x: 300, y: 610, w: 160, h: 200 },
      { id: 'f_wardrobe', kind: 'wardrobe', x: 520, y: 600, w: 160, h: 60, rotation: 90 },
      { id: 'f_sz_ceiling', kind: 'ceiling_lamp', x: 140, y: 600, w: 45, h: 45, entity: 'light.schlafzimmer' },
      { id: 'f_fl_ceiling', kind: 'ceiling_lamp', x: 690, y: 450, w: 40, h: 40, entity: 'light.flurlicht' },
      { id: 'f_bathtub', kind: 'bathtub', x: 865, y: 680, w: 75, h: 160 },
      { id: 'f_toilet', kind: 'toilet', x: 810, y: 400, w: 40, h: 60 },
      { id: 'f_basin', kind: 'washbasin', x: 900, y: 340, w: 60, h: 40 },
      { id: 'f_bad_ceiling', kind: 'ceiling_lamp', x: 865, y: 480, w: 40, h: 40, entity: 'light.badlicht' },
      { id: 'f_bad_heat', kind: 'towel_radiator', x: 940, y: 440, w: 60, h: 10, rotation: 90, entity: 'climate.heizung_bad' },
    ],
  }],
};
await ws.call({ type: 'lovelace/config/save', url_path: 'grundriss-test', config: { title: 'Grundriss', views: [{ title: 'Grundriss', path: 'grundriss', panel: true, cards: [DEMO] }] } });
console.log('test HA ready: http://127.0.0.1:8124/grundriss-test/grundriss');
ws.close();
