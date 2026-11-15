// Reinschau-Licht against the isolated test Home Assistant (port 8124): the room "Diele" glows while someone is in
// the "Flur" next door and the door between is open; entering the Diele ends the glow (its own rules apply), a closed
// door or the setting switched off keeps it dark. Rules made by hand for the same are replaced when asked to.
// Usage: node tools/testha/test-glow.mjs
import { token, wsConnect, rest, sleep, ok, failures, until } from './lib.mjs';

const tok = await token();
const ws = await wsConnect(tok);
const api = rest(tok);
const st = async (e) => (await api('GET', `/api/states/${e}`)).body;
const set = (entity_id, state, attributes = {}) => ws.call({ type: 'hr_fake/set', entity_id, state, attributes });
const snap = () => ws.call({ type: 'house_rules/snapshot' });
const LAMP = 'light.nachtlicht_diele';
const PRES = 'binary_sensor.praesenz_diele';
const DOOR = 'binary_sensor.zimmertuer_diele_a';
const FLUR = 'binary_sensor.praesenz_flur';

let info = await ws.call({ type: 'house_rules/info' }).catch(() => null);
if (!info?.loaded) {
  const flow = await api('POST', '/api/config/config_entries/flow', { handler: 'roomwise' });
  await api('POST', `/api/config/config_entries/flow/${flow.body.flow_id}`, {});
  info = await until(async () => {
    const i = await ws.call({ type: 'house_rules/info' }).catch(() => null);
    return i?.loaded && i;
  }, 60000, 1000);
}
ok(info?.loaded, `integration läuft (${info?.version})`);
await until(async () => (await snap()).devices.some((d) => d.entity_id === LAMP), 90000, 1000);
const areas = await ws.call({ type: 'config/area_registry/list' });
const areaOf = async (name) => (areas.find((a) => a.name === name) ?? (await ws.call({ type: 'config/area_registry/create', name }))).area_id;
const diele = await areaOf('Diele');
const flur = await areaOf('Flur');
for (const e of [LAMP, PRES, DOOR]) await ws.call({ type: 'config/entity_registry/update', entity_id: e, area_id: diele });
await ws.call({ type: 'config/entity_registry/update', entity_id: FLUR, area_id: flur });
await ws.call({ type: 'house_rules/features/set', features: { light: true } });
await ws.call({ type: 'house_rules/mode/set', mode: 'home' });
const room = await until(async () => (await snap()).rooms.find((r) => r.name === 'Diele'), 20000, 500);
const src = await until(async () => (await snap()).rooms.find((r) => r.name === 'Flur' && r.presence?.includes(FLUR)), 20000, 500);
ok(!!room && !!src, 'Räume Diele und Flur', { room, src });
await until(async () => (await snap()).starting === false, 150000, 1000);
await ws.call({ type: 'house_rules/room/save', room: { id: room.id, presence: [PRES], empty_after: 0.05, door_logic: false, door_pulse: [] } });
await ws.call({ type: 'house_rules/room/save', room: { id: src.id, presence: [FLUR], empty_after: 0.05 } });
await set(PRES, 'off');
await set(FLUR, 'off');
await set(DOOR, 'on');
await api('POST', '/api/services/light/turn_off', { entity_id: LAMP });

const cur = (await snap()).plans.light[room.id];
const handmade = { id: 'dglow', name: 'Diele glimmt (von Hand)', kind: 'while', when: [{ subject: `room:${src.id}`, verb: 'is_occupied' }], lights: [LAMP], action: { mode: 'on', brightness: 9 } };
const glow = { on: true, sources: [{ room: src.id, by: 'occupied', door: DOOR, door_state: 'open' }], lights: [LAMP], brightness: 4, color: 'k:2200', dark: 'always', not_sleep: true };
await ws.call({ type: 'house_rules/plan/set', kind: 'light', room: room.id, plan: { ...cur, on: true, manual: 'none', empty: { mode: 'off', delay: 0, dim: 10, dim_for: 0 }, smart: { ...(cur.smart ?? {}), mode: 'off' }, rules: [handmade], glow, glow_replace: ['dglow'] } });
let p = (await snap()).plans.light[room.id];
ok(p.rules.map((r) => r.id).sort().join() === 'glowauto,glowautok', 'zwei Regeln aus der Einstellung, die von Hand angelegte ersetzt', p.rules.map((r) => r.id));
ok(p.glow.on && p.glow.sources[0].door === DOOR, 'Einstellung gespeichert', p.glow);

await set(FLUR, 'on');
ok(await until(async () => (await st(LAMP)).state === 'on', 8000), 'jemand im Flur, Tür offen, Diele leer → Diele glimmt');
ok(Math.abs(((await st(LAMP)).attributes.brightness ?? 0) - Math.round(0.04 * 255)) <= 3, 'mit 4 %', (await st(LAMP)).attributes);
await set(DOOR, 'off');
ok(await until(async () => (await st(LAMP)).state === 'off', 8000), 'Tür zu → Glimmen aus');
await set(DOOR, 'on');
ok(await until(async () => (await st(LAMP)).state === 'on', 8000), 'Tür wieder auf → glimmt wieder');
await set(PRES, 'on');
await sleep(2500);
ok(!(p = (await snap()).plans.now?.[room.id]?.light)?.active?.some((n) => /Reinschau/.test(n)), 'Diele betreten → Reinschau-Licht gilt nicht mehr', p);
await set(PRES, 'off');
await set(FLUR, 'off');
ok(await until(async () => (await st(LAMP)).state === 'off', 10000), 'alle weg → aus');

// switched off: the rules go, nothing glows
await ws.call({ type: 'house_rules/plan/set', kind: 'light', room: room.id, plan: { ...(await snap()).plans.light[room.id], glow: { ...glow, on: false } } });
ok(!(await snap()).plans.light[room.id].rules.length, 'ausgeschaltet → Regeln weg');
await set(FLUR, 'on');
await sleep(3000);
ok((await st(LAMP)).state === 'off', 'ausgeschaltet → kein Glimmen');
await set(FLUR, 'off');

// back to neutral
await ws.call({ type: 'house_rules/plan/set', kind: 'light', room: room.id, plan: { ...(await snap()).plans.light[room.id], on: false, rules: [] } });
ws.close();
console.log(failures() ? `\n${failures()} Fehler` : '\nalles ok');
process.exit(failures() ? 1 : 0);
