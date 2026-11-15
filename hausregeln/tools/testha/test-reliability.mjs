// Reliability in everyday use against the isolated test Home Assistant (port 8124):
//   * "Solange" / "Wechselnd" rules with realistic sensors (motion that clears after a while, mmWave presence that
//     flickers, room occupancy with "empty after"), lamps that report their state late (like Zigbee)
//   * notifications: settings changes never remind, repeated conditions at most N times, quiet hours, dedup by tag
//   * after a restart roomwise checks everything and corrects what changed while HA was down or starting
// Usage: node tools/testha/test-reliability.mjs [--only name] [--no-restart]
// (run test-engine.mjs once before: it creates areas, persons and the integration entry)
import { token, wsConnect, rest, sleep, ok, failures, until } from './lib.mjs';

const tok = await token();
let ws = await wsConnect(tok);
const api = rest(tok);
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const set = (entity_id, state, attributes = {}) => ws.call({ type: 'hr_fake/set', entity_id, state, attributes });
const st = async (e) => (await api('GET', `/api/states/${e}`)).body;
const calls = (clear = false) => ws.call({ type: 'hr_fake/calls', clear });
const snapshot = () => ws.call({ type: 'house_rules/snapshot' });
const save = async (rule) => (await ws.call({ type: 'house_rules/rule/save', rule })).rule;
const isOn = async (e) => (await st(e)).state === 'on';
const hist = async (n = 8) => (await ws.call({ type: 'house_rules/history', limit: n })).map((h) => `${h.what} | ${h.why}`);

// ---------------------------------------------------------------- setup (idempotent)
const areas = await ws.call({ type: 'config/area_registry/list' });
const area = async (name) => (areas.find((a) => a.name === name) ?? (await ws.call({ type: 'config/area_registry/create', name }))).area_id;
const A = { flur: await area('Flur'), wohnzimmer: await area('Wohnzimmer'), kueche: await area('Küche'), bad: await area('Bad') };
const place = {
  flur: ['light.flurlicht', 'binary_sensor.praesenz_flur'],
  wohnzimmer: ['light.sofalicht', 'binary_sensor.bewegung_wohnzimmer', 'climate.heizung_wohnzimmer', 'sensor.co2_wohnzimmer', 'binary_sensor.fenster_wohnzimmer', 'sensor.temp_wohnzimmer'],
  kueche: ['light.kuechenlicht', 'climate.heizung_kueche', 'binary_sensor.fenster_kueche'],
  bad: ['light.badlicht', 'climate.heizung_bad', 'sensor.feuchte_bad', 'sensor.temp_bad', 'binary_sensor.fenster_bad'],
};
for (const [r, ents] of Object.entries(place)) for (const e of ents) await ws.call({ type: 'config/entity_registry/update', entity_id: e, area_id: A[r] }).catch((err) => console.log('area', e, err.message));
await api('POST', '/api/services/device_tracker/see', { dev_id: 'alex_handy', location_name: 'home' });
await api('POST', '/api/services/device_tracker/see', { dev_id: 'sam_handy', location_name: 'not_home' });
const persons = await ws.call({ type: 'person/list' });
for (const [name, trk] of [['Alex Test', 'device_tracker.alex_handy'], ['Sam Test', 'device_tracker.sam_handy']])
  if (!persons.storage.some((p) => p.name === name)) await ws.call({ type: 'person/create', name, device_trackers: [trk] });
// integration set up? (a fresh test HA)
if (!(await ws.call({ type: 'house_rules/info' }).catch(() => null))?.loaded) {
  const flow = await api('POST', '/api/config/config_entries/flow', { handler: 'roomwise' });
  await api('POST', `/api/config/config_entries/flow/${flow.body.flow_id}`, {});
  await until(async () => (await ws.call({ type: 'house_rules/info' }).catch(() => null))?.loaded, 30000, 500);
}
await until(async () => (await snapshot()).devices.length > 10, 90000, 1000);
await until(async () => (await snapshot()).devices.some((d) => d.entity_id === 'binary_sensor.bewegung_wohnzimmer' && d.room), 30000, 500);
let snap = await snapshot();
const R = Object.fromEntries(['Flur', 'Wohnzimmer', 'Küche', 'Bad'].map((n) => [n, snap.rooms.find((r) => r.name === n)?.id]));
ok(R.Flur && R.Wohnzimmer && R['Küche'] && R.Bad, 'Räume da', R);
await ws.call({ type: 'house_rules/mode/set', mode: 'home' });
const features0 = snap.features;
await ws.call({ type: 'house_rules/features/set', features: { light: true, heating: true, behaviours: true } });
for (const b of ['light_on_enter', 'light_off_empty', 'night_dim', 'heat_eco_empty', 'media_pause_empty']) await ws.call({ type: 'house_rules/behaviour/set', behaviour: b, on: false });
const rooms0 = Object.fromEntries(snap.rooms.map((r) => [r.id, r.empty_after]));
// the room counts as empty 3 s after the last motion (instead of 5 min)
for (const r of [R.Flur, R.Wohnzimmer]) await ws.call({ type: 'house_rules/room/save', room: { id: r, empty_after: 0.05 } });
// the light plans of the rooms off (they are tested in test-engine.mjs); a test switches one on where it matters
const lightPlans0 = snap.plans?.light ?? {};
for (const r of [R.Flur, R.Wohnzimmer]) await ws.call({ type: 'house_rules/plan/set', kind: 'light', room: r, plan: { ...(lightPlans0[r] ?? {}), on: false } });

const reset = async () => {
  for (const e of ['binary_sensor.praesenz_flur', 'binary_sensor.bewegung_wohnzimmer', 'binary_sensor.fenster_wohnzimmer', 'binary_sensor.fenster_bad']) await set(e, 'off');
  for (const e of ['light.flurlicht', 'light.sofalicht', 'light.badlicht', 'light.kuechenlicht']) await set(e, 'off', { latency: 0 });
  await calls(true);
};
const clean = async () => {
  for (const r of (await snapshot()).rules) await ws.call({ type: 'house_rules/rule/delete', rule_id: r.id });
  await reset();
  await until(async () => { const o = (await snapshot()).occupancy; return !o[R.Flur]?.occupied && !o[R.Wohnzimmer]?.occupied; }, 10000, 300);
};
const test = async (name, fn) => {
  if (only && !name.includes(only)) return;
  console.log(`\n# ${name}`);
  try {
    await fn();
  } catch (e) {
    ok(false, `${name}: ${e.message}`);
  }
  await clean();
};
await clean();
// right after a start the alarm and the rules wait a moment (restart safety)
await until(async () => !(await snapshot()).alarm.settling, 120000, 1000);
// … and in the start-up phase changes by others do not count as "by hand" yet
await until(async () => (await snapshot()).starting === false, 150000, 1000);

// ---------------------------------------------------------------- "Solange" with realistic sensors
const room = (verb = 'is_occupied') => ({ subject: `room:${R.Wohnzimmer}`, verb });
const enterLeave = async (label, light = 'light.sofalicht') => {
  await set('binary_sensor.bewegung_wohnzimmer', 'on');
  ok(await until(() => isOn(light), 5000), `${label}: Betreten → Licht an`);
  // the motion sensor clears after a while, the room counts as empty 3 s later
  await sleep(800);
  await set('binary_sensor.bewegung_wohnzimmer', 'off');
};

await test('Solange: Raum belegt → Licht, zurück wie vorher', async () => {
  await set('light.sofalicht', 'off', { latency: 0.8 });
  await save({ name: 'Licht solange belegt', type: 'while', when: [room()], then: [{ subject: 'light.sofalicht', verb: 'turn_on' }] });
  await enterLeave('wiederherstellen');
  ok(await until(async () => !(await isOn('light.sofalicht')), 9000), 'Verlassen (leer nach 3 Sek.) → Licht wieder aus', await hist());
  // twice in a row: the snapshot of the second time must again be "off"
  await enterLeave('zweites Mal');
  ok(await until(async () => !(await isOn('light.sofalicht')), 9000), 'zweites Mal: wieder aus', await hist());
});

await test('Solange: Bewegungsmelder direkt, kurz wieder Bewegung', async () => {
  await set('light.sofalicht', 'off', { latency: 0.8 });
  await save({ name: 'Licht solange Bewegung', type: 'while', when: [{ subject: 'binary_sensor.bewegung_wohnzimmer', verb: 'is_active' }], then: [{ subject: 'light.sofalicht', verb: 'turn_on' }] });
  await set('binary_sensor.bewegung_wohnzimmer', 'on');
  ok(await until(() => isOn('light.sofalicht'), 5000), 'Bewegung → an');
  await sleep(1500);
  // motion clears and comes back at once (someone still moves): the end and the new start overlap
  await set('binary_sensor.bewegung_wohnzimmer', 'off');
  await set('binary_sensor.bewegung_wohnzimmer', 'on');
  await sleep(2500);
  ok(await isOn('light.sofalicht'), 'kurz keine Bewegung → bleibt/geht wieder an');
  await set('binary_sensor.bewegung_wohnzimmer', 'off');
  ok(await until(async () => !(await isOn('light.sofalicht')), 6000), 'keine Bewegung mehr → aus (nicht der Zwischenstand „an“ als vorher gemerkt)', await hist());
});

await test('Solange: mmWave-Präsenz flackert', async () => {
  await set('light.flurlicht', 'off', { latency: 1.2 });
  await save({ name: 'Flur solange Präsenz', type: 'while', when: [{ subject: 'binary_sensor.praesenz_flur', verb: 'is_occupied' }], then: [{ subject: 'light.flurlicht', verb: 'turn_on' }] });
  await set('binary_sensor.praesenz_flur', 'on');
  ok(await until(() => isOn('light.flurlicht'), 5000), 'Präsenz → an');
  await sleep(1500);
  for (let i = 0; i < 3; i++) {
    await set('binary_sensor.praesenz_flur', 'off');
    await sleep(150);
    await set('binary_sensor.praesenz_flur', 'on');
    await sleep(200);
  }
  await sleep(2500);
  ok(await isOn('light.flurlicht'), 'nach dem Flackern (jemand ist da) an');
  await set('binary_sensor.praesenz_flur', 'off');
  ok(await until(async () => !(await isOn('light.flurlicht')), 7000), 'Präsenz weg → aus', await hist(12));
});

await test('Wechselnd: sonst aus', async () => {
  await set('light.sofalicht', 'off', { latency: 0.8 });
  await save({ name: 'Licht wechselnd', type: 'while', when: [room()], then: [{ subject: 'light.sofalicht', verb: 'turn_on' }], else: [{ subject: 'light.sofalicht', verb: 'turn_off' }] });
  await enterLeave('wechselnd');
  ok(await until(async () => !(await isOn('light.sofalicht')), 9000), 'Verlassen → sonst: aus', await hist());
  await enterLeave('wechselnd 2');
  ok(await until(async () => !(await isOn('light.sofalicht')), 9000), 'zweites Mal: aus');
});

await test('Wechselnd: Standard-Pause bei Handbedienung', async () => {
  // the rule's own switching never counts as "by hand", also with a lamp that reports late
  // (a lamp nobody touched in this run: a change by hand would pause the rule for an hour, as it should)
  const lamp = 'light.kleines_licht';
  await set(lamp, 'off', { latency: 1.5 });
  await save({ name: 'Licht wechselnd Pause', type: 'while', when: [room()], then: [{ subject: lamp, verb: 'turn_on' }], else: [{ subject: lamp, verb: 'turn_off' }], options: { manual_pause: '1h' } });
  await enterLeave('mit Pause', lamp);
  ok(await until(async () => !(await isOn(lamp)), 9000), 'Verlassen → aus (eigene Schaltung zählt nicht als „von Hand“)', await hist());
  await enterLeave('mit Pause 2', lamp);
  ok(await until(async () => !(await isOn(lamp)), 9000), 'zweites Mal: aus');
  await set(lamp, 'off', { latency: 0 });
});

await test('Solange: Geräteänderungen in HA halten das Ende nicht auf', async () => {
  // Home Assistant changes its registries now and then (an app updates its device, an integration reconnects):
  // Hausregeln rebuilds then, but a running "while" rule and the room's "empty after" time just go on
  await ws.call({ type: 'house_rules/room/save', room: { id: R.Wohnzimmer, empty_after: 0.15 } });
  await set('light.sofalicht', 'off', { latency: 0.5 });
  await save({ name: 'Licht solange belegt', type: 'while', when: [room()], then: [{ subject: 'light.sofalicht', verb: 'turn_on' }] });
  await set('binary_sensor.bewegung_wohnzimmer', 'on');
  ok(await until(() => isOn('light.sofalicht'), 5000), 'Betreten → an');
  await set('binary_sensor.bewegung_wohnzimmer', 'off');
  const t0 = Date.now();
  let n = 0;
  let off = false;
  // a registry change every 4 s (Hausregeln rebuilds 3 s after the last one)
  while (Date.now() - t0 < 28000 && !off) {
    if ((Date.now() - t0) % 4000 < 600) await ws.call({ type: 'config/entity_registry/update', entity_id: 'sensor.lux_flur', name: `Helligkeit Flur ${n++ % 2}` });
    await sleep(500);
    off = !(await isOn('light.sofalicht'));
  }
  ok(off && Date.now() - t0 < 15000, `trotz Änderungen alle 4 Sek.: nach ${Math.round((Date.now() - t0) / 1000)} Sek. aus (leer nach 9 Sek.)`, await hist());
  await ws.call({ type: 'config/entity_registry/update', entity_id: 'sensor.lux_flur', name: null });
  await ws.call({ type: 'house_rules/room/save', room: { id: R.Wohnzimmer, empty_after: 0.05 } });
});

await test('Solange: nicht zurückstellen', async () => {
  await save({ name: 'Licht bleibt', type: 'while', when: [room()], then: [{ subject: 'light.sofalicht', verb: 'turn_on' }], options: { restore: false } });
  await enterLeave('ohne zurück');
  await sleep(5000);
  ok(await isOn('light.sofalicht'), 'Verlassen → bleibt an (so eingestellt)');
});

await test('Solange mit „nur wenn“', async () => {
  await api('POST', '/api/services/input_boolean/turn_on', { entity_id: 'input_boolean.besuch' });
  await save({ name: 'Licht nur wenn', type: 'while', when: [room()], only: [{ subject: 'input_boolean.besuch', verb: 'is_on' }], then: [{ subject: 'light.sofalicht', verb: 'turn_on' }] });
  await enterLeave('nur wenn');
  ok(await until(async () => !(await isOn('light.sofalicht')), 9000), 'Verlassen → aus');
  await api('POST', '/api/services/input_boolean/turn_off', { entity_id: 'input_boolean.besuch' });
  await set('binary_sensor.bewegung_wohnzimmer', 'on');
  await sleep(1500);
  ok(!(await isOn('light.sofalicht')), '„nur wenn“ gilt nicht → bleibt aus');
  await set('binary_sensor.bewegung_wohnzimmer', 'off');
});

await test('Solange: was die Person von Hand ändert, bleibt', async () => {
  await save({ name: 'Licht solange belegt', type: 'while', when: [room()], then: [{ subject: 'light.sofalicht', verb: 'turn_on', brightness: 40 }] });
  await set('binary_sensor.bewegung_wohnzimmer', 'on');
  ok(await until(() => isOn('light.sofalicht'), 5000), 'an');
  await sleep(500);
  // at the lamp: off and on again (a fresh context, like a wall switch)
  await set('light.sofalicht', 'off');
  await set('light.sofalicht', 'on');
  await set('binary_sensor.bewegung_wohnzimmer', 'off');
  await sleep(6000);
  ok(await isOn('light.sofalicht'), 'von Hand geschaltet → bleibt beim Verlassen an', await hist());
});

await test('Solange mit Lichtplan im Raum', async () => {
  // the room's light plan is on (no own rules, "nobody there any more" = leave as is): the house rule decides
  await ws.call({ type: 'house_rules/plan/set', kind: 'light', room: R.Wohnzimmer, plan: { ...(lightPlans0[R.Wohnzimmer] ?? {}), on: true, rules: [], empty: { mode: 'keep', delay: 0, dim: 10, dim_for: 0 }, manual: 'room_empty' } });
  await set('light.sofalicht', 'off', { latency: 0.8 });
  await save({ name: 'Licht solange belegt', type: 'while', when: [room()], then: [{ subject: 'light.sofalicht', verb: 'turn_on' }] });
  await enterLeave('mit Lichtplan');
  ok(await until(async () => !(await isOn('light.sofalicht')), 9000), 'Verlassen → aus, auch mit Lichtplan', await hist());
  await ws.call({ type: 'house_rules/plan/set', kind: 'light', room: R.Wohnzimmer, plan: { ...(lightPlans0[R.Wohnzimmer] ?? {}), on: false } });
});

// ---------------------------------------------------------------- notifications
const notes = async (re) => (await calls()).filter((c) => c.service.startsWith('notify.') && (!re || re.test(`${c.data?.title} ${c.data?.message}`)));
const notifySettings = (n) => ws.call({ type: 'house_rules/settings/set', settings: { notifications: n } });
const alexId = (await snapshot()).persons.find((p) => /Alex/.test(p.name))?.id;
const heatPlan = (room, p) => ws.call({ type: 'house_rules/plan/set', kind: 'heat', room, plan: p });
const VENT = { on: true, times: [], humidity_on: true, humidity: 65, humidity_sensor: 'sensor.feuchte_bad', co2_on: false, co2: 1000, co2_sensor: null, mould: false, close: false, close_after: 0, wait: 0.02 };
const G0 = { outside: 'sensor.temp_aussen', notify: [alexId], quiet: { on: false }, gap: 0 };

await test('Benachrichtigungen: Lüften nur bei echtem Bedarf', async () => {
  const bad = R.Bad;
  await notifySettings({ reset: true, quiet: { on: false }, kinds: { vent: { on: true, gap: 120, daily: 3 } } });
  await ws.call({ type: 'house_rules/heating/set', config: G0 });
  await set('sensor.feuchte_bad', '50');
  await heatPlan(bad, { on: false, vent: VENT });
  await sleep(1500);
  await calls(true);
  await set('sensor.feuchte_bad', '80');
  const first = await until(async () => (await notes(/Luftfeuchte/)).length >= 1, 8000);
  ok(first, 'Feuchte 80 % → eine Lüft-Erinnerung');
  const n1 = (await notes(/Luftfeuchte/))[0];
  ok(n1?.data?.data?.tag === `hr_vent_${bad}` && n1?.data?.data?.push?.['interruption-level'] === 'passive' && n1?.data?.data?.alert_once === true, 'ruhig zugestellt: ersetzt die letzte (tag), ohne Ton', n1?.data?.data);
  // the owner's case: changing heating settings again and again
  for (let i = 0; i < 4; i++) {
    await heatPlan(bad, { on: false, vent: { ...VENT, wait: 0.02 + i * 0.01 }, temps: { comfort: 21 + i * 0.5 } });
    await ws.call({ type: 'house_rules/heating/set', config: { ...G0, gap: i } });
    await sleep(1200);
  }
  await sleep(3000);
  ok((await notes(/Lüft|lüft/)).length === 1, 'Einstellungen 8× geändert → keine weitere Erinnerung', (await notes()).map((c) => c.data?.message));
  // a lower limit: humidity is over it only because of the new setting → shows, but no message
  await set('sensor.feuchte_bad', '60');
  await sleep(1500);
  await heatPlan(bad, { on: false, vent: { ...VENT, humidity: 50 } });
  await sleep(4000);
  const v = (await snapshot()).plans.now?.[bad]?.heat?.vent;
  ok(v?.state === 'ventilate', 'neue Grenze 50 %: Status „lüften“', v);
  ok((await notes(/Lüft|lüft/)).length === 1, 'neue Grenze → keine Nachricht (nur durch die Einstellung)', (await notes()).map((c) => c.data?.message));
  // the value falls and rises again: a new occasion, but within the minimum gap (2 h per room and person)
  await heatPlan(bad, { on: false, vent: VENT });
  await set('sensor.feuchte_bad', '50');
  await sleep(1500);
  await set('sensor.feuchte_bad', '82');
  await sleep(4000);
  ok((await notes(/Lüft|lüft/)).length === 1, 'wieder über der Grenze innerhalb von 2 Std. → keine zweite Nachricht', (await notes()).map((c) => c.data?.message));
  const h = await hist(12);
  ok(h.some((x) => /Lüften Bad/.test(x) && /82/.test(x)), 'im Verlauf steht es trotzdem', h);
  // daily maximum: no gap, at most 2 a day
  await notifySettings({ kinds: { vent: { on: true, gap: 0, daily: 2 } } });
  for (const val of ['50', '83', '50', '84', '50', '85']) {
    await set('sensor.feuchte_bad', val);
    await sleep(2000);
  }
  ok((await notes(/Lüft|lüft/)).length === 2, 'Tageslimit 2 → höchstens 2 Nachrichten', (await notes()).map((c) => c.data?.message));
  // quiet hours: held back
  const nowH = parseInt(new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit' }), 10);
  await notifySettings({ reset: true, kinds: { vent: { on: true, gap: 0, daily: 0 } }, quiet: { on: true, from: `${String(nowH).padStart(2, '0')}:00`, to: `${String((nowH + 1) % 24).padStart(2, '0')}:00` } });
  await calls(true);
  await set('sensor.feuchte_bad', '50');
  await sleep(1500);
  await set('sensor.feuchte_bad', '86');
  await sleep(4000);
  ok((await notes(/Lüft|lüft/)).length === 0, 'Ruhezeit → keine Erinnerung', (await notes()).map((c) => c.data?.message));
  await calls(true);
  // a person switched the kind off for themselves
  await notifySettings({ quiet: { on: false }, persons: { [alexId]: { off: ['vent'] } } });
  await set('sensor.feuchte_bad', '50');
  await sleep(1500);
  await set('sensor.feuchte_bad', '87');
  await sleep(4000);
  ok((await notes(/Lüft|lüft/)).length === 0, 'Person hat Lüften abbestellt → keine Erinnerung', (await notes()).map((c) => c.data?.message));
  const view = (await snapshot()).settings?.notifications;
  ok(view?.kinds?.vent && view?.defaults?.vent?.gap === 120 && view.persons?.[alexId]?.off?.includes('vent'), 'Einstellungen im Snapshot', view);
  await notifySettings({ reset: true, persons: {}, kinds: { vent: { on: true, gap: 120, daily: 3 } }, quiet: { on: true, from: '22:00', to: '07:00' } });
  await heatPlan(bad, { on: false, vent: { ...VENT, on: false } });
  await set('sensor.feuchte_bad', '50');
});

await test('Benachrichtigungen: Regel-Nachricht entprellt', async () => {
  await notifySettings({ reset: true, quiet: { on: false }, kinds: { rule: { on: true, gap: 1, daily: 30 } } });
  await save({ name: 'Haustür', type: 'when', when: [{ subject: 'binary_sensor.haustuer', verb: 'opens' }], then: [{ subject: 'notify:alex_test', verb: 'send', message: 'Haustür geöffnet' }] });
  for (let i = 0; i < 4; i++) {
    await set('binary_sensor.haustuer', 'on');
    await sleep(700);
    await set('binary_sensor.haustuer', 'off');
    await sleep(700);
  }
  await sleep(1000);
  const n = await notes(/Haustür geöffnet/);
  ok(n.length === 1, `Tür prellt 4× in 6 Sek. → 1 Nachricht (${n.length})`, n.map((c) => c.data?.message));
  ok(n[0]?.data?.data?.tag?.startsWith('house_rules_'), 'mit tag (eine ersetzt die andere)', n[0]?.data);
  await set('binary_sensor.haustuer', 'off');
});

// ---------------------------------------------------------------- restart
if (!process.argv.includes('--no-restart') && (!only || 'Neustart'.includes(only))) {
  console.log('\n# Neustart: roomwise prüft alles und korrigiert');
  const k = R['Küche'];
  await ws.call({ type: 'house_rules/features/set', features: { heating: true, light: true } });
  await ws.call({ type: 'house_rules/heating/set', config: G0 });
  const ALLDAY = [{ from: '00:00', to: '23:59', days: 'all', level: 'comfort', temp: 21 }];
  await heatPlan(k, { on: true, thermostats: [], sensor: null, calibrate: 'off', temps: { comfort: 21, base: 18, eco: 17, night: 16, frost: 12 }, blocks: ALLDAY, presence: { away: false, away_after: 0, empty: false, empty_after: 30, home_soon: false }, manual: 'next_block', window: { on: false }, preheat: { on: false, max: 90 }, vent: { on: false }, smart: { mode: 'schedule', valve: { on: false }, guard: {} } });
  ok(await until(async () => { const c = await st('climate.heizung_kueche'); return c.state === 'heat' && c.attributes.temperature === 21; }, 10000), 'vorher: Küche heizt auf 21 °C');
  // the hallway's light plan: nobody there → off right away
  await ws.call({ type: 'house_rules/plan/set', kind: 'light', room: R.Flur, plan: { ...(lightPlans0[R.Flur] ?? {}), on: true, rules: [], empty: { mode: 'off', delay: 0, dim: 10, dim_for: 0 }, manual: 'room_empty' } });
  // a while rule that holds across the restart, and a "Wechselnd" rule that ended before it
  await api('POST', '/api/services/input_boolean/turn_on', { entity_id: 'input_boolean.besuch' });
  await save({ name: 'Besuch: Badlicht', type: 'while', when: [{ subject: 'input_boolean.besuch', verb: 'is_on' }], then: [{ subject: 'light.badlicht', verb: 'turn_on' }, { subject: 'notify:alex_test', verb: 'send', message: 'Besuch da' }] });
  await save({ name: 'Fenster Wohnzimmer: Sofalicht wechselnd', type: 'while', when: [{ subject: 'binary_sensor.fenster_wohnzimmer', verb: 'is_open' }], then: [{ subject: 'light.sofalicht', verb: 'turn_off' }], else: [{ subject: 'light.sofalicht', verb: 'turn_on' }] });
  await set('binary_sensor.fenster_wohnzimmer', 'on');
  await sleep(800);
  await set('binary_sensor.fenster_wohnzimmer', 'off');
  ok(await until(() => isOn('light.badlicht'), 5000), 'vorher: Badlicht an (Besuch)');
  ok(await until(() => isOn('light.sofalicht'), 5000), 'vorher: Sofalicht an (Fenster zu → sonst)');
  await sleep(17000); // the store is saved delayed
  console.log('  (Test-HA wird neu gestartet …)');
  await api('POST', '/api/services/homeassistant/restart', {});
  await sleep(8000);
  await until(async () => (await fetch('http://127.0.0.1:8124/api/').catch(() => null))?.status === 401, 120000, 1000);
  ws.close();
  ws = await wsConnect(tok);
  await until(async () => (await ws.call({ type: 'house_rules/info' }).catch(() => null))?.loaded, 90000, 1000);
  await until(async () => (await snapshot()).devices.length > 10, 90000, 1000);
  const t0 = Date.now();
  await calls(true);
  // like a flow that runs at every start: switches the thermostat off (without a signed-in user – a person in the app
  // counts even during the start, see heating.py) and the hallway light on (with a user's token: the light plan puts
  // back whatever is switched during the start)
  await ws.call({ type: 'hr_fake/call_as', user_id: '', domain: 'climate', service: 'set_hvac_mode', data: { entity_id: 'climate.heizung_kueche', hvac_mode: 'off' } });
  await api('POST', '/api/services/light/turn_on', { entity_id: 'light.flurlicht' });
  ok(await until(async () => { const c = await st('climate.heizung_kueche'); return c.state === 'heat' && c.attributes.temperature === 21 && c; }, 20000), `Thermostat beim Start ausgeschaltet → wieder Plan (heizen, 21 °C) nach ${Math.round((Date.now() - t0) / 1000)} Sek.`, await st('climate.heizung_kueche'));
  ok((await hist(30)).some((x) => /Heizung Küche: aus/.test(x) && /Während des Starts/.test(x)), 'Verlauf: Thermostat war beim Start verstellt', await hist(30));
  ok(await until(async () => !(await isOn('light.flurlicht')), 20000), 'Flurlicht beim Start angeschaltet (niemand da) → wieder aus');
  // the fake lamps come back "off" after the restart: at the end of the start-up phase the rules put them right
  ok(await until(() => isOn('light.badlicht'), 160000, 1000), `Solange-Regel gilt weiter → Badlicht wieder an (${Math.round((Date.now() - t0) / 1000)} Sek. nach dem Start)`, await hist());
  ok(await until(() => isOn('light.sofalicht'), 10000), 'Wechselnd-Regel war im Sonst-Zustand → Sofalicht wieder an');
  ok((await notes(/Besuch da/)).length === 0, 'die Nachricht der Regel kommt nach dem Neustart nicht noch einmal');
  const h = await hist(20);
  ok(h.some((x) => /Nach dem Start alles geprüft/.test(x)), 'Verlauf: nach dem Start alles geprüft', h);
  ok((await ws.call({ type: 'house_rules/history', limit: 30 })).every((e) => !(e.kind === 'manual' && /Heizung Küche|Flurlicht/.test(e.what))), 'die Änderungen beim Start zählen nicht als „von Hand“');
  await api('POST', '/api/services/input_boolean/turn_off', { entity_id: 'input_boolean.besuch' });
  await heatPlan(k, { on: false });
  await ws.call({ type: 'house_rules/plan/set', kind: 'light', room: R.Flur, plan: { ...(lightPlans0[R.Flur] ?? {}), on: false } });
  await clean();
}

// ---------------------------------------------------------------- end
const finish = async () => {
  for (const [r, v] of Object.entries(rooms0)) if (r === R.Flur || r === R.Wohnzimmer) await ws.call({ type: 'house_rules/room/save', room: { id: r, empty_after: v ?? 5 } }).catch(() => null);
  if (features0) await ws.call({ type: 'house_rules/features/set', features: features0 }).catch(() => null);
  console.log(`\n${failures() ? `${failures()} FEHLER` : 'alles ok'}`);
  ws.close();
  process.exit(failures() ? 1 : 0);
};
await finish();
