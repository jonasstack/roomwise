// Laying a robot vacuum's map onto the plan (editor, mode "Karte auflegen") must never change the plan's rooms:
// automatic fit, moving, turning, sizing, mirroring, a room laid on its own, dragging the map, cutting out and
// "Reset" only change how the map lies on the plan. "Fit plan" (walls onto the map) is the one tool that moves walls:
// it reads each room's walls where that room's map lies, never bends a room out of shape (a bathtub's edge in the
// map must not squeeze the bathroom), and "Reset" puts the walls back.
// Mock harness, neutral demo home, a made-up map (no Home Assistant, no real vacuum).
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/vac-align.mjs [outDir]
import { openMock } from './mock.mjs';

const out = process.argv[2];
let fails = 0;
const ok = (c, m) => {
  if (!c) fails++;
  console.log(c ? '• ok:' : '• FAIL:', m);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ED = `document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui')`;

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const ROOMS = [
  { id: 'living', name: 'Wohnzimmer', points: rect(0, 0, 500, 400) },
  { id: 'bath', name: 'Bad', points: rect(500, 0, 700, 250) },
  { id: 'hall', name: 'Flur', points: rect(500, 250, 650, 400) },
];
const config = {
  type: 'custom:floorplan-card', card_id: 'align_demo', height: 'calc(100vh - 16px)', view_mode: '2d', effects: 'off',
  floors: [{ id: 'eg', name: 'Erdgeschoss', rooms: ROOMS, devices: [], openings: [{ id: 'door_bath', type: 'door', a: [560, 250], b: [640, 250] }],
    furniture: [{ id: 'vac', kind: 'robot_vacuum', x: 100, y: 350, w: 35, h: 35, entity: 'vacuum.demo_robot' }, { id: 'dock', kind: 'robot_dock', x: 40, y: 380, w: 30, h: 30 }] }],
};

// the robot's map in mm (plan cm × 10). The bathroom sits 30 cm off in the map (the robot's map drifts there):
// it was laid on its own (room fit x −30). Its outer wall is mostly hidden behind the tub, washbasin and cabinets
// (only a third of it shows as a line); the bathtub's edge, 45 cm inside, is a long straight line.
const map = { floor_res: 50, wall_res: 50, rooms: [], walls: [], charger: [400, 3800] };
const cells = (id, name, x0, y0, x1, y1, dx = 0) => {
  const pts = [];
  for (let x = x0 + 50; x < x1 - 50; x += 50) for (let y = y0 + 50; y < y1 - 50; y += 50) pts.push([x + dx, y]);
  map.rooms.push({ id, name, pts });
};
const wall = (x0, y0, x1, y1, dx = 0) => {
  const n = Math.round(Math.hypot(x1 - x0, y1 - y0) / 25);
  for (let i = 0; i <= n; i++) map.walls.push([x0 + ((x1 - x0) * i) / n + dx, y0 + ((y1 - y0) * i) / n]);
};
cells('1', 'Wohnzimmer', 0, 0, 5000, 4000);
cells('2', 'Bad', 5000, 0, 7000, 2500, 300);
cells('3', 'Flur', 5000, 2500, 6500, 4000);
for (const [x0, y0, x1, y1] of [[0, 0, 5000, 0], [0, 4000, 5000, 4000], [0, 0, 0, 4000], [5000, 2500, 5000, 4000], [6500, 2500, 6500, 4000], [5000, 4000, 6500, 4000]]) wall(x0, y0, x1, y1);
// the bathroom's walls, 30 cm off like its floor; the outer one only in part, the tub's edge in full
for (const [x0, y0, x1, y1] of [[5000, 0, 7000, 0], [5000, 2500, 7000, 2500], [5000, 0, 5000, 2500], [7000, 1500, 7000, 2300], [6550, 0, 6550, 2500]]) wall(x0, y0, x1, y1, 300);

const m = await openMock({ config, states: { 'vacuum.demo_robot': { state: 'docked', attributes: { friendly_name: 'Robot' } } }, size: '1280x900' });
const { page } = m;
await m.card(`(card.openEditor(), true)`);
await wait(1800);
const ed = (expr) => page.evaluate(`(() => { const ed = ${ED}; return ${expr}; })()`);
ok(await ed('!!ed'), 'editor open');
const plan = () => ed(`JSON.stringify(ed._draft.floors[0].rooms.map((r) => [r.id, r.points]))`);
const doors = () => ed(`JSON.stringify(ed._draft.floors[0].openings.map((o) => [o.a, o.b]))`);
const before = await plan();
const doorsBefore = await doors();
// the map as the companion would hand it over (here: injected)
await page.evaluate(`${ED}.vacMaps.set('vacuum.demo_robot', ${JSON.stringify(map)})`);
await ed(`(ed.startAlign('vac'), true)`);
await wait(800);
ok(await ed('!!ed._align'), 'alignment mode open');
const tf = await ed(`ed._draft.floors[0].furniture.find((f) => f.id === 'vac').vacuum?.transform ?? null`);
ok(!!tf, `automatic first guess (${JSON.stringify(tf)})`);
const same = async (what) => ok((await plan()) === before && (await doors()) === doorsBefore, `${what}: rooms and doors unchanged`);
await same('automatic fit');
await ed(`(ed.alignAuto(), true)`);
await wait(200);
await same('"Automatic" again');
for (const [dx, dy, rot, k] of [[2, 0, 0, 1], [0, -2, 0, 1], [0, 0, 0.5, 1], [0, 0, 0, 1.02], [0, 0, 0, 0.98]]) await ed(`(ed.nudge(${dx}, ${dy}, ${rot}, ${k}), true)`);
await same('moving, turning, sizing in steps');
await ed(`(ed.alignMirror(), ed.alignMirror(), true)`);
await same('mirroring');
// drag the map with the mouse
const box = await page.evaluate(`(() => { const r = ${ED}.shadowRoot.querySelector('fp-plan').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
await page.mouse.move(box[0], box[1]);
await page.mouse.down();
for (let i = 1; i <= 8; i++) await page.mouse.move(box[0] + i * 6, box[1] + i * 3);
await page.mouse.up();
await wait(300);
await same('dragging the map');
// the bathroom on its own: the fit that puts it back where it belongs (−30 cm)
await ed(`(ed.alignRoom('2'), true)`);
await wait(300);
await ed(`(ed.setRoomFit('2', { ...ed.roomFit('2'), x: -30 }), true)`);
for (const [dx, dy, rot, k] of [[2, 0, 0, 1], [-2, 0, 0, 1], [0, 0, 0.5, 1], [0, 0, -0.5, 1]]) await ed(`(ed.nudge(${dx}, ${dy}, ${rot}, ${k}), true)`);
await same('a room laid on its own');
await ed(`(ed.alignRoom(undefined), true)`);
await wait(200);
// from here on the whole map lies exactly (identity: plan cm = robot mm / 10)
await ed(`(ed.setAlignTf({ x: 0, y: 0, rot: 0, scale: 0.1 }), true)`);
await same('setting the map exactly');
if (out) await page.screenshot({ path: `${out}/vac-align.png` });

// "Fit plan": all walls onto the map — the bathroom's walls are read where the bathroom's map lies (its own fit),
// the tub's edge does not squeeze it
await ed(`(ed._align = { ...ed._align, tool: 'walls' }, true)`);
await wait(200);
await ed(`(ed.alignSnapWalls(), true)`);
await wait(300);
const after = JSON.parse(await plan());
const bath = after.find(([id]) => id === 'bath')[1];
const xs = bath.map((p) => p[0]);
const width = Math.max(...xs) - Math.min(...xs);
ok(Math.abs(width - 200) <= 8, `fit plan: the bathroom keeps its width (${width} cm, was 200)`);
ok(after.every(([id, pts]) => { const b = JSON.parse(before).find(([x]) => x === id)[1]; return pts.every((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1]) <= 8); }), 'fit plan: no corner moved more than a few cm (map and plan agree)');
// moving a wall by hand (its handle in "Fit plan") does change the plan — on purpose …
const hb = await page.evaluate(`(() => { const hs = [...${ED}.shadowRoot.querySelector('fp-plan').shadowRoot.querySelectorAll('.h.planwall')]; const h = hs[0]; if (!h) return null; const r = h.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`)
  ?? (await page.evaluate(`(() => { const h = ${ED}.shadowRoot.querySelector('.h.planwall'); if (!h) return null; const r = h.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`));
if (hb) {
  await page.mouse.move(hb[0], hb[1]);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(hb[0] + i * 5, hb[1] + i * 5);
  await page.mouse.up();
  await wait(300);
}
ok(!!hb && (await plan()) !== before, `a wall dragged by hand moves (handle ${hb ? 'found' : 'missing'})`);
// … and "Reset" puts the plan back as it was when the mode was opened
await ed(`(ed.alignReset(), true)`);
await wait(300);
ok((await plan()) === before && (await doors()) === doorsBefore, 'Reset: rooms and doors exactly as before');
await ed(`(ed.endAlign(), true)`);
await wait(300);
ok((await plan()) === before, 'after "Done": rooms unchanged');
ok(!m.errors.filter((e) => !/unknown_command|Unknown command/.test(e)).length, `console: ${m.errors.join(' | ') || 'no errors'}`);
await m.browser.close();
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
