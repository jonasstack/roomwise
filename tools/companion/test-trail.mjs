// Trail of the current clean, on the isolated test Home Assistant (never the real one): the server records the
// run's path, a reloaded page shows it at once, it survives a restart of Home Assistant, it goes when docked.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
const U = process.argv[2] ?? 'http://127.0.0.1:8124';
const token = readFileSync(new URL('../.cache/companion-test-token', import.meta.url), 'utf8').trim();
const ok = (c, m) => console.log(c ? '  ok:' : '• FAIL:', m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const setState = (e, state) => fetch(`${U}/api/states/${e}`, { method: 'POST', headers: H, body: JSON.stringify({ state, attributes: {} }) });
let ws;
let id = 1;
const pend = new Map();
const connect = async () => {
  ws = new WebSocket(U.replace('http', 'ws') + '/api/websocket');
  await new Promise((res) => { ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: token })); else if (d.type === 'auth_ok') res(); else if (d.type === 'result') pend.get(d.id)?.(d); }; });
};
const call = (msg) => new Promise((res) => { const i = id++; pend.set(i, res); ws.send(JSON.stringify({ ...msg, id: i })); });
await connect();
await setState('vacuum.fake', 'docked');
const card = {
  type: 'custom:floorplan-card', card_id: 'fp_vac', view_mode: '3d',
  floors: [{ id: 'f1', name: 'EG', devices: [], openings: [], rooms: [{ id: 'r1', name: 'Wohnzimmer', points: [[0, 0], [400, 0], [400, 300], [0, 300]] }],
    furniture: [{ id: 'vac', kind: 'robot_vacuum', x: 30, y: 270, w: 35, h: 35, entity: 'vacuum.fake', vacuum: { transform: { x: -2500, y: 2800, rot: 0, scale: 0.1, mirror: true } } }] }],
};
await call({ type: 'lovelace/config/save', url_path: 'fp-test', config: { views: [{ title: 'Plan', path: 'plan', panel: true, cards: [card] }] } });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
await ctx.addInitScript(([u, t]) => localStorage.setItem('hassTokens', JSON.stringify({ hassUrl: u, clientId: u + '/', access_token: t, refresh_token: '', expires_in: 1e9, expires: Date.now() + 1e12 })), [U, token]);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const open = async () => { await page.goto(U + '/fp-test/plan', { waitUntil: 'networkidle' }); await page.waitForSelector('floorplan-card', { state: 'attached', timeout: 60000 }); await page.waitForTimeout(4000); };
const FIND = `const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } };`;
const C = (e) => page.evaluate(`(async () => { ${FIND} const card = find(document); const plan = card.shadowRoot.querySelector('fp-plan'); const gl = plan.gl; return ${e}; })()`);
const trail = () => C(`(() => { const v = gl.vacs.get('vac'); return v ? { n: v.trail.pts.length, vis: !!v.trail.mesh?.visible } : null; })()`);
await open();
await setState('vacuum.fake', 'cleaning');
await sleep(12000);
const p1 = (await call({ type: 'floorplan_card/vacuums/path', entity: 'vacuum.fake' })).result;
ok(p1?.pts?.length >= 3 && p1.run >= 1, `server records the run (${p1?.pts?.length} points, run ${p1?.run})`);
let t1 = await trail();
ok(t1?.n > 0 && t1.vis, `card shows the trail (${t1?.n} points)`);
// a reloaded page: the trail is back at once (from the server)
await open();
t1 = await trail();
ok(t1?.n >= p1.pts.length - 2 && t1.vis, `after reloading the page the trail is there (${t1?.n} points)`);
// Home Assistant restarts in the middle of the clean: the path is kept
await sleep(6000); // the store saves after 5 s
const before = (await call({ type: 'floorplan_card/vacuums/path', entity: 'vacuum.fake' })).result;
execSync(`docker restart ${process.env.TEST_HA_CONTAINER ?? 'fp-test-ha'}`);
// until Home Assistant has fully started (the frontend waits for that, too)
for (let i = 0; i < 90; i++) { try { const r = await fetch(U + '/api/config', { headers: H }); if (r.status === 200 && (await r.json()).state === 'RUNNING') break; } catch {} await sleep(2000); }
await sleep(3000);
await connect();
await setState('vacuum.fake', 'cleaning'); // a REST state is not restored by a restart
await sleep(3000);
const after = (await call({ type: 'floorplan_card/vacuums/path', entity: 'vacuum.fake' })).result;
ok(after?.run === before?.run && after.pts.length >= before.pts.length - 1, `after a restart of Home Assistant the run's path is still there (${before?.pts.length} → ${after?.pts?.length} points, run ${after?.run})`);
await open();
t1 = await trail();
ok(t1?.n >= before.pts.length - 2 && t1.vis, `and the page shows it (${t1?.n} points)`);
// docked: the trail goes, the next clean starts empty
await setState('vacuum.fake', 'docked');
await sleep(2500);
t1 = await trail();
ok(t1?.n === 0 && !t1.vis, 'docked: trail gone');
await setState('vacuum.fake', 'cleaning');
await sleep(1500);
const p3 = (await call({ type: 'floorplan_card/vacuums/path', entity: 'vacuum.fake' })).result;
ok(p3.run === after.run + 1 && p3.pts.length <= 2, `next clean: new run, empty path (run ${p3.run}, ${p3.pts.length} points)`);
await setState('vacuum.fake', 'docked');
console.log(errors.length ? errors.join('\n') : 'page: no errors');
await browser.close();
ws.close();
