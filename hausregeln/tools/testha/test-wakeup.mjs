// The automatic house mode around "Schlafen" against the isolated test HA (port 8124): restart and sensor flicker
// keep the night, an unavailable lamp does not block "alle Lichter aus", "Gäste" comes back after the night,
// "Aufstehen erkennen" keeps sleep over a night trip and its settings/permissions. The detection itself (clock,
// learning, buttons) is tested in test_wakeup.py. Runs after test-engine.mjs (that sets up areas, persons, the
// integration). Usage: node tools/testha/test-wakeup.mjs
import { token, wsConnect, rest, sleep, ok, failures, until, userToken } from './lib.mjs';

const tok = await token();
const ws = await wsConnect(tok);
const api = rest(tok);
const set = (entity_id, state, attributes = {}) => ws.call({ type: 'hr_fake/set', entity_id, state, attributes });
const snap = () => ws.call({ type: 'house_rules/snapshot' });
const mode = async () => (await snap()).mode;
const BED = 'binary_sensor.fp2_essbereich';
const sleepCfg = (config) => ws.call({ type: 'house_rules/mode_auto/set', mode: 'sleep', config });
const hist = async (n = 8) => (await ws.call({ type: 'house_rules/history', limit: n })).map((h) => `${h.what} | ${h.why}`);

await until(async () => (await ws.call({ type: 'house_rules/info' }).catch(() => null))?.loaded, 60000, 500);
await until(async () => !(await snap()).starting, 150000, 1000);
await ws.call({ type: 'house_rules/mode_auto/set', mode: '_enabled', config: { enabled: true } });
// someone is at home; "Weg" and "Urlaub" stay out of the way (put back at the end)
await api('POST', '/api/services/device_tracker/see', { dev_id: 'alex_handy', location_name: 'home' });
const before = (await snap()).mode_auto.modes;
for (const m of ['away', 'vacation']) await ws.call({ type: 'house_rules/mode_auto/set', mode: m, config: { on: false } });
await ws.call({ type: 'house_rules/mode_auto/set', mode: 'guests', config: { on: false } });
await ws.call({ type: 'house_rules/wakeup/set', config: { on: false, beds: [] } });
await set(BED, 'off');
await sleepCfg({ on: false, when: [], for: '', end: { on: false, when: [] } });
await ws.call({ type: 'house_rules/mode/set', mode: 'home' });

console.log('— Restart und Flackern');
{
  await sleepCfg({ on: true, when: [{ subject: BED, verb: 'is_occupied', for: '10m' }, { subject: 'person:someone', verb: 'is_home' }], for: '5m' });
  await set(BED, 'on');
  await ws.call({ type: 'house_rules/mode/set', mode: 'sleep' });
  ok((await mode()) === 'sleep', 'Schlafen (von Hand), Bett belegt');
  // a drop-out of the bed sensor for a few seconds: sleep stays (it used to end at once)
  await set(BED, 'off');
  await sleep(4000);
  await set(BED, 'on');
  await sleep(35000);
  ok((await mode()) === 'sleep', 'Bett-Sensor 4 s weg → Schlafen bleibt');
  // restart of the integration: every waiting time starts from zero, the sensor "changed just now"
  const entry = (await api('GET', '/api/config/config_entries/entry')).body.find((x) => x.domain === 'roomwise').entry_id;
  await api('POST', `/api/config/config_entries/entry/${entry}/reload`);
  await until(async () => (await ws.call({ type: 'house_rules/info' }).catch(() => null))?.loaded, 60000, 500);
  ok((await snap()).starting === true, 'nach dem Neustart: Startphase');
  await until(async () => !(await snap()).starting, 150000, 2000);
  await sleep(35000); // at least one evaluation after the start-up phase
  ok((await mode()) === 'sleep', 'nach dem Neustart (Wartezeiten noch nicht um) → Schlafen bleibt', await hist());
  // really up: the conditions fail for longer than the grace → home
  await set(BED, 'off');
  ok(await until(async () => (await mode()) === 'home', 120000, 2000), 'Bett leer (über die Kulanz hinaus) → Zuhause');
}

console.log('— nicht erreichbare Lampe');
{
  const area0 = (await ws.call({ type: 'config/entity_registry/get', entity_id: 'light.nachtlicht_diele' })).area_id ?? null;
  await ws.call({ type: 'config/entity_registry/update', entity_id: 'light.nachtlicht_diele', area_id: (await ws.call({ type: 'config/area_registry/list' })).find((a) => a.name === 'Flur').area_id });
  await api('POST', '/api/services/light/turn_off', { entity_id: 'light.flurlicht' });
  await set('light.nachtlicht_diele', 'unavailable');
  await sleep(4000); // inventory rebuild after the registry change
  await sleepCfg({ on: true, when: [{ subject: 'all:light@flur', verb: 'is_off' }, { subject: 'person:someone', verb: 'is_home' }], for: '' });
  ok(await until(async () => (await mode()) === 'sleep', 45000, 1000), '„alle Lichter im Flur aus“ hält, obwohl eine Lampe nicht erreichbar ist');
  await sleepCfg({ on: false, when: [] });
  await ws.call({ type: 'house_rules/mode/set', mode: 'home' });
  await set('light.nachtlicht_diele', 'off');
  await ws.call({ type: 'config/entity_registry/update', entity_id: 'light.nachtlicht_diele', area_id: area0 });
}

console.log('— Gäste nach der Nacht');
{
  await set(BED, 'off');
  await sleepCfg({ on: true, when: [{ subject: BED, verb: 'is_occupied' }, { subject: 'person:someone', verb: 'is_home' }], for: '' });
  await ws.call({ type: 'house_rules/mode/set', mode: 'guests' });
  await set(BED, 'on');
  ok(await until(async () => (await mode()) === 'sleep', 45000, 1000), 'Gäste (von Hand) → nachts Schlafen');
  await set(BED, 'off');
  ok(await until(async () => (await mode()) !== 'sleep', 120000, 2000) && (await mode()) === 'guests', 'nach der Nacht wieder Gäste, nicht Zuhause', await hist());
  await ws.call({ type: 'house_rules/mode/set', mode: 'home' });
}

console.log('— Aufstehen erkennen');
{
  let ma = await ws.call({ type: 'house_rules/wakeup/set', config: { on: true, action: 'direct', feedback: true, beds: [BED] } });
  ok(ma.wakeup?.on && ma.wakeup.found_beds.some((b) => b.entity_id === BED), 'eingeschaltet, Bett gewählt', ma.wakeup);
  ok(ma.wakeup.learned?.work?.need === 10, 'Startwert: Bett 10 Min. leer', ma.wakeup.learned);
  ma = await ws.call({ type: 'house_rules/wakeup/set', config: { action: 'quatsch', beds: ['light.flurlicht', BED] } });
  ok(ma.wakeup.action === 'direct' && ma.wakeup.beds.length === 1, 'ungültige Werte werden verworfen', ma.wakeup);
  await set(BED, 'on');
  ok(await until(async () => (await mode()) === 'sleep', 45000, 1000), 'Bett belegt → Schlafen');
  // night trip: the bed is empty, a start condition fails – with "Aufstehen erkennen" that does not end sleep
  await set(BED, 'off');
  await sleep(75000);
  ok((await mode()) === 'sleep', 'Bett 75 s leer (Nachtgang) → Schlafen bleibt', await hist());
  const w = (await snap()).mode_auto.wakeup;
  ok(/Bett seit \d+ Min\. leer/.test(w.status), 'Status sagt, worauf es wartet', w.status);
  const ma2 = (await snap()).mode_auto;
  ok(ma2.target === 'sleep' && /aufgestanden/.test(ma2.why), 'Ziel bleibt Schlafen, „bis erkannt wird, dass ihr aufgestanden seid“', { target: ma2.target, why: ma2.why });
  await set(BED, 'on');
  // permissions: only admins change or reset it
  const tabletTok = await userToken(tok);
  const tablet = await wsConnect(tabletTok);
  const denied = async (msg) => tablet.call(msg).then(() => false, () => true);
  ok(await denied({ type: 'house_rules/wakeup/set', config: { on: false } }), 'Bewohner darf nicht einstellen');
  ok(await denied({ type: 'house_rules/wakeup/reset' }), 'Bewohner darf nicht zurücksetzen');
  tablet.close();
  // a button from a stale or foreign message does nothing
  await api('POST', '/api/events/mobile_app_notification_action', { action: 'HR_WAKE_YES_deadbeef' });
  await sleep(1000);
  ok((await mode()) === 'sleep', 'fremder/alter Knopf → nichts');
  ma = await ws.call({ type: 'house_rules/wakeup/reset' });
  ok(ma.wakeup.detections === 0 && ma.wakeup.trips === 0, 'Gelerntes vergessen');
  // off again: sleep follows its start conditions as before
  await ws.call({ type: 'house_rules/wakeup/set', config: { on: false, beds: [] } });
  await sleepCfg({ on: false, when: [], end: { on: false, when: [] } });
  await ws.call({ type: 'house_rules/mode/set', mode: 'home' });
  await set(BED, 'off');
}

for (const m of ['away', 'vacation']) await ws.call({ type: 'house_rules/mode_auto/set', mode: m, config: { on: before[m].on } });
ws.close();
console.log(failures() ? `\n${failures()} FEHLER` : '\nALLES OK');
process.exit(failures() ? 1 : 0);
