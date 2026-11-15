// Live vacuum on the isolated test Home Assistant (never the real one): a fake Roborock drives lanes through a
// 4 x 3 m room; the server follows and learns it, the editor aligns its map automatically, the card shows it
// driving — delayed and live — always inside the room.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
const U = process.argv[2] ?? 'http://127.0.0.1:8124';
const out = process.argv[3] ?? '/tmp';
const token = readFileSync(new URL('../.cache/companion-test-token', import.meta.url), 'utf8').trim();
const ok = (c, m) => console.log(c ? '  ok:' : '• FAIL:', m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const setState = (e, state) => fetch(`${U}/api/states/${e}`, { method: 'POST', headers: H, body: JSON.stringify({ state, attributes: {} }) });
const ws = new WebSocket(U.replace('http', 'ws') + '/api/websocket'); let id = 1; const pend = new Map();
await new Promise((res) => { ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: token })); else if (d.type === 'auth_ok') res(); else if (d.type === 'result') pend.get(d.id)?.(d); }; });
const call = (msg) => new Promise((res) => { const i = id++; pend.set(i, res); ws.send(JSON.stringify({ ...msg, id: i })); });

await setState('vacuum.fake', 'docked');
await call({ type: 'floorplan_card/vacuums/reset', entity: 'vacuum.fake' });
await call({ type: 'execute_script', sequence: [{ action: 'roborock.get_vacuum_current_position', target: { entity_id: 'vacuum.fake' }, response_variable: 'r' }] });
// plan: one room 400 x 300 cm; robot map: x 25000..29000, y mirrored (28000 at the top) — the card must find that
const card = {
  type: 'custom:floorplan-card', card_id: 'fp_vac', view_mode: '3d',
  floors: [{ id: 'f1', name: 'EG', devices: [], openings: [], rooms: [{ id: 'r1', name: 'Wohnzimmer', points: [[0, 0], [400, 0], [400, 300], [0, 300]] }],
    furniture: [{ id: 'vac', kind: 'robot_vacuum', x: 30, y: 270, w: 35, h: 35, entity: 'vacuum.fake' }, { id: 'dock', kind: 'robot_dock', x: 15, y: 285, w: 30, h: 30 }] }],
};
await call({ type: 'lovelace/config/save', url_path: 'fp-test', config: { views: [{ title: 'Plan', path: 'plan', panel: true, cards: [card] }] } });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
await ctx.addInitScript(([u, t]) => localStorage.setItem('hassTokens', JSON.stringify({ hassUrl: u, clientId: u + '/', access_token: t, refresh_token: '', expires_in: 1e9, expires: Date.now() + 1e12 })), [U, token]);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const open = async () => { await page.goto(U + '/fp-test/plan', { waitUntil: 'networkidle' }); await page.waitForSelector('floorplan-card', { state: 'attached', timeout: 60000 }); await page.waitForTimeout(3000); };
await open();
const FIND = `const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } };`;
const C = (e) => page.evaluate(`(async () => { ${FIND} const card = find(document); const plan = card.shadowRoot.querySelector('fp-plan'); const gl = plan.glScene; return ${e}; })()`);
let info = (await call({ type: 'floorplan_card/info' })).result;
ok(info.vacuums?.fp_vac !== undefined, `the card handed its vacuum to the server (${JSON.stringify(info.vacuums)})`);
// clean: the server follows and learns
await setState('vacuum.fake', 'cleaning');
await sleep(70000);
await setState('vacuum.fake', 'docked');
await sleep(2500);
const learned = (await call({ type: 'floorplan_card/vacuums/learned', entity: 'vacuum.fake' })).result;
writeFileSync(`${out}/vac-learned.json`, JSON.stringify(learned)); // to replay the alignment offline
ok(learned.cells.length > 300, `learned the floor it drove over: ${learned.cells.length} cells, speed ${learned.speed} mm/s, dock ${JSON.stringify(learned.dock)}`);
// automatic alignment (the editor's function, run in the page)
execSync(`npx esbuild src/vacuum-live.ts --bundle --format=iife --global-name=FPVL --outfile=${out}/fpvl.js --log-level=error`);
await page.addScriptTag({ content: readFileSync(`${out}/fpvl.js`, 'utf8') });
const tf = await page.evaluate(([floor, l]) => window.FPVL.autoFit(floor, l, [15, 285]), [card.floors[0], learned]);
const chk = await page.evaluate(([tf]) => [window.FPVL.toPlan(tf, 25200, 25200), window.FPVL.toPlan(tf, 28800, 27800)], [tf]);
// expected: robot (25200, 25200) → plan (20, 280); robot (28800, 27800) → plan (380, 20)
const err = Math.max(Math.hypot(chk[0][0] - 20, chk[0][1] - 280), Math.hypot(chk[1][0] - 380, chk[1][1] - 20));
// the learned floor is only where its middle went, read every 2 s (corners cut): replayed offline over many start
// phases the fit lands 5–36 cm off, a wrong turn or mirror would be metres
ok(err < 40, `automatic alignment: robot map laid onto the plan within ${err.toFixed(0)} cm (${JSON.stringify(tf)})`);
// drive with that alignment — delayed (default)
const run = async (mode) => {
  const c2 = JSON.parse(JSON.stringify(card));
  c2.floors[0].furniture[0].vacuum = { transform: tf, ...(mode === 'live' ? { mode } : {}) };
  await call({ type: 'lovelace/config/save', url_path: 'fp-test', config: { views: [{ title: 'Plan', path: 'plan', panel: true, cards: [c2] }] } });
  await open();
  await setState('vacuum.fake', 'cleaning');
  // every frame the scene draws: where it showed the vacuum and when, recorded in the page (a look from outside
  // takes a while on software WebGL and can make two honest frames look like a jump)
  const REC = `const g = gl.petGroup.children.find((c) => c.userData.id === 'vac'); if (g && !g.userData.rec) { const anim = g.userData.anim; g.userData.rec = true;
    g.userData.anim = (now) => { const r = anim(now); if (g.visible) (window.__vacFrames ??= []).push([g.position.x, g.position.y, performance.now()]); return r; }; } return !!g;`;
  await C(`(() => { window.__vacFrames = []; ${REC} })()`);
  for (let i = 0; i < 24; i++) {
    await page.waitForTimeout(500);
    await C(`(() => { ${REC} })()`); // the scene may build (or rebuild) its vacuum a moment later
  }
  const pts = await page.evaluate(() => window.__vacFrames ?? []);
  await setState('vacuum.fake', 'docked');
  const inside = pts.every(([x, y]) => x >= -5 && x <= 405 && y >= -5 && y <= 305);
  const moves = pts.filter((p, i) => i && (p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1])).length;
  // speed over at least 0.2 s of shown frames (the fake drives 60 cm/s, a live guess corrects
  // itself a little faster; a jump would show as a much higher speed)
  let jumps = 0;
  for (let i = 0, j = 0; i < pts.length; i++) {
    while (j < pts.length && pts[j][2] - pts[i][2] < 200) j++;
    if (j < pts.length) jumps = Math.max(jumps, Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]) / ((pts[j][2] - pts[i][2]) / 1000));
  }
  ok(pts.length > 30 && inside, `${mode}: shown driving inside the room (${pts.length} frames, ${moves} moving)`);
  ok(jumps < 150, `${mode}: no jumps (fastest shown motion ${jumps.toFixed(0)} cm/s; the robot drives 60 cm/s)`);
  if (mode === 'delayed') await page.screenshot({ path: `${out}/vac-delayed.png` });
};
await run('delayed');
await run('live');
console.log(errors.join('\n') || 'console: no errors');
await browser.close();
ws.close();
