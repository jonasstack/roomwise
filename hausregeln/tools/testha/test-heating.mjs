// Heating controller (heating.py) against the isolated test Home Assistant (port 8124), with short delays.
// Usage: node tools/testha/test-heating.mjs [--only name]   (run test-engine.mjs once before: it creates areas and persons)
import { token, wsConnect, rest, sleep, ok, failures, until } from './lib.mjs';

const tok = await token();
const ws = await wsConnect(tok);
const api = rest(tok);
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const set = (entity_id, state, attributes = {}) => ws.call({ type: 'hr_fake/set', entity_id, state, attributes });
const st = async (e) => (await api('GET', `/api/states/${e}`)).body;
const calls = (clear = false) => ws.call({ type: 'hr_fake/calls', clear });
const snapshot = () => ws.call({ type: 'house_rules/snapshot' });
const temp = async (e) => (await st(e)).attributes.temperature;
const hist = async (n = 6) => (await ws.call({ type: 'house_rules/history', limit: n })).map((h) => `${h.what} | ${h.why}`);

// ---------------------------------------------------------------- setup (idempotent)
const areas = await ws.call({ type: 'config/area_registry/list' });
const area = async (name) => (areas.find((a) => a.name === name) ?? (await ws.call({ type: 'config/area_registry/create', name }))).area_id;
const A = { kueche: await area('Küche'), bad: await area('Bad'), wohnzimmer: await area('Wohnzimmer'), buero: await area('Büro') };
const place = {
  kueche: ['binary_sensor.fenster_kueche', 'climate.heizung_kueche'],
  bad: ['binary_sensor.fenster_bad', 'climate.heizung_bad', 'sensor.temp_bad', 'sensor.feuchte_bad'],
  wohnzimmer: ['climate.heizung_wohnzimmer', 'sensor.temp_wohnzimmer', 'sensor.co2_wohnzimmer', 'binary_sensor.fenster_wohnzimmer'],
  buero: ['climate.heizung_buero'],
};
for (const [r, ents] of Object.entries(place)) for (const e of ents) await ws.call({ type: 'config/entity_registry/update', entity_id: e, area_id: A[r] }).catch((err) => console.log('area', e, err.message));
await api('POST', '/api/services/device_tracker/see', { dev_id: 'alex_handy', location_name: 'home' });
await until(async () => (await snapshot()).devices.some((d) => d.entity_id === 'climate.heizung_wohnzimmer' && d.room), 15000, 500);
// a new area becomes a room once Hausregeln rebuilds (3 s after the last registry change)
await until(async () => (await snapshot()).rooms.some((r) => r.name === 'Büro'), 15000, 500);
let snap = await snapshot();
const R = Object.fromEntries(['Küche', 'Bad', 'Wohnzimmer', 'Büro'].map((n) => [n, snap.rooms.find((r) => r.name === n)?.id]));
ok(R['Küche'] && R.Bad && R.Wohnzimmer && R['Büro'], 'Räume da', R);
await ws.call({ type: 'house_rules/mode/set', mode: 'home' });
await ws.call({ type: 'house_rules/features/set', features: { heating: true } }).catch(() => null);
for (const rule of snap.rules) await ws.call({ type: 'house_rules/rule/delete', rule_id: rule.id });
await ws.call({ type: 'house_rules/behaviour/set', behaviour: 'heat_eco_empty', on: false });
// messages count against the limits of notify.py (kept across runs): every run starts from zero
await ws.call({ type: 'house_rules/settings/set', settings: { notifications: { reset: true, quiet: { on: false } } } });
// in the start-up phase changes by others do not count as "by hand" yet (core.starting): the manual tests need it over
await until(async () => (await snapshot()).starting === false, 150000, 1000);

const GUARD0 = { max: 24, min: 15, occupied_min: 18, max_setback: 4, never: { on: false, from: '00:00', to: '05:00' } };
const G0 = { outside: 'sensor.temp_aussen', summer: { on: false, above: 18, hold: 0 }, demand: { on: false, entity: null, above: 20, min_on: 0, min_off: 0 }, exercise: { on: false, minutes: 0.05 }, notify: [], quiet: { on: false }, gap: 0, smart: { guard: GUARD0, energy: { kind: 'auto', meter: null, price: null }, airing: { morning: null, minutes: 10, rooms: [] } }, defaults: { window: { on: true, delay: 2, resume: 5, action: 'off', drop: false, drop_k: 1 }, smart: { style: 'comfort', building: 'unknown' } } };
const glob = (cfg) => ws.call({ type: 'house_rules/heating/set', config: cfg });
// local clock of the test HA (Europe/Berlin)
const hm = (offsetMin) => new Date(Date.now() + offsetMin * 60000).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
const ALLDAY = [{ from: '00:00', to: '23:59', days: 'all', level: 'comfort', temp: 21 }];
const base = (extra = {}) => ({
  on: true,
  thermostats: [],
  sensor: null,
  calibrate: 'off',
  temps: { comfort: 21, base: 18, eco: 17, night: 16, frost: 12 },
  blocks: ALLDAY,
  presence: { away: false, away_after: 0, empty: false, empty_after: 30, home_soon: false },
  sleep: true,
  guests: true,
  manual: 'next_block',
  manual_hours: 2,
  window: { on: true, contacts: [], extra: [], delay: 0.05, resume: 0.1, action: 'off', drop: false, drop_k: 1 },
  preheat: { on: false, max: 90 },
  vent: { on: false, times: [], humidity_on: true, humidity: 65, humidity_sensor: null, co2_on: true, co2: 1000, co2_sensor: null, mould: false, close: false, close_after: 0, wait: 0.02 },
  valves: { stuck: true },
  smart: { mode: 'schedule', style: 'comfort', shadow_days: 7, guard: {}, valve: { on: false }, ramp: { step: null, minutes: null } },
  ...extra,
});
const smart = (extra = {}) => ({ mode: 'smart', style: 'sport', shadow_days: 0, guard: {}, valve: { on: false }, ramp: { step: null, minutes: null }, ...extra });
const tst = (action, extra = {}) => ws.call({ type: 'house_rules/heating/test', action, ...extra });
const thermal = (x) => ws.call({ type: 'hr_fake/thermal', ...x });
const explain = (room) => ws.call({ type: 'house_rules/heating/explain', room });
const doH = (action, extra = {}) => ws.call({ type: 'house_rules/heating/do', action, ...extra });
// local times of the test HA (Europe/Berlin) as timestamps (seconds), for seeding habits
const BERLIN = 'Europe/Berlin';
const tzOff = (ms) => Date.parse(new Date(ms).toLocaleString('sv-SE', { timeZone: BERLIN }).replace(' ', 'T') + 'Z') - ms;
const localTs = (isoDay, minutes) => {
  const [y, mo, d] = isoDay.split('-').map(Number);
  const guess = Date.UTC(y, mo - 1, d, 0, 0) + minutes * 60000;
  return (guess - tzOff(guess)) / 1000;
};
const pastDays = (n) => [...Array(n)].map((_x, k) => new Date(Date.now() - (k + 1) * 86400000).toLocaleDateString('sv-SE', { timeZone: BERLIN }));
const weekday = (isoDay) => new Date(isoDay + 'T12:00:00Z').getUTCDay(); // 0 = Sunday
const nowMin = () => { const [h, m] = hm(0).split(':').map(Number); return h * 60 + m; };
const plan = (room, p) => ws.call({ type: 'house_rules/plan/set', kind: 'heat', room, plan: p });
const now = async (room) => (await snapshot()).plans.now[room].heat;

const reset = async () => {
  // everything back to a neutral plan (also for test-engine.mjs afterwards): off, no airing detection
  await tst('factor', { value: 1 });
  await thermal({ factor: 1, entity_id: 'climate.heizung_buero', on: false });
  for (const r of Object.values(R)) await plan(r, { on: false, sensor: null, calibrate: 'off', vent: { on: false }, window: { drop: false, contacts: [] }, smart: { mode: 'schedule', valve: { on: false }, guard: {} }, reset: ['comfort', 'temps', 'presence', 'modes', 'manual', 'window', 'vent', 'preheat', 'style', 'valve', 'building', 'shadow'] });
  for (const r of Object.values(R)) await doH('reset_learning', { room: r });
  await glob(G0);
  await set('number.heizung_buero_valve_opening_degree', '100');
  await set('number.heizung_buero_valve_closing_degree', '100');
  await set('climate.heizung_buero', 'heat', { temperature: 20, current_temperature: 20 });
  for (const [e, s] of [['binary_sensor.fenster_kueche', 'off'], ['binary_sensor.fenster_bad', 'off'], ['binary_sensor.fenster_wohnzimmer', 'off'], ['switch.heizkessel', 'off']]) await set(e, s);
  await set('climate.heizung_kueche', 'heat', { temperature: 20, current_temperature: 20, valve: 0, window_open: null, hvac_action: null });
  await set('climate.heizung_bad', 'heat', { temperature: 20, current_temperature: 20, valve: 0 });
  await set('climate.heizung_wohnzimmer', 'heat', { temperature: 20, current_temperature: 19 });
  await set('number.heizung_wohnzimmer_local_temperature_calibration', '0');
  await set('sensor.temp_aussen', '5');
  await set('sensor.temp_bad', '21');
  await set('sensor.feuchte_bad', '50');
  await set('sensor.co2_wohnzimmer', '600');
  await ws.call({ type: 'house_rules/mode/set', mode: 'home' });
  await calls(true);
};
const test = async (name, fn) => {
  if (only && !name.includes(only)) return;
  console.log(`\n# ${name}`);
  await reset();
  try {
    await fn();
  } catch (e) {
    ok(false, `${name}: ${e.message}`);
  }
};

// ---------------------------------------------------------------- tests
await test('Zeitblöcke, Grundtemperatur, Vorheizen', async () => {
  const bad = R.Bad;
  let v = await plan(bad, base({ blocks: [{ from: hm(-60), to: hm(60), days: 'all', level: 'comfort', temp: 21 }], temps: { comfort: 22, base: 18, eco: 17, night: 16, frost: 12 } }));
  ok(v.now[bad].heat.temp === 22 && v.now[bad].heat.level === 'comfort', 'Block jetzt: Komfort 22 °C', v.now[bad].heat);
  ok(await until(async () => (await temp('climate.heizung_bad')) === 22), 'Thermostat bekommt 22 °C', await hist());
  ok(/22\s°C Komfort bis/.test(v.now[bad].heat.line), 'Statuszeile: „22 °C Komfort bis …“', v.now[bad].heat.line);
  v = await plan(bad, base({ blocks: [{ from: hm(120), to: hm(180), days: 'all', level: 'comfort', temp: 21 }], temps: { comfort: 22, base: 18, eco: 17, night: 16, frost: 12 } }));
  ok(v.now[bad].heat.temp === 18 && v.now[bad].heat.level === 'base', 'außerhalb der Blöcke: Grundtemperatur 18 °C', v.now[bad].heat);
  ok(await until(async () => (await temp('climate.heizung_bad')) === 18), 'Thermostat bekommt 18 °C');
  // preheat: 20 °C now, 22 wanted, 1,5 °C/h estimated → 80 min lead; block in 60 min → preheat now
  v = await plan(bad, base({ blocks: [{ from: hm(60), to: hm(120), days: 'all', level: 'comfort', temp: 21 }], temps: { comfort: 22, base: 18, eco: 17, night: 16, frost: 12 }, preheat: { on: true, max: 120 } }));
  ok(v.now[bad].heat.temp === 22 && /vorheizen/.test(v.now[bad].heat.why), 'Vorheizen: schon jetzt 22 °C für den Block in 60 Min.', v.now[bad].heat);
  v = await plan(bad, base({ blocks: [{ from: hm(60), to: hm(120), days: 'all', level: 'comfort', temp: 21 }], temps: { comfort: 22, base: 18, eco: 17, night: 16, frost: 12 }, preheat: { on: true, max: 30 } }));
  ok(v.now[bad].heat.temp === 18, 'höchstens 30 Min. vorher: noch Grundtemperatur', v.now[bad].heat);
  // heat-up rate set by hand instead of learned: 4 °C/h → 2 °C take 30 min, the block in 60 min does not need preheating yet
  v = await plan(bad, base({ blocks: [{ from: hm(60), to: hm(120), days: 'all', level: 'comfort', temp: 21 }], temps: { comfort: 22, base: 18, eco: 17, night: 16, frost: 12 }, preheat: { on: true, max: 120, learn: false, rate: 4 } }));
  ok(v.now[bad].heat.temp === 18 && v.now[bad].heat.rate === 4 && !v.now[bad].heat.rate_learned, 'Aufheiztempo fest 4 °C/h: noch kein Vorheizen, nichts gelernt', v.now[bad].heat);
  v = await plan(bad, base({ blocks: [{ from: hm(60), to: hm(120), days: 'all', level: 'comfort', temp: 21 }], temps: { comfort: 22, base: 18, eco: 17, night: 16, frost: 12 }, preheat: { on: true, max: 120, learn: false, rate: 1 } }));
  ok(v.now[bad].heat.temp === 22 && v.now[bad].heat.rate === 1, 'Aufheiztempo fest 1 °C/h: schon jetzt vorheizen', v.now[bad].heat);
  v = await plan(bad, base({ blocks: [{ from: hm(-60), to: hm(60), days: 'all', level: 'custom', temp: 19.5 }] }));
  ok(v.now[bad].heat.temp === 19.5, 'eigene Temperatur im Block: 19,5 °C', v.now[bad].heat);
});

await test('Fenster: abwarten, Heizung aus, Luft beruhigen, weiter', async () => {
  const k = R['Küche'];
  await plan(k, base());
  ok(await until(async () => (await temp('climate.heizung_kueche')) === 21), 'Küche 21 °C');
  await set('binary_sensor.fenster_kueche', 'on');
  await sleep(1000);
  const w = await now(k);
  ok(w.window.state === 'waiting' && /wartet noch/.test(w.line), 'kurz offen: wartet (Statuszeile)', w.line);
  await set('binary_sensor.fenster_kueche', 'off');
  await sleep(4000);
  ok((await st('climate.heizung_kueche')).state === 'heat', 'nur kurz offen → nichts passiert');
  await set('binary_sensor.fenster_kueche', 'on');
  ok(await until(async () => (await st('climate.heizung_kueche')).state === 'off', 8000), 'länger offen (3 Sek.) → Heizung aus', await hist());
  ok(/offen seit .* → Heizung aus/.test((await now(k)).line), 'Statuszeile erklärt es', (await now(k)).line);
  await set('binary_sensor.fenster_kueche', 'off');
  await sleep(2000);
  const s2 = await now(k);
  ok((await st('climate.heizung_kueche')).state === 'off' && s2.window.state === 'settling', 'zu → wartet, bis sich die Luft beruhigt hat', s2.line);
  ok(await until(async () => { const c = await st('climate.heizung_kueche'); return c.state === 'heat' && c.attributes.temperature === 21; }, 10000), 'dann wieder 21 °C (aktuelles Ziel)', await hist());
  // frost instead of off
  await plan(k, base({ window: { ...base().window, action: 'frost' } }));
  await set('binary_sensor.fenster_kueche', 'on');
  ok(await until(async () => (await temp('climate.heizung_kueche')) === 12, 8000), 'Einstellung Frostschutz: 12 °C statt aus');
  await set('binary_sensor.fenster_kueche', 'off');
  ok(await until(async () => (await temp('climate.heizung_kueche')) === 21, 12000), 'und zurück');
});

await test('Thermostat mit eigener Fenstererkennung', async () => {
  const k = R['Küche'];
  await plan(k, base());
  ok(await until(async () => (await temp('climate.heizung_kueche')) === 21), 'Küche 21 °C');
  await set('climate.heizung_kueche', 'heat', { temperature: 5, window_open: true });
  await sleep(2500);
  ok((await temp('climate.heizung_kueche')) === 5, 'Thermostat senkt selbst ab → Hausregeln lässt es in Ruhe');
  const s = await now(k);
  ok(s.mode === 'hands_off' && /selbst/.test(s.line), 'Status: erkennt es selbst', s.line);
  await set('climate.heizung_kueche', 'heat', { temperature: 5, window_open: false });
  ok(await until(async () => (await temp('climate.heizung_kueche')) === 21, 8000), 'Fenster wieder zu (Thermostat) → 21 °C');
});

await test('Von Hand: bis zum nächsten Zeitwechsel / Stunden', async () => {
  const k = R['Küche'];
  await plan(k, base());
  ok(await until(async () => (await temp('climate.heizung_kueche')) === 21), 'Küche 21 °C');
  await set('climate.heizung_kueche', 'heat', { temperature: 24 }); // at the device
  await sleep(2500);
  const s = await now(k);
  ok((await temp('climate.heizung_kueche')) === 24 && s.level === 'manual', 'am Thermostat 24 °C → bleibt', s.line);
  ok((await hist(4)).some((h) => /von Hand 24\s°C/.test(h)), 'Verlauf: von Hand', await hist(4));
  await ws.call({ type: 'house_rules/heating/do', action: 'clear_manual', room: k });
  ok(await until(async () => (await temp('climate.heizung_kueche')) === 21), '„Zurück zum Plan“ → 21 °C');
  await plan(k, base({ manual: 'hours', manual_hours: 0.002 }));
  await api('POST', '/api/services/climate/set_temperature', { entity_id: 'climate.heizung_kueche', temperature: 23 }); // in the app
  await sleep(1500);
  ok((await temp('climate.heizung_kueche')) === 23, 'in der App 23 °C → bleibt erst');
  ok(await until(async () => (await temp('climate.heizung_kueche')) === 21, 15000), 'nach der eingestellten Zeit (7 Sek.) zurück');
  await plan(k, base({ manual: 'never' }));
  await set('climate.heizung_kueche', 'heat', { temperature: 25 });
  ok(await until(async () => (await temp('climate.heizung_kueche')) === 21, 6000), '„Gar nicht“: sofort zurück');
});

await test('Von Hand: intelligent (Hausmodus, Fenster, alle weg, Höchstdauer)', async () => {
  const k = R['Küche'];
  const appSet = (temperature) => api('POST', '/api/services/climate/set_temperature', { entity_id: 'climate.heizung_kueche', temperature });
  await plan(k, base({ manual: 'smart', manual_max: 4 }));
  ok(await until(async () => (await temp('climate.heizung_kueche')) === 21), 'Küche 21 °C');
  await appSet(23);
  ok(await until(async () => (await now(k)).level === 'manual'), 'in der App 23 °C → von Hand');
  let s = await now(k);
  ok(/^Küche: Von Hand 23\s°C bis /.test(s.line) && s.manual?.mode === 'home', 'Statuszeile „Von Hand 23 °C bis …“, merkt sich den Hausmodus', s.line);
  ok((await hist(4)).some((h) => /von Hand 23\s°C/.test(h) && /Hausmodus ändert/.test(h)), 'Verlauf: bleibt bis … oder bis sich der Hausmodus ändert', await hist(4));
  // a window: off while open, afterwards the value set by hand comes back
  await set('binary_sensor.fenster_kueche', 'on');
  ok(await until(async () => (await st('climate.heizung_kueche')).state === 'off', 8000), 'Fenster auf → aus');
  await set('binary_sensor.fenster_kueche', 'off');
  ok(await until(async () => { const c = await st('climate.heizung_kueche'); return c.state === 'heat' && c.attributes.temperature === 23; }, 20000), 'Fenster zu → wieder 23 °C von Hand', (await now(k)).line);
  s = await now(k);
  ok(s.level === 'manual' && s.mode === 'hands_off', 'danach wieder Finger weg (von Hand)', s);
  // the house mode changes → the plan again
  await ws.call({ type: 'house_rules/mode/set', mode: 'sleep' });
  ok(await until(async () => (await temp('climate.heizung_kueche')) === 16), 'Hausmodus Schlafen → endet, Nacht 16 °C', (await now(k)).line);
  ok((await hist(6)).some((h) => /zurück zum Plan/.test(h) && /Hausmodus ist jetzt „Schlafen“/.test(h)), 'Verlauf: Hausmodus ist jetzt „Schlafen“', await hist(6));
  await ws.call({ type: 'house_rules/mode/set', mode: 'home' });
  ok(await until(async () => (await temp('climate.heizung_kueche')) === 21), 'zurück → 21 °C');
  // everyone leaves → the plan again
  await appSet(22);
  ok(await until(async () => (await now(k)).level === 'manual'), 'in der App 22 °C → von Hand');
  await api('POST', '/api/services/device_tracker/see', { dev_id: 'alex_handy', location_name: 'not_home' });
  ok(await until(async () => (await temp('climate.heizung_kueche')) === 21, 10000), 'alle weg → endet, 21 °C', (await now(k)).line);
  // (an automatic house mode may switch to "Weg" first: that ends it just the same)
  ok((await hist(6)).some((h) => /Alle sind weg|Hausmodus ist jetzt „Weg“/.test(h)), 'Verlauf: Alle sind weg', await hist(6));
  await api('POST', '/api/services/device_tracker/see', { dev_id: 'alex_handy', location_name: 'home' });
  await ws.call({ type: 'house_rules/mode/set', mode: 'home' });
  // the safety limit (here 7 s)
  await plan(k, base({ manual: 'smart', manual_max: 0.002 }));
  await appSet(24);
  ok(await until(async () => (await now(k)).level === 'manual'), 'in der App 24 °C → von Hand');
  ok(/spätestens/.test((await now(k)).line), 'Statuszeile: bis spätestens …', (await now(k)).line);
  ok(await until(async () => (await temp('climate.heizung_kueche')) === 21, 15000), 'nach der Höchstdauer zurück → 21 °C');
  ok((await hist(4)).some((h) => /gilt wieder der Plan/.test(h)), 'Verlauf: nach … gilt wieder der Plan', await hist(4));
  // the next change of the time plan is shown as the end (comfort until in 2 min, then base)
  const to = hm(2);
  await plan(k, base({ manual: 'smart', manual_max: 4, blocks: [{ from: hm(-60), to, days: 'all', level: 'comfort', temp: 21 }] }));
  await appSet(23);
  ok(await until(async () => (await now(k)).level === 'manual'), 'in der App 23 °C → von Hand');
  ok(new RegExp(`bis ${to} \\(Absenken\\)`).test((await now(k)).line), `Statuszeile: bis ${to} (Absenken)`, (await now(k)).line);
});

await test('Von Hand: intelligent im lernenden Raum (Anwesenheit flackert)', async () => {
  const wz = R.Wohnzimmer;
  const room0 = (await snapshot()).rooms.find((r) => r.id === wz);
  await ws.call({ type: 'config/entity_registry/update', entity_id: 'binary_sensor.bewegung_wohnzimmer', area_id: A.wohnzimmer }).catch(() => null);
  await ws.call({ type: 'house_rules/room/save', room: { id: wz, empty_after: 0.02 } });
  ok(await until(async () => (await snapshot()).rooms.find((r) => r.id === wz)?.motion?.includes('binary_sensor.bewegung_wohnzimmer'), 15000, 500), 'Wohnzimmer hat einen Bewegungsmelder');
  await set('binary_sensor.bewegung_wohnzimmer', 'on');
  const pres = { away: false, away_after: 0, empty: true, empty_after: 0.05, home_soon: false };
  try {
    await plan(wz, base({ blocks: [], presence: pres, manual: 'smart', manual_max: 4, smart: smart({ style: 'comfort', ramp: { step: 0, minutes: 0 } }) }));
    ok(await until(async () => (await temp('climate.heizung_wohnzimmer')) === 21, 10000), 'jemand im Raum → 21 °C', (await now(wz)).line);
    await api('POST', '/api/services/climate/set_temperature', { entity_id: 'climate.heizung_wohnzimmer', temperature: 23 });
    ok(await until(async () => (await now(wz)).level === 'manual'), 'in der App 23 °C → von Hand');
    // presence flickers: empty (the plan would save after 3 s) and back – the value set by hand stays
    await set('binary_sensor.bewegung_wohnzimmer', 'off');
    await sleep(6000);
    let s = await now(wz);
    ok(s.level === 'manual' && (await temp('climate.heizung_wohnzimmer')) === 23, 'Raum kurz leer → bleibt 23 °C von Hand', s.line);
    await set('binary_sensor.bewegung_wohnzimmer', 'on');
    await sleep(2000);
    s = await now(wz);
    ok(s.level === 'manual' && (await temp('climate.heizung_wohnzimmer')) === 23, 'wieder jemand da → bleibt 23 °C von Hand', s.line);
    // empty for long (45 min; the smart heating runs 600× faster here: 4,5 s) → the plan again
    await tst('factor', { value: 600 });
    await set('binary_sensor.bewegung_wohnzimmer', 'off');
    ok(await until(async () => (await now(wz)).level !== 'manual', 20000), 'Raum lange leer → endet', (await now(wz)).line);
    ok((await hist(8)).some((h) => /Raum ist seit \d+ Min\. leer/.test(h)), 'Verlauf: Der Raum ist seit … leer', await hist(8));
  } finally {
    await tst('factor', { value: 1 });
    await set('binary_sensor.bewegung_wohnzimmer', 'off');
    await ws.call({ type: 'house_rules/room/save', room: { id: wz, empty_after: room0?.empty_after ?? 5 } });
  }
});

await test('Von Hand: übersteht einen Neustart, Person beim Start zählt', async () => {
  const k = R['Küche'];
  const bad = R.Bad;
  await plan(k, base({ manual: 'smart', manual_max: 4 }));
  await plan(bad, base({ manual: 'smart', manual_max: 4 }));
  ok(await until(async () => (await temp('climate.heizung_kueche')) === 21 && (await temp('climate.heizung_bad')) === 21), 'Küche und Bad 21 °C');
  await api('POST', '/api/services/climate/set_temperature', { entity_id: 'climate.heizung_kueche', temperature: 23 });
  ok(await until(async () => (await now(k)).level === 'manual'), 'Küche in der App 23 °C → von Hand');
  // restart of the integration (unload + load: the same as a restart of Home Assistant for Hausregeln)
  const entry = (await api('GET', '/api/config/config_entries/entry')).body.find((x) => x.domain === 'house_rules').entry_id;
  await api('POST', `/api/config/config_entries/entry/${entry}/reload`);
  await until(async () => (await ws.call({ type: 'house_rules/info' }).catch(() => null))?.loaded, 60000, 500);
  ok((await snapshot()).starting === true, 'nach dem Neustart: Startphase');
  ok(await until(async () => (await now(k))?.level === 'manual', 10000), 'Küche: von Hand gilt nach dem Neustart weiter', (await now(k))?.line);
  await sleep(2000);
  ok((await temp('climate.heizung_kueche')) === 23, 'Küche bleibt 23 °C');
  // during the start-up phase: a person in the app counts, a device that reports something else does not
  await api('POST', '/api/services/climate/set_temperature', { entity_id: 'climate.heizung_bad', temperature: 20 });
  ok(await until(async () => (await now(bad))?.level === 'manual'), 'Bad in der App 20 °C während des Starts → von Hand', (await now(bad))?.line);
  ok(!(await hist(6)).some((h) => /Bad.*Während des Starts/.test(h)), 'nicht „Während des Starts verstellt“', await hist(6));
  await doH('clear_manual', { room: bad });
  ok(await until(async () => (await temp('climate.heizung_bad')) === 21), 'Bad zurück zum Plan → 21 °C');
  await set('climate.heizung_bad', 'heat', { temperature: 25 });
  ok(await until(async () => (await temp('climate.heizung_bad')) === 21, 8000), 'Gerät meldet 25 °C während des Starts → zurück auf 21 °C');
  await tst('startup', { value: 0 });
  ok((await snapshot()).starting === false, 'Startphase vorbei');
});

await test('Anwesenheit, Hausmodi', async () => {
  const k = R['Küche'];
  await plan(k, base({ presence: { away: true, away_after: 0.05, empty: false, empty_after: 30, home_soon: false } }));
  ok(await until(async () => (await temp('climate.heizung_kueche')) === 21), 'Küche 21 °C');
  await ws.call({ type: 'house_rules/mode/set', mode: 'away' });
  ok(await until(async () => (await temp('climate.heizung_kueche')) === 17), 'Hausmodus Weg → Sparen 17 °C');
  await ws.call({ type: 'house_rules/mode/set', mode: 'home' });
  ok(await until(async () => (await temp('climate.heizung_kueche')) === 21), 'zurück → 21 °C');
  await api('POST', '/api/services/device_tracker/see', { dev_id: 'alex_handy', location_name: 'not_home' });
  ok(await until(async () => (await temp('climate.heizung_kueche')) === 17, 12000), 'alle weg (3 Sek.) → 17 °C', (await now(k)).line);
  ok(/alle weg|Hausmodus Weg/.test((await now(k)).why), 'Grund: alle weg (oder der automatische Hausmodus Weg)', (await now(k)).why);
  await api('POST', '/api/services/device_tracker/see', { dev_id: 'alex_handy', location_name: 'home' });
  ok(await until(async () => (await temp('climate.heizung_kueche')) === 21), 'jemand zurück → 21 °C');
  await ws.call({ type: 'house_rules/mode/set', mode: 'sleep' });
  ok(await until(async () => (await temp('climate.heizung_kueche')) === 16), 'Schlafen → Nacht 16 °C');
  await ws.call({ type: 'house_rules/mode/set', mode: 'vacation' });
  ok(await until(async () => (await temp('climate.heizung_kueche')) === 12), 'Urlaub → Frostschutz 12 °C');
  await ws.call({ type: 'house_rules/mode/set', mode: 'home' });
  ok(await until(async () => (await temp('climate.heizung_kueche')) === 21), 'Zuhause → 21 °C');
});

await test('Wärmeanforderung mit Mindestzeiten', async () => {
  const k = R['Küche'];
  await plan(k, base());
  await glob({ ...G0, demand: { on: true, entity: 'switch.heizkessel', above: 20, min_on: 0.1, min_off: 0.05 } });
  await set('climate.heizung_kueche', 'heat', { temperature: 21, valve: 10 });
  await sleep(2000);
  ok((await st('switch.heizkessel')).state === 'off', 'Ventil 10 % → Kessel bleibt aus');
  await set('climate.heizung_kueche', 'heat', { temperature: 21, valve: 55 });
  ok(await until(async () => (await st('switch.heizkessel')).state === 'on', 5000), 'Ventil 55 % → Kessel an');
  ok((await st('binary_sensor.heizung_waermeanforderung')).state === 'on', 'binary_sensor.heizung_waermeanforderung an');
  const t0 = Date.now();
  await set('climate.heizung_kueche', 'heat', { temperature: 21, valve: 0 });
  await sleep(2000);
  ok((await st('switch.heizkessel')).state === 'on', 'Ventil zu → bleibt an (Mindestlaufzeit 6 Sek.)');
  ok(await until(async () => (await st('switch.heizkessel')).state === 'off', 10000), `dann aus (${Math.round((Date.now() - t0) / 1000)} Sek.)`);
  await set('climate.heizung_kueche', 'heat', { temperature: 21, valve: 80 });
  await sleep(1200);
  ok((await st('switch.heizkessel')).state === 'off', 'gleich wieder Bedarf → wartet die Mindest-Pause (3 Sek.)');
  ok(await until(async () => (await st('switch.heizkessel')).state === 'on', 8000), 'dann wieder an');
  const g = (await snapshot()).plans.heating.demand;
  ok(/Ventil 80\s%/.test(g.why), 'Grund: Ventil 80 %', g);
  await set('climate.heizung_kueche', 'heat', { temperature: 21, valve: 0 });
});

await test('Lüften: Feuchte, CO₂, Erinnerung', async () => {
  const bad = R.Bad;
  const events = [];
  await ws.sub({ type: 'subscribe_events', event_type: 'house_rules_ventilate' }, (e) => events.push(e.data));
  await glob({ ...G0, notify: [(await snapshot()).persons.find((p) => /Alex/.test(p.name))?.id] });
  await plan(bad, base({ on: false, vent: { ...base().vent, on: true, humidity: 60 } }));
  ok(await until(async () => (await st('sensor.bad_lueften')).state === 'ok', 8000), 'sensor.bad_lueften: ok', await st('sensor.bad_lueften'));
  await set('sensor.feuchte_bad', '72');
  ok(await until(async () => (await st('sensor.bad_lueften')).state === 'lueften', 8000), 'Feuchte 72 % → lueften', await st('sensor.bad_lueften'));
  const a = (await st('sensor.bad_lueften')).attributes;
  ok(a.minutes === 7 && /72\s%/.test(a.reason), 'Dauer nach Außentemperatur (5 °C → 7 Min.), Grund', a);
  ok(await until(() => events.some((e) => e.room === bad && e.reason === 'humidity'), 3000), 'Ereignis house_rules_ventilate', events);
  const c = await until(async () => (await calls()).find((x) => /Luftfeuchte\s72/.test(x.data?.message ?? '')), 3000);
  ok(c && c.service.startsWith('notify.'), 'Nachricht an Alex (zuhause)', await calls());
  await set('binary_sensor.fenster_bad', 'on');
  ok(await until(async () => (await st('sensor.bad_lueften')).state === 'lueftet', 5000), 'Fenster auf → lueftet');
  await set('binary_sensor.fenster_bad', 'off');
  await set('sensor.feuchte_bad', '50');
  ok(await until(async () => (await st('sensor.bad_lueften')).state === 'ok', 5000), 'Feuchte normal → ok');
  // window open too long while heating
  await plan(bad, base({ vent: { ...base().vent, on: true, close: true, close_after: 0.05 }, window: { ...base().window, delay: 5 } }));
  await set('binary_sensor.fenster_bad', 'on');
  ok(await until(async () => (await st('sensor.bad_lueften')).state === 'fenster_zu', 8000), 'Fenster zu lange offen → fenster_zu', await st('sensor.bad_lueften'));
  ok(await until(() => events.some((e) => e.reason === 'close_window'), 3000), 'Erinnerung „Fenster wieder zu“');
  await set('binary_sensor.fenster_bad', 'off');
  // CO₂ in the living room, mould risk
  const wz = R.Wohnzimmer;
  await plan(wz, base({ on: false, vent: { ...base().vent, on: true, mould: true } }));
  await set('sensor.co2_wohnzimmer', '1400');
  ok(await until(async () => /CO₂\s1400/.test((await st('sensor.wohnzimmer_lueften')).attributes.reason ?? ''), 8000), 'CO₂ 1400 ppm → lüften', await st('sensor.wohnzimmer_lueften'));
  await set('sensor.co2_wohnzimmer', '600');
  await plan(bad, base({ on: false, sensor: 'sensor.temp_bad', vent: { ...base().vent, on: true, humidity: 95, mould: true } }));
  await set('sensor.temp_aussen', '-5');
  await set('sensor.feuchte_bad', '70');
  ok(await until(async () => /Schimmelgefahr/.test((await st('sensor.bad_lueften')).attributes.reason ?? ''), 8000), 'kalt draußen + 70 % → Schimmelgefahr', await st('sensor.bad_lueften'));
  ok((await st('sensor.bad_lueften')).attributes.minutes === 5, 'bei −5 °C nur 5 Min. lüften');
});

await test('Sommer: draußen warm → Heizung aus', async () => {
  const k = R['Küche'];
  await plan(k, base());
  ok(await until(async () => (await temp('climate.heizung_kueche')) === 21), 'Küche 21 °C');
  await glob({ ...G0, summer: { on: true, above: 18, hold: 0 } });
  await set('sensor.temp_aussen', '22');
  ok(await until(async () => (await st('climate.heizung_kueche')).state === 'off', 8000), 'draußen 22 °C → aus', (await now(k)).line);
  ok(/Sommer/.test((await now(k)).line), 'Statuszeile: Sommer', (await now(k)).line);
  await set('sensor.temp_aussen', '17.5');
  await sleep(2500);
  ok((await st('climate.heizung_kueche')).state === 'off', '17,5 °C: bleibt aus (1 °C Abstand)');
  await set('sensor.temp_aussen', '10');
  ok(await until(async () => (await st('climate.heizung_kueche')).state === 'heat', 8000), '10 °C → heizt wieder');
});

await test('Raumthermometer: Abgleich und Zielkorrektur', async () => {
  const wz = R.Wohnzimmer;
  await set('sensor.temp_wohnzimmer', '21');
  await set('climate.heizung_wohnzimmer', 'heat', { temperature: 20, current_temperature: 19 });
  let v = await plan(wz, base({ sensor: 'sensor.temp_wohnzimmer', calibrate: 'auto' }));
  ok(v.heating.rooms[wz]?.calibration?.['climate.heizung_wohnzimmer'], 'Kalibrierung am Thermostat gefunden', v.heating.rooms[wz]);
  ok(v.heating.rooms[wz]?.valves?.['climate.heizung_wohnzimmer'] === 'sensor.heizung_wohnzimmer_ventil', 'Ventil-Sensor am selben Gerät gefunden', v.heating.rooms[wz]);
  ok(await until(async () => Number((await st('number.heizung_wohnzimmer_local_temperature_calibration')).state) === 2, 6000), 'Thermostat 19 °C, Raum 21 °C → Ausgleich +2 °C', (await st('number.heizung_wohnzimmer_local_temperature_calibration')).state);
  ok((await temp('climate.heizung_wohnzimmer')) === 21, 'Ziel unverändert 21 °C (Ausgleich am Thermostat)');
  // no calibration number: correct the target instead (Küche has none)
  const k = R['Küche'];
  await set('climate.heizung_kueche', 'heat', { temperature: 20, current_temperature: 19 });
  await plan(k, base({ sensor: 'sensor.temp_wohnzimmer', calibrate: 'auto' }));
  ok(await until(async () => (await temp('climate.heizung_kueche')) === 19), 'Küche ohne Ausgleich: Ziel 21 − 2 = 19 °C (Thermostat misst 2 °C weniger)', await temp('climate.heizung_kueche'));
  await set('sensor.heizung_wohnzimmer_ventil', '40');
  await sleep(1500);
  const s = await now(wz);
  ok(s.valve === 40 && /Ventil 40\s%/.test(s.line), 'Ventil 40 % in der Statuszeile', s.line);
  await set('sensor.heizung_wohnzimmer_ventil', '0');
});

await test('Lüften erkannt am Temperatursturz (ohne Kontakt)', async () => {
  const bad = R.Bad;
  await set('sensor.temp_bad', '21');
  await plan(bad, base({ sensor: 'sensor.temp_bad', calibrate: 'off', window: { ...base().window, on: true, contacts: ['binary_sensor.fenster_wohnzimmer'], drop: true, drop_k: 1, resume: 0.05 } }));
  ok(await until(async () => (await temp('climate.heizung_bad')) === 21), 'Bad 21 °C');
  await sleep(1000);
  await set('sensor.temp_bad', '19.6');
  ok(await until(async () => (await st('climate.heizung_bad')).state === 'off', 6000), 'Raum 1,4 °C kälter in kurzer Zeit → Lüften erkannt, aus', (await now(bad)).line);
  await set('sensor.temp_bad', '20.2');
  ok(await until(async () => (await st('climate.heizung_bad')).state === 'heat', 12000), 'wird wieder wärmer → nach der Wartezeit weiter', (await now(bad)).line);
});

await test('Ventilschutz', async () => {
  const k = R['Küche'];
  await plan(k, base());
  ok(await until(async () => (await temp('climate.heizung_kueche')) === 21), 'Küche 21 °C');
  await ws.call({ type: 'house_rules/heating/do', action: 'exercise' });
  ok(await until(async () => (await temp('climate.heizung_kueche')) === 30, 5000), 'alle Ventile ganz auf (30 °C)');
  ok(await until(async () => (await temp('climate.heizung_kueche')) === 21, 12000), 'nach 3 Sek. zurück auf 21 °C');
});

await test('Alte Heizpläne (erste Version) und Funktion aus', async () => {
  const k = R['Küche'];
  const v = await plan(k, { on: true, base: 17.5, windows: [{ from: '00:00', to: '23:59', days: 'all', temp: 20.5 }], away_eco: false, sleep: { on: true, temp: 15 }, vacation: 10, window_off: false, preheat: false });
  const p = v.heat[k];
  ok(p.v === 2 && p.blocks.length === 1 && p.blocks[0].temp === 20.5 && p.temps.base === 17.5 && p.temps.frost === 10 && p.temps.night === 15 && p.window.on === false && p.presence.away === false, 'altes Format wird übernommen', p);
  ok(await until(async () => (await temp('climate.heizung_kueche')) === 20.5), 'und angewendet: 20,5 °C');
  await ws.call({ type: 'house_rules/features/set', features: { heating: false } });
  await sleep(800);
  await set('climate.heizung_kueche', 'heat', { temperature: 25 });
  await sleep(2000);
  ok((await temp('climate.heizung_kueche')) === 25, 'Funktion Heizung aus → Hausregeln schaltet nichts');
  ok((await st('sensor.kuche_heizplan')).state === 'unavailable' || (await st('sensor.kuche_heizplan')).state === undefined, 'Heizplan-Sensor nicht verfügbar', (await st('sensor.kuche_heizplan')).state);
  await ws.call({ type: 'house_rules/features/set', features: { heating: true } });
  ok(await until(async () => (await temp('climate.heizung_kueche')) === 20.5, 8000), 'wieder an → zurück zum Plan');
});

// ---------------------------------------------------------------- smart heating
await test('Intelligent: Gewohnheiten lernen (Verlauf eingespielt) und Vorschlag übernehmen', async () => {
  const wz = R.Wohnzimmer;
  await plan(wz, base({ blocks: [] }));
  const days = pastDays(21);
  const iv = days.filter((d) => weekday(d) >= 1 && weekday(d) <= 5).map((d) => [localTs(d, 17 * 60), localTs(d, 22 * 60)]);
  const r = await tst('seed', { key: wz, intervals: iv, days });
  ok(r.days === 21, '21 Tage eingespielt', r);
  const x = await explain(wz);
  ok(x.heatmap.length === 7 && x.heatmap[1].length === 96, 'Wochenkarte: 7 Tage × 96 Viertelstunden');
  ok(x.heatmap[1][72] >= 70, `Dienstag 18:00: meist belegt (${x.heatmap[1][72]} %)`, x.heatmap[1].slice(64, 92));
  ok(x.heatmap[1][40] <= 15, `Dienstag 10:00: selten (${x.heatmap[1][40]} %)`);
  ok(x.heatmap[6][72] <= 30, `Sonntag 18:00: selten (${x.heatmap[6][72]} %)`);
  ok(x.days >= 15, 'gelernte Tage', x.days);
  const sug = await until(async () => (await snapshot()).suggestions.find((s) => s.id.startsWith(`s_heat_${wz}_workdays_17`)), 4000);
  ok(sug && /^Werktags ab 17:00 Wohnzimmer 21\s°C – übernehmen\?$/.test(sug.title), 'Vorschlag „Werktags ab 17:00 Wohnzimmer 21 °C – übernehmen?“', sug ?? { titles: (await snapshot()).suggestions.map((s) => s.title), plan: (await ws.call({ type: 'house_rules/heating/plan', room: wz })).windows });
  ok(sug?.heat?.block?.to === '22:00' && sug.task === 'heat_block', 'bis 22:00, als feste Zeit', sug);
  await doH('accept_proposal', { proposal: sug.id });
  const s2 = await snapshot();
  ok(s2.plans.heat[wz].blocks.some((b) => b.from === '17:00' && b.to === '22:00' && b.days === 'workdays'), 'übernommen: feste Zeit werktags 17:00–22:00', s2.plans.heat[wz].blocks);
  ok(!s2.suggestions.some((s) => s.id === sug.id), 'Vorschlag danach weg (gemerkt)');
});

await test('Intelligent: Vorheizen zur richtigen Zeit', async () => {
  const bad = R['Büro'];
  const start = nowMin() + 90;
  const days = pastDays(21);
  const iv = days.map((d) => [localTs(d, start), localTs(d, start + 120)]);
  await tst('seed', { key: bad, intervals: iv, days });
  await set('climate.heizung_buero', 'heat', { temperature: 20, current_temperature: 18 });
  await tst('model', { room: bad, k_l: 0.05, k_h: 6, n: 10 });
  await plan(bad, base({ blocks: [], temps: { comfort: 21, base: 18, eco: 17, night: 16, frost: 12 }, smart: smart() }));
  let h = await until(async () => { const x = await now(bad); return x.level === 'setback' && x; }, 6000);
  ok(h && h.temp === 18, 'Raum heizt schnell (6 °C/Std.), Nutzung erst in 90 Min. → noch abgesenkt 18 °C', await now(bad));
  ok(h && h.smart?.next?.preheat, `vorheizen ab ${h?.smart?.next?.preheat}`, h?.smart);
  ok(h && h.smart.chain.some((c) => /spart/.test(c)), 'Begründung: Absenken spart', h?.smart?.chain);
  await tst('model', { room: bad, k_l: 0.05, k_h: 1.2, n: 10 });
  h = await until(async () => { const x = await now(bad); return x.level === 'preheat' && x; }, 6000);
  ok(h && /vorheizen, damit es um/.test(h.why), 'Raum heizt langsam (1,2 °C/Std.) → schon jetzt vorheizen', await now(bad));
  ok(h && h.temp === 22 && h.smart.chain.some((c) => /Sportlich/.test(c)), 'Stil Sportlich: 1 °C mehr zum schnellen Aufheizen', h);
  ok(await until(async () => (await temp('climate.heizung_buero')) === 22), 'Thermostat bekommt 22 °C');
  const x = await explain(bad);
  ok(x.decisions.length >= 1 && x.decisions[0].chain.length >= 2, 'letzte Entscheidungen mit Begründungskette', x.decisions[0]);
  ok(x.today.length >= 2 && x.today.every((s) => s.from && s.to && typeof s.temp === 'number'), 'Tagesplan mit Abschnitten', x.today);
  ok(x.forecast.length === 25, 'Vorschau 12 Std. in halben Stunden', x.forecast.length);
});

await test('Intelligent: lohnt sich Absenken?', async () => {
  const bad = R.Bad;
  await tst('model', { room: bad, k_l: 0.08, k_h: 3, n: 10 });
  const short = await tst('setback', { room: bad, minutes: 30, comfort: 21, setback: 17, tout: 5, current: 21, style: 'eco' });
  ok(!short.worth, `30 Min. weg: lohnt nicht (${short.why})`, short);
  const long = await tst('setback', { room: bad, minutes: 480, comfort: 21, setback: 17, tout: 5, current: 21, style: 'eco' });
  ok(long.worth && long.saved_kh > 5 && long.reheat_h > 0, `8 Std. weg: lohnt (${long.saved_kh} Gradstunden, ${long.reheat_h} Std. vorher heizen)`, long);
  const comfy = await tst('setback', { room: bad, minutes: 90, comfort: 21, setback: 19.5, tout: 5, current: 21, style: 'comfort' });
  ok(!comfy.worth, `Stil Komfort, 90 Min., flach: lohnt nicht (${comfy.why})`, comfy);
});

await test('Intelligent: Grenzen gewinnen immer', async () => {
  const bad = R['Büro'];
  await set('climate.heizung_buero', 'heat', { temperature: 20, current_temperature: 22.5 });
  await plan(bad, base({ temps: { comfort: 23, base: 18, eco: 17, night: 16, frost: 12 }, smart: smart() }));
  await glob({ ...G0, smart: { ...G0.smart, guard: { ...GUARD0, max: 21 } } });
  let h = await until(async () => { const x = await now(bad); return x.temp === 21 && x; }, 6000);
  ok(h && h.smart.guards.some((g) => g.guard === 'max' && g.wanted === 23), 'Komfort 23 °C, Grenze 21 °C → 21 °C', await now(bad));
  ok(await until(async () => (await temp('climate.heizung_buero')) === 21), 'Thermostat bekommt 21 °C');
  await plan(bad, base({ temps: { comfort: 23, base: 18, eco: 17, night: 16, frost: 12 }, smart: smart({ guard: { max: 22 } }) }));
  h = await until(async () => { const x = await now(bad); return x.temp === 22 && x; }, 6000);
  ok(h, 'Raum darf bis 22 °C (eigene Grenze geht vor)', await now(bad));
  await glob({ ...G0, smart: { ...G0.smart, guard: { ...GUARD0, occupied_min: 15, never: { on: true, from: hm(-30), to: hm(60) } } } });
  h = await until(async () => { const x = await now(bad); return x.temp === 15 && x; }, 6000);
  ok(h && h.smart.guards.some((g) => g.guard === 'never'), 'in der Zeit „nie heizen“: nur die Untergrenze 15 °C', await now(bad));
  const x = await explain(bad);
  ok(x.guards.length >= 1, '„So denkt deine Heizung“ zeigt, was die Grenzen verhindert haben', x.guards);
});

await test('Intelligent: Schattenbetrieb steuert nichts', async () => {
  const bad = R['Büro'];
  const days = pastDays(21);
  const iv = days.map((d) => [localTs(d, nowMin() - 60), localTs(d, nowMin() + 120)]);
  await tst('seed', { key: bad, intervals: iv, days });
  await set('climate.heizung_buero', 'heat', { temperature: 20, current_temperature: 20 });
  await plan(bad, base({ blocks: [], temps: { comfort: 21, base: 18, eco: 17, night: 16, frost: 12 } }));
  ok(await until(async () => (await temp('climate.heizung_buero')) === 18), 'Zeitplan ohne Zeiten: 18 °C');
  await calls(true);
  await plan(bad, base({ blocks: [], temps: { comfort: 21, base: 18, eco: 17, night: 16, frost: 12 }, smart: { mode: 'smart', style: 'comfort', shadow_days: 7 } }));
  const h = await until(async () => { const x = await now(bad); return x.smart?.phase === 'shadow' && x.smart?.would && x; }, 6000);
  ok(h && h.smart.would.temp === 21 && h.temp === 18, `Schatten: würde ${h?.smart?.would?.temp} °C heizen, es gilt weiter der Zeitplan (18 °C)`, h?.smart);
  ok(h && h.smart.shadow.days === 7 && h.smart.shadow.left > 6.9 && !h.smart.shadow.ready, 'noch 7 Tage Beobachtung', h?.smart?.shadow);
  await sleep(2500);
  ok((await temp('climate.heizung_buero')) === 18, 'Thermostat bleibt bei 18 °C');
  ok(!(await calls()).some((c) => c.service === 'number.set_value'), 'keine Ventilbefehle');
  await doH('takeover', { room: bad });
  ok(await until(async () => (await temp('climate.heizung_buero')) === 21), 'übernommen → 21 °C (um diese Zeit meist jemand da)', (await now(bad)).why);
  ok((await now(bad)).smart.phase === 'active', 'heizt jetzt intelligent');
});

const valveRoom = async () => {
  const b = R['Büro'];
  await thermal({ factor: 120, entity_id: 'climate.heizung_buero', on: true, temp: 17, k_l: 0.08, k_h: 3 });
  await tst('factor', { value: 120 });
  await plan(b, base({ temps: { comfort: 21, base: 18, eco: 17, night: 16, frost: 12 }, smart: smart({ style: 'comfort', valve: { on: true } }) }));
  return b;
};

await test('Intelligent: Ventil direkt – regelt ein und funkt sparsam', async () => {
  const b = await valveRoom();
  ok(await until(async () => (await now(b)).smart?.valve?.state === 'on', 10000), 'Ventilsteuerung läuft', (await now(b)).smart?.valve);
  const v = (await snapshot()).plans.heating.rooms[b];
  ok(!v.valves['climate.heizung_buero'], 'Öffnungsgrad wird nicht als Ventilstellung gelesen', v.valves);
  const reached = await until(async () => { const c = (await st('climate.heizung_buero')).attributes.current_temperature; return c >= 20.6 && c <= 21.4 && c; }, 300000, 1000); // Komfort opens the valve at most 55 % (gentle): about 7–9 simulated hours in this cold room
  ok(reached, `Raum 17 → ${reached} °C (Ziel 21)`, (await st('climate.heizung_buero')).attributes);
  await sleep(20000); // another 40 simulated minutes: stays there
  const c = (await st('climate.heizung_buero')).attributes.current_temperature;
  ok(Math.abs(c - 21) <= 0.6, `bleibt bei 21 °C (${c} °C)`);
  const s = (await now(b)).smart.valve;
  ok(s.commands >= 2 && s.commands <= 30, `nur ${s.commands} Ventilbefehle in etwa 8 Std.`, s);
  const op = Number((await st('number.heizung_buero_valve_opening_degree')).state);
  const cl = Number((await st('number.heizung_buero_valve_closing_degree')).state);
  ok(op + cl === 100 && op < 100, `Öffnungs- und Schließgrad zusammen 100 % (${op} / ${cl})`);
  ok((await temp('climate.heizung_buero')) === 21, 'Solltemperatur bleibt 21 °C (fällt die Steuerung weg, regelt das Thermostat normal)');
  const x = await explain(b);
  ok(x.model.n_h >= 1 && x.model.k_h > 1 && x.model.k_h < 6, `Raummodell gelernt: heizt ${x.model.k_h} °C/Std. bei offenem Ventil (echt 3)`, x.model);
});

await test('Intelligent: Ventil nicht erreichbar → normale Regelung', async () => {
  const b = await valveRoom();
  ok(await until(async () => (await now(b)).smart?.valve?.state === 'on', 10000), 'Ventilsteuerung läuft');
  await set('number.heizung_buero_valve_opening_degree', 'unavailable');
  const s = await until(async () => { const x = (await now(b)).smart?.valve; return x?.state === 'fallback' && x; }, 10000);
  ok(s && /nicht erreichbar/.test(s.why), `zurück zur normalen Regelung (${s?.why})`, (await now(b)).smart?.valve);
  ok((await temp('climate.heizung_buero')) === 21, 'Thermostat regelt mit 21 °C weiter');
  await set('number.heizung_buero_valve_opening_degree', '100');
  ok(await until(async () => (await now(b)).smart?.valve?.state === 'on', 40000, 500), 'wieder erreichbar → Ventilsteuerung läuft wieder');
  await plan(b, base({ temps: { comfort: 21, base: 18, eco: 17, night: 16, frost: 12 }, smart: smart({ style: 'comfort', valve: { on: false } }) }));
  ok(await until(async () => Number((await st('number.heizung_buero_valve_opening_degree')).state) === 100 && Number((await st('number.heizung_buero_valve_closing_degree')).state) === 100, 10000), 'ausgeschaltet → Thermostat regelt sein Ventil wieder selbst (100 / 100)');
});

await test('Verbrauch und Kosten: geschätzt ohne Zähler, mit Gaszähler', async () => {
  const k = R['Küche'];
  await plan(k, base());
  await set('climate.heizung_kueche', 'heat', { temperature: 21, current_temperature: 19, valve: 50 });
  await glob({ ...G0, smart: { ...G0.smart, energy: { kind: 'gas', meter: null, price: 0.12 } } });
  await tst('factor', { value: 120 });
  await sleep(8000);
  let e = (await explain(k)).energy;
  ok(e.estimate && !e.from_meter && e.today.kwh > 0.05, `ohne Zähler geschätzt: ${e.today.kwh} kWh heute (Heizkörper ${e.radiator_w[k]} W × Ventilstunden)`, e.today);
  ok(e.today.cost > 0 && Math.abs(e.today.cost - (e.today.fuel_kwh * 0.12)) < 0.01, `Kosten ${e.today.cost} € bei 0,12 €/kWh`, e.today);
  ok(e.week.kwh >= e.today.kwh && e.month.kwh >= e.week.kwh, 'Woche und Monat');
  await tst('factor', { value: 1 });
  // the energy dashboard has a gas meter with a price per m³
  await ws.call({ type: 'energy/save_prefs', energy_sources: [{ type: 'gas', stat_energy_from: 'sensor.gaszaehler', stat_cost: null, entity_energy_price: null, number_energy_price: 1.2 }] });
  await glob({ ...G0 });
  const a = await ws.call({ type: 'house_rules/heating/assistant' });
  ok(a.energy.detected.kind === 'gas' && a.energy.meter.entity === 'sensor.gaszaehler' && a.energy.meter.price === 1.2, 'Gaszähler und Preis aus dem Energie-Dashboard erkannt', a.energy);
  ok(a.rooms.some((r) => r.id === R['Büro'] && r.valves['climate.heizung_buero']?.kind === 'pair'), 'Assistent: steuerbares Ventil im Büro gefunden', a.rooms.map((r) => [r.name, r.valves]));
  // the first reading is only the base; one small step so that today has meter data, then 2 m³ more
  await set('sensor.gaszaehler', '1000');
  await tst('tick');
  await set('sensor.gaszaehler', '1000.5');
  await tst('tick');
  const before = (await explain(k)).energy.today;
  await set('sensor.gaszaehler', '1002.5');
  await tst('tick');
  e = (await explain(k)).energy;
  const fuel = e.today.fuel_kwh - before.fuel_kwh;
  ok(e.from_meter && Math.abs(fuel - 20.6) < 0.05, `mit Zähler: 2 m³ = ${fuel.toFixed(1)} kWh`, e.today);
  ok(Math.abs(e.today.cost - before.cost - 2.4) < 0.01, `Kosten 2 m³ × 1,20 € = ${(e.today.cost - before.cost).toFixed(2)} €`, e.today);
  ok(e.today.rooms[k].kwh > 0, 'auf die Räume verteilt (nach Ventilstunden)', e.today.rooms);
  await ws.call({ type: 'energy/save_prefs', energy_sources: [] });
});

// ---------------------------------------------------------------- house-wide defaults, styles, inertia, bathroom, airing
const heatPlan = (room) => ws.call({ type: 'house_rules/heating/plan', room });
const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const span = (w) => (toMin(w.to) - toMin(w.from) + 1440) % 1440 || (w.to === '24:00' ? 1440 - toMin(w.from) : 0);
const span15 = (w) => span(w) === 15;
const isWork = (isoDay) => weekday(isoDay) >= 1 && weekday(isoDay) <= 5;
const todayIso = () => new Date().toLocaleDateString('sv-SE', { timeZone: BERLIN });

await test('Hausvorgaben: wie im ganzen Haus oder eigene Einstellung', async () => {
  const k = R['Küche'];
  await glob({ defaults: { window: { delay: 3 } } });
  let v = await plan(k, { ...base(), reset: ['window'] });
  ok(v.heat[k].window.delay === 3 && !v.heat[k].own.includes('window'), 'Raum ohne eigene Einstellung: Fenster-Wartezeit wie im ganzen Haus (3 Min.)', { delay: v.heat[k].window.delay, own: v.heat[k].own });
  ok(v.heat[k].own.includes('presence') && v.heat[k].own.includes('temps'), 'abweichende Abschnitte werden zur eigenen Einstellung', v.heat[k].own);
  v = await glob({ defaults: { window: { delay: 4 } } });
  ok(v.heat[k].window.delay === 4, 'Hausvorgabe geändert → der Raum folgt (4 Min.)', v.heat[k].window);
  ok(v.heating.config.defaults.window.delay === 4, 'Vorgabe gespeichert', v.heating.config.defaults.window);
  v = await plan(k, { ...v.heat[k], window: { ...v.heat[k].window, delay: 1 } });
  ok(v.heat[k].window.delay === 1 && v.heat[k].own.includes('window'), 'im Raum geändert → eigene Einstellung (1 Min.)', v.heat[k].own);
  ok(v.heat[k].window.contacts.length === 0, 'Fensterkontakte bleiben je Raum');
  v = await glob({ defaults: { window: { delay: 5 } } });
  ok(v.heat[k].window.delay === 1, 'Hausvorgabe ändert die eigene Einstellung nicht', v.heat[k].window);
  v = await plan(k, { ...v.heat[k], reset: ['window'] });
  ok(v.heat[k].window.delay === 5 && !v.heat[k].own.includes('window'), '„Wie im ganzen Haus“ → wieder 5 Min.', v.heat[k]);
  // style as a house-wide default
  v = await glob({ defaults: { smart: { style: 'eco' } } });
  v = await plan(k, { ...v.heat[k], smart: { ...v.heat[k].smart, mode: 'smart', shadow_days: 0 }, reset: ['style'] });
  ok(v.heat[k].smart.style === 'eco' && !v.heat[k].own.includes('style'), 'Stil Eco für das ganze Haus → der Raum heizt Eco', v.heat[k].smart);
  v = await plan(k, { ...v.heat[k], smart: { ...v.heat[k].smart, style: 'sport' } });
  ok(v.heat[k].smart.style === 'sport' && v.heat[k].own.includes('style'), 'eigener Stil Sportlich', v.heat[k].own);
  await glob({ defaults: { window: { delay: 2 }, smart: { style: 'comfort' } } });
});

await test('Intelligent: Stile neu – Eco ist unsicher kühler', async () => {
  const b = R['Büro'];
  // only two days learned (of the same kind as today, workday or day off): unsure
  const days = pastDays(14).filter((d) => isWork(d) === isWork(todayIso())).slice(0, 2);
  await tst('seed', { key: b, intervals: days.map((d) => [localTs(d, nowMin() - 60), localTs(d, nowMin() + 120)]), days });
  await set('climate.heizung_buero', 'heat', { temperature: 20, current_temperature: 20 });
  await plan(b, base({ blocks: [], smart: smart({ style: 'eco' }) }));
  let h = await until(async () => { const x = await now(b); return x.smart?.phase === 'active' && x.level === 'comfort' && x; }, 6000);
  ok(h && h.temp === 20 && h.smart.chain.some((c) => /Eco: noch unsicher/.test(c)), `Eco, erst 2 Tage gelernt: 1 °C kühler (${h?.temp} °C)`, h?.smart ?? (await now(b)));
  await plan(b, base({ blocks: [], smart: smart({ style: 'comfort' }) }));
  h = await until(async () => { const x = await now(b); return x.level === 'comfort' && x.temp === 21 && x; }, 6000);
  ok(h, 'Komfort: volle 21 °C', await now(b));
  const sb = await tst('setback', { room: b, minutes: 90, comfort: 21, setback: 15, tout: 5, current: 21, style: 'eco' });
  const sc = await tst('setback', { room: b, minutes: 90, comfort: 21, setback: 17, tout: 5, current: 21, style: 'comfort' });
  ok(sb.worth && !sc.worth, `90 Min. Pause: Eco senkt schon ab, Komfort noch nicht (${sb.why} / ${sc.why})`, { sb, sc });
});

await test('Intelligent: Bauweise als Vorwissen (Fußbodenheizung braucht Stunden)', async () => {
  const b = R['Büro'];
  const start = nowMin() + 240;
  const days = pastDays(21);
  await tst('seed', { key: b, intervals: days.map((d) => [localTs(d, start), localTs(d, start + 120)]), days });
  await set('climate.heizung_buero', 'heat', { temperature: 20, current_temperature: 18 });
  await plan(b, base({ blocks: [], smart: smart({ style: 'comfort', building: 'new' }) }));
  let h = await until(async () => { const x = await now(b); return x.smart?.phase === 'active' && ['setback', 'comfort'].includes(x.level) && x; }, 6000);
  ok(h && h.level === 'setback', `Neubau, Nutzung in 4 Std.: noch abgesenkt (${h?.temp} °C)`, h ?? (await now(b)));
  let pv = await heatPlan(b);
  ok(pv.model.lead_min < 180 && !pv.model.learned, `Neubau: etwa ${pv.model.lead_min} Min. Vorlauf (nach Bauweise geschätzt)`, pv.model);
  await plan(b, base({ blocks: [], smart: smart({ style: 'comfort', building: 'floor' }) }));
  h = await until(async () => { const x = await now(b); return x.level === 'preheat' && x; }, 6000);
  ok(h && h.smart.chain.some((c) => /reagiert erst nach/.test(c)), 'Fußbodenheizung, Nutzung in 4 Std.: heizt schon jetzt vor (träge)', h?.smart ?? (await now(b)));
  pv = await heatPlan(b);
  ok(pv.model.lead_min > 240 && pv.model.lag_min === 90 && pv.model.inert, `Fußbodenheizung: ${pv.model.lead_min} Min. Vorlauf, reagiert nach 90 Min., träge`, pv.model);
  const sb = await tst('setback', { room: b, minutes: 300, comfort: 21, setback: 17, tout: 5, current: 21, style: 'comfort' });
  ok(!sb.worth && sb.inert, `5 Std. Pause mit Fußbodenheizung: Absenken lohnt nicht (${sb.why})`, sb);
});

await test('Intelligent: Bad bekommt kurze Fenster vor der üblichen Nutzung, nicht 06–22', async () => {
  const bad = R.Bad;
  // a factory block (06–22 every day) is no learned plan: switching to intelligent drops it
  let v = await plan(bad, base({ blocks: [{ from: '06:00', to: '22:00', days: 'all', level: 'comfort', temp: 22 }] }));
  v = await plan(bad, { ...v.heat[bad], smart: smart() });
  ok(v.heat[bad].blocks.length === 0, 'Wechsel auf Intelligent: der Werks-Block 06–22 fällt weg', v.heat[bad].blocks);
  // three weeks of a realistic bathroom of a household of three: showers around 06:30, the evening routine around
  // 21:30, and short visits all day long (each 5 min)
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const days = pastDays(21);
  const iv = [];
  for (const d of days) {
    iv.push([localTs(d, 6 * 60 + 25 + Math.floor(rnd() * 10)), localTs(d, 7 * 60 + 5)]);
    if (rnd() < 0.8) iv.push([localTs(d, 21 * 60 + 25), localTs(d, 21 * 60 + 45)]);
    for (let i = 0; i < 12; i++) {
      const m = 7 * 60 + 15 + Math.floor(rnd() * 15 * 60);
      iv.push([localTs(d, m), localTs(d, m + 5)]);
    }
  }
  await tst('seed', { key: bad, intervals: iv, days });
  await tst('model', { room: bad, k_l: 0.06, k_h: 8, n: 10 });
  await set('sensor.temp_bad', '18'); // cold already: it waits for its usual time instead of keeping warm
  await plan(bad, { ...v.heat[bad], sensor: 'sensor.temp_bad' });
  const pv = await heatPlan(bad);
  const all = [...pv.windows.today, ...pv.windows.tomorrow];
  ok(pv.kind === 'short', 'Bad wird als kurz genutzter Raum erkannt');
  ok(all.length >= 1 && all.every((w) => span(w) <= 105), `nur kurze Komfort-Fenster: ${pv.windows.today.map((w) => `${w.from}–${w.to}`).join(', ')} (je höchstens 1¾ Std.)`, pv.windows);
  ok(pv.windows.today.some((w) => toMin(w.from) <= 6 * 60 + 30 && toMin(w.to) >= 7 * 60) && !pv.windows.today.some((w) => toMin(w.from) < 14 * 60 && toMin(w.to) > 12 * 60), 'morgens zum Duschen warm, mittags nicht', pv.windows.today);
  const comfortH = pv.today.filter((s) => ['comfort', 'preheat'].includes(s.level)).reduce((n, s) => n + span(s), 0) / 60;
  ok(comfortH <= 5, `warm insgesamt etwa ${comfortH.toFixed(1)} Std. am Tag, nicht 16`, pv.today);
  const seg = pv.today.find((s) => toMin(s.from) <= nowMin() && nowMin() < (s.to === '24:00' ? 1440 : toMin(s.to)));
  if (seg && !['comfort', 'preheat'].includes(seg.level)) {
    const h = await until(async () => { const x = await now(bad); return x.smart?.phase === 'active' && x; }, 6000);
    ok(h && h.level !== 'comfort' && h.temp < 21, `jetzt (nur kurze Besuche, Bad kalt): bleibt abgesenkt auf ${h?.temp} °C`, h ?? (await now(bad)));
    ok(h && h.smart.chain.some((c) => /Bad: nur zu den üblichen Zeiten|nur kurz im Raum/.test(c)), 'Begründung: Bad nur zu den üblichen Zeiten warm', h?.smart?.chain);
  } else console.log('  (jetzt ist übliche Bad-Zeit: Live-Prüfung übersprungen)');
  // as a time plan room: the proposal is a short window too
  await plan(bad, { ...(await snapshot()).plans.heat[bad], smart: { ...smart(), mode: 'schedule' }, blocks: [] });
  const sug = await until(async () => (await snapshot()).suggestions.filter((s) => s.id.startsWith(`s_heat_${bad}_`)), 4000);
  ok(Array.isArray(sug) && sug.length >= 1 && sug.every((s) => span(s.heat.block) <= 105), `Vorschläge nur kurz: ${(sug || []).map((s) => `${s.heat.block.from}–${s.heat.block.to}`).join(', ')}`, sug);
});

await test('Raumart: aus dem Bereich erkannt (Symbol, Label), eigene Einstellung gewinnt', async () => {
  // an area whose name says nothing: only its icon in Home Assistant says "shower"
  const known = (await ws.call({ type: 'config/area_registry/list' })).find((a) => a.name === 'Nebenraum');
  const aid = known
    ? (await ws.call({ type: 'config/area_registry/update', area_id: known.area_id, icon: 'mdi:shower', labels: [] })).area_id
    : (await ws.call({ type: 'config/area_registry/create', name: 'Nebenraum', icon: 'mdi:shower' })).area_id;
  const rid = await until(async () => (await snapshot()).rooms.find((r) => r.id === aid)?.id, 15000, 500);
  ok(rid, 'Raum aus dem neuen Bereich da', aid);
  if (!rid) return;
  await plan(rid, base({ blocks: [], smart: smart() }));
  let pv = await heatPlan(rid);
  ok(pv.kind === 'short' && pv.room_type?.source === 'icon' && pv.room_type?.detail === 'mdi:shower' && pv.room_type?.setting === 'auto', 'Symbol mdi:shower: kurz genutzt erkannt, mit Grund', pv.room_type);
  // the own setting wins, the detected kind stays visible
  await plan(rid, base({ blocks: [], smart: smart({ room_type: 'normal' }) }));
  pv = await heatPlan(rid);
  ok(pv.kind === 'normal' && pv.room_type?.setting === 'normal' && pv.room_type?.auto === 'short', 'eigene Raumart „normal“ gewinnt, das Erkannte bleibt sichtbar', pv.room_type);
  ok((await snapshot()).plans.heat[rid]?.smart?.room_type === 'normal', 'Einstellung gespeichert');
  const st = await until(async () => { const x = await now(rid); return x?.smart?.room_type && x; }, 6000);
  ok(st && st.smart.kind === 'normal' && st.smart.room_type.auto === 'short', 'Status im Snapshot nennt Raumart und Erkanntes', st?.smart);
  // back to automatic; the icon changed in Home Assistant → passage, without a restart
  await plan(rid, base({ blocks: [], smart: smart({ room_type: 'auto' }) }));
  await ws.call({ type: 'config/area_registry/update', area_id: aid, icon: 'mdi:stairs' });
  pv = await until(async () => { const x = await heatPlan(rid); return x.kind === 'pass' && x; }, 15000, 500);
  ok(pv && pv.room_type.source === 'icon', 'Symbol in Home Assistant auf Treppe geändert: Durchgang', pv?.room_type ?? (await heatPlan(rid)).room_type);
  // a label "Durchgang" (no icon): detected from the label
  const lab = await ws.call({ type: 'config/label_registry/create', name: 'Durchgang' }).catch(() => null);
  if (lab?.label_id) {
    await ws.call({ type: 'config/area_registry/update', area_id: aid, icon: null, labels: [lab.label_id] });
    pv = await until(async () => { const x = await heatPlan(rid); return x.room_type?.source === 'label' && x; }, 15000, 500);
    ok(pv && pv.kind === 'pass' && pv.room_type.detail === 'Durchgang', 'Label „Durchgang“ am Bereich: Durchgang', pv?.room_type ?? (await heatPlan(rid)).room_type);
    await ws.call({ type: 'config/label_registry/delete', label_id: lab.label_id });
  } else ok(false, 'Label anlegen');
  // nothing left: the name says nothing → normal
  await ws.call({ type: 'config/area_registry/update', area_id: aid, icon: null, labels: [] });
  pv = await until(async () => { const x = await heatPlan(rid); return x.room_type?.source === 'default' && x; }, 15000, 500);
  ok(pv && pv.kind === 'normal', 'ohne Symbol, Label, Geräte: normal', pv?.room_type ?? (await heatPlan(rid)).room_type);
  await ws.call({ type: 'config/area_registry/delete', area_id: aid });
});

await test('Intelligent: Lüften gelernt → erst danach vorheizen', async () => {
  // the office (no motion sensor) with a window contact of its own
  const wz = R['Büro'];
  const win = { ...base().window, contacts: ['binary_sensor.fenster_wohnzimmer'] };
  const days = pastDays(21);
  await tst('seed', { key: wz, intervals: days.map((d) => [localTs(d, nowMin() + 60), localTs(d, nowMin() + 240)]), days });
  await tst('model', { room: wz, k_l: 0.05, k_h: 1.5, n: 10 });
  await set('climate.heizung_buero', 'heat', { temperature: 18, current_temperature: 18 });
  // without airing: the slow room preheats right now
  await plan(wz, base({ blocks: [], window: win, smart: smart({ style: 'comfort' }) }));
  let h = await until(async () => { const x = await now(wz); return x.level === 'preheat' && x; }, 6000);
  ok(h, 'ohne Lüftgewohnheit: jetzt vorheizen', await now(wz));
  // a window of the room is usually open in 20–35 minutes
  await tst('seed', { key: `w:${wz}`, intervals: days.map((d) => [localTs(d, nowMin() + 20), localTs(d, nowMin() + 35)]), days });
  await plan(wz, base({ blocks: [], window: win, smart: smart({ style: 'comfort' }) }));
  h = await until(async () => { const x = await now(wz); return x.level !== 'preheat' && x; }, 6000);
  ok(h && /erst nach dem Lüften/.test(h.why) && h.temp < 21, `gelernt: gleich wird gelüftet → noch nicht vorheizen (${h?.why})`, h ?? (await now(wz)));
  ok(h && h.smart.chain.some((c) => /nach dem üblichen Lüften/.test(c)), 'Begründung in der Kette', h?.smart?.chain);
  const pv = await heatPlan(wz);
  ok(pv.airing.today.some((w) => w.source === 'learned'), `Plan zeigt die gelernte Lüftzeit ${pv.airing.today.map((w) => `${w.from}–${w.to}`).join(', ')}`, pv.airing);
  ok(pv.today.some((s) => s.level === 'airing'), 'im Tagesplan als Lüftzeit markiert', pv.today);
  // the prior from the assistant ("aired in the morning after getting up") for a room without learned airing
  await glob({ smart: { airing: { morning: true, minutes: 15, rooms: [] } } });
  const pk = await heatPlan(R['Küche']);
  ok(pk.airing.today.length === 1 && pk.airing.today[0].source === 'prior' && span15(pk.airing.today[0]), `Assistent „morgens lüften“: ${pk.airing.today.map((w) => `${w.from}–${w.to}`).join(', ')} bis es gelernt ist`, pk.airing);
});

await test('Intelligent: Lernphase heizt nach Anwesenheit, ohne Beobachten', async () => {
  const k = R['Küche'];
  const away = { away: true, away_after: 0.05, empty: false, empty_after: 30, home_soon: false };
  // observing first, then "0 days": acts right away
  await plan(k, base({ blocks: [], presence: away, smart: { ...smart({ style: 'comfort' }), shadow_days: 7 } }));
  ok(await until(async () => (await now(k)).smart?.phase === 'shadow', 6000), 'erst Beobachten (7 Tage)');
  // no ramp: the back-home check wants the full comfort right away (the ramp has its own tests)
  await plan(k, base({ blocks: [], presence: away, smart: smart({ style: 'comfort', ramp: { step: 0, minutes: 0 } }) }));
  let h = await until(async () => { const x = await now(k); return x.smart?.phase === 'active' && x.level === 'comfort' && x; }, 6000);
  ok(h, '0 Tage Beobachten: übernimmt sofort', await now(k));
  ok(h && h.temp === 21 && h.smart.learning === true && h.smart.chain.some((c) => /Lernphase/.test(c)) && /jemand ist zuhause/.test(h.why), `nichts gelernt, jemand zuhause → Komfort 21 °C (${h?.why})`, h?.smart ?? (await now(k)));
  ok(await until(async () => (await temp('climate.heizung_kueche')) === 21), 'Thermostat bekommt 21 °C');
  await api('POST', '/api/services/device_tracker/see', { dev_id: 'alex_handy', location_name: 'not_home' });
  h = await until(async () => { const x = await now(k); return x.level === 'eco' && x; }, 12000);
  ok(h && h.temp === 17 && /alle weg/.test(h.why), `alle weg → Sparen 17 °C (${h?.why})`, await now(k));
  ok(await until(async () => (await temp('climate.heizung_kueche')) === 17), 'Thermostat bekommt 17 °C');
  await api('POST', '/api/services/device_tracker/see', { dev_id: 'alex_handy', location_name: 'home' });
  ok(await until(async () => { const x = await now(k); return x.level === 'comfort' && x.temp === 21; }, 8000), 'wieder da → Komfort', await now(k));
  await ws.call({ type: 'house_rules/mode/set', mode: 'sleep' });
  ok(await until(async () => { const x = await now(k); return x.level === 'night' && x.temp === 16; }, 8000), 'Hausmodus Schlafen → Nacht 16 °C', await now(k));
  await ws.call({ type: 'house_rules/mode/set', mode: 'home' });
});

await test('Intelligent: abends ausklingen – ab der Uhrzeit höchstens die Abendtemperatur', async () => {
  const k = R['Küche'];
  const away = { away: true, away_after: 0.05, empty: false, empty_after: 30, home_soon: false };
  const sm = smart({ style: 'comfort', ramp: { step: 0, minutes: 0 } });
  await plan(k, base({ blocks: [], presence: away, smart: sm }));
  ok(await until(async () => { const x = await now(k); return x.level === 'comfort' && x.temp === 21; }, 8000), 'vorher Komfort 21 °C', await now(k));
  // from a minute ago until 04:00: at most 19 °C
  await plan(k, base({ blocks: [], presence: away, smart: { ...sm, evening: { on: true, temp: 19, from: hm(-1) } } }));
  const saved = (await snapshot()).plans.heat[k].smart.evening;
  ok(saved && saved.on && saved.temp === 19 && saved.from === hm(-1), 'Einstellung gespeichert', saved);
  let h = await until(async () => { const x = await now(k); return x.temp === 19 && x; }, 8000);
  ok(h && /abends ausklingen/.test(h.why) && h.smart.chain.some((c) => /kühlt langsam aus/.test(c)), `ab ${hm(-1)} höchstens 19 °C (${h?.why})`, h ?? (await now(k)));
  ok(await until(async () => (await temp('climate.heizung_kueche')) === 19), 'Thermostat bekommt 19 °C');
  await ws.call({ type: 'house_rules/mode/set', mode: 'guests' });
  ok(await until(async () => { const x = await now(k); return x.temp === 21; }, 8000), 'mit Gästen: wieder 21 °C', await now(k));
  await ws.call({ type: 'house_rules/mode/set', mode: 'sleep' });
  ok(await until(async () => { const x = await now(k); return x.level === 'night' && x.temp === 16; }, 8000), 'Schlafen: Nacht 16 °C wie immer', await now(k));
  await ws.call({ type: 'house_rules/mode/set', mode: 'home' });
  await plan(k, base({ blocks: [], presence: away, smart: { ...sm, evening: { on: true, temp: 19, from: hm(90) } } }));
  // (between 02:30 and 04:00 a start 90 min later would lie after 04:00 and wrap around the whole day)
  if (nowMin() < 150 || nowMin() >= 240) ok(await until(async () => { const x = await now(k); return x.temp === 21; }, 8000), `erst ab ${hm(90)}: jetzt noch 21 °C`, await now(k));
  await plan(k, base({ blocks: [], presence: away, smart: { ...sm, evening: { on: false, temp: 19, from: null } } }));
});

await test('Intelligent: Fenster auf → sofort aus und Ventil zu, zu → nach 25 s wieder an', async () => {
  const b = R['Büro'];
  const win = { ...base().window, contacts: ['binary_sensor.fenster_wohnzimmer'], delay: 0, resume: 25 / 60 };
  await thermal({ factor: 120, entity_id: 'climate.heizung_buero', on: true, temp: 18, k_l: 0.08, k_h: 3 });
  await tst('factor', { value: 120 });
  await plan(b, base({ blocks: [], window: win, temps: { comfort: 21, base: 18, eco: 17, night: 16, frost: 12 }, smart: smart({ style: 'comfort', valve: { on: true } }) }));
  ok(await until(async () => { const x = (await now(b)).smart?.valve; return x?.state === 'on' && x.u > 0; }, 15000), 'Ventilsteuerung läuft ab der ersten Minute (nichts gelernt)', (await now(b)).smart);
  const opening = async () => Number((await st('number.heizung_buero_valve_opening_degree')).state);
  const closing = async () => Number((await st('number.heizung_buero_valve_closing_degree')).state);
  await calls(true);
  let t0 = Date.now();
  await set('binary_sensor.fenster_wohnzimmer', 'on');
  ok(await until(async () => (await st('climate.heizung_buero')).state === 'off', 3000, 100), `Fenster auf → Heizung sofort aus (${Date.now() - t0} ms)`, await hist());
  ok(await until(async () => (await opening()) === 0 && (await closing()) === 100, 3000, 100), `und das Ventil sofort ganz zu (${Date.now() - t0} ms)`, { op: await opening(), cl: await closing(), v: (await now(b)).smart?.valve });
  ok((await now(b)).smart.valve.state === 'window', 'Ventilsteuerung: Fenster offen', (await now(b)).smart.valve);
  await sleep(3000);
  t0 = Date.now();
  await set('binary_sensor.fenster_wohnzimmer', 'off');
  await sleep(8000);
  const s = await now(b);
  ok((await st('climate.heizung_buero')).state === 'off' && s.window.state === 'settling' && (await opening()) === 0, 'zu: wartet noch, Ventil bleibt zu', s.line);
  ok(await until(async () => { const c = await st('climate.heizung_buero'); return c.state === 'heat' && c.attributes.temperature === 21; }, 30000, 250), 'dann wieder an auf 21 °C');
  const back = (Date.now() - t0) / 1000;
  ok(back >= 23 && back <= 32, `nach ${back.toFixed(1)} s (eingestellt 25 s)`);
  ok(await until(async () => (await now(b)).smart?.valve?.state === 'on' && (await opening()) > 0, 5000, 250), 'Ventil folgt sofort wieder der Steuerung', (await now(b)).smart?.valve);
  // flapping: opened again and again → waits longer instead of switching on and off
  const flips = [];
  await ws.sub({ type: 'subscribe_events', event_type: 'state_changed' }, (e) => {
    const d = e.data;
    if (d.entity_id === 'climate.heizung_buero' && d.old_state && d.new_state && d.old_state.state !== d.new_state.state) flips.push(d.new_state.state);
  });
  for (let i = 0; i < 3; i++) {
    await set('binary_sensor.fenster_wohnzimmer', 'on');
    await sleep(1500);
    await set('binary_sensor.fenster_wohnzimmer', 'off');
    await sleep(1500);
  }
  await sleep(30000);
  const f = await now(b);
  ok((await st('climate.heizung_buero')).state === 'off' && f.window.state === 'settling' && f.window.flapping, 'Fenster mehrmals kurz hintereinander auf: wartet länger (kein Flattern)', f.window);
  ok(flips.length <= 2, `Thermostat nur ${flips.length}× umgeschaltet bei 3 schnellen Öffnungen`, flips);
  await set('binary_sensor.fenster_wohnzimmer', 'off');
});

await reset();
console.log(`\n${failures() ? `${failures()} FEHLER` : 'alles ok'}`);
ws.close();
process.exit(failures() ? 1 : 0);
