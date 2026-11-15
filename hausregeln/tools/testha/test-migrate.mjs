// From the two old integrations (floorplan_card + house_rules, up to 0.1.0-beta.2) to roomwise, in the isolated
// test Home Assistant (port 8124, own data folder .cache/testha-migrate, the container hr-test-ha is replaced):
//   1. only the old integrations: set up both, a house mode, a rule, a renamed entity
//   2. roomwise next to the old folders: adding it first offers to move them; confirmed without the restart, they
//      go to <config>/roomwise-alte-ordner/ (nothing deleted, old entries stay), the hint "Neustart nötig" restarts
//   3. after that restart: roomwise takes over – same entity ids, mode, rules; old entries gone, a notification
//   4. the HACS case (update from 0.1.0-beta.3 to beta.4): only the old floorplan_card folder and entry plus a roomwise
//      entry; roomwise does not start, "Fix" under Repairs moves the folder and restarts, then roomwise runs
// Usage (from the repository root, the test HA slot must be free):
//   git worktree add /tmp/roomwise-old 9bd8819      (any checkout from before roomwise, e.g. 0.1.0-beta.3)
//   sh tools/heavy.sh testha node hausregeln/tools/testha/test-migrate.mjs /tmp/roomwise-old
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { token, wsConnect, rest, ok, failures, until, URL0 } from './lib.mjs';
import { readFileSync as read } from 'node:fs';

const OLD = process.argv[2] && resolve(process.argv[2]);
if (!OLD || !existsSync(`${OLD}/hausregeln/custom_components/house_rules/manifest.json`)) {
  console.error('usage: test-migrate.mjs <checkout of the old version (hausregeln/custom_components/house_rules inside)>');
  process.exit(2);
}
const HR = resolve(fileURLToPath(new URL('../..', import.meta.url))); // hausregeln/
const ROOT = resolve(HR, '..');
const D = `${HR}/.cache/testha-migrate`;
const NEW = JSON.parse(read(`${ROOT}/custom_components/roomwise/manifest.json`, 'utf8')).version;
const sh = (cmd) => execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

// the old integrations live as real folders in the data folder (custom_components/…), so the fix can move them
function plant(dir, names) {
  mkdirSync(`${dir}/custom_components`, { recursive: true });
  for (const n of names) sh(`cp -r "${oldMounts[n]}" "${dir}/custom_components/${n}"`);
}
const archived = (dir) => sh(`docker run --rm -v "${dir}:/c" alpine sh -c 'ls /c/roomwise-alte-ordner 2>/dev/null || true'`).split(/\s+/).filter(Boolean);
const present = (dir, n) => sh(`docker run --rm -v "${dir}:/c" alpine sh -c 'test -d /c/custom_components/${n} && echo yes || true'`) === 'yes';
// a restart from inside Home Assistant (homeassistant.restart): wait until it is gone, then until it is back
async function restarted() {
  await until(async () => {
    try {
      await fetch(`${URL0}/api/`);
      return false;
    } catch {
      return true;
    }
  }, 120000, 300);
  return up();
}
async function fix(api, issue_id, data) {
  const f = await api('POST', '/api/repairs/issues/fix', { handler: 'roomwise', issue_id });
  if (f.body?.type !== 'form') return f.body;
  return (await api('POST', `/api/repairs/issues/fix/${f.body.flow_id}`, data)).body;
}

function start(mounts, dir = D) {
  sh('docker rm -f hr-test-ha fp-test-ha >/dev/null 2>&1 || true');
  const v = Object.entries(mounts)
    .map(([name, src]) => `-v "${src}:/config/custom_components/${name}:ro"`)
    .join(' ');
  sh(`docker run -d --name hr-test-ha -p 127.0.0.1:8124:8123 -e TZ=Europe/Berlin -v "${dir}:/config" ${v} ghcr.io/home-assistant/home-assistant:stable`);
}
async function up() {
  return until(
    async () => {
      try {
        const r = await fetch(`${URL0}/api/`);
        return r.status === 401 || r.status === 200 || (await fetch(`${URL0}/api/onboarding`)).ok;
      } catch {
        return false;
      }
    },
    180000,
    1000,
  );
}
const stop = () => sh('docker stop -t 60 hr-test-ha >/dev/null');

// ---------------------------------------------------------------- fresh data folder
sh('docker rm -f hr-test-ha >/dev/null 2>&1 || true');
if (existsSync(D)) sh(`docker run --rm -v "${HR}/.cache:/c" alpine rm -rf /c/testha-migrate`);
// the token of the normal test HA (.cache/testha) comes back at the end
const TOKEN = `${HR}/.cache/test-token`;
const savedToken = existsSync(TOKEN) ? readFileSync(TOKEN, 'utf8') : null;
rmSync(TOKEN, { force: true });
mkdirSync(D, { recursive: true });
for (const f of ['configuration.yaml', 'automations.yaml']) copyFileSync(`${HR}/tools/testha/config/${f}`, `${D}/${f}`);
const FAKE = `${HR}/tools/testha/hr_fake`;
const oldMounts = { house_rules: `${OLD}/hausregeln/custom_components/house_rules`, floorplan_card: `${OLD}/custom_components/floorplan_card` };
plant(D, ['house_rules', 'floorplan_card']);

// ---------------------------------------------------------------- 1. the old integrations
console.log('\n# 1. alte Integrationen');
start({ hr_fake: FAKE });
ok(await up(), 'Test-HA läuft');
let tok = await token();
let ws = await wsConnect(tok);
let api = rest(tok);
async function entry(handler) {
  const has = async () => (await api('GET', '/api/config/config_entries/entry')).body.find((x) => x.domain === handler);
  if (!(await has())) {
    const flow = await api('POST', '/api/config/config_entries/flow', { handler });
    if (flow.body?.type === 'form') await api('POST', `/api/config/config_entries/flow/${flow.body.flow_id}`, {});
  }
  return until(async () => (await has())?.state === 'loaded' && (await has()), 60000, 500);
}
ok(!!(await entry('house_rules')), 'Hausregeln (alt) eingerichtet');
ok(!!(await entry('floorplan_card')), 'Grundriss-Karte (alt) eingerichtet');
await until(async () => (await ws.call({ type: 'house_rules/snapshot' })).starting === false, 150000, 1000);
await ws.call({ type: 'house_rules/mode/set', mode: 'guests' });
const rule = (
  await ws.call({
    type: 'house_rules/rule/save',
    rule: { name: 'Migration: Flurlicht', type: 'when', when: [{ subject: 'binary_sensor.praesenz_flur', verb: 'turns_on' }], and: [], then: [{ subject: 'light.flurlicht', verb: 'turn_on' }], only: [], enabled: true },
  })
).rule;
ok(!!rule?.id, 'Regel angelegt', rule);
await ws.call({ type: 'floorplan_card/card/save', card_id: 'migtest', config: { entry_alert: null } }).catch(() => null);
const regOld = (await ws.call({ type: 'config/entity_registry/list' })).filter((e) => e.platform === 'house_rules');
ok(regOld.length >= 3, `Entitäten von Hausregeln (${regOld.length})`);
// one entity renamed by the user: must keep its id
const sel = regOld.find((e) => e.entity_id.startsWith('select.'));
const RENAMED = 'select.mein_hausmodus';
await ws.call({ type: 'config/entity_registry/update', entity_id: sel.entity_id, new_entity_id: RENAMED });
const before = Object.fromEntries((await ws.call({ type: 'config/entity_registry/list' })).filter((e) => e.platform === 'house_rules').map((e) => [`${e.entity_id.split('.')[0]}|${e.unique_id}`, e.entity_id]));
ws.close();
stop();

// ---------------------------------------------------------------- 2. roomwise next to the old folders
console.log('\n# 2. roomwise neben den alten Ordnern');
start({ roomwise: `${ROOT}/custom_components/roomwise`, hr_fake: FAKE });
ok(await up(), 'Test-HA läuft');
tok = await token();
ws = await wsConnect(tok);
api = rest(tok);
await until(async () => (await ws.call({ type: 'house_rules/info' }).catch(() => null))?.loaded, 90000, 1000);
const info2 = await ws.call({ type: 'house_rules/info' });
ok(info2.version !== NEW, `Hausregeln läuft noch in der alten Integration (${info2.version})`);
// adding roomwise: the dialog first offers to move the old folders away; here without the restart
const f2 = await api('POST', '/api/config/config_entries/flow', { handler: 'roomwise' });
ok(f2.body?.step_id === 'old_folders', 'roomwise hinzufügen: zuerst „Frühere roomwise-Version gefunden“', f2.body);
const ph2 = f2.body?.description_placeholders?.folders ?? '';
ok(/floorplan_card/.test(ph2) && /house_rules/.test(ph2), 'nennt beide Ordner', ph2);
const done2 = (await api('POST', `/api/config/config_entries/flow/${f2.body.flow_id}`, { restart: false })).body;
ok(done2?.type === 'create_entry', 'Bestätigt (ohne Neustart): roomwise angelegt', done2);
ok(!present(D, 'floorplan_card') && !present(D, 'house_rules'), 'alte Ordner nicht mehr in custom_components');
const arch = archived(D);
ok(arch.some((a) => a.startsWith('floorplan_card-')) && arch.some((a) => a.startsWith('house_rules-')), `nichts gelöscht: beide liegen in roomwise-alte-ordner (${arch.join(', ')})`);
const rIssue = await until(async () => (await ws.call({ type: 'repairs/list_issues' })).issues.find((i) => i.domain === 'roomwise' && i.issue_id === 'restart_needed'), 20000, 500);
ok(!!rIssue?.is_fixable, 'Hinweis „Neustart nötig“ mit Knopf', rIssue);
ok((await api('GET', '/api/config/config_entries/entry')).body.some((e) => e.domain === 'house_rules'), 'alte Einträge bleiben bis zum Neustart (ihr Löschen würde Einstellungen löschen)');
ok((await ws.call({ type: 'config/entity_registry/list' })).filter((e) => e.platform === 'roomwise').length === 0, 'roomwise legt vor dem Neustart keine Entitäten an');
const rfix = await fix(api, 'restart_needed', {});
ok(rfix?.type === 'create_entry', 'Neustart über den Hinweis', rfix);
ws.close();

// ---------------------------------------------------------------- 3. after the restart
console.log('\n# 3. nach dem Neustart');
ok(await restarted(), 'Test-HA nach dem Neustart wieder da');
tok = await token();
ws = await wsConnect(tok);
api = rest(tok);
const info3 = await until(async () => {
  const i = await ws.call({ type: 'house_rules/info' }).catch(() => null);
  return i?.loaded && i;
}, 120000, 1000);
ok(info3?.version === NEW, `Hausregeln läuft in roomwise (${info3?.version})`);
const entries = (await api('GET', '/api/config/config_entries/entry')).body;
ok(!entries.some((e) => e.domain === 'house_rules' || e.domain === 'floorplan_card'), 'alte Einträge entfernt', entries.map((e) => e.domain));
ok(entries.some((e) => e.domain === 'roomwise' && e.state === 'loaded'), 'roomwise geladen');
const reg = await ws.call({ type: 'config/entity_registry/list' });
const after = Object.fromEntries(reg.filter((e) => e.platform === 'roomwise').map((e) => [`${e.entity_id.split('.')[0]}|${e.unique_id}`, e.entity_id]));
const lost = Object.entries(before).filter(([k, id]) => after[k] !== id);
ok(!lost.length, `alle ${Object.keys(before).length} Entitäten mit derselben ID übernommen`, lost.slice(0, 5));
ok(!reg.some((e) => e.platform === 'house_rules'), 'keine Entität mehr bei house_rules');
ok(after[`select|${sel.unique_id}`] === RENAMED, 'umbenannte Entität behält ihren Namen');
await until(async () => (await ws.call({ type: 'house_rules/snapshot' })).starting === false, 150000, 1000);
const snap = await ws.call({ type: 'house_rules/snapshot' });
ok(snap.mode === 'guests', `Hausmodus erhalten (${snap.mode})`);
ok(snap.rules.some((r) => r.id === rule.id), 'Regel erhalten');
const selState = (await api('GET', `/api/states/${RENAMED}`)).body;
ok(selState?.state && selState.state !== 'unavailable', `Hausmodus-Auswahl läuft (${selState?.state})`);
ok(!(await ws.call({ type: 'repairs/list_issues' })).issues.some((i) => i.issue_id === 'old_integrations'), 'Reparatur-Hinweis wieder weg');
const notes = await ws.call({ type: 'persistent_notification/get' }).catch(() => []);
ok(notes.some((n) => n.notification_id === 'roomwise_migrated'), 'Hinweis „übernommen“');
const fpInfo = await ws.call({ type: 'floorplan_card/info' }).catch((e) => ({ error: e.message }));
ok(fpInfo?.version === NEW, `Kartenteil läuft (${fpInfo?.version ?? fpInfo?.error})`);
const loader = await fetch(`${URL0}/floorplan_card_loader.js`);
ok(loader.ok, 'Karten-Lader wird ausgeliefert');
const panel = await fetch(`${URL0}/house_rules_static/house-rules-panel.js`);
ok(panel.ok || panel.status === 404, `Panel-Pfad registriert (${panel.status})`);
ok(!(await ws.call({ type: 'repairs/list_issues' })).issues.some((i) => i.issue_id === 'restart_needed'), 'Hinweis „Neustart nötig“ weg');
ws.close();
stop();

// ---------------------------------------------------------------- 4. HACS update from 0.1.0-beta.3
console.log('\n# 4. HACS-Update von beta.3: nur der alte Karten-Ordner');
const D4 = `${HR}/.cache/testha-migrate4`;
sh('docker rm -f hr-test-ha >/dev/null 2>&1 || true');
if (existsSync(D4)) sh(`docker run --rm -v "${HR}/.cache:/c" alpine rm -rf /c/testha-migrate4`);
rmSync(TOKEN, { force: true });
mkdirSync(D4, { recursive: true });
for (const f of ['configuration.yaml', 'automations.yaml']) copyFileSync(`${HR}/tools/testha/config/${f}`, `${D4}/${f}`);
plant(D4, ['floorplan_card']);
start({ hr_fake: FAKE }, D4);
ok(await up(), 'Test-HA läuft');
tok = await token();
api = rest(tok);
ok(!!(await entry('floorplan_card')), 'alte Grundriss-Karte eingerichtet (wie mit HACS beta.3)');
stop();
// 0.1.0-beta.4 added roomwise next to the old folder without asking: its entry is there, roomwise does not start
sh(`docker run --rm -v "${D4}:/c" --entrypoint python3 ghcr.io/home-assistant/home-assistant:stable -c "
import json, uuid
p = '/c/.storage/core.config_entries'
d = json.load(open(p))
old = next(e for e in d['data']['entries'] if e['domain'] == 'floorplan_card')
d['data']['entries'].append({**old, 'entry_id': uuid.uuid4().hex, 'domain': 'roomwise', 'title': 'roomwise', 'unique_id': None, 'data': {}, 'options': {}})
json.dump(d, open(p, 'w'))
"`);
// HACS installs roomwise next to it and leaves the old folder behind
start({ roomwise: `${ROOT}/custom_components/roomwise`, hr_fake: FAKE }, D4);
ok(await up(), 'Test-HA läuft');
tok = await token();
api = rest(tok);
ws = await wsConnect(tok);
const issue4 = await until(async () => (await ws.call({ type: 'repairs/list_issues' })).issues.find((i) => i.domain === 'roomwise' && i.issue_id === 'old_integrations'), 60000, 500);
ok(issue4?.is_fixable === true, 'Reparatur-Hinweis „frühere Version noch installiert“ mit Knopf „Beheben“', issue4);
const ph4 = issue4?.translation_placeholders?.folders ?? '';
ok(/floorplan_card/.test(ph4) && !/house_rules/.test(ph4), 'nennt nur den Karten-Ordner', ph4);
ok(!(await ws.call({ type: 'house_rules/info' }).catch(() => null))?.loaded, 'roomwise startet vorher nicht (keine Seitenleiste)');
ws.close();
const done4 = await fix(api, 'old_integrations', { restart: true });
ok(done4?.type === 'create_entry', 'Beheben (mit Neustart)', done4);
ok(!present(D4, 'floorplan_card') && archived(D4).some((a) => a.startsWith('floorplan_card-')), 'alter Ordner verschoben, nicht gelöscht');
ok(await restarted(), 'Test-HA nach dem Neustart wieder da');
tok = await token();
api = rest(tok);
ws = await wsConnect(tok);
const e4 = await until(async () => {
  const es = (await api('GET', '/api/config/config_entries/entry')).body;
  return es.some((e) => e.domain === 'roomwise' && e.state === 'loaded') && !es.some((e) => e.domain === 'floorplan_card') && es;
}, 120000, 1000);
ok(!!e4, 'roomwise läuft, alter Eintrag weg', e4 && e4.map((e) => `${e.domain}:${e.state}`));
const hr4 = await until(async () => {
  const i = await ws.call({ type: 'house_rules/info' }).catch(() => null);
  return i?.loaded && i;
}, 120000, 1000);
ok(hr4?.version === NEW, `Hausregeln läuft (Seitenleiste) (${hr4?.version})`);
ok((await fetch(`${URL0}/floorplan_card_loader.js`)).ok, 'Karten-Lader wird ausgeliefert');
ok(!(await ws.call({ type: 'repairs/list_issues' })).issues.some((i) => i.domain === 'roomwise' && ['old_integrations', 'restart_needed'].includes(i.issue_id)), 'keine roomwise-Hinweise mehr');
ws.close();

sh('docker rm -f hr-test-ha >/dev/null');
sh(`docker run --rm -v "${HR}/.cache:/c" alpine rm -rf /c/testha-migrate4`);
if (savedToken !== null) writeFileSync(TOKEN, savedToken);
else rmSync(TOKEN, { force: true });
console.log(failures() ? `\n${failures()} Fehler` : '\nalles ok');
process.exit(failures() ? 1 : 0);
