// Light plan details against the isolated test Home Assistant (port 8124), in the room "Diele" of hr_fake (a
// presence sensor, two door contacts, a light sensor that can report late, a night light that can be red):
//   * "nobody there any more → dim" keeps the colour and never makes a lamp brighter
//   * users set up as automations (Node-RED, AppDaemon …) are no person: no "by hand" pause
//   * "door opens → room briefly occupied"
//   * the dark signal: lux with hysteresis, only while the lights are off, sun, evening window
//   * "the last of several doors closes and someone is in the room" as a trigger, without waiting for lux
// Usage: node tools/testha/test-lightplan.mjs [--only name]
import { token, wsConnect, rest, sleep, ok, failures, until } from './lib.mjs';

const tok = await token();
const ws = await wsConnect(tok);
const api = rest(tok);
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const st = async (e) => (await api('GET', `/api/states/${e}`)).body;
const set = (entity_id, state, attributes = {}) => ws.call({ type: 'hr_fake/set', entity_id, state, attributes });
const snap = () => ws.call({ type: 'house_rules/snapshot' });
const hist = async (n = 8) => (await ws.call({ type: 'house_rules/history', limit: n })).map((h) => `${h.what} | ${h.why}`);
const LAMP = 'light.nachtlicht_diele';
const PRES = 'binary_sensor.praesenz_diele';
const DOOR_A = 'binary_sensor.zimmertuer_diele_a';
const DOOR_B = 'binary_sensor.zimmertuer_diele_b';
const LUX = 'sensor.lux_diele';

// ---------------------------------------------------------------- setup (idempotent)
let info = await ws.call({ type: 'house_rules/info' }).catch(() => null);
if (!info?.loaded) {
  const flow = await api('POST', '/api/config/config_entries/flow', { handler: 'house_rules' });
  await api('POST', `/api/config/config_entries/flow/${flow.body.flow_id}`, {});
  info = await until(async () => {
    const i = await ws.call({ type: 'house_rules/info' }).catch(() => null);
    return i?.loaded && i;
  }, 60000, 1000);
}
ok(info?.loaded, `integration läuft (${info?.version})`);
await until(async () => (await snap()).devices.some((d) => d.entity_id === LAMP), 90000, 1000);
const areas = await ws.call({ type: 'config/area_registry/list' });
const area = (areas.find((a) => a.name === 'Diele') ?? (await ws.call({ type: 'config/area_registry/create', name: 'Diele' }))).area_id;
for (const e of [LAMP, PRES, DOOR_A, DOOR_B, LUX]) await ws.call({ type: 'config/entity_registry/update', entity_id: e, area_id: area });
await ws.call({ type: 'house_rules/features/set', features: { light: true } });
const room = await until(async () => (await snap()).rooms.find((r) => r.name === 'Diele' && r.doors.length === 2 && r.lux === LUX), 20000, 500);
ok(!!room, 'Raum „Diele“ mit 2 Türen und Lichtsensor', (await snap()).rooms.find((r) => r.name === 'Diele'));
await ws.call({ type: 'house_rules/mode/set', mode: 'home' });
// in the start-up phase changes by others do not count as "by hand" yet (core.starting)
await until(async () => (await snap()).starting === false, 150000, 1000);
const alarm0 = (await snap()).alarm;
if (alarm0 && alarm0.state !== 'disarmed') {
  await ws.call({ type: 'house_rules/alarm/config', config: { confirm: 'none' } }).catch(() => null);
  await ws.call({ type: 'house_rules/alarm/disarm' }).catch(() => null);
}
const ROOM0 = { id: room.id, presence: [PRES], doors: [DOOR_A, DOOR_B], lux: LUX, empty_after: 0.05, door_logic: false, door_pulse: [], door_pulse_for: 30, dark_below: 50, dark: { sun: null, from: '', to: '', margin: 50, bright_for: 0, lux_when: 'lights_off' } };
const saveRoom = (patch = {}) => ws.call({ type: 'house_rules/room/save', room: { ...ROOM0, ...patch, dark: { ...ROOM0.dark, ...(patch.dark ?? {}) } } });
const base = { enabled: true, trigger: [], when: [], lights: [LAMP], variants: [], after: 'others', empty_after: 'off', follow_empty: false, own_end: { delay: 0, dim: 0, dim_for: 0 } };
const plan = async (rules, extra = {}) => {
  const cur = (await snap()).plans.light[room.id];
  return ws.call({ type: 'house_rules/plan/set', kind: 'light', room: room.id, plan: { ...cur, on: true, manual: 'none', empty: { mode: 'keep', delay: 0, dim: 10, dim_for: 0 }, smart: { ...(cur.smart ?? {}), mode: 'off' }, rules, ...extra } });
};
const occ = async () => (await snap()).occupancy[room.id] ?? {};
const reset = async () => {
  await plan([], { on: false });
  await saveRoom();
  for (const e of [PRES, DOOR_A, DOOR_B]) await set(e, 'off');
  await set(LUX, '500');
  await set(LAMP, 'off', { latency: 0 });
  await until(async () => !(await occ()).occupied, 10000);
};

async function test(name, fn) {
  if (only && !name.includes(only)) return;
  console.log(`\n▶ ${name}`);
  try {
    await reset();
    await fn();
  } catch (e) {
    ok(false, `${name}: ${e.message}`);
  }
}

// ---------------------------------------------------------------- 1. dimming keeps the colour
await test('Dimmen behält die Farbe und wird nie heller', async () => {
  await plan([], { empty: { mode: 'dim', delay: 0, dim: 30, dim_for: 0 } });
  await set(PRES, 'on');
  await set(LAMP, 'on', { brightness: 200, hs_color: [0, 100] });
  await sleep(800);
  await set(PRES, 'off');
  const dim = await until(async () => {
    const s = await st(LAMP);
    return s.attributes.brightness < 100 && s;
  }, 10000);
  ok(dim && Math.abs(dim.attributes.brightness - 77) <= 2, 'leer → auf 30 % gedimmt', dim?.attributes);
  ok(dim?.attributes.color_mode === 'hs' && dim.attributes.hs_color?.[0] === 0 && dim.attributes.hs_color?.[1] === 100, 'Farbe bleibt rot (kein Warmweiß)', dim?.attributes);
  // a red night light at 4 %: dimming to 30 % would be brighter → stays as it is
  await set(LAMP, 'on', { brightness: 10, hs_color: [0, 100] });
  await sleep(2500);
  const s = await st(LAMP);
  ok(s.state === 'on' && s.attributes.brightness === 10 && s.attributes.color_mode === 'hs' && s.attributes.hs_color?.[0] === 0, 'rotes Nachtlicht 4 %: bleibt 4 % rot', s.attributes);
  // a while rule that ended dims in the same way (someone in the room: the room's own "dim" stays out of it)
  await set(PRES, 'on');
  await plan([{ ...base, id: 'lp_w', name: 'Solange Tür A offen', kind: 'while', when: [{ subject: DOOR_A, verb: 'is_open' }], action: { mode: 'on', brightness: 90, color: '#ff0000' }, own_end: { delay: 0, dim: 20, dim_for: 0 } }]);
  await set(DOOR_A, 'on');
  ok(await until(async () => (await st(LAMP)).attributes.brightness > 200, 6000), 'Solange-Regel: rot 90 %', (await st(LAMP)).attributes);
  await set(DOOR_A, 'off');
  const end = await until(async () => {
    const x = await st(LAMP);
    return x.attributes.brightness < 100 && x;
  }, 8000);
  ok(end && Math.abs(end.attributes.brightness - 51) <= 2 && end.attributes.color_mode === 'hs' && end.attributes.hs_color?.[0] === 0, 'Regel vorbei: auf 20 % gedimmt, bleibt rot', end?.attributes);
});

// ---------------------------------------------------------------- 2. users that are automations
await test('Node-RED-Benutzer zählt als Automation, nicht von Hand', async () => {
  const users = await ws.call({ type: 'config/auth/list' });
  // like the Node-RED login: an admin user (only admins may switch every light)
  const nr = users.find((u) => u.name === 'Node-RED Test') ?? (await ws.call({ type: 'config/auth/create', name: 'Node-RED Test', group_ids: ['system-admin'] })).user;
  if (!nr.group_ids?.includes('system-admin')) await ws.call({ type: 'config/auth/update', user_id: nr.id, group_ids: ['system-admin'] });
  await ws.call({ type: 'house_rules/settings/set', settings: { automation_users: {} } });
  const roles = await ws.call({ type: 'house_rules/roles/get' });
  const au = roles.automation_users?.find((u) => u.id === nr.id);
  ok(au?.suggested && au.automation, 'Vorschlag: „Node-RED Test“ ist eine Automation', au);
  ok(roles.users?.some((u) => u.id === nr.id), 'steht auch in der Rollen-Liste', roles.users);
  await plan([{ ...base, id: 'lp_on', name: 'Betreten an', kind: 'when', trigger: [{ subject: `room:${room.id}`, verb: 'is_occupied' }], action: { mode: 'on', brightness: 60, color: 'warm' } }], { manual: '30m' });
  await set(PRES, 'on');
  ok(await until(async () => (await st(LAMP)).state === 'on', 6000), 'betreten → an');
  await sleep(600);
  await ws.call({ type: 'hr_fake/call_as', user_id: nr.id, domain: 'light', service: 'turn_off', data: { entity_id: LAMP } });
  ok(await until(async () => (await st(LAMP)).state === 'on', 6000), 'Node-RED schaltet aus → der Plan stellt es zurück (keine Hand-Pause)');
  const pl = (await snap()).plans.now?.[room.id]?.light;
  ok(Array.isArray(pl?.held) && !pl.held.includes(LAMP), 'nicht „von Hand“ gehalten', pl);
  const h = await hist(12);
  ok(h.some((x) => /Node-RED Test \(als Automation eingestellt\)/.test(x)), 'Verlauf: durch Node-RED (Automation), nicht von Hand', h);
  // switched off: this user counts as a person again
  await ws.call({ type: 'house_rules/settings/set', settings: { automation_users: { [nr.id]: false } } });
  const au2 = (await ws.call({ type: 'house_rules/roles/get' })).automation_users?.find((u) => u.id === nr.id);
  ok(au2 && !au2.automation && au2.suggested, 'eigene Wahl: keine Automation', au2);
  await sleep(600);
  await ws.call({ type: 'hr_fake/call_as', user_id: nr.id, domain: 'light', service: 'turn_off', data: { entity_id: LAMP } });
  await sleep(2500);
  ok((await st(LAMP)).state === 'off', 'als Person: bleibt aus (von Hand, 30 Min. Pause)');
  ok(((await snap()).plans.now?.[room.id]?.light?.held ?? []).includes(LAMP), 'von Hand gehalten');
  await ws.call({ type: 'house_rules/settings/set', settings: { automation_users: {} } });
});

await test('Lampe wieder erreichbar: zählt nicht als von Hand, wie vor dem Ausfall', async () => {
  await plan([], { manual: '30m' });
  ok((await st(LAMP)).state === 'off', 'vorher aus');
  await set(LAMP, 'unavailable');
  ok(await until(async () => (await st(LAMP)).state === 'unavailable', 4000), 'nicht erreichbar');
  // a power cut: the lamp comes back and switches itself on (its own power-on behaviour)
  await set(LAMP, 'on', { brightness: 255, latency: 0 });
  ok(await until(async () => (await st(LAMP)).state === 'off', 8000), 'wieder erreichbar und von selbst an → der Plan stellt „aus“ wie vor dem Ausfall her', await hist(6));
  ok(!((await snap()).plans.now?.[room.id]?.light?.held ?? []).includes(LAMP), 'nicht „von Hand“ gehalten');
});

// ---------------------------------------------------------------- 3. door opens → briefly occupied
await test('Tür öffnet → Raum kurz belegt', async () => {
  await saveRoom({ door_pulse: [DOOR_A], door_pulse_for: 3, empty_after: 1 });
  await plan([{ ...base, id: 'lp_on', name: 'Betreten an', kind: 'when', trigger: [{ subject: `room:${room.id}`, verb: 'entered' }], action: { mode: 'on', brightness: 60, color: 'warm' } }], { empty: { mode: 'off', delay: 0, dim: 10, dim_for: 0 } });
  await sleep(500);
  ok((await st(LAMP)).state === 'off', 'vorher aus');
  await set(DOOR_A, 'on');
  const o = await until(async () => (await occ()).occupied && (await occ()), 3000, 100);
  ok(o?.by === 'Tür geöffnet' || o?.by === 'Door opened', 'Tür auf → Raum belegt (Tür geöffnet)', o);
  ok(await until(async () => (await st(LAMP)).state === 'on', 3000, 100), 'Licht schon an, bevor der Sensor jemanden sieht');
  // nobody came: empty again right after the 3 s (not after "empty after" 1 min)
  ok(await until(async () => !(await occ()).occupied, 6000), 'niemand kam → nach 3 Sek. gleich wieder leer');
  ok(await until(async () => (await st(LAMP)).state === 'off', 4000), 'und das Licht wieder aus');
  // someone comes in: then the usual "empty after"
  await set(DOOR_A, 'off');
  await sleep(300);
  await set(DOOR_A, 'on');
  await sleep(800);
  await set(PRES, 'on');
  await sleep(300);
  await set(PRES, 'off');
  await sleep(4500);
  ok((await occ()).occupied, 'jemand kam herein: Raum bleibt nach dem Vorlauf belegt (Leer nach 1 Min.)', await occ());
  ok((await snap()).rooms.find((r) => r.id === room.id)?.door_pulse?.includes(DOOR_A), 'Einstellung im Raum gespeichert');
});

// ---------------------------------------------------------------- 4. the dark signal
await test('Dunkel-Signal mit Hysterese, Eigenlicht, Sonne, Abendfenster', async () => {
  await saveRoom({ dark: { bright_for: 0.1 } }); // bright again after 6 s
  await set(LUX, '10');
  ok(await until(async () => (await occ()).dark === true, 3000), '10 lx → dunkel', await occ());
  ok((await occ()).dark_why?.includes('lux'), 'Grund: Lichtsensor', await occ());
  await set(LUX, '60');
  await sleep(1500);
  ok((await occ()).dark === true, '60 lx (über 50, unter 75) → bleibt dunkel (Hysterese)', await occ());
  await set(LUX, '200');
  await sleep(2000);
  ok((await occ()).dark === true, '200 lx: erst 2 Sek. hell → noch dunkel', await occ());
  ok(await until(async () => (await occ()).dark === false, 70000, 500), '200 lx seit 6 Sek. → hell', await occ());
  // a light rule asks "dark?": in the hysteresis zone it still counts as dark
  await set(LUX, '10');
  await until(async () => (await occ()).dark === true, 3000);
  await set(LUX, '60');
  await plan([{ ...base, id: 'lp_d', name: 'Betreten, nur wenn dunkel', kind: 'when', trigger: [{ subject: `room:${room.id}`, verb: 'is_occupied' }], when: [{ subject: `room:${room.id}`, verb: 'is_dark' }], action: { mode: 'on', brightness: 70, color: 'warm' } }]);
  await set(PRES, 'on');
  ok(await until(async () => (await st(LAMP)).state === 'on', 5000), 'Lichtregel „nur wenn dunkel“ bei 60 lx (gerade noch dunkel) → an');
  // own light: while the lamp is on, a high lux value says nothing
  await set(LUX, '500');
  await sleep(8000);
  ok((await occ()).dark === true, 'Licht an, 500 lx (Eigenlicht) → bleibt dunkel', await occ());
  await plan([], { on: false });
  await set(LAMP, 'off');
  await set(LUX, '480');
  ok(await until(async () => (await occ()).dark === false, 70000, 500), 'Licht aus, weiter hell → nach 6 Sek. hell', await occ());
  // "always": the lux value counts also with the light on (then only the hysteresis protects)
  await saveRoom({ dark: { bright_for: 0.1, lux_when: 'always' } });
  await set(LAMP, 'on', { brightness: 200 });
  await set(LUX, '20');
  ok(await until(async () => (await occ()).dark === true, 3000), '„immer“: Licht an, 20 lx → dunkel');
  await set(LAMP, 'off');
  // sun: a limit above the sun right now → dark because of the sun
  await set(LUX, '500');
  const elev = Number((await st('sun.sun')).attributes?.elevation ?? 0);
  const limit = Math.min(30, Math.ceil(elev) + 2);
  await saveRoom({ dark: { sun: limit, bright_for: 0.1 } });
  ok(elev > 28 || (await until(async () => (await occ()).dark === true && (await occ()).dark_why?.includes('sun'), 3000)), `Sonne (${elev.toFixed(1)}°) unter ${limit}° → dunkel (Grund Sonne)`, await occ());
  // evening window around now → dark, whatever the lux sensor says
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  const hh = (x) => `${String((x + 24) % 24).padStart(2, '0')}:00`;
  await saveRoom({ dark: { from: hh(h - 1), to: hh(h + 1), bright_for: 0.1 } });
  ok(await until(async () => (await occ()).dark_why?.includes('time'), 3000), 'Zeitfenster jetzt → dunkel (Grund Uhrzeit)', await occ());
  const r = (await snap()).rooms.find((x) => x.id === room.id);
  ok(r?.dark?.from === hh(h - 1) && r.dark.sun === null && r.dark.margin === 50, 'Dunkel-Einstellungen gespeichert', r?.dark);
});

// ---------------------------------------------------------------- 5. the last of several doors closes, someone inside
await test('Letzte Tür zu und jemand im Raum → Licht sofort an (ohne Lux)', async () => {
  await saveRoom({ empty_after: 1 });
  const rules = [
    { ...base, id: 'lp_doors', name: 'Alle Türen zu, jemand da', kind: 'when', trigger: [{ subject: `all:door@${room.id}`, verb: 'closes' }], when: [{ subject: `room:${room.id}`, verb: 'is_occupied' }], action: { mode: 'on', brightness: 80, color: 'warm' } },
  ];
  await plan(rules);
  await set(DOOR_A, 'on');
  await set(DOOR_B, 'on');
  await set(PRES, 'on');
  // the light sensor reports "dark" only 10 s later (like a slow Zigbee sensor)
  await set(LUX, '5', { latency: 10 });
  await sleep(1500);
  ok((await st(LAMP)).state === 'off', 'Türen offen → noch aus');
  await set(DOOR_A, 'off');
  await sleep(1500);
  ok((await st(LAMP)).state === 'off', 'erste Tür zu → noch aus');
  await set(DOOR_B, 'off');
  ok(await until(async () => (await st(LAMP)).state === 'on', 2500, 100), 'letzte Tür zu → sofort an (Lichtsensor meldet noch hell)');
  ok(Number((await st(LUX)).state) === 500, 'Lichtsensor hat noch nicht gemeldet');
  // nobody inside: closing every door does nothing (the plan saved again: the firing above is forgotten)
  await set(PRES, 'off');
  await saveRoom({ empty_after: 0.02 });
  await until(async () => !(await occ()).occupied, 8000);
  await plan(rules);
  await set(LAMP, 'off');
  await sleep(1000);
  ok((await st(LAMP)).state === 'off', 'Raum leer, Licht aus');
  await set(DOOR_A, 'on');
  await set(DOOR_B, 'on');
  await sleep(500);
  await set(DOOR_A, 'off');
  await set(DOOR_B, 'off');
  await sleep(2000);
  ok((await st(LAMP)).state === 'off', 'niemand im Raum → alle Türen zu schaltet nichts');
});

// ---------------------------------------------------------------- by hand while the room counts as empty
await test('Von Hand eingeschaltet, während der Raum leer scheint → bleibt an, bis betreten und verlassen', async () => {
  await plan([], { manual: 'room_empty', empty: { mode: 'off', delay: 0, dim: 10, dim_for: 0 } });
  ok(!(await occ()).occupied, 'Raum leer');
  // a person (this test user, like the app or Siri through HomeKit) switches it on while the sensor sees nobody
  await api('POST', '/api/services/light/turn_on', { entity_id: LAMP, brightness: 120 });
  ok(await until(async () => (await st(LAMP)).state === 'on', 4000), 'an');
  await sleep(4000);
  ok((await st(LAMP)).state === 'on', 'bleibt an, obwohl „niemand mehr da“ (vorher nach 0,3 s wieder aus)', await hist(6));
  ok(((await snap()).plans.now?.[room.id]?.light?.held ?? []).includes(LAMP), 'von Hand gehalten');
  await set(PRES, 'on');
  ok(await until(async () => (await occ()).occupied, 4000), 'betreten');
  await sleep(1000);
  ok((await st(LAMP)).state === 'on', 'im Raum: bleibt an');
  await set(PRES, 'off');
  ok(await until(async () => (await st(LAMP)).state === 'off', 15000), 'verlassen → niemand mehr da → aus', await hist(6));
});

await reset();
ws.close();
console.log(failures() ? `\n${failures()} Fehler` : '\nalles ok');
process.exit(failures() ? 1 : 0);
