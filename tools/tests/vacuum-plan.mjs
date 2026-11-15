// First steps "from the robot vacuum's map": a brand-new card offers it when there is a vacuum; the chooser reads
// the map (companion), shows the plan made from it as a preview and "Apply" opens the editor with it as an unsaved
// draft — rooms with the map's names (a nameless one gets "Raum 1"), straight walls, a door where the floor runs
// through a gap in the wall, the room linked to the Home Assistant area of the same name, the vacuum and its dock
// placed and the vacuum already aligned (live view without "lay the map onto the plan"). Without a map yet: a hint
// and a mapping run that only starts after a second tap.
// Mock harness, neutral made-up map (no Home Assistant, no real vacuum, nothing saved).
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/vacuum-plan.mjs [outDir]
import { openMock } from './mock.mjs';

const out = process.argv[2];
let fails = 0;
const ok = (c, m, extra) => {
  if (!c) fails++;
  console.log(c ? '• ok:' : '• FAIL:', m, !c && extra !== undefined ? JSON.stringify(extra).slice(0, 400) : '');
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const errs = [];
const ED = `document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui')`;

// a made-up flat in robot millimetres (y up, like Roborock): living room, kitchen, an unnamed room, hallway;
// walls 50 mm apart, the hallway's floor running through a 90 cm gap into the living room (a doorway)
const map = { floor_res: 100, wall_res: 50, rooms: [], walls: [], charger: [600, 300] };
const cells = (id, name, x0, y0, x1, y1) => {
  const pts = [];
  for (let x = x0 + 50; x < x1; x += 100) for (let y = y0 + 50; y < y1; y += 100) pts.push([x, y]);
  map.rooms.push({ id, name, pts });
};
const wall = (x0, y0, x1, y1, gap) => {
  const n = Math.round(Math.hypot(x1 - x0, y1 - y0) / 50);
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    const y = y0 + ((y1 - y0) * i) / n;
    if (gap && x > gap[0] && x < gap[1]) continue;
    map.walls.push([Math.round(x), Math.round(y)]);
  }
};
cells('1', 'Wohnzimmer', 0, 0, 5000, 4000);
cells('2', 'Küche', 5050, 0, 8000, 2500);
cells('3', null, 5050, 2550, 8000, 4000);
cells('4', 'Flur', 0, 4050, 8000, 5500);
for (let x = 2050; x < 2900; x += 100) map.rooms[3].pts.push([x, 4025]);
wall(-25, -25, 8025, -25);
wall(-25, 5525, 8025, 5525);
wall(-25, -25, -25, 5525);
wall(8025, -25, 8025, 5525);
wall(5025, -25, 5025, 4025);
wall(5025, 2525, 8025, 2525);
wall(-25, 4025, 8025, 4025, [2000, 2900]);

const info = { adapter: 'roborock', source: null, platform: 'roborock', segments: [], clean: true, candidates: [] };
const states = { 'vacuum.demo_robot': { state: 'docked', attributes: { friendly_name: 'Robbi' } } };
const areas = { living: { area_id: 'living', name: 'Wohnzimmer', floor_id: null } };
const config = { type: 'custom:floorplan-card', card_id: 'vac_start_demo', height: 'calc(100vh - 16px)', view_mode: '2d', effects: 'off' };

// 1. with a map
let m = await openMock({ config, states, areas, size: '1280x900', ws: { 'floorplan_card/vacuums/info': info, 'floorplan_card/vacuums/map': map } });
let { page } = m;
await wait(900);
const sr = (sel) => `window.__fpCard.shadowRoot.querySelector(${JSON.stringify(sel)})`;
ok(await page.evaluate(`!!${sr('.onboard-vacuum')}`), 'welcome panel offers "Aus der Karte des Saugroboters"');
await page.evaluate(`${sr('.onboard-vacuum')}.click()`);
await page.waitForFunction(`!!${sr('fp-vacuum-start .vp-preview')}`, null, { timeout: 8000 }).catch(() => {});
const prev = await page.evaluate(`(() => { const v = ${sr('fp-vacuum-start')}; return { polys: v?.querySelectorAll('.vp-room').length, doors: v?.querySelectorAll('.vp-door').length, names: [...(v?.querySelectorAll('.vp-name') ?? [])].map((n) => n.textContent), summary: v?.querySelector('.vp-summary')?.textContent }; })()`);
ok(prev.polys === 4, `preview: 4 rooms (${prev.polys})`, prev);
ok(prev.doors === 1, `preview: 1 door (${prev.doors})`, prev);
ok(['Wohnzimmer', 'Küche', 'Raum 1', 'Flur'].every((n) => prev.names.includes(n)), `names from the map, nameless → "Raum 1" (${prev.names})`);
if (out) await page.screenshot({ path: `${out}/vacuum-plan-preview.png` });
await page.evaluate(`${sr('fp-vacuum-start .vp-apply')}.click()`);
await wait(1800);
const ed = (expr) => page.evaluate(`(() => { const ed = ${ED}; return ${expr}; })()`);
ok(await ed('!!ed'), 'Apply opens the editor');
const f = JSON.parse(await ed('JSON.stringify(ed._draft.floors[0])'));
ok(f.rooms.length === 4, `draft: 4 rooms (${f.rooms.length})`);
const rect = (r) => r.points.length === 4 && r.points.every((p, i) => { const q = r.points[(i + 1) % 4]; return p[0] === q[0] || p[1] === q[1]; });
ok(f.rooms.every(rect), 'every room a clean rectangle (straight walls)', f.rooms.map((r) => r.points));
// neighbours share their wall exactly: no gaps, no overlaps
const xs = (n) => f.rooms.find((r) => r.name === n).points.map((p) => p[0]);
const ys = (n) => f.rooms.find((r) => r.name === n).points.map((p) => p[1]);
ok(Math.max(...xs('Wohnzimmer')) === Math.min(...xs('Küche')) && Math.max(...xs('Wohnzimmer')) === Math.min(...xs('Raum 1')), 'living room and kitchen / room 1 meet on one wall');
ok(Math.min(...ys('Wohnzimmer')) === Math.max(...ys('Flur')), 'hallway and living room meet on one wall (map y up → plan y down)');
const door = f.openings?.[0];
ok(f.openings?.length === 1 && door.type === 'door' && door.a[1] === door.b[1] && Math.abs(door.a[0] - 225) <= 15 && Math.abs(door.b[0] - 315) <= 15, 'door where the hallway runs into the living room', f.openings);
ok(f.rooms.find((r) => r.name === 'Wohnzimmer')?.area === 'living', 'living room linked to the area "Wohnzimmer"');
const vac = f.furniture?.find((p) => p.kind === 'robot_vacuum');
const dock = f.furniture?.find((p) => p.kind === 'robot_dock');
ok(vac?.entity === 'vacuum.demo_robot' && vac?.vacuum?.transform?.scale === 0.1 && vac.vacuum.transform.mirror === true, 'vacuum placed, linked and aligned', vac);
// the dock sits where the map has it: charger (600, 300) mm through the same transform
const tf = vac?.vacuum?.transform;
const dx = tf ? tf.x + 0.1 * 600 : NaN;
const dy = tf ? tf.y - 0.1 * 300 : NaN;
ok(dock && Math.abs(dock.x - dx) <= 1 && Math.abs(dock.y - dy) <= 1, 'dock at the map\'s charger', { dock, dx, dy });
ok(!(await ed('ed.card.rawConfig?.floors?.length')), 'nothing saved yet (draft only)');
if (out) await page.screenshot({ path: `${out}/vacuum-plan-editor.png` });
errs.push(...m.errors);
await m.browser.close();

// 2. no map yet: hint, mapping run after a second tap, reads again
m = await openMock({ config, states, size: '1280x900', ws: { 'floorplan_card/vacuums/info': info, 'floorplan_card/vacuums/map': null } });
page = m.page;
await wait(900);
await page.evaluate(`${sr('.onboard-vacuum')}.click()`);
await page.waitForFunction(`!!${sr('fp-vacuum-start .vp-maprun')}`, null, { timeout: 8000 }).catch(() => {});
ok(await page.evaluate(`!!${sr('fp-vacuum-start .vp-nomap')}`), 'no map: says to let it drive once');
await page.evaluate(`${sr('fp-vacuum-start .vp-maprun')}.click()`);
await wait(200);
ok(!(await m.calls()).length, 'first tap only asks');
if (out) await page.screenshot({ path: `${out}/vacuum-plan-nomap.png` });
await page.evaluate(`${sr('fp-vacuum-start .vp-maprun')}.click()`);
await wait(300);
const calls = await m.calls();
ok(calls.some((c) => c.domain === 'vacuum' && c.service === 'start' && c.target?.entity_id === 'vacuum.demo_robot'), 'second tap: vacuum.start', calls);
ok(await page.evaluate(`${sr('fp-vacuum-start .vp')}?.dataset.state === 'mapping'`), 'then waits for the map');
errs.push(...m.errors);
await m.browser.close();

// 3. a vacuum whose map Home Assistant does not get
m = await openMock({ config, states, size: '1280x900', ws: { 'floorplan_card/vacuums/info': { ...info, adapter: null } } });
page = m.page;
await wait(900);
await page.evaluate(`${sr('.onboard-vacuum')}.click()`);
await wait(800);
ok(await page.evaluate(`${sr('fp-vacuum-start .vp')}?.dataset.state === 'unsupported'`), 'unsupported vacuum: says which ones work');
errs.push(...m.errors);
await m.browser.close();

// 4. no vacuum: the path is not offered
m = await openMock({ config, states: {}, size: '1280x900' });
await wait(700);
ok(!(await m.page.evaluate(`!!${sr('.onboard-vacuum')}`)), 'no vacuum: no such path');
errs.push(...m.errors);
await m.browser.close();
ok(!errs.length, 'no page errors or warnings', errs);

console.log(fails ? `\n${fails} FAIL` : '\nall ok');
process.exit(fails ? 1 : 0);
