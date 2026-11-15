// End to end on the isolated test Home Assistant (never the real one): the card comes from the companion
// integration (no resource added), the editor hands the front door warning to the server, a tap on the
// tablet acknowledges it there, walk check-offs reach other devices.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const U = process.argv[2] ?? 'http://127.0.0.1:8124';
const token = readFileSync(new URL('../.cache/companion-test-token', import.meta.url), 'utf8').trim();
const ok = (c, m) => console.log(c ? '  ok:' : '• FAIL:', m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const setState = (e, state) => fetch(`${U}/api/states/${e}`, { method: 'POST', headers: H, body: JSON.stringify({ state, attributes: {} }) });
const ws = new WebSocket(U.replace('http', 'ws') + '/api/websocket'); let id = 1; const pend = new Map();
await new Promise((res) => { ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: token })); else if (d.type === 'auth_ok') res(); else if (d.type === 'result') pend.get(d.id)?.(d); }; });
const call = (msg) => new Promise((res) => { const i = id++; pend.set(i, res); ws.send(JSON.stringify({ ...msg, id: i })); });

for (const [e, s] of [['binary_sensor.fp_door', 'off'], ['binary_sensor.fp_w0', 'on'], ['tts.fake', 'unknown'], ['media_player.fake', 'idle'], ['event.fp_ack', '2026-01-01T00:00:00']]) await setState(e, s);
await call({ type: 'floorplan_card/entry_alert/remove', card_id: 'fp_keep' });
await call({ type: 'floorplan_card/walks/undo', card_id: 'fp_e2e', pet_id: 'dog1', slot: '00:00' });
const dashboards = (await call({ type: 'lovelace/dashboards/list' })).result;
if (!dashboards.some((d) => d.url_path === 'fp-test')) await call({ type: 'lovelace/dashboards/create', url_path: 'fp-test', title: 'FP', mode: 'storage', require_admin: false, show_in_sidebar: true });
const card = {
  type: 'custom:floorplan-card', card_id: 'fp_e2e', view_mode: '2d',
  floors: [{ id: 'f1', name: 'EG', devices: [], rooms: [{ id: 'r1', name: 'Wohnzimmer', points: [[0, 0], [400, 0], [400, 300], [0, 300]] }],
    openings: [{ id: 'o_door', type: 'door', a: [150, 300], b: [240, 300], entity: 'binary_sensor.fp_door' }, { id: 'o_w0', type: 'window', a: [0, 100], b: [0, 200], entity: 'binary_sensor.fp_w0' }],
    furniture: [{ id: 'dog1', kind: 'dog', variant: 'maltipoo', x: 200, y: 150, w: 40, h: 18, name: 'Bello', pet: { walks: ['00:00'] } }] }],
  entry_alert: { door: 'o_door', timeout: 3, mode: 'general', tts_entity: 'tts.fake', media_player: 'media_player.fake', tts_language: 'de', ack_entity: 'event.fp_ack' },
};
await call({ type: 'lovelace/config/save', url_path: 'fp-test', config: { views: [{ title: 'Plan', path: 'plan', panel: true, cards: [card] }] } });

const browser = await chromium.launch();
const mk = async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  await ctx.addInitScript(([u, t]) => localStorage.setItem('hassTokens', JSON.stringify({ hassUrl: u, clientId: u + '/', access_token: t, refresh_token: '', expires_in: 1e9, expires: Date.now() + 1e12 })), [U, token]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror ' + e.message + ' ' + String(e.stack ?? '').slice(0, 300)));
  page.on('console', async (m) => { if (m.type() !== 'error' || /404|Failed to load resource|service worker/i.test(m.text())) return; const v = await Promise.all(m.args().map((a) => a.jsonValue().catch(() => '?'))); errors.push(m.text() + ' ' + JSON.stringify(v).slice(0, 300) + ' @' + (m.location()?.url ?? '')); });
  await page.goto(U + '/fp-test/plan', { waitUntil: 'networkidle' });
  await page.waitForSelector('floorplan-card', { timeout: 20000 });
  await page.waitForTimeout(2500);
  return { page, errors };
};
const FIND = `const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } };`;
const A = await mk();
const cardOf = (p, e) => p.evaluate(`(async () => { ${FIND} const card = find(document); return ${e}; })()`);
const resources = (await call({ type: 'lovelace/resources' })).result;
ok(!resources.length && (await cardOf(A.page, `!!card?.shadowRoot?.querySelector('fp-plan')`)), `card loaded by the integration alone (resources: ${resources.length})`);
// editor: switch the warning to the server and save
await A.page.getByRole('button', { name: /floor plan|Grundriss bearbeiten/i }).click();
await A.page.waitForTimeout(1200);
const saved = await A.page.evaluate(`(async () => { const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD-EDITOR-UI') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } }; const ed = find(document);
  ed.mutate((x) => { x.entry_alert = { ...x.entry_alert, server: true }; }); await ed.save(); return true; })()`);
await sleep(1500);
const info = (await call({ type: 'floorplan_card/info' })).result;
ok(saved && info.entry_alert.includes('fp_e2e'), `editor → server took the warning (${JSON.stringify(info.entry_alert)})`);
const stored = (await call({ type: 'lovelace/config', url_path: 'fp-test' })).result.views[0].cards[0];
ok(stored.entry_alert.server === true, 'card config: server: true');
await A.page.reload({ waitUntil: 'networkidle' }); await A.page.waitForTimeout(3000);
// door opens, nobody acknowledges → the server speaks (the card does not)
await call({ type: 'fp_fake/calls', clear: true });
await setState('binary_sensor.fp_door', 'on');
await sleep(800);
ok(await cardOf(A.page, `!!card.shadowRoot.querySelector('.entry-alert')`), 'the card shows the warning');
await sleep(3000);
let c = (await call({ type: 'fp_fake/calls' })).result.filter((x) => x.domain === 'tts');
ok(c.length === 1, `spoken once — by the server, not also by the card (${c.length})`);
// next time: a tap on the tablet acknowledges on the server
await setState('binary_sensor.fp_door', 'off');
await call({ type: 'fp_fake/calls', clear: true });
await setState('binary_sensor.fp_door', 'on');
await sleep(700);
await A.page.mouse.click(640, 420);
await sleep(3200);
c = (await call({ type: 'fp_fake/calls' })).result.filter((x) => x.domain === 'tts');
ok(c.length === 0 && !(await cardOf(A.page, `!!card.shadowRoot.querySelector('.entry-alert')`)), `tap on the tablet: off everywhere, nothing spoken (${c.length})`);
// walks: checked off on one device → the other device knows
const B = await mk();
const dueA = await cardOf(A.page, `card.pets.states.get('dog1')?.mode`);
await cardOf(A.page, `(card.gesture({ kind: 'furniture', id: 'dog1' }, 'tap'), true)`);
await sleep(1500);
const dueB = await cardOf(B.page, `card.pets.states.get('dog1')?.mode`);
ok(dueA === 'due' && dueB === 'idle', `walk checked off on device A → device B (${dueA} → ${dueB})`);
// two tablets: the warning is the same on both; a tap on A ends it on B too
await setState('binary_sensor.fp_door', 'off');
await sleep(300);
await setState('binary_sensor.fp_door', 'on');
await sleep(1200);
const onA = await cardOf(A.page, `card.entryAlert.state.active && card.entryAlert.state.phase`);
const onB = await cardOf(B.page, `card.entryAlert.state.active && card.entryAlert.state.phase`);
ok(onA === 'alarm' && onB === 'alarm', `both tablets show the warning (${onA}, ${onB})`);
await A.page.mouse.click(640, 420);
await sleep(1200);
const bAfter = await cardOf(B.page, `card.entryAlert.state.phase ?? 'off'`);
ok(bAfter === 'linger', `tap on tablet A → tablet B: acknowledged, windows still marked (${bAfter})`);
await sleep(5500);
ok(!(await cardOf(B.page, `card.entryAlert.state.active`)), 'and then off on tablet B as well');
// the dogs' walk state comes from the server
const fromServer = await cardOf(B.page, `card.pets.serverStates.size`);
ok(fromServer >= 1, `walk state from the server on the cards (${fromServer} dog)`);
console.log([...A.errors, ...B.errors].join('\n') || 'console: no errors');
await browser.close();
ws.close();
