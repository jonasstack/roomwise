// Feature assistants (assistants.py) and the intelligent light (lightlearn.py) against the isolated test Home Assistant
// (port 8124). Seeds hand changes → learned slot → shadow suggestions ("so hätte ich geschaltet") → guardrails win →
// switched on it acts; then every assistant's server side (suggest / apply / mark, admin only).
// Usage: node tools/testha/test-assistants.mjs [--only name]   (sets up areas and the integration itself if needed)
import { token, wsConnect, rest, sleep, ok, failures, until, userToken } from './lib.mjs';

const tok = await token();
const ws = await wsConnect(tok);
const api = rest(tok);
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const set = (entity_id, state, attributes = {}) => ws.call({ type: 'hr_fake/set', entity_id, state, attributes });
const st = async (e) => (await api('GET', `/api/states/${e}`)).body;
const snapshot = () => ws.call({ type: 'house_rules/snapshot' });

// ---------------------------------------------------------------- setup (idempotent)
const areas = await ws.call({ type: 'config/area_registry/list' });
const area = async (name) => (areas.find((a) => a.name === name) ?? (await ws.call({ type: 'config/area_registry/create', name }))).area_id;
const A = { flur: await area('Flur'), kueche: await area('Küche'), wohnzimmer: await area('Wohnzimmer') };
const place = {
  flur: ['light.flurlicht', 'binary_sensor.haustuer', 'binary_sensor.praesenz_flur', 'sensor.lux_flur', 'switch.tablet_bildschirm'],
  kueche: ['light.kuechenlicht', 'binary_sensor.fenster_kueche', 'vacuum.robo'],
  wohnzimmer: ['light.sofalicht', 'media_player.homepod', 'binary_sensor.bewegung_wohnzimmer'],
};
for (const [r, ents] of Object.entries(place)) for (const e of ents) await ws.call({ type: 'config/entity_registry/update', entity_id: e, area_id: A[r] }).catch((err) => console.log('area', e, err.message));
let info = await ws.call({ type: 'house_rules/info' }).catch(() => null);
if (!info?.loaded) {
  const flow = await api('POST', '/api/config/config_entries/flow', { handler: 'roomwise' });
  await api('POST', `/api/config/config_entries/flow/${flow.body.flow_id}`, {});
  info = await until(async () => {
    const i = await ws.call({ type: 'house_rules/info' }).catch(() => null);
    return i?.loaded && i;
  });
}
ok(info?.loaded, `integration läuft (${info?.version})`);
await until(async () => (await snapshot()).devices.some((d) => d.entity_id === 'light.flurlicht' && d.room), 90000, 1000);
// in the start-up phase changes by others do not count as "by hand" yet (core.starting): learning from hand changes needs it over
await until(async () => (await snapshot()).starting === false, 150000, 1000);
let snap = await snapshot();
const R = Object.fromEntries(['Flur', 'Küche', 'Wohnzimmer'].map((n) => [n, snap.rooms.find((r) => r.name === n)?.id]));
ok(R.Flur && R['Küche'] && R.Wohnzimmer, 'Räume da', R);
const features0 = snap.features;
const flur0 = snap.rooms.find((r) => r.id === R.Flur);
for (const r of snap.rules) await ws.call({ type: 'house_rules/rule/delete', rule_id: r.id });
await ws.call({ type: 'house_rules/mode/set', mode: 'home' });
for (const b of ['light_on_enter', 'light_off_empty', 'night_dim']) await ws.call({ type: 'house_rules/behaviour/set', behaviour: b, on: false });
const plan = async (room, p) => ws.call({ type: 'house_rules/plan/set', kind: 'light', room, plan: { ...(await snapshot()).plans.light[room], ...p } });
const now = async (room) => (await snapshot()).plans.now[room]?.light;
const pct = async (e) => Math.round(((await st(e)).attributes.brightness ?? 0) / 2.55);
const isOn = async (e) => (await st(e)).state === 'on';
const byHand = (data) => api('POST', '/api/services/light/turn_on', { entity_id: 'light.flurlicht', ...data });
const test = async (name, fn) => {
  if (only && !name.includes(only)) return;
  console.log(`\n# ${name}`);
  try {
    await fn();
  } catch (e) {
    ok(false, `${name}: ${e.message}`);
  }
};

// a neutral start: no light plans running, nothing learned in the hallway
for (const r of snap.rooms) await plan(r.id, { on: false, rules: [], smart: { mode: 'off' }, vacation: { ...snap.plans.light[r.id].vacation, on: false } });
await ws.call({ type: 'house_rules/light/forget', room: R.Flur });
await ws.call({ type: 'house_rules/features/set', features: { light: true } });
await ws.call({ type: 'house_rules/room/save', room: { id: R.Flur, empty_after: 0.02, lux: 'sensor.lux_flur', dark_below: 50 } });
await set('sensor.lux_flur', '5');
await set('switch.wasserkocher', 'off');
await set('binary_sensor.praesenz_flur', 'off');
await set('light.flurlicht', 'off');
await sleep(800);

await test('Assistent-Flags', async () => {
  // a killed test container may have lost the reset at the end of an earlier run (saved a few seconds later)
  for (const f of ['light', 'alarm', 'window_warning', 'vacation', 'vacuum', 'mode_auto']) await ws.call({ type: 'house_rules/assistant/mark', feature: f, done: false, dismissed: false });
  snap = await snapshot();
  const a = snap.setup.assistants;
  ok(a && ['light', 'alarm', 'window_warning', 'vacation', 'vacuum', 'mode_auto'].every((k) => k in a), 'Snapshot: setup.assistants je Funktion', a);
  ok(a.light.configured === false, 'Licht: noch nichts eingerichtet (configured false)', a.light);
  let v = await ws.call({ type: 'house_rules/assistant/mark', feature: 'light', dismissed: true });
  ok(v.light.dismissed === true && v.light.done === false, '„später“ merkt sich dismissed', v.light);
  v = await ws.call({ type: 'house_rules/assistant/mark', feature: 'light', dismissed: false, done: false });
  ok(!v.light.dismissed && !v.light.done, 'zurückgesetzt');
  let err = '';
  await ws.call({ type: 'house_rules/assistant/mark', feature: 'heating', done: true }).catch((e) => (err = e.message));
  ok(/invalid_format|not a valid/.test(err), 'Heizung hat kein Assistent-Flag hier (eigener Assistent)', err);
  const tabletTok = await userToken(tok);
  const ws2 = await wsConnect(tabletTok);
  err = '';
  await ws2.call({ type: 'house_rules/assistant/apply', feature: 'light', answers: {} }).catch((e) => (err = e.message));
  ok(/unauthorized/.test(err), 'ohne Admin: abgelehnt', err);
  ws2.close();
});

await test('Licht-Assistent (Server)', async () => {
  const sug = await ws.call({ type: 'house_rules/assistant/suggest', feature: 'light' });
  const flur = sug.rooms.find((r) => r.id === R.Flur);
  ok(flur && flur.lights.some((l) => l.entity_id === 'light.flurlicht' && l.white) && flur.presence.some((p) => p.entity_id === 'binary_sensor.praesenz_flur') && flur.lux?.entity_id === 'sensor.lux_flur', 'Vorschlag: Flur mit Licht (Weißton), Präsenzmelder und Lichtsensor', flur);
  ok(sug.slots.length === 5 && Array.isArray(sug.night), 'Startwerte je Tageszeit und „nachts“', sug.slots);
  // every slot the same start value: what is learned shows clearly
  const slots = sug.slots.map((s) => ({ ...s, brightness: 80, color: 'neutral' }));
  const res = await ws.call({ type: 'house_rules/assistant/apply', feature: 'light', answers: { rooms: [R.Flur], mode: 'smart', active: false, only_dark: true, slots, empty: { mode: 'off', delay: 0.02 }, manual: 'room_empty', guards: { max: 90, night_max: 90, night_warm: false, off_while: [] } } });
  ok(res.ok && res.rooms.includes(R.Flur), 'eingerichtet', res);
  snap = await snapshot();
  const p = snap.plans.light[R.Flur];
  ok(p.on && p.smart.mode === 'shadow' && p.smart.guards.max === 90 && p.rules.length === 0 && p.empty.mode === 'off', 'Flur: Lichtplan an, intelligent im Probelauf, Grenzen, keine Regeln', p.smart);
  ok(snap.setup.assistants.light.done && snap.setup.assistants.light.configured, 'Flag: eingerichtet', snap.setup.assistants.light);
  // "own rules" instead: a while rule with a variant per time of day, guardrails already applied
  await ws.call({ type: 'house_rules/assistant/apply', feature: 'light', answers: { rooms: [R.Küche], mode: 'rules', only_dark: false, slots: sug.slots, guards: { max: 60, night_max: 15, night_warm: true, off_while: [{ subject: 'switch.wasserkocher', verb: 'is_on' }] } } });
  const k = (await snapshot()).plans.light[R.Küche];
  const w = k.rules.find((x) => x.kind === 'while');
  const nightV = w?.variants.find((v) => v.when[0].from === '23:30');
  ok(k.smart.mode === 'off' && w && w.variants.length === 5 && w.variants.every((v) => v.brightness <= 60) && nightV?.brightness <= 15 && k.rules.some((x) => x.kind === 'never_on'), 'Eigene Regeln: Solange-Regel mit 5 Tageszeiten, „nie heller als 60 %“, nachts ≤ 15 %, „nie an, solange …“', k.rules);
  await plan(R.Küche, { on: false, rules: [] });
});

await test('Intelligentes Licht: lernen, Probelauf, Grenzen, an', async () => {
  await set('binary_sensor.praesenz_flur', 'on');
  await until(async () => (await snapshot()).occupancy[R.Flur]?.occupied, 8000);
  let n = await until(async () => (await now(R.Flur))?.smart?.lights?.['light.flurlicht'], 8000);
  ok(n && n.mode === 'on' && n.brightness === 80 && /Startwert/.test(n.why[0]), 'Probelauf ohne Gelerntes: „hätte“ 80 % (Startwert)', n);
  // four times by hand (app): 30 %, warm — a bit more than 20 s apart, so they count as separate examples
  for (let i = 0; i < 4; i++) {
    await byHand({ brightness_pct: 30 + (i % 2) * 2, color_temp_kelvin: 2400 });
    await sleep(i < 3 ? 21500 : 1500);
  }
  const learned = await ws.call({ type: 'house_rules/light/learned', room: R.Flur });
  const curSlot = learned.slots.find((s) => s.lights['light.flurlicht'].learned >= 3);
  ok(learned.samples === 4 && curSlot, `gelernt: 4 Einstellungen, eine Tageszeit mit Gelerntem (${curSlot?.label})`, learned);
  n = (await now(R.Flur)).smart;
  const want = n.lights['light.flurlicht'];
  ok(want.mode === 'on' && want.brightness < 60 && want.brightness >= 30 && want.kelvin < 3200 && /Gelernt/.test(want.why[0]), `Probelauf mit Gelerntem: „hätte“ ${want.brightness} %, ${want.kelvin} K`, want);
  ok(n.agree.n >= 1, `Vergleich mit dem, was von Hand passiert ist: ${n.agree.same} von ${n.agree.n}`, n.agree);
  const hs = await ws.call({ type: 'house_rules/history', limit: 20 });
  ok(!hs.some((x) => /Licht Flur/.test(x.what) && /Intelligent/.test(x.why)), 'Probelauf schaltet nichts', hs.slice(0, 5).map((x) => x.what));
  ok((await pct('light.flurlicht')) <= 33, 'Licht bleibt so, wie von Hand eingestellt', await pct('light.flurlicht'));
  // guardrails win over what was learned
  await plan(R.Flur, { smart: { ...(await snapshot()).plans.light[R.Flur].smart, guards: { max: 20, night_max: 90, night_warm: false, off_while: [{ subject: 'switch.wasserkocher', verb: 'is_on' }] } } });
  n = await until(async () => { const x = (await now(R.Flur))?.smart?.lights?.['light.flurlicht']; return x?.brightness === 20 && x; }, 5000);
  ok(n && n.why.some((w) => /nie heller als 20/.test(w)), 'Grenze „nie heller als 20 %“ gewinnt gegen das Gelernte', n);
  await set('switch.wasserkocher', 'on');
  n = await until(async () => { const x = (await now(R.Flur))?.smart?.lights?.['light.flurlicht']; return x?.mode === 'off' && x; }, 5000);
  ok(n && n.why.some((w) => /Bleibt aus/.test(w)), '„Aus lassen, solange …“ gewinnt', n);
  await set('switch.wasserkocher', 'off');
  // switched on: leave, come back → it switches on by itself, guarded
  await plan(R.Flur, { smart: { ...(await snapshot()).plans.light[R.Flur].smart, mode: 'on' } });
  await set('binary_sensor.praesenz_flur', 'off');
  ok(await until(async () => !(await isOn('light.flurlicht')), 15000), 'Raum leer → aus (Handbetrieb vergessen)');
  const before = (await ws.call({ type: 'house_rules/light/learned', room: R.Flur })).samples;
  ok(before === learned.samples, 'Ausschalten durch Hausregeln ist kein Beispiel', before);
  await set('binary_sensor.praesenz_flur', 'on');
  ok(await until(async () => (await isOn('light.flurlicht')) && Math.abs((await pct('light.flurlicht')) - 20) <= 2, 10000), 'jemand kommt → intelligent an, begrenzt auf 20 %', [await pct('light.flurlicht'), await now(R.Flur)]);
  const h = await ws.call({ type: 'house_rules/history', limit: 5 });
  ok(h.some((x) => /Licht Flur/.test(x.what) && /Intelligent/.test(x.why)), 'Verlauf erklärt: „Intelligent: …“', h.map((x) => `${x.what} | ${x.why}`));
  await set('switch.wasserkocher', 'on');
  ok(await until(async () => !(await isOn('light.flurlicht')), 8000), '„Aus lassen, solange …“: was es selbst eingeschaltet hat, geht aus');
  await set('switch.wasserkocher', 'off');
  // own hard rule on top: a while rule of the room decides first
  const rule = { id: 'own1', name: 'Hell', kind: 'while', enabled: true, trigger: [], when: [{ subject: 'switch.wasserkocher', verb: 'is_off' }], lights: [], variants: [], after: 'others', empty_after: 'off', action: { mode: 'on', brightness: 70, color: 'neutral' } };
  await plan(R.Flur, { rules: [rule] });
  ok(await until(async () => Math.abs((await pct('light.flurlicht')) - 70) <= 2, 8000), 'eigene Lichtregel geht vor (70 % statt 20 %)', await pct('light.flurlicht'));
  // "off" right before leaving does not count
  await plan(R.Flur, { rules: [] });
  await sleep(1500);
  const beforeOff = (await ws.call({ type: 'house_rules/light/learned', room: R.Flur })).samples;
  await api('POST', '/api/services/light/turn_off', { entity_id: 'light.flurlicht' });
  await sleep(600);
  const withOff = (await ws.call({ type: 'house_rules/light/learned', room: R.Flur })).samples;
  ok(withOff === beforeOff + 1, `Ausschalten von Hand: erst ein Beispiel (${beforeOff} → ${withOff})`, { recent: (await ws.call({ type: 'house_rules/light/learned', room: R.Flur })).recent, light: await st('light.flurlicht'), now: await now(R.Flur) });
  await set('binary_sensor.praesenz_flur', 'off');
  await sleep(2500);
  const after = (await ws.call({ type: 'house_rules/light/learned', room: R.Flur })).samples;
  ok(after === beforeOff, 'Ausschalten und dann gehen: zählt doch nicht', { before, beforeOff, withOff, after });
  await ws.call({ type: 'house_rules/light/forget', room: R.Flur });
  ok((await ws.call({ type: 'house_rules/light/learned', room: R.Flur })).samples === 0, '„Gelerntes vergessen“');
});

await test('Alarm-Assistent (Server)', async () => {
  const sug = await ws.call({ type: 'house_rules/assistant/suggest', feature: 'alarm' });
  ok(sug.sensors.some((d) => d.entity_id === 'binary_sensor.haustuer') && sug.night.includes('binary_sensor.fenster_kueche') && sug.home.includes('binary_sensor.haustuer'), 'Vorschlag: Sensoren der Räume, Nacht = Türen+Fenster, Zuhause = Türen', sug);
  const res = await ws.call({ type: 'house_rules/assistant/apply', feature: 'alarm', answers: { sensors: ['binary_sensor.haustuer', 'binary_sensor.fenster_kueche'], entry_delay: 20, exit_delay: 40, persons: 'everyone', flash: false, notify_disarm: false, arm_away: true, code: '2468' } });
  const al = (await snapshot()).alarm;
  const m = al.config.modes;
  ok(res.ok && al.config.enabled && m.away.sensors.length === 2 && m.night.sensors.length === 2 && m.home.sensors.join() === 'binary_sensor.haustuer', 'Arten mit den gewählten Sensoren', m);
  ok(m.away.entry_delay === 20 && m.away.exit_delay === 40 && m.night.exit_delay === 0 && m.away.auto.arm_away === true && m.away.lights.mode === 'none', 'Verzögerungen, automatisch scharf, kein Blinken', m.away);
  ok(al.config.has_code && al.config.confirm === 'pin' && al.config.notify_disarm === false && !al.config.buttons.includes('disarm'), 'PIN gesetzt (nur als Hash), kein Knopf „Alarm aus“', { has_code: al.config.has_code, confirm: al.config.confirm, buttons: al.config.buttons });
  ok(!JSON.stringify(await snapshot()).includes('2468'), 'PIN steht nirgends im Klartext');
  ok((await snapshot()).setup.assistants.alarm.done, 'Flag: eingerichtet');
  await ws.call({ type: 'house_rules/alarm/config', config: { code: null, confirm: 'none', notify_disarm: true, buttons: ['disarm', 'silence', 'camera'], enabled: false } });
});

await test('Fenster-, Urlaub-, Saugroboter-, Hausmodus-Assistent (Server)', async () => {
  let sug = await ws.call({ type: 'house_rules/assistant/suggest', feature: 'window_warning' });
  ok(sug.suggested.includes('binary_sensor.haustuer') && sug.windows.length > 0, 'Fenster-Warnung: Haustür vorgeschlagen, Fenster gezählt', sug.suggested);
  await ws.call({ type: 'house_rules/assistant/apply', feature: 'window_warning', answers: { doors: ['binary_sensor.haustuer'], only_last: false, lights: true, announce: false, notify: true, timeout: 15 } });
  snap = await snapshot();
  const c = snap.window_warning.config;
  ok(snap.features.window_warning && c.doors.join() === 'binary_sensor.haustuer' && !c.only_last && c.lights.mode === 'red' && c.lights.entities.includes('light.flurlicht') && c.announce.mode === 'none' && c.notify.on && c.timeout === 15, 'Fenster-Warnung eingerichtet (Licht im Raum der Tür)', c);

  sug = await ws.call({ type: 'house_rules/assistant/suggest', feature: 'vacation' });
  ok(sug.rooms.some((r) => r.id === R.Wohnzimmer && !r.plan_on), 'Urlaub: Räume mit Licht, Wohnzimmer noch ohne Lichtplan', sug.rooms);
  await ws.call({ type: 'house_rules/assistant/apply', feature: 'vacation', answers: { rooms: [R.Wohnzimmer], smart: true, never: { on: true, from: '10:00', to: '15:00' }, brightness: 60 } });
  snap = await snapshot();
  const wp = snap.plans.light[R.Wohnzimmer];
  ok(snap.features.vacation && wp.on && wp.vacation.on && wp.vacation.brightness === 60 && wp.empty.mode === 'keep' && wp.manual === 'none', 'Urlaub: Wohnzimmer nur für den Urlaub eingeschaltet, im Alltag ändert sich nichts', wp);
  const sim = await ws.call({ type: 'house_rules/sim/view' });
  ok(sim.config.smart && sim.config.dark.never && sim.config.dark.never_from === '10:00', 'feste Grenze „nie zwischen 10 und 15 Uhr“', sim.config.dark);

  sug = await ws.call({ type: 'house_rules/assistant/suggest', feature: 'vacuum' });
  ok(sug.vacuums.some((v) => v.entity_id === 'vacuum.robo') && sug.sensors.length > 0, 'Saugroboter gefunden', sug.vacuums);
  await ws.call({ type: 'house_rules/assistant/apply', feature: 'vacuum', answers: { vacuums: ['vacuum.robo'], sensors: 'all', after: 3 } });
  snap = await snapshot();
  ok(snap.features.vacuum && snap.cleaning.vacuums.join() === 'vacuum.robo' && snap.cleaning.after === 3, 'Saugroboter-Pause eingerichtet', snap.cleaning);

  sug = await ws.call({ type: 'house_rules/assistant/suggest', feature: 'mode_auto' });
  ok(sug.current.away && Array.isArray(sug.night), 'Hausmodus: aktuelle Einstellung', sug.current);
  await ws.call({ type: 'house_rules/assistant/apply', feature: 'mode_auto', answers: { away: { on: true, for: '10m' }, sleep: { on: false }, vacation: { on: true } } });
  snap = await snapshot();
  ok(snap.mode_auto.enabled && snap.mode_auto.modes.away.for === '10m' && snap.mode_auto.modes.vacation.on && !snap.mode_auto.modes.sleep.on, 'Hausmodus automatisch eingerichtet', snap.mode_auto.modes);
  const a = snap.setup.assistants;
  ok(a.window_warning.done && a.vacation.done && a.vacuum.done && a.mode_auto.done, 'alle Flags gesetzt', a);
  let err = '';
  await ws.call({ type: 'house_rules/assistant/apply', feature: 'nope', answers: {} }).catch((e) => (err = e.message));
  ok(/invalid_format|not a valid/.test(err), 'unbekannte Funktion abgelehnt', err);
});

// ---------------------------------------------------------------- back to neutral (for the other test scripts)
snap = await snapshot();
for (const r of snap.rooms) await plan(r.id, { on: false, rules: [], smart: { mode: 'off' }, vacation: { ...snap.plans.light[r.id].vacation, on: false } });
await ws.call({ type: 'house_rules/mode_auto/set', mode: 'away', config: { for: '' } });
await ws.call({ type: 'house_rules/mode_auto/set', mode: 'vacation', config: { on: false } });
await ws.call({ type: 'house_rules/sim/set', config: { dark: { never: false } } });
await ws.call({ type: 'house_rules/room/save', room: { id: R.Flur, empty_after: flur0.empty_after ?? 5 } });
await ws.call({ type: 'house_rules/features/set', features: features0 });
for (const f of ['light', 'alarm', 'window_warning', 'vacation', 'vacuum', 'mode_auto']) await ws.call({ type: 'house_rules/assistant/mark', feature: f, done: false, dismissed: false });
await set('binary_sensor.praesenz_flur', 'off');
await set('light.flurlicht', 'off');
ws.close();
console.log(`\n${failures() ? `${failures()} FEHLER` : 'alles ok'}`);
process.exit(failures() ? 1 : 0);
