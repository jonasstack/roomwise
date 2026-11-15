// Local tests of the diagnostics server in Miniflare (the same runtime as Cloudflare, an in-memory D1).
// Nothing leaves this machine. Usage: npm test   (in telemetry/worker)
//   node test/run.mjs ../../hausregeln/.cache/telemetry-sample.json  also checks what the integration really sent
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const here = (p) => new URL(p, import.meta.url).pathname;
const bundle = await build({ entryPoints: [here('../src/index.ts')], bundle: true, format: 'esm', write: false, target: 'es2022' });
const TOKEN = 'test-read-token-0123456789';
const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, d1Databases: ['DB'], bindings: { READ_TOKEN: TOKEN }, compatibilityDate: '2024-10-22' });
const db = await mf.getD1Database('DB');
const sql = readFileSync(here('../migrations/0001_init.sql'), 'utf8').replace(/--.*$/gm, '');
for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) await db.prepare(stmt).run();

let fails = 0;
const ok = (c, m, extra) => {
  if (!c) fails++;
  console.log(c ? '  ok:' : '• FAIL:', m, !c && extra !== undefined ? JSON.stringify(extra).slice(0, 300) : '');
};
const req = async (method, path, body, headers = {}) => {
  const r = await mf.dispatchFetch('http://worker' + path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const t = await r.text();
  let j;
  try {
    j = JSON.parse(t);
  } catch {
    j = t;
  }
  return { status: r.status, body: j };
};
const auth = { authorization: `Bearer ${TOKEN}` };
const uuid = () => crypto.randomUUID();

const report = (id, over = {}) => ({
  schema: 1,
  install_id: id,
  period_days: 7,
  versions: { roomwise: '0.1.0', house_rules: '0.1.0', floorplan_card: '0.1.0-alpha.1', ha: '2026.10.1', python: '3.13' },
  ha: { language: 'de', unit_system: 'metric', installation: 'Home Assistant OS' },
  entities: { domains: { light: 12, climate: 4, binary_sensor: 20 }, device_classes: { 'binary_sensor:window': 6, 'binary_sensor:door': 3 } },
  platforms: { climate: { zha: 4 }, light: { hue: 10, custom: 2 } },
  shapes: [{ domain: 'climate', platform: 'zha', shape: 'sf=401;hvac=heat,off;step=0.5;presets=0;cur;valve=attr:pi_heating_demand', count: 4 }],
  features: { alarm: true, light: true, heating: false },
  roomwise: { floorplan_card: true, cards: 1, entry_alert: true, pets: 0, vacuum_adapters: { roborock: 1 } },
  counts: { rules: 5, rooms: 6 },
  clients: [{ browser: 'chrome', engine: 'blink', engine_version: 130, webgl: 'webgl2', gpu: 'adreno', tier: 'ok', profile: 'high', view: '3d', screen: 'tablet', cores: '5-8', count: 3 }],
  ...over,
});
const error = (id, over = {}) => ({ schema: 1, install_id: id, fingerprint: 'abcdef0123456789abcdef01', type: 'KeyError', frames: ['house_rules/core.py:120 rebuild', 'house_rules/rooms.py:44 start'], count: 2, versions: { roomwise: '0.1.0', ha: '2026.10.1' }, ...over });

// ---------------------------------------------------------------- reports
const A = uuid();
const B = uuid();
let r = await req('POST', '/v1/report', report(A));
ok(r.status === 200 && r.body.ok, 'Bericht angenommen', r);
r = await req('POST', '/v1/report', report(A, { counts: { rules: 6, rooms: 6 } }));
const rows = await db.prepare('SELECT COUNT(*) n, MAX(payload) p FROM reports WHERE install_id = ?').bind(A).first();
ok(rows.n === 1 && JSON.parse(rows.p).counts.rules === 6, 'gleicher Tag: überschrieben statt doppelt (upsert)');
await req('POST', '/v1/report', report(B, { versions: { roomwise: '0.1.1', ha: '2026.11.0', python: '3.13' }, ha: { language: 'en', unit_system: 'us_customary', installation: 'Home Assistant Container' } }));
const cols = await db.prepare("SELECT * FROM pragma_table_info('reports')").all();
ok(!cols.results.some((c) => /ip|header|agent|country/i.test(c.name)), 'keine Spalte für IP, Header, Land', cols.results.map((c) => c.name));

// rejected
r = await req('POST', '/v1/report', { ...report(uuid()), extra: 1 });
ok(r.status === 400 && /unknown field/.test(r.body.detail), 'unbekanntes Feld abgelehnt', r.body);
r = await req('POST', '/v1/report', report(uuid(), { platforms: { light: { 'light.wohnzimmer': 1 } } }));
ok(r.status === 400, 'Entitäts-ID als Schlüssel abgelehnt', r.body);
r = await req('POST', '/v1/report', report(uuid(), { ha: { language: 'de', unit_system: 'metric', installation: 'Bei Familie Muster' } }));
ok(r.status === 400, 'freier Text abgelehnt');
r = await req('POST', '/v1/report', report('not-a-uuid'));
ok(r.status === 400, 'ungültige Kennung abgelehnt');
r = await req('POST', '/v1/report', JSON.stringify({ ...report(uuid()), pad: 'x'.repeat(70 * 1024) }));
ok(r.status === 413, 'zu groß (> 64 KB) abgelehnt', r.status);
r = await req('POST', '/v1/report', '{oops');
ok(r.status === 400, 'kaputtes JSON abgelehnt');
r = await req('POST', '/v1/report', 'x', { 'content-type': 'text/plain' });
ok(r.status === 415, 'kein JSON-Typ abgelehnt');

// rate limit
const C = uuid();
const codes = [];
for (let i = 0; i < 7; i++) codes.push((await req('POST', '/v1/report', report(C))).status);
ok(codes.slice(0, 5).every((c) => c === 200) && codes.slice(5).every((c) => c === 429), 'Ratenbegrenzung je Kennung (5 am Tag)', codes);

// ---------------------------------------------------------------- errors
r = await req('POST', '/v1/error', error(A));
const fp = r.body.fingerprint;
ok(r.status === 200 && /^[0-9a-f]{24}$/.test(fp), 'Fehler angenommen', r.body);
await req('POST', '/v1/error', error(B, { frames: ['house_rules/core.py:125 rebuild', 'house_rules/rooms.py:47 start'], count: 3, versions: { roomwise: '0.1.1', ha: '2026.11.0' } }));
const e = await db.prepare('SELECT * FROM errors WHERE fingerprint = ?').bind(fp).first();
ok(e && e.count === 5 && JSON.parse(e.versions).length === 2, 'gleicher Fehler in anderer Zeile/Version: zusammengezählt', e);
r = await req('POST', '/v1/error', error(A, { frames: ['/config/custom_components/house_rules/core.py:1 x'] }));
ok(r.status === 400, 'Pfade außerhalb von roomwise abgelehnt');
r = await req('POST', '/v1/error', error(A, { message: "KeyError: 'Wohnzimmer'" }));
ok(r.status === 400, 'Fehlermeldung (Text) abgelehnt');
r = await req('POST', '/v1/error', JSON.stringify({ ...error(A), pad: 'x'.repeat(20 * 1024) }));
ok(r.status === 413, 'Fehler > 16 KB abgelehnt');

// ---------------------------------------------------------------- read API
r = await req('GET', '/v1/stats');
ok(r.status === 401, 'Statistik ohne Token: 401');
r = await req('GET', '/v1/stats', undefined, { authorization: 'Bearer falsch' });
ok(r.status === 401, 'Statistik mit falschem Token: 401');
r = await req('GET', '/v1/stats?days=30', undefined, auth);
const s = r.body;
ok(r.status === 200 && s.installs === 3, 'Statistik: 3 Installationen', s.installs);
ok(s.versions.roomwise.some((v) => v.value === '0.1.0' && v.installs === 2), 'Statistik: Versionen', s.versions.roomwise);
ok(s.language.some((v) => v.value === 'en'), 'Statistik: Sprachen');
ok(s.platforms.some((p) => p.domain === 'climate' && p.platform === 'zha' && p.total === 12), 'Statistik: Integrationen je Domäne', s.platforms);
ok(s.domains.some((d) => d.key === 'light' && d.total === 36), 'Statistik: Domänen summiert');
ok(s.features.some((f) => f.feature === 'alarm' && f.on === 3), 'Statistik: Funktionen', s.features);
ok(s.clients.browsers.some((b) => b.value === 'chrome' && b.cards === 9), 'Statistik: Browser', s.clients.browsers);
ok(s.shapes.some((x) => x.domain === 'climate' && /valve/.test(x.shape)), 'Statistik: Fähigkeiten');
ok(s.roomwise.vacuum === 3, 'Statistik: roomwise-Teile', s.roomwise);
r = await req('GET', '/v1/errors', undefined, auth);
ok(r.status === 200 && r.body.errors[0]?.installs === 2 && r.body.errors[0].count === 5, 'Top-Fehler mit Anzahl Installationen', r.body.errors?.[0]);
r = await req('GET', `/v1/install/${A}`, undefined, auth);
ok(r.status === 200 && r.body.reports.length === 1 && r.body.errors.length === 1, 'Rohdaten einer Kennung (mit Token)');
r = await req('GET', `/v1/install/${A}`);
ok(r.status === 401, 'Rohdaten ohne Token: 401');

// ---------------------------------------------------------------- delete
r = await req('DELETE', `/v1/install/${A}`);
ok(r.status === 200 && r.body.deleted >= 2, 'Löschen einer Kennung', r.body);
const left = await db.prepare('SELECT (SELECT COUNT(*) FROM reports WHERE install_id = ?1) + (SELECT COUNT(*) FROM error_installs WHERE install_id = ?1) + (SELECT COUNT(*) FROM rate WHERE install_id = ?1) n').bind(A).first();
ok(left.n === 0, 'nichts mehr von der Kennung gespeichert');
r = await req('DELETE', '/v1/install/abc');
ok(r.status === 400, 'Löschen mit ungültiger Kennung: 400');
r = await req('GET', '/v1/stats', undefined, auth);
ok(r.body.installs === 2, 'Statistik danach ohne die gelöschte Installation');

// ---------------------------------------------------------------- retention (daily cron)
await db.prepare("UPDATE reports SET day = '2020-01-01' WHERE install_id = ?").bind(B).run();
const worker = await mf.getWorker();
await worker.scheduled({ cron: '17 3 * * *' });
const old = await db.prepare('SELECT COUNT(*) n FROM reports WHERE install_id = ?').bind(B).first();
ok(old.n === 0, 'Aufräumen löscht alte Berichte');

// what the real integration sent in the test HA (hausregeln/tools/testha/test-telemetry.mjs writes it), if given
if (process.argv[2]) {
  const sample = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  r = await req('POST', '/v1/report', { ...sample.report, install_id: uuid() });
  ok(r.status === 200, 'echter Bericht aus der Test-HA passt zum Schema', r.body);
  if (sample.error) {
    r = await req('POST', '/v1/error', { ...sample.error, install_id: uuid() });
    ok(r.status === 200, 'echter Fehlerbericht aus der Test-HA passt zum Schema', r.body);
  }
}

r = await req('GET', '/nope');
ok(r.status === 404, 'unbekannter Pfad: 404');
await mf.dispose();
console.log(fails ? `\n${fails} FAILED` : '\nall ok');
process.exit(fails ? 1 : 0);
