// Release features against the isolated test Home Assistant (port 8124): the logbook, a rule as a Home Assistant
// automation, rule history / trash / undo, roles (Admin, Bewohner, Gast) on every websocket command, and the clean
// removal of both integrations (Hausregeln and the floor plan card companion).
// The last part deletes and adds the integrations again: everything stored in this test HA is gone afterwards.
// Usage (holds the lock for start + test):
//   sh tools/heavy.sh testha sh -c 'sh hausregeln/tools/testha/start.sh && node hausregeln/tools/testha/test-release.mjs'
//   node hausregeln/tools/testha/test-release.mjs --skip-uninstall
import { existsSync, readFileSync } from 'node:fs';
import { token, wsConnect, rest, sleep, ok, failures, until, userToken } from './lib.mjs';

const SKIP_UNINSTALL = process.argv.includes('--skip-uninstall');
const ROOT = new URL('../../', import.meta.url);
const STORAGE = new URL('.cache/testha/.storage/', ROOT);
const tok = await until(async () => token().catch(() => undefined), 180000, 2000);
if (!tok) throw new Error('test HA not reachable');
let ws = await wsConnect(tok);
const api = rest(tok);
const err = (p) => p.then(() => '').catch((e) => e.message);
const denied = (p) => err(p).then((m) => /unauthorized/i.test(m));
const t0 = new Date().toISOString();

// ---------------------------------------------------------------- setup (idempotent)
async function ensureEntry(handler) {
  const entries = (await api('GET', '/api/config/config_entries/entry')).body;
  const e = entries.find((x) => x.domain === handler);
  if (e && e.state === 'loaded') return e.entry_id;
  if (!e) {
    const flow = await api('POST', '/api/config/config_entries/flow', { handler });
    if (flow.body?.type === 'form') await api('POST', `/api/config/config_entries/flow/${flow.body.flow_id}`, {});
  }
  return until(async () => (await api('GET', '/api/config/config_entries/entry')).body.find((x) => x.domain === handler && x.state === 'loaded')?.entry_id, 60000, 500);
}
await ensureEntry('roomwise');
const info = await until(async () => (await ws.call({ type: 'house_rules/info' }).catch(() => null))?.loaded && true, 60000);
ok(info, 'Hausregeln läuft');
await until(async () => (await ws.call({ type: 'house_rules/snapshot' })).devices.length > 10, 90000, 1000);
await until(async () => !(await ws.call({ type: 'house_rules/snapshot' })).alarm.settling, 120000, 1000);
const snapshot = () => ws.call({ type: 'house_rules/snapshot' });
const save = async (rule, conn = ws) => (await conn.call({ type: 'house_rules/rule/save', rule })).rule;
const set = (entity_id, state, attributes = {}) => ws.call({ type: 'hr_fake/set', entity_id, state, attributes });
for (const r of (await snapshot()).rules) if (r.id.startsWith('rel_')) await ws.call({ type: 'house_rules/rule/delete', rule_id: r.id });
await ws.call({ type: 'house_rules/trash/purge' });
await ws.call({ type: 'house_rules/alarm/disarm' }).catch(() => null);
await ws.call({ type: 'house_rules/alarm/config', config: { enabled: false, code: null, confirm: 'none' } });

// ---------------------------------------------------------------- 1. logbook
console.log('\n# Logbuch');
const logbook = (filter) => ws.call({ type: 'logbook/get_events', start_time: t0, end_time: new Date(Date.now() + 60000).toISOString() }).then((l) => l.filter(filter));
await set('light.flurlicht', 'off');
const klingel = await save({ id: 'rel_klingel', name: 'Klingel macht Flurlicht', type: 'when', when: [{ subject: 'input_button.klingel', verb: 'pressed' }], then: [{ subject: 'light.flurlicht', verb: 'turn_on' }], options: { manual_pause: '' } });
await api('POST', '/api/services/input_button/press', { entity_id: 'input_button.klingel' });
const fired = await until(async () => (await logbook((e) => e.name === klingel.name))[0], 15000, 500);
ok(fired && /hat ausgeführt: .*Flurlicht/.test(fired.message), 'Regel-Lauf steht mit lesbarer Nachricht im Logbuch', fired);
ok(fired?.entity_id?.startsWith('switch.'), 'Logbuch-Zeile gehört zum Schalter der Regel', fired?.entity_id);
// a run that is skipped (condition false) is not worth a logbook line
const skip = await save({ id: 'rel_skip', name: 'Nur im Urlaub', type: 'when', when: [{ subject: 'input_button.klingel', verb: 'pressed' }], and: [{ subject: 'mode', verb: 'is', mode: 'vacation' }], then: [{ subject: 'light.kuechenlicht', verb: 'turn_on' }], options: { manual_pause: '' } });
await api('POST', '/api/services/input_button/press', { entity_id: 'input_button.klingel' });
await sleep(2500);
ok(!(await logbook((e) => e.name === skip.name)).length, 'übersprungener Lauf steht nicht im Logbuch (nicht gesprächig)');
// alarm: armed / disarmed with who and why
await ws.call({ type: 'house_rules/alarm/config', config: { enabled: true, code: null, confirm: 'none', modes: { away: { sensors: ['binary_sensor.haustuer'], exit_delay: 0 } } } });
await set('binary_sensor.haustuer', 'off');
const armed = await ws.call({ type: 'house_rules/alarm/arm', mode: 'away', force: true });
ok(armed.ok !== false, 'Alarmanlage scharf', armed);
await sleep(800);
await ws.call({ type: 'house_rules/alarm/disarm' });
const alarmLines = await until(async () => {
  const l = await logbook((e) => e.name === 'Hausregeln' && /^Alarmanlage/.test(e.message ?? ''));
  return l.length >= 2 && l;
}, 15000, 500);
ok(alarmLines && alarmLines.some((e) => /scharf/.test(e.message)) && alarmLines.some((e) => /unscharf/.test(e.message)), 'Scharf und unscharf stehen im Logbuch', alarmLines);
ok(alarmLines?.every((e) => e.entity_id?.startsWith('alarm_control_panel.')), 'mit der Alarmanlage als Entität', alarmLines?.map((e) => e.entity_id));
await ws.call({ type: 'house_rules/alarm/config', config: { enabled: false } });
const ours = await logbook((e) => e.name === 'Hausregeln' || e.domain === 'roomwise');
ok(ours.length < 20, `wenige Zeilen von Hausregeln (${ours.length})`);

// ---------------------------------------------------------------- 2. export as automation
console.log('\n# Als Automation exportieren');
const exp = (rule_id) => ws.call({ type: 'house_rules/rule/export', rule_id });
const doors = await save({
  id: 'rel_tuer',
  name: 'Irgendeine Tür tagsüber',
  type: 'when',
  when: [{ subject: 'any:door', verb: 'opens' }],
  and: [{ subject: 'time', verb: 'between', from: '08:00', to: '20:00' }],
  then: [{ subject: 'light.flurlicht', verb: 'dim', brightness: 40 }],
  options: { manual_pause: '' },
});
let e1 = await exp(doors.id);
const trig = e1.automation.triggers[0];
ok(Array.isArray(trig.entity_id) && trig.entity_id.includes('binary_sensor.haustuer') && trig.entity_id.length >= 2, '„irgendeine Tür“ wird zur Liste der Türen', trig);
ok(trig.trigger === 'state' && trig.to === 'on', 'Tür geht auf = Zustand „on“', trig);
ok(e1.automation.conditions.some((c) => c.condition === 'time' && c.after === '08:00:00' && c.before === '20:00:00'), 'Zeitfenster als Bedingung', e1.automation.conditions);
ok(e1.automation.actions[0].action === 'light.turn_on' && e1.automation.actions[0].data.brightness_pct === 40, 'Dimmen als light.turn_on', e1.automation.actions);
ok(e1.complete && !e1.notes.length && /alias: Irgendeine Tür tagsüber/.test(e1.yaml), 'vollständig übertragbar, YAML lesbar', e1.notes);
const dark = await save({
  id: 'rel_dunkel',
  name: 'Flur dunkel',
  type: 'when',
  when: [{ subject: 'binary_sensor.praesenz_flur', verb: 'occupied' }],
  and: [{ subject: `room:${(await snapshot()).rooms[0]?.id ?? 'x'}`, verb: 'is_dark' }],
  then: [{ subject: 'light.flurlicht', verb: 'turn_on', for: '5m' }],
  options: { manual_pause: '1h' },
});
let e2 = await exp(dark.id);
ok(!e2.complete && e2.notes.length >= 2, 'nicht Übertragbares wird benannt', e2.notes);
ok(/Nicht übertragbar: /.test(e2.yaml) && e2.automation.conditions.some((c) => /^Nicht übertragbar/.test(c.alias ?? '')), 'und an der Stelle markiert', e2.yaml.slice(0, 600));
ok(e2.notes.some((n) => /von Hand/.test(n)), 'Hinweis: Hausregeln lässt von Hand geschaltete Geräte aus', e2.notes);
const toggle = await save({ id: 'rel_wechsel', name: 'Bad wechselnd', type: 'while', when: [{ subject: 'binary_sensor.fenster_bad', verb: 'is_open' }], then: [{ subject: 'light.badlicht', verb: 'turn_on' }], else: [{ subject: 'light.badlicht', verb: 'turn_off' }] });
const e3 = await exp(toggle.id);
ok(e3.automation.mode === 'restart' && e3.automation.actions[0].choose?.[0].sequence[0].action === 'light.turn_on' && e3.automation.actions[0].default?.[0].action === 'light.turn_off', '„Wechselnd“ wird zu choose mit sonst-Zweig', e3.automation.actions);
ok(e3.automation.triggers.length >= 2, 'Auslöser für beide Richtungen', e3.automation.triggers);
// a draft (not saved) can be exported too
const draft = await ws.call({ type: 'house_rules/rule/export', rule: { name: 'Entwurf', type: 'when', when: [{ subject: 'sun', verb: 'sets', offset: '-30m' }], then: [{ subject: 'light.sofalicht', verb: 'turn_on' }] } });
ok(draft.automation.triggers[0].trigger === 'sun' && draft.automation.triggers[0].offset === '-00:30:00', 'Entwurf: Sonnenuntergang mit Versatz', draft.automation.triggers);

// create it in Home Assistant through its automation config API, then the rule is paused here
const simple = await save({ id: 'rel_auto', name: 'Haustür macht Sofalicht', type: 'when', when: [{ subject: 'binary_sensor.haustuer', verb: 'opens' }], then: [{ subject: 'light.sofalicht', verb: 'turn_on' }], options: { manual_pause: '' } });
const e4 = await exp(simple.id);
const tabletTok = await userToken(tok, 'tablet');
const tabletApi = rest(tabletTok);
const tabletPost = await tabletApi('POST', `/api/config/automation/config/${e4.id}`, e4.automation);
ok(tabletPost.status === 401 || tabletPost.status === 403, `Nicht-Admin kann in Home Assistant keine Automation anlegen (${tabletPost.status})`);
const created = await api('POST', `/api/config/automation/config/${e4.id}`, e4.automation);
ok(created.status === 200, `Automation über die Konfig-API angelegt (${created.status})`, created.body);
const autoEntity = await until(async () => (await ws.call({ type: 'config/entity_registry/list' })).find((x) => x.platform === 'automation' && x.unique_id === e4.id)?.entity_id, 20000, 500);
ok(autoEntity, `Automation da: ${autoEntity}`);
const marked = await ws.call({ type: 'house_rules/rule/exported', rule_id: simple.id, automation_id: e4.id });
ok(marked.rule.enabled === false && marked.rule.meta.exported?.automation_id === e4.id, 'Regel hier ausgeschaltet, nicht gelöscht', marked.rule);
ok((await snapshot()).rules.some((r) => r.id === simple.id), 'Regel bleibt in der Liste');
await set('light.sofalicht', 'off');
await set('binary_sensor.haustuer', 'off');
await sleep(300);
await set('binary_sensor.haustuer', 'on');
ok(await until(async () => (await api('GET', '/api/states/light.sofalicht')).body.state === 'on', 8000), 'die angelegte Automation schaltet wirklich');
await set('binary_sensor.haustuer', 'off');
await api('DELETE', `/api/config/automation/config/${e4.id}`);

// ---------------------------------------------------------------- 3. history, trash, undo
console.log('\n# Verlauf und Papierkorb');
const base = { id: 'rel_verlauf', name: 'Version eins', type: 'when', when: [{ subject: 'binary_sensor.badtuer', verb: 'opens' }], then: [{ subject: 'light.badlicht', verb: 'turn_on' }] };
await save(base);
await save({ ...base, name: 'Version zwei' });
await save({ ...base, name: 'Version zwei', then: [{ subject: 'light.badlicht', verb: 'turn_off' }] });
await save({ ...base, name: 'Version zwei', then: [{ subject: 'light.badlicht', verb: 'turn_off' }] }); // nothing changed: no version
let versions = await ws.call({ type: 'house_rules/rule/versions', rule_id: base.id });
ok(versions.length === 3, `drei Versionen (${versions.length})`, versions.map((v) => v.kind));
ok(versions[0].current && versions[0].summary === 'Die Aktionen wurden geändert.' && versions[1].summary === 'Der Name wurde geändert.' && versions[2].kind === 'create', 'Zusammenfassung als Sätze, neueste zuerst', versions.map((v) => v.summary));
ok(versions[0].by_name && versions[0].at && versions[2].sentence.length > 10, 'wer, wann, die Regel als Satz', versions[0]);
const first = versions[2];
const restored = await ws.call({ type: 'house_rules/rule/restore_version', rule_id: base.id, version: first.id });
ok(restored.rule.name === 'Version eins' && restored.rule.then[0].verb === 'turn_on', 'frühere Version wiederhergestellt', restored.rule);
versions = await ws.call({ type: 'house_rules/rule/versions', rule_id: base.id });
ok(versions.length === 4 && versions[0].kind === 'restore' && /wurde wiederhergestellt/.test(versions[0].summary), 'Wiederherstellen ist eine neue Version', versions[0]);
for (let i = 0; i < 25; i++) await save({ ...base, name: `Viele ${i}` });
ok((await ws.call({ type: 'house_rules/rule/versions', rule_id: base.id })).length === 20, 'höchstens 20 Versionen je Regel');
// delete → trash → "Rückgängig"
await ws.call({ type: 'house_rules/rule/delete', rule_id: base.id });
let trash = await ws.call({ type: 'house_rules/trash/list' });
const item = trash.find((t) => t.id === base.id);
ok(item && item.deleted && item.until && item.deleted_by_name && item.sentence, 'gelöscht liegt im Papierkorb (mit Zeit, wer, bis wann)', item);
ok(!(await snapshot()).rules.some((r) => r.id === base.id), 'und nicht mehr in den Regeln');
const back = await ws.call({ type: 'house_rules/trash/restore', rule_id: base.id });
ok(back.rule.id === base.id && (await snapshot()).rules.some((r) => r.id === base.id), 'Rückgängig holt sie zurück');
ok((await ws.call({ type: 'house_rules/rule/versions', rule_id: base.id }))[0].kind === 'trash_restore', 'Zurückholen steht im Verlauf');
ok(/nicht im Papierkorb/.test(await err(ws.call({ type: 'house_rules/trash/restore', rule_id: base.id }))), 'zweimal zurückholen geht nicht');
// a rule with the same id exists meanwhile: it comes back under a new id
await ws.call({ type: 'house_rules/rule/delete', rule_id: base.id });
await save({ ...base, name: 'Neue mit gleicher Id' });
const twin = await ws.call({ type: 'house_rules/trash/restore', rule_id: base.id });
ok(twin.rule.id !== base.id && (await snapshot()).rules.filter((r) => r.id === base.id || r.id === twin.rule.id).length === 2, 'gleiche Id: kommt mit neuer Id zurück', twin.rule.id);
await ws.call({ type: 'house_rules/rule/delete', rule_id: twin.rule.id });
ok((await ws.call({ type: 'house_rules/trash/purge', rule_id: twin.rule.id })).removed === 1, 'endgültig löschen');

// ---------------------------------------------------------------- 4. roles on every command
console.log('\n# Rollen');
const permSrc = readFileSync(new URL('../custom_components/roomwise/house_rules/permissions.py', ROOT), 'utf8');
const wsSrc = readFileSync(new URL('../custom_components/roomwise/house_rules/websocket.py', ROOT), 'utf8');
const NEED = Object.fromEntries([...permSrc.matchAll(/^\s+"([a-z_/]+)": "(guest|resident|admin|ha_admin)",/gm)].map((m) => [m[1], m[2]]));
const registered = [...new Set([...wsSrc.matchAll(/"house_rules\/([a-z_/]+)"/g)].map((m) => m[1]))];
ok(registered.every((c) => NEED[c]), 'jeder Befehl hat eine Rolle', registered.filter((c) => !NEED[c]));
const snap0 = await snapshot();
// minimal payloads that pass the schema (the role check runs after the schema)
const P = {
  'rule/save': { rule: {} },
  'rule/delete': { rule_id: 'perm_none' },
  'rule/enable': { rule_id: 'perm_none', enabled: true },
  'rule/pause': { rule_id: 'perm_none', minutes: 5 },
  'rule/run': { rule_id: 'perm_none' },
  'rule/test': { rule: {} },
  'rule/describe': { rule: {} },
  'rule/entities': { rule: {} },
  'rule/run_actions': { rule: {} },
  'rule/versions': { rule_id: 'perm_none' },
  'rule/restore_version': { rule_id: 'perm_none', version: 'x' },
  'rule/export': { rule_id: 'perm_none' },
  'rule/exported': { rule_id: 'perm_none', automation_id: 'x' },
  'trash/restore': { rule_id: 'perm_none' },
  'trash/purge': { rule_id: 'perm_none' },
  from_text: { text: 'Wenn die Haustür aufgeht, Flurlicht an' },
  for_entity: { entity_id: 'light.none' },
  for_entities: { entity_ids: ['light.none'] },
  'entities/search': { query: 'radar' },
  'mode/set': { mode: snap0.mode },
  'room/save': { room: {} },
  'behaviour/set': { behaviour: 'none', on: false },
  'devices/set': { changes: [] },
  'suggestion/dismiss': { suggestion_id: 'perm_test' },
  'automation/enable': { entity_id: 'automation.none', enabled: true },
  'settings/set': { settings: {} },
  'ui/set': { ui: {} },
  'glow/set': { glow: {} },
  'lightcal/get': {},
  'lightcal/set': { lights: {} },
  'group/save': { group: {} },
  'group/delete': { group_id: 'none' },
  'alarm/arm': { mode: 'away' },
  'alarm/disarm': { code: '0000' },
  'alarm/config': { config: {} },
  'objects/save': { object: { name: 'perm' } },
  'objects/delete': { object_id: 'o_permnone' },
  'objects/test': { object_id: 'o_permnone' },
  'objects/arm': { object_id: 'o_permnone' },
  'objects/disarm': { object_id: 'o_permnone', code: '0000' },
  'ai/set': { ai: {} },
  'ai/review': { rule: {} },
  'ai/improve': { text: 'Licht an', rule: {} },
  'mode_auto/set': { mode: '_enabled', config: {} },
  'wakeup/set': { config: {} },
  'sim/set': { config: {} },
  'alarm/register_device': { payload: {}, name: 'x', rp_id: 'localhost' },
  'alarm/preview_tone': { tone: 'gong', player: 'media_player.none' },
  'alarm/siren_test': { seconds: 1, volume: 10 },
  'alarm/siren_test_stop': {},
  'alarm/channel_test': { channel: 'email' },
  'cleaning/set': { config: {} },
  'plan/set': { kind: 'light', room: 'none', plan: {} },
  'plan/habits': { room: 'none' },
  'heating/set': { config: {} },
  'heating/do': { action: 'clear_manual', room: 'none' },
  'heating/explain': { room: 'none' },
  'heating/plan': { room: 'none' },
  'heating/test': { action: 'tick' },
  'features/set': { features: {} },
  'setup/apply': { step: 'modes' },
  'window_warning/set': { config: {} },
  'window_warning/import': { entry_alert: {}, openings: [] },
  'telemetry/set': { on: false },
  'telemetry/client': { browser: 'other' },
  'backup/preview': { backup: {} },
  'backup/restore': { backup: {}, mode: 'merge' },
  'roles/set': { user_id: 'perm_none', role: 'guest' },
  'assistant/mark': { feature: 'light', done: false },
  'assistant/suggest': { feature: 'light' },
  'assistant/apply': { feature: 'light', answers: {} },
  'light/learned': { room: 'none' },
  'light/forget': { room: 'none' },
  'light/preview': { action: 'keep', session: 'none' },
  'places/person': { person_id: 'none' },
  'places/predict': { person_id: 'none' },
  'places/name': { place_id: 'none', name: 'x' },
  'places/delete': { place_id: 'none' },
  'places/to_zone': { place_id: 'none' },
  'places/relearn': { days: 1 },
};
const RANK = { guest: 0, resident: 1, admin: 2, ha_admin: 3 };
const roles = async () => (await ws.call({ type: 'house_rules/roles/get' })).users;
const tabletUser = (await roles()).find((u) => u.name === 'tablet');
ok(tabletUser && tabletUser.role === 'resident' && !tabletUser.fixed, 'Standard: Nicht-Admin ist Bewohner', tabletUser);
ok((await roles()).filter((u) => u.ha_admin).every((u) => u.role === 'admin' && u.fixed), 'HA-Admins sind fest Admin');
ok(/immer Admin/.test(await err(ws.call({ type: 'house_rules/roles/set', user_id: (await roles()).find((u) => u.ha_admin).id, role: 'guest' }))), 'HA-Admin lässt sich nicht herabstufen');

async function matrix(role, only = null) {
  await ws.call({ type: 'house_rules/roles/set', user_id: tabletUser.id, role });
  const conn = await wsConnect(tabletTok);
  const me = await conn.call({ type: 'house_rules/permissions' });
  ok(me.role === role, `Rolle ${role} kommt beim Benutzer an`, me);
  const snap = await conn.call({ type: 'house_rules/snapshot' });
  ok(snap.me?.role === role, `Snapshot nennt die eigene Rolle (${role})`, snap.me);
  const wrong = [];
  for (const cmd of registered) {
    if (cmd === 'subscribe' || (only && !only(cmd))) continue;
    const should = RANK[role] >= RANK[NEED[cmd]];
    const msg = await err(conn.call({ type: `house_rules/${cmd}`, ...(P[cmd] ?? {}) }));
    const refused = /unauthorized/i.test(msg);
    const pinOnly = cmd === 'alarm/register_device' && /PIN/.test(msg);
    if (refused !== !should && !pinOnly) wrong.push(`${cmd}: ${refused ? 'abgelehnt' : 'erlaubt'} (${msg || 'ok'})`);
    if (/invalid_format/.test(msg)) wrong.push(`${cmd}: Testdaten passen nicht (${msg})`);
  }
  ok(!wrong.length, `${role}: jeder Befehl erlaubt/abgelehnt wie in der Tabelle`, wrong);
  return conn;
}
await ws.call({ type: 'house_rules/alarm/config', config: { enabled: false, code: null, confirm: 'none' } });
const guest = await matrix('guest');
ok(await denied(save({ id: 'rel_gast', name: 'Gast', type: 'when', when: [{ subject: 'binary_sensor.badtuer', verb: 'opens' }], then: [{ subject: 'light.badlicht', verb: 'turn_on' }] }, guest)), 'Gast: keine Regel anlegen');
ok(!(await denied(guest.call({ type: 'house_rules/window_warning/ack' }))) && !(await denied(guest.call({ type: 'house_rules/rule/run', rule_id: klingel.id }))), 'Gast: bedienen (bestätigen, Regel ausführen) geht');
const guestPause = await tabletApi('POST', '/api/services/roomwise/pause', { rule_id: klingel.id, minutes: 1 });
ok(guestPause.status === 401 || guestPause.status === 403, `Gast: auch die Aktion roomwise.pause wird abgelehnt (${guestPause.status})`);
guest.close();
const resident = await matrix('resident');
const resRule = await save({ id: 'rel_bewohner', name: 'Vom Bewohner', type: 'when', when: [{ subject: 'binary_sensor.badtuer', verb: 'opens' }], then: [{ subject: 'light.badlicht', verb: 'turn_on' }] }, resident).catch((e) => e);
ok(resRule.id === 'rel_bewohner', 'Bewohner: Regel anlegen geht', resRule.message);
ok(!(await denied(resident.call({ type: 'house_rules/rule/delete', rule_id: 'rel_bewohner' }))) && !(await denied(resident.call({ type: 'house_rules/trash/restore', rule_id: 'rel_bewohner' }))), 'Bewohner: löschen und zurückholen geht');
ok(await denied(save({ id: 'rel_sicher', name: 'Sicher', type: 'when', when: [{ subject: 'binary_sensor.badtuer', verb: 'opens' }], then: [{ subject: 'lock.none', verb: 'unlock' }], options: { allow_sensitive: true } }, resident)), 'Bewohner: keine Regel, die Schlösser öffnen darf');
ok(await denied(save({ id: 'rel_alarm', name: 'Alarm', type: 'when', when: [{ subject: 'binary_sensor.badtuer', verb: 'opens' }], then: [{ subject: 'alarm', verb: 'arm_away' }] }, resident)), 'Bewohner: keine Regel, die die Alarmanlage schaltet');
const adminAlarmRule = await save({ id: 'rel_alarm2', name: 'Alarm vom Admin', type: 'when', when: [{ subject: 'binary_sensor.badtuer', verb: 'opens' }], then: [{ subject: 'alarm', verb: 'arm_away' }], enabled: false });
ok(await denied(resident.call({ type: 'house_rules/rule/delete', rule_id: adminAlarmRule.id })), 'Bewohner: Sicherheits-Regel des Admins nicht löschen');
ok(await denied(resident.call({ type: 'house_rules/heating/do', action: 'exercise' })), 'Bewohner: Ventilschutz (Einstellung) nicht');
ok(await denied(resident.call({ type: 'house_rules/settings/set', settings: { eco_temp: 12 } })), 'Bewohner: keine Einstellungen');
resident.close();
// an admin may do everything: only check the commands that need a Home Assistant admin (the rest would really run)
const promoted = await matrix('admin', (cmd) => NEED[cmd] === 'ha_admin' || ['roles/get', 'permissions', 'snapshot'].includes(cmd));
ok(!(await denied(promoted.call({ type: 'house_rules/settings/set', settings: {} }))), 'zum Admin gemacht: Einstellungen gehen');
ok(await denied(promoted.call({ type: 'house_rules/automation/enable', entity_id: 'automation.none', enabled: true })), 'aber HA-Automationen schaltet nur ein HA-Admin');
// a role in Hausregeln never gives more than Home Assistant does: security, data leaving the house, roles
for (const [cmd, what] of [
  ['alarm/config', 'Alarm-Einstellungen'],
  ['objects/save', 'Weitere Alarme anlegen'],
  ['ai/set', 'KI-Verbindung (Adresse, Schlüssel)'],
  ['ai/test', 'KI-Verbindung testen'],
  ['telemetry/set', 'Diagnosedaten'],
  ['features/set', 'Funktionen'],
  ['backup/restore', 'Sicherung zurückspielen'],
  ['roles/set', 'Rollen'],
])
  ok(NEED[cmd] === 'ha_admin' && (await denied(promoted.call({ type: `house_rules/${cmd}`, ...(P[cmd] ?? {}) }))), `zum Admin gemacht, aber kein HA-Admin: ${what} abgelehnt`);
ok(await denied(promoted.call({ type: 'house_rules/alarm/register_device', payload: {}, name: 'x', rp_id: 'localhost' })), 'zum Admin gemacht: Face-ID-Gerät nur mit PIN');
ok(await denied(promoted.call({ type: 'house_rules/assistant/apply', feature: 'alarm', answers: {} })), 'zum Admin gemacht: Alarm-Assistent nicht');
const pme = await promoted.call({ type: 'house_rules/permissions' });
ok(!pme.ha_admin && pme.can.settings && !pme.can.security && !pme.can.features, 'zum Admin gemacht: can.security und can.features aus, can.settings an', pme);
promoted.close();
await ws.call({ type: 'house_rules/roles/set', user_id: tabletUser.id, role: 'resident' });
ok((await roles()).find((u) => u.id === tabletUser.id).role === 'resident', 'zurück auf Bewohner');

// ---------------------------------------------------------------- 5. clean removal
if (!SKIP_UNINSTALL) {
  console.log('\n# Entfernen');
  const has = (key) => existsSync(new URL(key, STORAGE));
  let entry = await ensureEntry('roomwise');
  // reload and disable keep everything
  await api('POST', `/api/config/config_entries/entry/${entry}/reload`);
  await until(async () => (await ws.call({ type: 'house_rules/info' }).catch(() => null))?.loaded, 60000, 500);
  ok((await snapshot()).rules.some((r) => r.id === klingel.id), 'neu laden: Regeln bleiben');
  await ws.call({ type: 'config_entries/disable', entry_id: entry, disabled_by: 'user' });
  await sleep(1500);
  ok(has('house_rules') && has('house_rules.versions'), 'ausgeschaltet: Dateien bleiben');
  await ws.call({ type: 'config_entries/disable', entry_id: entry, disabled_by: null });
  await until(async () => (await ws.call({ type: 'house_rules/info' }).catch(() => null))?.loaded, 60000, 500);
  ok(await until(async () => (await snapshot()).rules.some((r) => r.id === klingel.id), 20000), 'wieder eingeschaltet: Regeln da');
  await save({ id: 'rel_fehlt', name: 'Mit fehlendem Gerät', type: 'when', when: [{ subject: 'binary_sensor.haustuer', verb: 'opens' }], then: [{ subject: 'light.gibt_es_nicht', verb: 'turn_on' }] });
  await ws.call({ type: 'house_rules/issues/check' }).catch(() => null);
  const issuesBefore = (await ws.call({ type: 'repairs/list_issues' })).issues.filter((i) => i.domain === 'roomwise').length;
  const entitiesBefore = (await ws.call({ type: 'config/entity_registry/list' })).filter((e) => e.platform === 'roomwise').length;
  // the card part: stored settings, a dashboard resource pointing to its files (from earlier versions)
  await ws.call({ type: 'floorplan_card/walks/done', card_id: 'release_test', pet_id: 'hund', slot: '07:00' }).catch((e) => console.log('walks', e.message));
  const resList = () => ws.call({ type: 'lovelace/resources' });
  const mine = await ws.call({ type: 'lovelace/resources/create', res_type: 'module', url: '/floorplan_card_files/floorplan-card.js?v=1' }).catch((e) => ({ error: e.message }));
  const other = await ws.call({ type: 'lovelace/resources/create', res_type: 'module', url: '/local/andere-karte.js' }).catch((e) => ({ error: e.message }));
  ok(!mine.error && !other.error, 'Dashboard-Ressourcen angelegt', [mine, other]);
  await sleep(6000); // delayed writes reach the disk
  ok(has('house_rules') && has('house_rules.history') && has('house_rules.versions') && has('floorplan_card'), 'vorher: Dateien da (Hausregeln und Kartenteil)');
  ok(entitiesBefore > 3, `vorher: ${entitiesBefore} Entitäten, ${issuesBefore} Reparatur-Hinweise`);
  const del = await api('DELETE', `/api/config/config_entries/entry/${entry}`);
  ok(del.status === 200, `Integration gelöscht (${del.status})`);
  await sleep(7000); // longer than any delayed write: nothing may come back
  const left = ['house_rules', 'house_rules.history', 'house_rules.habits', 'house_rules.smart_heat', 'house_rules.telemetry', 'house_rules.versions'].filter(has);
  ok(!left.length, 'keine Dateien von Hausregeln übrig', left);
  ok(!has('floorplan_card'), 'Kartenteil: Datei gelöscht');
  const urls = (await resList()).map((r) => r.url);
  ok(!urls.some((u) => u.startsWith('/floorplan_card_files/')) && urls.includes('/local/andere-karte.js'), 'eigene Dashboard-Ressource entfernt, fremde bleibt', urls);
  for (const r of await resList()) if (r.url === '/local/andere-karte.js') await ws.call({ type: 'lovelace/resources/delete', resource_id: r.id });
  ok(!(await ws.call({ type: 'config/entity_registry/list' })).some((e) => e.platform === 'roomwise'), 'keine Entitäten übrig');
  ok(!(await ws.call({ type: 'repairs/list_issues' })).issues.some((i) => i.domain === 'roomwise'), 'keine Reparatur-Hinweise übrig');
  ok(!('hausregeln' in (await ws.call({ type: 'get_panels' }))), 'Seitenleiste ohne Hausregeln');
  entry = await ensureEntry('roomwise');
  ok(entry && (await until(async () => (await ws.call({ type: 'house_rules/info' }).catch(() => null))?.loaded, 60000, 500)), 'wieder hinzufügen geht (frisch)');
  ok(!(await snapshot()).rules.some((r) => r.id === klingel.id), 'frisch: alte Regeln sind weg');

}

ws.close();
console.log(failures() ? `\n${failures()} FEHLER` : '\nalles ok');
process.exit(failures() ? 1 : 0);
