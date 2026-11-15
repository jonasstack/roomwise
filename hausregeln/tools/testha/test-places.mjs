// "Wo ist wer" against the isolated test Home Assistant (port 8124): fake GPS trackers move along fictional tracks.
// Learning from seeded recorder history, prediction, arrival time, rules about places, admin rights, Nominatim off.
// Usage: node tools/testha/test-places.mjs [--quick]   (--quick skips the 5-minute wait for "stopped at a spot")
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { token, wsConnect, rest, sleep, ok, failures, until, userToken } from './lib.mjs';

const tok = await token();
const ws = await wsConnect(tok);
const api = rest(tok);
const quick = process.argv.includes('--quick');
const set = (entity_id, state, attributes = {}) => ws.call({ type: 'hr_fake/set', entity_id, state, attributes });
const st = async (e) => (await api('GET', `/api/states/${e}`)).body;
const places = () => ws.call({ type: 'house_rules/places/get' });
const person = async (id) => (await places()).persons.find((p) => p.entity_id === id);
const ROBIN = 'person.robin_beispiel';
const KIM = 'person.kim_beispiel';
const HOME = [52.52, 13.4];
const WORK = [52.6, 13.5];
const move = (tracker, [lat, lon], speed) => set(tracker, '', { latitude: lat, longitude: lon, gps_accuracy: 10, ...(speed != null ? { speed } : {}) });
const along = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];

// ---------------------------------------------------------------- setup (idempotent)
let info = await ws.call({ type: 'house_rules/info' }).catch(() => null);
if (!info?.loaded) {
  const flow = await api('POST', '/api/config/config_entries/flow', { handler: 'house_rules' });
  await api('POST', `/api/config/config_entries/flow/${flow.body.flow_id}`, {});
  info = await until(async () => {
    const i = await ws.call({ type: 'house_rules/info' }).catch(() => null);
    return i?.loaded && i;
  });
}
ok(info?.loaded, `integration läuft (${info?.version})`);
await until(async () => (await ws.call({ type: 'house_rules/snapshot' })).devices.length > 10, 90000, 1000);
await until(async () => await st('device_tracker.handy_robin').then((s) => s?.state), 30000, 500);
ok(!!(await st('device_tracker.handy_robin'))?.attributes?.latitude, 'hr_fake: GPS-Tracker mit Position');

const zones = await ws.call({ type: 'zone/list' });
if (!zones.some((z) => z.name === 'Arbeit')) await ws.call({ type: 'zone/create', name: 'Arbeit', latitude: WORK[0], longitude: WORK[1], radius: 300, icon: 'mdi:briefcase' });
await move('device_tracker.handy_robin', HOME);
await move('device_tracker.handy_kim', HOME);
const list = await ws.call({ type: 'person/list' });
for (const [name, tr] of [
  ['Robin Beispiel', 'device_tracker.handy_robin'],
  ['Kim Beispiel', 'device_tracker.handy_kim'],
])
  if (!list.storage.some((p) => p.name === name)) await ws.call({ type: 'person/create', name, device_trackers: [tr] });
await until(async () => (await st(ROBIN))?.state === 'home', 20000);
// only the two test persons count (other tests leave persons without GPS behind)
const before = (await ws.call({ type: 'house_rules/snapshot' })).settings.persons_excluded ?? [];
const others = (await ws.call({ type: 'house_rules/snapshot' })).residents.map((r) => r.entity_id).filter((e) => ![ROBIN, KIM].includes(e));
await ws.call({ type: 'house_rules/settings/set', settings: { persons_excluded: others } });
ok(await until(async () => (await places()).persons.filter((p) => [ROBIN, KIM].includes(p.entity_id)).length === 2, 20000), 'beide Testpersonen in „Wo ist wer“', (await places()).persons);
const snap = await ws.call({ type: 'house_rules/snapshot' });
for (const r of snap.rules) await ws.call({ type: 'house_rules/rule/delete', rule_id: r.id });
await set('light.badlicht', 'off');
await set('light.kuechenlicht', 'off');
await set('light.sofalicht', 'off');
await ws.call({ type: 'house_rules/places/settings', nominatim: false, learn: true });

console.log('\n# Lernen aus dem Verlauf');
{
  const seed = fileURLToPath(new URL('./seed_places.py', import.meta.url));
  execFileSync('docker', ['cp', seed, 'hr-test-ha:/tmp/seed_places.py']);
  const out = JSON.parse(execFileSync('docker', ['exec', 'hr-test-ha', 'python3', '/tmp/seed_places.py', ROBIN]).toString());
  ok(out.rows > 500, `Verlauf eingespielt (${out.rows} Positionen, 3 Wochen)`);
  const res = await ws.call({ type: 'house_rules/places/relearn', days: 30 });
  ok(res.ok && res.fixes >= out.rows - 5, 'neu gelernt aus dem Recorder', res);
  const v = await places();
  const sport = v.learned.find((p) => Math.abs(p.lat - 52.5) < 0.002 && Math.abs(p.lon - 13.52) < 0.003);
  ok(sport && sport.visits >= 5, 'Sportplatz als gelernter Ort (≥ 5 Besuche)', v.learned);
  ok(!v.learned.some((p) => Math.abs(p.lat - WORK[0]) < 0.004 || Math.abs(p.lat - HOME[0]) < 0.002), 'Zonen werden nicht als gelernte Orte geführt', v.learned);
  ok(v.stats.trips >= 45, `Wege gelernt (${v.stats.trips})`, v.stats);
  ok(sport?.typical?.stay_min >= 45 && sport.typical.stay_min <= 75, 'typische Aufenthaltsdauer ~1 Std.', sport?.typical);

  // names: admins only
  const tablet = await wsConnect(await userToken(tok, 'tablet'));
  const denied = await tablet.call({ type: 'house_rules/places/name', place_id: sport.id, name: 'Darf nicht' }).then(() => null, (e) => e.message);
  ok(denied && /unauthorized/i.test(denied), 'ohne Admin: Ort umbenennen verweigert', denied);
  const denied2 = await tablet.call({ type: 'house_rules/places/settings', nominatim: true }).then(() => null, (e) => e.message);
  ok(denied2 && /unauthorized/i.test(denied2), 'ohne Admin: Einstellungen verweigert', denied2);
  const seen = await tablet.call({ type: 'house_rules/places/get' }).catch(() => null);
  ok(seen?.persons?.length >= 2, 'ohne Admin: Übersicht lesen erlaubt');
  tablet.close();
  const named = await ws.call({ type: 'house_rules/places/name', place_id: sport.id, name: 'Sportplatz' });
  ok(named.learned.find((p) => p.id === sport.id)?.label === 'Sportplatz', 'Admin: Ort benannt');
  const d = await ws.call({ type: 'house_rules/rule/describe', rule: { type: 'when', when: [{ subject: 'person:robin_beispiel', verb: 'enters_zone', zone: sport.id }], and: [], then: [{ subject: 'light.badlicht', verb: 'turn_on' }], only: [] } });
  ok(/Sportplatz/.test(d.sentence), 'Satz nennt den gelernten Ort', d.sentence);
  globalThis.sportId = sport.id;
}

console.log('\n# Regeln: Heimweg, Ankunft, unterwegs seit');
const save = async (rule) => (await ws.call({ type: 'house_rules/rule/save', rule: { type: 'when', and: [], only: [], options: { manual_pause: '' }, ...rule } })).rule;
{
  await save({ name: 'Heimweg', when: [{ subject: 'person:robin_beispiel', verb: 'heading_home', value: 60 }], then: [{ subject: 'light.badlicht', verb: 'turn_on' }] });
  await save({ name: 'Gleich da', when: [{ subject: 'person:robin_beispiel', verb: 'arrives_within', value: 10 }], then: [{ subject: 'light.kuechenlicht', verb: 'turn_on' }] });
  await save({ name: 'Unterwegs', when: [{ subject: 'person:robin_beispiel', verb: 'moving_for', value: 0.02 }], then: [{ subject: 'light.sofalicht', verb: 'turn_on' }] });
  // at work, then on the way home
  await move('device_tracker.handy_robin', WORK);
  ok(await until(async () => (await st(ROBIN)).state === 'Arbeit'), 'Robin ist bei der Arbeit');
  ok(await until(async () => (await person(ROBIN))?.line?.startsWith('Arbeit · seit')), 'Statuszeile „Arbeit · seit …“', await person(ROBIN));
  ok((await st('light.badlicht')).state === 'off', 'bei der Arbeit: noch kein Heimweg');
  await sleep(125000); // more than driving through: the way home starts at work
  for (const f of [0.08, 0.16, 0.24, 0.32]) {
    await move('device_tracker.handy_robin', along(WORK, HOME, f), 12);
    await sleep(700);
  }
  const p = await ws.call({ type: 'house_rules/places/predict', person_id: ROBIN });
  ok(p.destination === 'home' && p.probability >= 0.6, 'Vorhersage: nach Hause', p);
  ok(p.eta_min >= 8 && p.eta_min <= 25, `Ankunft in ca. ${p.eta_min} Min.`, p);
  ok(await until(async () => (await st('light.badlicht')).state === 'on'), 'Regel „kommt wahrscheinlich nach Hause“ ausgelöst');
  ok(await until(async () => (await st('light.sofalicht')).state === 'on'), 'Regel „seit … unterwegs“ ausgelöst');
  const line = (await person(ROBIN))?.line ?? '';
  ok(/^Unterwegs · wahrscheinlich nach Hause · ca\. \d+ Min\.$/.test(line), `Statuszeile „${line}“`);
  ok((await st('light.kuechenlicht')).state === 'off', 'noch weit: „in unter 10 Min.“ nicht', p);
  // how Robin travels: speed (43 km/h) → car; the phone's activity sensor wins; a bike tracker moving along
  const r1 = await person(ROBIN);
  ok(r1?.mode === 'car' && r1.mode_basis === 'speed' && r1.mode_confidence > 0 && r1.mode_confidence < 0.6, 'Art: nach Tempo Auto (unsicher)', r1);
  ok(r1?.prediction?.distance_km > 3 && r1.updated && p.mode === 'car', 'Restweg, letzte Meldung, Art auch in predict', { r1, p });
  await set('sensor.handy_robin_detected_activity', 'on_bicycle');
  ok(await until(async () => (await person(ROBIN))?.mode_basis === 'activity'), 'Handy-Sensor on_bicycle zählt sofort', await person(ROBIN));
  ok((await person(ROBIN)).mode === 'bike' && (await person(ROBIN)).mode_confidence >= 0.8, 'Art: Fahrrad (Handy-Sensor)', await person(ROBIN));
  await set('sensor.handy_robin_detected_activity', 'still');
  const here = along(WORK, HOME, 0.33);
  await move('device_tracker.testrad', here);
  await move('device_tracker.handy_robin', here, 12);
  ok(await until(async () => (await person(ROBIN))?.mode_basis === 'vehicle'), 'Rad-Tracker fährt mit', await person(ROBIN));
  ok((await person(ROBIN)).mode === 'bike', 'Art: Fahrrad (Fahrzeug-Tracker)', await person(ROBIN));
  await move('device_tracker.testrad', HOME);
  for (const f of [0.5, 0.62, 0.74, 0.84]) {
    await move('device_tracker.handy_robin', along(WORK, HOME, f), 12);
    await sleep(400);
  }
  const p2 = await ws.call({ type: 'house_rules/places/predict', person_id: ROBIN });
  ok(p2.eta_min < p.eta_min, `näher: Ankunft früher (${p2.eta_min} Min.)`, p2);
  ok(await until(async () => (await st('light.kuechenlicht')).state === 'on'), 'Regel „in unter 10 Min. zuhause“ ausgelöst', p2);
  const t = await ws.call({ type: 'house_rules/rule/test', rule: { type: 'when', when: [{ subject: 'time', verb: 'at', time: '07:00' }], and: [{ subject: 'person:robin_beispiel', verb: 'is_heading_home' }], then: [{ subject: 'light.badlicht', verb: 'turn_off' }], only: [] } });
  ok(t.checks.find((c) => c.section === 'and')?.ok === true, 'Bedingung „wahrscheinlich auf dem Heimweg“ stimmt', t.checks);
  // everybody on the way home: Kim is at home (does not count), Robin is on the way → true
  const all = await ws.call({ type: 'house_rules/rule/test', rule: { type: 'while', when: [{ subject: 'person:everyone', verb: 'is_heading_home' }], and: [], then: [{ subject: 'light.badlicht', verb: 'turn_on' }], only: [] } });
  ok(all.checks[0]?.ok === true, '„alle sind auf dem Heimweg“: wer zuhause ist, zählt nicht', all.checks);
  const near = await ws.call({ type: 'house_rules/rule/test', rule: { type: 'while', when: [{ subject: 'person:someone', verb: 'is_near', distance: 5 }], and: [], then: [{ subject: 'light.badlicht', verb: 'turn_on' }], only: [] } });
  ok(near.checks[0]?.ok === true, '„jemand nähert sich“ (5 km, kommt näher)', near.checks);
  await move('device_tracker.handy_robin', HOME);
  ok(await until(async () => (await st(ROBIN)).state === 'home'), 'Robin zuhause');
  ok(await until(async () => (await person(ROBIN))?.state === 'zone' && !(await ws.call({ type: 'house_rules/places/predict', person_id: ROBIN })).destination), 'zuhause: keine Vorhersage mehr');
  const detail = await ws.call({ type: 'house_rules/places/person', person_id: ROBIN });
  ok(Array.isArray(detail.timeline) && detail.trips.length === 20 && detail.trips[0].to && detail.person?.entity_id === ROBIN, 'Detail: Tagesverlauf, letzte Wege, Person', detail);
}

console.log('\n# verlässt einen gelernten Ort');
{
  const id = globalThis.sportId;
  await save({ name: 'Sport aus', when: [{ subject: 'person:kim_beispiel', verb: 'leaves_zone', zone: id }], then: [{ subject: 'light.badlicht', verb: 'turn_off' }] });
  const inside = await ws.call({ type: 'house_rules/rule/test', rule: { type: 'while', when: [{ subject: 'person:kim_beispiel', verb: 'in_zone', zone: id }], and: [], then: [{ subject: 'light.badlicht', verb: 'turn_on' }], only: [] } });
  ok(inside.checks[0]?.ok === false, 'Kim ist nicht am Sportplatz', inside.checks);
}

if (!quick) {
  console.log('\n# Anhalten an einem unbekannten Ort (5 Min. warten), Nominatim aus');
  await ws.call({ type: 'hr_fake/set', entity_id: 'sensor.handy_robin_geocoded_location', state: 'Musterweg 3, 12345 Musterstadt, Deutschland' });
  const spotA = [52.47, 13.31];
  const spotB = [52.46, 13.45];
  await move('device_tracker.handy_robin', spotA, 0);
  await move('device_tracker.handy_kim', spotB, 0);
  await sleep(150000);
  await move('device_tracker.handy_robin', [spotA[0] + 0.0001, spotA[1]], 0);
  await move('device_tracker.handy_kim', [spotB[0] + 0.0001, spotB[1]], 0);
  await sleep(165000);
  await move('device_tracker.handy_robin', [spotA[0] - 0.0001, spotA[1]], 0);
  await move('device_tracker.handy_kim', [spotB[0] - 0.0001, spotB[1]], 0);
  const a = await until(async () => ((await person(ROBIN))?.state === 'stay' ? person(ROBIN) : null), 20000, 1000);
  ok(a?.line?.startsWith('Musterweg 3 · seit'), 'steht: Straße aus dem Handy-Sensor', a);
  const s = await person(KIM);
  ok(s?.state === 'stay' && s.line.startsWith('Unbekannter Ort · seit'), 'ohne Sensor und ohne Nominatim: „Unbekannter Ort“', s);
  ok((await places()).stats.nominatim_requests === 0, 'Nominatim ist aus: keine Anfrage nach draußen');
  await move('device_tracker.handy_robin', HOME);
  await move('device_tracker.handy_kim', HOME);
}

// clean up
for (const r of (await ws.call({ type: 'house_rules/snapshot' })).rules) await ws.call({ type: 'house_rules/rule/delete', rule_id: r.id });
await ws.call({ type: 'house_rules/settings/set', settings: { persons_excluded: before } });
// the test persons go again (other tests count every person)
for (const p of (await ws.call({ type: 'person/list' })).storage.filter((x) => / Beispiel$/.test(x.name))) await ws.call({ type: 'person/delete', person_id: p.id });
ws.close();
console.log(failures() ? `\n${failures()} FEHLER` : '\nalles ok');
process.exit(failures() ? 1 : 0);
