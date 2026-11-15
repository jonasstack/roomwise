// Anonymous diagnostics (telemetry.py) and the diagnostics downloads, against the isolated test HA (port 8124).
// The diagnostics server is replaced by a mock inside the test HA (hr_fake/telemetry). Checks: off by default and
// nothing sent, "not available" without a server, the preview holds no identifying data of the fake home, opt-in
// sends to the mock, delete and opt-out reach the server, only admins may switch, both diagnostics downloads are
// pseudonymized. Usage: node tools/testha/test-telemetry.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { token, wsConnect, rest, ok, failures, until, userToken, sleep } from './lib.mjs';

const tok = await token();
const ws = await wsConnect(tok);
const api = rest(tok);
const mock = (msg = {}) => ws.call({ type: 'hr_fake/telemetry', ...msg });

// ---------------------------------------------------------------- the fake home (idempotent)
let info = await ws.call({ type: 'house_rules/info' }).catch(() => null);
if (!info?.loaded) {
  const flow = await api('POST', '/api/config/config_entries/flow', { handler: 'roomwise' });
  await api('POST', `/api/config/config_entries/flow/${flow.body.flow_id}`, {});
  info = await until(async () => {
    const i = await ws.call({ type: 'house_rules/info' }).catch(() => null);
    return i?.loaded && i;
  }, 30000);
}
ok(info?.loaded, 'Hausregeln läuft');
await until(async () => (await ws.call({ type: 'house_rules/snapshot' })).devices.length > 10, 90000, 1000);
const areas = await ws.call({ type: 'config/area_registry/list' });
const area = async (name) => (areas.find((a) => a.name === name) ?? (await ws.call({ type: 'config/area_registry/create', name }))).area_id;
const roomId = await area('Arbeitszimmer');
// moved there for this test only, put back at the end (later suites expect them in their rooms)
const moved = ['light.flurlicht', 'climate.heizung_bad'];
const areaBefore = {};
for (const e of moved) areaBefore[e] = (await ws.call({ type: 'config/entity_registry/get', entity_id: e }).catch(() => null))?.area_id ?? null;
for (const e of moved) await ws.call({ type: 'config/entity_registry/update', entity_id: e, area_id: roomId }).catch(() => undefined);
const persons = await ws.call({ type: 'person/list' });
if (!persons.storage.some((p) => p.name === 'Erika Beispiel')) await ws.call({ type: 'person/create', name: 'Erika Beispiel' });
// roomwise holds the card part too (its diagnostics, "roomwise" part of the report): the same entry
const fpEntry = (await ws.call({ type: 'config_entries/get', domain: 'roomwise' }))[0];
ok(!!fpEntry && !!(await ws.call({ type: 'floorplan_card/info' }).catch(() => null)), 'Kartenteil von roomwise läuft');
if (fpEntry) await ws.call({ type: 'floorplan_card/entry_alert/set', card_id: 'tele_test', config: { door: 'binary_sensor.haustuer', windows: [{ e: 'binary_sensor.fenster_bad', n: 'Fenster im Arbeitszimmer' }], texts: { general: 'Erika, Fenster zu!' } } }).catch((e) => console.log('  (entry alert:', e.message, ')'));

// every identifier of the fake home that must never show up in what is sent
const states = (await api('GET', '/api/states')).body;
const devices = await ws.call({ type: 'config/device_registry/list' });
const areasNow = await ws.call({ type: 'config/area_registry/list' });
const ids = new Set();
for (const s of states) {
  ids.add(s.entity_id);
  if (typeof s.attributes.friendly_name === 'string' && s.attributes.friendly_name.length >= 3) ids.add(s.attributes.friendly_name);
}
for (const a of areasNow) ids.add(a.area_id), ids.add(a.name);
for (const d of devices) for (const n of [d.name, d.name_by_user]) if (n && n.length >= 3) ids.add(n);
ids.add('Erika Beispiel');
// words that are also standard vocabulary (a device literally called "light" is not identifying)
const vocab = new Set(['light', 'climate', 'vacuum', 'sensor', 'switch', 'Sonne', 'Home Assistant']);
const leaks = (obj) => {
  const out = [];
  const walk = (x) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (x && typeof x === 'object') return Object.entries(x).forEach(([k, v]) => (walk(k), walk(v)));
    if (typeof x !== 'string') return;
    for (const id of ids) if (!vocab.has(id) && (x === id || (id.includes('.') && x.includes(id)) || (id.length >= 5 && x.includes(id)))) out.push(`${id} in "${x.slice(0, 60)}"`);
  };
  walk(obj);
  return out;
};

// ---------------------------------------------------------------- off by default, no server yet
await ws.call({ type: 'house_rules/telemetry/set', on: false }).catch(() => undefined);
await mock({ endpoint: false, clear: true });
let t = await ws.call({ type: 'house_rules/telemetry/get' });
ok(t.on === false && t.available === false, 'aus und „noch nicht verfügbar“ ohne Server', t);
const na = await ws.call({ type: 'house_rules/telemetry/set', on: true }).catch((e) => e.message);
ok(String(na).startsWith('not_available'), 'Einschalten ohne Server wird abgelehnt', na);

// server there, still off: nothing is sent
await mock({ endpoint: true, clear: true });
t = await ws.call({ type: 'house_rules/telemetry/get' });
ok(t.available === true && t.on === false, 'mit Server: verfügbar, aber weiter aus');
const sn = await ws.call({ type: 'house_rules/telemetry/send_now' });
ok(sn.ok === false && sn.error === 'off', 'aus: „Jetzt senden“ sendet nichts', sn);
const cl0 = await ws.call({ type: 'house_rules/telemetry/client', browser: 'chrome', engine: 'blink', engine_version: 130, webgl: 'webgl2', tier: 'ok' });
ok(cl0.accepted === false, 'aus: Karten-Meldung wird verworfen');
await ws.call({ type: 'hr_fake/raise_in_house_rules' });
await sleep(400);
ok((await mock()).received.length === 0, 'aus: nichts beim Server angekommen');

// ---------------------------------------------------------------- preview: exactly what would be sent
const pv = await ws.call({ type: 'house_rules/telemetry/preview' });
const rep = pv.report;
ok(rep.schema === 1 && rep.versions?.ha && rep.versions?.roomwise, 'Vorschau: Versionen', rep.versions);
ok(rep.ha?.language === 'de' && rep.ha?.unit_system === 'metric', 'Vorschau: Sprache und Einheiten', rep.ha);
ok(rep.entities?.domains?.light >= 3 && rep.entities?.device_classes?.['binary_sensor:window'] >= 1, 'Vorschau: Anzahl je Domäne und Geräteklasse', rep.entities);
ok(rep.platforms?.light?.custom >= 3 && !JSON.stringify(rep).includes('hr_fake'), 'Vorschau: private Integration nur als „custom“', rep.platforms?.light);
ok(rep.platforms?.person?.person >= 1 || rep.platforms?.zone?.zone >= 1 || Object.keys(rep.platforms ?? {}).length > 3, 'Vorschau: eingebaute Integrationen mit Namen');
const clim = (rep.shapes ?? []).find((s) => s.domain === 'climate');
ok(clim && /hvac=/.test(clim.shape) && /sf=\d+/.test(clim.shape), 'Vorschau: Fähigkeiten der Thermostate', clim);
ok(typeof rep.features?.alarm === 'boolean' && typeof rep.counts?.rules === 'number' && rep.counts.areas >= 1, 'Vorschau: Funktionen und Anzahlen', rep.counts);
ok(fpEntry ? rep.roomwise?.floorplan_card === true && rep.roomwise?.entry_alert === true : true, 'Vorschau: roomwise-Teile (Grundriss-Karte, Warnung)', rep.roomwise);
ok(!rep.install_id || !/^[0-9a-f-]{36}$/.test(rep.install_id), 'Vorschau (aus): noch keine Kennung');
const lk = leaks(pv);
ok(lk.length === 0, 'Vorschau enthält keine Entitäten, Namen, Räume oder Personen', lk.slice(0, 5));
ok(!/latitude|longitude|52\.52|13\.4|Hausregeln Test|Europe\/Berlin/.test(JSON.stringify(pv)), 'Vorschau: keine Koordinaten, Ortsname, Zeitzone');

// ---------------------------------------------------------------- only admins
// a fresh non-admin user for this run (removed at the end)
const uname = `tele${Date.now().toString(36)}`;
const userTok = await userToken(tok, uname);
const uRec = (await ws.call({ type: 'config/auth/list' })).find((u) => u.name === uname);
ok(uRec && !uRec.group_ids?.includes('system-admin'), 'Test-Nutzer ist kein Admin', uRec?.group_ids);
const uws = await wsConnect(userTok);
for (const [type, extra] of [
  ['house_rules/telemetry/set', { on: true }],
  ['house_rules/telemetry/preview', {}],
  ['house_rules/telemetry/delete', {}],
  ['house_rules/telemetry/send_now', {}],
]) {
  const r = await uws.call({ type, ...extra }).catch((e) => e.message);
  ok(String(r).startsWith('unauthorized'), `nur Admins: ${type}`, r);
}
const ug = await uws.call({ type: 'house_rules/telemetry/get' });
ok(ug.on === false && !('install_id' in ug), 'Nicht-Admin sieht den Stand, aber keine Kennung');

// ---------------------------------------------------------------- opt in: sends to the mock
t = await ws.call({ type: 'house_rules/telemetry/set', on: true });
const id1 = t.install_id;
ok(t.on && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id1 ?? ''), 'eingeschaltet mit zufälliger Kennung (uuid4)', t);
const cl1 = await uws.call({ type: 'house_rules/telemetry/client', browser: 'chrome', engine: 'blink', engine_version: 130, webgl: 'webgl2', gpu: 'adreno', tier: 'ok', profile: 'high', view: '3d', screen: 'tablet', cores: '5-8' });
await uws.call({ type: 'house_rules/telemetry/client', browser: 'evil<script>', engine: 'x', engine_version: 99999, webgl: 'webgl2', tier: 'ok' });
const extra = await uws.call({ type: 'house_rules/telemetry/client', browser: 'chrome', name: 'Erika' }).catch((e) => e.message);
ok(String(extra).startsWith('invalid_format'), 'Karten-Meldung mit unbekanntem Feld wird abgelehnt', extra);
ok(cl1.accepted === true, 'an: Karten-Meldung (auch von Nicht-Admins) angenommen');
await ws.call({ type: 'hr_fake/raise_in_house_rules' });
await sleep(400);
const pv2 = await ws.call({ type: 'house_rules/telemetry/preview' });
ok(pv2.report.install_id === id1 && pv2.report.clients?.some((c) => c.browser === 'chrome' && c.count === 1), 'Vorschau (an): Kennung und Browser-Zählung', pv2.report.clients);
ok(pv2.report.clients?.some((c) => c.browser === 'other' && c.engine_version === 0) && !JSON.stringify(pv2).includes('evil'), 'unbekannte Browser-Werte werden zu „other“');
ok(pv2.errors?.length >= 1, 'Vorschau (an): Fehler wartet auf Versand', pv2.errors);
await mock({ clear: true });
const sent = await ws.call({ type: 'house_rules/telemetry/send_now' });
ok(sent.ok === true, 'Jetzt senden: ok', sent);
const got = (await mock()).received;
const post = got.find((r) => r.method === 'POST' && r.path === '/v1/report');
ok(post?.body?.install_id === id1 && post.body.versions?.ha, 'Bericht beim Mock-Server angekommen', got.map((r) => r.path));
const err = got.find((r) => r.method === 'POST' && r.path === '/v1/error');
ok(err?.body?.type === 'AttributeError' && err.body.frames?.some((f) => /^house_rules\/setup\.py:\d+ save$/.test(f)), 'Fehlerbericht: Typ und eigene Zeilen', err?.body);
ok(err && !JSON.stringify(err.body).includes('NoneType') && !err.body.message && !JSON.stringify(err.body).includes('/config/'), 'Fehlerbericht: keine Meldung, keine Pfade');
ok(leaks(got).length === 0, 'Gesendetes enthält keine identifizierenden Daten', leaks(got).slice(0, 5));
// for the server's own test: it validates exactly these bodies against its schema (telemetry/worker/test/run.mjs)
mkdirSync(new URL('../../.cache/', import.meta.url), { recursive: true });
writeFileSync(new URL('../../.cache/telemetry-sample.json', import.meta.url), JSON.stringify({ report: post?.body, error: err?.body }, null, 1));
await mock({ clear: true });
await ws.call({ type: 'house_rules/telemetry/send_now' });
ok(!(await mock()).received.some((r) => r.path === '/v1/error'), 'derselbe Fehler höchstens einmal am Tag');

// ---------------------------------------------------------------- delete, opt out, opt in again
await mock({ clear: true });
const del = await ws.call({ type: 'house_rules/telemetry/delete' });
ok(del.ok && del.deleted, '„Meine Daten löschen“: ok', del);
ok((await mock()).received.some((r) => r.method === 'DELETE' && r.path === `/v1/install/${id1}`), 'Löschen erreicht den Server mit der alten Kennung');
t = await ws.call({ type: 'house_rules/telemetry/get' });
const id2 = t.install_id;
ok(t.on && id2 && id2 !== id1, 'danach neue Kennung');
await mock({ clear: true });
t = await ws.call({ type: 'house_rules/telemetry/set', on: false });
ok(t.on === false && !t.install_id, 'ausgeschaltet: Kennung vergessen');
ok(!!(await until(async () => (await mock()).received.some((r) => r.method === 'DELETE' && r.path === `/v1/install/${id2}`), 5000)), 'Ausschalten löscht die Daten auf dem Server');
t = await ws.call({ type: 'house_rules/telemetry/set', on: true });
ok(t.install_id && t.install_id !== id1 && t.install_id !== id2, 'wieder eingeschaltet: wieder neue Kennung');
await ws.call({ type: 'house_rules/telemetry/set', on: false });

// a server that is down: fails silently
await mock({ endpoint: 'http://127.0.0.1:9/nowhere' });
await ws.call({ type: 'house_rules/telemetry/set', on: true });
const down = await ws.call({ type: 'house_rules/telemetry/send_now' });
ok(down.ok === false, 'Server nicht erreichbar: still fehlgeschlagen, kein Fehler', down);
await mock({ endpoint: true });
await ws.call({ type: 'house_rules/telemetry/set', on: false });
await mock({ endpoint: false, clear: true });

// ---------------------------------------------------------------- setup wizard knows the step
const sv = await ws.call({ type: 'house_rules/setup/save' });
ok(sv.steps.includes('diagnostics') && sv.steps.indexOf('diagnostics') === sv.steps.length - 2, 'Einrichtung: Schritt „diagnostics“ vor „done“');

// ---------------------------------------------------------------- diagnostics downloads
const hrEntry = fpEntry;
const d0 = await api('GET', `/api/diagnostics/config_entry/${hrEntry.entry_id}`);
// one download, both parts: { roomwise, card, house_rules }
const d1 = { status: d0.status, body: { data: d0.body?.data?.house_rules } };
ok(d1.status === 200 && d1.body?.data?.version, 'Diagnose Hausregeln herunterladbar', d1.status);
const l1 = leaks(d1.body?.data ?? {});
ok(l1.length === 0, 'Diagnose Hausregeln: keine Entitäten oder Namen', l1.slice(0, 5));
ok(JSON.stringify(d1.body?.data?.rules ?? []).length > 2 ? /[a-z_]+\.[0-9a-f]{6}/.test(JSON.stringify(d1.body.data)) : true, 'Diagnose Hausregeln: Pseudonyme statt Entitäten');
ok(Array.isArray(d1.body?.data?.recent_errors) && d1.body.data.recent_errors.some((e) => e.type === 'AttributeError'), 'Diagnose Hausregeln: letzte Fehler (lokal)');
if (fpEntry) {
  const d2 = { status: d0.status, body: { data: d0.body?.data?.card } };
  ok(d2.status === 200 && d2.body?.data?.loaded === true, 'Diagnose Grundriss-Karte herunterladbar', d2.status);
  const s2 = JSON.stringify(d2.body?.data ?? {});
  ok(leaks(d2.body?.data ?? {}).length === 0 && !s2.includes('Erika'), 'Diagnose Grundriss-Karte: keine Entitäten, Namen, Texte', leaks(d2.body?.data ?? {}).slice(0, 5));
  ok(/binary_sensor\.[0-9a-f]{6}/.test(s2), 'Diagnose Grundriss-Karte: Pseudonyme statt Entitäten');
  await ws.call({ type: 'floorplan_card/entry_alert/remove', card_id: 'tele_test' }).catch(() => undefined);
}

for (const e of moved) await ws.call({ type: 'config/entity_registry/update', entity_id: e, area_id: areaBefore[e] }).catch(() => undefined);
uws.close();
if (uRec) await ws.call({ type: 'config/auth/delete', user_id: uRec.id }).catch(() => undefined);
ws.close();
console.log(failures() ? `\n${failures()} FAILED` : '\nall ok');
process.exit(failures() ? 1 : 0);
