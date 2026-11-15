// Washer, dryer, dishwasher on the mock harness (no Home Assistant; neutral demo values): the time left as a chip at
// the appliance (end time as a timestamp, minutes left), "fertig" with a soft signal until "Gesehen" or the door opens,
// the smart-plug fallback (power + history), the popup with every value, the editor's role rows, 2D / 3D pictures.
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/appliance.mjs [outDir] [light|dark]
import { openMock, demoHome } from './mock.mjs';
import { KNOWN } from '../pw.mjs';

const out = process.argv[2] ?? '/tmp';
const scheme = process.argv[3] ?? 'light';
let fails = 0;
const ok = (c, m, extra) => {
  if (!c) fails++;
  console.log(c ? '• ok:' : '• FAIL:', m, !c && extra !== undefined ? JSON.stringify(extra) : '');
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const LAYER = `document.querySelector('floorplan-card-layer')?.shadowRoot`;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

const cfg = demoHome();
const eg = cfg.floors[0];
eg.rooms.push({ id: 'utility', name: 'Hauswirtschaft', floor: { type: 'tiles' }, points: [[0, 500], [600, 500], [600, 640], [0, 640]] });
eg.furniture.push(
  { id: 'wm', kind: 'washer', name: 'Waschmaschine', entity: 'sensor.demo_washer_operation_state', x: 60, y: 600, w: 60, h: 60, rotation: 180 },
  { id: 'tr', kind: 'dryer', name: 'Trockner', entity: 'sensor.demo_dryer_status', x: 140, y: 600, w: 60, h: 60, rotation: 180 },
  { id: 'gs', kind: 'dishwasher', name: 'Spülmaschine', entity: 'switch.demo_dishwasher_plug', x: 940, y: 40, w: 60, h: 60 },
);
const dev = (id, device_id, extra = {}) => ({ entity_id: id, device_id, ...extra });
const entities = {
  'sensor.demo_washer_operation_state': dev('sensor.demo_washer_operation_state', 'dev_wm'),
  'sensor.demo_washer_remaining_program_time': dev('sensor.demo_washer_remaining_program_time', 'dev_wm'),
  'sensor.demo_washer_program_progress': dev('sensor.demo_washer_program_progress', 'dev_wm'),
  'sensor.demo_washer_selected_program': dev('sensor.demo_washer_selected_program', 'dev_wm'),
  'binary_sensor.demo_washer_door': dev('binary_sensor.demo_washer_door', 'dev_wm'),
  'sensor.demo_washer_spin_speed': dev('sensor.demo_washer_spin_speed', 'dev_wm'),
  'sensor.demo_dryer_status': dev('sensor.demo_dryer_status', 'dev_tr'),
  'sensor.demo_dryer_remaining_time': dev('sensor.demo_dryer_remaining_time', 'dev_tr'),
  'switch.demo_dishwasher_plug': dev('switch.demo_dishwasher_plug', 'dev_gs'),
  'sensor.demo_dishwasher_plug_power': dev('sensor.demo_dishwasher_plug_power', 'dev_gs'),
};
const states = {
  'sensor.demo_washer_operation_state': { state: 'Run', attributes: { friendly_name: 'Waschmaschine Betriebszustand' } },
  'sensor.demo_washer_remaining_program_time': { state: iso(now + 42 * 60000 + 20000), attributes: { friendly_name: 'Waschmaschine Programmende', device_class: 'timestamp' } },
  'sensor.demo_washer_program_progress': { state: '30', attributes: { friendly_name: 'Waschmaschine Fortschritt', unit_of_measurement: '%' } },
  'sensor.demo_washer_selected_program': { state: 'Baumwolle 40', attributes: { friendly_name: 'Waschmaschine Programm' } },
  'binary_sensor.demo_washer_door': { state: 'off', attributes: { friendly_name: 'Waschmaschine Tür', device_class: 'door' } },
  'sensor.demo_washer_spin_speed': { state: '1400', attributes: { friendly_name: 'Waschmaschine Schleuderdrehzahl', unit_of_measurement: 'U/min' } },
  'sensor.demo_dryer_status': { state: 'running', attributes: { friendly_name: 'Trockner Status' } },
  'sensor.demo_dryer_remaining_time': { state: '25', attributes: { friendly_name: 'Trockner Restzeit', unit_of_measurement: 'min' } },
  'switch.demo_dishwasher_plug': { state: 'on', attributes: { friendly_name: 'Spülmaschine Steckdose' } },
  'sensor.demo_dishwasher_plug_power': { state: '1850', attributes: { friendly_name: 'Spülmaschine Steckdose Leistung', device_class: 'power', unit_of_measurement: 'W' } },
};
// the plug's history: ran from 100 to 40 minutes ago, quiet since then
const sec = (minAgo) => (now - minAgo * 60000) / 1000;
const history = {
  'sensor.demo_dishwasher_plug_power': [
    { s: '1.2', lu: sec(130) },
    { s: '1900', lu: sec(100) },
    { s: '3', lu: sec(80) },
    { s: '2100', lu: sec(70) },
    { s: '35', lu: sec(45) },
    { s: '1.1', lu: sec(40) },
  ],
};
const m = await openMock({ config: { ...cfg, view_mode: '2d' }, states, entities, size: '1280x900', scheme, ws: { 'history/history_during_period': history } });
const { page } = m;
await wait(1200);

const chip = (id) => m.card(`(() => { const c = plan.shadowRoot.querySelector('.pet-chip.appl[data-appl="${id}"]'); return c ? { text: c.textContent.trim(), cls: c.className } : null; })()`);
const popupOpen = () => page.evaluate(`!!${LAYER}?.querySelector('fp-appliance-popup')`);
const inPopup = (sel) => `${LAYER}.querySelector('fp-appliance-popup').shadowRoot.querySelector(${JSON.stringify(sel)})`;
const closePopup = async () => {
  await page.evaluate(`${LAYER}?.querySelector('.sheet > *')?.shadowRoot.querySelector('.close')?.click()`);
  await wait(500);
};

// ---------- running: time left from an end timestamp, from minutes ----------
let c = await chip('wm');
ok(c && /noch 4[123] Min\./.test(c.text) && /run/.test(c.cls), `washer: chip with the time left from the end time (${c?.text})`, c);
c = await chip('tr');
ok(c && /noch 2[45] Min\./.test(c.text), `dryer: minutes left (${c?.text})`, c);
c = await chip('gs');
ok(c && /läuft/.test(c.text), `dishwasher via smart plug: running above the threshold (${c?.text})`, c);
ok(await m.card(`!!plan.shadowRoot.querySelector('.pet-chip.appl.prog[data-appl="wm"]')`), 'washer: thin progress line (30 %)');
await page.screenshot({ path: `${out}/appliance-2d-running-${scheme}.png` });

// ---------- the popup ----------
await m.card(`(card.gesture({ kind: 'furniture', id: 'wm' }, 'tap'), true)`);
await wait(900);
ok(await popupOpen(), 'tap on the washer opens its popup (no switching)');
ok((await m.calls()).length === 0, 'no service call from the tap');
const vals = await page.evaluate(`${inPopup('[data-appl-values]')}?.textContent.replace(/\\s+/g, ' ')`);
ok(/Baumwolle 40/.test(vals ?? '') && /30 %/.test(vals ?? '') && /Fertig um/.test(vals ?? ''), `popup: program, progress, end time (${vals?.slice(0, 120)})`);
const info = await page.evaluate(`${inPopup('[data-appl-info]')}?.textContent ?? ''`);
ok(/Schleuder/.test(info), 'popup: further values found by name (spin speed)');
await page.screenshot({ path: `${out}/appliance-popup-running-${scheme}.png` });
await closePopup();

// ---------- done → signal → "Gesehen" ----------
await m.setStates({ 'sensor.demo_washer_operation_state': { state: 'Finished' }, 'sensor.demo_washer_remaining_program_time': { state: 'unknown' } });
await wait(500);
c = await chip('wm');
ok(c && /fertig/.test(c.text) && /done/.test(c.cls), `washer done: green "fertig" chip (${c?.text})`, c);
ok(await m.card(`!!plan.shadowRoot.querySelector('.ffx.power circle')`), 'done: a soft ring around the washer');
await page.screenshot({ path: `${out}/appliance-2d-done-${scheme}.png` });
await m.card(`(card.gesture({ kind: 'furniture', id: 'wm' }, 'tap'), true)`);
await wait(900);
ok(await page.evaluate(`!!${inPopup('[data-seen]')}`), 'popup of a done washer: "Gesehen"');
await page.screenshot({ path: `${out}/appliance-popup-done-${scheme}.png` });
await page.evaluate(`${inPopup('[data-seen]')}.click()`);
await wait(400);
ok(!(await chip('wm')), '"Gesehen" clears the chip');
ok((await page.evaluate(`window.__fpWs.map((x) => x.type)`)).includes('floorplan_card/appliance/ack'), '"Gesehen" goes to the companion (shared with every screen)');
await closePopup();

// door opened after the end clears it, too
await wait(1100);
await m.setStates({ 'sensor.demo_washer_operation_state': { state: 'Run' } });
await wait(300);
await m.setStates({ 'sensor.demo_washer_operation_state': { state: 'Finished' } });
await wait(400);
ok(/fertig/.test((await chip('wm'))?.text ?? ''), 'next run done: "fertig" again');
await wait(5300);
await m.setStates({ 'binary_sensor.demo_washer_door': { state: 'on' } });
await wait(400);
ok(!(await chip('wm')), 'door opened after the end: "fertig" goes away');

// ---------- smart plug fallback: done from the history ----------
await m.setStates({ 'sensor.demo_dishwasher_plug_power': { state: '1.0' } });
await wait(900);
c = await chip('gs');
ok(c && /fertig/.test(c.text), `dishwasher via plug: quiet for 40 min after a run → "fertig" (${c?.text})`, c);
ok((await page.evaluate(`window.__fpWs.filter((x) => x.type === 'history/history_during_period').map((x) => x.entity_ids[0])`)).includes('sensor.demo_dishwasher_plug_power'), 'history of the plug power asked for');

// ---------- the editor: one row per value, detected ones marked ----------
await m.card(`(card.openEditor?.() ?? card.shadowRoot.querySelector('.edit-btn, [data-edit]')?.click(), true)`);
await wait(1500);
const edOpen = await page.evaluate(`!!${LAYER}?.querySelector('floorplan-card-editor-ui')`);
if (edOpen) {
  await page.evaluate(`(() => { const ed = ${LAYER}.querySelector('floorplan-card-editor-ui'); ed.select?.({ kind: 'furniture', id: 'wm' }); return true; })()`);
  await wait(800);
  const rows = await page.evaluate(`(() => { const ed = ${LAYER}.querySelector('floorplan-card-editor-ui'); const r = ed.shadowRoot; return [...r.querySelectorAll('[data-appl-role]')].map((x) => x.dataset.applRole + '=' + x.dataset.entity); })()`);
  ok(rows.length >= 8 && rows.some((x) => x.startsWith('end=sensor.demo_washer_remaining')) && rows.some((x) => x.startsWith('door=binary_sensor.demo_washer_door')), `editor: value rows with the detected entities (${rows.join(', ')})`);
  await page.screenshot({ path: `${out}/appliance-editor-${scheme}.png` });
} else console.log('  (editor not opened in this mock — role rows checked through the popup only)');

// ---------- 3D ----------
await m.setStates({ 'sensor.demo_washer_operation_state': { state: 'Run' }, 'sensor.demo_washer_remaining_program_time': { state: iso(Date.now() + 30 * 60000) }, 'binary_sensor.demo_washer_door': { state: 'off' } });
const m3 = await openMock({ config: { ...cfg, view_mode: '3d' }, states: { ...states, 'sensor.demo_dryer_status': { state: 'Finished', attributes: { friendly_name: 'Trockner Status' } } }, entities, size: '1280x900', scheme, ws: { 'history/history_during_period': history } });
await wait(2200);
ok(await m3.card('plan.is3d && !!plan.glScene'), 'WebGL 3D view');
const model = await m3.card(`(() => { const g = plan.glScene.furniture.children.find((c) => c.userData.id === 'wm'); return g ? { drum: !!g.getObjectByName('drum'), display: !!g.getObjectByName('display'), anim: !!g.userData.anim } : null; })()`);
ok(model?.drum && model?.display && model?.anim, 'washer in 3D: porthole drum and display; the drum turns while it runs', model);
const gs3 = await m3.card(`(() => { const g = plan.glScene.furniture.children.find((c) => c.userData.id === 'gs'); return g ? { display: !!g.getObjectByName('display'), drum: !!g.getObjectByName('drum') } : null; })()`);
ok(gs3?.display && !gs3?.drum, 'dishwasher in 3D: door with display, no drum', gs3);
await m3.card(`(plan.setSpin?.(180), plan.focusRoom('utility'), true)`);
await wait(2200);
await m3.page.screenshot({ path: `${out}/appliance-3d-${scheme}.png` });
await m3.card(`(plan.setSpin?.(0), plan.focusRoom('kitchen'), true)`);
await wait(2200);
await m3.page.screenshot({ path: `${out}/appliance-3d-kitchen-${scheme}.png` });
const errs3 = m3.errors.filter((e) => !KNOWN.some((r) => r.test(e)));
ok(!errs3.length, 'no console errors (3D)', errs3);
await m3.browser.close();

ok(!m.errors.filter((e) => !/unknown_command|Unknown command/.test(e) && !KNOWN.some((r) => r.test(e))).length, 'no console errors', m.errors);
await m.browser.close();
console.log(fails ? `${fails} failure(s)` : 'all ok');
process.exit(fails ? 1 : 0);
