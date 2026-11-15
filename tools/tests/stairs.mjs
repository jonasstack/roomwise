// Stairs on the mock harness (no Home Assistant; neutral demo house with two floors): found in the library ("Bauteile",
// search "Treppe"), the editor's "Treppe setzen" tool and "Wo ist die Treppe?", the stairwell on the floor above
// (2D and the 3D floor) with its chip down, a stair light (tap switches it, hold lists all devices, lit treads), the
// stairs always at the bottom of the plan (under furniture, not a tap target without a device), and the dog going up
// the stairs in 3D. Temporary config in the page only.
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/stairs.mjs [outDir] [light|dark]
import { openMock } from './mock.mjs';

const out = process.argv[2] ?? '/tmp';
const scheme = process.argv[3] ?? 'light';
let fails = 0;
const ok = (c, m, extra) => {
  if (!c) fails++;
  console.log(c ? '• ok:' : '• FAIL:', m, !c && extra !== undefined ? JSON.stringify(extra) : '');
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

const config = () => ({
  type: 'custom:floorplan-card',
  card_id: 'stairs',
  height: 'calc(100vh - 16px)',
  view_mode: '2d',
  effects: 'off',
  floors: [
    {
      id: 'eg',
      name: 'Erdgeschoss',
      level: 0,
      rooms: [
        { id: 'wohnen', name: 'Wohnen', points: rect(0, 0, 600, 500) },
        { id: 'flur', name: 'Flur', points: rect(600, 0, 900, 500) },
      ],
      devices: [],
      openings: [{ id: 'd1', type: 'door', a: [600, 300], b: [600, 390] }],
      furniture: [
        { id: 'st', kind: 'stairs', x: 750, y: 250, w: 100, h: 260, entity: 'light.demo_stairs', contents: [{ entity: 'light.demo_steps' }, { entity: 'binary_sensor.demo_stairs_motion' }] },
        // a piece standing on the stairs' footprint: drawn above them
        { id: 'plant', kind: 'plant', x: 750, y: 150, w: 40, h: 40 },
        { id: 'sofa', kind: 'sofa', x: 300, y: 400, w: 220, h: 95 },
        { id: 'dog', kind: 'dog', variant: 'retriever', name: 'Rex', x: 300, y: 200, w: 80, h: 28, pet: { figure: 'simple' } },
      ],
    },
    {
      id: 'og',
      name: 'Obergeschoss',
      level: 1,
      rooms: [
        { id: 'schlafen', name: 'Schlafen', points: rect(0, 0, 600, 500) },
        { id: 'diele', name: 'Diele', points: rect(600, 0, 900, 500) },
      ],
      devices: [],
      openings: [],
      furniture: [{ id: 'bed', kind: 'bed', x: 300, y: 250, w: 160, h: 200 }],
    },
  ],
});
const states = {
  'light.demo_stairs': { state: 'off', attributes: { friendly_name: 'Treppenlicht', brightness: 200 } },
  'light.demo_steps': { state: 'off', attributes: { friendly_name: 'LED-Stufen' } },
  'binary_sensor.demo_stairs_motion': { state: 'off', attributes: { friendly_name: 'Bewegung Treppe', device_class: 'motion' } },
};

const m = await openMock({ config: config(), states, size: '1280x900', scheme });
const { page } = m;
await wait(1500);

// ---------- 2D: background, quiet, light ----------
const order = await m.card(`[...plan.shadowRoot.querySelectorAll('.furniture > .piece')].map((g) => g.dataset.furniture)`);
ok(order.indexOf('st') === 0 && order.indexOf('plant') > order.indexOf('st'), `stairs drawn first, under every piece (${order.join(', ')})`);
await m.card(`(plan.requestUpdate(), true)`);
ok(!(await m.card(`!!plan.shadowRoot.querySelector('[data-furniture="st"] .stair-lit')`)), 'light off: no lit treads');
await m.setStates({ 'light.demo_stairs': { state: 'on', attributes: { friendly_name: 'Treppenlicht', brightness: 200 } } });
await wait(400);
ok(await m.card(`!!plan.shadowRoot.querySelector('[data-furniture="st"] .stair-lit')`), 'light on: the treads glow softly');
await page.screenshot({ path: `${out}/stairs-2d-lit-${scheme}.png` });
await m.setStates({ 'light.demo_stairs': { state: 'off', attributes: { friendly_name: 'Treppenlicht' } }, 'binary_sensor.demo_stairs_motion': { state: 'on', attributes: { friendly_name: 'Bewegung Treppe', device_class: 'motion' } } });
await wait(400);
ok(await m.card(`!!plan.shadowRoot.querySelector('[data-furniture="st"] .stair-lit')`), 'motion on the stairs: the treads glow too');
await m.setStates({ 'binary_sensor.demo_stairs_motion': { state: 'off', attributes: { friendly_name: 'Bewegung Treppe', device_class: 'motion' } } });

// tap switches the stair light; hold lists all devices; the chip still leads upstairs
await m.clearCalls();
await m.card(`(card.gesture({ kind: 'furniture', id: 'st' }, 'tap'), true)`);
await wait(300);
const calls = await m.calls();
ok(calls.some((c) => c.domain === 'light' && c.service === 'toggle' && JSON.stringify(c).includes('light.demo_stairs')) || calls.some((c) => JSON.stringify(c).includes('light.demo_stairs')), 'tap on the stairs: switches the stair light', calls);
await m.card(`(card.gesture({ kind: 'furniture', id: 'st' }, 'hold'), true)`);
await wait(600);
const popup = await page.evaluate(`(() => { const l = document.querySelector('floorplan-card-layer'); const p = l?.shadowRoot.querySelector('fp-furniture-popup'); return p ? p.shadowRoot.textContent : null; })()`);
ok(!!popup && popup.includes('LED-Stufen') && popup.includes('Bewegung Treppe'), 'hold: every device of the stairs', popup?.slice(0, 120));
await page.keyboard.press('Escape');
await wait(400);
const chip = await m.card(`plan.shadowRoot.querySelector('.pet-chip.stair')?.textContent.trim()`);
ok(chip?.includes('Obergeschoss'), `chip above the stairs: "${chip}"`);
// a stair without a device is no tap target: the room takes the tap
await m.card(`(card.setConfig({ ...card.rawConfig, floors: card.rawConfig.floors.map((f) => f.id !== 'eg' ? f : { ...f, furniture: f.furniture.map((x) => x.id === 'st' ? { id: 'st', kind: 'stairs', x: 750, y: 250, w: 100, h: 260 } : x) }) }), true)`);
await wait(600);
const hitBare = await m.card(`(() => { const el = plan.shadowRoot.querySelector('[data-furniture="st"]'); const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height * 0.8; const path = []; let e = plan.shadowRoot.elementFromPoint(x, y); while (e) { path.push(e); e = e.parentNode instanceof Element ? e.parentNode : null; } return plan.hitTestInner({ composedPath: () => path, clientX: x, clientY: y }); })()`);
ok(hitBare?.kind === 'room' && hitBare.id === 'flur', 'stairs without a device: the tap goes to the room', hitBare);
// the chip leads upstairs
await m.card(`(card.gesture({ kind: 'furniture', id: 'st', to: 'og' }, 'tap'), true)`);
await wait(1800);
ok((await m.card(`card._floorId`)) === 'og', 'chip → upstairs');

// ---------- the floor above: stairwell ----------
const sw = await m.card(`plan.shadowRoot.querySelectorAll('.stairwell .sw-steps').length`);
ok(sw === 1, `upstairs: the stairwell at the same spot (${sw})`);
const down = await m.card(`plan.shadowRoot.querySelector('.pet-chip.stair')?.textContent.trim()`);
ok(down?.includes('Erdgeschoss'), `stairwell chip leads down: "${down}"`);
const swOp = await m.card(`getComputedStyle(plan.shadowRoot.querySelector('.stairwell .sw-steps')).opacity`);
ok(Number(swOp) < 0.5, `stairwell is faint (opacity ${swOp})`);
await page.screenshot({ path: `${out}/stairs-2d-stairwell-${scheme}.png` });
await m.card(`(card.gesture({ kind: 'furniture', id: 'st', to: 'eg' }, 'tap'), true)`);
await wait(1800);
ok((await m.card(`card._floorId`)) === 'eg', 'stairwell chip → down again');

// ---------- 3D: tappable only with a device, lit strips, stairwell in the floor texture, dog on the stairs ----------
await m.card(`(card.setConfig({ ...card.rawConfig, view_mode: '3d' }), true)`);
await wait(2500);
ok(await m.card(`plan.is3d && !!plan.glScene`), 'WebGL 3D view');
// a pick right on the stairs' middle (projected like a tap) does not hit them
const pick = await m.card(`(() => { const g = plan.glScene; const V = g.camera.position.constructor; const p = new V(750, 250, 50); p.project(g.camera); const vp = plan.shadowRoot.querySelector('.viewport').getBoundingClientRect(); return plan.glPick({ clientX: vp.left + (p.x + 1) / 2 * g.view.width, clientY: vp.top + (1 - p.y) / 2 * g.view.height }, 0, 0, true) ?? null; })()`);
ok(pick !== 'st', `stairs without a device: no tap target in 3D (pick: ${pick})`);
await page.screenshot({ path: `${out}/stairs-3d-${scheme}.png` });
// the dog takes the stairs: rises along the treads, then is out of sight upstairs
const life = (expr) => m.card(`(() => { const L = plan.glScene.dogs.get('dog'); return L ? ${expr} : null; })()`);
await wait(1500);
ok((await life('!!L.actor')) === true, 'the dog is there');
await life(`(L.task = 'climb', L.climbI = 0, L.climbBack = false, L.trip = 0, true)`);
await m.card(`(plan.glScene.requestRender?.(), true)`);
let maxZ = 0;
let gone = false;
for (let i = 0; i < 60 && !gone; i++) {
  await wait(500);
  const s = await life(`({ z: L.z ?? 0, task: L.task, vis: plan.glScene.petGroup.children.find((c) => c.userData.id === 'dog')?.visible })`);
  maxZ = Math.max(maxZ, s?.z ?? 0);
  if (i === 8) await page.screenshot({ path: `${out}/stairs-3d-dog-${scheme}.png` });
  gone = s?.task === 'away' && s.vis === false;
}
ok(maxZ > 40, `the dog climbs the stairs (up to ${Math.round(maxZ)} cm)`);
ok(gone, 'at the top: out of sight upstairs');
await life(`(L.until = 0, true)`);
let back = false;
for (let i = 0; i < 60 && !back; i++) {
  await wait(500);
  back = (await life(`L.task === 'idle' && (L.z ?? 0) === 0`)) === true;
}
ok(back, 'and comes back down');

// upstairs in 3D: the stairwell lies on the floor (part of the floor texture layers)
await m.card(`(card.goFloor('og'), true)`);
await wait(2500);
ok((await m.card(`!!plan.shadowRoot.querySelector('.stairwell')`)) === true, 'upstairs in 3D: stairwell layer drawn into the floor');
await page.screenshot({ path: `${out}/stairs-3d-stairwell-${scheme}.png` });

// ---------- editor: library, tool, the question after laying out a house, the floors menu ----------
await m.card(`(card.goFloor('eg'), card.setConfig({ ...card.rawConfig, view_mode: '2d' }), true)`);
await wait(1200);
const ED = `document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui')`;
const E = (expr) => page.evaluate(`(() => { const ed = ${ED}; return ${expr}; })()`);
await m.card(`(card.openEditor(), true)`);
await wait(2000);
ok(await E('!!ed'), 'editor open');
await E(`(ed.shadowRoot.querySelector('.tool[data-panel="furniture"]').click(), true)`);
await wait(500);
const cats = await E(`[...ed.shadowRoot.querySelectorAll('.cat-chips .chip')].map((c) => c.textContent.trim()).slice(0, 3).join(' | ')`);
ok(cats.split(' | ')[2] === 'Bauteile', `"Bauteile" is the first category (${cats})`);
await E(`(ed._furnQ = 'Treppe', true)`);
await wait(400);
const hits = await E(`ed.shadowRoot.querySelectorAll('.furn-grid .furn').length`);
ok(hits >= 3, `search "Treppe": straight, L-shaped and spiral stairs (${hits})`);
await E(`(ed._furnQ = '', ed._panel = null, true)`);
await wait(300);
// the toolbar tool: pick "L-förmig", tap the plan → stairs there, selected
ok(await E(`!!ed.shadowRoot.querySelector('.tool[data-tool="stairs"]')`), 'toolbar: "Treppe setzen"');
await E(`(ed.shadowRoot.querySelector('.tool[data-tool="stairs"]').click(), true)`);
await wait(300);
ok(await E(`!!ed.shadowRoot.querySelector('.stairs-hint')`), 'hint: where to tap, kind of stairs');
await E(`(ed.shadowRoot.querySelector('[data-stair-variant="l"]').click(), true)`);
const n0 = await E(`ed.floor.furniture.filter((f) => f.kind === 'stairs').length`);
await E(`(ed.onTap({ kind: 'room', id: 'wohnen' }, [200, 200]), true)`);
await wait(300);
const placed = await E(`(() => { const s = ed.floor.furniture.filter((f) => f.kind === 'stairs'); const f = s[s.length - 1]; return { n: s.length, variant: f.variant, x: f.x, y: f.y, sel: ed._sel?.id === f.id, tool: ed._tool }; })()`);
ok(placed.n === n0 + 1 && placed.variant === 'l' && placed.sel && placed.tool === 'select', 'tap → L-shaped stairs placed there and selected', placed);
// the inspector of stairs: leads to, stair light, more devices
const insp = await E(`ed.shadowRoot.textContent`);
ok(insp.includes('Führt zu') && insp.includes('Treppenlicht') && insp.includes('Weitere Geräte an der Treppe'), 'inspector: leads to, stair light, more devices');
// the floors menu's "Treppe setzen" (hook for the floors bar)
await E(`(ed.placeStairs('og'), true)`);
await wait(300);
ok((await E(`ed.floorId === 'og' && ed._tool === 'stairs'`)) === true, 'floors menu "Treppe setzen": that floor, the tool on');
await E(`(ed._tool = 'select', ed.requestUpdate(), true)`);
// "Wo ist die Treppe?" after laying out a house: on the floor with a floor above, the hallway offered
const house = (await m.card(`card.rawConfig`));
house.floors[0].furniture = house.floors[0].furniture.filter((f) => f.kind !== 'stairs');
await m.card(`(card.ensureLayer().closeEditor(), true)`);
await wait(600);
await m.card(`(card.ensureLayer().openEditor('og', { config: ${JSON.stringify(house)}, askStairs: true }), true)`);
await wait(2200);
// first the short tour (if it shows), the question comes after it
const tour = await E('ed._tour');
ok(tour !== true || (await E(`ed._tool`)) !== 'stairs', 'while the tour shows, the question waits');
await E(`(ed._tour = false, true)`);
await wait(500);
const ask = await E(`({ floor: ed.floorId, tool: ed._tool, text: ed.shadowRoot.querySelector('.stairs-hint')?.textContent ?? '', room: ed.shadowRoot.querySelector('[data-stairs-room]')?.dataset.stairsRoom })`);
ok(ask.floor === 'eg' && ask.tool === 'stairs' && ask.text.includes('Wo ist die Treppe') && ask.room === 'flur', 'house: "Wo ist die Treppe?" on the ground floor, the hallway offered', ask);
await page.screenshot({ path: `${out}/stairs-editor-ask-${scheme}.png` });
await E(`(ed.shadowRoot.querySelector('[data-stairs-room]').click(), true)`);
await wait(300);
const inFlur = await E(`ed.floor.furniture.find((f) => f.kind === 'stairs')`);
ok(!!inFlur && inFlur.x > 600 && inFlur.x < 900, 'one tap: stairs in the hallway', inFlur);
await m.card(`(card.ensureLayer().closeEditor(), true)`);
await wait(400);

const errs = m.errors.filter((e) => !/favicon|DevTools|WebGL|GPU stall|GL Driver|Automatic fallback/i.test(e));
ok(!errs.length, 'console: no errors or warnings', errs);
await m.browser.close();
console.log(fails ? `\n${fails} FAIL` : '\nall ok');
process.exit(fails ? 1 : 0);
