// Devices the user corrects (exclude, other kind, own devices), vehicle-safe detection and object alarms
// ("Weitere Alarme"), against the isolated test Home Assistant (port 8124). Fake devices: tools/testha/hr_fake
// (a car and a bike with GPS trackers, a vibration sensor in the garage). Usage: node tools/testha/test-objects.mjs
import { token, wsConnect, rest, sleep, ok, failures, until, userToken } from './lib.mjs';

const tok = await token();
const ws = await wsConnect(tok);
const api = rest(tok);
const set = (entity_id, state, attributes = {}) => ws.call({ type: 'hr_fake/set', entity_id, state, attributes });
const st = async (e) => (await api('GET', `/api/states/${e}`)).body;
const calls = (clear = false) => ws.call({ type: 'hr_fake/calls', clear });
const snapshot = () => ws.call({ type: 'house_rules/snapshot' });
const devSet = (changes) => ws.call({ type: 'house_rules/devices/set', changes });
const action = (a) => api('POST', '/api/events/mobile_app_notification_action', { action: a });

// ---------------------------------------------------------------- setup (idempotent, like test-engine)
const areas = await ws.call({ type: 'config/area_registry/list' });
const area = async (name) => (areas.find((a) => a.name === name) ?? (await ws.call({ type: 'config/area_registry/create', name }))).area_id;
const A = { flur: await area('Flur'), kueche: await area('Küche'), bad: await area('Bad'), wohnzimmer: await area('Wohnzimmer') };
const place = {
  flur: ['light.flurlicht', 'binary_sensor.haustuer', 'binary_sensor.praesenz_flur'],
  // the same rooms as test-engine places them (no registry change when it runs next)
  kueche: ['light.kuechenlicht', 'binary_sensor.fenster_kueche', 'climate.heizung_kueche', 'binary_sensor.fp2_alles', 'binary_sensor.fp2_kochfeld', 'binary_sensor.fp2_essbereich'],
  bad: ['binary_sensor.fenster_bad', 'binary_sensor.badtuer', 'climate.heizung_bad', 'light.badlicht', 'sensor.temp_bad'],
  wohnzimmer: ['light.sofalicht', 'binary_sensor.fenster_wohnzimmer'],
};
for (const [r, ents] of Object.entries(place))
  for (const e of ents) await ws.call({ type: 'config/entity_registry/update', entity_id: e, area_id: A[r] }).catch((err) => console.log('area', e, err.message));
await api('POST', '/api/services/device_tracker/see', { dev_id: 'alex_handy', location_name: 'home' });
await api('POST', '/api/services/device_tracker/see', { dev_id: 'sam_handy', location_name: 'not_home' });
const persons = await ws.call({ type: 'person/list' });
for (const [name, tr] of [
  ['Alex Test', 'device_tracker.alex_handy'],
  ['Sam Test', 'device_tracker.sam_handy'],
])
  if (!persons.storage.some((p) => p.name === name)) await ws.call({ type: 'person/create', name, device_trackers: [tr] });
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
await until(async () => (await snapshot()).devices.length > 10, 90000, 1000);
// object alarms wait the start-up phase like the house alarm
await until(async () => !(await snapshot()).alarm.settling, 120000, 1000);
await sleep(1500);

const snap0 = await snapshot();
const features0 = snap0.features;
const alarm0 = snap0.alarm.config;
const feat = (features) => ws.call({ type: 'house_rules/features/set', features });
// fresh state: no own corrections of the tested devices, no object alarms
const TESTED = ['binary_sensor.fenster_bad', 'binary_sensor.badtuer', 'binary_sensor.haustuer', 'light.badlicht', 'binary_sensor.garage_erschuetterung', 'binary_sensor.testauto_tuer', 'sensor.temp_bad'];
await devSet(TESTED.map((entity_id) => ({ entity_id, reset: true })));
for (const o of snap0.objects ?? []) await ws.call({ type: 'house_rules/objects/delete', object_id: o.id });
for (const e of ['binary_sensor.fenster_bad', 'binary_sensor.fenster_kueche', 'binary_sensor.fenster_wohnzimmer', 'binary_sensor.haustuer', 'binary_sensor.garage_erschuetterung', 'binary_sensor.testrad_erschuetterung', 'switch.sirene', 'light.flurlicht']) await set(e, 'off');

const test = async (name, fn) => {
  console.log(`\n# ${name}`);
  try {
    await fn();
  } catch (e) {
    ok(false, `${name}: ${e.message}`);
  }
};
const dev = async () => Object.fromEntries((await snapshot()).devices.map((d) => [d.entity_id, d]));
const unused = async () => Object.fromEntries((await snapshot()).devices_unused.map((d) => [d.entity_id, d]));
const roomOf = (s, name) => s.rooms.find((r) => r.name === name);

await test('Fahrzeuge: nie Türen, Fenster oder Melder des Hauses', async () => {
  const d = await dev();
  const u = await unused();
  ok(d['device_tracker.testauto']?.kind === 'vehicle' && d['device_tracker.testrad']?.kind === 'vehicle', 'Auto und Fahrrad (GPS-Tracker) als Fahrzeug erkannt', await ws.call({ type: 'config/entity_registry/get', entity_id: 'device_tracker.testauto' }).then((r) => ({ dis: r.disabled_by, hid: r.hidden_by, cat: r.entity_category, dev: r.device_id, plat: r.platform }), (e) => e.message));
  ok(!d['device_tracker.handy_robin'] || d['device_tracker.handy_robin'].kind !== 'vehicle', 'ein Handy (Tracker „Handy …“) ist kein Fahrzeug');
  ok(!d['binary_sensor.testauto_tuer'] && !d['binary_sensor.testauto_fenster'] && !d['lock.testauto_verriegelung'] && !d['binary_sensor.testauto_bewegung'], 'Tür, Fenster, Schloss und Bewegung des Autos sind keine Geräte des Hauses');
  ok(u['binary_sensor.testauto_tuer']?.reason === 'vehicle' && u['binary_sensor.testauto_tuer']?.vehicle === 'Testauto' && u['binary_sensor.testauto_tuer']?.kind === 'door', 'Autotür steht als Teil von „Testauto“ in der Liste der nicht verwendeten', u['binary_sensor.testauto_tuer']);
  ok(u['binary_sensor.testrad_erschuetterung'] === undefined || u['binary_sensor.testrad_erschuetterung'].reason === 'vehicle', 'Erschütterung des Fahrrads gehört zum Fahrrad');
  const ww = await ws.call({ type: 'house_rules/window_warning/get' });
  ok(!ww.suggested_doors.includes('binary_sensor.testauto_tuer'), '„Front left door“ des Autos ist nicht die vorgeschlagene Haustür', ww.suggested_doors);
  ok(ww.suggested_doors.includes('binary_sensor.haustuer'), 'die Haustür schon');
  const s = await snapshot();
  ok(!Object.values(s.alarm.suggested).flat().some((e) => e.startsWith('binary_sensor.testauto') || e.startsWith('lock.')), 'Alarmanlage schlägt keine Sensoren des Autos vor', s.alarm.suggested);
  const sug = await ws.call({ type: 'house_rules/setup/suggest' });
  ok(!sug.window_warning.doors.some((x) => x.entity_id === 'binary_sensor.testauto_tuer') && !sug.window_warning.windows.some((x) => x.entity_id === 'binary_sensor.testauto_fenster'), 'Assistent: keine Autotür, kein Autofenster');
  // the user assigns it explicitly: then it counts
  await devSet([{ entity_id: 'binary_sensor.testauto_tuer', kind: 'door', room: A.flur }]);
  const d2 = await dev();
  ok(d2['binary_sensor.testauto_tuer']?.kind === 'door' && d2['binary_sensor.testauto_tuer']?.room === A.flur, 'ausdrücklich als Tür im Flur zugeordnet → zählt als Tür', d2['binary_sensor.testauto_tuer']);
  await devSet([{ entity_id: 'binary_sensor.testauto_tuer', reset: true }]);
  ok(!(await dev())['binary_sensor.testauto_tuer'], 'zurückgesetzt → wieder Teil des Autos');
});

await test('Nicht verwenden: zählt nirgends', async () => {
  await devSet([{ entity_id: 'binary_sensor.fenster_bad', hidden: true }, { entity_id: 'binary_sensor.haustuer', hidden: true }, { entity_id: 'light.badlicht', hidden: true }, { entity_id: 'sensor.temp_bad', hidden: true }]);
  const s = await snapshot();
  const d = Object.fromEntries(s.devices.map((x) => [x.entity_id, x]));
  const u = Object.fromEntries(s.devices_unused.map((x) => [x.entity_id, x]));
  ok(!d['binary_sensor.fenster_bad'] && u['binary_sensor.fenster_bad']?.reason === 'user', 'ausgeschlossen: nicht mehr unter den Geräten, in der Liste „nicht verwendet“', u['binary_sensor.fenster_bad']);
  ok(!Object.values(s.alarm.suggested).flat().includes('binary_sensor.fenster_bad') && !Object.values(s.alarm.suggested).flat().includes('binary_sensor.haustuer'), 'Alarmanlage schlägt es nicht mehr vor', s.alarm.suggested);
  const ww = await ws.call({ type: 'house_rules/window_warning/get' });
  ok(!ww.suggested_doors.includes('binary_sensor.haustuer'), 'Fenster-Warnung schlägt die ausgeschlossene Haustür nicht vor', ww.suggested_doors);
  const heat = s.plans.heating.rooms[A.bad];
  ok(heat && !heat.contacts.includes('binary_sensor.fenster_bad') && !heat.sensors.includes('sensor.temp_bad'), 'Heizung (gefunden im Bad): ohne das Fenster und ohne das Thermometer', heat);
  const sug = await ws.call({ type: 'house_rules/setup/suggest' });
  ok(!sug.rooms.find((r) => r.id === A.bad)?.lights.includes('light.badlicht'), 'Licht: ausgeschlossene Lampe gehört nicht mehr zum Bad (Lichtplan, Assistent)');
  ok(!roomOf(s, 'Flur').doors.includes('binary_sensor.haustuer'), 'Raumbelegung: Tür zählt nicht mehr für die Tür-Logik', roomOf(s, 'Flur').doors);
  // window warning: an excluded window never warns
  await feat({ window_warning: true });
  await ws.call({ type: 'house_rules/window_warning/set', config: { doors: ['binary_sensor.badtuer'], windows: 'all', only_last: false, delay: 0, timeout: 30, lights: { mode: 'none', entities: [] }, notify: { on: false } } });
  await set('binary_sensor.fenster_bad', 'on');
  await set('binary_sensor.badtuer', 'on');
  await sleep(800);
  ok(!(await ws.call({ type: 'house_rules/window_warning/get' })).active, 'Fenster-Warnung: nur ein ausgeschlossenes Fenster offen → keine Warnung');
  await set('binary_sensor.badtuer', 'off');
  await set('binary_sensor.fenster_wohnzimmer', 'on');
  await set('binary_sensor.badtuer', 'on');
  const v = await until(async () => { const x = await ws.call({ type: 'house_rules/window_warning/get' }); return x.active && x; }, 3000);
  ok(v && v.windows.includes('binary_sensor.fenster_wohnzimmer') && !v.windows.includes('binary_sensor.fenster_bad'), 'mit einem anderen offenen Fenster: Warnung ohne das ausgeschlossene', v?.windows);
  await ws.call({ type: 'house_rules/window_warning/ack' });
  for (const e of ['binary_sensor.badtuer', 'binary_sensor.fenster_wohnzimmer', 'binary_sensor.fenster_bad']) await set(e, 'off');
  await feat({ window_warning: features0.window_warning });
  // back
  await devSet([{ entity_id: 'binary_sensor.fenster_bad', hidden: false }, { entity_id: 'binary_sensor.haustuer', reset: true }, { entity_id: 'light.badlicht', reset: true }, { entity_id: 'sensor.temp_bad', reset: true }]);
  const d3 = await dev();
  ok(d3['binary_sensor.fenster_bad'] && d3['binary_sensor.haustuer'] && d3['light.badlicht'], 'wieder verwenden → wieder da');
});

await test('Andere Art und anderer Raum gelten überall', async () => {
  await devSet([{ entity_id: 'binary_sensor.badtuer', kind: 'window' }]);
  const s = await snapshot();
  const d = Object.fromEntries(s.devices.map((x) => [x.entity_id, x]));
  ok(d['binary_sensor.badtuer']?.kind === 'window' && d['binary_sensor.badtuer']?.auto_kind === 'door', 'Tür → Fenster, „erkannt als Tür“ bleibt sichtbar', d['binary_sensor.badtuer']);
  ok(s.plans.heating.rooms[A.bad]?.contacts.includes('binary_sensor.badtuer'), 'Heizung im Bad nimmt es als Fensterkontakt', s.plans.heating.rooms[A.bad]);
  ok(!roomOf(s, 'Bad').doors.includes('binary_sensor.badtuer'), 'und es ist keine Tür des Bads mehr', roomOf(s, 'Bad').doors);
  await devSet([{ entity_id: 'binary_sensor.badtuer', kind: 'door', room: A.wohnzimmer, name: 'Terrassentür', icon: 'mdi:door-sliding' }]);
  const s2 = await snapshot();
  const b = s2.devices.find((x) => x.entity_id === 'binary_sensor.badtuer');
  ok(b?.room === A.wohnzimmer && b?.auto_room === A.bad && b?.name === 'Terrassentür' && b?.icon === 'mdi:door-sliding', 'anderer Raum, eigener Name und Symbol', b);
  ok(roomOf(s2, 'Wohnzimmer').doors.includes('binary_sensor.badtuer') && !roomOf(s2, 'Bad').doors.includes('binary_sensor.badtuer'), 'Räume: zählt jetzt im Wohnzimmer, nicht mehr im Bad');
  await devSet([{ entity_id: 'binary_sensor.badtuer', reset: true }]);
  const b2 = (await dev())['binary_sensor.badtuer'];
  ok(b2?.kind === 'door' && b2?.room === A.bad && !b2.auto_kind && b2.name !== 'Terrassentür', 'zurücksetzen → wie erkannt', b2);
});

await test('Eigenes Gerät: in Regeln und Plänen nutzbar', async () => {
  ok(!(await dev())['binary_sensor.garage_erschuetterung'], 'Erschütterungssensor wird nicht von selbst erkannt');
  await devSet([{ entity_id: 'binary_sensor.garage_erschuetterung', manual: true, kind: 'motion', room: A.flur, name: 'Rüttler Flur', icon: 'mdi:vibrate' }]);
  const s = await snapshot();
  const g = s.devices.find((x) => x.entity_id === 'binary_sensor.garage_erschuetterung');
  ok(g?.manual && g.kind === 'motion' && g.room === A.flur && g.name === 'Rüttler Flur' && g.icon === 'mdi:vibrate', 'von Hand hinzugefügt: Art, Raum, Name, Symbol', g);
  ok(roomOf(s, 'Flur').motion.includes('binary_sensor.garage_erschuetterung'), 'zählt als Bewegungsmelder des Flurs (Raumbelegung, Lichtplan)');
  const r = (await ws.call({ type: 'house_rules/rule/save', rule: { name: 'Test eigenes Gerät', type: 'when', when: [{ subject: 'binary_sensor.garage_erschuetterung', verb: 'detected' }], then: [{ subject: 'light.flurlicht', verb: 'turn_on' }] } })).rule;
  await set('light.flurlicht', 'off');
  await set('binary_sensor.garage_erschuetterung', 'on');
  ok(await until(async () => (await st('light.flurlicht')).state === 'on', 4000), 'Regel „Wenn Rüttler Flur Bewegung meldet, dann Flurlicht an“ läuft');
  ok(await until(async () => (await snapshot()).occupancy[A.flur]?.occupied, 3000), 'Flur gilt als belegt');
  await ws.call({ type: 'house_rules/rule/delete', rule_id: r.id });
  await set('binary_sensor.garage_erschuetterung', 'off');
  await set('light.flurlicht', 'off');
  await devSet([{ entity_id: 'binary_sensor.garage_erschuetterung', reset: true }]);
  ok(!(await dev())['binary_sensor.garage_erschuetterung'], 'eigenes Gerät entfernt');
});

let garage = null;
await test('Objekt-Alarm: scharf → Erschütterung → Nachricht mit Knöpfen → aus', async () => {
  const res = await ws.call({ type: 'house_rules/objects/save', object: { name: 'Garage', kind: 'garage', sensors: ['binary_sensor.garage_erschuetterung'], sirens: ['switch.sirene'], notify: { persons: 'everyone', critical: true } } });
  garage = res.id;
  ok(res.ok && res.objects.some((o) => o.id === garage && o.state === 'disarmed'), 'Objekt-Alarm „Garage“ angelegt', res);
  // like the house alarm, object alarms wait 60 s after a start before sensors count
  const settled = await until(async () => (await snapshot()).objects.find((o) => o.id === garage)?.settling === false, 120000, 1000);
  ok(settled, 'Anlaufphase nach dem Start vorbei');
  const ent = await until(async () => { const x = await st('alarm_control_panel.alarm_garage'); return x?.state && x; }, 5000);
  ok(ent?.state === 'disarmed', 'Entität alarm_control_panel.alarm_garage (unscharf)', ent ?? (await api('GET', '/api/states')).body.filter((x) => x.entity_id.startsWith('alarm_control_panel.')).map((x) => x.entity_id));
  await ws.call({ type: 'house_rules/objects/arm', object_id: garage });
  ok(await until(async () => (await st('alarm_control_panel.alarm_garage')).state === 'armed_away', 3000), 'scharf (Entität armed_away)');
  await calls(true);
  await set('binary_sensor.garage_erschuetterung', 'on');
  ok(await until(async () => (await snapshot()).objects.find((o) => o.id === garage)?.state === 'triggered', 3000), 'Erschütterung → Alarm');
  const msg = await until(async () => (await calls()).find((c) => c.service.startsWith('notify.mobile_app') && /Garage/.test(c.data.title)), 3000);
  const acts = msg?.data?.data?.actions ?? [];
  ok(msg && acts.some((a) => a.action === `HR_OBJ_DISARM:${garage}` && a.authenticationRequired) && acts.some((a) => a.action === `HR_OBJ_SILENCE:${garage}`), 'Nachricht „Alarm: Garage“ mit „Alarm aus“ (Face ID am Handy) und „Sirene stumm“', msg ?? (await snapshot()).persons.map((p) => [p.id, p.phones]));
  ok(msg?.data?.data?.push?.['interruption-level'] === 'critical', 'kritische Nachricht');
  ok(await until(async () => (await st('switch.sirene')).state === 'on', 3000), 'Sirene an');
  ok((await st('alarm_control_panel.alarmanlage')).state !== 'triggered', 'die Alarmanlage des Hauses bleibt unberührt');
  await set('binary_sensor.garage_erschuetterung', 'off');
  // "Alarm aus" asks how, like the house alarm
  await calls(true);
  await action(`HR_OBJ_DISARM:${garage}`);
  const ask = await until(async () => (await calls()).find((c) => c.data.title === 'Alarm aus – wie?'), 3000);
  const opts = (ask?.data?.data?.actions ?? []).map((a) => a.action);
  ok(opts.includes(`HR_OBJ_STOP:${garage}`) && opts.includes(`HR_OBJ_DISARMALL:${garage}`), 'Rückfrage mit „Nur diesen Alarm aus“ und „Ganz unscharf schalten“', ask);
  await action(`HR_OBJ_STOP:${garage}`);
  ok(await until(async () => (await snapshot()).objects.find((o) => o.id === garage)?.state === 'armed', 3000), '„Nur diesen Alarm aus“ → bleibt scharf');
  ok(await until(async () => (await st('switch.sirene')).state === 'off', 3000), 'Sirene aus');
  await set('binary_sensor.garage_erschuetterung', 'on');
  ok(await until(async () => (await snapshot()).objects.find((o) => o.id === garage)?.state === 'triggered', 3000), 'erneut Erschütterung → wieder Alarm');
  await set('binary_sensor.garage_erschuetterung', 'off');
  await action(`HR_OBJ_DISARMALL:${garage}`);
  ok(await until(async () => (await st('alarm_control_panel.alarm_garage')).state === 'disarmed', 3000), '„Ganz unscharf schalten“ → unscharf');
  const hist = await ws.call({ type: 'house_rules/history', limit: 12 });
  ok(hist.some((h) => h.what === 'ALARM: Garage') && hist.some((h) => h.what === 'Garage: unscharf'), 'Verlauf: Alarm und unscharf', hist.slice(0, 6).map((h) => h.what));
});

await test('Objekt-Alarm: Fahrrad-Tracker bewegt sich', async () => {
  const res = await ws.call({ type: 'house_rules/objects/save', object: { name: 'Fahrrad', kind: 'bike', sensors: ['device_tracker.testrad', 'binary_sensor.testrad_erschuetterung'], notify: { persons: ['alex_test'], critical: false } } });
  const bike = res.id;
  const home = await st('device_tracker.testrad');
  await ws.call({ type: 'house_rules/objects/arm', object_id: bike });
  await set('device_tracker.testrad', 'x', { latitude: home.attributes.latitude + 0.0002, longitude: home.attributes.longitude });
  await sleep(600);
  ok((await snapshot()).objects.find((o) => o.id === bike)?.state === 'armed', 'GPS-Zittern (ca. 20 m) → kein Alarm');
  await calls(true);
  await set('device_tracker.testrad', 'x', { latitude: home.attributes.latitude + 0.02, longitude: home.attributes.longitude });
  ok(await until(async () => (await snapshot()).objects.find((o) => o.id === bike)?.state === 'triggered', 3000), 'Fahrrad bewegt sich weg → Alarm');
  const msgs = (await until(async () => { const c = (await calls()).filter((x) => /Fahrrad/.test(x.data.title ?? '')); return c.length && c; }, 3000)) || [];
  ok(msgs.length && msgs.every((c) => c.service === 'notify.mobile_app_iphone_von_alex'), 'Nachricht nur an die gewählte Person', msgs.map((c) => c.service));
  await ws.call({ type: 'house_rules/objects/disarm', object_id: bike });
  await set('device_tracker.testrad', 'x', { latitude: home.attributes.latitude, longitude: home.attributes.longitude });
  await ws.call({ type: 'house_rules/objects/delete', object_id: bike });
  ok(!(await snapshot()).objects.some((o) => o.id === bike), 'gelöscht');
  ok(await until(async () => !(await st('alarm_control_panel.alarm_fahrrad'))?.state, 3000), 'Entität entfernt');
});

await test('Objekt-Alarm: mit der Alarmanlage scharf und unscharf', async () => {
  await ws.call({ type: 'house_rules/objects/save', object: { id: garage, auto: { with_alarm: true } } });
  await ws.call({ type: 'house_rules/alarm/config', config: { enabled: true, modes: { home: { sensors: [], exit_delay: 0 } } } });
  await ws.call({ type: 'house_rules/alarm/arm', mode: 'home', force: true });
  ok(await until(async () => { const o = (await snapshot()).objects.find((x) => x.id === garage); return o?.state === 'armed' && o.by_auto; }, 3000), 'Alarmanlage scharf (zuhause) → Garage automatisch scharf');
  await ws.call({ type: 'house_rules/alarm/disarm' });
  ok(await until(async () => (await snapshot()).objects.find((x) => x.id === garage)?.state === 'disarmed', 3000), 'Alarmanlage aus → Garage aus');
  // by hand armed: stays when the house alarm goes off
  await ws.call({ type: 'house_rules/objects/arm', object_id: garage });
  await ws.call({ type: 'house_rules/alarm/arm', mode: 'home', force: true });
  await ws.call({ type: 'house_rules/alarm/disarm' });
  await sleep(500);
  ok((await snapshot()).objects.find((x) => x.id === garage)?.state === 'armed', 'von Hand scharf geschaltet → bleibt scharf, wenn die Alarmanlage ausgeht');
  await ws.call({ type: 'house_rules/objects/disarm', object_id: garage });
  // house mode
  await ws.call({ type: 'house_rules/objects/save', object: { id: garage, auto: { with_alarm: false, arm_on: ['away'], disarm_on: ['home'] } } });
  await ws.call({ type: 'house_rules/mode/set', mode: 'away' });
  ok(await until(async () => (await snapshot()).objects.find((x) => x.id === garage)?.state === 'armed', 3000), 'Hausmodus „Weg“ → scharf');
  await ws.call({ type: 'house_rules/mode/set', mode: 'home' });
  ok(await until(async () => (await snapshot()).objects.find((x) => x.id === garage)?.state === 'disarmed', 3000), 'Hausmodus „Zuhause“ → unscharf');
  await ws.call({ type: 'house_rules/objects/save', object: { id: garage, auto: { arm_on: [], disarm_on: [] } } });
});

await test('Objekt-Alarm: PIN der Alarmanlage und Rechte ohne Admin', async () => {
  await ws.call({ type: 'house_rules/alarm/config', config: { code: '2468', confirm: 'pin' } });
  const t2 = await userToken(tok, 'tablet');
  const wsT = await wsConnect(t2);
  const save = await wsT.call({ type: 'house_rules/objects/save', object: { name: 'Hack' } }).then(() => 'ok', (e) => e.message);
  ok(/unauthorized/i.test(save), 'ohne Admin: keinen Objekt-Alarm anlegen', save);
  const del = await wsT.call({ type: 'house_rules/objects/delete', object_id: garage }).then(() => 'ok', (e) => e.message);
  ok(/unauthorized/i.test(del), 'ohne Admin: nicht löschen', del);
  const arm = await wsT.call({ type: 'house_rules/objects/arm', object_id: garage });
  ok(arm.ok, 'ohne Admin: scharf schalten geht');
  let d = await wsT.call({ type: 'house_rules/objects/disarm', object_id: garage });
  ok(!d.ok && d.error === 'wrong_code', 'ausschalten ohne PIN → abgelehnt', d);
  d = await wsT.call({ type: 'house_rules/objects/disarm', object_id: garage, code: '0000' });
  ok(!d.ok && d.error === 'wrong_code', 'falsche PIN → abgelehnt (zählt für die Sperre der Alarmanlage)', d);
  ok((await st('alarm_control_panel.alarm_garage')).attributes.code_format === 'number', 'Entität verlangt eine Zahl als Code');
  const svc = await api('POST', '/api/services/alarm_control_panel/alarm_disarm', { entity_id: 'alarm_control_panel.alarm_garage', code: '1111' });
  ok(svc.status >= 400 && (await st('alarm_control_panel.alarm_garage')).state === 'armed_away', 'HA-Alarmzentrale: falscher Code → bleibt scharf', svc.status);
  d = await wsT.call({ type: 'house_rules/objects/disarm', object_id: garage, code: '2468' });
  ok(d.ok && (await snapshot()).objects.find((x) => x.id === garage)?.state === 'disarmed', 'richtige PIN → unscharf', d);
  wsT.close();
});

// ---------------------------------------------------------------- clean up: everything as before the run
await ws.call({ type: 'house_rules/objects/delete', object_id: garage }).catch(() => null);
// a fresh test HA has no PIN; a PIN set before this run is not known here, so it stays removed
await ws.call({ type: 'house_rules/alarm/config', config: { code: null, confirm: 'none', enabled: !!alarm0.enabled } }).catch(() => null);
await devSet(TESTED.map((entity_id) => ({ entity_id, reset: true })));
await feat(features0);
for (const e of ['switch.sirene', 'light.flurlicht']) await set(e, 'off');
console.log(`\n${failures() ? `${failures()} FEHLER` : 'alles ok'}`);
ws.close();
process.exit(failures() ? 1 : 0);
