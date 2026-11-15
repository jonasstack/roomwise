// Functional matrix of Hausregeln against the isolated test Home Assistant (port 8124): every trigger verb, every
// condition and every action of the vocabulary once, with realistic fake devices (late reports, repeated Zigbee
// reports, motion that clears by itself, devices that go unavailable, covers with travel time, a motor lock), plus
// robustness: registry changes and edits while a rule runs, two rules on one device, rapid toggling, a restart
// in the middle of a timed step.
// Usage: node tools/testha/test-functions.mjs [--only regex] [--no-restart]
// Prints one line per cell and a coverage table at the end (group: tested / passing).
import { token, wsConnect, rest, sleep, ok, failures, until } from './lib.mjs';

const tok = await token();
let ws = await wsConnect(tok);
const api = rest(tok);
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const set = (entity_id, state, attributes = {}) => ws.call({ type: 'hr_fake/set', entity_id, state, attributes });
const st = async (e) => (await api('GET', `/api/states/${e}`)).body;
const svc = (domain, service, data) => api('POST', `/api/services/${domain}/${service}`, data);
const calls = (clear = false) => ws.call({ type: 'hr_fake/calls', clear });
const snapshot = () => ws.call({ type: 'house_rules/snapshot' });
const save = async (rule) => (await ws.call({ type: 'house_rules/rule/save', rule })).rule;
const del = (id) => ws.call({ type: 'house_rules/rule/delete', rule_id: id }).catch(() => null);
const hist = async (n = 6) => (await ws.call({ type: 'house_rules/history', limit: n })).map((h) => `${h.kind}: ${h.what} | ${h.why}`);
const stateOf = async (e) => (await st(e))?.state;
const see = (dev_id, extra) => svc('device_tracker', 'see', { dev_id, ...extra });

// every rule that runs fires house_rules_fired: the probe of the trigger cells
const fired = [];
const listen = async () => ws.sub({ type: 'subscribe_events', event_type: 'house_rules_fired' }, (ev) => fired.push({ id: ev.data.rule_id, t: Date.now() }));
await listen();
const count = (id) => fired.filter((f) => f.id === id).length;
const PROBE = (name) => ({ subject: 'input_text.probe', verb: 'set_text', state: String(name).slice(0, 90) });

// ---------------------------------------------------------------- matrix bookkeeping
const cells = [];
let group = '';
const skip = (name) => only && !new RegExp(only).test(`${group} ${name}`);
const cell = (name, cond, extra) => {
  cells.push({ group, name, ok: !!cond });
  ok(cond, `[${group}] ${name}`, extra);
};
const section = (name) => {
  group = name;
  console.log(`\n# ${name}`);
};

// ---------------------------------------------------------------- setup (idempotent, like test-reliability.mjs)
const areas = await ws.call({ type: 'config/area_registry/list' });
const area = async (name) => (areas.find((a) => a.name === name) ?? (await ws.call({ type: 'config/area_registry/create', name }))).area_id;
const A = { flur: await area('Flur'), wohnzimmer: await area('Wohnzimmer'), kueche: await area('Küche'), bad: await area('Bad') };
const place = {
  flur: ['light.flurlicht', 'binary_sensor.praesenz_flur', 'sensor.lux_flur'],
  wohnzimmer: ['light.sofalicht', 'binary_sensor.bewegung_wohnzimmer', 'binary_sensor.fenster_wohnzimmer', 'media_player.homepod'],
  kueche: ['light.kuechenlicht', 'binary_sensor.fenster_kueche'],
  bad: ['light.badlicht', 'binary_sensor.fenster_bad', 'binary_sensor.badtuer', 'sensor.temp_bad'],
};
for (const [r, ents] of Object.entries(place)) for (const e of ents) await ws.call({ type: 'config/entity_registry/update', entity_id: e, area_id: A[r] }).catch((err) => console.log('area', e, err.message));
await see('alex_handy', { location_name: 'home' });
await see('sam_handy', { location_name: 'not_home' });
const persons = await ws.call({ type: 'person/list' });
for (const [name, trk] of [['Alex Test', 'device_tracker.alex_handy'], ['Sam Test', 'device_tracker.sam_handy']])
  if (!persons.storage.some((p) => p.name === name)) await ws.call({ type: 'person/create', name, device_trackers: [trk] });
const zones = await ws.call({ type: 'zone/list' });
if (!zones.some((z) => z.name === 'Testzone')) await ws.call({ type: 'zone/create', name: 'Testzone', latitude: 52.4, longitude: 13.2, radius: 300 });
if (!(await ws.call({ type: 'house_rules/info' }).catch(() => null))?.loaded) {
  const flow = await api('POST', '/api/config/config_entries/flow', { handler: 'roomwise' });
  await api('POST', `/api/config/config_entries/flow/${flow.body.flow_id}`, {});
  await until(async () => (await ws.call({ type: 'house_rules/info' }).catch(() => null))?.loaded, 30000, 500);
}
await until(async () => (await snapshot()).devices.length > 10, 90000, 1000);
await until(async () => (await snapshot()).devices.some((d) => d.entity_id === 'binary_sensor.bewegung_wohnzimmer' && d.room), 30000, 500);
let snap = await snapshot();
// only the two test persons count (other tests leave persons behind)
const excluded0 = snap.settings?.persons_excluded ?? [];
const testPersons = (await ws.call({ type: 'person/list' })).storage.filter((p) => /^(Alex|Sam) Test$/.test(p.name)).map((p) => `person.${p.name.toLowerCase().replace(' ', '_')}`);
await ws.call({ type: 'house_rules/settings/set', settings: { persons_excluded: snap.residents.map((r) => r.entity_id).filter((e) => !testPersons.includes(e)) } });
await until(async () => (await snapshot()).persons.filter((p) => /Alex|Sam/.test(p.name)).length === 2, 20000, 500);
snap = await snapshot();
const R = Object.fromEntries(['Flur', 'Wohnzimmer', 'Küche', 'Bad'].map((n) => [n, snap.rooms.find((r) => r.name === n)?.id]));
ok(R.Flur && R.Wohnzimmer && R['Küche'] && R.Bad, 'Räume da', R);
const kinds = Object.fromEntries(snap.devices.map((d) => [d.entity_id, d.kind]));
await ws.call({ type: 'house_rules/mode/set', mode: 'home' });
const features0 = snap.features;
await ws.call({ type: 'house_rules/features/set', features: { light: true, heating: true, behaviours: true } });
for (const b of ['light_on_enter', 'light_off_empty', 'night_dim', 'heat_eco_empty', 'media_pause_empty']) await ws.call({ type: 'house_rules/behaviour/set', behaviour: b, on: false });
const rooms0 = Object.fromEntries(snap.rooms.map((r) => [r.id, r.empty_after]));
for (const r of [R.Flur, R.Wohnzimmer]) await ws.call({ type: 'house_rules/room/save', room: { id: r, empty_after: 0.05 } });
const lightPlans0 = snap.plans?.light ?? {};
for (const r of Object.values(R)) await ws.call({ type: 'house_rules/plan/set', kind: 'light', room: r, plan: { ...(lightPlans0[r] ?? {}), on: false } });
// rules left from an earlier run
for (const r of snap.rules) await del(r.id);
await until(async () => !(await snapshot()).alarm.settling, 120000, 1000);
await until(async () => (await snapshot()).starting === false, 150000, 1000);

const L = 'light.kleines_licht';
const M = 'binary_sensor.bewegung_wohnzimmer';
const P = 'binary_sensor.praesenz_flur';
const W = 'binary_sensor.fenster_wohnzimmer';
const reset = async () => {
  for (const e of [M, P, W, 'binary_sensor.fenster_bad', 'binary_sensor.badtuer', 'binary_sensor.garage_erschuetterung', 'binary_sensor.wasser_kueche']) await set(e, 'off');
  for (const e of [L, 'light.sofalicht', 'light.badlicht', 'light.flurlicht']) await set(e, 'off', { latency: 0 });
  await set('switch.sirene', 'off');
};
await reset();
const occupied = async (room) => (await snapshot()).occupancy?.[room]?.occupied;

/** one trigger cell: a "when" rule with the clause, the probe as step; arm() sets the start, fire() the change */
async function trig(name, clause, { arm, fire, wait = 4000, early = 0, rule = {} }) {
  if (skip(name)) return;
  let r;
  try {
    if (arm) await arm();
    await sleep(300);
    r = await save({ name: `T ${group} ${name}`, type: 'when', when: [clause], then: [PROBE(name)], options: { manual_pause: '' }, ...rule });
    await sleep(300);
    const n0 = count(r.id);
    await fire();
    if (early) {
      await sleep(early);
      if (count(r.id) > n0) return cell(`${name} (zu früh, vor ${early} ms)`, false, await hist(4));
    }
    cell(name, await until(() => count(r.id) > n0, wait, 100), await hist(4));
  } catch (e) {
    cell(name, false, e.message);
  } finally {
    if (r) await del(r.id);
  }
}

/** one condition cell (the engine's own check, as in "Probelauf"): holds after setTrue, not after setFalse */
async function cond(name, clause, setTrue, setFalse, settle = 300) {
  if (skip(name)) return;
  try {
    const check = async () => (await ws.call({ type: 'house_rules/rule/test', rule: { name: 'c', type: 'while', when: [clause], then: [PROBE('c')] } })).checks[0];
    await setTrue();
    await sleep(settle);
    const a = await check();
    await setFalse();
    await sleep(settle);
    const b = await check();
    cell(name, a?.ok === true && b?.ok === false, { a, b, ...(clause.subject.startsWith('room:') ? { occ: (await snapshot()).occupancy?.[clause.subject.slice(5)], m: await stateOf(M) } : {}) });
  } catch (e) {
    cell(name, false, e.message);
  }
}
const condPair = async (name, yes, no) => {
  if (skip(name)) return;
  const check = async (c) => (await ws.call({ type: 'house_rules/rule/test', rule: { name: 'c', type: 'while', when: [c], then: [PROBE('c')] } })).checks[0];
  const a = await check(yes);
  const b = await check(no);
  cell(name, a?.ok === true && b?.ok === false, { a, b });
};

/** one action cell: runs the step for real (like "Schritte ausführen"), check() polls the result */
async function act(name, step, check, { pre, options = {}, wait = 5000 } = {}) {
  if (skip(name)) return;
  try {
    if (pre) await pre();
    await sleep(200);
    const res = await ws.call({ type: 'house_rules/rule/run_actions', rule: { name: `A ${name}`, when: [{ subject: 'binary_sensor.haustuer', verb: 'opens' }], then: [step], options: { manual_pause: '', ...options } } });
    cell(name, await until(check, wait, 150), res);
  } catch (e) {
    cell(name, false, e.message);
  }
}

// the "at" trigger needs the clock: set up now, checked at the end
const berlin = (d) => d.toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
const atTime = berlin(new Date(Date.now() + 90000));
const atRule = !skip('Zeit um') ? await save({ name: 'T Zeit um', type: 'when', when: [{ subject: 'time', verb: 'at', time: atTime }], then: [PROBE('Zeit um')], options: { manual_pause: '' } }) : null;
const atStart = Date.now();

// ================================================================ triggers
section('Auslöser Licht');
await trig('angeht', { subject: L, verb: 'turns_on' }, { arm: () => set(L, 'off'), fire: () => set(L, 'on') });
await trig('ausgeht', { subject: L, verb: 'turns_off' }, { arm: () => set(L, 'on'), fire: () => set(L, 'off') });
await trig('länger als 2 Sek. an', { subject: L, verb: 'on_for', for: '2s' }, { arm: () => set(L, 'off'), fire: () => set(L, 'on'), early: 1300, wait: 3500 });
await trig('länger als 2 Sek. aus', { subject: L, verb: 'off_for', for: '2s' }, { arm: () => set(L, 'on'), fire: () => set(L, 'off'), early: 1300, wait: 3500 });
await trig('heller als 50 %', { subject: L, verb: 'brighter', brightness: 50 }, { arm: () => set(L, 'on', { brightness: 50 }), fire: () => set(L, 'on', { brightness: 230 }) });
await trig('dunkler als 50 %', { subject: L, verb: 'dimmer', brightness: 50 }, { arm: () => set(L, 'on', { brightness: 230 }), fire: () => set(L, 'on', { brightness: 50 }) });
if (!skip('doppelte Meldungen')) {
  // Zigbee: the same "on" reported three more times (only the link quality changes) → once
  await set(L, 'off');
  const r = await save({ name: 'T doppelt', type: 'when', when: [{ subject: L, verb: 'turns_on' }], then: [PROBE('doppelt')], options: { manual_pause: '' } });
  await sleep(300);
  await set(L, 'on', { _dup: 3 });
  await sleep(1500);
  cell('doppelte Meldungen (Zigbee) → einmal', count(r.id) === 1, count(r.id));
  await del(r.id);
}
if (!skip('nicht erreichbar')) {
  // on, then the lamp drops off the network while the time runs out, then reports "on" again: it was on all the time
  await set(L, 'off');
  const r = await save({ name: 'T an seit', type: 'when', when: [{ subject: L, verb: 'on_for', for: '3s' }], then: [PROBE('an seit')], options: { manual_pause: '' } });
  await sleep(300);
  await set(L, 'on');
  await sleep(500);
  await set(L, 'unavailable');
  await sleep(4000);
  const during = count(r.id);
  await set(L, 'on');
  cell('„länger als“ nach kurz nicht erreichbar: läuft danach weiter', during === 0 && (await until(() => count(r.id) > 0, 5000, 100)), { during, after: count(r.id) });
  await del(r.id);
  await set(L, 'off');
}

section('Auslöser Fenster/Tür');
await trig('Fenster geht auf', { subject: W, verb: 'opens' }, { arm: () => set(W, 'off'), fire: () => set(W, 'on') });
await trig('Fenster geht zu', { subject: W, verb: 'closes' }, { arm: () => set(W, 'on'), fire: () => set(W, 'off') });
await trig('Fenster länger als 2 Sek. offen', { subject: W, verb: 'open_for', for: '2s' }, { arm: () => set(W, 'off'), fire: () => set(W, 'on'), early: 1300, wait: 3500 });
await trig('Tür geht auf', { subject: 'binary_sensor.badtuer', verb: 'opens' }, { arm: () => set('binary_sensor.badtuer', 'off'), fire: () => set('binary_sensor.badtuer', 'on') });
await set(W, 'off');

section('Auslöser Bewegung/Präsenz');
await trig('Bewegung erkannt', { subject: M, verb: 'detected' }, { arm: () => set(M, 'off'), fire: () => set(M, 'on') });
await trig('keine Bewegung seit 2 Sek. (Melder geht selbst aus)', { subject: M, verb: 'clear_for', for: '2s' }, { arm: () => set(M, 'off'), fire: () => set(M, 'on', { _clear_after: 1 }), early: 2200, wait: 3000 });
await trig('Präsenz belegt', { subject: P, verb: 'occupied' }, { arm: () => set(P, 'off'), fire: () => set(P, 'on') });
await trig('Präsenz frei seit 2 Sek.', { subject: P, verb: 'free_for', for: '2s' }, { arm: () => set(P, 'on'), fire: () => set(P, 'off'), early: 1300, wait: 3500 });
if (!skip('flackert')) {
  // mmWave: free for a moment, then someone again → the 2 s count anew
  await set(P, 'on');
  const r = await save({ name: 'T frei', type: 'when', when: [{ subject: P, verb: 'free_for', for: '2s' }], then: [PROBE('frei')], options: { manual_pause: '' } });
  await sleep(300);
  await set(P, 'off');
  await sleep(1200);
  await set(P, 'on');
  await sleep(200);
  await set(P, 'off');
  await sleep(1200);
  const early = count(r.id);
  cell('Präsenz flackert → „frei seit“ zählt neu', early === 0 && (await until(() => count(r.id) > 0, 3000, 100)), { early });
  await del(r.id);
}
await set(M, 'off');
await set(P, 'off');

section('Auslöser Raum');
await until(async () => !(await occupied(R.Wohnzimmer)), 8000, 300);
await trig('Raum betreten', { subject: `room:${R.Wohnzimmer}`, verb: 'entered' }, { fire: () => set(M, 'on') });
await trig('Raum leer', { subject: `room:${R.Wohnzimmer}`, verb: 'empty' }, { arm: async () => { await set(M, 'on'); await until(() => occupied(R.Wohnzimmer), 4000, 200); }, fire: () => set(M, 'off'), wait: 8000 });
await trig('Raum länger als 2 Sek. leer', { subject: `room:${R.Wohnzimmer}`, verb: 'empty_for', for: '2s' }, { arm: async () => { await set(M, 'on'); await until(() => occupied(R.Wohnzimmer), 4000, 200); }, fire: () => set(M, 'off'), early: 3000, wait: 8000 });

section('Auslöser Geräte');
const C = 'climate.heizung_buero';
await trig('Heizung beginnt zu heizen', { subject: C, verb: 'starts_heating' }, { arm: () => set(C, 'heat', { hvac_action: 'idle' }), fire: () => set(C, 'heat', { hvac_action: 'heating' }) });
await set(C, 'heat', { hvac_action: '' });
const CV = 'cover.rollladen_test';
await trig('Rollladen geht auf (Fahrzeit)', { subject: CV, verb: 'opens' }, { arm: () => set(CV, 'closed', { instant: true }), fire: () => set(CV, 'open') });
await trig('Rollladen geht zu (Fahrzeit)', { subject: CV, verb: 'closes' }, { arm: () => set(CV, 'open', { instant: true }), fire: () => set(CV, 'closed') });
const MP = 'media_player.homepod';
await trig('Medien an', { subject: MP, verb: 'turns_on' }, { arm: () => set(MP, 'off'), fire: () => set(MP, 'idle') });
await trig('Medien spielt', { subject: MP, verb: 'starts_playing' }, { arm: () => set(MP, 'paused'), fire: () => set(MP, 'playing') });
await trig('Medien stoppt', { subject: MP, verb: 'stops' }, { arm: () => set(MP, 'playing'), fire: () => set(MP, 'paused') });
const S = 'switch.sirene';
await trig('Schalter an', { subject: S, verb: 'turns_on' }, { arm: () => set(S, 'off'), fire: () => set(S, 'on') });
await trig('Schalter aus', { subject: S, verb: 'turns_off' }, { arm: () => set(S, 'on'), fire: () => set(S, 'off') });
await trig('Schalter länger als 2 Sek. an', { subject: S, verb: 'on_for', for: '2s' }, { arm: () => set(S, 'off'), fire: () => set(S, 'on'), early: 1300, wait: 3500 });
await set(S, 'off');
await trig('Skript lief', { subject: 'script.test_ablauf', verb: 'ran' }, { fire: () => svc('script', 'turn_on', { entity_id: 'script.test_ablauf' }) });
await trig('Wasser erkannt', { subject: 'binary_sensor.wasser_kueche', verb: 'wet' }, { arm: () => set('binary_sensor.wasser_kueche', 'off'), fire: () => set('binary_sensor.wasser_kueche', 'on') });
await set('binary_sensor.wasser_kueche', 'off');
const K = 'lock.kellertuer_schloss';
await trig('Schloss entriegelt (Motor)', { subject: K, verb: 'unlocked' }, { arm: () => set(K, 'locked'), fire: () => svc('lock', 'unlock', { entity_id: K }) });
await set(K, 'locked');
const G = 'binary_sensor.garage_erschuetterung';
await trig('Binärsensor an', { subject: G, verb: 'turns_on' }, { arm: () => set(G, 'off'), fire: () => set(G, 'on') });
await trig('Binärsensor aus', { subject: G, verb: 'turns_off' }, { arm: () => set(G, 'on'), fire: () => set(G, 'off') });
await trig('Binärsensor länger als 2 Sek. an', { subject: G, verb: 'on_for', for: '2s' }, { arm: () => set(G, 'off'), fire: () => set(G, 'on'), early: 1300, wait: 3500 });
await set(G, 'off');

section('Auslöser Messwerte');
const T = 'sensor.temp_bad';
await trig('Temperatur unter 18', { subject: T, verb: 'below', value: 18 }, { arm: () => set(T, '21'), fire: () => set(T, '17') });
await trig('Temperatur über 25', { subject: T, verb: 'above', value: 25 }, { arm: () => set(T, '21'), fire: () => set(T, '26') });
if (!skip('Rauschen')) {
  await set(T, '21');
  const r = await save({ name: 'T Rauschen', type: 'when', when: [{ subject: T, verb: 'below', value: 18 }], then: [PROBE('Rauschen')], options: { manual_pause: '' } });
  await sleep(300);
  for (const v of ['17.9', '17.8', '17.95', '17.7']) {
    await set(T, v);
    await sleep(250);
  }
  await sleep(500);
  const once = count(r.id);
  await set(T, '18.2');
  await sleep(250);
  await set(T, '17.9');
  await sleep(800);
  cell('Messwert rauscht unter der Grenze → ein Auslösen pro Unterschreiten', once === 1 && count(r.id) === 2, { once, total: count(r.id) });
  await del(r.id);
}
await set(T, '21');
const LUX = 'sensor.lux_flur';
await trig('Helligkeit unter 5 lx', { subject: LUX, verb: 'below', value: 5 }, { arm: () => set(LUX, '50'), fire: () => set(LUX, '2') });
await trig('Helligkeit über 100 lx', { subject: LUX, verb: 'above', value: 100 }, { arm: () => set(LUX, '50'), fire: () => set(LUX, '300') });
await set(LUX, '10');
const CO2 = 'sensor.co2_wohnzimmer';
await trig('Sensor ändert sich', { subject: CO2, verb: 'changes' }, { arm: () => set(CO2, '600'), fire: () => set(CO2, '650') });
await trig('Sensor über 1000', { subject: CO2, verb: 'above', value: 1000 }, { arm: () => set(CO2, '600'), fire: () => set(CO2, '1200') });
await trig('Sensor unter 500', { subject: CO2, verb: 'below', value: 500 }, { arm: () => set(CO2, '600'), fire: () => set(CO2, '450') });
await trig('Sensor wird 800 (Zahl, gemeldet als 800.0)', { subject: CO2, verb: 'becomes', state: '800' }, { arm: () => set(CO2, '600'), fire: () => set(CO2, '800') });
await set(CO2, '600');
const TXT = 'sensor.handy_robin_geocoded_location';
await trig('Textsensor wird „arbeit“ (Groß/klein egal)', { subject: TXT, verb: 'becomes', state: 'arbeit' }, { arm: () => set(TXT, 'Unknown'), fire: () => set(TXT, 'Arbeit') });
await set(TXT, 'Unknown');
const NUM = 'number.heizung_wohnzimmer_local_temperature_calibration';
await trig('Zahl ändert sich', { subject: NUM, verb: 'changes' }, { arm: () => set(NUM, '0'), fire: () => set(NUM, '1.5') });
await trig('Zahl über 2', { subject: NUM, verb: 'above', value: 2 }, { arm: () => set(NUM, '0'), fire: () => set(NUM, '3') });
await set(NUM, '0');
const IN = 'input_number.zieltemp';
await trig('Eingabezahl über 25', { subject: IN, verb: 'above', value: 25 }, { arm: () => svc('input_number', 'set_value', { entity_id: IN, value: 20 }), fire: () => svc('input_number', 'set_value', { entity_id: IN, value: 26 }) });
await trig('Eingabezahl unter 15', { subject: IN, verb: 'below', value: 15 }, { arm: () => svc('input_number', 'set_value', { entity_id: IN, value: 20 }), fire: () => svc('input_number', 'set_value', { entity_id: IN, value: 12 }) });

section('Auslöser Helfer, Knöpfe, Szenen, Ereignisse');
const SEL = 'input_select.waschprogramm';
await trig('Auswahl wird „Schnell“', { subject: SEL, verb: 'becomes', state: 'Schnell' }, { arm: () => svc('input_select', 'select_option', { entity_id: SEL, option: 'Eco' }), fire: () => svc('input_select', 'select_option', { entity_id: SEL, option: 'Schnell' }) });
await trig('Auswahl ändert sich', { subject: SEL, verb: 'changes' }, { arm: () => svc('input_select', 'select_option', { entity_id: SEL, option: 'Eco' }), fire: () => svc('input_select', 'select_option', { entity_id: SEL, option: 'Baumwolle' }) });
const NOTE = 'input_text.notiz';
await trig('Text wird „hallo“', { subject: NOTE, verb: 'becomes', state: 'hallo' }, { arm: () => svc('input_text', 'set_value', { entity_id: NOTE, value: 'x' }), fire: () => svc('input_text', 'set_value', { entity_id: NOTE, value: 'hallo' }) });
await trig('Text ändert sich', { subject: NOTE, verb: 'changes' }, { arm: () => svc('input_text', 'set_value', { entity_id: NOTE, value: 'x' }), fire: () => svc('input_text', 'set_value', { entity_id: NOTE, value: 'y' }) });
await trig('Ein/Aus-Helfer an', { subject: 'input_boolean.besuch', verb: 'turns_on' }, { arm: () => svc('input_boolean', 'turn_off', { entity_id: 'input_boolean.besuch' }), fire: () => svc('input_boolean', 'turn_on', { entity_id: 'input_boolean.besuch' }) });
await svc('input_boolean', 'turn_off', { entity_id: 'input_boolean.besuch' });
await trig('Taste gedrückt (button)', { subject: 'button.test_taste', verb: 'pressed' }, { fire: () => set('button.test_taste', 'press') });
await trig('Taste gedrückt (input_button)', { subject: 'input_button.klingel', verb: 'pressed' }, { fire: () => svc('input_button', 'press', { entity_id: 'input_button.klingel' }) });
await trig('Szene aktiviert', { subject: 'scene.test_szene', verb: 'activated' }, { fire: () => svc('scene', 'turn_on', { entity_id: 'scene.test_szene' }) });
await svc('input_boolean', 'turn_off', { entity_id: 'input_boolean.besuch' });
await trig('Ereignis (Wandschalter)', { subject: 'event.wandschalter_test', verb: 'changes' }, { fire: () => set('event.wandschalter_test', 'double') });
await api('POST', '/api/states/weather.hr_test', { state: 'sunny' });
await trig('beliebige Entität wird „rainy“', { subject: 'weather.hr_test', verb: 'becomes', state: 'rainy' }, { arm: () => api('POST', '/api/states/weather.hr_test', { state: 'sunny' }), fire: () => api('POST', '/api/states/weather.hr_test', { state: 'rainy' }) });
await trig('beliebige Entität ändert sich', { subject: 'weather.hr_test', verb: 'changes' }, { fire: () => api('POST', '/api/states/weather.hr_test', { state: 'cloudy' }) });

section('Auslöser Personen, Tracker, Fahrzeug');
const FAR = { latitude: 48.137, longitude: 11.575 };
const HOME = { latitude: 52.52, longitude: 13.4 };
const KIM = 'device_tracker.handy_kim';
await trig('Tracker kommt an', { subject: KIM, verb: 'arrives' }, { arm: () => set(KIM, '', FAR), fire: () => set(KIM, '', HOME) });
await trig('Tracker geht', { subject: KIM, verb: 'leaves' }, { arm: () => set(KIM, '', HOME), fire: () => set(KIM, '', FAR) });
await set(KIM, '', HOME);
const CAR = 'device_tracker.testauto';
await trig(`Fahrzeug kommt an (${kinds[CAR]})`, { subject: CAR, verb: 'arrives' }, { arm: () => set(CAR, '', FAR), fire: () => set(CAR, '', HOME) });
await trig(`Fahrzeug fährt weg (${kinds[CAR]})`, { subject: CAR, verb: 'leaves' }, { arm: () => set(CAR, '', HOME), fire: () => set(CAR, '', FAR) });
await set(CAR, '', HOME);
snap = await snapshot();
const sam = snap.persons.find((p) => /Sam/.test(p.name));
const SAM = `person:${sam?.id}`;
await trig('Person kommt heim', { subject: SAM, verb: 'arrives' }, { arm: () => see('sam_handy', { location_name: 'not_home' }), fire: () => see('sam_handy', { location_name: 'home' }) });
await trig('Person geht', { subject: SAM, verb: 'leaves' }, { arm: () => see('sam_handy', { location_name: 'home' }), fire: () => see('sam_handy', { location_name: 'not_home' }) });
await trig('Person betritt Zone', { subject: SAM, verb: 'enters_zone', zone: 'testzone' }, { arm: () => see('sam_handy', { location_name: 'not_home' }), fire: () => see('sam_handy', { location_name: 'Testzone' }) });
await trig('Person verlässt Zone', { subject: SAM, verb: 'leaves_zone', zone: 'testzone' }, { arm: () => see('sam_handy', { location_name: 'Testzone' }), fire: () => see('sam_handy', { location_name: 'not_home' }) });
await trig('Person weit weg (100 km)', { subject: SAM, verb: 'far_from', zone: 'home', distance: 100 }, { arm: () => see('sam_handy', { gps: [52.53, 13.42], gps_accuracy: 10 }), fire: () => see('sam_handy', { gps: [FAR.latitude, FAR.longitude], gps_accuracy: 10 }) });
await trig('jemand kommt heim (alle Personen)', { subject: 'person:someone', verb: 'arrives' }, { arm: () => see('sam_handy', { location_name: 'not_home' }), fire: () => see('sam_handy', { location_name: 'home' }) });
await see('sam_handy', { location_name: 'not_home' });

section('Auslöser Hausmodus, Alarm, Regeln, Sonne');
await trig('Hausmodus wird „weg“', { subject: 'mode', verb: 'changes_to', mode: 'away' }, { arm: () => ws.call({ type: 'house_rules/mode/set', mode: 'home' }), fire: () => ws.call({ type: 'house_rules/mode/set', mode: 'away' }) });
await ws.call({ type: 'house_rules/mode/set', mode: 'home' });
if (!skip('Regel lief')) {
  const a = await save({ name: 'T Quelle', type: 'when', when: [{ subject: G, verb: 'turns_on' }], then: [PROBE('Quelle')], options: { manual_pause: '' } });
  await trig('Regel lief', { subject: `rule:${a.id}`, verb: 'ran' }, { fire: () => ws.call({ type: 'house_rules/rule/run', rule_id: a.id }) });
  await del(a.id);
}
for (const [verb, off] of [['sets', '-30m'], ['rises', '+15m']]) {
  if (skip(`Sonne ${verb}`)) continue;
  // the sun's time cannot be faked: the trigger is set up with its offset (HA's own sun tracker), it fires at that time
  const r = await save({ name: `T Sonne ${verb}`, type: 'when', when: [{ subject: 'sun', verb, offset: off }], then: [PROBE('Sonne')], options: { manual_pause: '' } });
  const t = await ws.call({ type: 'house_rules/rule/test', rule: r });
  cell(`Sonne ${verb} ${off}: angelegt (Zeitpunkt nicht prüfbar)`, r.when[0].offset === off && t.verdict, t.verdict);
  await del(r.id);
}
// the alarm as trigger
const alarmCfg = { enabled: true, confirm: 'none', modes: Object.fromEntries(['away', 'night', 'home'].map((m) => [m, { sensors: ['binary_sensor.haustuer'], entry_delay: 1, exit_delay: 0, loud: false, lights: { mode: 'none', entities: [] }, activate: [], smart: { inside: { on: false, seconds: 90 }, arrival: { on: false, minutes: 10 } }, auto: { arm_on: [], disarm_on: [], arm_at: '', disarm_at: '', only_auto: true } }])), notify: { persons: 'everyone', critical: false, pre_alarm: false, armed: false }, sirens: [], buttons: ['disarm'], duration: 30, code: null };
if (!skip('Alarm')) {
  await set('binary_sensor.haustuer', 'off');
  await ws.call({ type: 'house_rules/alarm/config', config: alarmCfg });
  await ws.call({ type: 'house_rules/alarm/disarm' }).catch(() => null);
  await trig('Alarm scharf', { subject: 'alarm', verb: 'armed' }, { fire: () => ws.call({ type: 'house_rules/alarm/arm', mode: 'home', force: true }) });
  cell('Alarm-Zustand scharf (Bedingung)', (await condCheck({ subject: 'alarm', verb: 'is_armed' })) === true);
  await trig('Alarm ausgelöst (Eingangsverzögerung 1 Sek.)', { subject: 'alarm', verb: 'triggered' }, { fire: () => set('binary_sensor.haustuer', 'on'), wait: 6000 });
  cell('Alarm ausgelöst (Bedingung)', (await condCheck({ subject: 'alarm', verb: 'is_triggered' })) === true);
  await set('binary_sensor.haustuer', 'off');
  await trig('Alarm aus', { subject: 'alarm', verb: 'disarmed' }, { fire: () => ws.call({ type: 'house_rules/alarm/disarm' }) });
  cell('Alarm aus (Bedingung)', (await condCheck({ subject: 'alarm', verb: 'is_disarmed' })) === true);
}
async function condCheck(c) {
  return (await ws.call({ type: 'house_rules/rule/test', rule: { name: 'c', type: 'while', when: [c], then: [PROBE('c')] } })).checks[0]?.ok;
}

section('Auslöser Gruppen und Platzhalter');
if (!skip('Gruppe')) {
  const g = (await ws.call({ type: 'house_rules/group/save', group: { name: 'Testgruppe gemischt', icon: 'light', members: [L, S], match: 'any' } })).group;
  await trig('gemischte Gruppe geht an', { subject: `group:${g.id}`, verb: 'turns_on' }, { arm: async () => { await set(L, 'off'); await set(S, 'off'); }, fire: () => set(S, 'on') });
  const g2 = (await ws.call({ type: 'house_rules/group/save', group: { name: 'Testgruppe alle', icon: 'light', members: [L, 'light.sofalicht'], match: 'all' } })).group;
  await trig('Gruppe „alle“: erst wenn alle an', { subject: `group:${g2.id}`, verb: 'turns_on' }, { arm: async () => { await set(L, 'off'); await set('light.sofalicht', 'on'); }, fire: () => set(L, 'on') });
  await ws.call({ type: 'house_rules/group/delete', group_id: g.id });
  await ws.call({ type: 'house_rules/group/delete', group_id: g2.id });
  await set(S, 'off');
  await set(L, 'off');
  await set('light.sofalicht', 'off');
}
await trig('irgendein Fenster geht auf', { subject: 'any:window', verb: 'opens' }, { fire: () => set(W, 'on') });
await set(W, 'off');
if (!skip('alle Fenster')) {
  const wins = (await snapshot()).devices.filter((d) => d.kind === 'window' && d.entity_id.startsWith('binary_sensor.')).map((d) => d.entity_id);
  for (const w of wins) await set(w, 'off');
  const r = await save({ name: 'T alle Fenster', type: 'when', when: [{ subject: 'all:window', verb: 'opens' }], then: [PROBE('alle')], options: { manual_pause: '' } });
  await sleep(300);
  for (const w of wins.slice(0, -1)) await set(w, 'on');
  await sleep(600);
  const before = count(r.id);
  await set(wins.at(-1), 'on');
  cell(`alle ${wins.length} Fenster offen → erst beim letzten`, wins.length > 1 && before === 0 && (await until(() => count(r.id) > 0, 3000, 100)), { wins, before });
  await del(r.id);
  for (const w of wins) await set(w, 'off');
}
if (!skip('selben Raum')) {
  await set('light.sofalicht', 'off');
  await set('light.badlicht', 'off');
  const r = await save({ name: 'T selber Raum', type: 'when', when: [{ subject: 'any:motion', verb: 'detected' }], then: [{ subject: 'any:light@same', verb: 'turn_on' }], options: { manual_pause: '' } });
  await sleep(300);
  await set(M, 'on');
  const on = await until(async () => (await stateOf('light.sofalicht')) === 'on', 4000);
  cell('„im selben Raum“: Bewegung im Wohnzimmer → nur dort Licht', on && (await stateOf('light.badlicht')) === 'off', await hist(3));
  await del(r.id);
  await set(M, 'off');
  await set('light.sofalicht', 'off');
}

section('Auslöser mit Bedingungen, Pause, Abklingzeit');
if (!skip('nur wenn')) {
  await svc('input_boolean', 'turn_off', { entity_id: 'input_boolean.besuch' });
  const r = await save({ name: 'T nur wenn', type: 'when', when: [{ subject: G, verb: 'turns_on' }], only: [{ subject: 'input_boolean.besuch', verb: 'is_on' }], then: [PROBE('nur wenn')], options: { manual_pause: '' } });
  await sleep(300);
  await set(G, 'on');
  await sleep(800);
  const blocked = count(r.id) === 0 && (await hist(3)).some((h) => /^skipped/.test(h));
  await set(G, 'off');
  await svc('input_boolean', 'turn_on', { entity_id: 'input_boolean.besuch' });
  await sleep(300);
  await set(G, 'on');
  cell('„nur wenn“: nein → übersprungen (im Verlauf), ja → läuft', blocked && (await until(() => count(r.id) > 0, 3000, 100)), await hist(3));
  await del(r.id);
  await set(G, 'off');
  await svc('input_boolean', 'turn_off', { entity_id: 'input_boolean.besuch' });
}
if (!skip('Abklingzeit')) {
  const r = await save({ name: 'T Abklingzeit', type: 'when', when: [{ subject: G, verb: 'turns_on' }], then: [PROBE('ab')], options: { manual_pause: '', cooldown: '1h' } });
  await sleep(300);
  for (let i = 0; i < 3; i++) {
    await set(G, 'on');
    await sleep(400);
    await set(G, 'off');
    await sleep(200);
  }
  cell('Abklingzeit 1 Std.: dreimal ausgelöst → einmal gelaufen', count(r.id) === 1, count(r.id));
  await ws.call({ type: 'house_rules/rule/pause', rule_id: r.id, minutes: 5 });
  const n = count(r.id);
  await ws.call({ type: 'house_rules/rule/run', rule_id: r.id });
  cell('„jetzt ausführen“ läuft trotz Pause und Abklingzeit', await until(() => count(r.id) > n, 3000, 100));
  await del(r.id);
}

// ================================================================ conditions (the engine's check)
section('Bedingungen');
await cond('Licht ist an', { subject: L, verb: 'is_on' }, () => set(L, 'on'), () => set(L, 'off'));
await cond('Licht ist aus', { subject: L, verb: 'is_off' }, () => set(L, 'off'), () => set(L, 'on'));
await cond('Licht heller als 50 %', { subject: L, verb: 'is_brighter', brightness: 50 }, () => set(L, 'on', { brightness: 230 }), () => set(L, 'on', { brightness: 60 }));
await cond('Licht dunkler als 50 %', { subject: L, verb: 'is_dimmer', brightness: 50 }, () => set(L, 'on', { brightness: 60 }), () => set(L, 'on', { brightness: 230 }));
if (!skip('seit')) {
  await set(L, 'off');
  await sleep(300);
  await set(L, 'on');
  const a = await condCheck({ subject: L, verb: 'is_on', for: '2s' });
  await sleep(2300);
  const b = await condCheck({ subject: L, verb: 'is_on', for: '2s' });
  await set(L, 'on', { brightness: 120 }); // an attribute changes: the state is on for longer still
  const c = await condCheck({ subject: L, verb: 'is_on', for: '2s' });
  cell('„ist seit 2 Sek. an“ (auch wenn sich die Helligkeit ändert)', a === false && b === true && c === true, { a, b, c });
}
await set(L, 'off');
await cond('Fenster offen', { subject: W, verb: 'is_open' }, () => set(W, 'on'), () => set(W, 'off'));
await cond('Fenster zu', { subject: W, verb: 'is_closed' }, () => set(W, 'off'), () => set(W, 'on'));
await set(W, 'off');
await cond('Bewegung aktiv', { subject: M, verb: 'is_active' }, () => set(M, 'on'), () => set(M, 'off'));
await cond('keine Bewegung', { subject: M, verb: 'is_clear' }, () => set(M, 'off'), () => set(M, 'on'));
await set(M, 'off');
await cond('Präsenz belegt', { subject: P, verb: 'is_occupied' }, () => set(P, 'on'), () => set(P, 'off'));
await cond('Präsenz frei', { subject: P, verb: 'is_free' }, () => set(P, 'off'), () => set(P, 'on'));
await set(P, 'off');
await cond('Raum belegt', { subject: `room:${R.Wohnzimmer}`, verb: 'is_occupied' }, () => set(M, 'on'), () => set(M, 'off'), 4500);
await cond('Raum leer', { subject: `room:${R.Wohnzimmer}`, verb: 'is_empty' }, () => set(M, 'off'), () => set(M, 'on'), 4500);
await set(M, 'off');
// a room only counts as bright again once it has been bright for `bright_for` minutes (10 by default): none here
await ws.call({ type: 'house_rules/room/save', room: { id: R.Flur, dark: { bright_for: 0 } } });
await cond('Raum dunkel (Lux)', { subject: `room:${R.Flur}`, verb: 'is_dark' }, () => set(LUX, '2'), () => set(LUX, '800'), 600);
await cond('Raum hell (Lux)', { subject: `room:${R.Flur}`, verb: 'is_bright' }, () => set(LUX, '800'), () => set(LUX, '2'), 600);
await set(LUX, '10');
await ws.call({ type: 'house_rules/room/save', room: { id: R.Flur, dark: { bright_for: 10 } } });
await cond('Heizung heizt', { subject: C, verb: 'is_heating' }, () => set(C, 'heat', { hvac_action: 'heating' }), () => set(C, 'heat', { hvac_action: 'idle' }));
await set(C, 'heat', { hvac_action: '' });
await cond('Rollladen offen', { subject: CV, verb: 'is_open' }, () => set(CV, 'open', { instant: true }), () => set(CV, 'closed', { instant: true }));
await cond('Medien spielt', { subject: MP, verb: 'is_playing' }, () => set(MP, 'playing'), () => set(MP, 'paused'));
await cond('Medien an', { subject: MP, verb: 'is_on' }, () => set(MP, 'idle'), () => set(MP, 'off'));
await cond('Wasser erkannt', { subject: 'binary_sensor.wasser_kueche', verb: 'is_wet' }, () => set('binary_sensor.wasser_kueche', 'on'), () => set('binary_sensor.wasser_kueche', 'off'));
await cond('Temperatur unter 18', { subject: T, verb: 'is_below', value: 18 }, () => set(T, '17'), () => set(T, '21'));
await cond('Temperatur über 25', { subject: T, verb: 'is_above', value: 25 }, () => set(T, '26'), () => set(T, '21'));
await cond('Schloss zu', { subject: K, verb: 'is_locked' }, () => set(K, 'locked'), () => set(K, 'unlocked'));
await set(K, 'locked');
await cond('Tracker zu Hause', { subject: KIM, verb: 'is_home' }, () => set(KIM, '', HOME), () => set(KIM, '', FAR));
await cond('Tracker weg', { subject: KIM, verb: 'is_away' }, () => set(KIM, '', FAR), () => set(KIM, '', HOME));
await cond('Fahrzeug zu Hause', { subject: CAR, verb: 'is_home' }, () => set(CAR, '', HOME), () => set(CAR, '', FAR));
await set(CAR, '', HOME);
await cond('Person zu Hause', { subject: SAM, verb: 'is_home' }, () => see('sam_handy', { location_name: 'home' }), () => see('sam_handy', { location_name: 'not_home' }));
await cond('Person weg', { subject: SAM, verb: 'is_away' }, () => see('sam_handy', { location_name: 'not_home' }), () => see('sam_handy', { location_name: 'home' }));
await cond('Person in Zone', { subject: SAM, verb: 'in_zone', zone: 'testzone' }, () => see('sam_handy', { location_name: 'Testzone' }), () => see('sam_handy', { location_name: 'not_home' }));
await cond('Person nicht in Zone', { subject: SAM, verb: 'not_in_zone', zone: 'testzone' }, () => see('sam_handy', { location_name: 'not_home' }), () => see('sam_handy', { location_name: 'Testzone' }));
await cond('Person weit weg', { subject: SAM, verb: 'is_far', zone: 'home', distance: 100 }, () => see('sam_handy', { gps: [FAR.latitude, FAR.longitude], gps_accuracy: 10 }), () => see('sam_handy', { gps: [52.53, 13.42], gps_accuracy: 10 }));
await cond('Person in der Nähe (5 km)', { subject: SAM, verb: 'is_near', distance: 5 }, () => see('sam_handy', { gps: [52.53, 13.42], gps_accuracy: 10 }), () => see('sam_handy', { gps: [FAR.latitude, FAR.longitude], gps_accuracy: 10 }));
await cond('jemand zu Hause / alle weg', { subject: 'person:someone', verb: 'is_home' }, () => see('alex_handy', { location_name: 'home' }), async () => { await see('alex_handy', { location_name: 'not_home' }); await see('sam_handy', { location_name: 'not_home' }); });
await see('alex_handy', { location_name: 'home' });
await see('sam_handy', { location_name: 'not_home' });
await cond('Sensor ist 600', { subject: CO2, verb: 'is', state: '600' }, () => set(CO2, '600'), () => set(CO2, '700'));
await cond('Sensor ist nicht 600', { subject: CO2, verb: 'is_not', state: '600' }, () => set(CO2, '700'), () => set(CO2, '600'));
await cond('Sensor über 1000', { subject: CO2, verb: 'is_above', value: 1000 }, () => set(CO2, '1100'), () => set(CO2, '900'));
await cond('Sensor unter 500', { subject: CO2, verb: 'is_below', value: 500 }, () => set(CO2, '400'), () => set(CO2, '900'));
await set(CO2, '600');
await cond('Auswahl ist „Eco“', { subject: SEL, verb: 'is', state: 'Eco' }, () => svc('input_select', 'select_option', { entity_id: SEL, option: 'Eco' }), () => svc('input_select', 'select_option', { entity_id: SEL, option: 'Schnell' }));
await cond('Hausmodus ist „zu Hause“', { subject: 'mode', verb: 'is', mode: 'home' }, () => ws.call({ type: 'house_rules/mode/set', mode: 'home' }), () => ws.call({ type: 'house_rules/mode/set', mode: 'away' }));
await cond('Hausmodus ist nicht „weg“', { subject: 'mode', verb: 'is_not', mode: 'away' }, () => ws.call({ type: 'house_rules/mode/set', mode: 'home' }), () => ws.call({ type: 'house_rules/mode/set', mode: 'away' }));
await ws.call({ type: 'house_rules/mode/set', mode: 'home' });
if (!skip('Sonne')) {
  const sun0 = await st('sun.sun');
  await cond('Sonne untergegangen', { subject: 'sun', verb: 'is_down' }, () => api('POST', '/api/states/sun.sun', { state: 'below_horizon', attributes: sun0.attributes }), () => api('POST', '/api/states/sun.sun', { state: 'above_horizon', attributes: sun0.attributes }));
  await cond('Sonne oben', { subject: 'sun', verb: 'is_up' }, () => api('POST', '/api/states/sun.sun', { state: 'above_horizon', attributes: sun0.attributes }), () => api('POST', '/api/states/sun.sun', { state: 'below_horizon', attributes: sun0.attributes }));
  await api('POST', '/api/states/sun.sun', { state: sun0.state, attributes: sun0.attributes });
}
const hm = (d) => berlin(d);
await condPair('Zeit zwischen', { subject: 'time', verb: 'between', from: hm(new Date(Date.now() - 3600e3)), to: hm(new Date(Date.now() + 3600e3)) }, { subject: 'time', verb: 'between', from: hm(new Date(Date.now() + 3600e3)), to: hm(new Date(Date.now() + 7200e3)) });
await condPair('Zeit zwischen (über Mitternacht)', { subject: 'time', verb: 'between', from: hm(new Date(Date.now() - 600e3)), to: hm(new Date(Date.now() - 1200e3)) }, { subject: 'time', verb: 'between', from: hm(new Date(Date.now() + 600e3)), to: hm(new Date(Date.now() + 1200e3)) });
if (!skip('Tageszeit')) {
  const h = parseInt(new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit' }), 10);
  const times = (await snapshot()).settings?.times ?? {};
  const win = { night: times.night ?? [22, 6], morning: times.morning ?? [6, 10], evening: times.evening ?? [18, 22] };
  const inWin = ([a, b]) => (a <= b ? h >= a && h < b : h >= a || h < b);
  const res = {};
  for (const v of ['night', 'morning', 'evening']) res[v] = (await condCheck({ subject: 'time', verb: v })) === inWin(win[v]);
  cell('Nacht / Morgen / Abend nach den Zeiten der Einstellungen', Object.values(res).every(Boolean), { h, win, res });
  const wd = new Date().toLocaleDateString('en-GB', { timeZone: 'Europe/Berlin', weekday: 'short' });
  const weekend = wd === 'Sat' || wd === 'Sun';
  cell(`Werktag / Wochenende (${wd})`, (await condCheck({ subject: 'time', verb: 'weekend' })) === weekend && (await condCheck({ subject: 'time', verb: 'workdays' })) === !weekend);
}
if (!skip('Regel aktiv')) {
  const r = await save({ name: 'T aktiv', type: 'while', when: [{ subject: G, verb: 'is_on' }], then: [PROBE('aktiv')], options: { manual_pause: '' } });
  await cond('Regel ist aktiv', { subject: `rule:${r.id}`, verb: 'is_active' }, () => set(G, 'on'), () => set(G, 'off'), 600);
  await del(r.id);
}
if (!skip('heute geputzt')) {
  // nothing in the rules watches the robot: it cleans (started in its app), the condition must still know
  const before = await condCheck({ subject: 'vacuum.robo_oben', verb: 'not_cleaned_today' });
  await set('vacuum.robo_oben', 'cleaning');
  await sleep(500);
  await set('vacuum.robo_oben', 'docked');
  await sleep(300);
  const after = await condCheck({ subject: 'vacuum.robo_oben', verb: 'cleaned_today' });
  cell(before === false ? '„heute geputzt“ (schon heute markiert – Vorbedingung nicht prüfbar)' : '„heute geputzt“ auch ohne Regel auf den Saugroboter', after === true, { before, after });
}
// (the second robot: the first one pauses the motion sensors of its rooms while it cleans, see test-engine.mjs)
const VAC = 'vacuum.robo_oben';
await cond('Saugroboter in der Station', { subject: VAC, verb: 'is_docked' }, () => set(VAC, 'docked'), () => set(VAC, 'cleaning'));
await trig('Saugroboter startet', { subject: VAC, verb: 'starts' }, { arm: () => set(VAC, 'docked'), fire: () => set(VAC, 'cleaning') });
await trig('Saugroboter fertig', { subject: VAC, verb: 'done' }, { arm: () => set(VAC, 'cleaning'), fire: () => set(VAC, 'docked') });
await set(VAC, 'docked');

// ================================================================ actions
section('Aktionen Licht');
await act('einschalten', { subject: L, verb: 'turn_on' }, async () => (await stateOf(L)) === 'on', { pre: () => set(L, 'off') });
await act('ausschalten', { subject: L, verb: 'turn_off' }, async () => (await stateOf(L)) === 'off', { pre: () => set(L, 'on') });
await act('umschalten', { subject: L, verb: 'toggle' }, async () => (await stateOf(L)) === 'on', { pre: () => set(L, 'off') });
await act('dimmen auf 30 %', { subject: L, verb: 'dim', brightness: 30 }, async () => { const s = await st(L); return s.state === 'on' && Math.abs(s.attributes.brightness - 77) <= 3; }, { pre: () => set(L, 'off') });
await act('warmweiß', { subject: L, verb: 'color', color: 'warmweiß' }, async () => (await st(L)).attributes.color_temp_kelvin === 2700, { pre: () => set(L, 'off') });
await act('Farbe rot (RGBW-Lampe)', { subject: 'light.kuechenlicht', verb: 'color', color: 'rot' }, async () => { const s = await st('light.kuechenlicht'); return s.state === 'on' && s.attributes.color_mode === 'rgbw'; }, { pre: () => set('light.kuechenlicht', 'off') });
await set('light.kuechenlicht', 'off');
await act('für 2 Sek. an, dann wieder wie vorher', { subject: L, verb: 'turn_on', for: '2s' }, async () => (await stateOf(L)) === 'on', { pre: () => set(L, 'off') });
if (!skip('für 2 Sek.')) cell('… nach 2 Sek. wieder aus', await until(async () => (await stateOf(L)) === 'off', 5000));
if (!skip('blinken')) {
  await set(L, 'off');
  const p = ws.call({ type: 'house_rules/rule/run_actions', rule: { name: 'A blinken', when: [{ subject: G, verb: 'turns_on' }], then: [{ subject: L, verb: 'blink' }], options: { manual_pause: '' } } });
  const sawOn = await until(async () => (await stateOf(L)) === 'on', 3000, 100);
  await p;
  cell('blinken: an und aus, danach wie vorher (aus)', sawOn && (await until(async () => (await stateOf(L)) === 'off', 3000)));
}
await act('alle Lichter im Raum (Platzhalter mit Raum)', { subject: `any:light@${R.Bad}`, verb: 'turn_on' }, async () => (await stateOf('light.badlicht')) === 'on', { pre: () => set('light.badlicht', 'off') });
await set('light.badlicht', 'off');
if (!skip('nicht erreichbar')) {
  await set(L, 'unavailable');
  const res = await ws.call({ type: 'house_rules/rule/run_actions', rule: { name: 'A weg', when: [{ subject: G, verb: 'turns_on' }], then: [{ subject: L, verb: 'turn_on' }], options: { manual_pause: '' } } });
  const d = res.done ?? [];
  cell('Lampe nicht erreichbar → als übersprungen gemeldet, nicht als erledigt', d.length > 0 && d.every((x) => /nicht erreichbar/.test(typeof x === 'string' ? x : x.text)), d);
  await set(L, 'off');
}

section('Aktionen Heizung, Rollladen, Medien, Schloss, Saugroboter');
await set(C, 'heat', { temperature: 20, latency: 0 });
await act('Temperatur 22,5 °C', { subject: C, verb: 'set_temp', temperature: 22.5 }, async () => (await st(C)).attributes.temperature === 22.5);
await act('Eco', { subject: C, verb: 'eco' }, async () => (await st(C)).attributes.temperature === Number((await snapshot()).settings?.eco_temp ?? 17));
await act('Heizung aus', { subject: C, verb: 'turn_off' }, async () => (await stateOf(C)) === 'off');
await act('Boost (aus → heizen, +3 °C)', { subject: C, verb: 'boost', for: '2s' }, async () => { const s = await st(C); return s.state === 'heat' && s.attributes.temperature >= 23; }, { pre: () => set(C, 'off', { temperature: 20 }) });
if (!skip('Boost')) cell('… Boost endet: wieder wie vorher (aus)', await until(async () => (await stateOf(C)) === 'off', 5000), await st(C));
await set(C, 'heat', { temperature: 20 });
await act('Rollladen zu (Fahrzeit 2 Sek.)', { subject: CV, verb: 'close' }, async () => (await stateOf(CV)) === 'closed', { pre: () => set(CV, 'open', { instant: true }) });
await act('Rollladen auf', { subject: CV, verb: 'open' }, async () => (await stateOf(CV)) === 'open');
await act('Rollladen auf 40 %', { subject: CV, verb: 'position', position: 40 }, async () => { const s = await st(CV); return s.attributes.current_position === 40 && s.state === 'open'; });
await act('Medien abspielen', { subject: MP, verb: 'play' }, async () => (await stateOf(MP)) === 'playing', { pre: () => set(MP, 'paused') });
await act('Medien pausieren', { subject: MP, verb: 'pause' }, async () => (await stateOf(MP)) === 'paused');
await act('Lautstärke 40 %', { subject: MP, verb: 'volume', volume: 40 }, async () => (await st(MP)).attributes.volume_level === 0.4);
await act('Medien aus', { subject: MP, verb: 'turn_off' }, async () => (await stateOf(MP)) === 'off');
await api('POST', '/api/states/tts.hr_test', { state: 'unknown' });
await act('Durchsage', { subject: MP, verb: 'announce', message: 'Test' }, async () => (await calls()).some((c) => (c.service === 'tts.speak' && c.data.message === 'Test') || c.service === 'media_player.play_media'), { pre: () => calls(true) });
await act('Schloss zu (Motor)', { subject: K, verb: 'lock' }, async () => (await stateOf(K)) === 'locked', { pre: () => set(K, 'unlocked') });
if (!skip('aufschließen')) {
  await set(K, 'locked');
  await ws.call({ type: 'house_rules/rule/run_actions', rule: { name: 'A auf', when: [{ subject: G, verb: 'turns_on' }], then: [{ subject: K, verb: 'unlock' }], options: { manual_pause: '' } } });
  await sleep(1800);
  cell('aufschließen ohne Freigabe: bleibt zu', (await stateOf(K)) === 'locked');
}
await act('aufschließen mit Freigabe', { subject: K, verb: 'unlock' }, async () => (await stateOf(K)) === 'unlocked', { options: { allow_sensitive: true } });
await set(K, 'locked');
await act('Saugroboter starten', { subject: VAC, verb: 'start' }, async () => (await stateOf(VAC)) === 'cleaning', { pre: () => set(VAC, 'docked') });
await act('Saugroboter zur Station', { subject: VAC, verb: 'dock' }, async () => (await stateOf(VAC)) === 'docked');
await act('Schalter an', { subject: S, verb: 'turn_on' }, async () => (await stateOf(S)) === 'on', { pre: () => set(S, 'off') });
await act('Schalter umschalten', { subject: S, verb: 'toggle' }, async () => (await stateOf(S)) === 'off');
await act('Skript starten', { subject: 'script.test_ablauf', verb: 'run' }, async () => (await stateOf('script.test_ablauf')) === 'on');

section('Aktionen Helfer, Szenen, Automationen');
await act('Zahl setzen', { subject: IN, verb: 'set_value', value: 22 }, async () => Number(await stateOf(IN)) === 22);
await act('Zahl (number) setzen', { subject: NUM, verb: 'set_value', value: 1.5 }, async () => Number(await stateOf(NUM)) === 1.5);
await act('Auswahl setzen', { subject: SEL, verb: 'select', state: 'Baumwolle' }, async () => (await stateOf(SEL)) === 'Baumwolle');
await act('Text setzen', { subject: NOTE, verb: 'set_text', state: 'hallo welt' }, async () => (await stateOf(NOTE)) === 'hallo welt');
await act('Taste drücken (button)', { subject: 'button.test_taste', verb: 'press' }, async () => (await calls()).some((c) => c.service === 'button.press'), { pre: () => calls(true) });
const kl0 = await stateOf('input_button.klingel');
await act('Taste drücken (input_button)', { subject: 'input_button.klingel', verb: 'press' }, async () => (await stateOf('input_button.klingel')) !== kl0);
await act('Szene aktivieren', { subject: 'scene.test_szene', verb: 'activate' }, async () => (await stateOf('input_boolean.besuch')) === 'on', { pre: () => svc('input_boolean', 'turn_off', { entity_id: 'input_boolean.besuch' }) });
await act('Ein/Aus-Helfer aus', { subject: 'input_boolean.besuch', verb: 'turn_off' }, async () => (await stateOf('input_boolean.besuch')) === 'off');
await act('Automation auslösen', { subject: 'automation.test_flurlicht_an_per_ereignis', verb: 'trigger' }, async () => (await stateOf('light.flurlicht')) === 'on', { pre: () => set('light.flurlicht', 'off') });
await set('light.flurlicht', 'off');
await act('Hausmodus setzen', { subject: 'mode', verb: 'set', mode: 'away' }, async () => (await snapshot()).mode === 'away');
await ws.call({ type: 'house_rules/mode/set', mode: 'home' });
if (!skip('Alarm')) {
  await ws.call({ type: 'house_rules/alarm/config', config: alarmCfg });
  await act('Alarm scharf (zu Hause)', { subject: 'alarm', verb: 'arm_home' }, async () => (await snapshot()).alarm.state === 'armed_home');
  await ws.call({ type: 'house_rules/rule/run_actions', rule: { name: 'A unscharf', when: [{ subject: G, verb: 'turns_on' }], then: [{ subject: 'alarm', verb: 'disarm' }], options: {} } });
  await sleep(500);
  cell('Alarm aus ohne Freigabe: bleibt scharf', (await snapshot()).alarm.state === 'armed_home');
  await act('Alarm aus mit Freigabe', { subject: 'alarm', verb: 'disarm' }, async () => (await snapshot()).alarm.state === 'disarmed', { options: { allow_sensitive: true } });
  await act('Alarm auslösen', { subject: 'alarm', verb: 'trigger' }, async () => (await snapshot()).alarm.state === 'triggered');
  await ws.call({ type: 'house_rules/alarm/disarm' });
  await ws.call({ type: 'house_rules/alarm/config', config: { ...alarmCfg, enabled: false } }).catch(() => null);
}

section('Aktionen Nachrichten, Warten, Regeln');
const notes = async (re) => (await calls()).filter((c) => c.service.startsWith('notify.') && (!re || re.test(`${c.data?.title} ${c.data?.message}`)));
await ws.call({ type: 'house_rules/settings/set', settings: { notifications: { reset: true, quiet: { on: false }, kinds: { rule: { on: true, gap: 0, daily: 0 } } } } });
const alex = (await snapshot()).persons.find((p) => /Alex/.test(p.name));
await act('Nachricht senden', { subject: `notify:${alex?.id}`, verb: 'send', message: 'Funktionstest Nachricht' }, async () => (await notes(/Funktionstest Nachricht/)).length === 1, { pre: () => calls(true) });
await act('Alarm-Nachricht (kritisch)', { subject: `notify:${alex?.id}`, verb: 'alarm', message: 'Funktionstest kritisch' }, async () => (await notes(/Funktionstest kritisch/))[0]?.data?.data?.push?.['interruption-level'] === 'critical', { pre: () => calls(true) });
for (const [answer, runs] of [['YES', true], ['NO', false]]) {
  if (skip(`Rückfrage ${answer}`)) continue;
  await calls(true);
  const r = await save({ name: `T Frage ${answer}`, type: 'when', when: [{ subject: G, verb: 'turns_on' }], then: [{ subject: `notify:${alex?.id}`, verb: 'ask', message: `Frage ${answer}` }, PROBE(`nach Frage ${answer}`)], options: { manual_pause: '' } });
  await ws.call({ type: 'house_rules/rule/run', rule_id: r.id });
  const q = await until(async () => (await notes(new RegExp(`Frage ${answer}`)))[0], 4000);
  const action = q?.data?.data?.actions?.find((a) => a.action.endsWith(`_${answer}`))?.action;
  await api('POST', '/api/events/mobile_app_notification_action', { action });
  await sleep(1000);
  cell(`Rückfrage, Antwort ${answer === 'YES' ? 'Ja → weiter' : 'Nein → Rest entfällt'}`, !!action && ((await stateOf('input_text.probe')) === `nach Frage ${answer}`) === runs, { action, probe: await stateOf('input_text.probe') });
  await del(r.id);
}
if (!skip('warten')) {
  await svc('input_text', 'set_value', { entity_id: 'input_text.probe', value: '-' });
  const t0 = Date.now();
  const p = ws.call({ type: 'house_rules/rule/run_actions', rule: { name: 'A warten', when: [{ subject: G, verb: 'turns_on' }], then: [{ subject: 'wait', verb: 'wait', for: '2s' }, PROBE('gewartet')], options: { manual_pause: '' } } });
  await until(async () => (await stateOf('input_text.probe')) === 'gewartet', 5000, 100);
  await p;
  const dt = Date.now() - t0;
  cell(`warten 2 Sek. (${dt} ms)`, dt >= 1900 && dt < 4500 && (await stateOf('input_text.probe')) === 'gewartet');
}
if (!skip('warten bis leer')) {
  await svc('input_text', 'set_value', { entity_id: 'input_text.probe', value: '-' });
  await set(M, 'off');
  const empty0 = await until(async () => !(await occupied(R.Wohnzimmer)), 8000, 300);
  const r = await save({ name: 'T bis leer', type: 'when', when: [{ subject: `room:${R.Wohnzimmer}`, verb: 'entered' }], then: [{ subject: 'wait', verb: 'wait_until_empty' }, PROBE('leer')], options: { manual_pause: '' } });
  await sleep(300);
  await set(M, 'on');
  await sleep(1500);
  const early = await stateOf('input_text.probe');
  const occ = (await snapshot()).occupancy?.[R.Wohnzimmer];
  await set(M, 'off');
  cell('warten bis der Raum leer ist', early === '-' && (await until(async () => (await stateOf('input_text.probe')) === 'leer', 8000)), { early, empty0, occ, h: await hist(4) });
  await del(r.id);
}
if (!skip('Regel starten')) {
  const b = await save({ name: 'T Ziel', type: 'when', when: [{ subject: G, verb: 'turns_on' }], then: [PROBE('Ziel')], options: { manual_pause: '' } });
  const n = count(b.id);
  await act('andere Regel ausführen', { subject: `rule:${b.id}`, verb: 'run' }, async () => count(b.id) > n);
  await act('andere Regel pausieren', { subject: `rule:${b.id}`, verb: 'pause', for: '1h' }, async () => !!(await snapshot()).rules.find((x) => x.id === b.id)?.paused_until);
  await del(b.id);
}

// ================================================================ robustness
section('Robustheit');
if (!skip('Schleife')) {
  // two rules that undo each other: must not switch back and forth forever
  await set(S, 'off');
  const a = await save({ name: 'T an→aus', type: 'when', when: [{ subject: S, verb: 'turns_on' }], then: [{ subject: S, verb: 'turn_off' }], options: { manual_pause: '' } });
  const b = await save({ name: 'T aus→an', type: 'when', when: [{ subject: S, verb: 'turns_off' }], then: [{ subject: S, verb: 'turn_on' }], options: { manual_pause: '' } });
  await sleep(300);
  await set(S, 'on');
  await sleep(6000);
  const n1 = count(a.id) + count(b.id);
  await sleep(3000);
  const n2 = count(a.id) + count(b.id);
  cell(`zwei Regeln heben sich auf → keine Endlosschleife (${n1} → ${n2} Läufe)`, n2 === n1 && n1 < 30, { n1, n2, h: await hist(3) });
  await del(a.id);
  await del(b.id);
  await set(S, 'off');
}
if (!skip('gleiches Gerät')) {
  // a "while" rule and a "when" rule on one lamp: the while rule's end puts back what was before it, the
  // when rule's change by a rule is not taken for a change by hand
  await set(L, 'off', { latency: 0.6 });
  const w = await save({ name: 'T solange', type: 'while', when: [{ subject: G, verb: 'is_on' }], then: [{ subject: L, verb: 'turn_on' }], options: { manual_pause: '' } });
  const d = await save({ name: 'T dimmen', type: 'when', when: [{ subject: P, verb: 'occupied' }], then: [{ subject: L, verb: 'dim', brightness: 20 }], options: { manual_pause: '' } });
  await set(G, 'on');
  await until(async () => (await stateOf(L)) === 'on', 4000);
  await set(P, 'on');
  await sleep(1500);
  await set(G, 'off');
  const off = await until(async () => (await stateOf(L)) === 'off', 5000);
  cell('Solange-Regel und Wenn-Regel auf einer Lampe: Ende stellt zurück (aus)', off, await hist(5));
  await del(w.id);
  await del(d.id);
  await set(P, 'off');
  await set(L, 'off', { latency: 0 });
}
if (!skip('schnell')) {
  await set(L, 'off', { latency: 0.4 });
  const r = await save({ name: 'T schnell', type: 'while', when: [{ subject: M, verb: 'is_active' }], then: [{ subject: L, verb: 'turn_on' }], options: { manual_pause: '' } });
  await sleep(300);
  for (let i = 0; i < 10; i++) {
    await set(M, i % 2 ? 'off' : 'on');
    await sleep(120);
  }
  await set(M, 'off');
  const off = await until(async () => (await stateOf(L)) === 'off', 6000);
  await sleep(1500);
  cell('Bewegung 10× in 1 Sek. an/aus → am Ende aus, kein Hängenbleiben', off && (await stateOf(L)) === 'off', await hist(4));
  await del(r.id);
  await set(L, 'off', { latency: 0 });
}
if (!skip('kurz nicht erreichbar')) {
  // a Zigbee motion sensor drops off the network for a moment while someone is in the room: the light stays on
  const r = await save({ name: 'T Melder weg', type: 'while', when: [{ subject: M, verb: 'is_active' }], then: [{ subject: L, verb: 'turn_on' }], options: { manual_pause: '' } });
  await set(M, 'on');
  await until(async () => (await stateOf(L)) === 'on', 4000);
  await set(M, 'unavailable');
  await sleep(2500);
  const kept = (await stateOf(L)) === 'on';
  const mState = await stateOf(M);
  await set(M, 'on');
  await sleep(500);
  await set(M, 'off');
  const off = await until(async () => (await stateOf(L)) === 'off', 5000);
  cell('Solange: Melder kurz nicht erreichbar → Licht bleibt an, danach normal aus', kept && off, { kept, off, mState, h: await hist(4) });
  await del(r.id);
  await set(M, 'off');
}
if (!skip('meldet spät')) {
  // a lamp (cloud bulb / long transition) reports more than 5 s after the call: still the rule's switching, not by hand
  await set(L, 'off', { latency: 6.5 });
  await ws.call({ type: 'house_rules/rule/run_actions', rule: { name: 'A spät', when: [{ subject: G, verb: 'turns_on' }], then: [{ subject: L, verb: 'turn_on' }], options: { manual_pause: '' } } });
  await until(async () => (await stateOf(L)) === 'on', 9000);
  await sleep(500);
  const h = await ws.call({ type: 'house_rules/history', limit: 6 });
  const manual = h.find((e) => e.kind === 'manual' && /Kleines Licht/.test(e.what) && Date.now() - Date.parse(e.at) < 15000);
  cell('Lampe meldet erst nach 6,5 Sek. → nicht „von Hand“', !manual, manual ?? h.slice(0, 3));
  await set(L, 'off', { latency: 0 });
}
if (!skip('Thermostat spät')) {
  await set(C, 'heat', { temperature: 20, latency: 6.5 });
  await ws.call({ type: 'house_rules/rule/run_actions', rule: { name: 'A Thermostat', when: [{ subject: G, verb: 'turns_on' }], then: [{ subject: C, verb: 'set_temp', temperature: 23 }], options: { manual_pause: '' } } });
  await until(async () => (await st(C)).attributes.temperature === 23, 10000);
  await sleep(500);
  const h = await ws.call({ type: 'house_rules/history', limit: 6 });
  const manual = h.find((e) => e.kind === 'manual' && /Heizung Büro/.test(e.what));
  cell('Thermostat meldet die Zieltemperatur erst nach 6,5 Sek. → nicht „von Hand“', !manual, manual ?? h.slice(0, 3));
  await set(C, 'heat', { temperature: 20, latency: 0 });
}
if (!skip('bearbeitet')) {
  // a running "while" rule is edited: afterwards its end still puts back the state from before it (off)
  await set(L, 'off', { latency: 1 });
  const r = await save({ name: 'T bearbeitet', type: 'while', when: [{ subject: G, verb: 'is_on' }], then: [{ subject: L, verb: 'turn_on' }], options: { manual_pause: '' } });
  await set(G, 'on');
  await until(async () => (await stateOf(L)) === 'on', 4000);
  await sleep(500);
  await save({ ...r, name: 'T bearbeitet (neu)' });
  const back = await until(async () => (await stateOf(L)) === 'on' && (await snapshot()).rules.find((x) => x.id === r.id)?.name === 'T bearbeitet (neu)', 6000);
  await sleep(2500);
  await set(G, 'off');
  const off = await until(async () => (await stateOf(L)) === 'off', 6000);
  cell('Solange-Regel während sie gilt bearbeitet → danach Ende stellt richtig zurück (aus)', back && off, { back, off, h: await hist(5) });
  await del(r.id);
  await set(G, 'off');
  await set(L, 'off', { latency: 0 });
}
if (!skip('Entitäts-ID')) {
  // a long rule name: its switch entity is cut to a valid id (Home Assistant rejects one that ends in "_")
  const r = await save({ name: 'T Auslöser Personen, Tracker, Fahrzeug jemand kommt heim (alle Personen)', type: 'when', when: [{ subject: G, verb: 'turns_on' }], then: [PROBE('id')] });
  const sw = await until(async () => (await api('GET', '/api/states')).body.find((x) => x.entity_id.startsWith('switch.hausregel_t_ausloser_personen')), 5000);
  cell(`Schalter der Regel mit langem Namen: gültige Entitäts-ID (${sw?.entity_id})`, sw && /^switch\.[a-z0-9_]*[a-z0-9]$/.test(sw.entity_id));
  await del(r.id);
}
if (!skip('Registry warten')) {
  // "light on, wait, light off": a registry change in the middle of the wait must not cut the run off
  await svc('input_text', 'set_value', { entity_id: 'input_text.probe', value: '-' });
  const r = await save({ name: 'T Registry warten', type: 'when', when: [{ subject: G, verb: 'turns_on' }], then: [{ subject: 'wait', verb: 'wait', for: '6s' }, PROBE('nach Warten')], options: { manual_pause: '' } });
  await sleep(4000); // (the new rule's own switch is a registry change too: let it settle first)
  await set(G, 'on');
  await sleep(1000);
  await ws.call({ type: 'config/entity_registry/update', entity_id: 'sensor.lux_flur', name: 'Helligkeit Flur Y' });
  cell('Wenn-Regel wartet, dabei Registry-Änderung → läuft zu Ende', await until(async () => (await stateOf('input_text.probe')) === 'nach Warten', 12000), await hist(3));
  await ws.call({ type: 'config/entity_registry/update', entity_id: 'sensor.lux_flur', name: null });
  await del(r.id);
  await set(G, 'off');
}
if (!skip('Registry')) {
  // HA rebuilds the registries (an integration reconnects): a running "länger als" goes on
  await set(S, 'off');
  const r = await save({ name: 'T Registry', type: 'when', when: [{ subject: S, verb: 'on_for', for: '6s' }], then: [PROBE('reg')], options: { manual_pause: '' } });
  await sleep(300);
  const t0 = Date.now();
  await set(S, 'on');
  await sleep(1000);
  await ws.call({ type: 'config/entity_registry/update', entity_id: 'sensor.lux_flur', name: 'Helligkeit Flur X' });
  const hit = await until(() => count(r.id) > 0, 12000, 100);
  const dt = Date.now() - t0;
  cell(`„länger als 6 Sek.“ während einer Registry-Änderung (${dt} ms)`, hit && dt < 8500, dt);
  await ws.call({ type: 'config/entity_registry/update', entity_id: 'sensor.lux_flur', name: null });
  await del(r.id);
  await set(S, 'off');
}

// ================================================================ the clock
section('Auslöser Zeit');
if (atRule) {
  const n = await until(() => count(atRule.id) > 0, Math.max(1000, 160000 - (Date.now() - atStart)), 500);
  cell(`um ${atTime} Uhr`, n, await hist(3));
  await del(atRule.id);
}

// ================================================================ restart in the middle of a timed step
if (!process.argv.includes('--no-restart') && !skip('Neustart')) {
  section('Neustart');
  // "turn on for 60 s": the helper keeps its state over a restart, the step's "afterwards back" must survive it too
  await svc('input_boolean', 'turn_off', { entity_id: 'input_boolean.besuch' });
  await ws.call({ type: 'house_rules/rule/run_actions', rule: { name: 'A für 60 Sek.', when: [{ subject: G, verb: 'turns_on' }], then: [{ subject: 'input_boolean.besuch', verb: 'turn_on', for: '60s' }], options: { manual_pause: '' } } });
  const t0 = Date.now();
  ok((await stateOf('input_boolean.besuch')) === 'on', 'vorher an (für 60 Sek.)');
  await sleep(17000);
  await api('POST', '/api/services/homeassistant/restart', {});
  await sleep(8000);
  await until(async () => (await fetch('http://127.0.0.1:8124/api/').catch(() => null))?.status === 401, 120000, 1000);
  ws.close();
  ws = await wsConnect(tok);
  await until(async () => (await ws.call({ type: 'house_rules/info' }).catch(() => null))?.loaded, 90000, 1000);
  const off = await until(async () => (await stateOf('input_boolean.besuch')) === 'off', Math.max(5000, 90000 - (Date.now() - t0)), 1000);
  cell(`„für 60 Sek.“ über einen Neustart: danach wieder aus (${Math.round((Date.now() - t0) / 1000)} Sek.)`, off, await stateOf('input_boolean.besuch'));
}

// ================================================================ end
await reset().catch(() => null);
for (const [r, v] of Object.entries(rooms0)) if (r === R.Flur || r === R.Wohnzimmer) await ws.call({ type: 'house_rules/room/save', room: { id: r, empty_after: v ?? 5 } }).catch(() => null);
if (features0) await ws.call({ type: 'house_rules/features/set', features: features0 }).catch(() => null);
await ws.call({ type: 'house_rules/settings/set', settings: { persons_excluded: excluded0 } }).catch(() => null);
const byGroup = {};
for (const c of cells) {
  byGroup[c.group] ??= { n: 0, ok: 0 };
  byGroup[c.group].n++;
  if (c.ok) byGroup[c.group].ok++;
}
console.log('\nMatrix:');
for (const [g, v] of Object.entries(byGroup)) console.log(`  ${g.padEnd(52)} ${v.ok}/${v.n}`);
console.log(`  ${'gesamt'.padEnd(52)} ${cells.filter((c) => c.ok).length}/${cells.length}`);
const bad = cells.filter((c) => !c.ok);
if (bad.length) console.log('\nfehlgeschlagen:\n' + bad.map((c) => `  [${c.group}] ${c.name}`).join('\n'));
console.log(`\n${failures() ? `${failures()} FEHLER` : 'alles ok'}`);
ws.close();
process.exit(failures() ? 1 : 0);
