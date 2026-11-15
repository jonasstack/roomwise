// Tests the companion integration against an isolated test Home Assistant (never the real one):
//   sh tools/companion/testha/start.sh (container fp-test-ha on 127.0.0.1:8124 with custom_components/roomwise + the
//   test-only component tools/companion/testha/fp_fake, which records tts / light / scene / notify calls). Usage: node tools/companion/test-companion.mjs [url]
const URL0 = process.argv[2] ?? 'http://127.0.0.1:8124';
const ok = (c, m) => console.log(c ? '  ok:' : '• FAIL:', m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (path, opts = {}) => { const r = await fetch(URL0 + path, opts); const t = await r.text(); try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t }; } };

// onboarding (first run) or stored token
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const TOK = new URL('../.cache/companion-test-token', import.meta.url);
let token = existsSync(TOK) ? readFileSync(TOK, 'utf8').trim() : '';
if (token && (await j('/api/', { headers: { Authorization: `Bearer ${token}` } })).status !== 200) token = '';
if (!token) {
  const client_id = `${URL0}/`;
  const u = await j('/api/onboarding/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id, name: 'Test', username: 'test', password: 'test-pass-123', language: 'de' }) });
  const code = u.body.auth_code;
  const tk = await j('/auth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id }) });
  const access = tk.body.access_token;
  // long-lived token for later runs
  const ws0 = await wsConnect(access);
  token = await ws0.call({ type: 'auth/long_lived_access_token', client_name: 'fp-test', lifespan: 3650 });
  ws0.close();
  const { mkdirSync } = await import('node:fs');
  mkdirSync(new URL('../.cache/', import.meta.url), { recursive: true });
  writeFileSync(TOK, token);
}
const H = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
// finish onboarding (otherwise the start page is the onboarding page)
for (const step of ['core_config', 'analytics']) await j(`/api/onboarding/${step}`, { method: 'POST', headers: H, body: '{}' });
await j('/api/onboarding/integration', { method: 'POST', headers: H, body: JSON.stringify({ client_id: `${URL0}/`, redirect_uri: `${URL0}/?auth_callback=1` }) });

async function wsConnect(tok) {
  const ws = new WebSocket(URL0.replace('http', 'ws') + '/api/websocket');
  let id = 1;
  const pend = new Map();
  const subs = new Map();
  await new Promise((res, rej) => {
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: tok }));
      else if (d.type === 'auth_ok') res();
      else if (d.type === 'auth_invalid') rej(new Error('auth'));
      else if (d.type === 'result') { const p = pend.get(d.id); pend.delete(d.id); d.success ? p?.res(d.result) : p?.rej(new Error(d.error?.code + ': ' + d.error?.message)); }
      else if (d.type === 'event') subs.get(d.id)?.(d.event);
    };
  });
  return {
    call: (msg) => new Promise((res, rej) => { const i = id++; pend.set(i, { res, rej }); ws.send(JSON.stringify({ ...msg, id: i })); }),
    sub: (msg, cb) => new Promise((res, rej) => { const i = id++; subs.set(i, cb); pend.set(i, { res, rej }); ws.send(JSON.stringify({ ...msg, id: i })); }),
    close: () => ws.close(),
  };
}

const ws = await wsConnect(token);
const setState = (e, state) => j(`/api/states/${e}`, { method: 'POST', headers: H, body: JSON.stringify({ state, attributes: {} }) });
const calls = async (clear = false) => ws.call({ type: 'fp_fake/calls', clear });

// 1) set up (config flow, nothing to fill in)
let info = await ws.call({ type: 'floorplan_card/info' }).catch(() => undefined);
if (!info?.loaded) {
  const flow = await j('/api/config/config_entries/flow', { method: 'POST', headers: H, body: JSON.stringify({ handler: 'roomwise' }) });
  ok(flow.status === 200, `config flow starts (${flow.status} ${flow.body.type})`);
  if (flow.body.type === 'form') {
    const done = await j(`/api/config/config_entries/flow/${flow.body.flow_id}`, { method: 'POST', headers: H, body: '{}' });
    ok(done.body.type === 'create_entry', `one click: entry created (${done.body.type})`);
  }
  await sleep(1500);
  info = await ws.call({ type: 'floorplan_card/info' }).catch((e) => ({ err: String(e) }));
}
ok(info?.loaded, `companion loaded (${JSON.stringify(info)})`);
const again = await j('/api/config/config_entries/flow', { method: 'POST', headers: H, body: JSON.stringify({ handler: 'roomwise' }) });
ok(again.body.type === 'abort', `only once (${again.body.type} ${again.body.reason})`);

// 2) the card is served and loaded on every dashboard
const loader = await j('/floorplan_card_loader.js');
ok(loader.status === 200 && /import\("\/floorplan_card_files\/floorplan-card\.js\?v=/.test(loader.body), `loader: ${String(loader.body).trim()}`);
const jsUrl = String(loader.body).match(/"([^"]+)"/)?.[1];
const js = await fetch(URL0 + jsUrl);
ok(js.status === 200 && Number(js.headers.get('content-length') ?? (await js.clone().arrayBuffer()).byteLength) > 100000, `card script served (${js.status})`);
const model = await fetch(URL0 + '/floorplan_card_files/models/dog-shiba.glb');
ok(model.status === 200, `3D models served (${model.status})`);
const page = await (await fetch(URL0 + '/')).text();
ok(page.includes('/floorplan_card_loader.js'), 'every dashboard page loads the card (extra module)');

// 3) front door warning (a warning kept from the last run is taken back first)
await ws.call({ type: 'floorplan_card/entry_alert/remove', card_id: 'fp_keep' });
await ws.call({ type: 'floorplan_card/entry_alert/remove', card_id: 'fp_e2e' });
await setState('binary_sensor.fp_door', 'off');
await setState('binary_sensor.fp_w0', 'on');
await setState('binary_sensor.fp_w1', 'on');
await setState('binary_sensor.fp_w2', 'off');
await setState('event.fp_ack', '2026-01-01T00:00:00');
// speaker and TTS engine exist in a real installation
await setState('tts.fake', 'unknown');
await setState('media_player.fake', 'idle');
const cfg = {
  door: 'binary_sensor.fp_door',
  windows: [{ e: 'binary_sensor.fp_w1', n: 'Küche Fenster' }, { e: 'binary_sensor.fp_w0', n: 'Bad Fenster' }, { e: 'binary_sensor.fp_w2', n: 'Flur Fenster' }],
  ack_entity: 'event.fp_ack', timeout: 2, mode: 'sequential', tts_entity: 'tts.fake', media_player: 'media_player.fake', language: 'de',
  texts: { general: 'Achtung, es sind noch Fenster offen.', all: 'Noch offen: {fenster}.', single: '{fenster} ist noch offen.' }, and: ' und ',
  flash_color: ['light.fp_a'], flash_plain: ['light.fp_b'],
};
await ws.call({ type: 'floorplan_card/entry_alert/set', card_id: 'fp_test', config: cfg });
info = await ws.call({ type: 'floorplan_card/info' });
ok(info.entry_alert.includes('fp_test'), 'warning handed to the server');
await calls(true);
await setState('binary_sensor.fp_door', 'on');
await sleep(800);
let c = await calls();
ok(c.some((x) => x.domain === 'scene' && x.service === 'create' && JSON.stringify(x.data.snapshot_entities) === '["light.fp_a","light.fp_b"]'), 'lights remembered (scene snapshot)');
ok(!c.some((x) => x.domain === 'tts'), 'no announcement before the timeout');
await sleep(4200);
c = await calls();
const red = c.filter((x) => x.service === 'turn_on' && x.domain === 'light' && JSON.stringify(x.data.rgb_color) === '[255,0,0]');
ok(red.length === 3, `3× red (${red.length})`);
ok(c.filter((x) => x.domain === 'light' && x.service === 'turn_off').length === 3, '3× off');
ok(c.some((x) => x.domain === 'scene' && x.service === 'turn_on'), 'lights restored afterwards');
let tts = c.filter((x) => x.domain === 'tts');
if (!tts.length) console.log('    calls:', JSON.stringify(c.map((x) => x.domain + '.' + x.service)));
ok(tts.length === 1 && tts[0].data.message === 'Küche Fenster ist noch offen.' && tts[0].data.media_player_entity_id === 'media_player.fake' && tts[0].data.language === 'de', `after the timeout: first window in checking order (${JSON.stringify(tts[0]?.data)})`);
await setState('binary_sensor.fp_w1', 'off');
await sleep(500);
tts = (await calls()).filter((x) => x.domain === 'tts');
ok(tts.length === 2 && tts[1].data.message === 'Bad Fenster ist noch offen.', `closed → next window (${tts[1]?.data.message})`);
// the switch acknowledges
await setState('event.fp_ack', '2026-01-01T00:00:05');
await sleep(400);
await setState('binary_sensor.fp_w1', 'on');
await setState('binary_sensor.fp_w1', 'off');
await sleep(400);
ok((await calls()).filter((x) => x.domain === 'tts').length === 2, 'acknowledged by the switch: silent');

// "all" mode, acknowledged by a tablet tap before the timeout
await ws.call({ type: 'floorplan_card/entry_alert/set', card_id: 'fp_test', config: { ...cfg, mode: 'all', flash_color: [], flash_plain: [] } });
await calls(true);
await setState('binary_sensor.fp_w1', 'on');
await setState('binary_sensor.fp_door', 'off');
await setState('binary_sensor.fp_door', 'on');
await sleep(300);
const ack = await ws.call({ type: 'floorplan_card/entry_alert/ack', card_id: 'fp_test' });
await sleep(2500);
ok(ack.acknowledged && !(await calls()).some((x) => x.domain === 'tts'), 'tablet tap acknowledges: silent');
await setState('binary_sensor.fp_door', 'off');
await setState('binary_sensor.fp_door', 'on');
await sleep(2600);
tts = (await calls()).filter((x) => x.domain === 'tts');
ok(tts.length === 1 && tts[0].data.message === 'Noch offen: Küche Fenster und Bad Fenster.', `not acknowledged: all at once (${tts[0]?.data.message})`);
// all windows closed → ends by itself
await setState('binary_sensor.fp_door', 'off');
await calls(true);
await setState('binary_sensor.fp_door', 'on');
await setState('binary_sensor.fp_w0', 'off');
await setState('binary_sensor.fp_w1', 'off');
await sleep(2600);
ok(!(await calls()).some((x) => x.domain === 'tts'), 'windows closed in time: silent');
// unavailable → on is no door opening
await setState('binary_sensor.fp_w0', 'on');
await setState('binary_sensor.fp_door', 'unavailable');
await setState('binary_sensor.fp_door', 'on');
await sleep(2600);
ok(!(await calls()).some((x) => x.domain === 'tts'), 'unavailable → on (restart) is no alarm');

// 4) walks shared by every device
const pushed = [];
await ws.sub({ type: 'floorplan_card/walks/subscribe', card_id: 'fp_test' }, (e) => pushed.push(e));
await ws.call({ type: 'floorplan_card/walks/done', card_id: 'fp_test', pet_id: 'dog1', slot: '07:00' });
await sleep(300);
ok(pushed.length >= 2 && pushed[pushed.length - 1].dog1?.includes('07:00'), `check-off pushed to all cards (${JSON.stringify(pushed)})`);
const w = await ws.call({ type: 'floorplan_card/walks', card_id: 'fp_test' });
ok(w.dog1?.includes('07:00'), 'check-off stored');

// 4b) every tablet sees the same warning: state pushed by the server
const states = [];
await ws.call({ type: 'floorplan_card/entry_alert/set', card_id: 'fp_test', config: { ...cfg, mode: 'all', timeout: 8, flash_color: [], flash_plain: [] } });
await ws.sub({ type: 'floorplan_card/entry_alert/subscribe', card_id: 'fp_test' }, (e) => states.push(e));
await setState('binary_sensor.fp_w1', 'on');
await setState('binary_sensor.fp_door', 'off');
await setState('binary_sensor.fp_door', 'on');
await sleep(500);
let last = states[states.length - 1];
ok(last?.active && last.phase === 'alarm' && last.windows.includes('binary_sensor.fp_w1') && last.deadline > Date.now(), `pushed: alarm, open windows, announcement time (${JSON.stringify(last)})`);
await ws.call({ type: 'floorplan_card/entry_alert/ack', card_id: 'fp_test' });
await sleep(300);
last = states[states.length - 1];
ok(last?.active && last.phase === 'linger', `acknowledged on one tablet → all tablets: windows stay marked (${last?.phase})`);
await sleep(5500);
last = states[states.length - 1];
ok(last && !last.active, 'then the warning ends everywhere');

// 4c) walks on the server: due state for every card, reminders by person and zone, "Done" on the phone
const now = new Date();
// walk times are in the test instance's time zone
const hhmm = (d) => new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
const slot = hhmm(new Date(now.getTime() - 2 * 60000));
await setState('person.alex', 'home');
await setState('person.sam', 'Arbeit');
await setState('device_tracker.fp_dog', 'home');
const targets = [{ person: 'person.alex', service: 'notify.fake_alex' }, { person: 'person.sam', service: 'notify.fake_sam' }];
await calls(true);
const petStates = [];
await ws.sub({ type: 'floorplan_card/pets/subscribe', card_id: 'fp_test' }, (e) => petStates.push(e));
await ws.call({ type: 'floorplan_card/pets/set', card_id: 'fp_test', sig: 't1', pets: [
  { id: 'dog1', name: 'Bruno', walks: [slot], presence: 'device_tracker.fp_dog', remind: { after: 0, text: '{name} muss raus! (Gassi um {zeit})', done_label: 'Erledigt', notify: { targets, zone: 'zone.home', fallback: 'all' } } },
  { id: 'dog2', name: 'Bello', walks: [slot], remind: { after: 0, notify: { targets, zone: 'zone.arbeit' } } },
  { id: 'dog3', name: 'Luna', walks: [slot], remind: { after: 30, notify: { targets } } },
] });
await sleep(1500);
const ps = petStates[petStates.length - 1] ?? {};
ok(ps.dog1?.mode === 'due' && ps.dog1.slot === slot, `server: Bruno's walk at ${slot} is due (${JSON.stringify(ps.dog1)})`);
info = await ws.call({ type: 'floorplan_card/info' });
ok(info.pets?.fp_test === 't1', 'cards can see which version of the dogs the server has');
let n = (await calls()).filter((x) => x.domain === 'notify');
const to = (svc) => n.filter((x) => x.service === svc && x.data.message !== 'clear_notification');
ok(to('fake_alex').some((x) => x.data.message === 'Bruno muss raus! (Gassi um ' + slot + ')' && x.data.data.actions[0].title === 'Erledigt'), 'zone home: Alex (at home) gets "Bruno muss raus!" with a Done button');
ok(!to('fake_sam').some((x) => x.data.message.startsWith('Bruno')), 'zone home: Sam (at work) does not');
ok(to('fake_sam').some((x) => x.data.message.startsWith('Bello')) && !to('fake_alex').some((x) => x.data.message.startsWith('Bello')), 'zone "Arbeit": only Sam');
ok(!n.some((x) => x.data.message.startsWith('Luna')), 'first reminder after 30 min: not yet');
// nobody at home → everybody (fallback)
await calls(true);
await setState('person.alex', 'not_home');
await ws.call({ type: 'floorplan_card/pets/set', card_id: 'fp_test', sig: 't2', pets: [
  { id: 'dog4', name: 'Rex', walks: [slot], remind: { after: 0, notify: { targets, zone: 'zone.home', fallback: 'all' } } },
  { id: 'dog5', name: 'Kira', walks: [slot], remind: { after: 0, notify: { targets, zone: 'zone.home', fallback: 'none' } } },
  { id: 'dog1', name: 'Bruno', walks: [slot], presence: 'device_tracker.fp_dog', remind: { after: 0, notify: { targets, zone: 'zone.home' } } },
] });
await sleep(1500);
n = (await calls()).filter((x) => x.domain === 'notify');
ok(to('fake_alex').some((x) => x.data.message.startsWith('Rex')) && to('fake_sam').some((x) => x.data.message.startsWith('Rex')), 'nobody in the zone → everybody gets it');
ok(!n.some((x) => x.data.message.startsWith('Kira')), 'nobody in the zone, fallback off → nobody');
ok(!n.some((x) => x.data.message.startsWith('Bruno')), 'Bruno was reminded already: no second message (no repeat set)');
// ticks: no Done button, important
await calls(true);
await ws.call({ type: 'floorplan_card/pets/set', card_id: 'fp_test', sig: 't3', pets: [
  { id: 'dog6', name: 'Max', walks: [slot], remind: { after: 0, title: 'Max', text: 'Max muss raus! (Gassi um {zeit})', done_button: false, important: true, notify: { targets: [{ service: 'notify.fake_alex' }] } } },
  { id: 'dog1', name: 'Bruno', walks: [slot], presence: 'device_tracker.fp_dog', remind: { after: 0, notify: { targets, zone: 'zone.home' } } },
] });
await sleep(1500);
const mx = (await calls()).find((x) => x.domain === 'notify' && x.data.title === 'Max');
ok(mx && mx.data.message === `Max muss raus! (Gassi um ${slot})` && !mx.data.data.actions && mx.data.data.push?.['interruption-level'] === 'time-sensitive' && mx.data.data.priority === 'high', `ticks: plain title/text, no Done button, important (${JSON.stringify(mx?.data)})`);
// "Done" pressed on the phone
await calls(true);
await j('/api/events/mobile_app_notification_action', { method: 'POST', headers: H, body: JSON.stringify({ action: `FP_WALK|fp_test|dog1|${slot}` }) });
await sleep(1200);
const ps2 = petStates[petStates.length - 1] ?? {};
ok(ps2.dog1?.mode === 'idle' && ps2.dog1.done.includes(slot), `"Done" on the phone → checked off for every card (${JSON.stringify(ps2.dog1)})`);
n = (await calls()).filter((x) => x.domain === 'notify');
ok(n.some((x) => x.service === 'fake_alex' && x.data.message === 'clear_notification' && x.data.data.tag === 'fp-walk-fp_test-dog1'), 'the reminder disappears from the phones');
// the dog is out → state "away"
await setState('device_tracker.fp_dog', 'not_home');
await sleep(800);
ok((petStates[petStates.length - 1] ?? {}).dog1?.mode === 'away', 'presence away → out for a walk');
await setState('device_tracker.fp_dog', 'home');
await ws.call({ type: 'floorplan_card/pets/set', card_id: 'fp_test', sig: '', pets: [] });

// 5) non-admin cannot change the warning (checked by HA: require_admin) — remove works for admin
await ws.call({ type: 'floorplan_card/entry_alert/remove', card_id: 'fp_test' });
info = await ws.call({ type: 'floorplan_card/info' });
ok(!info.entry_alert.includes('fp_test'), 'warning taken back');
await ws.call({ type: 'floorplan_card/entry_alert/set', card_id: 'fp_keep', config: cfg });
ws.close();
console.log('done');
process.exit(0); // an open subscription must not keep the run waiting
