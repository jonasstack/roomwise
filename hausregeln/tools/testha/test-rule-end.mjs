// The end of a light rule only touches the lamps of that rule: a rule that switches on the floor lamp of a room with
// three lamps ends with "Aus" → only the floor lamp goes off, the ceiling light and the sofa light someone switched on
// by hand stay as they are while the room is occupied; the same with "erst dimmen"; a rule for "Alle im Raum" ends for
// all of them. Against the isolated test Home Assistant (port 8124).
// Usage: node tools/testha/test-rule-end.mjs
import { token, wsConnect, rest, sleep, ok, failures, until } from './lib.mjs';

const tok = await token();
const ws = await wsConnect(tok);
const api = rest(tok);
const st = async (e) => (await api('GET', `/api/states/${e}`)).body;
const snap = () => ws.call({ type: 'house_rules/snapshot' });
const STEH = 'light.lampe_dim';
const DECKE = 'light.lampe_ct';
const SOFA = 'light.lampe_onoff';
const PRES = 'binary_sensor.bewegung_wohnzimmer';
const COND = 'input_boolean.licht_a';
const set = (entity_id, state, attributes = {}) => ws.call({ type: 'hr_fake/set', entity_id, state, attributes });

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
await until(async () => (await snap()).devices.some((d) => d.entity_id === STEH), 90000, 1000);
const areas = await ws.call({ type: 'config/area_registry/list' });
const area = (areas.find((a) => a.name === 'Leseecke') ?? (await ws.call({ type: 'config/area_registry/create', name: 'Leseecke' }))).area_id;
for (const e of [STEH, DECKE, SOFA, PRES]) await ws.call({ type: 'config/entity_registry/update', entity_id: e, area_id: area });
await ws.call({ type: 'house_rules/features/set', features: { light: true } });
await ws.call({ type: 'house_rules/mode/set', mode: 'home' });
const room = await until(async () => (await snap()).rooms.find((r) => r.name === 'Leseecke' && r.motion?.includes(PRES)), 20000, 500);
ok(!!room, 'Raum „Leseecke“ mit drei Lampen und Bewegungsmelder', (await snap()).rooms.find((r) => r.name === 'Leseecke'));
await until(async () => (await snap()).starting === false, 150000, 1000);
await ws.call({ type: 'house_rules/room/save', room: { id: room.id, presence: [], motion: [PRES], empty_after: 5, door_logic: false, door_pulse: [] } });
await set(PRES, 'on');

const base = { enabled: true, trigger: [], variants: [], empty_after: 'off', follow_empty: false, own_end: { delay: 0, dim: 0, dim_for: 0 } };
let emptyDelay = 5;
const plan = async (rules) => {
  const cur = (await snap()).plans.light[room.id];
  return ws.call({ type: 'house_rules/plan/set', kind: 'light', room: room.id, plan: { ...cur, on: true, manual: 'none', empty: { mode: 'off', delay: emptyDelay, dim: 10, dim_for: 0 }, smart: { ...(cur.smart ?? {}), mode: 'off' }, rules } });
};
const svc = (s, e, data = {}) => api('POST', `/api/services/light/${s}`, { entity_id: e, ...data });
const isOn = async (e) => (await st(e)).state === 'on';

async function scenario(name, rule, expectOff) {
  await api('POST', '/api/services/input_boolean/turn_off', { entity_id: COND });
  await plan([]);
  for (const e of [STEH, DECKE, SOFA]) await svc('turn_off', e);
  await sleep(800);
  await plan([{ ...base, id: 'lp_end', name: 'Leselicht', kind: 'while', when: [{ subject: COND, verb: 'is_on' }], action: { mode: 'on', brightness: 70 }, ...rule }]);
  // someone switches the ceiling light and the sofa light on by hand
  await svc('turn_on', DECKE, { brightness: 200 });
  await svc('turn_on', SOFA);
  await sleep(500);
  await api('POST', '/api/services/input_boolean/turn_on', { entity_id: COND });
  ok(await until(() => isOn(STEH), 6000), `${name}: die Regel schaltet die Stehlampe ein`);
  await sleep(1500);
  await api('POST', '/api/services/input_boolean/turn_off', { entity_id: COND });
  await sleep(3500);
  const now = { steh: await isOn(STEH), decke: await isOn(DECKE), sofa: await isOn(SOFA), stehB: (await st(STEH)).attributes.brightness };
  for (const [k, e] of [['steh', STEH], ['decke', DECKE], ['sofa', SOFA]]) {
    const want = !expectOff.includes(e);
    ok(now[k] === want, `${name}: ${k} ${want ? 'bleibt an' : 'geht aus'}`, now, (await snap()).plans.now?.[room.id]?.light);
  }
  return now;
}

await scenario('Aus, nur die Stehlampe', { lights: [STEH], after: 'off' }, [STEH]);
await scenario('Aus mit Nachlauf (eigene Zeit 0)', { lights: [STEH], after: 'off', own_end: { delay: 0, dim: 0, dim_for: 0 } }, [STEH]);
await scenario('Raum-Einstellung folgen, Raum belegt', { lights: [STEH], after: 'off', follow_empty: true }, []);
emptyDelay = 0.02;
await scenario('Raum-Einstellung folgen (1 s), Raum belegt', { lights: [STEH], after: 'off', follow_empty: true }, [STEH]);
emptyDelay = 5;
await scenario('Wie die anderen Regeln', { lights: [STEH], after: 'others' }, []);
// a lamp of another room in the rule ("Lichter aus anderen Räumen"): only it and the floor lamp go off
const OTHER = 'light.lampe_rgb';
await svc('turn_off', OTHER);
await scenario('Aus, mit Lampe aus anderem Raum', { lights: [STEH, OTHER], after: 'off' }, [STEH]);
ok(!(await isOn(OTHER)), 'Lampe aus anderem Raum: geht mit aus');
await scenario('Aus, alle im Raum', { lights: [], after: 'off' }, [STEH, DECKE, SOFA]);

// erst dimmen: only the floor lamp dims, the others keep their brightness
await api('POST', '/api/services/input_boolean/turn_off', { entity_id: COND });
await plan([]);
for (const e of [STEH, DECKE, SOFA]) await svc('turn_off', e);
await sleep(800);
await plan([{ ...base, id: 'lp_end', name: 'Leselicht', kind: 'while', lights: [STEH], after: 'off', when: [{ subject: COND, verb: 'is_on' }], action: { mode: 'on', brightness: 70 }, own_end: { delay: 0, dim: 20, dim_for: 0.1 } }]);
await svc('turn_on', DECKE, { brightness: 200 });
await svc('turn_on', SOFA);
await api('POST', '/api/services/input_boolean/turn_on', { entity_id: COND });
await until(() => isOn(STEH), 6000);
await sleep(1500);
await api('POST', '/api/services/input_boolean/turn_off', { entity_id: COND });
await sleep(2500);
const d1 = { steh: (await st(STEH)).attributes.brightness, decke: (await st(DECKE)).attributes.brightness, sofa: await isOn(SOFA) };
ok(d1.steh > 0 && d1.steh < 100, 'Erst dimmen: die Stehlampe dimmt herunter', d1);
ok(d1.decke === 200 && d1.sofa, 'Erst dimmen: Decke und Sofa bleiben wie sie sind', d1);
ok(await until(async () => !(await isOn(STEH)), 15000), 'Erst dimmen: danach geht die Stehlampe aus');
ok((await isOn(DECKE)) && (await isOn(SOFA)), 'Erst dimmen: Decke und Sofa bleiben an');

// back to neutral
await api('POST', '/api/services/input_boolean/turn_off', { entity_id: COND });
await plan([]);
const cur = (await snap()).plans.light[room.id];
await ws.call({ type: 'house_rules/plan/set', kind: 'light', room: room.id, plan: { ...cur, on: false, rules: [] } });
await set(PRES, 'off');
ws.close();
console.log(failures() ? `\n${failures()} Fehler` : '\nalles ok');
process.exit(failures() ? 1 : 0);
