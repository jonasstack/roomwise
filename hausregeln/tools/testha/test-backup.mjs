// Backup / restore and the hints in the Repairs panel, against the isolated test Home Assistant (port 8124).
// Usage: node tools/testha/test-backup.mjs   (start the test HA first: tools/testha/start.sh)
import { token, wsConnect, rest, sleep, ok, failures, until, userToken } from './lib.mjs';

const tok = await token();
const ws = await wsConnect(tok);
const api = rest(tok);

// ---------------------------------------------------------------- setup (idempotent)
const areas = await ws.call({ type: 'config/area_registry/list' });
const area = async (name) => (areas.find((a) => a.name === name) ?? (await ws.call({ type: 'config/area_registry/create', name }))).area_id;
const A = { flur: await area('Flur'), bad: await area('Bad'), wohnzimmer: await area('Wohnzimmer') };
for (const [r, ents] of Object.entries({ flur: ['light.flurlicht', 'binary_sensor.haustuer', 'binary_sensor.praesenz_flur'], bad: ['climate.heizung_bad', 'binary_sensor.fenster_bad', 'light.badlicht'], wohnzimmer: ['light.sofalicht'] }))
  for (const e of ents) await ws.call({ type: 'config/entity_registry/update', entity_id: e, area_id: A[r] }).catch((err) => console.log('area', e, err.message));
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
await until(async () => (await ws.call({ type: 'house_rules/snapshot' })).devices.length > 10, 90000, 1000);
await until(async () => !(await ws.call({ type: 'house_rules/snapshot' })).alarm.settling, 120000, 1000);
const snapshot = () => ws.call({ type: 'house_rules/snapshot' });
// the inventory is rebuilt a few seconds after area changes
ok(await until(async () => (await snapshot()).rooms.filter((r) => Object.values(A).includes(r.id)).length === 3, 30000, 500), 'Räume bekannt');
const save = async (rule) => (await ws.call({ type: 'house_rules/rule/save', rule })).rule;
const clearRules = async () => {
  for (const r of (await snapshot()).rules) await ws.call({ type: 'house_rules/rule/delete', rule_id: r.id });
};
const err = (p) => p.then(() => '').catch((e) => e.message);
await clearRules();
await ws.call({ type: 'house_rules/alarm/disarm' }).catch(() => null);
await ws.call({ type: 'house_rules/alarm/config', config: { enabled: false, code: null, confirm: 'none' } });

// ---------------------------------------------------------------- 1. export
console.log('\n# Sichern');
const rA = await save({ id: 'bk_flur', name: 'Flurlicht an der Tür', type: 'when', when: [{ subject: 'binary_sensor.haustuer', verb: 'opens' }], then: [{ subject: 'light.flurlicht', verb: 'turn_on' }] });
const rB = await save({ id: 'bk_bad', name: 'Badlicht aus', type: 'when', when: [{ subject: 'binary_sensor.fenster_bad', verb: 'opens' }], then: [{ subject: 'light.badlicht', verb: 'turn_off' }] });
await ws.call({ type: 'house_rules/group/save', group: { id: 'g_backup', name: 'Lichter', members: ['light.flurlicht', 'light.badlicht'] } });
await ws.call({ type: 'house_rules/features/set', features: { heating: true, light: true } });
await ws.call({ type: 'house_rules/settings/set', settings: { eco_temp: 16.5 } });
await ws.call({ type: 'house_rules/plan/set', kind: 'heat', room: A.bad, plan: { on: true, temps: { comfort: 22.5 } } });
await ws.call({
  type: 'house_rules/alarm/config',
  config: { enabled: true, code: '4711', confirm: 'pin', modes: { away: { sensors: ['binary_sensor.haustuer'] } }, channels: { email: { on: true, host: 'smtp.example.org', password: 'geheim-123', to: ['alarm@example.org'] } } },
});
const backup = await ws.call({ type: 'house_rules/backup/export' });
const text = JSON.stringify(backup);
ok(backup.format === 'house_rules_backup' && backup.version === 1 && backup.created, 'Format, Version, Zeitpunkt', { f: backup.format, v: backup.version });
ok(backup.data.rules.some((r) => r.id === 'bk_flur') && backup.data.groups.some((g) => g.id === 'g_backup'), 'Regeln und Gruppen drin');
ok(backup.data.heating.rooms[A.bad]?.temps?.comfort === 22.5 && backup.data.settings.eco_temp === 16.5, 'Heizplan und Einstellungen drin');
ok(backup.data.alarm.modes.away.sensors.includes('binary_sensor.haustuer') && backup.data.alarm.enabled === true, 'Alarmanlage drin');
ok(!('code_hash' in backup.data.alarm) && !('devices' in backup.data.alarm) && !text.includes('geheim-123') && !text.includes('pbkdf2'), 'ohne PIN-Hash, Passkeys, Passwörter');
ok(!('ai' in backup.data) && !('runtime' in backup.data) && !('history' in backup.data), 'ohne KI-Schlüssel, Laufzeit, Verlauf');
const tablet = await userToken(tok);
const wsUser = await wsConnect(tablet);
ok(/unauthorized/i.test(await err(wsUser.call({ type: 'house_rules/backup/export' }))), 'Nicht-Admin darf nicht sichern');
ok(/unauthorized/i.test(await err(wsUser.call({ type: 'house_rules/backup/restore', backup, mode: 'merge' }))), 'Nicht-Admin darf nicht wiederherstellen');
wsUser.close();

// ---------------------------------------------------------------- 2. checks
console.log('\n# Prüfen');
const preview = (b, remap = {}) => ws.call({ type: 'house_rules/backup/preview', backup: b, remap });
ok(/keine Sicherung/.test(await err(preview({ format: 'etwas', version: 1, data: {} }))), 'fremde Datei abgelehnt');
ok(/neueren Version/.test(await err(preview({ ...backup, version: 99 }))), 'neuere Version abgelehnt');
ok(/beschädigt.*Regeln/.test(await err(preview({ ...backup, data: { ...backup.data, rules: 'kaputt' } }))), 'kaputter Teil wird benannt');
ok(/zu groß/.test(await err(preview({ ...backup, data: { ...backup.data, dismissed: ['x'.repeat(2_100_000)] } }))), 'zu große Datei abgelehnt');
ok(/ungewöhnlich groß/.test(await err(preview({ ...backup, data: { ...backup.data, rules: Array(501).fill(backup.data.rules[0]) } }))), 'zu viele Regeln abgelehnt');

// a backup from another home: a light that does not exist here
const foreign = JSON.parse(text);
foreign.data.rules.push({ id: 'bk_fremd', name: 'Fremdes Licht', type: 'when', when: [{ subject: 'binary_sensor.haustuer', verb: 'opens' }], then: [{ subject: 'light.gibt_es_hier_nicht', verb: 'turn_on' }], enabled: true, options: {} });
let p = await preview(foreign);
const miss = p.missing.find((m) => m.entity_id === 'light.gibt_es_hier_nicht');
ok(miss && miss.used_in.some((u) => /Fremdes Licht/.test(u)), 'fehlendes Gerät mit Ort erkannt', p.missing);
ok(miss?.candidates.length && miss.candidates.every((c) => c.entity_id.startsWith('light.')), 'Ersatz-Vorschläge derselben Art', miss?.candidates);
const rules = p.sections.find((s) => s.key === 'rules');
ok(rules?.incoming === 3 && rules.same === 2 && rules.new === 1, 'Vorschau: neu / gleich gezählt', rules);
ok(p.notes.length === 0, 'PIN ist da: kein Hinweis');

// ---------------------------------------------------------------- 3. restore
console.log('\n# Wiederherstellen');
await ws.call({ type: 'house_rules/alarm/arm', mode: 'away', force: true });
await sleep(500);
p = await preview(foreign);
ok(p.alarm_armed === true, 'Vorschau weiß: Alarm scharf');
ok(/scharf/.test(await err(ws.call({ type: 'house_rules/backup/restore', backup: foreign, mode: 'merge' }))), 'scharf → Alarm-Teil wird nicht überschrieben');
const onlyRules = await ws.call({ type: 'house_rules/backup/restore', backup: foreign, mode: 'merge', sections: ['rules'] });
ok(onlyRules.ok && onlyRules.sections.join() === 'rules', 'ohne Alarm-Teil geht es auch, wenn scharf');
await ws.call({ type: 'house_rules/alarm/disarm', code: '4711' });
await sleep(300);

await ws.call({ type: 'house_rules/rule/delete', rule_id: rA.id });
const rC = await save({ id: 'bk_neu', name: 'Nur hier', type: 'when', when: [{ subject: 'binary_sensor.haustuer', verb: 'closes' }], then: [{ subject: 'light.sofalicht', verb: 'turn_off' }] });
await ws.call({ type: 'house_rules/settings/set', settings: { eco_temp: 19 } });
await ws.call({ type: 'house_rules/plan/set', kind: 'heat', room: A.bad, plan: { on: false, temps: { comfort: 19 } } });
let res = await ws.call({ type: 'house_rules/backup/restore', backup: foreign, mode: 'merge', remap: { 'light.gibt_es_hier_nicht': 'light.sofalicht', 'light.erfunden': 'light.auch_erfunden' } });
let s = await snapshot();
const ids = s.rules.map((r) => r.id);
ok(res.ok && ids.includes(rA.id) && ids.includes(rB.id) && ids.includes(rC.id) && ids.includes('bk_fremd'), 'Zusammenführen: gelöschte zurück, eigene bleibt', ids);
ok(s.rules.find((r) => r.id === 'bk_fremd')?.then[0].subject === 'light.sofalicht', 'Ersatz eingesetzt (remap)');
ok(s.settings.eco_temp === 16.5 && s.plans.heat[A.bad]?.on === true && s.plans.heat[A.bad]?.temps.comfort === 22.5, 'Einstellungen und Heizplan zurück', s.plans.heat[A.bad]);
ok(s.groups.some((g) => g.id === 'g_backup'), 'Gruppe da');
ok(s.alarm.config.has_code === true && s.alarm.config.confirm === 'pin' && s.alarm.config.channels.email.has_password === true, 'PIN und Passwort von hier bleiben', { has: s.alarm.config.has_code, c: s.alarm.config.confirm, pw: s.alarm.config.channels.email.has_password });
ok(s.history.some((h) => /Sicherung wiederhergestellt/.test(h.what)), 'steht im Verlauf');

res = await ws.call({ type: 'house_rules/backup/restore', backup, mode: 'replace' });
s = await snapshot();
ok(res.ok && s.rules.map((r) => r.id).sort().join() === [rA.id, rB.id].sort().join(), 'Ersetzen: genau die Regeln der Sicherung', s.rules.map((r) => r.id));
// without a PIN here, "PIN" in the backup becomes "no confirmation" with a note
await ws.call({ type: 'house_rules/alarm/config', config: { code: null, confirm: 'none' } });
p = await preview(backup);
ok(p.notes.some((n) => /PIN/.test(n)), 'Vorschau: PIN neu festlegen');
res = await ws.call({ type: 'house_rules/backup/restore', backup, mode: 'merge', sections: ['alarm'] });
s = await snapshot();
ok(res.notes.some((n) => /PIN/.test(n)) && s.alarm.config.confirm === 'none' && s.alarm.config.enabled === true, 'ohne PIN: keine Bestätigung + Hinweis', { notes: res.notes, c: s.alarm.config.confirm });

// ---------------------------------------------------------------- 4. repairs
console.log('\n# Reparaturen');
const issues = async () => (await ws.call({ type: 'repairs/list_issues' })).issues.filter((i) => i.domain === 'roomwise' && !['frontend_missing', 'old_integrations'].includes(i.issue_id));
const check = () => ws.call({ type: 'house_rules/issues/check' });
await ws.call({ type: 'house_rules/alarm/config', config: { enabled: false } });
await check();
await save({ id: 'bk_kaputt', name: 'Mit verschwundenem Licht', type: 'when', when: [{ subject: 'binary_sensor.haustuer', verb: 'opens' }], then: [{ subject: 'light.verschwunden', verb: 'turn_on' }] });
await check();
let list = await issues();
let it = list.find((i) => i.issue_id === 'missing_light.verschwunden');
ok(it && it.translation_key === 'entity_missing' && it.is_fixable && /Mit verschwundenem Licht/.test(it.translation_placeholders.used_in), 'fehlendes Gerät in einer Regel → Hinweis (behebbar)', list);
// fix it in the Repairs panel: replace with another light
const fix = await api('POST', '/api/repairs/issues/fix', { handler: 'roomwise', issue_id: 'missing_light.verschwunden' });
ok(fix.body?.type === 'form' && fix.body.step_id === 'init', 'Reparatur-Dialog öffnet', fix.body);
const bad = await api('POST', `/api/repairs/issues/fix/${fix.body.flow_id}`, { replacement: 'light.verschwunden' });
ok(bad.body?.errors?.replacement === 'invalid_entity', 'dasselbe / fehlende Gerät wird abgelehnt', bad.body);
const done = await api('POST', `/api/repairs/issues/fix/${fix.body.flow_id}`, { replacement: 'light.flurlicht' });
ok(done.body?.type === 'create_entry', 'Ersetzen bestätigt', done.body);
s = await snapshot();
ok(s.rules.find((r) => r.id === 'bk_kaputt')?.then[0].subject === 'light.flurlicht', 'Regel nutzt jetzt das neue Gerät');
await check();
ok(!(await issues()).some((i) => i.issue_id === 'missing_light.verschwunden'), 'Hinweis verschwindet von selbst');
// a disabled rule does not count
await save({ id: 'bk_aus', name: 'Ausgeschaltet', type: 'when', enabled: false, when: [{ subject: 'binary_sensor.haustuer', verb: 'opens' }], then: [{ subject: 'light.auch_weg', verb: 'turn_on' }] });
await check();
ok(!(await issues()).some((i) => i.issue_id === 'missing_light.auch_weg'), 'ausgeschaltete Regel: kein Hinweis');

// heating plan in a room without a thermostat (the hallway: other tests put a thermostat into the living room)
await ws.call({ type: 'house_rules/plan/set', kind: 'heat', room: A.flur, plan: { on: true } });
await check();
it = (await issues()).find((i) => i.issue_id === `heating_no_thermostat_${A.flur}`);
ok(it?.translation_key === 'heating_no_thermostat' && it.translation_placeholders.room === 'Flur', 'Heizplan ohne Thermostat → Hinweis', it);
await ws.call({ type: 'house_rules/plan/set', kind: 'heat', room: A.flur, plan: { on: false } });
await check();
ok(!(await issues()).some((i) => i.issue_id.startsWith('heating_no_thermostat_')), 'Heizplan aus → Hinweis weg');

// the alarm: nobody to notify / a notify service that is gone
await ws.call({ type: 'hr_fake/notify', name: 'alarm_test_dienst', present: true });
await ws.call({ type: 'house_rules/alarm/config', config: { enabled: true, notify: { persons: [] }, channels: { email: { on: false }, services: { on: false, list: [] } } } });
await check();
ok((await issues()).some((i) => i.issue_id === 'alarm_no_target' && i.severity === 'error'), 'Alarm ohne Empfänger → Hinweis (Fehler)');
await ws.call({ type: 'house_rules/alarm/config', config: { channels: { services: { on: true, list: ['alarm_test_dienst'] } } } });
await check();
list = await issues();
ok(!list.some((i) => i.issue_id === 'alarm_no_target'), 'mit Dienst: Empfänger da');
await ws.call({ type: 'hr_fake/notify', name: 'alarm_test_dienst', present: false });
await check();
list = await issues();
it = list.find((i) => i.issue_id === 'alarm_notify_missing');
ok(it && /notify\.alarm_test_dienst/.test(it.translation_placeholders.services) && list.some((i) => i.issue_id === 'alarm_no_target'), 'Dienst verschwunden → Hinweis', list.map((i) => i.issue_id));
await ws.call({ type: 'house_rules/alarm/config', config: { enabled: false } });
await check();
ok(!(await issues()).some((i) => i.issue_id.startsWith('alarm_')), 'Alarm aus → Hinweise weg');

// a dashboard with the floor plan card, but nothing loads it
const boards = await ws.call({ type: 'lovelace/dashboards/list' });
if (!boards.some((b) => b.url_path === 'hr-plan-test')) await ws.call({ type: 'lovelace/dashboards/create', url_path: 'hr-plan-test', title: 'Plan', mode: 'storage', require_admin: true, show_in_sidebar: false });
await ws.call({ type: 'lovelace/config/save', url_path: 'hr-plan-test', config: { views: [{ cards: [{ type: 'custom:floorplan-card', floors: [] }] }] } });
const card = async () => (await check()).some((i) => i.id === 'card_not_loaded');
// the card's companion integration loads the card itself; once another test set it up in this test HA it stays
// loaded until a restart, so only that side can be checked then
const companion = (await api('GET', '/api/config')).body?.components?.includes('roomwise');
if (companion) {
  await sleep(1500);
  ok(!(await card()), 'Begleit-Integration lädt die Karte: kein Hinweis (ohne Begleit-Integration nicht prüfbar, bis zum Neustart des Test-HA)');
} else {
  ok(await until(card, 8000, 500), 'Karte im Dashboard, nichts lädt sie → Hinweis');
  it = (await issues()).find((i) => i.issue_id === 'card_not_loaded');
  ok(it?.translation_key === 'card_not_loaded' && !it.is_fixable, 'Hinweis „Karte wird nicht geladen“', it);
}
await ws.call({ type: 'lovelace/resources/create', res_type: 'module', url: '/hacsfiles/roomwise/floorplan-card.js' });
ok(!(await card()), 'mit Ressource: kein Hinweis');

// clean up
for (const r of (await ws.call({ type: 'lovelace/resources' })).filter((x) => /floorplan-card/.test(x.url))) await ws.call({ type: 'lovelace/resources/delete', resource_id: r.id });
await ws.call({ type: 'lovelace/dashboards/delete', dashboard_id: (await ws.call({ type: 'lovelace/dashboards/list' })).find((b) => b.url_path === 'hr-plan-test').id });
await clearRules();
await check();
console.log(failures() ? `\n${failures()} FEHLER` : '\nalles ok');
ws.close();
process.exit(failures() ? 1 : 0);
