// Garden, energy and cars: outdoor areas without walls, live animations, chips. Temporary config, synthetic states.
import { openHA } from '../pw.mjs';
const out = process.argv[2] ?? '/tmp';
const scheme = process.argv[3] ?? 'light';
const { browser, page, errors } = await openHA({ size: '1280x800', scheme, kiosk: true, block: ['light', 'switch', 'valve', 'lawn_mower'] });
const ok = (c, m) => console.log(c ? '• ok:' : '• FAIL:', m);
const FIND = `const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } };`;
const card = (expr) => page.evaluate(`(async () => { ${FIND} const card = find(document); const plan = card.shadowRoot.querySelector('fp-plan'); return ${expr}; })()`);
await page.waitForTimeout(1500);
if (process.env.DAY) await page.evaluate(() => (window.__fpDay = true));
await card(`(() => {
  const S = (id, state, attrs = {}) => ({ entity_id: id, state: String(state), attributes: attrs, last_changed: new Date().toISOString(), last_updated: new Date().toISOString(), context: {} });
  const fake = {
    'lawn_mower.fp_mower': S('lawn_mower.fp_mower', 'mowing'),
    'switch.fp_sprinkler': S('switch.fp_sprinkler', 'on'),
    'sensor.fp_pv': S('sensor.fp_pv', '3.8', { unit_of_measurement: 'kW' }),
    'sensor.fp_bat': S('sensor.fp_bat', '72', { unit_of_measurement: '%' }),
    'sensor.fp_bat_power': S('sensor.fp_bat_power', '1450', { unit_of_measurement: 'W' }),
    'sensor.fp_wb': S('sensor.fp_wb', 'charging'),
    'sensor.fp_eqa_soc': S('sensor.fp_eqa_soc', '64', { unit_of_measurement: '%' }),
    'sensor.fp_eqa_range': S('sensor.fp_eqa_range', '268', { unit_of_measurement: 'km' }),
    'binary_sensor.fp_eqa_charging': S('binary_sensor.fp_eqa_charging', 'on'),
    'device_tracker.fp_eqa': S('device_tracker.fp_eqa', 'home'),
    'sensor.fp_smart_soc': S('sensor.fp_smart_soc', '41', { unit_of_measurement: '%' }),
    'device_tracker.fp_smart': S('device_tracker.fp_smart', 'not_home'),
    'sensor.fp_smart_addr': S('sensor.fp_smart_addr', 'Königstraße 12, Stuttgart'),
    'light.fp_garden': S('light.fp_garden', 'on', { brightness: 255, rgb_color: [255, 210, 150] }),
  };
  if (window.__fpDay) { fake['sun.sun'] = S('sun.sun', 'above_horizon', { elevation: 42, azimuth: 200 }); const w = Object.keys(card._hass.states).find((e) => e.startsWith('weather.')); if (w) fake[w] = { ...card._hass.states[w], state: 'sunny', attributes: { ...card._hass.states[w].attributes, cloud_coverage: 10 } }; }
  let real = card._hass;
  Object.defineProperty(card, '_hass', { configurable: true, get() { return real ? { ...real, states: { ...real.states, ...fake } } : real; }, set(v) { real = v; } });
  const f0 = card.rawConfig.floors[0];
  const xs = f0.rooms.flatMap((r) => r.points.map((p) => p[0])), ys = f0.rooms.flatMap((r) => r.points.map((p) => p[1]));
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const G = 900;
  const garden = { id: 'fp_garden', name: 'Garten', outdoor: true, floor: { type: 'grass' }, points: [[x0 - G, y1], [x1 + G, y1], [x1 + G, y1 + G], [x0 - G, y1 + G]] };
  const terrace = { id: 'fp_terrace', name: 'Terrasse', outdoor: true, floor: { type: 'decking' }, points: [[x0, y1], [x0 + 420, y1], [x0 + 420, y1 + 300], [x0, y1 + 300]] };
  const drive = { id: 'fp_drive', name: 'Einfahrt', outdoor: true, floor: { type: 'paving' }, points: [[x1 + 60, y0 - 50], [x1 + 700, y0 - 50], [x1 + 700, y1], [x1 + 60, y1]] };
  const fy = y1 + 520;
  const furn = [
    { id: 'o_tree1', kind: 'tree', x: x0 + 700, y: fy + 120, w: 320, h: 320 },
    { id: 'o_tree2', kind: 'tree', variant: 'conifer', x: x1 - 150, y: fy + 200, w: 200, h: 200, height: 600 },
    { id: 'o_tree3', kind: 'tree', variant: 'fruit', x: x0 + 1150, y: fy + 40, w: 260, h: 260, height: 380 },
    { id: 'o_hedge', kind: 'bush', variant: 'hedge', x: (x0 + x1) / 2, y: y1 + G - 40, w: 900, h: 60, height: 150 },
    { id: 'o_bush', kind: 'bush', variant: 'flowering', x: x0 + 480, y: y1 + 80, w: 100, h: 100 },
    { id: 'o_bed', kind: 'flower_bed', x: x0 + 980, y: y1 + 90, w: 260, h: 90 },
    { id: 'o_raised', kind: 'raised_bed', x: x0 + 240, y: fy + 240, w: 200, h: 80 },
    { id: 'o_lounge', kind: 'garden_lounge', x: x0 + 200, y: y1 + 120, w: 220, h: 90 },
    { id: 'o_parasol', kind: 'parasol', x: x0 + 330, y: y1 + 210, w: 260, h: 260, color: '#d8c3a5' },
    { id: 'o_pool', kind: 'pool', x: x0 + 1500, y: fy + 140, w: 600, h: 300 },
    { id: 'o_dock', kind: 'mower_dock', x: x1 - 420, y: y1 + 60, w: 70, h: 60 },
    { id: 'o_mower', kind: 'lawn_mower', entity: 'lawn_mower.fp_mower', x: x1 - 400, y: y1 + 60, w: 62, h: 48 },
    { id: 'o_spr', kind: 'sprinkler', entity: 'switch.fp_sprinkler', x: x0 + 900, y: fy + 260, w: 20, h: 20 },
    { id: 'o_light', kind: 'garden_light', entity: 'light.fp_garden', x: x0 + 620, y: y1 + 40, w: 15, h: 15 },
    { id: 'o_pv', kind: 'solar_panels', variant: 'ground', entity: 'sensor.fp_pv', count: 8, x: x1 + 200, y: fy + 200, w: 420, h: 220 },
    { id: 'o_carport', kind: 'carport', x: x1 + 380, y: (y0 + y1) / 2, w: 320, h: 560 },
    { id: 'o_pvroof', kind: 'solar_panels', variant: 'flat', entity: 'sensor.fp_pv', count: 6, elevation: 242, x: x1 + 380, y: (y0 + y1) / 2, w: 300, h: 260, show_value: false },
    { id: 'o_wb', kind: 'wallbox', entity: 'sensor.fp_wb', x: x1 + 75, y: (y0 + y1) / 2 + 60, w: 25, h: 15, rotation: 270 },
    { id: 'o_eqa', kind: 'car', variant: 'merc_eqa', name: 'EQA', color: '#3a4a5c', entity: 'sensor.fp_eqa_soc', entities: { range: 'sensor.fp_eqa_range', charging: 'binary_sensor.fp_eqa_charging', location: 'device_tracker.fp_eqa' }, x: x1 + 380, y: (y0 + y1) / 2 + 40, w: 446, h: 183, rotation: 90 },
    { id: 'o_smart', kind: 'car', variant: 'smart_1', name: 'smart', color: '#f4f4f2', accent: '#1f1f21', entity: 'sensor.fp_smart_soc', entities: { location: 'device_tracker.fp_smart', address: 'sensor.fp_smart_addr' }, x: x1 + 600, y: (y0 + y1) / 2 + 40, w: 427, h: 182, rotation: 90 },
    { id: 'o_bat', kind: 'home_battery', entity: 'sensor.fp_bat', entities: { power: 'sensor.fp_bat_power' }, x: x1 + 120, y: y0 + 60, w: 60, h: 22 },
    { id: 'o_fence', kind: 'fence', x: x0 - G + 450, y: y1 + G - 4, w: 900, h: 8 },
  ];
  card.setConfig({ ...card.rawConfig, floors: card.rawConfig.floors.map((fl, i) => i ? fl : { ...fl, rooms: [...fl.rooms, garden, terrace, drive], furniture: [...(fl.furniture ?? []), ...furn] }) });
  return true; })()`);
await page.waitForTimeout(3500);
const walls = await card(`plan.glScene.walls.children.length`);
const info = await card(`(() => { const ids = ['o_mower', 'o_spr', 'o_pv', 'o_bat', 'o_wb', 'o_eqa', 'o_smart', 'o_tree1']; return Object.fromEntries(ids.map((id) => { const g = plan.glScene.furniture.children.find((c) => c.userData.id === id); return [id, g ? (g.userData.anim ? 'anim' : 'static') : 'missing']; })); })()`);
console.log('  pieces:', JSON.stringify(info));
ok(info.o_mower === 'anim' && info.o_spr === 'anim' && info.o_pv === 'anim' && info.o_bat === 'anim' && info.o_eqa === 'anim', 'mower, sprinkler, solar, battery and charging car are animated');
ok(info.o_tree1 === 'static' || info.o_tree1 === 'anim', 'tree built');
const m0 = await card(`(() => { const g = plan.glScene.furniture.children.find((c) => c.userData.id === 'o_mower'); return [Math.round(g.position.x), Math.round(g.position.y)]; })()`);
await page.waitForTimeout(1000);
const m1 = await card(`(() => { const g = plan.glScene.furniture.children.find((c) => c.userData.id === 'o_mower'); return [Math.round(g.position.x), Math.round(g.position.y)]; })()`);
ok(m0.join() !== m1.join(), `the mower drives its lanes (${m0} → ${m1})`);
const chips = await card(`[...plan.shadowRoot.querySelectorAll('.pet-chip.info')].map((c) => c.className.replace('pet-chip info', '').trim() + ':' + c.textContent.trim()).join(' | ')`);
console.log('  chips:', chips);
ok(/64 %.*lädt/.test(chips), 'charging car chip');
ok(/Unterwegs · Königstraße 12/.test(chips), 'away car with its address');
ok(/72 %.*\+1,5 kW|72 %.*\+1.5 kW/.test(chips), 'battery: charge and charging power');
ok(/3,8 kW|3.8 kW/.test(chips), 'solar power');
ok(/mäht/.test(chips), 'mower status');
// outdoor areas have no walls
const wallsWithout = await card(`(() => { const f = card._config.floors[0]; return f.rooms.filter((r) => r.outdoor).length; })()`);
ok(wallsWithout === 3, 'three outdoor areas');
await page.screenshot({ path: `${out}/outdoor-${process.env.DAY ? 'day-' : ''}${scheme}.png` });
await card(`(plan.panZoom.zoomBy(0.62), true)`);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/outdoor-wide-${process.env.DAY ? 'day-' : ''}${scheme}.png` });
// stagecheck: both stages carry the same camera
const st = await card(`[...plan.shadowRoot.querySelectorAll('.stage')].map((e) => e.style.getPropertyValue('--fp-tilt') + ' ' + e.style.transform.slice(0, 60)).join(' || ')`);
console.log('  stages:', st);
console.log(errors.length ? errors.join('\n') : 'console: keine Fehler/Warnungen');
await browser.close();
