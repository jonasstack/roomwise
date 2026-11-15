// Light rules and the advanced logic against the isolated test Home Assistant (port 8124), with lamps of every
// kind from hr_fake (rgb, rgbw, rgbww, hs + white tones + effects, xy, white tones only, dimmable only, on/off only,
// white channel) and lamps that report late (like Zigbee). Also "Live an der Lampe": what the panel sends in live
// mode looks the same as what the rule sends when it runs, and Home Assistant refuses a user without control rights.
// Usage: node tools/testha/test-lights.mjs [--only name]
import { token, wsConnect, rest, sleep, ok, failures, until, userToken } from './lib.mjs';

const tok = await token();
const ws = await wsConnect(tok);
const api = rest(tok);
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const st = async (e) => (await api('GET', `/api/states/${e}`)).body;
const svc = (domain, service, data) => api('POST', `/api/services/${domain}/${service}`, data);
const set = (entity_id, state, attributes = {}) => ws.call({ type: 'hr_fake/set', entity_id, state, attributes });
const LAMPS = ['rgb', 'rgbw', 'rgbww', 'hs', 'xy', 'ct', 'dim', 'onoff', 'white'].map((x) => `light.lampe_${x}`);
const snap = () => ws.call({ type: 'house_rules/snapshot' });

// ---------------------------------------------------------------- setup (idempotent)
let info = await ws.call({ type: 'house_rules/info' }).catch(() => null);
if (!info?.loaded) {
  const flow = await api('POST', '/api/config/config_entries/flow', { handler: 'house_rules' });
  await api('POST', `/api/config/config_entries/flow/${flow.body.flow_id}`, {});
  info = await until(async () => {
    const i = await ws.call({ type: 'house_rules/info' }).catch(() => null);
    return i?.loaded && i;
  }, 60000, 1000);
}
ok(info?.loaded, `integration läuft (${info?.version})`);
await until(async () => (await snap()).devices.some((d) => d.entity_id === 'light.lampe_rgb'), 90000, 1000);
const areas = await ws.call({ type: 'config/area_registry/list' });
const lab = (areas.find((a) => a.name === 'Lichtlabor') ?? (await ws.call({ type: 'config/area_registry/create', name: 'Lichtlabor' }))).area_id;
for (const e of LAMPS) await ws.call({ type: 'config/entity_registry/update', entity_id: e, area_id: lab });
await ws.call({ type: 'house_rules/features/set', features: { light: true } });
const room = await until(async () => (await snap()).rooms.find((r) => r.name === 'Lichtlabor' && (r.lights ?? []).length !== 0) || (await snap()).rooms.find((r) => r.name === 'Lichtlabor'), 20000, 500);
ok(!!room, 'Raum „Lichtlabor“ da');
await until(async () => (await snap()).devices.filter((d) => LAMPS.includes(d.entity_id) && d.room === room.id).length === LAMPS.length, 20000, 500);
for (const r of (await snap()).rules) if (r.id.startsWith('r_lt')) await ws.call({ type: 'house_rules/rule/delete', rule_id: r.id });
await ws.call({ type: 'house_rules/mode/set', mode: 'home' });
// other tests may leave the alarm on (a triggered alarm switches the lights itself: the plan keeps its hands off)
// (only then, without wrong PINs, and the way it is confirmed is put back at the end)
const alarm0 = (await snap()).alarm;
const alarmConfirm = alarm0 && alarm0.state !== 'disarmed' ? (alarm0.config?.confirm ?? 'none') : null;
if (alarmConfirm) {
  await ws.call({ type: 'house_rules/alarm/config', config: { confirm: 'none' } }).catch(() => null);
  await ws.call({ type: 'house_rules/alarm/disarm' }).catch(() => null);
}
const s0 = await snap();
console.log(`  (Alarm: ${s0.alarm?.state ?? '–'}, Hausmodus: ${s0.mode}, Funktion Licht: ${s0.features?.light})`);

const plan = async (rules, extra = {}) => {
  const cur = (await snap()).plans.light[room.id];
  return ws.call({ type: 'house_rules/plan/set', kind: 'light', room: room.id, plan: { ...cur, on: true, manual: 'none', empty: { mode: 'keep', delay: 0.05, dim: 10, dim_for: 0 }, smart: { ...(cur.smart ?? {}), mode: 'off' }, rules, ...extra } });
};
const base = { enabled: true, trigger: [], when: [], lights: [], variants: [], after: 'others', empty_after: 'off', follow_empty: false, own_end: { delay: 0, dim: 0, dim_for: 0 } };
const allOff = async () => {
  await plan([], { on: false });
  for (const e of LAMPS) await svc('light', 'turn_off', { entity_id: e });
  for (const b of ['licht_a', 'licht_b']) await svc('input_boolean', 'turn_off', { entity_id: `input_boolean.${b}` });
  for (const e of LAMPS) await set(e, 'off', { latency: 0, call_latency: 0 });
};
const close = (a, b, d = 3) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => Math.abs(Number(x) - Number(b[i])) <= d);

async function test(name, fn) {
  if (only && !name.includes(only)) return;
  console.log(`\n▶ ${name}`);
  try {
    await fn();
  } catch (e) {
    ok(false, `${name}: ${e.message}`);
  }
}

// ---------------------------------------------------------------- light plan: each lamp its own, every colour mode
await test('Lichtplan: alle Farbmodi, jede Lampe einzeln', async () => {
  await allOff();
  const R = {
    ...base,
    id: 'lt1',
    name: 'Rot',
    kind: 'while',
    when: [{ subject: 'input_boolean.licht_a', verb: 'is_on' }],
    lights: LAMPS,
    after: 'restore',
    action: { mode: 'on', brightness: 60, color: '#ff0000', per_light: { 'light.lampe_ct': { color: 'k:3000', brightness: 30 }, 'light.lampe_onoff': { mode: 'off' }, 'light.lampe_rgbw': { color: 'rgbw:0,0,255,80' } } },
  };
  // before: the hs lamp is green at 40 % (to see "back as before" with the colour)
  await svc('light', 'turn_on', { entity_id: 'light.lampe_hs', hs_color: [120, 100], brightness_pct: 40 });
  // the room has no presence sensor: a long "nobody there any more" time, so "back as before" is not overruled by it
  const saved = await plan([R], { empty: { mode: 'keep', delay: 240, dim: 10, dim_for: 0 } });
  ok(saved.light?.[room.id]?.rules?.[0]?.action?.per_light?.['light.lampe_ct']?.color === 'k:3000', 'per_light gespeichert', saved.light?.[room.id]?.rules?.[0]);
  const t0 = Date.now();
  await svc('input_boolean', 'turn_on', { entity_id: 'input_boolean.licht_a' });
  const done = await until(async () => {
    const s = Object.fromEntries(await Promise.all(LAMPS.map(async (e) => [e, await st(e)])));
    return s['light.lampe_rgb'].state === 'on' && s['light.lampe_xy'].state === 'on' && s['light.lampe_ct'].state === 'on' && s['light.lampe_white'].state === 'on' && s['light.lampe_hs'].attributes.hs_color?.[0] === 0 && s;
  }, 8000, 100);
  ok(!!done, `alle Lampen geschaltet (${Date.now() - t0} ms vom Schalter bis zur letzten Lampe)`, (await snap()).plans.now[room.id]);
  if (!done) return;
  const a = (e) => done[e].attributes;
  ok(close(a('light.lampe_rgb').rgb_color, [255, 0, 0]) && Math.abs(a('light.lampe_rgb').brightness - 153) <= 3, 'RGB-Lampe: rot, 60 %', a('light.lampe_rgb'));
  ok(a('light.lampe_rgbw').color_mode === 'rgbw' && close(a('light.lampe_rgbw').rgbw_color, [0, 0, 255, 80]), 'RGBW-Lampe: eigene Farbe als rgbw', a('light.lampe_rgbw'));
  ok(a('light.lampe_rgbww').color_mode === 'rgbww' && a('light.lampe_rgbww').rgbww_color?.[0] === 255, 'RGBWW-Lampe: rot als rgbww', a('light.lampe_rgbww'));
  ok(a('light.lampe_hs').color_mode === 'hs' && close(a('light.lampe_hs').hs_color, [0, 100], 1), 'HS-Lampe: hs rot', a('light.lampe_hs'));
  ok(a('light.lampe_xy').color_mode === 'xy' && close(a('light.lampe_xy').xy_color, [0.701, 0.299], 0.001), 'XY-Lampe: rot als xy wie Home Assistant (0,701 / 0,299)', a('light.lampe_xy'));
  ok(a('light.lampe_ct').color_temp_kelvin === 3000 && Math.abs(a('light.lampe_ct').brightness - 77) <= 3, 'Weiß-Lampe: eigener Weißton 3000 K, 30 %', a('light.lampe_ct'));
  ok(done['light.lampe_dim'].state === 'on' && Math.abs(a('light.lampe_dim').brightness - 153) <= 3, 'Dimm-Lampe: nur Helligkeit', a('light.lampe_dim'));
  ok(done['light.lampe_onoff'].state === 'off', 'An/aus-Lampe: einzeln aus');
  ok(a('light.lampe_white').color_mode === 'hs', 'Weißkanal-Lampe: Farbe über hs', a('light.lampe_white'));
  // stable: nothing switches again and again
  const before = Object.fromEntries(await Promise.all(LAMPS.map(async (e) => [e, (await st(e)).last_updated])));
  await sleep(4000);
  const after = Object.fromEntries(await Promise.all(LAMPS.map(async (e) => [e, (await st(e)).last_updated])));
  const moved = LAMPS.filter((e) => before[e] !== after[e]);
  ok(!moved.length, 'ruhig: keine Lampe wird ständig neu geschaltet', moved);
  // back as before: hs green 40 %, others off
  await svc('input_boolean', 'turn_off', { entity_id: 'input_boolean.licht_a' });
  const back = await until(async () => {
    const hs = await st('light.lampe_hs');
    const rgb = await st('light.lampe_rgb');
    return rgb.state === 'off' && hs.state === 'on' && Math.abs(hs.attributes.hs_color?.[0] - 120) < 3 && hs;
  }, 8000, 150);
  ok(!!back && Math.abs(back.attributes.brightness - 102) <= 3, '„Wieder wie vorher“: Farbe und Helligkeit zurück, andere aus', back?.attributes);
});

await test('Lichtplan: Zigbee-Verzögerung, Effekt, Übergang, Weißkanal, 0–255', async () => {
  await allOff();
  for (const e of LAMPS) await set(e, 'off', { latency: 1.2 });
  const R = {
    ...base,
    id: 'lt2',
    name: 'Effekt',
    kind: 'when',
    trigger: [{ subject: 'input_boolean.licht_b', verb: 'is_on' }],
    lights: ['light.lampe_hs', 'light.lampe_white', 'light.lampe_dim'],
    action: { mode: 'on', brightness: 50, color: 'none', effect: 'candle', transition: 2, per_light: { 'light.lampe_white': { color: 'white', brightness: 80 }, 'light.lampe_dim': { bri: 200 } } },
  };
  await plan([R]);
  const t0 = Date.now();
  await svc('input_boolean', 'turn_on', { entity_id: 'input_boolean.licht_b' });
  const hs = await until(async () => {
    const s = await st('light.lampe_hs');
    return s.state === 'on' && s;
  }, 8000, 100);
  ok(hs?.attributes.effect === 'candle' && hs?.attributes.last_call?.transition === 2, `Effekt „candle“ und 2 s Übergang (${Date.now() - t0} ms bei 1,2 s Lampen-Verzögerung)`, hs?.attributes);
  const w = await until(async () => {
    const s = await st('light.lampe_white');
    return s.state === 'on' && s;
  }, 6000, 100);
  ok(w?.attributes.color_mode === 'white' && Math.abs(w.attributes.brightness - 204) <= 3, 'Weißkanal mit 80 %', w?.attributes);
  const d = await until(async () => {
    const s = await st('light.lampe_dim');
    return s.state === 'on' && s;
  }, 6000, 100);
  ok(d?.attributes.brightness === 200, 'Helligkeit genau 200/255', d?.attributes);
  // late reports must not make the plan switch twice
  const stamp = (await st('light.lampe_hs')).last_updated;
  await sleep(3500);
  ok((await st('light.lampe_hs')).last_updated === stamp, 'trotz Verzögerung nur einmal geschaltet');
  for (const e of LAMPS) await set(e, 'off', { latency: 0 });
});

await test('Lichtplan: Szene einmal aktivieren, Gruppen und/oder/nicht', async () => {
  await allOff();
  await svc('scene', 'create', { scene_id: 'lichttest_blau', entities: { 'light.lampe_rgb': { state: 'on', rgb_color: [0, 0, 255], brightness: 255 } } });
  const S = { ...base, id: 'lt3', name: 'Szene', kind: 'when', trigger: [{ subject: 'input_boolean.licht_b', verb: 'is_on' }], lights: ['light.lampe_rgb'], action: { mode: 'scene', scene: 'scene.lichttest_blau', brightness: 70, color: 'warm' } };
  // nested: on while (A or B) and not (value above 900)
  const G = {
    ...base,
    id: 'lt4',
    name: 'Gruppe',
    kind: 'while',
    when: [{ subject: 'logic', verb: 'all', items: [{ subject: 'logic', verb: 'any', items: [{ subject: 'input_boolean.licht_a', verb: 'is_on' }, { subject: 'input_boolean.licht_b', verb: 'is_on' }] }, { subject: 'logic', verb: 'not', items: [{ subject: 'input_number.lichtwert', verb: 'is_above', value: 900 }] }] }],
    lights: ['light.lampe_ct'],
    after: 'off',
    action: { mode: 'on', brightness: 40, color: 'kalt' },
  };
  await svc('input_number', 'set_value', { entity_id: 'input_number.lichtwert', value: 100 });
  const saved = await plan([S, G]);
  const g = saved.light?.[room.id]?.rules?.find((r) => r.id === 'lt4');
  ok(g?.when?.[0]?.items?.[0]?.items?.length === 2, 'verschachtelte Gruppe gespeichert', g?.when);
  await svc('input_boolean', 'turn_on', { entity_id: 'input_boolean.licht_b' });
  const blue = await until(async () => {
    const s = await st('light.lampe_rgb');
    return s.state === 'on' && close(s.attributes.rgb_color, [0, 0, 255]) && s;
  }, 6000, 150);
  ok(!!blue, 'Szene aktiviert: RGB-Lampe blau');
  const ct = await until(async () => (await st('light.lampe_ct')).state === 'on', 6000, 150);
  ok(ct, 'Gruppe (A oder B) und nicht (Wert > 900): an');
  // the scene's lamp is left alone afterwards (no "back to the scene" when someone else changes it)
  await svc('light', 'turn_on', { entity_id: 'light.lampe_rgb', rgb_color: [255, 255, 0] });
  await sleep(2000);
  ok(close((await st('light.lampe_rgb')).attributes.rgb_color, [255, 255, 0]), 'Szene läuft nur einmal (danach bleibt die Lampe, wie sie ist)');
  await svc('input_number', 'set_value', { entity_id: 'input_number.lichtwert', value: 950 });
  ok(await until(async () => (await st('light.lampe_ct')).state === 'off', 6000, 150), '„nicht“ greift: Wert > 900 → aus');
  await svc('input_number', 'set_value', { entity_id: 'input_number.lichtwert', value: 100 });
});

// ---------------------------------------------------------------- house rules: advanced logic
const save = async (rule) => (await ws.call({ type: 'house_rules/rule/save', rule: { only: [], and: [], enabled: true, options: { manual_pause: '' }, ...rule } })).rule;
const del = (id) => ws.call({ type: 'house_rules/rule/delete', rule_id: id }).catch(() => null);
const lightSet = (e, light) => ({ subject: e, verb: 'set', light });

await test('Hausregel: Auslöser-Kennungen und „je nach Auslöser“, Licht einstellen', async () => {
  await allOff();
  const r = await save({
    id: 'r_lt_choose',
    name: 'Wahl',
    type: 'when',
    when: [
      { subject: 'input_boolean.licht_a', verb: 'turns_on', id: 'a' },
      { subject: 'input_boolean.licht_b', verb: 'turns_on', id: 'b' },
    ],
    then: [
      {
        subject: 'logic',
        verb: 'choose',
        cases: [
          { trigger: ['a'], when: [], then: [lightSet('light.lampe_rgbww', { mode: 'on', brightness: 30, color: 'hs:120,100' })] },
          { trigger: ['b'], when: [], then: [lightSet('light.lampe_rgbww', { mode: 'on', brightness: 90, color: '#0000ff' })] },
        ],
        else: [],
      },
    ],
  });
  ok(r?.then?.[0]?.cases?.length === 2 && r?.when?.[0]?.id === 'a', 'Regel mit Wahl gespeichert', r);
  await svc('input_boolean', 'turn_on', { entity_id: 'input_boolean.licht_a' });
  const green = await until(async () => {
    const s = await st('light.lampe_rgbww');
    // a lamp that was off: on in the colour first (very dim), then the brightness (lightspec.power_up)
    return s.state === 'on' && Math.abs(s.attributes.hs_color?.[0] - 120) < 5 && Math.abs(s.attributes.brightness - 77) <= 3 && s;
  }, 6000, 150);
  ok(!!green && Math.abs(green.attributes.brightness - 77) <= 3, 'Auslöser a → grün, 30 %', (green ?? (await st('light.lampe_rgbww'))).attributes.calls?.slice(-4));
  await svc('input_boolean', 'turn_on', { entity_id: 'input_boolean.licht_b' });
  const blue = await until(async () => {
    const s = await st('light.lampe_rgbww');
    return Math.abs(s.attributes.hs_color?.[0] - 240) < 5 && s;
  }, 6000, 150);
  ok(!!blue, 'Auslöser b → blau', blue?.attributes);
  const d = await ws.call({ type: 'house_rules/rule/describe', rule: r });
  ok(typeof d?.sentence === 'string' && /Auslöser|trigger/.test(d.sentence), 'Satz beschreibt die Wahl', d);
  const ex = await ws.call({ type: 'house_rules/rule/export', rule_id: 'r_lt_choose' });
  const a0 = ex?.automation?.actions?.[0];
  ok(ex?.automation?.triggers?.[0]?.id === 'a' && a0?.choose?.[0]?.conditions?.[0]?.condition === 'trigger' && a0.choose[0].sequence?.[0]?.data?.rgbww_color, 'als HA-Automation: Auslöser-Kennung, choose nach Auslöser, rgbww_color', ex?.automation);
  await del('r_lt_choose');
});

await test('Hausregel: Wenn/Sonst, Wiederholen, Gleichzeitig, Werte vom Auslöser', async () => {
  await allOff();
  await save({
    id: 'r_lt_flow',
    name: 'Ablauf',
    type: 'when',
    when: [{ subject: 'input_number.lichtwert', verb: 'changes' }],
    then: [
      { subject: 'logic', verb: 'set', name: 'level', from: 'trigger', in_min: 0, in_max: 1000, out_min: 1, out_max: 100 },
      { subject: 'logic', verb: 'if', if: [{ subject: 'input_number.lichtwert', verb: 'is_between', min: 1, max: 900 }], then: [{ subject: 'light.lampe_dim', verb: 'turn_on', brightness: '$level' }], else: [{ subject: 'light.lampe_dim', verb: 'turn_off' }] },
      { subject: 'logic', verb: 'parallel', then: [{ subject: 'wait', verb: 'wait', for: '2s' }, { subject: 'wait', verb: 'wait', for: '2s' }] },
      { subject: 'logic', verb: 'repeat', count: 3, then: [{ subject: 'light.lampe_onoff', verb: 'toggle' }] },
    ],
  });
  const t0 = Date.now();
  await svc('input_number', 'set_value', { entity_id: 'input_number.lichtwert', value: 500 });
  const dim = await until(async () => {
    const s = await st('light.lampe_dim');
    return s.state === 'on' && s;
  }, 5000, 100);
  ok(!!dim && Math.abs(dim.attributes.brightness / 2.55 - 50) <= 2, 'Wert vom Auslöser (500 von 1000) → 50 % Helligkeit', dim?.attributes);
  const toggled = await until(async () => (await st('light.lampe_onoff')).state === 'on', 6000, 100);
  const took = Date.now() - t0;
  ok(toggled && took < 3800, `zwei Wartezeiten von 2 s gleichzeitig (${took} ms) und 3× umschalten → an`);
  await svc('input_number', 'set_value', { entity_id: 'input_number.lichtwert', value: 950 });
  ok(await until(async () => (await st('light.lampe_dim')).state === 'off', 5000, 100), 'sonst-Zweig: Wert außerhalb → aus');
  await del('r_lt_flow');
  await svc('input_number', 'set_value', { entity_id: 'input_number.lichtwert', value: 100 });
});

await test('Hausregel: Warten bis …, Warten auf ein HA-Ereignis, HA-Ereignis als Auslöser', async () => {
  await allOff();
  await save({
    id: 'r_lt_wait',
    name: 'Warten',
    type: 'when',
    when: [{ subject: 'ha_event', verb: 'fired', event_type: 'hr_test_press', event_data: 'button=1' }],
    then: [
      { subject: 'light.lampe_ct', verb: 'turn_on' },
      { subject: 'logic', verb: 'wait_until', items: [{ subject: 'input_boolean.licht_b', verb: 'is_on' }], timeout: '30s', continue: false },
      { subject: 'light.lampe_ct', verb: 'turn_off' },
      { subject: 'logic', verb: 'wait_trigger', items: [{ subject: 'ha_event', verb: 'fired', event_type: 'hr_test_go' }], timeout: '30s', continue: true },
      { subject: 'light.lampe_xy', verb: 'turn_on' },
    ],
  });
  await sleep(500);
  await api('POST', '/api/events/hr_test_press', { button: '2' });
  await sleep(1200);
  ok((await st('light.lampe_ct')).state === 'off', 'Ereignis mit anderen Daten löst nicht aus');
  await api('POST', '/api/events/hr_test_press', { button: '1' });
  ok(await until(async () => (await st('light.lampe_ct')).state === 'on', 5000, 100), 'HA-Ereignis mit button=1 löst aus');
  await sleep(800);
  ok((await st('light.lampe_ct')).state === 'on', 'wartet, bis B an ist');
  await svc('input_boolean', 'turn_on', { entity_id: 'input_boolean.licht_b' });
  ok(await until(async () => (await st('light.lampe_ct')).state === 'off', 5000, 100), 'B an → weiter');
  await sleep(600);
  ok((await st('light.lampe_xy')).state === 'off', 'wartet auf das Ereignis „hr_test_go“');
  await api('POST', '/api/events/hr_test_go', {});
  ok(await until(async () => (await st('light.lampe_xy')).state === 'on', 5000, 100), 'Ereignis kommt → weiter');
  await del('r_lt_wait');
});

await test('Hausregel: Lauf-Modus single / restart / queued / parallel', async () => {
  for (const [mode, want, wait] of [
    ['single', 'on', 3500],
    ['restart', 'on', 4500],
    ['queued', 'off', 6500],
    ['parallel', 'off', 3800],
  ]) {
    await allOff();
    await save({
      id: 'r_lt_mode',
      name: `Modus ${mode}`,
      type: 'when',
      when: [{ subject: 'input_boolean.licht_a', verb: 'turns_on' }, { subject: 'input_boolean.licht_a', verb: 'turns_off' }],
      then: [{ subject: 'wait', verb: 'wait', for: '2s' }, { subject: 'light.lampe_onoff', verb: 'toggle' }],
      options: { manual_pause: '', mode, max: 5 },
    });
    await sleep(300);
    await svc('input_boolean', 'turn_on', { entity_id: 'input_boolean.licht_a' });
    await sleep(500);
    await svc('input_boolean', 'turn_off', { entity_id: 'input_boolean.licht_a' });
    await sleep(wait);
    const s = (await st('light.lampe_onoff')).state;
    ok(s === want, `${mode}: zweimal ausgelöst → Lampe ${want}`, { s, history: (await snap()).history.filter((h) => h.rule_id === 'r_lt_mode' || /Modus/.test(JSON.stringify(h))).slice(0, 4) });
    await del('r_lt_mode');
  }
});

await test('Bedingungen: zwischen, Wochentage, Sonne mit Versatz, nicht', async () => {
  await svc('input_number', 'set_value', { entity_id: 'input_number.lichtwert', value: 500 });
  const today = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' })).getDay()];
  const others = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].filter((d) => d !== today).join(',');
  const rule = {
    type: 'when',
    when: [{ subject: 'input_boolean.licht_a', verb: 'turns_on' }],
    and: [
      { subject: 'input_number.lichtwert', verb: 'is_between', min: 400, max: 600 },
      { subject: 'input_number.lichtwert', verb: 'is_between', min: 600, max: 700 },
      { subject: 'time', verb: 'weekdays', days: today },
      { subject: 'time', verb: 'weekdays', days: others },
      { subject: 'sun', verb: 'after_sunset', offset: '-30m' },
      { subject: 'sun', verb: 'before_sunset', offset: '-30m' },
      { subject: 'logic', verb: 'not', items: [{ subject: 'input_number.lichtwert', verb: 'is_between', min: 400, max: 600 }] },
      { subject: 'logic', verb: 'any', items: [{ subject: 'input_number.lichtwert', verb: 'is_below', value: 10 }, { subject: 'input_number.lichtwert', verb: 'is_above', value: 10 }] },
    ],
    then: [{ subject: 'light.lampe_dim', verb: 'turn_on' }],
    only: [],
  };
  const res = await ws.call({ type: 'house_rules/rule/test', rule });
  const c = res.checks.filter((x) => x.section === 'and').map((x) => x.ok);
  ok(c[0] === true && c[1] === false, 'zwischen 400 und 600: ja, 600–700: nein', c);
  ok(c[2] === true && c[3] === false, 'Wochentage: heute ja, die anderen nein', c);
  ok(c[4] !== c[5], 'Sonne: genau eins von „nach“ und „vor Sonnenuntergang − 30 Min.“', c);
  ok(c[6] === false && c[7] === true, '„nichts davon“ und „eins davon“', c);
  const d = await ws.call({ type: 'house_rules/rule/describe', rule });
  ok(/zwischen 400 und 600|between 400 and 600/.test(d?.sentence ?? '') && /nichts davon|none of/.test(d?.sentence ?? ''), 'Satz mit „zwischen“ und „nichts davon“', d?.sentence);
});

await test('Speichern: Grenzen, unbekannte Schlüssel, alte Lichtregeln', async () => {
  let deep = { subject: 'input_boolean.licht_a', verb: 'is_on' };
  for (let i = 0; i < 9; i++) deep = { subject: 'logic', verb: 'all', items: [deep], junk: 1 };
  const r = await save({ id: 'r_lt_deep', name: 'Tief', type: 'when', when: [{ subject: 'input_boolean.licht_a', verb: 'turns_on' }], and: [deep], then: [{ subject: 'logic', verb: 'nope' }, { subject: 'light.lampe_rgb', verb: 'turn_on' }] });
  let depth = 0;
  for (let c = r.and[0]; c && c.subject === 'logic'; c = c.items?.[0]) depth++;
  ok(r.and.length === 0 || depth <= 6, `zu tief verschachtelt wird abgeschnitten (Tiefe ${depth})`, r.and);
  ok(!JSON.stringify(r).includes('junk') && r.then.length === 1, 'unbekannte Schlüssel und Blöcke fallen weg', r);
  await del('r_lt_deep');
  // a light rule in the old format (only mode/brightness/colour) still works
  await allOff();
  await plan([{ ...base, id: 'lt9', name: 'Alt', kind: 'while', when: [{ subject: 'input_boolean.licht_a', verb: 'is_on' }], lights: ['light.lampe_ct', 'light.lampe_rgb'], action: { mode: 'on', brightness: 70, color: 'warm' } }]);
  await svc('input_boolean', 'turn_on', { entity_id: 'input_boolean.licht_a' });
  const old = await until(async () => {
    const s = await st('light.lampe_ct');
    return s.state === 'on' && s;
  }, 6000, 150);
  ok(old?.attributes.color_temp_kelvin === 2700, 'alte Regel: warm = 2700 K', old?.attributes);
  const rgb = await st('light.lampe_rgb');
  ok(rgb.state === 'on' && rgb.attributes.hs_color?.[0] > 20 && rgb.attributes.hs_color?.[0] < 45, 'RGB-Lampe ohne Weißtöne: warm als Farbe', rgb.attributes);
});

await test('Gleichzeitig: Lampen einer Regel schalten zusammen, nicht nacheinander', async () => {
  // lamps like Zigbee/Hue: the service call waits 1 s for the lamp's answer, and the state is reported 1 s late
  const PAIR = ['light.lampe_ct', 'light.lampe_dim'];
  const slow = async () => {
    for (const e of PAIR) await set(e, 'off', { latency: 1, call_latency: 1 });
  };
  const apart = async (state) => {
    const xs = await until(async () => {
      const ys = await Promise.all(PAIR.map(st));
      return ys.every((y) => y.state === state) && ys;
    }, 12000, 100);
    return xs ? Math.abs(Date.parse(xs[0].last_changed) - Date.parse(xs[1].last_changed)) : Infinity;
  };
  await allOff();
  await slow();
  const W = { ...base, id: 'lt_sync', name: 'Zusammen', kind: 'while', when: [{ subject: 'input_boolean.licht_a', verb: 'is_on' }], lights: PAIR, after: 'off' };
  await plan([{ ...W, action: { mode: 'on', brightness: 60, color: 'none' } }]);
  await svc('input_boolean', 'turn_on', { entity_id: 'input_boolean.licht_a' });
  let d = await apart('on');
  ok(d <= 150, `Lichtplan, gleiche Einstellung: beide an mit ${d} ms Abstand`);
  await svc('input_boolean', 'turn_off', { entity_id: 'input_boolean.licht_a' });
  d = await apart('off');
  ok(d <= 150, `Lichtplan, Regel vorbei: beide aus mit ${d} ms Abstand`);
  await plan([{ ...W, action: { mode: 'on', brightness: 60, color: 'none', per_light: { 'light.lampe_dim': { brightness: 30 } } } }]);
  await svc('input_boolean', 'turn_on', { entity_id: 'input_boolean.licht_a' });
  d = await apart('on');
  ok(d <= 150, `Lichtplan, verschiedene Einstellungen: beide an mit ${d} ms Abstand`);
  // a house rule: one light setting, a different brightness per lamp; "while": put back afterwards
  await allOff();
  await slow();
  await save({ id: 'r_lt_sync', name: 'Zusammen', type: 'while', when: [{ subject: 'input_boolean.licht_b', verb: 'is_on' }], then: [lightSet(`all:light@${room.id}`, { mode: 'on', brightness: 70, color: 'none', per_light: { 'light.lampe_dim': { brightness: 20 } } })] });
  await svc('input_boolean', 'turn_on', { entity_id: 'input_boolean.licht_b' });
  d = await apart('on');
  ok(d <= 150, `Hausregel, verschiedene Einstellungen: beide an mit ${d} ms Abstand`);
  await svc('input_boolean', 'turn_off', { entity_id: 'input_boolean.licht_b' });
  d = await apart('off');
  ok(d <= 150, `Hausregel „solange“ vorbei, wie vorher: beide aus mit ${d} ms Abstand`);
  await del('r_lt_sync');
});

await test('Live an der Lampe: Vorschau = Ausführung, Rechte', async () => {
  await allOff();
  const X = 'light.lampe_xy';
  // what the panel sends in live mode (LiveStore.lightCall): call_service with a target, RGB as rgb_color (HA converts)
  const live = { type: 'call_service', domain: 'light', service: 'turn_on', service_data: { brightness: 77, rgb_color: [255, 138, 61] }, target: { entity_id: X } };
  await ws.call(live);
  const prev = await until(async () => {
    const s = await st(X);
    return s.state === 'on' && Array.isArray(s.attributes.xy_color) && s;
  });
  await svc('light', 'turn_off', { entity_id: X });
  await until(async () => (await st(X)).state === 'off');
  // what Hausregeln sends when the step runs (lightspec.py: xy for an xy lamp, rgb_to_xy like Home Assistant)
  await ws.call({ type: 'house_rules/rule/run_actions', rule: { name: 'Live-Vergleich', when: [{ subject: 'input_boolean.licht_a', verb: 'turns_on' }], then: [lightSet(X, { mode: 'on', bri: 77, color: '#ff8a3d' })], options: { manual_pause: '' } } });
  const run = await until(async () => {
    const s = await st(X);
    return s.state === 'on' && s;
  });
  ok(prev && run && close(prev.attributes.xy_color, run.attributes.xy_color, 0.0005) && prev.attributes.brightness === run.attributes.brightness, `XY-Lampe: live ${prev?.attributes.xy_color} = ausgeführt ${run?.attributes.xy_color} (77/255)`);
  ok(JSON.stringify(run?.attributes.last_call?.xy_color) === '[0.577,0.37]', 'Hausregeln sendet xy wie Home Assistant (#ff8a3d → 0.577, 0.37)', run?.attributes.last_call);
  // a Home Assistant user without control rights (read-only group): refused with "unauthorized", the lamp stays
  const ro = await wsConnect(await userToken(tok, 'leser', 'system-read-only'));
  const err = await ro.call({ ...live, service_data: { brightness: 10 } }).then(() => null, (e) => e);
  ro.close();
  ok(err && /unauthori/i.test(`${err.code ?? ''} ${err.message ?? ''}`), 'Nur-Lesen-Benutzer: Home Assistant lehnt ab (unauthorized)', err && { code: err.code, message: err.message });
  ok((await st(X)).attributes.brightness === 77, 'Lampe unverändert');
  await svc('light', 'turn_off', { entity_id: X });
});

await test('Live-Vorschau über die Integration (light/preview): Plan hält still, zurückstellen, Rechte', async () => {
  await allOff();
  const D = 'light.lampe_dim';
  const H = 'light.lampe_hs';
  const bri = async (e) => (await st(e)).attributes.brightness;
  // the plan keeps the dimmable lamp at 30 % while licht_a is on (and would put any other change back)
  const W = { ...base, id: 'lt_prev', name: 'Vorschau-Test', kind: 'while', when: [{ subject: 'input_boolean.licht_a', verb: 'is_on' }], lights: [D], after: 'off' };
  await plan([{ ...W, action: { mode: 'on', brightness: 30, color: 'none' } }], { manual: '30m' });
  await svc('input_boolean', 'turn_on', { entity_id: 'input_boolean.licht_a' });
  ok(await until(async () => Math.abs((await bri(D)) - 76.5) <= 1, 8000), 'Plan: Lampe auf 30 % (76/255)');
  const b30 = await bri(D);
  const pv = await wsConnect(tok);
  const { session } = await pv.call({ type: 'house_rules/light/preview', action: 'start', lights: [D, H] });
  ok(typeof session === 'string' && session.length > 8, 'Sitzung gestartet');
  await pv.call({ type: 'house_rules/light/preview', action: 'apply', session, settings: { [D]: { mode: 'on', bri: 200 }, [H]: { mode: 'on', brightness: 50, color: 'hs:240,100', transition: 5, flash: 'long' } } });
  ok(await until(async () => (await bri(D)) === 200, 5000), 'Vorschau: dimmbare Lampe genau 200/255');
  const h = await st(H);
  ok(h.state === 'on' && close(h.attributes.hs_color, [240, 100], 1) && h.attributes.last_call?.transition === undefined && h.attributes.last_call?.flash === undefined, 'HS-Lampe: blau als hs, ohne Übergang/Blitz', h.attributes);
  await sleep(2500);
  ok((await bri(D)) === 200, 'der Plan stellt während der Vorschau nichts zurück');
  const now1 = (await snap()).plans.now?.[room.id]?.light;
  ok(!(now1?.held ?? []).includes(D), 'zählt nicht als „von Hand“', now1);
  const hist = await ws.call({ type: 'house_rules/history', limit: 8 });
  ok(!hist.slice(0, 8).some((x) => /dimmbar|Lampe HS/.test(x.what) && /Hand|App/.test(x.why ?? '')), 'kein „von Hand“ im Verlauf', hist.slice(0, 5).map((x) => `${x.what} | ${x.why}`));
  await pv.call({ type: 'house_rules/light/preview', action: 'stop', session, restore: true });
  ok(await until(async () => (await bri(D)) === b30 && (await st(H)).state === 'off', 5000), 'stop: beide wie vorher (30 %, aus)');
  ok(/not_found/.test(await pv.call({ type: 'house_rules/light/preview', action: 'keep', session }).then(() => '', (e) => e.message)), 'beendete Sitzung: not_found');
  await sleep(6500);
  ok((await bri(D)) === b30, 'nach der Schonfrist hält der Plan wieder 30 %');

  // the panel's connection drops (tab closed): lamps back right away
  const pv2 = await wsConnect(tok);
  const s2 = (await pv2.call({ type: 'house_rules/light/preview', action: 'start', lights: [D] })).session;
  await pv2.call({ type: 'house_rules/light/preview', action: 'apply', session: s2, settings: { [D]: { mode: 'on', bri: 150 } } });
  ok(await until(async () => (await bri(D)) === 150, 5000), 'zweite Sitzung: 150/255');
  pv2.close();
  ok(await until(async () => (await bri(D)) === b30, 5000), 'Verbindung weg: Lampe sofort zurück');

  // "so lassen": stays, and for the plan it counts as by hand (its room setting: 30 min)
  const s3 = (await pv.call({ type: 'house_rules/light/preview', action: 'start', lights: [D] })).session;
  await pv.call({ type: 'house_rules/light/preview', action: 'apply', session: s3, settings: { [D]: { mode: 'on', bri: 180 } } });
  ok(await until(async () => (await bri(D)) === 180, 5000), 'dritte Sitzung: 180/255');
  await pv.call({ type: 'house_rules/light/preview', action: 'stop', session: s3, restore: false });
  await sleep(6500);
  const now3 = (await snap()).plans.now?.[room.id]?.light;
  ok((await bri(D)) === 180 && (now3?.held ?? []).includes(D), '„So lassen“: bleibt 180, der Plan lässt sie wie von Hand in Ruhe', now3);

  // rights: lights only, Home Assistant's control right per lamp, only the own session
  const bad = await pv.call({ type: 'house_rules/light/preview', action: 'start', lights: ['input_boolean.licht_b'] }).then(() => '', (e) => e.message);
  ok(/^invalid/.test(bad), 'keine Lampe (Schalter/Schloss …): abgelehnt', bad);
  const ro = await wsConnect(await userToken(tok, 'leser', 'system-read-only'));
  const roErr = await ro.call({ type: 'house_rules/light/preview', action: 'start', lights: [D] }).then(() => '', (e) => e.message);
  ok(/^unauthorized/.test(roErr) && /dimmbar/.test(roErr), 'Nur-Lesen-Benutzer: abgelehnt, mit Namen der Lampe', roErr);
  ro.close();
  const tablet = await wsConnect(await userToken(tok, 'tablet'));
  const s4 = (await pv.call({ type: 'house_rules/light/preview', action: 'start', lights: [D] })).session;
  const other = await tablet.call({ type: 'house_rules/light/preview', action: 'apply', session: s4, settings: { [D]: { mode: 'off' } } }).then(() => '', (e) => e.message);
  ok(/^not_found/.test(other) && (await st(D)).state === 'on', 'fremde Sitzung: not_found, nichts geschaltet', other);
  const own = await tablet.call({ type: 'house_rules/light/preview', action: 'start', lights: [D] }).then((r) => r.session, (e) => e.message);
  ok(typeof own === 'string' && own.length > 8, 'Bewohner (Standard-Benutzer) darf eine eigene Vorschau starten', own);
  await tablet.call({ type: 'house_rules/light/preview', action: 'stop', session: own });
  await pv.call({ type: 'house_rules/light/preview', action: 'stop', session: s4 });
  tablet.close();
  pv.close();
  await svc('input_boolean', 'turn_off', { entity_id: 'input_boolean.licht_a' });
  await allOff();
});

// ---------------------------------------------------------------- lamps that are off power up in their colour
const calls = async (e) => (await st(e)).attributes.calls ?? [];
const nCalls = async (e) => (await st(e)).attributes.n_calls ?? 0;
const fresh = async (e, state = 'off', attrs = {}) => set(e, state, { latency: 0, call_latency: 0, bri_offset: 0, steps: false, clear_calls: true, ...attrs });

await test('Einschalten in der Farbe: erst ganz dunkel in der Farbe, dann hoch (kein Weiß-Blitz)', async () => {
  await allOff();
  for (const e of LAMPS) await fresh(e);
  const R = { ...base, id: 'lt_pu', name: 'Orange', kind: 'while', when: [{ subject: 'input_boolean.licht_a', verb: 'is_on' }], lights: ['light.lampe_xy', 'light.lampe_rgb', 'light.lampe_hs'], after: 'off', action: { mode: 'on', brightness: 67, color: 'xy:0.596,0.388', transition: 0.5, per_light: { 'light.lampe_rgb': { bri: 3 } } } };
  await svc('light', 'turn_on', { entity_id: 'light.lampe_hs', brightness: 100, hs_color: [200, 50] }); // already on: one call
  await fresh('light.lampe_hs', 'on');
  await plan([R], { empty: { mode: 'keep', delay: 240, dim: 10, dim_for: 0 } });
  await svc('input_boolean', 'turn_on', { entity_id: 'input_boolean.licht_a' });
  const xy = await until(async () => {
    const s = await st('light.lampe_xy');
    return s.state === 'on' && Math.abs(s.attributes.brightness - 171) <= 3 && s;
  }, 6000, 100);
  const c = xy?.attributes.calls ?? [];
  ok(c.length === 2 && c[0].brightness === 13 && c[0].transition === 0 && close(c[0].xy_color, [0.596, 0.388], 0.001), 'aus → 1. Aufruf: Farbe, 13/255, ohne Übergang', c);
  ok(c[1]?.brightness === 171 && c[1].transition === 0.5, '2. Aufruf: Helligkeit mit dem Übergang 0,5 s', c);
  const rgb = await calls('light.lampe_rgb');
  ok(rgb.length === 1 && rgb[0].brightness === 3 && rgb[0].transition === 0, 'Ziel fast aus (3/255): ein Aufruf in der Farbe ohne Übergang', rgb);
  const hs = await calls('light.lampe_hs');
  ok(hs.length === 1 && hs[0].transition === 0.5 && Math.abs(hs[0].brightness - 171) <= 1, 'schon an: ein Aufruf wie gewünscht', hs);
  // a house rule: the same
  await svc('input_boolean', 'turn_off', { entity_id: 'input_boolean.licht_a' });
  await until(async () => (await st('light.lampe_xy')).state === 'off', 5000);
  await plan([], { on: false });
  await fresh('light.lampe_rgbww');
  await save({ id: 'r_lt_pu', name: 'Farbe', type: 'when', when: [{ subject: 'input_boolean.licht_b', verb: 'turns_on' }], then: [lightSet('light.lampe_rgbww', { mode: 'on', brightness: 80, color: '#ff8c00', transition: 1 })] });
  await svc('input_boolean', 'turn_on', { entity_id: 'input_boolean.licht_b' });
  const ww = await until(async () => {
    const s = await st('light.lampe_rgbww');
    return (s.attributes.n_calls ?? 0) >= 2 && s;
  }, 6000, 100);
  const w = ww?.attributes.calls ?? [];
  ok(w.length === 2 && w[0].brightness === 13 && w[0].rgbww_color && w[1].brightness === 204 && w[1].transition === 1, 'Hausregel „Licht einstellen“: ebenso in zwei Schritten', w);
  await del('r_lt_pu');
});

// ---------------------------------------------------------------- lamps that report their own way: no re-send loop
await test('Lichtplan: Lampe meldet anders oder in Stufen → kein Dauer-Senden', async () => {
  await allOff();
  // a lamp that always reports 20 brighter than asked (beyond the tolerance): at most 3 tries
  await svc('light', 'turn_on', { entity_id: 'light.lampe_hs', brightness: 40, hs_color: [30, 100] });
  await fresh('light.lampe_hs', 'on', { bri_offset: 20 });
  // a lamp that reports a fade in steps (halfway first): one call is enough
  await svc('light', 'turn_on', { entity_id: 'light.lampe_xy', brightness: 20, xy_color: [0.5, 0.4] });
  await fresh('light.lampe_xy', 'on', { steps: true });
  const R = { ...base, id: 'lt_rs', name: 'Abends', kind: 'while', when: [{ subject: 'input_boolean.licht_a', verb: 'is_on' }], lights: ['light.lampe_hs', 'light.lampe_xy'], after: 'nothing', action: { mode: 'on', bri: 100, color: 'hs:30,100', transition: 2, per_light: { 'light.lampe_xy': { bri: 200 } } } };
  await plan([R], { empty: { mode: 'keep', delay: 240, dim: 10, dim_for: 0 } });
  await svc('input_boolean', 'turn_on', { entity_id: 'input_boolean.licht_a' });
  await sleep(14000);
  const n = await nCalls('light.lampe_hs');
  ok(n === 3, `Lampe meldet immer 20 heller: ${n}× gesendet (höchstens 3), dann in Ruhe gelassen`, [await calls('light.lampe_hs'), (await snap()).plans.now?.[room.id], (await st('light.lampe_hs')).attributes]);
  const nx = await nCalls('light.lampe_xy');
  ok(nx === 1, `Übergang 2 s in Stufen gemeldet: ${nx}× gesendet`, await calls('light.lampe_xy'));
  ok(Math.abs((await st('light.lampe_xy')).attributes.brightness - 200) <= 2, 'und am Ende richtig');
  // switched off by something else: the plan tries again
  await svc('light', 'turn_off', { entity_id: 'light.lampe_hs' });
  ok(await until(async () => (await st('light.lampe_hs')).state === 'on', 6000), 'von außen ausgeschaltet → wieder an');
  await svc('input_boolean', 'turn_off', { entity_id: 'input_boolean.licht_a' });
  await plan([], { on: false });
  await fresh('light.lampe_hs');
  await fresh('light.lampe_xy');
});

// ---------------------------------------------------------------- never on: commands of house rules on their way
await test('Nie an: Befehl einer Hausregel unterwegs, späte Meldung, erlaubte Regel', async () => {
  await allOff();
  await svc('input_boolean', 'turn_off', { entity_id: 'input_boolean.licht_b' });
  for (const e of LAMPS) await fresh(e);
  // "lamp A never on while lamp B is off" – one command switches both, B reports 1.5 s later
  await fresh('light.lampe_dim', 'off', { latency: 1.5 });
  const N = { ...base, id: 'lt_no', name: 'Nie an, solange Dimm-Lampe aus', kind: 'never_on', when: [{ subject: 'light.lampe_dim', verb: 'is_off' }], lights: ['light.lampe_ct'] };
  await plan([N], { manual: '30m', empty: { mode: 'keep', delay: 240, dim: 10, dim_for: 0 } });
  await save({ id: 'r_lt_two', name: 'Beide', type: 'when', when: [{ subject: 'input_boolean.licht_b', verb: 'turns_on' }], then: [lightSet('light.lampe_ct', { mode: 'on', brightness: 60, color: 'warm' }), lightSet('light.lampe_dim', { mode: 'on', brightness: 60, color: 'none' })] });
  await svc('input_boolean', 'turn_on', { entity_id: 'input_boolean.licht_b' });
  await sleep(6000);
  ok((await st('light.lampe_ct')).state === 'on' && (await st('light.lampe_dim')).state === 'on', 'beide an: die Sperre hängt an der zweiten Lampe desselben Befehls und greift nicht');
  await del('r_lt_two');
  await svc('input_boolean', 'turn_off', { entity_id: 'input_boolean.licht_b' });
  // an allowed house rule, the lamp reports only 6 s later (Home Assistant: a fresh context, like a press at the device)
  await allOff();
  await fresh('light.lampe_ct', 'off', { latency: 6 });
  await svc('input_boolean', 'turn_on', { entity_id: 'input_boolean.licht_a' });
  const B = { ...base, id: 'lt_nb', name: 'Nie an, solange A', kind: 'never_on', when: [{ subject: 'input_boolean.licht_a', verb: 'is_on' }], lights: ['light.lampe_ct'], allow: ['rule:r_lt_ok'] };
  await plan([B], { manual: '30m', empty: { mode: 'keep', delay: 240, dim: 10, dim_for: 0 } });
  await save({ id: 'r_lt_ok', name: 'Erlaubt', type: 'when', when: [{ subject: 'input_boolean.licht_b', verb: 'turns_on' }], then: [lightSet('light.lampe_ct', { mode: 'on', brightness: 60, color: 'warm', transition: 0.5 })] });
  await svc('input_boolean', 'turn_on', { entity_id: 'input_boolean.licht_b' });
  ok(await until(async () => (await st('light.lampe_ct')).state === 'on', 9000), 'erlaubte Regel: Lampe geht an (Meldung nach 6 s)');
  await sleep(4000);
  ok((await st('light.lampe_ct')).state === 'on', 'erlaubte Regel: bleibt an');
  // (a house rule's change is kept like one by hand: the "not allowed" case below shows that the late report counts as the rule)
  await del('r_lt_ok');
  await svc('input_boolean', 'turn_off', { entity_id: 'input_boolean.licht_b' });
  // a house rule that is not allowed, the same late report: off again (no longer taken for a person)
  await svc('light', 'turn_off', { entity_id: 'light.lampe_ct' });
  await until(async () => (await st('light.lampe_ct')).state === 'off', 9000);
  await plan([B], { manual: '30m', empty: { mode: 'keep', delay: 240, dim: 10, dim_for: 0 } });
  await save({ id: 'r_lt_nope', name: 'Nicht erlaubt', type: 'when', when: [{ subject: 'input_boolean.licht_b', verb: 'turns_on' }], then: [lightSet('light.lampe_ct', { mode: 'on', brightness: 60, color: 'warm' })] });
  await svc('input_boolean', 'turn_on', { entity_id: 'input_boolean.licht_b' });
  ok(await until(async () => (await st('light.lampe_ct')).state === 'on', 9000), 'nicht erlaubte Regel: Lampe meldet sich an');
  ok(await until(async () => (await st('light.lampe_ct')).state === 'off', 22000), 'nicht erlaubte Regel: wieder aus (gesperrt)');
  await del('r_lt_nope');
  await svc('input_boolean', 'turn_off', { entity_id: 'input_boolean.licht_b' });
  await svc('input_boolean', 'turn_off', { entity_id: 'input_boolean.licht_a' });
  await plan([], { on: false });
  await fresh('light.lampe_ct');
  await fresh('light.lampe_dim');
});

// ---------------------------------------------------------------- a house rule is newer than a "when" light rule
await test('Hausregel nach einer „Wenn“-Lichtregel: der Plan stellt nicht zurück', async () => {
  await allOff();
  await fresh('light.lampe_rgb');
  const W = { ...base, id: 'lt_when', name: 'Wenn A: rot', kind: 'when', trigger: [{ subject: 'input_boolean.licht_a', verb: 'is_on' }], lights: ['light.lampe_rgb'], action: { mode: 'on', brightness: 60, color: '#ff0000' } };
  await plan([W], { empty: { mode: 'keep', delay: 240, dim: 10, dim_for: 0 } });
  await svc('input_boolean', 'turn_on', { entity_id: 'input_boolean.licht_a' });
  ok(await until(async () => (await st('light.lampe_rgb')).attributes.rgb_color?.[0] === 255 && Math.abs((await st('light.lampe_rgb')).attributes.brightness - 153) <= 3, 6000), 'Wenn-Regel: rot 60 %');
  // right after the plan applied it: a house rule (a button) sets it otherwise
  await save({ id: 'r_lt_btn', name: 'Knopf: blau', type: 'when', when: [{ subject: 'input_boolean.licht_b', verb: 'turns_on' }], then: [lightSet('light.lampe_rgb', { mode: 'on', brightness: 20, color: '#0000ff' })] });
  await svc('input_boolean', 'turn_on', { entity_id: 'input_boolean.licht_b' });
  await sleep(4000);
  const s = await st('light.lampe_rgb');
  ok(close(s.attributes.rgb_color, [0, 0, 255]) && Math.abs(s.attributes.brightness - 51) <= 3, 'Hausregel danach: bleibt blau 20 %', s.attributes);
  await del('r_lt_btn');
  await svc('input_boolean', 'turn_off', { entity_id: 'input_boolean.licht_b' });
  await svc('input_boolean', 'turn_off', { entity_id: 'input_boolean.licht_a' });
  await plan([], { on: false });
});

await allOff();
await plan([], { on: false });
if (alarmConfirm && alarmConfirm !== 'none') await ws.call({ type: 'house_rules/alarm/config', config: { confirm: alarmConfirm } }).catch(() => null);
ws.close();
console.log(failures() ? `\n${failures()} Fehler` : '\nalles ok');
process.exit(failures() ? 1 : 0);
