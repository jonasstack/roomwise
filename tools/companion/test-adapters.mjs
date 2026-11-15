// Live vacuums beyond Roborock, on the isolated test Home Assistant (never the real one). fp_fake has a Dreame-like
// robot (map camera with calibration points, attributes as Dreame Vacuum writes them) and a Valetudo-like one
// (Valetudo's "Map data" PNG) driving through a demo flat of two rooms. The companion must find each robot's map
// by itself, read position, map and path, learn the floor; the card's automatic alignment must lay both maps
// onto the plan; room cleaning must go to each robot's own integration; the card shows the robot driving and
// offers its rooms in the popup.
// Run (through the lock, with start.sh + setup.mjs before): node tools/companion/test-adapters.mjs [url] [outdir]
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
const U = process.argv[2] ?? 'http://127.0.0.1:8124';
const out = process.argv[3] ?? '/tmp';
if (!/127\.0\.0\.1:8124|localhost:8124/.test(U)) throw new Error('only against the isolated test HA on port 8124');
const token = readFileSync(new URL('../.cache/companion-test-token', import.meta.url), 'utf8').trim();
let fails = 0;
const ok = (c, m) => {
  if (!c) fails++;
  console.log(c ? '  ok:' : '• FAIL:', m);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ws = new WebSocket(U.replace('http', 'ws') + '/api/websocket');
let id = 1;
const pend = new Map();
const subs = new Map();
await new Promise((res) => {
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: token }));
    else if (d.type === 'auth_ok') res();
    else if (d.type === 'result') pend.get(d.id)?.(d);
    else if (d.type === 'event') subs.get(d.id)?.(d.event);
  };
});
const call = (msg) => new Promise((res) => { const i = id++; pend.set(i, res); ws.send(JSON.stringify({ ...msg, id: i })); });
const sub = (msg, cb) => { const i = id++; subs.set(i, cb); return call0(i, msg); };
const call0 = (i, msg) => new Promise((res) => { pend.set(i, res); ws.send(JSON.stringify({ ...msg, id: i })); });
const robot = (r, state) => call({ type: 'fp_fake/vacuum', robot: r, state });

// the demo flat (plan cm) and where each robot's coordinates lie on it (see fp_fake/world.py)
const ROOMS = { Wohnzimmer: [0, 0, 400, 300], Küche: [400, 0, 700, 300] };
const toPlan = {
  dreame: ([x, y]) => [(x + 2000) / 10, (1500 - y) / 10],
  valetudo: ([x, y]) => [x / 10 - 200, y / 10 - 300],
};
const inFlat = ([x, y], m = 20) => x >= -m && x <= 700 + m && y >= -m && y <= 300 + m;
const floor = {
  id: 'f1', name: 'EG', devices: [],
  rooms: [
    { id: 'r1', name: 'Wohnzimmer', points: [[0, 0], [400, 0], [400, 300], [0, 300]] },
    { id: 'r2', name: 'Küche', points: [[400, 0], [700, 0], [700, 300], [400, 300]] },
  ],
  openings: [{ id: 'd1', type: 'door', a: [400, 100], b: [400, 190] }],
  furniture: [
    { id: 'vac_d', kind: 'robot_vacuum', x: 25, y: 275, w: 35, h: 35, entity: 'vacuum.demo_dreame' },
    { id: 'vac_v', kind: 'robot_vacuum', x: 25, y: 275, w: 35, h: 35, entity: 'vacuum.demo_valetudo' },
    { id: 'dock', kind: 'robot_dock', x: 25, y: 285, w: 30, h: 30 },
  ],
};
const VACS = [
  { key: 'dreame', id: 'vac_d', entity: 'vacuum.demo_dreame', map: 'camera.demo_dreame_map', adapter: 'map_camera' },
  { key: 'valetudo', id: 'vac_v', entity: 'vacuum.demo_valetudo', map: 'camera.demo_valetudo_map_data', adapter: 'valetudo' },
];
for (const v of VACS) {
  await robot(v.key, 'docked');
  await call({ type: 'floorplan_card/vacuums/reset', entity: v.entity });
}
await call({ type: 'floorplan_card/vacuums/set', card_id: 'fp_adapt', vacuums: VACS.map((v) => ({ id: v.id, entity: v.entity })), sig: 'test' });

// 1) which adapter, found by itself
for (const v of VACS) {
  const info = (await call({ type: 'floorplan_card/vacuums/info', entity: v.entity })).result;
  ok(info?.adapter === v.adapter && info.source === v.map, `${v.key}: adapter ${info?.adapter} with ${info?.source} (found on the robot's device)`);
  ok(info?.segments?.map((s) => s.name).join(',') === 'Wohnzimmer,Küche' && info.clean, `${v.key}: rooms of its map ${JSON.stringify(info?.segments)}, cleaning ${info?.clean}`);
  ok(info?.candidates?.[0] === v.map, `${v.key}: suggested map entities ${JSON.stringify(info?.candidates)}`);
}
const none = (await call({ type: 'floorplan_card/vacuums/info', entity: 'vacuum.nothing_here' })).result;
ok(none && none.adapter === null && !none.clean, 'a vacuum without any map: no adapter, nothing offered');
const over = (await call({ type: 'floorplan_card/vacuums/info', entity: 'vacuum.demo_dreame', map: 'camera.demo_valetudo_map_data' })).result;
ok(over?.adapter === 'valetudo' && over.source === 'camera.demo_valetudo_map_data', 'a map entity picked by hand wins');
const bad = await call({ type: 'floorplan_card/vacuums/info', entity: 'vacuum.demo_dreame', map: 'light.kitchen' });
ok(!bad.success, 'only camera / image entities can be picked as map');

// 2) the robots' own maps, robot mm: every floor point lies in its room of the plan
const maps = {};
for (const v of VACS) {
  const m = (await call({ type: 'floorplan_card/vacuums/map', entity: v.entity })).result;
  maps[v.key] = m;
  const rooms = m?.rooms ?? [];
  const wrong = rooms.flatMap((r) => r.pts.map(toPlan[v.key]).filter(([x, y]) => { const b = ROOMS[r.name]; return !b || x < b[0] - 15 || x > b[2] + 15 || y < b[1] - 15 || y > b[3] + 15; }));
  const n = rooms.reduce((s, r) => s + r.pts.length, 0);
  ok(m?.adapter === v.adapter && rooms.length === 2 && n > 1000 && wrong.length <= n * 0.02, `${v.key}: map with ${rooms.map((r) => `${r.name} ${r.pts.length}`).join(', ')} floor points, ${wrong.length} outside their room`);
  ok(m?.walls?.length > 100 && m.charger && Math.hypot(...toPlan[v.key](m.charger).map((c, i) => c - [25, 275][i])) < 10, `${v.key}: ${m?.walls?.length} wall points, dock at ${JSON.stringify(m?.charger && toPlan[v.key](m.charger))}`);
}

// 3) the editor's automatic alignment lays each map onto the plan (coordinates map → robot → plan)
execSync(`npx esbuild src/vacuum-live.ts --bundle --format=esm --platform=node --outfile=${out}/fpvl-node.mjs --log-level=error`);
const FPVL = await import(`${out}/fpvl-node.mjs?${Date.now()}`);
const tfs = {};
for (const v of VACS) {
  if (!maps[v.key]) continue;
  const tf = FPVL.autoFitMap(floor, maps[v.key], [25, 285]);
  tfs[v.key] = tf;
  const probe = v.key === 'dreame' ? [[-1500, 1000], [4500, -1000], [0, 0]] : [[2500, 3500], [8500, 5500], [4000, 4500]];
  const err = tf ? Math.max(...probe.map((p) => Math.hypot(...FPVL.toPlan(tf, p[0], p[1]).map((c, i) => c - toPlan[v.key](p)[i])))) : Infinity;
  ok(err < 25, `${v.key}: automatic alignment within ${err.toFixed(0)} cm (${JSON.stringify(tf)})`);
}

// 4) driving: positions as the integration reports them, how often, inside the flat; floor learned; path
const seen = { vac_d: [], vac_v: [] };
let last = {};
await sub({ type: 'floorplan_card/vacuums/subscribe', card_id: 'fp_adapt' }, (st) => {
  last = st ?? {};
  for (const [k, s] of Object.entries(last)) if (s.x != null && seen[k] && (!seen[k].length || seen[k].at(-1).seq !== s.seq)) seen[k].push(s);
});
await sleep(500);
for (const v of VACS) seen[v.id] = [];
for (const v of VACS) await robot(v.key, 'cleaning');
await sleep(26000);
for (const v of VACS) {
  const s = seen[v.id];
  const pts = s.map((q) => toPlan[v.key]([q.x, q.y]));
  const moving = new Set(pts.map((p) => p.map(Math.round).join(','))).size;
  ok(s.length >= 8 && moving >= 8 && pts.every((p) => inFlat(p)), `${v.key}: ${s.length} positions, ${moving} different, all inside the flat`);
  const iv = last[v.id]?.iv;
  const want = v.key === 'dreame' ? 1500 : 2000;
  ok(iv > want * 0.6 && iv < want * 1.6 && last[v.id]?.adapter === v.adapter, `${v.key}: new position every ${iv} ms (its integration: ${want} ms) — the card waits that long`);
}
const pv = (await call({ type: 'floorplan_card/vacuums/path', entity: 'vacuum.demo_valetudo' })).result;
const pd = (await call({ type: 'floorplan_card/vacuums/path', entity: 'vacuum.demo_dreame' })).result;
ok(pv?.pts?.length >= 8 && pv.pts.every((p) => inFlat(toPlan.valetudo(p))), `valetudo: trail of the run (${pv?.pts?.length} points, from its own map path)`);
ok(pd?.pts?.length >= 5 && pd.pts.every((p) => inFlat(toPlan.dreame(p))), `dreame: trail of the run (${pd?.pts?.length} points)`);
for (const v of VACS) await robot(v.key, 'docked');
await sleep(4500); // a map camera may report the dock a moment after the vacuum's state
for (const v of VACS) {
  const l = (await call({ type: 'floorplan_card/vacuums/learned', entity: v.entity })).result;
  ok(l?.cells?.length > 40 && l.runs >= 1, `${v.key}: learned ${l?.cells?.length} cells of floor, ${l?.runs} run(s), speed ${l?.speed} mm/s`);
  ok(l?.dock && Math.hypot(...toPlan[v.key](l.dock).map((c, i) => c - [25, 275][i])) < 10, `${v.key}: dock learned at ${JSON.stringify(l?.dock && toPlan[v.key](l.dock))}`);
}

// 5) room cleaning goes to each robot's own integration
await call({ type: 'fp_fake/calls', clear: true });
const cd = await call({ type: 'floorplan_card/vacuums/clean', entity: 'vacuum.demo_dreame', segments: ['2'] });
const cv = await call({ type: 'floorplan_card/vacuums/clean', entity: 'vacuum.demo_valetudo', segments: ['1', '2'] });
const calls = (await call({ type: 'fp_fake/calls' })).result;
const segCall = calls.find((c) => c.domain === 'fp_fake' && c.service === 'vacuum_clean_segment');
ok(cd.success && JSON.stringify(segCall?.data?.segments) === '[2]' && JSON.stringify(segCall?.data?.entity_id ?? '').includes('vacuum.demo_dreame'), `dreame: its own segment service (${JSON.stringify(segCall)})`);
const mq = calls.find((c) => c.domain === 'mqtt' && c.service === 'publish');
const payload = mq ? JSON.parse(mq.data.payload) : {};
ok(cv.success && mq?.data?.topic === 'valetudo/demo_robot/MapSegmentationCapability/clean/set' && JSON.stringify(payload) === JSON.stringify({ segment_ids: ['1', '2'], iterations: 1, customOrder: true }), `valetudo: MQTT ${mq?.data?.topic} ${mq?.data?.payload}`);
const cn = await call({ type: 'floorplan_card/vacuums/clean', entity: 'vacuum.nothing_here', segments: ['1'] });
ok(!cn.success && cn.error?.code === 'not_supported', `no adapter: cleaning refused (${cn.error?.code})`);
await sleep(1000);
await robot('dreame', 'docked');

// 6) the card: the Dreame-like robot drives on the plan with the found alignment; its popup offers its rooms
const card = { type: 'custom:floorplan-card', card_id: 'fp_adapt', view_mode: '3d', floors: [JSON.parse(JSON.stringify(floor))] };
card.floors[0].furniture[0].vacuum = { transform: tfs.dreame };
card.floors[0].furniture[1].vacuum = { transform: tfs.valetudo };
await call({ type: 'lovelace/config/save', url_path: 'fp-test', config: { views: [{ title: 'Plan', path: 'plan', panel: true, cards: [card] }] } });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
await ctx.addInitScript(([u, t]) => localStorage.setItem('hassTokens', JSON.stringify({ hassUrl: u, clientId: u + '/', access_token: t, refresh_token: '', expires_in: 1e9, expires: Date.now() + 1e12 })), [U, token]);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.stack ?? e.message ?? e).slice(0, 400)));
await page.goto(U + '/fp-test/plan', { waitUntil: 'networkidle' });
await page.waitForSelector('floorplan-card', { state: 'attached', timeout: 60000 });
await page.waitForTimeout(4000);
const FIND = `const find = (root, tag) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === tag) return el; if (el.shadowRoot) { const f = find(el.shadowRoot, tag); if (f) return f; } } };`;
const C = (e) => page.evaluate(`(async () => { ${FIND} const card = find(document, 'FLOORPLAN-CARD'); const plan = card.shadowRoot.querySelector('fp-plan'); const gl = plan.glScene; return ${e}; })()`);
await robot('dreame', 'cleaning');
const shown = [];
for (let i = 0; i < 48; i++) {
  await page.waitForTimeout(250);
  const p = await C(`(() => { const g = gl?.petGroup?.children.find((c) => c.userData.id === 'vac_d'); return g && g.visible ? [Math.round(g.position.x), Math.round(g.position.y), performance.now()] : null; })()`);
  if (p) shown.push(p);
}
const diag = await C(`(() => { const v = gl?.vacs?.get('vac_d'); return v ? { samples: v.live?.samples?.length, delay: v.live?.delay, last: v.live?.samples?.at(-1) } : 'no live vacuum'; })()`);
await robot('dreame', 'docked');
const moves = shown.filter((p, i) => i && (p[0] !== shown[i - 1][0] || p[1] !== shown[i - 1][1])).length;
const fastest = Math.max(0, ...shown.map((p, i) => (i ? Math.hypot(p[0] - shown[i - 1][0], p[1] - shown[i - 1][1]) / Math.max(0.05, (p[2] - shown[i - 1][2]) / 1000) : 0)));
ok(shown.length > 30 && moves > 10 && shown.every((p) => inFlat(p, 25)), `card: the Dreame-like robot drives inside the flat (${shown.length} frames, ${moves} moving; ${JSON.stringify(diag)})`);
ok(fastest < 150, `card: smooth although its map reports only every 1.5 s (fastest shown motion ${fastest.toFixed(0)} cm/s, the robot drives 60)`);
await page.screenshot({ path: `${out}/vac-adapters.png` });
await call({ type: 'fp_fake/calls', clear: true });
await C(`card.ensureLayer().openPopup({ entity: 'vacuum.demo_valetudo' })`);
await page.waitForTimeout(1500);
const chips = await page.evaluate(`(() => { ${FIND} const p = find(document, 'FP-VACUUM-POPUP'); return p ? [...p.shadowRoot.querySelectorAll('[data-room]')].map((b) => b.textContent.trim()) : null; })()`);
ok(chips?.join(',') === 'Wohnzimmer,Küche', `popup: rooms of the robot's own map ${JSON.stringify(chips)}`);
await page.evaluate(`(() => { ${FIND} const p = find(document, 'FP-VACUUM-POPUP'); p.shadowRoot.querySelector('[data-room="2"]').click(); })()`);
await page.waitForTimeout(300);
await page.evaluate(`(() => { ${FIND} const p = find(document, 'FP-VACUUM-POPUP'); p.shadowRoot.querySelector('button.clean').click(); })()`);
await page.waitForTimeout(1500);
const pc = (await call({ type: 'fp_fake/calls' })).result.find((c) => c.domain === 'mqtt');
ok(pc && JSON.parse(pc.data.payload).segment_ids.join() === '2', `popup: "1 Raum reinigen" sends Valetudo's segment cleaning (${pc?.data?.payload})`);
console.log(errors.length ? errors.join('\n') : 'page: no errors');
await browser.close();
ws.close();
console.log(fails ? `FAILED: ${fails}` : 'all ok');
process.exit(fails ? 1 : 0);
