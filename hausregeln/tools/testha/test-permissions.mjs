// Permission matrix and security checks of both integrations against the isolated test Home Assistant (port 8124).
// Every websocket command of house_rules/* and floorplan_card/* is read from the Python sources, checked to be
// registered, and called as a non-admin user (e.g. a wall tablet): admin-only commands must be refused, every
// other command must answer without a crash. Plus: unauthenticated static files, button events from phones,
// secrets in what any user can read, size limits.
// Usage (holds the lock for start + test): sh tools/heavy.sh testha sh -c 'sh hausregeln/tools/testha/start.sh && node hausregeln/tools/testha/test-permissions.mjs'
import { readFileSync } from 'node:fs';
import { token, wsConnect, rest, ok, failures, until, userToken, URL0 } from './lib.mjs';

const ROOT = new URL('../../../', import.meta.url);
const tok = await until(async () => token().catch(() => undefined), 180000, 2000);
if (!tok) throw new Error('test HA not reachable');
const ws = await wsConnect(tok);
const api = rest(tok);

// ---------------------------------------------------------------- set up roomwise (idempotent)
for (const handler of ['roomwise']) {
  const entries = (await api('GET', '/api/config/config_entries/entry')).body;
  if (entries.some((e) => e.domain === handler && e.state === 'loaded')) continue;
  const flow = await api('POST', '/api/config/config_entries/flow', { handler });
  if (flow.body?.type === 'form') await api('POST', `/api/config/config_entries/flow/${flow.body.flow_id}`, {});
}
await until(async () => (await ws.call({ type: 'house_rules/info' }).catch(() => null))?.loaded, 30000);
await until(async () => (await ws.call({ type: 'floorplan_card/info' }).catch(() => null))?.loaded, 30000);

const tabletTok = await userToken(tok, 'tablet');
const tablet = await wsConnect(tabletTok);
const tabletApi = rest(tabletTok);

// ---------------------------------------------------------------- the intended matrix
// admin = only admins; ha_admin = only a real Home Assistant admin (also refused for a user made "Admin" in Hausregeln);
// any = every logged-in user; pin = a Home Assistant admin, or anyone else who knows the alarm PIN
// The tablet has the default role of a non-admin in Hausregeln: Bewohner (resident). Commands a resident may use are
// 'any' here; what a guest may not do is checked in test-release.mjs (roles on every command).
// The payloads are minimal valid ones (schema first, then the permission check runs).
const snap = await ws.call({ type: 'house_rules/snapshot' });
const MATRIX = {
  'house_rules/info': ['any', {}],
  'house_rules/subscribe': ['any', {}],
  'house_rules/snapshot': ['any', {}],
  'house_rules/rule/save': ['any', { rule: {} }],
  'house_rules/rule/delete': ['any', { rule_id: 'perm_none' }],
  'house_rules/rule/enable': ['any', { rule_id: 'perm_none', enabled: true }],
  'house_rules/rule/pause': ['any', { rule_id: 'perm_none', minutes: 5 }],
  'house_rules/rule/run': ['any', { rule_id: 'perm_none' }],
  'house_rules/rule/test': ['any', { rule: {} }],
  'house_rules/rule/describe': ['any', { rule: {} }],
  'house_rules/from_text': ['any', { text: 'Wenn die Haustür aufgeht, Flurlicht an' }],
  'house_rules/for_entity': ['any', { entity_id: 'light.none' }],
  'house_rules/for_entities': ['any', { entity_ids: ['light.none'] }],
  'house_rules/mode/set': ['any', { mode: snap.mode }],
  'house_rules/room/save': ['admin', { room: {} }],
  'house_rules/behaviour/set': ['admin', { behaviour: 'none', on: false }],
  'house_rules/devices/set': ['admin', { changes: [] }],
  'house_rules/suggestion/dismiss': ['any', { suggestion_id: 'perm_test' }],
  'house_rules/automation/enable': ['ha_admin', { entity_id: 'automation.none', enabled: true }],
  'house_rules/vocabulary': ['any', {}],
  'house_rules/history': ['any', {}],
  'house_rules/settings/set': ['admin', { settings: {} }],
  'house_rules/ui/set': ['any', { ui: {} }],
  'house_rules/glow/set': ['any', { glow: {} }],
  'house_rules/lightcal/get': ['any', {}],
  'house_rules/lightcal/set': ['any', { lights: {} }],
  'house_rules/group/save': ['admin', { group: {} }],
  'house_rules/group/delete': ['admin', { group_id: 'none' }],
  'house_rules/alarm/arm': ['any', { mode: 'away' }],
  'house_rules/alarm/disarm': ['any', { code: '0000' }],
  'house_rules/alarm/silence': ['any', {}],
  'house_rules/alarm/test': ['admin', {}],
  'house_rules/alarm/config': ['ha_admin', { config: {} }],
  // object alarms ("Weitere Alarme"): set up by admins; arm and disarm (with the house alarm's PIN) by anyone
  'house_rules/objects/save': ['ha_admin', { object: { name: 'perm' } }],
  'house_rules/objects/delete': ['ha_admin', { object_id: 'o_permnone' }],
  'house_rules/objects/arm': ['any', { object_id: 'o_permnone' }],
  'house_rules/objects/disarm': ['any', { object_id: 'o_permnone', code: '0000' }],
  'house_rules/objects/test': ['ha_admin', { object_id: 'o_permnone' }],
  'house_rules/ai/set': ['ha_admin', { ai: {} }],
  'house_rules/ai/test': ['ha_admin', {}],
  'house_rules/rule/entities': ['any', { rule: {} }],
  'house_rules/suggestion/restore': ['admin', {}],
  'house_rules/rule/run_actions': ['any', { rule: {} }],
  'house_rules/mode_auto/set': ['admin', { mode: '_enabled', config: {} }],
  'house_rules/wakeup/set': ['admin', { config: {} }],
  'house_rules/wakeup/reset': ['admin', {}],
  'house_rules/sim/view': ['any', {}],
  'house_rules/sim/set': ['admin', { config: {} }],
  'house_rules/sim/learn': ['admin', {}],
  'house_rules/alarm/challenge': ['any', {}],
  'house_rules/alarm/register_device': ['pin', { payload: {}, name: 'x', rp_id: 'localhost' }],
  'house_rules/alarm/preview_tone': ['admin', { tone: 'gong', player: 'media_player.none' }],
  'house_rules/alarm/channel_test': ['admin', { channel: 'email' }],
  'house_rules/cleaning/set': ['admin', { config: {} }],
  'house_rules/plan/set': ['any', { kind: 'light', room: 'none', plan: {} }],
  'house_rules/plan/habits': ['any', { room: 'none' }],
  'house_rules/heating/set': ['admin', { config: {} }],
  'house_rules/heating/do': ['any', { action: 'clear_manual', room: 'none' }],
  'house_rules/ai/review': ['any', { rule: {} }],
  'house_rules/ai/improve': ['any', { text: 'Licht an', rule: {} }],
  'house_rules/features/set': ['ha_admin', { features: {} }],
  'house_rules/setup/save': ['admin', {}],
  'house_rules/setup/suggest': ['admin', {}],
  'house_rules/setup/apply': ['admin', { step: 'modes' }],
  'house_rules/window_warning/get': ['any', {}],
  'house_rules/window_warning/set': ['admin', { config: {} }],
  'house_rules/window_warning/ack': ['any', {}],
  'house_rules/window_warning/import': ['admin', { entry_alert: {}, openings: [] }],
  'house_rules/heating/explain': ['any', { room: 'none' }],
  'house_rules/heating/plan': ['any', { room: 'none' }],
  'house_rules/heating/assistant': ['admin', {}],
  'house_rules/heating/test': ['admin', { action: 'tick' }],
  'house_rules/telemetry/get': ['any', {}],
  'house_rules/telemetry/set': ['ha_admin', { on: false }],
  'house_rules/telemetry/preview': ['admin', {}],
  'house_rules/telemetry/delete': ['ha_admin', {}],
  'house_rules/telemetry/send_now': ['ha_admin', {}],
  'house_rules/telemetry/client': ['any', { browser: 'other' }],
  'house_rules/backup/export': ['admin', {}],
  'house_rules/backup/preview': ['admin', { backup: {} }],
  'house_rules/backup/restore': ['ha_admin', { backup: {}, mode: 'merge' }],
  'house_rules/issues/check': ['admin', {}],
  'house_rules/permissions': ['any', {}],
  'house_rules/roles/get': ['admin', {}],
  'house_rules/roles/set': ['ha_admin', { user_id: 'perm_none', role: 'guest' }],
  'house_rules/rule/versions': ['any', { rule_id: 'perm_none' }],
  'house_rules/rule/restore_version': ['any', { rule_id: 'perm_none', version: 'x' }],
  'house_rules/trash/list': ['any', {}],
  'house_rules/trash/restore': ['any', { rule_id: 'perm_none' }],
  'house_rules/trash/purge': ['admin', { rule_id: 'perm_none' }],
  'house_rules/rule/export': ['any', { rule_id: 'perm_none' }],
  'house_rules/rule/exported': ['admin', { rule_id: 'perm_none', automation_id: 'x' }],
  'house_rules/assistant/mark': ['admin', { feature: 'light', done: false }],
  'house_rules/assistant/suggest': ['admin', { feature: 'light' }],
  'house_rules/assistant/apply': ['admin', { feature: 'light', answers: {} }],
  'house_rules/light/learned': ['any', { room: 'none' }],
  'house_rules/light/forget': ['admin', { room: 'none' }],
  'house_rules/light/preview': ['any', { action: 'keep', session: 'none' }],
  'house_rules/places/get': ['any', {}],
  'house_rules/places/person': ['any', { person_id: 'none' }],
  'house_rules/places/predict': ['any', { person_id: 'none' }],
  'house_rules/places/name': ['admin', { place_id: 'none', name: 'x' }],
  'house_rules/places/delete': ['admin', { place_id: 'none' }],
  'house_rules/places/to_zone': ['ha_admin', { place_id: 'none' }],
  'house_rules/places/settings': ['admin', {}],
  'house_rules/places/relearn': ['admin', { days: 1 }],
  'house_rules/places/forget': ['admin', {}],
  'floorplan_card/info': ['any', {}],
  'floorplan_card/entry_alert/set': ['admin', { card_id: 'perm', config: {} }],
  'floorplan_card/entry_alert/remove': ['admin', { card_id: 'perm' }],
  'floorplan_card/entry_alert/ack': ['any', { card_id: 'perm' }],
  'floorplan_card/walks': ['any', { card_id: 'perm' }],
  'floorplan_card/walks/done': ['any', { card_id: 'perm', pet_id: 'dog', slot: '07:00' }],
  'floorplan_card/vacuums/info': ['any', { entity: 'vacuum.none' }],
  'floorplan_card/vacuums/clean': ['any', { entity: 'vacuum.none', segments: [1] }],
  'floorplan_card/plans/list': ['any', {}],
  'floorplan_card/plans/get': ['any', { plan_id: 'perm_none' }],
  'floorplan_card/plans/subscribe': ['any', { plan_id: 'perm_none' }],
  'floorplan_card/plans/save': ['admin', { name: 'perm', plan: {} }],
  'floorplan_card/plans/delete': ['admin', { plan_id: 'perm_none' }],
  'floorplan_card/images/get': ['any', { image_id: 'perm_none' }],
  'floorplan_card/images/save': ['admin', { data: 'data:image/png;base64,iVBORw0KGgo=' }],
  'floorplan_card/images/delete': ['admin', { image_id: 'perm_none' }],
  'floorplan_card/walks/undo': ['any', { card_id: 'perm', pet_id: 'dog', slot: '07:00' }],
  'floorplan_card/walks/subscribe': ['any', { card_id: 'perm' }],
  'floorplan_card/entry_alert/subscribe': ['any', { card_id: 'perm' }],
  'floorplan_card/pets/set': ['admin', { card_id: 'perm', pets: [] }],
  'floorplan_card/pets/subscribe': ['any', { card_id: 'perm' }],
  'floorplan_card/vacuums/set': ['admin', { card_id: 'perm', vacuums: [] }],
  'floorplan_card/vacuums/subscribe': ['any', { card_id: 'perm' }],
  'floorplan_card/vacuums/learned': ['any', { entity: 'vacuum.none' }],
  'floorplan_card/vacuums/path': ['any', { entity: 'vacuum.none' }],
  'floorplan_card/vacuums/map': ['any', { entity: 'vacuum.none' }],
  'floorplan_card/vacuums/reset': ['admin', { entity: 'vacuum.none' }],
  'floorplan_card/wifi/get': ['any', {}],
  'floorplan_card/wifi/set': ['admin', { networks: [] }],
};

// ---------------------------------------------------------------- every command in the sources is in the matrix and registered
const sources = ['custom_components/roomwise/card/websocket.py', 'custom_components/roomwise/house_rules/websocket.py'].map((f) => readFileSync(new URL(f, ROOT), 'utf8')).join('\n');
const commands = [...new Set([...sources.matchAll(/"type"\): "((?:house_rules|floorplan_card)\/[a-z_/]+)"/g)].map((m) => m[1]))];
ok(commands.length >= 70, `${commands.length} Befehle in den Quellen gefunden`);
const missing = commands.filter((c) => !MATRIX[c]);
ok(!missing.length, 'jeder Befehl steht in der Rechte-Tabelle (neue Befehle hier eintragen)', missing);
const stale = Object.keys(MATRIX).filter((c) => !commands.includes(c));
ok(!stale.length, 'die Tabelle enthält keine Befehle, die es nicht mehr gibt', stale);
const unregistered = [];
for (const c of commands) {
  // as admin with an invalid payload: a registered command answers invalid_format, an unknown one unknown_command
  const e = await ws.call({ type: c, perm_probe: { nested: true } }).then(() => '', (err) => err.message);
  if (/unknown_command/.test(e)) unregistered.push(c);
}
ok(!unregistered.length, 'alle Befehle sind in Home Assistant angemeldet', unregistered);

// ---------------------------------------------------------------- call each one as the tablet (non-admin)
const wrong = [];
for (const c of commands) {
  const [who, payload] = MATRIX[c] ?? ['admin', {}];
  const conn = c.endsWith('/subscribe') ? await wsConnect(tabletTok) : tablet; // a subscription ends with its connection
  const err = await conn.call({ type: c, ...payload }).then(() => '', (e) => e.message);
  if (conn !== tablet) conn.close();
  const refused = /^unauthorized/.test(err);
  if (who === 'admin' || who === 'ha_admin' || who === 'pin' ? !refused : refused || /unknown_error|invalid_format/.test(err)) wrong.push(`${c} (${who}): ${err || 'ok'}`);
}
ok(!wrong.length, 'als Nicht-Admin: Admin-Befehle abgelehnt, alle anderen antworten ohne Absturz', wrong);
ok((await ws.call({ type: 'house_rules/info' })).loaded && (await ws.call({ type: 'floorplan_card/info' })).loaded, 'beide Integrationen laufen danach weiter');

// ---------------------------------------------------------------- made "Admin" in Hausregeln: still never more than Home Assistant allows
// The tablet (no Home Assistant admin) gets the Hausregeln role Admin: every 'ha_admin' command and a Face ID device
// without the PIN stay refused. The table must name the same commands as permissions.py.
const permSrc = readFileSync(new URL('custom_components/roomwise/house_rules/permissions.py', ROOT), 'utf8');
const haOnly = [...permSrc.matchAll(/^\s+"([a-z_/]+)": "ha_admin",/gm)].map((m) => `house_rules/${m[1]}`);
const tableHa = Object.keys(MATRIX).filter((c) => MATRIX[c][0] === 'ha_admin');
ok(haOnly.length >= 14 && haOnly.every((c) => tableHa.includes(c)) && tableHa.every((c) => haOnly.includes(c)), `ha_admin-Befehle: Tabelle = permissions.py (${haOnly.length})`, { haOnly, tableHa });
const tabletId = (await ws.call({ type: 'house_rules/roles/get' })).users.find((u) => u.name === 'tablet')?.id;
await ws.call({ type: 'house_rules/roles/set', user_id: tabletId, role: 'admin' });
const promoted = await wsConnect(tabletTok);
const pme = await promoted.call({ type: 'house_rules/permissions' });
ok(pme.role === 'admin' && !pme.ha_admin && pme.can.settings && !pme.can.security && !pme.can.features, 'Tablet ist jetzt Admin in Hausregeln, aber kein HA-Admin (can.security/features aus)', pme);
const leaked = [];
for (const c of haOnly) {
  const e = await promoted.call({ type: c, ...MATRIX[c][1] }).then(() => '', (err) => err.message);
  if (!/^unauthorized/.test(e)) leaked.push(`${c}: ${e || 'ok'}`);
}
ok(!leaked.length, 'Hausregeln-Admin ohne HA-Admin: Alarm, Objekt-Alarme, KI, Diagnose, Funktionen, Rücksicherung, Rollen, HA-Änderungen abgelehnt', leaked);
let pe = await promoted.call({ type: 'house_rules/alarm/register_device', payload: {}, name: 'x', rp_id: 'localhost' }).then(() => '', (err) => err.message);
ok(/^unauthorized/.test(pe), '… Face-ID-Gerät ohne PIN abgelehnt', pe);
pe = await promoted.call({ type: 'house_rules/assistant/apply', feature: 'alarm', answers: {} }).then(() => '', (err) => err.message);
ok(/^unauthorized/.test(pe), '… Alarm-Assistent (schreibt die Alarm-Einstellungen) abgelehnt', pe);
pe = await promoted.call({ type: 'house_rules/settings/set', settings: {} }).then(() => '', (err) => err.message);
ok(!pe, '… normale Einstellungen gehen', pe);
pe = await promoted.call({ type: 'house_rules/settings/set', settings: { ollama: { url: 'http://example.invalid:11434', model: 'x' } } }).then(() => '', (err) => err.message);
ok(/^unauthorized/.test(pe), '… Adresse des Sprachmodells (ausgehende URL) über settings/set abgelehnt', pe);
promoted.close();
await ws.call({ type: 'house_rules/roles/set', user_id: tabletId, role: 'resident' });

// HA's own commands the card and panel rely on stay admin-only for the tablet
for (const type of ['config/auth/list', 'fire_event']) {
  const e = await tablet.call({ type, ...(type === 'fire_event' ? { event_type: 'mobile_app_notification_action', event_data: { action: 'HR_ALARM_DISARM_ALL' } } : {}) }).then(() => '', (err) => err.message);
  ok(/^unauthorized/.test(e), `${type} als Nicht-Admin abgelehnt (Home Assistant)`, e);
}

// ---------------------------------------------------------------- size limits for what any user can send
const tooBig = (m) => tablet.call(m).then(() => 'ok', (e) => e.message);
ok(/invalid_format/.test(await tooBig({ type: 'house_rules/rule/pause', rule_id: 'perm_none', minutes: 1e300 })), 'Pause: riesige Minutenzahl abgelehnt');
ok(/invalid_format/.test(await tooBig({ type: 'house_rules/rule/describe', rule: { when: [{ subject: 'x'.repeat(70000) }] } })), 'Regel über 64 kB abgelehnt');
ok(/invalid_format/.test(await tooBig({ type: 'house_rules/suggestion/dismiss', suggestion_id: 'x'.repeat(81) })), 'zu lange Vorschlags-ID abgelehnt');
ok(/invalid_format/.test(await tooBig({ type: 'floorplan_card/walks/done', card_id: 'x'.repeat(81), pet_id: 'dog', slot: '07:00' })), 'zu lange Karten-ID abgelehnt');
for (let i = 0; i < 30; i++) await tablet.call({ type: 'house_rules/alarm/challenge' });
ok(true, '30 Face-ID-Anfragen hintereinander: kein Fehler (nur die neuesten bleiben gültig)');

// ---------------------------------------------------------------- secrets never reach a non-admin (or any browser)
const SECRET_KEY = 'perm-test-not-a-real-key';
const SECRET_PW = 'smtp-perm-test-password';
await ws.call({ type: 'house_rules/ai/set', ai: { provider: 'openai', model: 'gpt-test', key: SECRET_KEY } });
await ws.call({ type: 'house_rules/alarm/config', config: { channels: { email: { host: 'mail.example.org', user: 'u', password: SECRET_PW, to: ['a@example.org'] }, signal: { numbers: [{ phone: '+491234', apikey: 'signal-perm-key' }] } } } });
const tSnap = JSON.stringify(await tablet.call({ type: 'house_rules/snapshot' }));
ok(!tSnap.includes(SECRET_KEY) && !tSnap.includes(SECRET_PW) && !tSnap.includes('signal-perm-key'), 'Snapshot (alle Nutzer): kein API-Schlüssel, kein Mail-Passwort, kein Signal-Schlüssel');
ok(/"has_key":true/.test(tSnap) && /"has_password":true/.test(tSnap), '… nur „gesetzt“');
ok(!/code_hash|pbkdf2\$/.test(tSnap), '… und kein PIN-Hash');
await ws.call({ type: 'house_rules/ai/set', ai: { provider: 'none' } });
await ws.call({ type: 'house_rules/alarm/config', config: { channels: { email: { host: '', user: '', password: '', to: [] }, signal: { numbers: [] } } } });

// ---------------------------------------------------------------- rules that may disarm / unlock: started by hand only by admins
const rule = (await ws.call({ type: 'house_rules/rule/save', rule: { name: 'Perm: Alarm aus', when: [{ subject: 'binary_sensor.haustuer', verb: 'opens' }], then: [{ subject: 'alarm', verb: 'disarm' }], options: { allow_sensitive: true } } })).rule;
let e = await tablet.call({ type: 'house_rules/rule/run', rule_id: rule.id }).then(() => '', (err) => err.message);
ok(/^unauthorized/.test(e), 'Regel mit „Alarm aus“: Nicht-Admin darf sie nicht von Hand starten (Websocket)', e);
const svc = await tabletApi('POST', '/api/services/roomwise/run', { rule_id: rule.id });
ok(svc.status === 401, '… und nicht über die Aktion roomwise.run', svc.status);
e = await ws.call({ type: 'house_rules/rule/run', rule_id: rule.id }).then(() => '', (err) => err.message);
ok(!e, 'Admin darf es', e);
await ws.call({ type: 'house_rules/rule/delete', rule_id: rule.id });
ok((await tabletApi('POST', '/api/services/roomwise/reset_alarm_pin', {})).status === 401, 'roomwise.reset_alarm_pin nur für Admins');

// ---------------------------------------------------------------- button events from a phone of a non-admin who gets no alarm messages
const feats = (await ws.call({ type: 'house_rules/snapshot' })).features;
await ws.call({ type: 'house_rules/features/set', features: { alarm: true } });
await ws.call({ type: 'house_rules/alarm/config', config: { enabled: true, code: null, confirm: 'none', modes: { away: { sensors: ['binary_sensor.praesenz_flur'], exit_delay: 0, entry_delay: 0, reaction: 'notify', auto: { arm_away: false } } } } });
await ws.call({ type: 'house_rules/alarm/arm', mode: 'away', force: true });
const alarmState = async () => (await api('GET', '/api/states/alarm_control_panel.alarmanlage')).body.state;
ok(await until(async () => (await alarmState()) === 'armed_away'), 'Alarmanlage scharf');
// the tablet user registers a phone in the companion app (any user can) and fires the "disarm" button event
const reg = await tabletApi('POST', '/api/mobile_app/registrations', {
  device_id: 'permtest-device', app_id: 'io.robbie.HomeAssistant', app_name: 'Home Assistant', app_version: '2026.1', device_name: 'permtest', manufacturer: 'Test', model: 'Test', os_name: 'iOS', os_version: '18', supports_encryption: false, app_data: {},
});
ok(reg.status === 201 && reg.body?.webhook_id, 'Nicht-Admin kann ein Handy anmelden (so ist Home Assistant)', reg);
const hook = (data) => fetch(`${URL0}/api/webhook/${reg.body.webhook_id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'fire_event', data }) });
for (const action of ['HR_ALARM_DISARM_ALL', 'HR_ALARM_STOP', 'HR_ALARM_SILENCE'])
  await hook({ event_type: 'mobile_app_notification_action', event_data: { action } });
await until(async () => (await ws.call({ type: 'house_rules/history', limit: 5 })).some((x) => /Knopf aus einer Nachricht abgelehnt/.test(x.what)), 4000);
ok((await alarmState()) === 'armed_away', '„Unscharf“-Knopf von einem fremden Handy: Alarmanlage bleibt scharf');
ok((await ws.call({ type: 'house_rules/history', limit: 5 })).some((x) => /Knopf aus einer Nachricht abgelehnt/.test(x.what)), 'Verlauf nennt die Ablehnung');
// the same button from an admin still works
await ws.call({ type: 'fire_event', event_type: 'mobile_app_notification_action', event_data: { action: 'HR_ALARM_DISARM_ALL' } });
ok(await until(async () => (await alarmState()) === 'disarmed'), 'derselbe Knopf von einem Admin schaltet aus');
// broken walk buttons from that phone: ignored, nothing crashes
for (const action of ['FP_WALK|a|b', 'FP_WALK|' + 'x'.repeat(200) + '|dog|07:00', 'FP_WALK|perm|dog|7am', 'FP_WALK|perm|dog|07:00'])
  await hook({ event_type: 'mobile_app_notification_action', event_data: { action } });
const walks = await ws.call({ type: 'floorplan_card/walks', card_id: 'perm' });
ok(JSON.stringify(walks.dog ?? []) === '["07:00"]', 'Gassi-Knopf: nur gültige Angaben zählen', walks);
await ws.call({ type: 'floorplan_card/walks/undo', card_id: 'perm', pet_id: 'dog', slot: '07:00' });
await ws.call({ type: 'house_rules/alarm/config', config: { enabled: false } });
await ws.call({ type: 'house_rules/features/set', features: { alarm: !!feats.alarm } });
// remove the test phone again
const entries = (await api('GET', '/api/config/config_entries/entry')).body;
for (const en of entries.filter((x) => x.domain === 'mobile_app' && x.title === 'permtest')) await api('DELETE', `/api/config/config_entries/entry/${en.entry_id}`);

// ---------------------------------------------------------------- unauthenticated HTTP: only the static files, no listing, no way out
const get = async (path) => {
  const r = await fetch(URL0 + path, { redirect: 'manual' });
  return { status: r.status, text: await r.text() };
};
const loader = await get('/floorplan_card_loader.js');
ok(loader.status === 200 && /^import\("\/floorplan_card_files\/floorplan-card\.js\?v=[0-9a-f.\-a-z]+"\);\s*$/.test(loader.text), 'Lader der Karte: nur ein import, keine Daten', loader.text.slice(0, 120));
for (const path of ['/floorplan_card_files/', '/house_rules_static/', '/house_rules_sounds/']) ok((await get(path)).status >= 400, `${path}: kein Verzeichnis-Listing`);
for (const path of ['/floorplan_card_files/../__init__.py', '/floorplan_card_files/%2e%2e/__init__.py', '/house_rules_sounds/..%2f..%2fmanifest.json', '/house_rules_static/%2e%2e/alarm.py', '/house_rules_sounds/%2e%2e/%2e%2e/.storage/house_rules']) {
  const r = await get(path);
  ok(r.status >= 400 && !/import |"domain"|code_hash/.test(r.text), `${path}: kein Zugriff außerhalb`, r.status);
}
ok((await get('/house_rules_sounds/gong.mp3')).status === 200, 'Töne sind ohne Anmeldung abrufbar (Lautsprecher brauchen das)');

tablet.close();
ws.close();
console.log(failures() ? `${failures()} FEHLER` : 'alles ok');
process.exit(failures() ? 1 : 0);
