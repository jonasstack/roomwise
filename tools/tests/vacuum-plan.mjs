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

// 5. a house: Home Assistant knows two floors, the robot keeps three maps (one not loaded) — one floor per map with
// geometry, put on Home Assistant's floor whose areas its rooms match, the robot on the floor of the map it uses
const upper = { floor_res: 100, wall_res: 50, rooms: [], walls: [], charger: null };
const cellsUp = (id, name, x0, y0, x1, y1) => {
  const pts = [];
  for (let x = x0 + 50; x < x1; x += 100) for (let y = y0 + 50; y < y1; y += 100) pts.push([x, y]);
  upper.rooms.push({ id, name, pts });
};
cellsUp('11', 'Schlafzimmer', 0, 0, 4000, 3500);
cellsUp('12', 'Bad', 4050, 0, 6500, 3500);
for (let x = -25; x <= 6525; x += 50) upper.walls.push([x, -25], [x, 3525]);
for (let y = -25; y <= 3525; y += 50) upper.walls.push([-25, y], [6525, y], [4025, y]);
const haFloors = { eg: { floor_id: 'eg', name: 'Erdgeschoss', level: 0 }, og: { floor_id: 'og', name: 'Obergeschoss', level: 1 } };
const haAreas = { living: { area_id: 'living', name: 'Wohnzimmer', floor_id: 'eg' }, bed: { area_id: 'bed', name: 'Schlafzimmer', floor_id: 'og' }, bath: { area_id: 'bath', name: 'Bad', floor_id: 'og' } };
const maps = { select: 'select.robbi_karte', maps: [ { id: '0', name: 'Map 1', current: true, map }, { id: '1', name: 'Oben', current: false, map: upper }, { id: '2', name: 'Keller', current: false, map: null } ] };
m = await openMock({ config, states, areas: haAreas, floors: haFloors, size: '1280x900', ws: { 'floorplan_card/vacuums/info': info, 'floorplan_card/vacuums/maps': maps } });
page = m.page;
await wait(900);
ok(await page.evaluate(`${sr('.onboard-home [data-home="house"]')}?.getAttribute('aria-pressed') === 'true'`), 'welcome: "Haus" suggested (Home Assistant has two floors)');
await page.evaluate(`${sr('.onboard-vacuum')}.click()`);
await page.waitForFunction(`!!${sr('fp-vacuum-start .vp-preview')}`, null, { timeout: 8000 }).catch(() => {});
const house = await page.evaluate(`(() => { const v = ${sr('fp-vacuum-start')}; return { house: v.querySelector('[data-home="house"]')?.getAttribute('aria-pressed'), n: v.querySelector('[data-floors-n]')?.textContent, tabs: [...v.querySelectorAll('.vp-tab')].map((b) => b.textContent.trim()), miss: [...v.querySelectorAll('.vp-miss')].map((x) => x.dataset.map), summary: v.querySelector('.vp-summary')?.textContent }; })()`);
ok(house.house === 'true' && house.n === '2', `preview: house with 2 floors (${house.n})`, house);
ok(house.tabs.length === 2 && /Obergeschoss/.test(house.tabs[0]) && /Erdgeschoss/.test(house.tabs[1]), `one tab per floor, top first, named after Home Assistant (${house.tabs})`, house);
ok(house.miss.length === 1 && house.miss[0] === '2', 'the map without geometry is named with a hint', house);
if (out) await page.screenshot({ path: `${out}/vacuum-plan-house.png` });
await page.evaluate(`${sr('fp-vacuum-start .vp-switch')}.click()`);
await wait(150);
ok(!(await m.calls()).length, 'switching the robot\'s map: the first tap only asks');
await page.evaluate(`${sr('fp-vacuum-start .vp-switch')}.click()`);
await wait(200);
const sw = await m.calls();
ok(sw.some((c) => c.domain === 'select' && c.service === 'select_option' && c.target?.entity_id === 'select.robbi_karte' && c.data?.option === 'Keller'), 'second tap: the robot switches to that map (docked)', sw);
// a third floor: the plus adds an empty one on top
await page.evaluate(`${sr('fp-vacuum-start [data-floors-plus]')}.click()`);
await wait(300);
ok((await page.evaluate(`${sr('fp-vacuum-start')}.querySelectorAll('.vp-tab').length`)) === 3, 'plus: a third (empty) floor');
await page.evaluate(`${sr('fp-vacuum-start [data-floors-minus]')}.click()`);
await wait(300);
await page.evaluate(`${sr('fp-vacuum-start .vp-apply')}.click()`);
await wait(1800);
const fl = JSON.parse(await ed('JSON.stringify(ed._draft.floors)'));
const eg = fl.find((f) => f.floor === 'eg');
const og = fl.find((f) => f.floor === 'og');
ok(fl.length === 2 && eg && og, `draft: two floors, linked to Home Assistant's (${fl.map((f) => f.name)})`, fl.map((f) => ({ n: f.name, fl: f.floor, l: f.level })));
ok(eg?.name === 'Erdgeschoss' && eg.level === 0 && og?.name === 'Obergeschoss' && og.level === 1, 'names and levels from Home Assistant');
ok(eg?.rooms.some((r) => r.name === 'Wohnzimmer') && og?.rooms.map((r) => r.name).sort().join() === 'Bad,Schlafzimmer', 'each map on its floor (rooms matched to the floor\'s areas)', { eg: eg?.rooms.map((r) => r.name), og: og?.rooms.map((r) => r.name) });
ok(eg?.furniture.some((p) => p.kind === 'robot_vacuum') && !og?.furniture.some((p) => p.kind === 'robot_vacuum'), 'the robot stands on the floor of the map it uses now');
const ids = fl.flatMap((f) => [...f.rooms, ...(f.openings ?? []), ...(f.furniture ?? [])].map((x) => x.id));
ok(new Set(ids).size === ids.length, 'ids unique across floors');
errs.push(...m.errors);
await m.browser.close();

// 6. first steps: "draw it yourself" for a house starts with its floors; no hints → a flat
m = await openMock({ config, states: {}, floors: haFloors, areas: haAreas, size: '1280x900' });
page = m.page;
await wait(800);
await page.evaluate(`${sr('.onboard-start')}.click()`);
await wait(1500);
const drawn = JSON.parse(await ed('JSON.stringify(ed._draft.floors.map((f) => ({ name: f.name, floor: f.floor, level: f.level })))'));
ok(drawn.length === 2 && drawn.some((f) => f.floor === 'eg') && drawn.some((f) => f.floor === 'og'), `draw it yourself, house: two empty floors from Home Assistant (${drawn.map((f) => f.name)})`, drawn);
errs.push(...m.errors);
await m.browser.close();
m = await openMock({ config, states: {}, size: '390x844' });
page = m.page;
await wait(800);
ok(await page.evaluate(`${sr('.onboard-home [data-home="flat"]')}?.getAttribute('aria-pressed') === 'true'`), 'nothing points to a house: "Wohnung"');
await page.evaluate(`${sr('.onboard-home [data-home="house"]')}.click()`);
await wait(200);
await page.evaluate(`${sr('.onboard-home [data-floors-plus]')}.click()`);
await wait(200);
ok((await page.evaluate(`${sr('.onboard-home [data-floors-n]')}?.textContent`)) === '3', 'house: the number of floors can be set');
if (out) await page.screenshot({ path: `${out}/onboard-house-phone.png` });
await page.evaluate(`${sr('.onboard-start')}.click()`);
await wait(1500);
const three = JSON.parse(await ed('JSON.stringify(ed._draft.floors.map((f) => ({ name: f.name, level: f.level })))'));
ok(three.length === 3 && three.map((f) => f.name).join() === 'Erdgeschoss,Obergeschoss,Dachgeschoss', `three floors named by storey (${three.map((f) => f.name)})`, three);
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
