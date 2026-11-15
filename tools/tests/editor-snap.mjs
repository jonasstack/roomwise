// Editor: pulling rooms into shape. Corners and walls line up with what is already drawn (other rooms' corners and
// walls, the line of another corner, the extension of a slanted wall) with helper lines, the grid only when nothing
// is near (and not at all on a floor made from a robot vacuum's map: grid_snap false). A wall or corner two rooms
// share moves for both (doors on it too); Alt moves only the room's own. A slanted wall stays slanted.
// Mock harness (no Home Assistant, neutral rooms).
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/editor-snap.mjs [outDir]
import { openMock } from './mock.mjs';

const out = process.argv[2];
let fails = 0;
const ok = (c, m, extra) => {
  if (!c) fails++;
  console.log(c ? '• ok:' : '• FAIL:', m, !c && extra !== undefined ? JSON.stringify(extra) : '');
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ED = `document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui')`;
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

const config = {
  type: 'custom:floorplan-card',
  card_id: 'snap',
  view_mode: '2d',
  effects: 'off',
  floors: [
    {
      id: 'eg',
      name: 'Erdgeschoss',
      rooms: [
        { id: 'a', name: 'Raum A', points: rect(0, 0, 400, 300) },
        { id: 'b', name: 'Raum B', points: rect(400, 0, 800, 300) },
        { id: 'c', name: 'Raum C', points: [[0, 300], [400, 300], [420, 600], [0, 600]] },
        { id: 'd', name: 'Raum D', points: rect(1000, 0, 1300, 250) },
      ],
      devices: [],
      openings: [{ id: 'door_ab', type: 'door', a: [400, 100], b: [400, 190] }],
    },
  ],
};

const m = await openMock({ config, size: '1280x900' });
const { page } = m;
await m.card(`(card.openEditor(), true)`);
await wait(1800);
ok(await page.evaluate(`!!${ED}`), 'editor open');
const E = (body) => page.evaluate(`(() => { const ed = ${ED}; ${body} })()`);
const rooms = () => E(`return Object.fromEntries(ed._draft.floors[0].rooms.map((r) => [r.id, r.points]));`);
const door = () => E(`return ed._draft.floors[0].openings[0];`);
const tol = await E(`return 14 / ed.scale;`);
const grid = await E(`return ed.grid;`);
const sel = (id) => E(`ed.select({ kind: 'room', id: ${JSON.stringify(id)} }); return true;`);
/** a drag through the editor's own gesture handlers (what a mouse or a finger ends up calling) */
const drag = async (handle, from, to, { alt = false, end = true } = {}) => {
  await E(`ed.handlers.onDragStart({ kind: 'background', id: 'handle:${handle}' }, ${JSON.stringify(from)}, { altKey: ${alt} }); return true;`);
  for (let i = 1; i <= 6; i++) await E(`ed.handlers.onDragMove([${from[0] + ((to[0] - from[0]) * i) / 6}, ${from[1] + ((to[1] - from[1]) * i) / 6}]); return true;`);
  await wait(60);
  if (end) await E(`ed.handlers.onDragEnd(${JSON.stringify(to)}, false); return true;`);
  await wait(120);
};
const close = (a, b, e = 0.05) => Math.abs(a - b) <= e;

// 1. the wall A and B share, pulled to the right: B goes along (no gap), the door on it too; grid on → grid
await sel('a');
await wait(200);
await drag('m:1', [400, 150], [437, 150]);
let r = await rooms();
const x1 = r.a[1][0];
ok(close(x1 % grid, 0) && x1 > 400, `shared wall on a grid line (grid on, nothing near): x=${x1}`, r.a);
ok(close(r.a[1][0], r.b[0][0]) && close(r.a[2][0], r.b[3][0]), 'B goes along: no gap, no overlap', { a: r.a, b: r.b });
let dd = await door();
ok(close(dd.a[0], x1) && close(dd.b[0], x1), `the door on that wall goes along (${dd.a[0]})`, dd);
ok(close(r.c[1][0], 400) && close(r.c[1][1], 300), "C (only touching that wall's end) stays", r.c);
await E(`ed.undo(); return true;`);
await wait(150);

// 2. Alt: only A's wall moves
await drag('m:1', [400, 150], [437, 150], { alt: true });
r = await rooms();
ok(r.a[1][0] > 400 && close(r.b[0][0], 400) && close(r.b[3][0], 400), `Alt: only this room (A ${r.a[1][0]}, B stays 400)`, { a: r.a, b: r.b });
await E(`ed.undo(); return true;`);
await wait(150);

// 3. a floor made from a robot vacuum's map: no grid; a corner lines up with another room's corner line
await E(`ed.mutate((_d, f) => { f.grid_snap = false; }, false); return true;`);
ok((await E(`return ed.gridSnap;`)) === false, 'grid_snap false: no grid snapping');
await sel('d');
await wait(200);
// x well clear of every corner's line (also the room's own), y just off the line of A/B's bottom (y 300)
const tx = Math.round((1300 + tol * 2 + 7.3) * 10) / 10;
const target = [tx, 300 + tol * 0.4];
await drag('v:2', [1300, 250], target, { end: false });
const hov = await E(`return ed._hover;`);
ok(hov?.kind === 'align' && (hov.guides?.length ?? 0) >= 1, `dragged corner lines up (kind ${hov?.kind}, ${hov?.guides?.length ?? 0} helper line(s))`, hov);
if (out) await page.screenshot({ path: `${out}/editor-snap-align.png` });
const guides = await page.evaluate(`${ED}.shadowRoot.querySelector('fp-plan')?.shadowRoot?.querySelectorAll('.ed-guide.align').length ?? -1`);
ok(guides >= 1 || guides === -1, `helper lines drawn (${guides})`);
await E(`ed.handlers.onDragEnd(${JSON.stringify(target)}, false); return true;`);
await wait(120);
r = await rooms();
ok(close(r.d[2][1], 300), `corner on the line of A/B's bottom (y ${r.d[2][1]})`, r.d);
ok(close(r.d[2][0], tx, 0.6), `x not pulled onto the grid (x ${r.d[2][0]}, dragged to ${tx})`, r.d);
ok(close(r.d[1][0], 1300) && close(r.d[1][1], 0), 'the rest of the room stays', r.d);

// 4. nothing near and no grid: the corner goes exactly where it is dragged
const free = [Math.round((1000 - tol * 2 - 7.3) * 10) / 10, Math.round((-tol * 2 - 11.7) * 10) / 10];
await drag('v:0', [1000, 0], free);
r = await rooms();
ok(close(r.d[0][0], free[0], 0.6) && close(r.d[0][1], free[1], 0.6), `free corner: no grid jump (${r.d[0]}, dragged to ${free})`, r.d);

// 5. a slanted wall stays slanted when pulled
await sel('c');
await wait(200);
const before = (await rooms()).c;
const slope0 = (before[2][0] - before[1][0]) / (before[2][1] - before[1][1]);
await drag('m:1', [410, 450], [433, 452]);
r = await rooms();
const slope1 = (r.c[2][0] - r.c[1][0]) / (r.c[2][1] - r.c[1][1]);
ok(close(slope0, slope1, 0.01) && r.c[1][0] > before[1][0], `slanted wall moved and still slanted (${slope0.toFixed(3)} → ${slope1.toFixed(3)})`, r.c);
ok(close(r.c[0][0], 0) && close(r.c[3][1], 600), 'the other corners stay', r.c);

// 6. a corner A and B share: dragged on A, B's goes along
await sel('a');
await wait(200);
await drag('v:1', [400, 0], [400, -37]);
r = await rooms();
ok(close(r.a[1][0], r.b[0][0]) && close(r.a[1][1], r.b[0][1]) && r.a[1][1] < 0, `shared corner moves for both (${r.a[1]} / ${r.b[0]})`, { a: r.a, b: r.b });

// 7. the same with a real mouse on the wall's middle handle (pointer events, as on the tablet)
await E(`ed.undo(); ed.undo(); return true;`);
await wait(200);
await sel('b');
await wait(300);
const hpos = await page.evaluate(`(() => { const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.dataset?.handle === 'm:1') return el; if (el.shadowRoot) { const x = find(el.shadowRoot); if (x) return x; } } return null; }; const h = find(${ED}.shadowRoot); if (!h) return null; const b = h.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`);
ok(!!hpos, 'the middle handle of the wall is there', hpos);
if (hpos) {
  const bx0 = (await rooms()).b[1][0];
  await page.mouse.move(hpos[0], hpos[1]);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(hpos[0] + i * 6, hpos[1] + (i % 2));
  await page.mouse.up();
  await wait(300);
  r = await rooms();
  ok(r.b[1][0] > bx0 + 5 && close(r.b[1][0], r.b[2][0]), `mouse drag pulls the wall (x ${bx0} → ${r.b[1][0]}), straight`, r.b);
}
if (out) await page.screenshot({ path: `${out}/editor-snap-done.png` });
ok(!m.errors.length, `console: ${m.errors.join(' | ') || 'no errors'}`);
await m.browser.close();
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
