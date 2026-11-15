// End-to-end test of the Hausregeln integration against the isolated test Home Assistant (port 8124).
// Fake devices come from tools/testha/hr_fake. Usage: node tools/testha/test-engine.mjs [--only name]
import { execSync } from 'node:child_process';
import { token, wsConnect, rest, sleep, ok, failures, until, userToken } from './lib.mjs';

const tok = await token();
const ws = await wsConnect(tok);
const api = rest(tok);
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const set = (entity_id, state, attributes = {}) => ws.call({ type: 'hr_fake/set', entity_id, state, attributes });
const st = async (e) => (await api('GET', `/api/states/${e}`)).body;
const calls = (clear = false) => ws.call({ type: 'hr_fake/calls', clear });

// ---------------------------------------------------------------- setup (idempotent)
const areas = await ws.call({ type: 'config/area_registry/list' });
const area = async (name) => (areas.find((a) => a.name === name) ?? (await ws.call({ type: 'config/area_registry/create', name }))).area_id;
const A = { flur: await area('Flur'), kueche: await area('Küche'), bad: await area('Bad'), wohnzimmer: await area('Wohnzimmer') };
const place = {
  flur: ['light.flurlicht', 'binary_sensor.haustuer', 'binary_sensor.praesenz_flur', 'sensor.lux_flur', 'switch.tablet_bildschirm'],
  kueche: ['light.kuechenlicht', 'binary_sensor.fenster_kueche', 'climate.heizung_kueche', 'switch.wasserkocher', 'binary_sensor.wasser_kueche', 'binary_sensor.fp2_alles', 'binary_sensor.fp2_kochfeld', 'binary_sensor.fp2_essbereich', 'vacuum.robo'],
  bad: ['binary_sensor.fenster_bad', 'binary_sensor.badtuer', 'climate.heizung_bad', 'light.badlicht', 'sensor.temp_bad'],
  wohnzimmer: ['light.sofalicht', 'media_player.homepod', 'binary_sensor.bewegung_wohnzimmer'],
};
for (const [r, ents] of Object.entries(place))
  for (const e of ents) await ws.call({ type: 'config/entity_registry/update', entity_id: e, area_id: A[r] }).catch((err) => console.log('area', e, err.message));

// people with (legacy) trackers
await api('POST', '/api/services/device_tracker/see', { dev_id: 'alex_handy', location_name: 'home' });
await api('POST', '/api/services/device_tracker/see', { dev_id: 'sam_handy', location_name: 'not_home' });
const persons = await ws.call({ type: 'person/list' });
for (const [name, tr] of [
  ['Alex Test', 'device_tracker.alex_handy'],
  ['Sam Test', 'device_tracker.sam_handy'],
])
  if (!persons.storage.some((p) => p.name === name)) await ws.call({ type: 'person/create', name, device_trackers: [tr] });

// integration set up?
let info = await ws.call({ type: 'house_rules/info' }).catch(() => null);
if (!info?.loaded) {
  const flow = await api('POST', '/api/config/config_entries/flow', { handler: 'roomwise' });
  await api('POST', `/api/config/config_entries/flow/${flow.body.flow_id}`, {});
  info = await until(async () => {
    const i = await ws.call({ type: 'house_rules/info' }).catch(() => null);
    return i?.loaded && i;
  });
}
ok(info?.loaded, `integration läuft (${info?.version}, API ${info?.api})`);
// Home Assistant may still be starting: the integration builds its inventory once HA runs
await until(async () => (await ws.call({ type: 'house_rules/snapshot' })).devices.length > 10, 90000, 1000);
// the areas set above count once Hausregeln rebuilds (3 s after the last registry change)
await until(async () => (await ws.call({ type: 'house_rules/snapshot' })).rooms.find((r) => r.name === 'Küche')?.presence.length > 0, 15000, 500);

// fresh state for every run: delete own rules
let snap = await ws.call({ type: 'house_rules/snapshot' });
for (const r of snap.rules) await ws.call({ type: 'house_rules/rule/delete', rule_id: r.id });
await ws.call({ type: 'house_rules/mode/set', mode: 'home' });
// a fresh install starts with the features off (the wizard switches them on): the tests need light, heating,
// vacation and room behaviours running
const features0 = (await ws.call({ type: 'house_rules/snapshot' })).features;
await ws.call({ type: 'house_rules/features/set', features: { light: true, heating: true, vacation: true, behaviours: true } });
// at the end the features are set back as they were before the run
const restoreFeatures = (conn) => (features0 ? conn.call({ type: 'house_rules/features/set', features: features0 }).catch(() => null) : null);
for (const b of ['light_on_enter', 'light_off_empty', 'night_dim', 'heat_eco_empty', 'media_pause_empty']) await ws.call({ type: 'house_rules/behaviour/set', behaviour: b, on: false });
const reset = async () => {
  for (const [e, s] of [
    ['binary_sensor.haustuer', 'off'],
    ['binary_sensor.fenster_kueche', 'off'],
    ['binary_sensor.fenster_bad', 'off'],
    ['binary_sensor.badtuer', 'off'],
    ['binary_sensor.praesenz_flur', 'off'],
    ['binary_sensor.fp2_alles', 'off'],
    ['binary_sensor.fp2_kochfeld', 'off'],
    ['light.flurlicht', 'off'],
    ['light.kuechenlicht', 'off'],
    ['light.badlicht', 'off'],
    ['switch.wasserkocher', 'off'],
    ['switch.tablet_bildschirm', 'off'],
    ['switch.sirene', 'off'],
  ])
    await set(e, s);
  await set('climate.heizung_kueche', 'heat', { temperature: 21 });
  await set('climate.heizung_bad', 'heat', { temperature: 22 });
  await calls(true);
};
await reset();
await sleep(500);
snap = await ws.call({ type: 'house_rules/snapshot' });
const save = async (rule) => (await ws.call({ type: 'house_rules/rule/save', rule })).rule;
const test = async (name, fn) => {
  if (only && !name.includes(only)) return;
  console.log(`\n# ${name}`);
  try {
    await fn();
  } catch (e) {
    ok(false, `${name}: ${e.message}`);
  }
  snap = await ws.call({ type: 'house_rules/snapshot' });
  for (const r of snap.rules) await ws.call({ type: 'house_rules/rule/delete', rule_id: r.id });
  await reset();
  await sleep(300);
};

await ws.call({ type: 'house_rules/suggestion/restore' });
// messages count against the limits of notify.py (kept across runs): every run starts from zero
// (no quiet hours, no gaps or daily limits here: those are tested in test-reliability.mjs)
await ws.call({ type: 'house_rules/settings/set', settings: { notifications: { reset: true, quiet: { on: false }, kinds: Object.fromEntries(['rule', 'rule_report', 'window', 'alarm_info'].map((k) => [k, { on: true, gap: 0, daily: 0 }])) } } });
// right after a start the alarm waits a minute before sensors count (restart safety)
await until(async () => !(await ws.call({ type: 'house_rules/snapshot' })).alarm.settling, 120000, 1000);
// in the start-up phase changes by others do not count as "by hand" yet (core.starting)
await until(async () => (await ws.call({ type: 'house_rules/snapshot' })).starting === false, 150000, 1000);
snap = await ws.call({ type: 'house_rules/snapshot' });
await test('Inventar', async () => {
  const dev = Object.fromEntries(snap.devices.map((d) => [d.entity_id, d]));
  ok(dev['binary_sensor.fenster_kueche']?.kind === 'window' && dev['binary_sensor.fenster_kueche']?.kind_hint === 'door', 'Fensterkontakt als „Tür“ eingetragen → Fenster mit Hinweis', dev['binary_sensor.fenster_kueche']);
  ok(dev['binary_sensor.haustuer']?.kind === 'door', 'Haustür bleibt Tür');
  ok(dev['binary_sensor.fp2_kochfeld']?.kind === 'zone' && dev['binary_sensor.fp2_alles']?.kind === 'presence', 'FP2: ein Sensor für den Raum, die anderen sind Zonen', [dev['binary_sensor.fp2_alles'], dev['binary_sensor.fp2_kochfeld']]);
  ok(dev['switch.wasserkocher']?.kind === 'outlet', 'Steckdose erkannt');
  const kueche = snap.rooms.find((r) => r.name === 'Küche');
  ok(kueche?.in === 'in der Küche', '„in der Küche“');
  ok(kueche?.presence.includes('binary_sensor.fp2_alles') && kueche?.zones.length === 2, 'Küche: Anwesenheit + 2 Zonen automatisch zugeordnet', kueche);
  const bad = snap.rooms.find((r) => r.name === 'Bad');
  ok(bad?.door_logic === true, 'Bad ohne Sensor: Tür-Logik automatisch an', bad);
  const alex = snap.persons.find((p) => p.name === 'Alex');
  ok(alex?.phone === 'mobile_app_iphone_von_alex', 'Handy von Alex gefunden', snap.persons);
  ok(snap.automations.length >= 2 && snap.automations[0].summary.length > 10, 'HA-Automationen gelesen', snap.automations[0]);
  ok(snap.suggestions.some((s) => s.id.startsWith('s_merge_')), 'Vorschlag: 2 Tablet-Automationen → 1 Regel', snap.suggestions.map((s) => s.id));
  ok(snap.suggestions.some((s) => s.id === 's_kinds'), 'Vorschlag: falsch eingeordnete Fensterkontakte');
  ok(snap.suggestions.some((s) => s.id === 's_window_heating'), 'Vorschlag: Heizung aus bei offenem Fenster');
});

await test('Wenn-Regel mit „für 3 Sek.“', async () => {
  const r = await save({ name: 'Licht beim Heimkommen', type: 'when', when: [{ subject: 'binary_sensor.haustuer', verb: 'opens' }], then: [{ subject: 'light.flurlicht', verb: 'turn_on', brightness: 70, for: '3s' }] });
  ok(r.tags.includes('light'), 'Tag „light“ automatisch');
  await set('binary_sensor.haustuer', 'on');
  const on = await until(async () => (await st('light.flurlicht')).state === 'on');
  ok(on, 'Haustür auf → Flurlicht an');
  ok(Math.abs((await st('light.flurlicht')).attributes.brightness - 178) <= 2, '70 % Helligkeit');
  const off = await until(async () => (await st('light.flurlicht')).state === 'off', 6000);
  ok(off, 'nach 3 Sek. wieder aus (Zustand von vorher)');
  const h = await ws.call({ type: 'house_rules/history', limit: 10 });
  ok(h.some((e) => e.rule === r.id && /Flurlicht/.test(e.what) && /Haustür/.test(e.why)), 'Verlauf: was und warum', h[0]);
  const sw = await st(`switch.${(await ws.call({ type: 'config/entity_registry/list' })).find((e) => e.unique_id === `rule_${r.id}`)?.entity_id?.split('.')[1]}`);
  ok(sw?.state === 'on' && sw.attributes.sentence?.startsWith('Wenn Haustür'), 'Schalter für die Regel mit Satz', sw);
});

await test('Bedingung und Probelauf', async () => {
  const rule = { name: 'Nur wenn niemand zuhause', type: 'when', when: [{ subject: 'binary_sensor.haustuer', verb: 'opens' }], and: [{ subject: 'person:everyone', verb: 'is_away' }], then: [{ subject: 'notify:alex_test', verb: 'send', message: 'Haustür geöffnet' }] };
  const t = await ws.call({ type: 'house_rules/rule/test', rule });
  ok(t.checks.find((c) => c.section === 'and')?.ok === false && /Alex: Zuhause/.test(t.checks.find((c) => c.section === 'and').now), 'Probelauf: „alle weg“ stimmt nicht (Alex zuhause)', t);
  ok(/Würde jetzt nichts tun/.test(t.verdict), 'Probelauf-Urteil', t.verdict);
  await save(rule);
  await set('binary_sensor.haustuer', 'on');
  await sleep(800);
  ok((await calls()).length === 0, 'Alex zuhause → keine Nachricht');
  await set('binary_sensor.haustuer', 'off');
  await api('POST', '/api/services/device_tracker/see', { dev_id: 'alex_handy', location_name: 'not_home' });
  await sleep(400);
  await set('binary_sensor.haustuer', 'on');
  const c = await until(async () => (await calls()).find((x) => x.service === 'notify.mobile_app_iphone_von_alex'));
  ok(c?.data?.message === 'Haustür geöffnet', 'alle weg → Nachricht an Alex’ Handy', c);
  await api('POST', '/api/services/device_tracker/see', { dev_id: 'alex_handy', location_name: 'home' });
});

await test('Solange + „im selben Raum“ + Wiederherstellen', async () => {
  await save({ name: 'Heizung aus bei offenem Fenster', type: 'while', when: [{ subject: 'any:window', verb: 'is_open', for: '2s' }], then: [{ subject: 'all:climate@same', verb: 'turn_off' }] });
  await set('climate.heizung_kueche', 'heat', { temperature: 21.5 });
  await set('binary_sensor.fenster_kueche', 'on');
  await sleep(900);
  ok((await st('climate.heizung_kueche')).state === 'heat', 'nach 1 Sek. noch an (wartet 2 Sek.)');
  ok(await until(async () => (await st('climate.heizung_kueche')).state === 'off', 5000), 'Fenster Küche 2 Sek. offen → Heizung Küche aus');
  ok((await st('climate.heizung_bad')).state === 'heat', 'Heizung Bad bleibt an (anderer Raum)');
  const s1 = await ws.call({ type: 'house_rules/snapshot' });
  ok(Object.values(s1.active).flat().includes(A.kueche), 'gilt gerade für die Küche', s1.active);
  await set('binary_sensor.fenster_kueche', 'off');
  ok(await until(async () => (await st('climate.heizung_kueche')).state === 'heat'), 'Fenster zu → Heizung wieder an');
  ok((await st('climate.heizung_kueche')).attributes.temperature === 21.5, 'mit der alten Temperatur (21,5 °C)');
});

await test('Solange: Handbedienung bleibt', async () => {
  await save({ name: 'Heizung aus bei offenem Fenster', type: 'while', when: [{ subject: 'any:window', verb: 'is_open' }], then: [{ subject: 'all:climate@same', verb: 'turn_off' }] });
  await set('binary_sensor.fenster_bad', 'on');
  ok(await until(async () => (await st('climate.heizung_bad')).state === 'off'), 'Fenster Bad offen → Heizung Bad aus');
  await sleep(300);
  await api('POST', '/api/services/climate/set_hvac_mode', { entity_id: 'climate.heizung_bad', hvac_mode: 'heat' }); // by hand (user context)
  await api('POST', '/api/services/climate/set_temperature', { entity_id: 'climate.heizung_bad', temperature: 25 });
  await sleep(300);
  await set('binary_sensor.fenster_bad', 'off');
  await sleep(800);
  const h = await ws.call({ type: 'house_rules/history', limit: 5 });
  ok((await st('climate.heizung_bad')).attributes.temperature === 25, 'von Hand gesetzte 25 °C bleiben');
  ok(h.some((e) => /bleibt so/.test(e.why)), 'Verlauf erklärt es', h.slice(0, 3));
  ok(h.some((e) => e.kind === 'manual'), 'Handbedienung im Verlauf');
});

await test('Solange: ohne Wiederherstellen und Wechselnd (sonst)', async () => {
  await set('binary_sensor.fenster_kueche', 'off');
  await set('climate.heizung_kueche', 'heat', { temperature: 21 });
  let r = await save({ name: 'Heizung aus, nicht zurück', type: 'while', when: [{ subject: 'binary_sensor.fenster_kueche', verb: 'is_open' }], then: [{ subject: 'climate.heizung_kueche', verb: 'turn_off' }], options: { restore: false } });
  ok(r.options.restore === false, 'Haken „Danach wieder herstellen“ aus gespeichert');
  await set('binary_sensor.fenster_kueche', 'on');
  ok(await until(async () => (await st('climate.heizung_kueche')).state === 'off'), 'Fenster auf → Heizung aus');
  await set('binary_sensor.fenster_kueche', 'off');
  await sleep(1200);
  ok((await st('climate.heizung_kueche')).state === 'off', 'ohne Wiederherstellen: Heizung bleibt aus');
  await ws.call({ type: 'house_rules/rule/delete', rule_id: r.id });
  const r0 = await save({ name: 'Standard', type: 'while', when: [{ subject: 'binary_sensor.fenster_kueche', verb: 'is_open' }], then: [{ subject: 'climate.heizung_kueche', verb: 'turn_off' }] });
  ok(r0.options.restore === true, 'Standard: wieder herstellen an');
  await ws.call({ type: 'house_rules/rule/delete', rule_id: r0.id });

  await set('light.kuechenlicht', 'off');
  await set('light.flurlicht', 'off');
  await set('binary_sensor.fp2_essbereich', 'off');
  r = await save({
    name: 'Essbereich wechselnd',
    type: 'while',
    when: [{ subject: 'binary_sensor.fp2_essbereich', verb: 'is_occupied' }],
    then: [{ subject: 'light.kuechenlicht', verb: 'turn_on' }],
    else: [{ subject: 'light.kuechenlicht', verb: 'turn_off' }, { subject: 'light.flurlicht', verb: 'turn_on' }],
    options: { manual_pause: '' },
  });
  ok(r.else?.length === 2, 'Sonst-Schritte gespeichert', r);
  const d = await ws.call({ type: 'house_rules/rule/describe', rule: r });
  ok(/sonst/.test(d.sentence), 'Satz mit „sonst“', d.sentence);
  await set('binary_sensor.fp2_essbereich', 'on');
  ok(await until(async () => (await st('light.kuechenlicht')).state === 'on'), 'belegt → Küchenlicht an');
  ok((await st('light.flurlicht')).state === 'off', 'Sonst-Schritt noch nicht gelaufen');
  await set('binary_sensor.fp2_essbereich', 'off');
  ok(await until(async () => (await st('light.flurlicht')).state === 'on' && (await st('light.kuechenlicht')).state === 'off'), 'frei → sonst: Küchenlicht aus, Flurlicht an');
  const fe = await ws.call({ type: 'house_rules/for_entity', entity_id: 'light.flurlicht' });
  ok(fe.switches.includes(r.id), 'Gerät im Sonst-Teil zählt als „wird geschaltet“');
  const h = await ws.call({ type: 'house_rules/history', limit: 4 });
  ok(h.some((e) => /Sonst/.test(e.why)), 'Verlauf nennt den Sonst-Teil', h.map((e) => e.why));
  r = await save({ ...r, type: 'when', when: [{ subject: 'binary_sensor.fp2_essbereich', verb: 'occupied' }] });
  ok(!('else' in r), 'Wenn-Regeln haben keinen Sonst-Teil');
});

await test('Alle Entitäten: Helfer, Knöpfe, Auswahl, Zahlen', async () => {
  await api('POST', '/api/services/input_boolean/turn_off', { entity_id: 'input_boolean.besuch' });
  await api('POST', '/api/services/input_select/select_option', { entity_id: 'input_select.waschprogramm', option: 'Eco' });
  await api('POST', '/api/services/input_number/set_value', { entity_id: 'input_number.zieltemp', value: 18 });
  const r1 = await save({ name: 'Klingel → Besuch', when: [{ subject: 'input_button.klingel', verb: 'pressed' }], then: [{ subject: 'input_boolean.besuch', verb: 'turn_on' }], options: { manual_pause: '' } });
  const d = await ws.call({ type: 'house_rules/rule/describe', rule: r1 });
  ok(/Klingel/.test(d.sentence) && /Besuch da/.test(d.sentence), 'Satz mit den Namen aus Home Assistant', d.sentence);
  await api('POST', '/api/services/input_button/press', { entity_id: 'input_button.klingel' });
  ok(await until(async () => (await st('input_boolean.besuch')).state === 'on'), 'Knopf gedrückt → Helfer an');
  const r2 = await save({ name: 'Programm → Temperatur', when: [{ subject: 'input_select.waschprogramm', verb: 'becomes', state: 'Schnell' }], then: [{ subject: 'input_number.zieltemp', verb: 'set_value', value: 22.5 }], options: { manual_pause: '' } });
  await api('POST', '/api/services/input_select/select_option', { entity_id: 'input_select.waschprogramm', option: 'Schnell' });
  ok(await until(async () => Number((await st('input_number.zieltemp')).state) === 22.5), 'Auswahl wechselt auf „Schnell“ → Zahl auf 22,5');
  const r3 = await save({
    name: 'Besuch: Baumwolle',
    type: 'while',
    when: [{ subject: 'input_boolean.besuch', verb: 'is_on' }, { subject: 'input_number.zieltemp', verb: 'is_above', value: 20 }],
    then: [{ subject: 'input_select.waschprogramm', verb: 'select', state: 'Baumwolle' }],
    options: { manual_pause: '' },
  });
  ok(await until(async () => (await st('input_select.waschprogramm')).state === 'Baumwolle'), 'Solange Helfer an und Zahl über 20 → Auswahl „Baumwolle“');
  await api('POST', '/api/services/input_boolean/turn_off', { entity_id: 'input_boolean.besuch' });
  ok(await until(async () => (await st('input_select.waschprogramm')).state === 'Schnell'), 'danach wieder „Schnell“');
  for (const r of [r1, r2, r3]) await ws.call({ type: 'house_rules/rule/delete', rule_id: r.id });
});

await test('Weit weg von einem Ort (Urlaub)', async () => {
  const conf = (await api('GET', '/api/config')).body;
  await api('POST', '/api/services/input_boolean/turn_off', { entity_id: 'input_boolean.besuch' });
  const r = await save({ name: 'Weit weg', when: [{ subject: 'person:alex_test', verb: 'far_from', distance: 100, zone: 'home' }], then: [{ subject: 'input_boolean.besuch', verb: 'turn_on' }], options: { manual_pause: '' } });
  const d = await ws.call({ type: 'house_rules/rule/describe', rule: r });
  ok(/mehr als 100 km von Zuhause weg/.test(d.sentence), 'Satz mit Entfernung', d.sentence);
  await api('POST', '/api/services/device_tracker/see', { dev_id: 'alex_handy', gps: [conf.latitude + 0.5, conf.longitude], gps_accuracy: 10 });
  await until(async () => (await st('person.alex_test')).attributes.latitude > conf.latitude + 0.4);
  await sleep(500);
  ok((await st('input_boolean.besuch')).state === 'off', '55 km weg: noch nicht', await st('person.alex_test'));
  await api('POST', '/api/services/device_tracker/see', { dev_id: 'alex_handy', gps: [conf.latitude + 1.5, conf.longitude], gps_accuracy: 10 });
  ok(await until(async () => (await st('input_boolean.besuch')).state === 'on'), '165 km weg → ausgelöst', [await st('person.alex_test'), (await ws.call({ type: 'house_rules/history', limit: 3 })).map((h) => h.what)]);
  const t = await ws.call({ type: 'house_rules/rule/test', rule: { ...r, type: 'while', when: [{ subject: 'person:alex_test', verb: 'is_far', distance: 100, zone: 'home' }] } });
  ok(t.checks[0]?.ok === true, 'als Bedingung: ist weit weg', t.checks);
  await ws.call({ type: 'house_rules/rule/delete', rule_id: r.id });
  await api('POST', '/api/services/device_tracker/see', { dev_id: 'alex_handy', location_name: 'home', gps: [conf.latitude, conf.longitude], gps_accuracy: 10 });
});

await test('Saugroboter: Melder pausieren', async () => {
  await set('vacuum.robo', 'docked');
  await set('binary_sensor.praesenz_flur', 'off');
  await set('light.flurlicht', 'off');
  // the hallway must be empty first (it may still count as occupied from an earlier test: "leer nach 5 Min.")
  const flur0 = (await ws.call({ type: 'house_rules/snapshot' })).rooms.find((x) => x.name === 'Flur');
  await ws.call({ type: 'house_rules/room/save', room: { id: flur0.id, empty_after: 0.05 } });
  await until(async () => !(await ws.call({ type: 'house_rules/snapshot' })).occupancy[flur0.id]?.occupied, 10000);
  let c = await ws.call({ type: 'house_rules/cleaning/set', config: { on: true, vacuums: ['vacuum.robo'], sensors: 'all', after: 0 } });
  ok(c.on && c.vacuums[0] === 'vacuum.robo' && !c.active, 'Saugroboter verknüpft');
  const r = await save({ name: 'Flur belegt → Licht', when: [{ subject: 'binary_sensor.praesenz_flur', verb: 'occupied' }], then: [{ subject: 'light.flurlicht', verb: 'turn_on' }], options: { manual_pause: '' } });
  await ws.call({ type: 'house_rules/alarm/config', config: { enabled: true, code: null, modes: { away: { sensors: ['binary_sensor.praesenz_flur'], exit_delay: 0, entry_delay: 0, reaction: 'notify', smart: { inside: { on: false }, arrival: { on: false } }, auto: { arm_away: false } } } } });
  await ws.call({ type: 'house_rules/alarm/arm', mode: 'away', force: true });
  ok(await until(async () => (await st('alarm_control_panel.alarmanlage')).state === 'armed_away'), 'Alarm scharf (abwesend)');
  await set('vacuum.robo', 'cleaning');
  ok(await until(async () => (await ws.call({ type: 'house_rules/snapshot' })).cleaning.active), 'reinigt: Pause aktiv');
  await set('binary_sensor.praesenz_flur', 'on');
  await sleep(1200);
  ok((await st('light.flurlicht')).state === 'off', 'Melder schlägt an: Regel löst nicht aus');
  ok((await st('alarm_control_panel.alarmanlage')).state === 'armed_away', 'kein Alarm');
  const snap2 = await ws.call({ type: 'house_rules/snapshot' });
  const flurId = snap2.rooms.find((x) => x.name === 'Flur').id;
  const occ = snap2.occupancy[flurId];
  ok(!occ?.occupied || !/Anwesenheitssensor Flur/i.test(occ.by ?? ''), 'Flur gilt nicht durch den Melder als belegt', [occ, snap2.cleaning, (await ws.call({ type: 'house_rules/history', limit: 8 })).map((e) => e.at.slice(11, 19) + ' ' + e.what)]);
  const h = await ws.call({ type: 'house_rules/history', limit: 6 });
  ok(h.some((e) => /Saugroboter reinigt/.test(e.why)), 'Verlauf erklärt es', h.map((e) => e.what));
  await ws.call({ type: 'house_rules/alarm/disarm' });
  await set('binary_sensor.praesenz_flur', 'off');
  await set('vacuum.robo', 'docked');
  await ws.call({ type: 'house_rules/room/save', room: { id: flur0.id, empty_after: flur0.empty_after } });
  ok(await until(async () => !(await ws.call({ type: 'house_rules/snapshot' })).cleaning.active, 4000), 'fertig: Pause vorbei');
  await set('binary_sensor.praesenz_flur', 'on');
  ok(await until(async () => (await st('light.flurlicht')).state === 'on'), 'danach löst der Melder wieder aus');
  await set('binary_sensor.praesenz_flur', 'off');
  await ws.call({ type: 'house_rules/rule/delete', rule_id: r.id });
  await ws.call({ type: 'house_rules/cleaning/set', config: { on: false } });
  await ws.call({ type: 'house_rules/alarm/config', config: { enabled: false, modes: { away: { reaction: 'loud' } } } });
});

await test('Wer wohnt hier (Bewohner)', async () => {
  let snap = await ws.call({ type: 'house_rules/snapshot' });
  ok(snap.residents.length >= 1 && snap.residents.every((p) => p.counts), 'alle Personen zählen', snap.residents);
  const someone = snap.residents.find((p) => p.entity_id !== 'person.alex_test') ?? snap.residents[0];
  await ws.call({ type: 'house_rules/settings/set', settings: { persons_excluded: [someone.entity_id] } });
  snap = await ws.call({ type: 'house_rules/snapshot' });
  ok(!snap.residents.find((p) => p.entity_id === someone.entity_id).counts && !snap.persons.some((p) => p.entity_id === someone.entity_id), 'herausgenommen: zählt nicht mehr', snap.persons.map((p) => p.entity_id));
  await ws.call({ type: 'house_rules/settings/set', settings: { persons_excluded: [] } });
  snap = await ws.call({ type: 'house_rules/snapshot' });
  ok(snap.persons.some((p) => p.entity_id === someone.entity_id), 'wieder drin');
});

await test('Oder in Bedingungen (Solange)', async () => {
  await api('POST', '/api/services/input_boolean/turn_off', { entity_id: 'input_boolean.besuch' });
  await set('binary_sensor.fp2_essbereich', 'off');
  await set('light.kuechenlicht', 'off');
  const r = await save({
    name: 'Besuch oder Essbereich',
    type: 'while',
    when: [{ subject: 'input_boolean.besuch', verb: 'is_on', or: [{ subject: 'binary_sensor.fp2_essbereich', verb: 'is_occupied' }] }],
    then: [{ subject: 'light.kuechenlicht', verb: 'turn_on' }],
    else: [{ subject: 'light.kuechenlicht', verb: 'turn_off' }],
    options: { manual_pause: '' },
  });
  ok(r.when[0].or?.length === 1, 'Oder gespeichert', r.when);
  const d = await ws.call({ type: 'house_rules/rule/describe', rule: r });
  ok(/oder/.test(d.sentence), 'Satz mit „oder“', d.sentence);
  await set('binary_sensor.fp2_essbereich', 'on');
  ok(await until(async () => (await st('light.kuechenlicht')).state === 'on'), 'zweite Möglichkeit reicht → an');
  await api('POST', '/api/services/input_boolean/turn_on', { entity_id: 'input_boolean.besuch' });
  await set('binary_sensor.fp2_essbereich', 'off');
  await sleep(1000);
  ok((await st('light.kuechenlicht')).state === 'on', 'erste gilt noch → bleibt an');
  await api('POST', '/api/services/input_boolean/turn_off', { entity_id: 'input_boolean.besuch' });
  ok(await until(async () => (await st('light.kuechenlicht')).state === 'off'), 'keine gilt mehr → sonst: aus');
  await ws.call({ type: 'house_rules/rule/delete', rule_id: r.id });
});

await test('Feinheiten: seit bei Messwerten, Lichthelligkeit, länger aus', async () => {
  await set('sensor.lux_flur', '10');
  await set('light.badlicht', 'off');
  // "Helligkeit über 300 lx seit 4 Sek." — the value keeps changing, the time must still count from when it went over
  const r = await save({
    name: 'Hell seit',
    type: 'while',
    when: [{ subject: 'sensor.lux_flur', verb: 'is_above', value: 300, for: '4s' }],
    then: [{ subject: 'light.badlicht', verb: 'turn_on' }],
    else: [{ subject: 'light.badlicht', verb: 'turn_off' }],
    options: { manual_pause: '' },
  });
  await set('sensor.lux_flur', '400');
  await sleep(1500);
  await set('sensor.lux_flur', '420');
  await sleep(1500);
  await set('sensor.lux_flur', '410');
  ok((await st('light.badlicht')).state === 'off', 'erst 3 Sek. über 300 lx → noch nicht');
  ok(await until(async () => (await st('light.badlicht')).state === 'on', 5000), 'über 300 lx seit 4 Sek. (Wert hat sich zwischendurch geändert) → an');
  await set('sensor.lux_flur', '100');
  ok(await until(async () => (await st('light.badlicht')).state === 'off'), 'wieder darunter → sonst: aus');
  await ws.call({ type: 'house_rules/rule/delete', rule_id: r.id });

  // light brightness as a condition, and "länger als 3 Sek. aus" as a trigger
  await api('POST', '/api/services/light/turn_on', { entity_id: 'light.sofalicht', brightness_pct: 20 });
  await sleep(500);
  const mk = (verb) => ({ name: 'x', type: 'when', when: [{ subject: 'binary_sensor.haustuer', verb: 'opens' }], and: [{ subject: 'light.sofalicht', verb, brightness: 30 }], then: [] });
  const t1 = await ws.call({ type: 'house_rules/rule/test', rule: mk('is_dimmer') });
  const t2 = await ws.call({ type: 'house_rules/rule/test', rule: mk('is_brighter') });
  ok(t1.checks.find((c) => c.section === 'and')?.ok === true && t2.checks.find((c) => c.section === 'and')?.ok === false, 'Sofalicht 20 %: dunkler als 30 % ja, heller nein', [t1.checks, t2.checks]);
  await set('light.badlicht', 'on');
  const r2 = await save({ name: 'Bad länger aus', when: [{ subject: 'light.badlicht', verb: 'off_for', for: '3s' }], then: [{ subject: 'light.flurlicht', verb: 'turn_on' }], options: { manual_pause: '' } });
  await set('light.flurlicht', 'off');
  await set('light.badlicht', 'off');
  await sleep(1500);
  ok((await st('light.flurlicht')).state === 'off', 'Bad erst 1,5 Sek. aus → noch nichts');
  ok(await until(async () => (await st('light.flurlicht')).state === 'on', 5000), 'Bad länger als 3 Sek. aus → Flurlicht an');
  await ws.call({ type: 'house_rules/rule/delete', rule_id: r2.id });
  await set('light.flurlicht', 'off');
  await set('light.sofalicht', 'off');
});

await test('Urlaub: bewohnt wirken (gelernt)', async () => {
  const v = await ws.call({ type: 'house_rules/sim/learn' });
  // "ins Bett" needs a bedroom with a sensor (the fake devices have none unless a run before gave it one)
  const bedroom = (await ws.call({ type: 'house_rules/snapshot' })).rooms.some((r) => /schlaf|bed/i.test(r.name) && (r.presence?.length || r.motion?.length));
  ok(Array.isArray(v.timeline) && (!bedroom || v.timeline.some((x) => x.kind === 'bed')) && v.timeline.some((x) => x.kind === 'stay'), 'Tagesablauf simuliert (auch ohne genug Gelerntes)', v.timeline.length);
  ok(Object.keys(v.neighbours).length > 0, 'Nachbarräume vorhanden', v.neighbours);
  const v2 = await ws.call({ type: 'house_rules/sim/set', config: { people: 2, night: false } });
  ok(v2.people === 2 && !v2.config.night && !v2.timeline.some((x) => x.kind === 'night'), 'Einstellungen: 2 Personen, nachts aus');
  ok(new Set(v2.timeline.map((x) => x.walker)).size === 2, 'zwei Personen laufen getrennt');
  const v3 = await ws.call({ type: 'house_rules/sim/view', day: '2026-12-24' });
  ok(v3.day === '2026-12-24' && v3.timeline.length > 0, 'Vorschau für einen anderen Tag');
  await ws.call({ type: 'house_rules/sim/set', config: { people: 0, night: true } });
});

await test('Lichtplan und Heizplan', async () => {
  const snap = await ws.call({ type: 'house_rules/snapshot' });
  const kue = snap.rooms.find((x) => x.name === 'Küche');
  const bad = snap.rooms.find((x) => x.name === 'Bad');
  ok(snap.plans?.light?.[kue.id] && snap.plans?.heat?.[bad.id], 'Pläne im Snapshot');
  for (const e of ['binary_sensor.fp2_alles', 'binary_sensor.fp2_kochfeld', 'binary_sensor.fp2_essbereich']) await set(e, 'off');
  await set('light.kuechenlicht', 'off');
  await ws.call({ type: 'house_rules/room/save', room: { id: kue.id, empty_after: 0.05 } });
  await until(async () => !(await ws.call({ type: 'house_rules/snapshot' })).occupancy[kue.id]?.occupied, 10000);
  const pl = async (plan) => ws.call({ type: 'house_rules/plan/set', kind: 'light', room: kue.id, plan: { ...(await ws.call({ type: 'house_rules/snapshot' })).plans.light[kue.id], ...plan } });
  const bri = async () => (await st('light.kuechenlicht')).attributes.brightness ?? 0;
  const pct = async () => Math.round((await bri()) / 2.55);
  const isOn = async () => (await st('light.kuechenlicht')).state === 'on';
  const besuch = (on) => api('POST', `/api/services/input_boolean/turn_${on ? 'on' : 'off'}`, { entity_id: 'input_boolean.besuch' });
  const enter = () => set('binary_sensor.fp2_alles', 'on');
  const leave = () => set('binary_sensor.fp2_alles', 'off');
  const base = { kind: 'when', enabled: true, trigger: [], when: [], lights: [], variants: [], after: 'others', empty_after: 'off', action: { mode: 'on', brightness: 80, color: 'neutral' } };
  await besuch(false);
  const R1 = { ...base, id: 'r1', name: 'Reinkommen', trigger: [{ subject: `room:${kue.id}`, verb: 'is_occupied' }], variants: [{ id: 'v', when: [{ subject: 'input_boolean.besuch', verb: 'is_on' }], mode: 'on', brightness: 30, color: 'warm' }] };
  let v = await pl({ on: true, rules: [R1], empty: { mode: 'off', delay: 0.05, dim: 10, dim_for: 5 }, manual: 'room_empty', guests_keep: true });
  ok(v.light[kue.id].on && v.light[kue.id].rules.length === 1, 'Lichtregeln gespeichert');
  await enter();
  ok(await until(async () => (await isOn()) && Math.abs((await pct()) - 80) <= 2), '„Wenn jemand reinkommt“ → 80 %', await pct());
  await sleep(500);
  const hh = await ws.call({ type: 'house_rules/history', limit: 6 });
  ok(!hh.some((e) => e.kind === 'manual' && e.entity_id === 'light.kuechenlicht'), 'Lichtregel zählt nicht als „von Hand“', hh.map((e) => e.kind + ' ' + e.what));
  await ws.call({ type: 'house_rules/room/save', room: { id: kue.id, empty_after: 0.2 } });
  await leave();
  const pend = await until(async () => (await ws.call({ type: 'house_rules/snapshot' })).occupancy[kue.id]?.empty_at, 3000);
  ok(pend, 'niemand mehr erkannt: „leer um …“ wird gemeldet');
  ok(await until(async () => !(await ws.call({ type: 'house_rules/snapshot' })).occupancy[kue.id]?.occupied, 20000), 'nach dem Nachlauf leer');
  await ws.call({ type: 'house_rules/room/save', room: { id: kue.id, empty_after: 0.05 } });
  await until(async () => !(await isOn()), 12000);
  await enter();
  await until(async () => await isOn());
  await leave();
  ok(await until(async () => !(await isOn()), 12000), 'niemand mehr da (nach dem Timer) → aus');
  await besuch(true);
  await enter();
  ok(await until(async () => (await isOn()) && Math.abs((await pct()) - 30) <= 2), 'je nach: Besuch → 30 %', await pct());
  await besuch(false);
  // while: more important than the "when" result, afterwards back to it
  const R2 = { ...base, id: 'r2', name: 'Besuch', kind: 'while', when: [{ subject: 'input_boolean.besuch', verb: 'is_on' }], action: { mode: 'on', brightness: 20, color: 'warm' } };
  await pl({ rules: [R1, R2] });
  await leave();
  await until(async () => !(await isOn()), 12000);
  await enter();
  ok(await until(async () => Math.abs((await pct()) - 80) <= 2), 'wieder 80 %');
  await besuch(true);
  ok(await until(async () => Math.abs((await pct()) - 20) <= 2), '„Solange Besuch“ → 20 %', await pct());
  await besuch(false);
  ok(await until(async () => Math.abs((await pct()) - 80) <= 2), 'vorbei → was die anderen sagen: 80 %', await pct());
  // another automation switches it off: counts like by hand, the "when" rule does not take it back
  await api('POST', '/api/events/hr_test_kitchen_off', {});
  ok(await until(async () => !(await isOn()), 3000) || true, '(HA-Automation schaltet aus)');
  await sleep(2000);
  ok(!(await isOn()), 'andere Automation schaltet aus → bleibt aus (wie von Hand, die Wenn-Regel setzt nur einmal)');
  // a switch at the device (no app, no automation) counts as by hand
  await set('light.kuechenlicht', 'off');
  await sleep(1500);
  ok(!(await isOn()), 'Schalter am Gerät: gilt als von Hand, bleibt aus', [(await ws.call({ type: 'house_rules/snapshot' })).plans.now[kue.id], (await ws.call({ type: 'house_rules/history', limit: 4 })).map((h) => h.what + ' | ' + h.why)]);
  // by hand: stays until the room was empty
  await api('POST', '/api/services/light/turn_on', { entity_id: 'light.kuechenlicht', brightness_pct: 50 });
  await sleep(1500);
  await besuch(true);
  await sleep(1500);
  ok(Math.abs((await pct()) - 50) <= 2, 'von Hand 50 %: bleibt, solange jemand da ist', await pct());
  await besuch(false);
  await leave();
  ok(await until(async () => !(await isOn()), 12000), 'leer → aus, Handbedienung vergessen');
  // keep on: stays on while … even when the room is empty; afterwards (room empty) off
  const R3 = { ...base, id: 'r3', name: 'Bleibt bei Besuch', kind: 'keep_on', when: [{ subject: 'input_boolean.besuch', verb: 'is_on' }], empty_after: 'off' };
  await pl({ rules: [R1, R3] });
  await enter();
  ok(await until(async () => await isOn()), 'an');
  await besuch(true);
  await leave();
  await sleep(8000);
  ok(await isOn(), '„Nie aus, solange Besuch“: bleibt an, obwohl niemand da ist');
  await besuch(false);
  ok(await until(async () => !(await isOn()), 8000), 'Besuch vorbei und niemand da → aus');
  // never on
  const R4 = { ...base, id: 'r4', name: 'Nicht bei Besuch', kind: 'never_on', when: [{ subject: 'input_boolean.besuch', verb: 'is_on' }] };
  await pl({ rules: [R1, R4] });
  await besuch(true);
  await enter();
  await sleep(2000);
  ok(!(await isOn()), '„Nie an, solange Besuch“: bleibt aus');
  await set('light.kuechenlicht', 'on', { brightness: 200 });
  ok(await until(async () => await isOn(), 2000) && (await sleep(1200), await isOn()), 'schon an: bleibt an (nie an heißt nicht aus)');
  await besuch(false);
  await leave();
  await until(async () => !(await isOn()), 12000);
  // Sperren: while a rule holds, another light may not go on, except …; never-on tied to a light rule
  await besuch(false);
  await leave();
  await set('light.flurlicht', 'off');
  await until(async () => !(await isOn()), 12000);
  const RK = { ...base, id: 'rk', name: 'Küche an', trigger: [{ subject: `room:${kue.id}`, verb: 'is_occupied' }], lights: ['light.kuechenlicht'] };
  const RF = { ...base, id: 'rf', name: 'Flur mit an', trigger: [{ subject: `room:${kue.id}`, verb: 'is_occupied' }], lights: ['light.flurlicht'] };
  const RB = { ...base, id: 'rb', name: 'Besuch', kind: 'while', when: [{ subject: 'input_boolean.besuch', verb: 'is_on' }], lights: ['light.kuechenlicht'], action: { mode: 'on', brightness: 30, color: 'warm' }, block_lights: ['light.flurlicht'], except: [{ subject: 'binary_sensor.fp2_kochfeld', verb: 'is_occupied' }] };
  await set('binary_sensor.fp2_kochfeld', 'off');
  await pl({ rules: [RK, RF, RB], empty: { mode: 'off', delay: 0.05, dim: 10, dim_for: 5 } });
  await besuch(true);
  await enter();
  ok(await until(async () => Math.abs((await pct()) - 30) <= 2), 'Solange Besuch: Küche 30 %');
  await sleep(1500);
  ok((await st('light.flurlicht')).state === 'off', 'Sperre: Flurlicht geht nicht an, obwohl eine Regel es will');
  await set('binary_sensor.fp2_kochfeld', 'on');
  ok(await until(async () => (await st('light.flurlicht')).state === 'on'), 'Ausnahme (Kochfeld belegt): Sperre aufgehoben → Flurlicht an');
  await set('binary_sensor.fp2_kochfeld', 'off');
  await set('light.flurlicht', 'off');
  const RN = { ...base, id: 'rn', name: 'Flur nie bei Besuch', kind: 'never_on', when: [], linked: ['rb2'], lights: ['light.flurlicht'] };
  const RB2 = { ...RB, id: 'rb2', block_lights: [], except: [] };
  await pl({ rules: [RK, RF, RB2, RN] });
  await sleep(1500);
  ok((await st('light.flurlicht')).state === 'off', '„Nie an“ gekoppelt an „Besuch“: Flurlicht bleibt aus');
  await besuch(false);
  await leave();
  await until(async () => !(await isOn()), 12000);
  await set('light.flurlicht', 'off');

  // colour: an own white
  await pl({ rules: [{ ...RK, action: { mode: 'on', brightness: 60, color: 'k:3300' } }] });
  await leave();
  await until(async () => !(await isOn()), 12000);
  await enter();
  ok(await until(async () => (await st('light.kuechenlicht')).attributes.color_temp_kelvin === 3300), 'eigener Weißton 3300 K', (await st('light.kuechenlicht')).attributes);
  // a block holds on every path: an HA automation is put back, an allowed house rule may
  await set('light.flurlicht', 'off');
  const hr = await save({ name: 'Klingel: Flurlicht', when: [{ subject: 'input_button.klingel', verb: 'pressed' }], then: [{ subject: 'light.flurlicht', verb: 'turn_on' }], options: { manual_pause: '' } });
  const RN2 = { ...base, id: 'rn2', name: 'Flur gesperrt', kind: 'never_on', when: [{ subject: 'input_boolean.besuch', verb: 'is_on' }], lights: ['light.flurlicht'], allow: [`rule:${hr.id}`] };
  await pl({ rules: [RK, RN2] });
  await besuch(true);
  await sleep(1200);
  await api('POST', '/api/events/hr_test_flur_on', {});
  ok(await until(async () => (await st('light.flurlicht')).state === 'on', 3000) || true, '(HA-Automation schaltet Flurlicht ein)');
  ok(await until(async () => (await st('light.flurlicht')).state === 'off', 4000), 'gesperrt: HA-Automation → sofort wieder aus');
  await api('POST', '/api/services/input_button/press', { entity_id: 'input_button.klingel' });
  await sleep(2500);
  ok((await st('light.flurlicht')).state === 'on', 'als Ausnahme erlaubte Hausregel darf einschalten');
  await besuch(false);
  await ws.call({ type: 'house_rules/rule/delete', rule_id: hr.id });
  await set('light.flurlicht', 'off');
  await leave();
  await until(async () => !(await isOn()), 12000);

  // while ended: first the "nobody there any more" time and dimming, then "afterwards"
  await set('binary_sensor.fp2_essbereich', 'off');
  const R5 = { ...base, id: 'r5', name: 'Essbereich', kind: 'while', when: [{ subject: 'binary_sensor.fp2_essbereich', verb: 'is_occupied' }], after: 'off', action: { mode: 'on', brightness: 80, color: 'neutral' } };
  await pl({ rules: [R5], empty: { mode: 'dim', delay: 0.1, dim: 20, dim_for: 0.1 } });
  await set('binary_sensor.fp2_essbereich', 'on');
  ok(await until(async () => Math.abs((await pct()) - 80) <= 2), 'Solange Essbereich belegt → 80 %');
  await set('binary_sensor.fp2_essbereich', 'off');
  await sleep(2500);
  ok(Math.abs((await pct()) - 80) <= 2, 'vorbei: wartet erst (6 Sek. Nachlauf)', await pct());
  ok(await until(async () => Math.abs((await pct()) - 20) <= 2, 10000), 'dann gedimmt auf 20 %', await pct());
  ok(await until(async () => !(await isOn()), 12000), 'dann „danach: aus“');
  await pl({ rules: [{ ...R5, follow_empty: false }] });
  await set('binary_sensor.fp2_essbereich', 'on');
  ok(await until(async () => await isOn()), 'wieder an');
  await set('binary_sensor.fp2_essbereich', 'off');
  ok(await until(async () => !(await isOn()), 2500), 'Haken aus: sofort aus');
  // own cool-down: 3 s wait, then 40 % for 3 s, then afterwards (off)
  await pl({ rules: [{ ...R5, follow_empty: false, own_end: { delay: 0.05, dim: 40, dim_for: 0.05 } }] });
  await set('binary_sensor.fp2_essbereich', 'on');
  ok(await until(async () => Math.abs((await pct()) - 80) <= 2), 'eigene Abklingzeit: an mit 80 %');
  await set('binary_sensor.fp2_essbereich', 'off');
  await sleep(1200);
  ok(Math.abs((await pct()) - 80) <= 2, 'eigene Abklingzeit: wartet erst', await pct());
  ok(await until(async () => Math.abs((await pct()) - 40) <= 2, 8000), 'eigene Abklingzeit: dann 40 %', await pct());
  ok(await until(async () => !(await isOn()), 10000), 'eigene Abklingzeit: dann aus', [await pct(), (await ws.call({ type: 'house_rules/snapshot' })).plans.now[kue.id].light, (await ws.call({ type: 'house_rules/history', limit: 5 })).map((h) => h.what + ' | ' + h.why)]);
  // own colour
  await pl({ rules: [{ ...R5, follow_empty: false, own_end: { delay: 0, dim: 0, dim_for: 0 }, action: { mode: 'on', brightness: 70, color: '#ff0000' } }] });
  await set('binary_sensor.fp2_essbereich', 'on');
  ok(await until(async () => JSON.stringify((await st('light.kuechenlicht')).attributes.rgb_color) === '[255,0,0]'), 'eigene Farbe #ff0000 kommt an', (await st('light.kuechenlicht')).attributes);
  await set('binary_sensor.fp2_essbereich', 'off');
  await until(async () => !(await isOn()), 4000);
  await pl({ on: false, rules: [] });

  await set('binary_sensor.fenster_bad', 'off');
  await set('climate.heizung_bad', 'heat', { temperature: 19 });
  v = await ws.call({ type: 'house_rules/plan/set', kind: 'heat', room: bad.id, plan: { ...snap.plans.heat[bad.id], on: true, away_eco: false, windows: [{ from: '00:00', to: '23:59', days: 'all', temp: 22.5 }], ...(snap.plans.heat[bad.id].window && typeof snap.plans.heat[bad.id].window === 'object' ? { window: { ...snap.plans.heat[bad.id].window, drop: false } } : {}) } });
  ok(v.now[bad.id].heat.temp === 22.5, 'Heizplan: jetzt 22,5 °C', v.now[bad.id]);
  ok(await until(async () => (await st('climate.heizung_bad')).attributes.temperature === 22.5), 'gleich angewendet: 22,5 °C', (await ws.call({ type: 'house_rules/history', limit: 6 })).map((h) => h.what + ' | ' + h.why));
  await ws.call({ type: 'house_rules/mode/set', mode: 'vacation' });
  ok(await until(async () => (await st('climate.heizung_bad')).attributes.temperature === 12), 'Urlaub → 12 °C');
  await ws.call({ type: 'house_rules/mode/set', mode: 'home' });
  ok(await until(async () => (await st('climate.heizung_bad')).attributes.temperature === 22.5), 'zurück → 22,5 °C');
  const hab = await ws.call({ type: 'house_rules/plan/habits', room: kue.id });
  ok(Array.isArray(hab.windows) && typeof hab.note === 'string', 'Gewohnheiten: Antwort mit Hinweis', hab);
  await ws.call({ type: 'house_rules/plan/set', kind: 'heat', room: bad.id, plan: { ...v.heat[bad.id], on: false } });
});

await test('Räume: Anwesenheit, Leer-nach, Licht-Regeln des Raums (früher Raumverhalten)', async () => {
  const flur = snap.rooms.find((r) => r.name === 'Flur');
  await ws.call({ type: 'house_rules/room/save', room: { id: flur.id, empty_after: 0.05, dark_below: 80, dark: { bright_for: 0 } } }); // bright again at once (no 10 min hysteresis)
  await set('binary_sensor.praesenz_flur', 'off');
  await set('sensor.lux_flur', '10');
  await until(async () => (await st('binary_sensor.flur_belegt')).state === 'off', 8000); // left over from an earlier run
  // what the room behaviours "Licht an beim Reinkommen" / "Licht aus, wenn leer" became (behaviours.migrate)
  const ron = (await ws.call({ type: 'house_rules/rule/save', rule: { name: 'Test: Licht an beim Reinkommen', type: 'when', when: [{ subject: `room:${flur.id}`, verb: 'entered' }], and: [{ subject: `room:${flur.id}`, verb: 'is_dark' }], then: [{ subject: `all:light@${flur.id}`, verb: 'turn_on', night_dim: false }], only: [], enabled: true, options: { manual_pause: 'room_empty' } } })).rule;
  const roff = (await ws.call({ type: 'house_rules/rule/save', rule: { name: 'Test: Licht aus, wenn leer', type: 'when', when: [{ subject: `room:${flur.id}`, verb: 'empty' }], and: [], then: [{ subject: `all:light@${flur.id}`, verb: 'turn_off' }], only: [], enabled: true, options: { manual_pause: '' } } })).rule;
  await sleep(500);
  await set('binary_sensor.praesenz_flur', 'on');
  ok(await until(async () => (await st('binary_sensor.flur_belegt')).state === 'on'), 'binary_sensor.flur_belegt an');
  ok(await until(async () => (await st('light.flurlicht')).state === 'on'), 'Flur betreten + dunkel (10 lx) → Licht an', (await ws.call({ type: 'house_rules/history', limit: 6 })).map((h) => h.what + ' | ' + h.why));
  await set('binary_sensor.praesenz_flur', 'off');
  await sleep(1200);
  ok((await st('binary_sensor.flur_belegt')).state === 'on', 'kurz danach noch belegt (Leer nach 3 Sek.)');
  ok(await until(async () => (await st('binary_sensor.flur_belegt')).state === 'off', 6000), 'nach 3 Sek. leer');
  ok(await until(async () => (await st('light.flurlicht')).state === 'off'), 'leer → Licht aus');
  await set('sensor.lux_flur', '500');
  await set('binary_sensor.praesenz_flur', 'on');
  await sleep(1000);
  ok((await st('light.flurlicht')).state === 'off', 'hell (500 lx) → Licht bleibt aus');
  const s1 = await ws.call({ type: 'house_rules/snapshot' });
  ok((s1.today[flur.id] ?? []).length >= 1, 'Belegung von heute aufgezeichnet', s1.today[flur.id]);
  await set('sensor.lux_flur', '10');
  for (const r of [ron, roff]) await ws.call({ type: 'house_rules/rule/delete', rule_id: r.id });
  await ws.call({ type: 'house_rules/room/save', room: { id: flur.id, empty_after: 5 } });
});

await test('Tür-Logik im Bad', async () => {
  const bad = snap.rooms.find((r) => r.name === 'Bad');
  await ws.call({ type: 'house_rules/room/save', room: { id: bad.id, empty_after: 0.05 } });
  await sleep(300);
  await set('binary_sensor.badtuer', 'on');
  await sleep(200);
  await set('binary_sensor.badtuer', 'off');
  ok(await until(async () => (await st('binary_sensor.bad_belegt')).state === 'on'), 'Tür auf und zu → Bad belegt');
  await sleep(4000);
  ok((await st('binary_sensor.bad_belegt')).state === 'on', 'bleibt belegt, solange die Tür zu ist');
  await set('binary_sensor.badtuer', 'on');
  ok(await until(async () => (await st('binary_sensor.bad_belegt')).state === 'off', 6000), 'Tür auf → nach 3 Sek. leer');
  await ws.call({ type: 'house_rules/room/save', room: { id: bad.id, empty_after: 5 } });
});

await test('Raum betreten als Auslöser, Zone, Rückfrage', async () => {
  const kueche = snap.rooms.find((r) => r.name === 'Küche');
  await save({
    name: 'Kochen',
    type: 'when',
    when: [{ subject: 'zone:binary_sensor.fp2_kochfeld', verb: 'occupied' }],
    then: [
      { subject: 'notify:alex_test', verb: 'ask', message: 'Küchenlicht an?' },
      { subject: `all:light@${kueche.id}`, verb: 'turn_on' },
    ],
  });
  await set('binary_sensor.fp2_kochfeld', 'on');
  const q = await until(async () => (await calls()).find((x) => x.data?.data?.actions));
  ok(q?.data?.data?.actions?.[0]?.title === 'Ja', 'Frage mit Ja/Nein ans Handy', q);
  await sleep(500);
  ok((await st('light.kuechenlicht')).state === 'off', 'wartet auf die Antwort');
  await api('POST', '/api/events/mobile_app_notification_action', { action: q.data.data.actions[0].action });
  ok(await until(async () => (await st('light.kuechenlicht')).state === 'on'), '„Ja“ → Küchenlicht an');
});

await test('Hausmodus und Verknüpfung', async () => {
  const a = await save({ name: 'Bett erkannt', type: 'when', when: [{ subject: 'binary_sensor.fp2_essbereich', verb: 'occupied' }], then: [{ subject: 'mode', verb: 'set', mode: 'sleep' }] });
  await save({ name: 'Gute Nacht', type: 'when', when: [{ subject: 'mode', verb: 'changes_to', mode: 'sleep' }], then: [{ subject: 'all:light', verb: 'turn_off' }] });
  await set('light.sofalicht', 'on');
  await set('binary_sensor.fp2_essbereich', 'on');
  ok(await until(async () => (await ws.call({ type: 'house_rules/snapshot' })).mode === 'sleep'), 'Regel setzt Hausmodus „Schlafen“');
  ok(await until(async () => (await st('light.sofalicht')).state === 'off'), 'Folge-Regel „Gute Nacht“ schaltet alle Lichter aus');
  ok((await st('select.hausmodus')).state === 'Schlafen', 'select.hausmodus = Schlafen');
  const h = await ws.call({ type: 'house_rules/history', limit: 6 });
  ok(h.some((e) => /Hausmodus wechselte auf Schlafen/.test(e.why)), 'Verlauf erklärt die Kette', h.slice(0, 3));
  await set('binary_sensor.fp2_essbereich', 'off');
  await ws.call({ type: 'house_rules/mode/set', mode: 'home' });
  void a;
});

await test('Pause, Aus, Abklingzeit', async () => {
  const r = await save({ name: 'Kocher', type: 'when', when: [{ subject: 'binary_sensor.haustuer', verb: 'opens' }], then: [{ subject: 'switch.wasserkocher', verb: 'toggle' }], options: { cooldown: '1h' } });
  await set('binary_sensor.haustuer', 'on');
  ok(await until(async () => (await st('switch.wasserkocher')).state === 'on'), 'läuft beim ersten Mal');
  await set('binary_sensor.haustuer', 'off');
  await set('binary_sensor.haustuer', 'on');
  await sleep(700);
  ok((await st('switch.wasserkocher')).state === 'on', 'Abklingzeit: zweites Mal nicht');
  await save({ ...r, options: { cooldown: '' } });
  await ws.call({ type: 'house_rules/rule/pause', rule_id: r.id, minutes: 10 });
  await set('binary_sensor.haustuer', 'off');
  await set('binary_sensor.haustuer', 'on');
  await sleep(700);
  ok((await st('switch.wasserkocher')).state === 'on', 'pausiert: läuft nicht');
  const h = await ws.call({ type: 'house_rules/history', limit: 3 });
  ok(h[0]?.kind === 'skipped' && /pausiert/.test(h[0].why), 'Verlauf: nicht ausgeführt, weil pausiert', h[0]);
  await ws.call({ type: 'house_rules/rule/pause', rule_id: r.id, until: null });
  await ws.call({ type: 'house_rules/rule/enable', rule_id: r.id, enabled: false });
  await set('binary_sensor.haustuer', 'off');
  await set('binary_sensor.haustuer', 'on');
  await sleep(700);
  ok((await st('switch.wasserkocher')).state === 'on', 'ausgeschaltet: läuft nicht');
});

await test('„länger als“ und Platzhalter „alle“', async () => {
  await save({ name: 'Wasserkocher aus', type: 'when', when: [{ subject: 'switch.wasserkocher', verb: 'on_for', for: '2s' }], then: [{ subject: 'switch.wasserkocher', verb: 'turn_off' }] });
  await set('switch.wasserkocher', 'on');
  await sleep(1000);
  ok((await st('switch.wasserkocher')).state === 'on', 'nach 1 Sek. noch an');
  ok(await until(async () => (await st('switch.wasserkocher')).state === 'off', 5000), 'länger als 2 Sek. an → aus');
});

await test('Text → Regel (einfacher Parser)', async () => {
  const d = await ws.call({ type: 'house_rules/from_text', text: 'Wenn die Haustür aufgeht, mach das Flurlicht an' });
  ok(d.rule.when[0]?.subject === 'binary_sensor.haustuer' && d.rule.when[0]?.verb === 'opens', 'Auslöser: Haustür geht auf', d);
  ok(d.rule.then[0]?.subject === 'light.flurlicht' && d.rule.then[0]?.verb === 'turn_on', 'Aktion: Flurlicht an', d.rule.then);
  const d2 = await ws.call({ type: 'house_rules/from_text', text: 'Solange im Bad das Fenster offen ist, Heizung aus' });
  ok(d2.rule.type === 'while' && /^any:window@/.test(d2.rule.when[0]?.subject) && /^all:climate@/.test(d2.rule.then[0]?.subject) && d2.rule.then[0].verb === 'turn_off', 'Solange-Regel aus Text', d2.rule);
  const d3 = await ws.call({ type: 'house_rules/from_text', text: 'Wenn alle weg sind, saug die Wohnung, aber nur werktags' });
  ok(d3.rule.when[0]?.subject === 'person:everyone' && d3.rule.then[0]?.subject === 'vacuum.robo' && d3.rule.only[0]?.verb === 'workdays', 'Saugen wenn alle weg, werktags', d3.rule);
  ok(typeof d.sentence === 'string' && d.sentence.startsWith('Wenn Haustürsensor'), 'Satz dazu', d.sentence);
});

await test('Gerät: was passiert damit', async () => {
  const r = await save({ name: 'Fensterwarnung', type: 'when', when: [{ subject: 'any:window', verb: 'opens' }], then: [{ subject: 'notify:everyone', verb: 'send', message: 'Fenster auf' }] });
  const f = await ws.call({ type: 'house_rules/for_entity', entity_id: 'binary_sensor.fenster_kueche' });
  ok(f.starts.includes(r.id), 'Fenster Küche startet die Regel (über „irgendein Fenster“)', f);
  const t = await ws.call({ type: 'house_rules/for_entity', entity_id: 'switch.tablet_bildschirm' });
  ok(t.automations.length === 2, 'Tablet: 2 HA-Automationen');
  const many = await ws.call({ type: 'house_rules/for_entities', entity_ids: ['binary_sensor.fenster_kueche', 'switch.tablet_bildschirm', 'binary_sensor.fenster_kueche', 'light.gibt_es_nicht'] });
  ok(Object.keys(many).length === 3, 'for_entities: ein Eintrag je Gerät (doppelte zusammengefasst)', Object.keys(many));
  ok(many['binary_sensor.fenster_kueche'].starts.includes(r.id) && many['switch.tablet_bildschirm'].automations.length === 2 && !many['light.gibt_es_nicht'].starts.length, 'for_entities: dieselben Zahlen wie for_entity', many);
  const snap = await ws.call({ type: 'house_rules/snapshot' });
  const sr = snap.rules.find((x) => x.id === r.id);
  ok(typeof sr.sentence === 'string' && /Fenster/.test(sr.sentence), 'Snapshot: Satz an der Regel', sr.sentence);
});

await test('Ungültige Regeln', async () => {
  let err = '';
  await ws.call({ type: 'house_rules/rule/save', rule: { name: 'x', when: [], then: [] } }).catch((e) => (err = e.message));
  ok(/Auslöser/.test(err), 'ohne Auslöser abgelehnt', err);
  const r = await save({ id: 'b_hack', name: 'x'.repeat(500), when: [{ subject: 'binary_sensor.haustuer', verb: 'opens', evil: { a: 1 } }], then: [{ subject: 'light.flurlicht', verb: 'turn_on' }] });
  ok(!r.id.startsWith('b_') && r.name.length <= 120 && !('evil' in r.when[0]), 'bereinigt: keine b_-ID, Name gekürzt, fremde Felder weg', r);
});

await test('Gruppen', async () => {
  const g = (await ws.call({ type: 'house_rules/group/save', group: { name: 'Heizung', icon: 'heating', members: ['climate.heizung_kueche', 'climate.heizung_bad'], match: 'any' } })).group;
  ok(g.id.startsWith('g_'), 'Gruppe „Heizung“ angelegt');
  const r = await save({ name: 'Haustür: Heizung aus', when: [{ subject: 'binary_sensor.haustuer', verb: 'opens' }], and: [{ subject: `group:${g.id}`, verb: 'is_heating' }], then: [{ subject: `group:${g.id}`, verb: 'turn_off' }] });
  const desc = await ws.call({ type: 'house_rules/rule/describe', rule: r });
  ok(/Heizung/.test(desc.sentence), 'Satz mit der Gruppe', desc.sentence);
  const r2 = await save({ ...r, and: [] });
  await set('binary_sensor.haustuer', 'on');
  ok(await until(async () => (await st('climate.heizung_kueche')).state === 'off' && (await st('climate.heizung_bad')).state === 'off'), 'Gruppe schaltet beide Heizungen aus');
  const f = await ws.call({ type: 'house_rules/for_entity', entity_id: 'climate.heizung_bad' });
  ok(f.switches.includes(r2.id), 'Gerät weiß, dass es über die Gruppe geschaltet wird', f);
  await ws.call({ type: 'house_rules/group/delete', group_id: g.id });
});

await test('Orte (Zonen)', async () => {
  const zones = await ws.call({ type: 'zone/list' });
  if (!zones.some((z) => z.name === 'Arbeit')) await ws.call({ type: 'zone/create', name: 'Arbeit', latitude: 52.6, longitude: 13.5, radius: 300, icon: 'mdi:briefcase' });
  await sleep(500);
  const s1 = await ws.call({ type: 'house_rules/snapshot' });
  const arbeit = s1.zones.find((z) => z.name === 'Arbeit');
  ok(arbeit && s1.zones[0].id === 'home', 'Orte: Zuhause zuerst, Arbeit dabei', s1.zones);
  await save({ name: 'Feierabend', when: [{ subject: 'person:alex_test', verb: 'leaves_zone', zone: arbeit.id }], then: [{ subject: 'notify:alex_test', verb: 'send', message: 'Feierabend!' }] });
  await save({ name: 'Angekommen', when: [{ subject: 'person:alex_test', verb: 'enters_zone', zone: arbeit.id }], then: [{ subject: 'light.badlicht', verb: 'turn_on' }] });
  await api('POST', '/api/services/device_tracker/see', { dev_id: 'alex_handy', gps: [52.6, 13.5], gps_accuracy: 10 });
  ok(await until(async () => (await st('person.alex_test')).state === 'Arbeit'), 'Alex ist bei der Arbeit');
  ok(await until(async () => (await st('light.badlicht')).state === 'on'), '„bei Arbeit ankommt“ → Badlicht an');
  await api('POST', '/api/services/device_tracker/see', { dev_id: 'alex_handy', gps: [52.7, 13.7], gps_accuracy: 10 });
  const c = await until(async () => (await calls()).find((x) => x.data?.message === 'Feierabend!'));
  ok(c, '„Arbeit verlässt“ → Nachricht „Feierabend!“');
  const t = await ws.call({ type: 'house_rules/rule/test', rule: { type: 'when', when: [{ subject: 'time', verb: 'at', time: '07:00' }], and: [{ subject: 'person:alex_test', verb: 'in_zone', zone: arbeit.id }], then: [{ subject: 'light.badlicht', verb: 'turn_off' }] } });
  ok(t.checks.find((x) => x.section === 'and')?.ok === false, '„ist bei Arbeit“ stimmt jetzt nicht', t.checks);
  await api('POST', '/api/services/device_tracker/see', { dev_id: 'alex_handy', location_name: 'home' });
});

await test('Alarmanlage', async () => {
  const mode = (sensors, entry, exit, extra = {}) => ({ sensors, entry_delay: entry, exit_delay: exit, loud: true, lights: { mode: 'on', entities: ['light.badlicht'] }, activate: [], smart: { inside: { on: false, seconds: 90 }, arrival: { on: false, minutes: 10 } }, auto: { arm_on: [], disarm_on: [], arm_at: '', disarm_at: '', only_auto: true }, ...extra });
  const cfg = {
    enabled: true,
    confirm: 'none',
    modes: {
      away: mode(['binary_sensor.haustuer', 'binary_sensor.fenster_kueche'], 2, 1),
      night: mode(['binary_sensor.fenster_kueche'], 2, 0),
      home: mode(['binary_sensor.haustuer'], 2, 0),
    },
    notify: { persons: 'everyone', critical: true, pre_alarm: true, armed: false },
    sirens: ['switch.sirene'],
    buttons: ['disarm', 'silence', 'lights'],
    duration: 60,
    code: null,
  };
  let v = await ws.call({ type: 'house_rules/alarm/config', config: cfg });
  ok(v.config.enabled && v.state === 'disarmed' && v.config.version === 2, 'eingerichtet (Format 2), unscharf');
  ok((await st('alarm_control_panel.alarmanlage')).state === 'disarmed', 'alarm_control_panel.alarmanlage = disarmed');
  ok((await st('switch.alarmanlage_aktiv')).state === 'on' && (await st('sensor.alarmanlage_zustand')).state === 'disarmed', 'switch.alarmanlage_aktiv + sensor.alarmanlage_zustand');
  const snd = await fetch('http://127.0.0.1:8124/house_rules_sounds/sirene.mp3');
  ok(snd.status === 200 && (await snd.arrayBuffer()).byteLength > 100000, 'Alarmton wird ausgeliefert');
  await set('binary_sensor.fenster_kueche', 'on');
  let r = await ws.call({ type: 'house_rules/alarm/arm', mode: 'away' });
  ok(!r.ok && r.error === 'open' && r.open[0]?.entity_id === 'binary_sensor.fenster_kueche', 'Fenster offen → Rückfrage statt scharf', r);
  r = await ws.call({ type: 'house_rules/alarm/arm', mode: 'away', force: true });
  ok(r.ok && r.bypassed.includes('binary_sensor.fenster_kueche'), 'trotzdem scharf: Fenster ausgenommen');
  ok((await st('alarm_control_panel.alarmanlage')).state === 'arming', 'erst „arming“ (Zeit zum Gehen)');
  ok(await until(async () => (await st('alarm_control_panel.alarmanlage')).state === 'armed_away', 4000), 'dann scharf (abwesend)');
  ok((await st('binary_sensor.alarmanlage_scharf')).state === 'on', 'binary_sensor.alarmanlage_scharf an');
  await set('binary_sensor.fenster_kueche', 'off');
  await set('binary_sensor.fenster_kueche', 'on');
  await sleep(500);
  ok((await st('alarm_control_panel.alarmanlage')).state === 'armed_away', 'ausgenommenes Fenster löst nicht aus');
  await calls(true);
  await set('binary_sensor.haustuer', 'on');
  ok(await until(async () => (await st('alarm_control_panel.alarmanlage')).state === 'pending', 3000), 'Haustür → Voralarm');
  ok((await st('binary_sensor.alarmanlage_voralarm')).state === 'on', 'binary_sensor.alarmanlage_voralarm an');
  const pre = await until(async () => (await calls()).find((x) => /Alarm in 2 Sekunden/.test(x.data?.message ?? '')));
  ok(pre?.data?.data?.actions?.[0]?.action === 'HR_ALARM_DISARM' && pre.data.data.url === '/hausregeln/alarm', 'Voralarm-Nachricht mit „Alarm aus“, öffnet die Alarm-Zentrale', pre);
  ok(await until(async () => (await st('alarm_control_panel.alarmanlage')).state === 'triggered', 5000), 'nach 2 Sek. ALARM');
  ok(await until(async () => (await st('switch.sirene')).state === 'on'), 'Sirene an');
  ok(await until(async () => (await st('light.badlicht')).state === 'on'), 'gezieltes Licht (Badlicht) an');
  ok((await st('light.kuechenlicht')).state === 'off', 'andere Lichter bleiben aus');
  const msg = await until(async () => (await calls()).find((x) => x.data?.title === 'Alarm!'));
  ok(msg?.data?.data?.push?.['interruption-level'] === 'critical' && msg.data.data.actions.length === 3, 'kritische Nachricht mit 3 Knöpfen', msg);
  await api('POST', '/api/events/mobile_app_notification_action', { action: 'HR_ALARM_SILENCE' });
  ok(await until(async () => (await st('switch.sirene')).state === 'off'), 'Knopf „Sirene stumm“ → Sirene aus');
  ok((await st('alarm_control_panel.alarmanlage')).state === 'triggered', 'Anlage bleibt im Alarm');
  await calls(true);
  await api('POST', '/api/events/mobile_app_notification_action', { action: 'HR_ALARM_DISARM' });
  const how = await until(async () => (await calls()).find((x) => x.data?.title === 'Alarm aus – wie?'));
  ok(
    how?.data?.data?.actions?.map((a) => a.action).join() === 'HR_ALARM_STOP,HR_ALARM_DISARM_ALL' && how.data.data.actions.every((a) => a.authenticationRequired) && how.data.data.tag === 'house_rules_alarm',
    'Knopf „Alarm aus“ → zweite Nachricht: „Nur diesen Alarm aus“ oder „Ganz unscharf schalten“',
    how,
  );
  ok((await st('alarm_control_panel.alarmanlage')).state === 'triggered', 'bis zur Wahl bleibt der Alarm');
  await api('POST', '/api/events/mobile_app_notification_action', { action: 'HR_ALARM_STOP' });
  ok(await until(async () => (await st('alarm_control_panel.alarmanlage')).state === 'armed_away'), '„Nur diesen Alarm aus“ → Alarm vorbei, Anlage bleibt scharf (abwesend)');
  await sleep(800);
  ok((await st('alarm_control_panel.alarmanlage')).state === 'armed_away' && (await st('switch.sirene')).state === 'off', 'offene Haustür löst nicht gleich wieder aus, Sirene aus');
  ok((await ws.call({ type: 'house_rules/history', limit: 4 })).some((h) => /Alarm beendet, Alarmanlage bleibt scharf/.test(h.what) && /Haustür/.test(h.why)), 'Verlauf: Alarm beendet, bleibt scharf, wer ausgelöst hatte');
  await set('binary_sensor.haustuer', 'off');
  await set('binary_sensor.haustuer', 'on');
  ok(await until(async () => (await st('alarm_control_panel.alarmanlage')).state === 'pending', 3000), 'Haustür wieder auf → wieder Voralarm (die Anlage ist ja scharf)');
  await api('POST', '/api/events/mobile_app_notification_action', { action: 'HR_ALARM_STOP' });
  ok(await until(async () => (await st('alarm_control_panel.alarmanlage')).state === 'armed_away'), 'auch der Voralarm lässt sich so beenden');
  await sleep(2500);
  ok((await st('alarm_control_panel.alarmanlage')).state === 'armed_away', 'danach kein Alarm (Countdown gestoppt)');
  await api('POST', '/api/events/mobile_app_notification_action', { action: 'HR_ALARM_DISARM_ALL' });
  ok(await until(async () => (await st('alarm_control_panel.alarmanlage')).state === 'disarmed'), '„Ganz unscharf schalten“ → unscharf');
  await set('binary_sensor.haustuer', 'off');
  await set('binary_sensor.fenster_kueche', 'off');
  await set('light.badlicht', 'off');

  // PIN
  await ws.call({ type: 'house_rules/alarm/config', config: { code: '1234', confirm: 'pin' } });
  await ws.call({ type: 'house_rules/alarm/arm', mode: 'night' });
  ok((await st('alarm_control_panel.alarmanlage')).state === 'armed_night', 'Nacht: sofort scharf');
  let d = await ws.call({ type: 'house_rules/alarm/disarm', code: '0000' });
  ok(!d.ok && (await st('alarm_control_panel.alarmanlage')).state === 'armed_night', 'falsche PIN → bleibt scharf');
  await save({ name: 'Bei Alarm Flurlicht', when: [{ subject: 'alarm', verb: 'triggered' }], then: [{ subject: 'light.flurlicht', verb: 'turn_on' }] });
  await set('binary_sensor.fenster_kueche', 'on');
  ok(await until(async () => (await st('alarm_control_panel.alarmanlage')).state === 'triggered', 3000), 'Fenster nachts → sofort Alarm');
  ok(await until(async () => (await st('light.flurlicht')).state === 'on'), 'Regel „Wenn Alarmanlage Alarm auslöst“ → Flurlicht an');
  d = await ws.call({ type: 'house_rules/alarm/disarm', code: '1234' });
  ok(d.ok && (await st('alarm_control_panel.alarmanlage')).state === 'disarmed', 'richtige PIN → unscharf');
  ok((await st('switch.sirene')).state === 'off', 'Sirene beim Ausschalten aus');
  await set('binary_sensor.fenster_kueche', 'off');

  // smart: opened from inside (presence in the hall shortly before) and someone just came home
  await ws.call({ type: 'house_rules/alarm/config', config: { code: null, confirm: 'none', modes: { home: { smart: { inside: { on: true, seconds: 60 }, arrival: { on: false, minutes: 10 } } } } } });
  await ws.call({ type: 'house_rules/alarm/arm', mode: 'home' });
  await set('binary_sensor.praesenz_flur', 'on');
  await sleep(300);
  await set('binary_sensor.haustuer', 'on');
  await sleep(800);
  ok((await st('alarm_control_panel.alarmanlage')).state === 'armed_home', 'von innen geöffnet (Flur belegt) → kein Alarm');
  let h = await ws.call({ type: 'house_rules/history', limit: 5 });
  ok(h.some((e) => /Intelligente Ausnahme/.test(e.why)), 'Verlauf erklärt die Ausnahme', h[0]);
  await set('binary_sensor.haustuer', 'off');
  await set('binary_sensor.praesenz_flur', 'off');
  await ws.call({ type: 'house_rules/alarm/config', config: { modes: { home: { smart: { inside: { on: false }, arrival: { on: true, minutes: 5 } } } } } });
  await api('POST', '/api/services/device_tracker/see', { dev_id: 'alex_handy', location_name: 'not_home' });
  await sleep(300);
  await api('POST', '/api/services/device_tracker/see', { dev_id: 'alex_handy', location_name: 'home' });
  await sleep(300);
  await set('binary_sensor.haustuer', 'on');
  await sleep(800);
  ok((await st('alarm_control_panel.alarmanlage')).state === 'armed_home', 'gerade heimgekommen → kein Alarm');
  await set('binary_sensor.haustuer', 'off');
  await ws.call({ type: 'house_rules/alarm/disarm' });

  // chosen persons: armed when they are all away, off when one comes home
  const people = (await ws.call({ type: 'house_rules/snapshot' })).persons;
  const alex = people.find((p) => p.entity_id === 'person.alex_test');
  let v2 = await ws.call({ type: 'house_rules/alarm/config', config: { presence: { persons: [alex.id, 'gibt_es_nicht'] }, modes: { away: { exit_delay: 1, auto: { arm_away: true, away_for: 0, disarm_home: true, only_auto: true } } } } });
  ok(JSON.stringify(v2.config.presence.persons) === JSON.stringify([alex.id]), 'Anwesenheit: nur gewählte, vorhandene Personen', v2.config.presence);
  await api('POST', '/api/services/device_tracker/see', { dev_id: 'alex_handy', location_name: 'not_home' });
  ok(await until(async () => ['arming', 'armed_away'].includes((await st('alarm_control_panel.alarmanlage')).state), 4000), 'gewählte Personen alle weg → automatisch scharf', people.map((p) => [p.name, p.home]));
  await api('POST', '/api/services/device_tracker/see', { dev_id: 'alex_handy', location_name: 'home' });
  ok(await until(async () => (await st('alarm_control_panel.alarmanlage')).state === 'disarmed', 4000), 'eine heimgekommen → automatisch aus');
  h = await ws.call({ type: 'house_rules/history', limit: 6 });
  ok(h.some((e) => /heimgekommen/.test(e.why) || /heimgekommen/.test(e.what)), 'Verlauf nennt das Heimkommen', h.map((e) => e.what + ' | ' + e.why));
  await ws.call({ type: 'house_rules/alarm/config', config: { presence: { persons: 'everyone' }, modes: { away: { auto: { arm_away: false, disarm_home: false } } } } });

  // silent alarm with an extra device
  await ws.call({ type: 'house_rules/alarm/config', config: { modes: { night: { loud: false, activate: ['switch.tablet_bildschirm'], smart: { inside: { on: false }, arrival: { on: false } } } } } });
  await ws.call({ type: 'house_rules/alarm/arm', mode: 'night' });
  await calls(true);
  await set('binary_sensor.fenster_kueche', 'on');
  ok(await until(async () => (await st('alarm_control_panel.alarmanlage')).state === 'triggered', 3000), 'stiller Alarm ausgelöst');
  ok(await until(async () => (await calls()).find((x) => x.data?.title === 'Stiller Alarm')), 'Nachricht „Stiller Alarm“');
  ok(await until(async () => (await st('switch.tablet_bildschirm')).state === 'on'), 'zusätzliches Gerät eingeschaltet');
  await sleep(500);
  ok((await st('switch.sirene')).state === 'off', 'still: keine Sirene');
  await ws.call({ type: 'house_rules/alarm/disarm' });
  ok(await until(async () => (await st('switch.tablet_bildschirm')).state === 'off'), 'beim Ausschalten wieder aus');
  await set('binary_sensor.fenster_kueche', 'off');

  // automatic with the house mode
  await ws.call({ type: 'house_rules/alarm/config', config: { modes: { night: { loud: true, activate: [], auto: { arm_on: ['sleep'], disarm_on: ['home'], only_auto: true } } } } });
  await ws.call({ type: 'house_rules/mode/set', mode: 'sleep' });
  ok(await until(async () => (await st('alarm_control_panel.alarmanlage')).state === 'armed_night'), 'Hausmodus „Schlafen“ → automatisch scharf (Nacht)');
  await ws.call({ type: 'house_rules/mode/set', mode: 'home' });
  ok(await until(async () => (await st('alarm_control_panel.alarmanlage')).state === 'disarmed'), 'zurück auf „Zuhause“ → automatisch unscharf');
  h = await ws.call({ type: 'house_rules/history', limit: 40 });
  ok(h.filter((e) => e.kind === 'alarm').length >= 8, 'Alarm-Verlauf', h.filter((e) => e.kind === 'alarm').map((e) => e.what));
  await ws.call({ type: 'house_rules/alarm/config', config: { enabled: false, modes: { night: { auto: { arm_on: [], disarm_on: [] } } } } });
  ok((await st('switch.alarmanlage_aktiv')).state === 'off', 'Hauptschalter aus');
  await set('switch.sirene', 'off');
});

await test('Alarm: Empfänger, nur Nachricht, wiederholen, weitere Wege', async () => {
  const snap = await ws.call({ type: 'house_rules/snapshot' });
  const alex = snap.persons.find((p) => p.entity_id === 'person.alex_test');
  await set('switch.tablet_bildschirm', 'off');
  await set('switch.sirene', 'off');
  await set('binary_sensor.fenster_kueche', 'off');
  const v = await ws.call({
    type: 'house_rules/alarm/config',
    config: {
      enabled: true,
      code: null,
      notify: { persons: 'everyone', armed: true, armed_persons: [alex.id], test_persons: [alex.id], repeat: { on: true, every: 20, max: 2, channels: true } },
      channels: { services: { on: true, list: ['sms_test', 'gibt_es_nicht'], events: ['triggered', 'test'] } },
      modes: { night: { sensors: ['binary_sensor.fenster_kueche'], reaction: 'notify', activate: ['switch.tablet_bildschirm'], smart: { inside: { on: false }, arrival: { on: false } }, auto: { arm_on: [], disarm_on: [] } } },
    },
  });
  ok(v.config.modes.night.reaction === 'notify' && JSON.stringify(v.config.channels.services.list) === '["sms_test"]', 'Nur Nachricht und Dienst gespeichert (unbekannter Dienst verworfen)', v.config.channels);
  ok(v.notify_services.includes('sms_test') && !v.notify_services.some((n) => n.startsWith('mobile_app_')), 'weitere Dienste werden angeboten', v.notify_services);
  ok(!('password' in v.config.channels.email), 'kein Passwort im Frontend');
  await calls(true);
  await ws.call({ type: 'house_rules/alarm/arm', mode: 'night' });
  const armedMsg = await until(async () => (await calls()).filter((c) => /scharf/.test(c.data?.message ?? '')), 4000);
  ok(armedMsg && armedMsg.length && armedMsg.every((c) => c.service === 'notify.mobile_app_iphone_von_alex'), 'Scharf-Nachricht nur an die gewählte Person', armedMsg);
  await calls(true);
  await set('binary_sensor.fenster_kueche', 'on');
  ok(await until(async () => (await st('alarm_control_panel.alarmanlage')).state === 'triggered', 3000), 'Alarm (nur Nachricht) ausgelöst');
  ok(await until(async () => (await calls()).find((c) => c.service === 'notify.sms_test'), 4000), 'weiterer Dienst bekommt den Alarm');
  const all = await calls();
  ok(all.some((c) => c.service === 'notify.mobile_app_iphone_von_sam') && all.some((c) => c.service === 'notify.mobile_app_iphone_von_alex'), 'Alarm an alle');
  await sleep(800);
  ok((await st('switch.tablet_bildschirm')).state === 'off' && (await st('switch.sirene')).state === 'off', 'Nur Nachricht: keine Geräte, keine Sirene');
  ok(await until(async () => (await calls()).find((c) => /Erinnerung 1/.test(c.data?.message ?? '') && c.service === 'notify.sms_test'), 30000, 1000), 'Erinnerung nach 20 s (auch über weitere Wege)', [(await st('alarm_control_panel.alarmanlage')).state, (await ws.call({ type: 'house_rules/history', limit: 6 })).map((h) => h.what + ' | ' + h.why), (await calls()).map((c) => c.service + ': ' + (c.data?.message ?? '')).slice(-6)]);
  await ws.call({ type: 'house_rules/alarm/disarm' });
  await set('binary_sensor.fenster_kueche', 'off');
  await calls(true);
  await sleep(22000);
  ok(!(await calls()).some((c) => /Erinnerung/.test(c.data?.message ?? '')), 'nach dem Ausschalten keine Erinnerung mehr');
  const t = await ws.call({ type: 'house_rules/alarm/channel_test', channel: 'services' });
  ok(t.ok && (await calls()).some((c) => c.service === 'notify.sms_test' && /Test/.test(c.data?.message ?? '')), 'Testknopf: weiterer Dienst', t);
  const tm = await ws.call({ type: 'house_rules/alarm/channel_test', channel: 'email' });
  ok(!tm.ok && /Mailserver/.test(tm.errors.join(' ')), 'Mail ohne Server: verständlicher Fehler', tm);
  await calls(true);
  await ws.call({ type: 'house_rules/alarm/test' });
  const tc = await until(async () => (await calls()).filter((c) => c.service.startsWith('notify.mobile_app_')), 4000);
  ok(tc && tc.length && tc.every((c) => c.service === 'notify.mobile_app_iphone_von_alex'), 'Probealarm nur an die gewählte Person', tc);
  await ws.call({
    type: 'house_rules/alarm/config',
    config: { enabled: false, notify: { armed: false, armed_persons: 'same', test_persons: 'same', repeat: { on: false } }, channels: { services: { on: false } }, modes: { night: { reaction: 'loud', activate: [] } } },
  });
});

await test('Alarm „Nur Licht“: blinkt, kein Ton', async () => {
  const md = (extra) => ({ sensors: ['binary_sensor.fenster_kueche'], entry_delay: 0, exit_delay: 0, reaction: 'silent', loud: false, lights: { mode: 'on', entities: ['light.badlicht'] }, activate: [], smart: { inside: { on: false, seconds: 90 }, arrival: { on: false, minutes: 10 } }, auto: { arm_on: [], disarm_on: [], arm_at: '', disarm_at: '', only_auto: true }, ...extra });
  await ws.call({ type: 'house_rules/alarm/config', config: { enabled: true, confirm: 'none', modes: { away: md({}), night: md({ sensors: [] }), home: md({ sensors: [] }) }, notify: { persons: 'everyone', critical: false, pre_alarm: false, armed: false, repeat: { on: false } }, sirens: ['switch.sirene'], code: null } });
  await set('binary_sensor.fenster_kueche', 'off');
  await set('light.badlicht', 'off');
  await ws.call({ type: 'house_rules/alarm/arm', mode: 'away', force: true });
  let changes = 0;
  let last = 'off';
  await set('binary_sensor.fenster_kueche', 'on');
  const t = Date.now();
  while (Date.now() - t < 7000) {
    const now = (await st('light.badlicht')).state;
    if (now !== last) {
      changes++;
      last = now;
    }
    await sleep(300);
  }
  ok((await st('alarm_control_panel.alarmanlage')).state === 'triggered', 'Alarm ausgelöst');
  ok(changes >= 4, `Licht blinkt (${changes} Wechsel)`);
  ok((await st('switch.sirene')).state === 'off', 'keine Sirene');
  await ws.call({ type: 'house_rules/alarm/disarm' });
  await ws.call({ type: 'house_rules/alarm/config', config: { enabled: false } });
  await set('binary_sensor.fenster_kueche', 'off');
  await sleep(6000);
  await set('light.badlicht', 'off');
});

await test('Hausmodus als Schalter', async () => {
  await ws.call({ type: 'house_rules/mode_auto/set', mode: '_enabled', config: { enabled: false } });
  await ws.call({ type: 'house_rules/mode/set', mode: 'home' });
  ok(await until(async () => (await st('switch.hausmodus_schlafen'))?.state === 'off'), 'switch.hausmodus_schlafen aus (Zuhause)');
  await api('POST', '/api/services/switch/turn_on', { entity_id: 'switch.hausmodus_schlafen' });
  ok(await until(async () => (await ws.call({ type: 'house_rules/snapshot' })).mode === 'sleep'), 'Schalter an → Hausmodus Schlafen');
  ok((await st('switch.hausmodus_schlafen')).state === 'on' && (await st('switch.hausmodus_weg')).state === 'off', 'Schlafen an, Weg aus');
  await ws.call({ type: 'house_rules/mode/set', mode: 'away' });
  ok(await until(async () => (await st('switch.hausmodus_weg')).state === 'on' && (await st('switch.hausmodus_schlafen')).state === 'off'), 'Hausmodus Weg → Schalter folgen');
  await api('POST', '/api/services/switch/turn_off', { entity_id: 'switch.hausmodus_weg' });
  ok(await until(async () => (await ws.call({ type: 'house_rules/snapshot' })).mode === 'home'), 'Schalter aus → Zuhause');
});

await test('Hausmodus automatisch', async () => {
  await ws.call({ type: 'house_rules/mode_auto/set', mode: '_enabled', config: { enabled: true } });
  await ws.call({ type: 'house_rules/mode_auto/set', mode: 'sleep', config: { on: true, when: [{ subject: 'binary_sensor.fp2_essbereich', verb: 'is_occupied' }, { subject: 'person:someone', verb: 'is_home' }], for: '' } });
  await set('binary_sensor.fp2_essbereich', 'on');
  ok(await until(async () => (await ws.call({ type: 'house_rules/snapshot' })).mode === 'sleep', 40000, 1000), 'Bedingungen erfüllt → Schlafen');
  ok((await st('sensor.hausmodus')).state === 'sleep', 'sensor.hausmodus = sleep');
  await ws.call({ type: 'house_rules/mode/set', mode: 'guests' });
  await sleep(1500);
  ok((await ws.call({ type: 'house_rules/snapshot' })).mode === 'guests', 'von Hand gesetzt → bleibt, solange sich nichts ändert');
  await set('binary_sensor.fp2_essbereich', 'off');
  ok(await until(async () => (await ws.call({ type: 'house_rules/snapshot' })).mode === 'home', 40000, 1000), 'Bedingung weg → wieder Zuhause');

  // own end: stays until the end conditions hold
  const mode = async () => (await ws.call({ type: 'house_rules/snapshot' })).mode;
  const besuch = (on) => api('POST', `/api/services/input_boolean/turn_${on ? 'on' : 'off'}`, { entity_id: 'input_boolean.besuch' });
  await besuch(false);
  await ws.call({ type: 'house_rules/mode_auto/set', mode: 'sleep', config: { end: { on: true, when: [{ subject: 'input_boolean.besuch', verb: 'is_on' }], for: '' } } });
  await set('binary_sensor.fp2_essbereich', 'on');
  ok(await until(async () => (await mode()) === 'sleep', 40000, 1000), 'eigenes Ende: Schlafen startet wie gehabt');
  await set('binary_sensor.fp2_essbereich', 'off');
  await sleep(2500);
  ok((await mode()) === 'sleep', 'Startbedingung weg → bleibt Schlafen (eigenes Ende noch nicht erreicht)');
  await besuch(true);
  ok(await until(async () => (await mode()) === 'home', 40000, 1000), 'Endbedingung erfüllt → Zuhause');
  // set by hand while the end already holds: only counts once it changed
  await ws.call({ type: 'house_rules/mode/set', mode: 'sleep' });
  await sleep(2500);
  ok((await mode()) === 'sleep', 'von Hand Schlafen, Ende galt schon → bleibt', (await ws.call({ type: 'house_rules/history', limit: 5 })).map((h) => h.what + ' | ' + h.why));
  await besuch(false);
  await sleep(1500);
  await besuch(true);
  ok(await until(async () => (await mode()) === 'home', 40000, 1000), 'Ende wird (wieder) wahr → auch der von Hand gesetzte Modus endet');
  await besuch(false);
  await ws.call({ type: 'house_rules/mode_auto/set', mode: 'sleep', config: { on: false, when: [], end: { on: false, when: [] } } });
});

await test('Schritte ohne Auslöser ausführen', async () => {
  const rule = { name: 'Test', when: [{ subject: 'binary_sensor.haustuer', verb: 'opens' }], then: [{ subject: 'light.flurlicht', verb: 'turn_on' }, { subject: 'light.badlicht', verb: 'turn_on' }] };
  const one = await ws.call({ type: 'house_rules/rule/run_actions', rule, index: 1 });
  ok((await st('light.badlicht')).state === 'on' && (await st('light.flurlicht')).state === 'off', 'nur Schritt 2 ausgeführt', one);
  const all = await ws.call({ type: 'house_rules/rule/run_actions', rule });
  ok((await st('light.flurlicht')).state === 'on' && all.done.length === 2, 'alle Schritte ausgeführt', all);
  const r = await save({ name: 'Pause-Test', when: [{ subject: 'binary_sensor.haustuer', verb: 'opens' }], then: [{ subject: 'light.flurlicht', verb: 'turn_on' }], options: { manual_pause: '1h' } });
  await api('POST', '/api/services/light/turn_off', { entity_id: 'light.flurlicht' }); // by hand
  await sleep(300);
  await set('binary_sensor.haustuer', 'on');
  await sleep(800);
  const h = await ws.call({ type: 'house_rules/history', limit: 4 });
  ok(h[0]?.kind === 'skipped' && /von Hand/.test(h[0].why), 'von Hand geschaltet → übersprungen, im Verlauf erklärt', h[0]);
  const snap2 = await ws.call({ type: 'house_rules/snapshot' });
  ok(!snap2.rules.find((x) => x.id === r.id)?.meta?.last_run, 'zählt nicht als gelaufen');
});

await test('KI-Anbindung (ohne echte Verbindung nach außen)', async () => {
  let err = '';
  await ws.call({ type: 'house_rules/ai/review', rule: { type: 'when', when: [{ subject: 'binary_sensor.haustuer', verb: 'opens' }], then: [] } }).catch((e) => (err = e.message));
  ok(/Keine KI/.test(err), 'Prüfen ohne KI → verständlicher Fehler', err);
  const t = await ws.call({ type: 'house_rules/ai/test', ai: { provider: 'ollama', url: 'http://127.0.0.1:1' } });
  ok(!t.ok && /Keine Verbindung|Antwort/.test(t.error), 'nicht erreichbarer Server → verständlicher Fehler', t);
  const t2 = await ws.call({ type: 'house_rules/ai/test', ai: { provider: 'gemini' } });
  ok(!t2.ok && /Schlüssel/.test(t2.error), 'ohne Schlüssel → Hinweis', t2);
  const pub = await ws.call({ type: 'house_rules/ai/set', ai: { provider: 'gemini', key: 'test-key-1234567890', model: 'gemini-x' } });
  ok(pub.has_key && pub.key_hint === '…7890' && pub.model === 'gemini-x', 'gespeichert, Schlüssel nur als …7890', pub);
  const snapText = JSON.stringify(await ws.call({ type: 'house_rules/snapshot' }));
  ok(!snapText.includes('test-key-1234567890'), 'Schlüssel taucht im Snapshot nicht auf');
  await ws.call({ type: 'house_rules/ai/set', ai: { provider: 'none' } });
  const pub2 = (await ws.call({ type: 'house_rules/snapshot' })).ai;
  ok(pub2.provider === 'none' && !pub2.has_key, '„Keins“ löscht die Anbindung samt Schlüssel', pub2);
});

const feat = (features) => ws.call({ type: 'house_rules/features/set', features });
const FEAT_START = { alarm: false, light: true, heating: true, vacation: true, mode_auto: true, vacuum: false, ai: false, window_warning: false };

await test('Funktionen: aus = wirklich aus', async () => {
  let f = (await ws.call({ type: 'house_rules/snapshot' })).features;
  ok(f && Object.keys(FEAT_START).every((k) => typeof f[k] === 'boolean'), 'alle Funktionen im Snapshot', f);
  await feat({ ...FEAT_START });
  // Licht: eine Lichtregel schaltet nur, solange "Licht" an ist
  const kue = (await ws.call({ type: 'house_rules/snapshot' })).rooms.find((x) => x.name === 'Küche');
  for (const e of ['binary_sensor.fp2_alles', 'binary_sensor.fp2_kochfeld', 'binary_sensor.fp2_essbereich']) await set(e, 'off');
  await set('light.kuechenlicht', 'off');
  await ws.call({ type: 'house_rules/room/save', room: { id: kue.id, empty_after: 0.05 } });
  await until(async () => !(await ws.call({ type: 'house_rules/snapshot' })).occupancy[kue.id]?.occupied, 10000);
  const rule = { id: 'f1', name: 'Da', kind: 'when', enabled: true, trigger: [{ subject: `room:${kue.id}`, verb: 'is_occupied' }], when: [], lights: [], variants: [], after: 'others', empty_after: 'off', action: { mode: 'on', brightness: 60, color: 'neutral' } };
  const before = (await ws.call({ type: 'house_rules/snapshot' })).plans.light[kue.id];
  await ws.call({ type: 'house_rules/plan/set', kind: 'light', room: kue.id, plan: { ...before, on: true, rules: [rule], empty: { mode: 'keep', delay: 0.05, dim: 10, dim_for: 5 } } });
  await feat({ light: false });
  await set('binary_sensor.fp2_alles', 'on');
  await sleep(2500);
  ok((await st('light.kuechenlicht')).state === 'off', 'Licht aus: Lichtregel schaltet nicht');
  await set('binary_sensor.fp2_alles', 'off');
  await until(async () => !(await ws.call({ type: 'house_rules/snapshot' })).occupancy[kue.id]?.occupied, 10000);
  await feat({ light: true });
  await set('binary_sensor.fp2_alles', 'on');
  ok(await until(async () => (await st('light.kuechenlicht')).state === 'on', 6000), 'Licht wieder an: dieselbe Regel schaltet');
  await set('binary_sensor.fp2_alles', 'off');
  await ws.call({ type: 'house_rules/plan/set', kind: 'light', room: kue.id, plan: { ...before } });
  await ws.call({ type: 'house_rules/room/save', room: { id: kue.id, empty_after: kue.empty_after } });
  // Alarmanlage
  await feat({ alarm: false });
  ok((await st('alarm_control_panel.alarmanlage')).state === 'unavailable' && (await st('binary_sensor.alarmanlage_scharf')).state === 'unavailable' && (await st('sensor.alarmanlage_zustand')).state === 'unavailable', 'Alarmanlage aus: ihre Entitäten sind nicht verfügbar');
  const arm = await ws.call({ type: 'house_rules/alarm/arm', mode: 'away', force: true });
  ok(!arm.ok && arm.error === 'not_set_up', 'Alarmanlage aus: scharf schalten geht nicht', arm);
  f = await feat({ alarm: true });
  ok(f.alarm && (await st('switch.alarmanlage_aktiv')).state === 'on', 'Alarmanlage an = Schalter „Alarmanlage aktiv“ an');
  ok(await until(async () => (await st('alarm_control_panel.alarmanlage')).state === 'disarmed', 4000), 'Alarmanlage an: verfügbar und unscharf, ohne Anlaufphase', (await st('alarm_control_panel.alarmanlage')).state);
  const al = (await ws.call({ type: 'house_rules/snapshot' })).alarm;
  ok(!al.settling && al.config.modes.away.sensors.length > 0, 'beim ersten Einschalten: Sensoren der Räume vorgeschlagen', al.config.modes.away.sensors);
  await feat({ alarm: false });
  // Hausmodus automatisch
  await feat({ mode_auto: false });
  await api('POST', '/api/services/device_tracker/see', { dev_id: 'alex_handy', location_name: 'not_home' });
  await sleep(2000);
  ok((await ws.call({ type: 'house_rules/snapshot' })).mode === 'home', 'Hausmodus automatisch aus: alle weg → bleibt „Zuhause“');
  await feat({ mode_auto: true });
  ok(await until(async () => (await ws.call({ type: 'house_rules/snapshot' })).mode === 'away', 5000), 'wieder an: wechselt auf „Weg“');
  await api('POST', '/api/services/device_tracker/see', { dev_id: 'alex_handy', location_name: 'home' });
  await until(async () => (await ws.call({ type: 'house_rules/snapshot' })).mode === 'home', 5000);
  await ws.call({ type: 'house_rules/mode/set', mode: 'home' });
  // Urlaubssimulation
  await ws.call({ type: 'house_rules/sim/set', config: { smart: true } });
  await ws.call({ type: 'house_rules/mode/set', mode: 'vacation' });
  ok((await ws.call({ type: 'house_rules/sim/view' })).enabled === true, 'Urlaubssimulation an: läuft im Urlaub');
  await feat({ vacation: false });
  ok((await ws.call({ type: 'house_rules/sim/view' })).enabled === false, 'Urlaubssimulation aus: läuft auch im Urlaub nicht');
  await feat({ vacation: true, light: false });
  ok((await ws.call({ type: 'house_rules/sim/view' })).enabled === false, 'ohne Licht keine Urlaubssimulation');
  await ws.call({ type: 'house_rules/mode/set', mode: 'home' });
  await feat({ light: true });
  // KI
  await ws.call({ type: 'house_rules/ai/set', ai: { provider: 'gemini', key: 'test-key-1234567890', model: 'gemini-x' } });
  await feat({ ai: false });
  let err = '';
  await ws.call({ type: 'house_rules/ai/review', rule: { type: 'when', when: [{ subject: 'binary_sensor.haustuer', verb: 'opens' }], then: [] } }).catch((e) => (err = e.message));
  ok(/ausgeschaltet/.test(err) && (await ws.call({ type: 'house_rules/snapshot' })).settings.ai_connected === false, 'KI aus: keine Anfrage, verständlicher Hinweis, Anbindung bleibt gespeichert', err);
  ok((await ws.call({ type: 'house_rules/snapshot' })).ai.has_key, 'Schlüssel bleibt gespeichert');
  await ws.call({ type: 'house_rules/ai/set', ai: { provider: 'none' } });
  // Saugroboter-Pause = cleaning.on
  f = await feat({ vacuum: true });
  const cl = (await ws.call({ type: 'house_rules/snapshot' })).cleaning;
  ok(f.vacuum && cl.on && cl.vacuums.includes('vacuum.robo'), 'Saugroboter-Pause an: Saugroboter gleich gewählt', cl);
  await feat({ vacuum: false });
  ok(!(await ws.call({ type: 'house_rules/snapshot' })).cleaning.on, 'Saugroboter-Pause aus');
  ok(!('behaviours' in (await ws.call({ type: 'house_rules/snapshot' })).features), 'Raumverhalten ist keine Funktion mehr (aufgelöst)');
  // nicht-Admins dürfen nichts umschalten
  const t2 = await userToken(tok, 'tablet');
  const ws2 = await wsConnect(t2);
  let e2 = '';
  await ws2.call({ type: 'house_rules/features/set', features: { alarm: true } }).catch((e) => (e2 = e.message));
  ok(/unauthorized/.test(e2), 'Funktionen umschalten nur als Admin', e2);
  ws2.close();
  await feat({ ...FEAT_START });
});

await test('Einrichtung (Assistent)', async () => {
  let su = await ws.call({ type: 'house_rules/setup/save', restart: true });
  ok(su.done === false && su.step === 'welcome' && !Object.keys(su.answers).length, 'Assistent neu starten (alte Antworten weg)', su);
  su = await ws.call({ type: 'house_rules/setup/save', step: 'rooms', answers: { modes: { away: true } } });
  ok(su.step === 'rooms' && su.answers.modes.away === true && (await ws.call({ type: 'house_rules/snapshot' })).setup.step === 'rooms', 'Fortschritt wird gespeichert (weitermachen auf jedem Gerät)', su);
  const sug = await ws.call({ type: 'house_rules/setup/suggest' });
  const kue = sug.rooms.find((r) => r.name === 'Küche');
  ok(kue && kue.candidates.some((c) => c.entity_id === 'binary_sensor.fp2_alles'), 'Vorschlag: Melder je Raum aus HA-Bereich und Geräteklasse', kue?.candidates);
  ok(sug.examples.length >= 2 && sug.examples.every((e) => e.sentence && e.rule.when.length && e.rule.then.length), `${sug.examples.length} Beispielregeln aus echten Geräten`, sug.examples.map((e) => e.sentence));
  ok(sug.alarm.away.some((d) => d.entity_id === 'binary_sensor.haustuer') && sug.alarm.sirens.some((d) => d.entity_id === 'switch.sirene'), 'Vorschlag Alarm: Sensoren und Sirene', sug.alarm);
  ok(sug.vacuums.some((v) => v.entity_id === 'vacuum.robo') && sug.floorplan === true, 'Saugroboter gefunden, Grundriss-Karte da (Kartenteil von roomwise)');
  ok(sug.window_warning.doors.some((d) => d.entity_id === 'binary_sensor.haustuer'), 'Fenster-Warnung: Haustür vorgeschlagen', sug.window_warning.doors);
  // a car's door ("Front left door" on a device with odometer and range) is never the house's front door, nor a door / window at all
  const wwv = await ws.call({ type: 'house_rules/window_warning/get' });
  const inv = (await ws.call({ type: 'house_rules/snapshot' })).devices ?? [];
  const invIds = (Array.isArray(inv) ? inv : Object.values(inv)).map((d) => d.entity_id);
  ok(!wwv.suggested_doors.includes('binary_sensor.demo_auto_tuer_vorne_links') && !sug.window_warning.doors.some((d) => d.entity_id.startsWith('binary_sensor.demo_auto')), 'Autotür nie als Haustür vorgeschlagen', wwv.suggested_doors);
  ok(!invIds.some((e) => e.startsWith('binary_sensor.demo_auto')) && !(wwv.window_candidates ?? []).includes('binary_sensor.demo_auto_fenster'), 'Türen und Fenster des Autos gehören nicht zum Haus', invIds.filter((e) => e.includes('demo_auto')));
  ok(Array.isArray(wwv.window_entities) && Array.isArray(wwv.window_candidates), 'Fenster-Warnung nennt beobachtete und mögliche Fenster', wwv.window_candidates);
  const ex = await save(sug.examples[0].rule);
  ok(ex.meta.origin === 'suggestion', 'Beispielregel mit einem Tipp übernommen');
  // rooms: confirm the kitchen sensors
  const r = await ws.call({ type: 'house_rules/setup/apply', step: 'rooms', data: { rooms: [{ id: kue.id, presence: ['binary_sensor.fp2_alles'], motion: [] }] } });
  ok(r.ok && (await ws.call({ type: 'house_rules/snapshot' })).rooms.find((x) => x.id === kue.id).presence.join() === 'binary_sensor.fp2_alles', 'Räume übernommen');
  // light: a first rule in the kitchen
  const before = (await ws.call({ type: 'house_rules/snapshot' })).plans.light[kue.id];
  await ws.call({ type: 'house_rules/plan/set', kind: 'light', room: kue.id, plan: { ...before, on: false, rules: [] } });
  const l = await ws.call({ type: 'house_rules/setup/apply', step: 'light', data: { rooms: [kue.id] } });
  const pl = (await ws.call({ type: 'house_rules/snapshot' })).plans.light[kue.id];
  ok(l.rooms.includes(kue.id) && pl.on && pl.rules.length === 1 && pl.rules[0].kind === 'while', 'Licht: erste Lichtregel je Raum', pl.rules);
  const v = await ws.call({ type: 'house_rules/setup/apply', step: 'vacation', data: {} });
  ok(v.rooms.includes(kue.id) && (await ws.call({ type: 'house_rules/snapshot' })).plans.light[kue.id].vacation.on, 'Urlaub: bewohnt wirken in Räumen mit Lichtregeln');
  await ws.call({ type: 'house_rules/plan/set', kind: 'light', room: kue.id, plan: before });
  await ws.call({ type: 'house_rules/setup/apply', step: 'modes', data: { away: true, sleep: true, vacation: false } });
  const ma = (await ws.call({ type: 'house_rules/snapshot' })).mode_auto;
  ok(ma.modes.sleep.on && ma.modes.away.on && !ma.modes.vacation.on, 'Hausmodus-Grundlagen übernommen', ma.modes);
  await ws.call({ type: 'house_rules/mode_auto/set', mode: 'sleep', config: { on: false } });
  let bad = '';
  await ws.call({ type: 'house_rules/setup/apply', step: 'nope', data: {} }).catch((e) => (bad = e.message));
  ok(bad, 'unbekannter Schritt → Fehler');
  su = await ws.call({ type: 'house_rules/setup/save', done: true });
  ok(su.done && su.step === 'done', 'Assistent abgeschlossen');
});

await test('Fenster-Warnung beim Gehen', async () => {
  const ww = (config) => ws.call({ type: 'house_rules/window_warning/set', config });
  const get = () => ws.call({ type: 'house_rules/window_warning/get' });
  await feat({ window_warning: false });
  ok((await st('binary_sensor.fenster_warnung')).state === 'unavailable', 'aus: Entität nicht verfügbar');
  await set('binary_sensor.fenster_kueche', 'on');
  await set('binary_sensor.haustuer', 'on');
  await sleep(800);
  ok(!(await get()).active, 'aus: Haustür auf mit offenem Fenster → keine Warnung');
  await set('binary_sensor.haustuer', 'off');
  await feat({ window_warning: true });
  await ww({ doors: ['binary_sensor.haustuer'], windows: 'all', only_last: false, delay: 0, timeout: 2, lights: { mode: 'red', entities: ['light.flurlicht'] }, ack_entity: '', announce: { mode: 'all', players: ['media_player.homepod'], tts: 'tts.fake' }, notify: { on: true, persons: ['alex_test'] } });
  await set('light.flurlicht', 'off');
  await calls(true);
  await set('binary_sensor.haustuer', 'on');
  let v = await until(async () => { const x = await get(); return x.active && x; }, 3000);
  ok(v && v.phase === 'alarm' && v.windows.includes('binary_sensor.fenster_kueche') && v.deadline, 'Haustür auf + Fenster offen → Warnung mit offenen Fenstern und Countdown', v);
  ok((await st('binary_sensor.fenster_warnung')).state === 'on', 'binary_sensor.fenster_warnung an');
  ok(await until(async () => (await st('light.flurlicht')).state === 'on', 2000), 'Licht blinkt');
  const said = await until(async () => (await ws.call({ type: 'house_rules/history', limit: 8 })).find((h) => h.what === 'Fenster-Warnung: Durchsage'), 5000);
  ok(said && /Noch offen: .*Küche/.test(said.why) && /HomePod|homepod/i.test(said.why), 'nach dem Countdown: Durchsage „Noch offen: …“ (steht im Verlauf)', said);
  ok(await until(async () => (await calls()).some((c) => c.service === 'notify.mobile_app_iphone_von_alex' && /offen/.test(c.data.message)), 3000), 'und Nachricht an die gewählte Person');
  ok(await until(async () => (await st('light.flurlicht')).state === 'off', 6000), 'Licht danach wieder wie vorher (aus)');
  ok((await get()).spoken, 'angesagt');
  await set('binary_sensor.fenster_kueche', 'off');
  ok(await until(async () => !(await get()).active, 2000), 'alle Fenster zu → Warnung endet');
  await set('binary_sensor.haustuer', 'off');
  // acknowledge
  await ww({ timeout: 30, lights: { mode: 'none', entities: [] } });
  await set('binary_sensor.fenster_kueche', 'on');
  await set('binary_sensor.haustuer', 'on');
  await until(async () => (await get()).active, 3000);
  const t2 = await userToken(tok, 'tablet');
  const wsT = await wsConnect(t2);
  const a = await wsT.call({ type: 'house_rules/window_warning/ack' });
  ok(a.ok && (await get()).phase === 'linger', 'Bestätigen (auch ohne Admin, z. B. am Tablet) → Fenster bleiben kurz markiert');
  ok(await until(async () => !(await get()).active, 8000), 'dann vorbei');
  wsT.close();
  await set('binary_sensor.haustuer', 'off');
  // only when the last one leaves
  await ww({ only_last: true });
  await api('POST', '/api/services/device_tracker/see', { dev_id: 'alex_handy', location_name: 'home' });
  await api('POST', '/api/services/device_tracker/see', { dev_id: 'sam_handy', location_name: 'home' });
  await until(async () => (await st('person.sam_test')).state === 'home' && (await st('person.alex_test')).state === 'home', 5000);
  await set('binary_sensor.haustuer', 'on');
  await sleep(800);
  ok(!(await get()).active, 'nur beim Letzten: zwei zuhause → keine Warnung');
  await set('binary_sensor.haustuer', 'off');
  await api('POST', '/api/services/device_tracker/see', { dev_id: 'sam_handy', location_name: 'not_home' });
  await until(async () => (await st('person.sam_test')).state === 'not_home', 5000);
  await sleep(300);
  await set('binary_sensor.haustuer', 'on');
  ok(await until(async () => (await get()).active, 3000), 'nur beim Letzten: einer zuhause → Warnung');
  await ws.call({ type: 'house_rules/window_warning/ack' });
  await set('binary_sensor.haustuer', 'off');
  await set('binary_sensor.fenster_kueche', 'off');
  // import from the floor plan card (entry_alert)
  const imp = await ws.call({
    type: 'house_rules/window_warning/import',
    source: 'Wandtablet',
    entry_alert: { door: 'o_door', timeout: 45, mode: 'sequential', media_player: 'media_player.homepod', tts_entity: 'tts.fake', text_single: '{fenster} ist offen!', order: ['o_w2', 'o_w1'], flash_lights: ['light.flurlicht'], ack_entity: 'input_button.klingel', announce_users: ['u1'] },
    openings: [
      { id: 'o_door', type: 'door', entity: 'binary_sensor.haustuer' },
      { id: 'o_w1', type: 'window', entity: 'binary_sensor.fenster_kueche' },
      { id: 'o_w2', type: 'window', entity: 'binary_sensor.fenster_bad' },
    ],
  });
  const c = imp.config;
  ok(c.doors.join() === 'binary_sensor.haustuer' && c.windows.join() === 'binary_sensor.fenster_bad,binary_sensor.fenster_kueche' && c.timeout === 45 && c.announce.mode === 'sequential' && c.announce.texts.single === '{fenster} ist offen!' && c.lights.entities.includes('light.flurlicht') && c.ack_entity === 'input_button.klingel' && c.users.join() === 'u1' && c.imported?.from === 'Wandtablet', 'Einstellungen der Grundriss-Karte übernommen (Tür/Fenster aus den Öffnungen des Plans)', c);
  await feat({ window_warning: false });
});

await test('Alarm: Gerät für Face ID nur als Admin oder mit PIN', async () => {
  const t2 = await userToken(tok, 'tablet');
  const wsT = await wsConnect(t2);
  const reg = (w, code) => w.call({ type: 'house_rules/alarm/register_device', payload: { id: 'x', clientDataJSON: 'e30', attestationObject: '' }, name: 'Test', rp_id: 'localhost', ...(code ? { code } : {}) }).then(() => 'ok', (e) => e.message);
  await ws.call({ type: 'house_rules/alarm/config', config: { code: null } });
  ok(/unauthorized/.test(await reg(wsT)), 'ohne Admin und ohne PIN: abgelehnt');
  await ws.call({ type: 'house_rules/alarm/config', config: { code: '4711' } });
  ok(/unauthorized/.test(await reg(wsT, '1234')), 'falsche PIN: abgelehnt');
  const right = await reg(wsT, '4711');
  ok(!/unauthorized/.test(right), 'richtige PIN: darf einrichten (scheitert hier erst an der Test-Anmeldung)', right);
  const adm = await reg(ws);
  ok(!/unauthorized/.test(adm), 'Admin: darf einrichten', adm);
  ok(!(await ws.call({ type: 'house_rules/snapshot' })).alarm.config.devices.length, 'kein Gerät gespeichert');
  await ws.call({ type: 'house_rules/alarm/config', config: { code: null } });
  wsT.close();
});

await test('Alarm: Sicherheit (PIN, Sperre, Hauptschalter, Nachricht)', async () => {
  const cfg = (c) => ws.call({ type: 'house_rules/alarm/config', config: c });
  const am = { sensors: ['binary_sensor.haustuer'], entry_delay: 30, exit_delay: 0, reaction: 'notify', smart: { inside: { on: false }, arrival: { on: false } }, auto: { arm_away: false, disarm_home: false } };
  await cfg({ enabled: true, confirm: 'none', code: null, modes: { away: am }, notify: { persons: 'everyone', critical: false, pre_alarm: false, armed: false, repeat: { on: false } }, sirens: [] });
  let e = '';
  await cfg({ confirm: 'pin' }).catch((x) => (e = x.message));
  ok(/PIN festlegen/.test(e), '„PIN“ ohne PIN lässt sich nicht einstellen', e);
  e = '';
  await cfg({ confirm: 'device' }).catch((x) => (e = x.message));
  ok(/PIN festlegen/.test(e), '„Face ID“ ohne PIN als Ausweg auch nicht', e);
  const v = await cfg({ code: '2468', confirm: 'pin' });
  ok(v.config.confirm === 'pin' && v.config.has_code && !JSON.stringify(v).includes('2468'), 'PIN und „PIN“ zusammen gesetzt, PIN nie im Frontend');
  e = '';
  await cfg({ code: null }).catch((x) => (e = x.message));
  ok(/PIN festlegen/.test(e) && (await ws.call({ type: 'house_rules/snapshot' })).alarm.config.has_code, 'PIN entfernen, solange „PIN“ gilt → abgelehnt');
  // main switch: no disarming around the PIN
  await set('binary_sensor.haustuer', 'off');
  await ws.call({ type: 'house_rules/alarm/arm', mode: 'away', force: true });
  ok(await until(async () => (await st('alarm_control_panel.alarmanlage')).state === 'armed_away', 4000), 'scharf');
  const sw = await api('POST', '/api/services/switch/turn_off', { entity_id: 'switch.alarmanlage_aktiv' });
  ok(sw.status >= 400 && (await st('alarm_control_panel.alarmanlage')).state === 'armed_away' && (await st('switch.alarmanlage_aktiv')).state === 'on', '„Alarmanlage aktiv“ aus, solange scharf → abgelehnt, bleibt scharf', sw.status);
  // HA alarm panel: same PIN
  const bad = await api('POST', '/api/services/alarm_control_panel/alarm_disarm', { entity_id: 'alarm_control_panel.alarmanlage', code: '1111' });
  ok(bad.status >= 400 && (await st('alarm_control_panel.alarmanlage')).state === 'armed_away', 'HA-Alarmzentrale: falsche PIN → bleibt scharf', bad.status);
  // lockout after 5 wrong PINs (per user)
  let d;
  for (let i = 0; i < 3; i++) d = await ws.call({ type: 'house_rules/alarm/disarm', code: '0000' });
  ok(d.error === 'wrong_code' && !d.retry_in, '4× falsch (1× an der HA-Zentrale + 3× in der App, derselbe Nutzer): noch keine Sperre', d);
  d = await ws.call({ type: 'house_rules/alarm/disarm', code: '0000' });
  ok(d.error === 'wrong_code' && d.retry_in >= 25, '5× falsch → gesperrt (30 s)', d);
  d = await ws.call({ type: 'house_rules/alarm/disarm', code: '2468' });
  ok(!d.ok && d.error === 'locked' && (await st('alarm_control_panel.alarmanlage')).state === 'armed_away', 'gesperrt: auch die richtige PIN wirkt nicht', d);
  const t2 = await userToken(tok, 'tablet');
  const wsT = await wsConnect(t2);
  d = await wsT.call({ type: 'house_rules/alarm/disarm', code: '0000' });
  ok(d.error === 'wrong_code', 'Sperre gilt je Nutzer (Tablet noch nicht gesperrt)', d);
  wsT.close();
  await sleep(31000);
  d = await ws.call({ type: 'house_rules/alarm/disarm', code: '2468' });
  ok(d.ok && (await st('alarm_control_panel.alarmanlage')).state === 'disarmed', 'nach der Sperre: richtige PIN → unscharf', d);
  // the button in the phone message: only when allowed
  await cfg({ notify_disarm: false });
  await ws.call({ type: 'house_rules/alarm/arm', mode: 'away', force: true });
  await until(async () => (await st('alarm_control_panel.alarmanlage')).state === 'armed_away', 4000);
  await ws.call({ type: 'fire_event', event_type: 'mobile_app_notification_action', event_data: { action: 'HR_ALARM_DISARM' } });
  await sleep(800);
  ok((await st('alarm_control_panel.alarmanlage')).state === 'armed_away', '„Alarm aus“ aus der Nachricht nicht erlaubt → bleibt scharf');
  ok((await ws.call({ type: 'house_rules/history', limit: 4 })).some((h) => /aus der Nachricht abgelehnt/.test(h.what)), 'Verlauf sagt warum');
  await ws.call({ type: 'fire_event', event_type: 'mobile_app_notification_action', event_data: { action: 'HR_ALARM_DISARM_ALL' } });
  await sleep(800);
  ok((await st('alarm_control_panel.alarmanlage')).state === 'armed_away', 'auch „Ganz unscharf schalten“ nicht erlaubt → bleibt scharf');
  await cfg({ notify_disarm: true });
  await calls(true);
  await ws.call({ type: 'fire_event', event_type: 'mobile_app_notification_action', event_data: { action: 'HR_ALARM_DISARM' } });
  const how = await until(async () => (await calls()).find((x) => x.data?.title === 'Alarm aus – wie?'));
  ok(/schon vorbei/.test(how?.data?.message ?? '') && (await st('alarm_control_panel.alarmanlage')).state === 'armed_away', '„Alarm aus“ ohne laufenden Alarm → fragt trotzdem, bleibt scharf', how);
  await ws.call({ type: 'fire_event', event_type: 'mobile_app_notification_action', event_data: { action: 'HR_ALARM_DISARM_ALL' } });
  ok(await until(async () => (await st('alarm_control_panel.alarmanlage')).state === 'disarmed', 3000), 'erlaubt (Standard) → aus, das Handy hat vorher entsperrt');
  // reset the lockout: admin action (not for other users) and the file for the command line
  for (let i = 0; i < 5; i++) d = await ws.call({ type: 'house_rules/alarm/disarm', code: '0000' });
  ok(d.retry_in >= 25 && (await ws.call({ type: 'house_rules/snapshot' })).alarm.config.pin_locked === 1, 'wieder gesperrt, das Panel zeigt „1 Nutzer gesperrt“', d);
  const stored = JSON.parse(execSync('docker exec hr-test-ha cat /config/.storage/house_rules').toString());
  ok(Object.values(stored.data.runtime?.alarm_pin ?? {}).some((v) => v[0] >= 5), 'die Sperre ist gespeichert (übersteht einen Neustart)');
  const tU = await userToken(tok, 'tablet');
  const res = await fetch('http://127.0.0.1:8124/api/services/roomwise/reset_alarm_pin', { method: 'POST', headers: { authorization: `Bearer ${tU}`, 'content-type': 'application/json' }, body: '{}' });
  d = await ws.call({ type: 'house_rules/alarm/disarm', code: '2468' });
  ok(res.status === 401 && d.error === 'locked', 'Aktion „Alarm-PIN zurücksetzen“ ohne Admin → abgelehnt', res.status);
  await api('POST', '/api/services/roomwise/reset_alarm_pin', {});
  d = await ws.call({ type: 'house_rules/alarm/disarm', code: '2468' });
  ok(d.ok && (await ws.call({ type: 'house_rules/snapshot' })).alarm.config.pin_locked === 0, 'Admin-Aktion hebt die Sperre auf, richtige PIN geht sofort', d);
  for (let i = 0; i < 5; i++) d = await ws.call({ type: 'house_rules/alarm/disarm', code: '0000' });
  execSync("docker exec hr-test-ha sh -c 'touch /config/house_rules_pin_reset'");
  d = await ws.call({ type: 'house_rules/alarm/disarm', code: '2468' });
  ok(d.ok, 'Kommandozeile: touch /config/house_rules_pin_reset → Sperre weg, richtige PIN geht', d);
  ok(execSync('docker exec hr-test-ha sh -c "ls /config/house_rules_pin_reset 2>/dev/null || true"').toString().trim() === '', 'die Datei wird danach gelöscht');
  ok((await ws.call({ type: 'house_rules/snapshot' })).alarm.config.has_code, 'leere Datei: PIN bleibt');
  const sw2 = await api('POST', '/api/services/switch/turn_off', { entity_id: 'switch.alarmanlage_aktiv' });
  ok(sw2.status < 400 && (await st('switch.alarmanlage_aktiv')).state === 'off', 'unscharf: Hauptschalter aus geht');
  await cfg({ code: null, confirm: 'none', enabled: false });
});

if (process.argv.includes('--no-restart')) {
  await restoreFeatures(ws);
  console.log(`\n${failures() ? `${failures()} FEHLER` : 'alles ok'}`);
  ws.close();
  process.exit(failures() ? 1 : 0);
}
if (!only || 'Neustart'.includes(only)) {
  console.log('\n# Neustart: Solange-Regel stellt danach zurück');
  // the heating part would own the thermostats (heating plans from test-heating.mjs): off for this test, also across the restart
  await ws.call({ type: 'house_rules/features/set', features: { heating: false } });
  await save({ name: 'Heizung aus bei offenem Fenster', type: 'while', when: [{ subject: 'any:window', verb: 'is_open' }], then: [{ subject: 'all:climate@same', verb: 'turn_off' }] });
  await set('climate.heizung_kueche', 'heat', { temperature: 23 });
  await set('binary_sensor.fenster_kueche', 'on');
  ok(await until(async () => (await st('climate.heizung_kueche')).state === 'off'), 'Heizung Küche aus');
  // the alarm across the restart: armed (away), door closed, motion sensor quiet
  const am = (sensors) => ({ sensors, entry_delay: 2, exit_delay: 0, loud: false, reaction: 'notify', lights: { mode: 'off', entities: [] }, activate: [], smart: { inside: { on: false, seconds: 90 }, arrival: { on: false, minutes: 10 } }, auto: { arm_on: [], disarm_on: [], arm_at: '', disarm_at: '', only_auto: true } });
  await ws.call({ type: 'house_rules/alarm/config', config: { enabled: true, confirm: 'none', modes: { away: am(['binary_sensor.haustuer', 'binary_sensor.bewegung_wohnzimmer']), night: am([]), home: am([]) }, notify: { persons: 'everyone', critical: false, pre_alarm: false, armed: false, repeat: { on: false } }, sirens: [], code: null } });
  await set('binary_sensor.haustuer', 'off');
  await set('binary_sensor.bewegung_wohnzimmer', 'off');
  const ar = await ws.call({ type: 'house_rules/alarm/arm', mode: 'away', force: true });
  ok(ar.ok && (await st('alarm_control_panel.alarmanlage')).state === 'armed_away', 'Alarm vor dem Neustart scharf');
  // the PIN lockout across the restart
  await ws.call({ type: 'house_rules/alarm/config', config: { code: '2468', confirm: 'pin' } });
  let pd;
  for (let i = 0; i < 5; i++) pd = await ws.call({ type: 'house_rules/alarm/disarm', code: '0000' });
  ok(pd.retry_in >= 25, 'vor dem Neustart: 5× falsche PIN → gesperrt', pd);
  // a "while" rule with "sonst" steps that ran, then switched off: after the restart it must put back nothing
  await api('POST', '/api/services/input_boolean/turn_off', { entity_id: 'input_boolean.licht_a' });
  const offRule = await save({ name: 'Aus mit sonst', type: 'while', when: [{ subject: 'input_boolean.licht_a', verb: 'is_on' }], then: [{ subject: 'input_boolean.licht_b', verb: 'turn_off' }], else: [{ subject: 'input_boolean.licht_b', verb: 'turn_on' }] });
  await api('POST', '/api/services/input_boolean/turn_on', { entity_id: 'input_boolean.licht_a' });
  await sleep(1500);
  await api('POST', '/api/services/input_boolean/turn_off', { entity_id: 'input_boolean.licht_a' });
  ok(await until(async () => (await st('input_boolean.licht_b')).state === 'on', 8000), 'Regel mit sonst: sonst lief (B an)');
  await save({ ...offRule, enabled: false });
  await api('POST', '/api/services/input_boolean/turn_off', { entity_id: 'input_boolean.licht_b' });
  await sleep(6000); // store is saved delayed
  console.log('  (Test-HA wird neu gestartet …)');
  await api('POST', '/api/services/homeassistant/restart', {});
  await sleep(8000);
  await until(async () => (await fetch('http://127.0.0.1:8124/api/').catch(() => null))?.status === 401, 90000, 1000);
  const ws2 = await wsConnect(tok);
  await until(async () => (await ws2.call({ type: 'house_rules/info' }).catch(() => null))?.loaded, 60000, 1000);
  await sleep(3000);
  // start-up phase of the alarm: the motion sensor "wakes up" (off → on) and the door is opened; only the door may count
  // until HA has fully started the alarm entities are "unavailable" (never a wrong "disarmed")
  await until(async () => (await st('alarm_control_panel.alarmanlage')).state !== 'unavailable', 90000, 500);
  const t0 = Date.now();
  const set2 = (entity_id, state) => ws2.call({ type: 'hr_fake/set', entity_id, state, attributes: {} });
  const al = (await ws2.call({ type: 'house_rules/snapshot' })).alarm;
  ok(al.state === 'armed_away' && al.settling, 'nach dem Neustart weiter scharf, Anlaufphase', { state: al.state, settling: al.settling });
  ok((await st('alarm_control_panel.alarmanlage')).state === 'armed_away' && (await st('binary_sensor.alarmanlage_scharf')).state === 'on', 'auch die HA-Anzeige (alarm_control_panel) zeigt nach dem Neustart „scharf“', (await st('alarm_control_panel.alarmanlage')).state);
  await set2('binary_sensor.bewegung_wohnzimmer', 'on');
  await sleep(1500);
  await set2('binary_sensor.haustuer', 'on');
  await sleep(1500);
  await set2('binary_sensor.haustuer', 'off');
  await sleep(5000);
  ok((await st('alarm_control_panel.alarmanlage')).state === 'armed_away', 'Bewegungsmelder „wacht auf“ beim Start → kein Alarm');
  // the fake devices start fresh (window closed, heating 21 °C): the rule that was on before the restart
  // waits the start-up phase, then puts back the state it stored (23 °C), not the fake's default
  ok((await st('climate.heizung_kueche')).attributes.temperature !== 23, 'Solange-Regel: direkt nach dem Start noch nicht beendet (Anlaufphase)', await st('climate.heizung_kueche'));
  const trig = await until(async () => ['pending', 'triggered'].includes((await st('alarm_control_panel.alarmanlage')).state), 90000, 1000);
  ok(trig && Date.now() - t0 > 30000, `Haustür während des Starts geöffnet → nach der Anlaufphase Voralarm (${Math.round((Date.now() - t0) / 1000)} s)`);
  const hist = await ws2.call({ type: 'house_rules/history', limit: 10 });
  ok(hist.some((h) => /Nach dem Neustart: geöffnet/.test(h.what) && /Haustür/.test(h.why)), 'Verlauf erklärt es', hist.slice(0, 3).map((h) => h.what));
  ok(await until(async () => (await st('alarm_control_panel.alarmanlage')).state === 'triggered', 5000), 'dann Alarm');
  const h = await until(async () => { const c = await st('climate.heizung_kueche'); return c.state === 'heat' && c.attributes.temperature === 23 && c; }, 150000, 1000);
  ok(h, 'nach der Anlaufphase: gilt wirklich nicht mehr → gespeicherter Zustand (23 °C) zurück', await st('climate.heizung_kueche'));
  ok((await st('input_boolean.licht_b')).state === 'off', 'ausgeschaltete Regel: nach dem Neustart keine „sonst“-Schritte (B bleibt aus)', (await ws2.call({ type: 'house_rules/history', limit: 6 })).map((x) => `${x.what} | ${x.why}`));
  for (const r of (await ws2.call({ type: 'house_rules/snapshot' })).rules) await ws2.call({ type: 'house_rules/rule/delete', rule_id: r.id });
  let pd2 = await ws2.call({ type: 'house_rules/alarm/disarm', code: '0000' });
  ok(pd2.error === 'locked' || pd2.retry_in >= 55, 'nach dem Neustart: Sperre zählt weiter (6. falsche PIN → 60 s statt neu bei 0)', pd2);
  execSync("docker exec hr-test-ha sh -c 'echo pin > /config/house_rules_pin_reset'");
  pd2 = await ws2.call({ type: 'house_rules/alarm/disarm' });
  const al2 = (await ws2.call({ type: 'house_rules/snapshot' })).alarm;
  ok(pd2.ok && !al2.config.has_code && al2.config.confirm === 'none' && al2.state === 'disarmed', 'Datei mit „pin“ → Sperre weg und PIN entfernt, Ausschalten geht', { pd2, has_code: al2.config.has_code });
  await ws2.call({ type: 'house_rules/alarm/config', config: { enabled: false } });
  ok((await ws2.call({ type: 'house_rules/snapshot' })).features.heating === false, 'Funktion „Heizung“ bleibt über den Neustart aus');
  await ws2.call({ type: 'house_rules/features/set', features: { heating: true } });
  await restoreFeatures(ws2);
  ws2.close();
  console.log(`\n${failures() ? `${failures()} FEHLER` : 'alles ok'}`);
  process.exit(failures() ? 1 : 0);
}

await restoreFeatures(ws);
console.log(`\n${failures() ? `${failures()} FEHLER` : 'alles ok'}`);
ws.close();
process.exit(failures() ? 1 : 0);
