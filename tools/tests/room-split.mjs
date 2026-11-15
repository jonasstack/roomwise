// "Raum teilen" and "Räume zusammenlegen": a line right through a room cuts it into two rooms – open (an open
// kitchen: a passage on the cut, no wall) or with a wall; L-shapes and slanted walls too; a line that does not cross
// the room is refused; furniture belongs to the part it stands in; undo; two neighbours join into one room (doors and
// passages on the former wall go), only when the result is one simple outline. Mock harness, nothing saved.
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/room-split.mjs [outDir]
import * as esbuild from 'esbuild';
import { openMock } from './mock.mjs';

const out = process.argv[2];
let fails = 0;
const ok = (c, m, extra) => {
  if (!c) fails++;
  console.log(c ? '• ok:' : '• FAIL:', m, !c && extra !== undefined ? JSON.stringify(extra).slice(0, 400) : '');
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const errs = [];
const area = (pts) => Math.abs(pts.reduce((a, p, i) => { const q = pts[(i + 1) % pts.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);

// ---------- geometry ----------
{
  const r = await esbuild.build({
    stdin: { contents: "export { splitOutline, mergeOutlines } from './src/room-split'; export { wallPieces } from './src/walls';", resolveDir: process.cwd(), loader: 'ts' },
    bundle: true,
    format: 'esm',
    write: false,
    platform: 'node',
    logLevel: 'silent',
  });
  const g = await import('data:text/javascript;base64,' + Buffer.from(r.outputFiles[0].text).toString('base64'));
  const rect = [[0, 0], [600, 0], [600, 400], [0, 400]];
  const s = g.splitOutline(rect, [400, 0], [400, 400]);
  ok(s.ok && Math.round(area(s.pieces[0])) === 160000 && Math.round(area(s.pieces[1])) === 80000, 'rectangle cut at 4 m: 4×4 m and 2×4 m, the larger part first', s);
  const L = [[0, 0], [600, 0], [600, 200], [300, 200], [300, 500], [0, 500]];
  const sl = g.splitOutline(L, [0, 300], [300, 300]);
  ok(sl.ok && Math.round(area(sl.pieces[0]) + area(sl.pieces[1])) === Math.round(area(L)) && sl.pieces[0].length === 6, 'L-shape: the arm cut off, nothing lost', sl);
  const sla = g.splitOutline([[0, 0], [500, 0], [400, 300], [0, 300]], [200, 0], [250, 300]);
  ok(sla.ok && sla.chord.every((p) => p[1] === 0 || p[1] === 300), 'slanted line through a room with a slanted wall', sla);
  ok(!g.splitOutline(rect, [100, 100], [200, 100]).ok, 'a line inside the room that does not reach the walls: refused');
  ok(!g.splitOutline(rect, [0, 0], [600, 0]).ok, 'a line along a wall: refused');
  ok(!g.splitOutline(rect, [20, 0], [20, 400]).ok && g.splitOutline(rect, [20, 0], [20, 400]).reason === 'small', 'a 20 cm sliver: refused as too small');
  const m = g.mergeOutlines(s.pieces[0], s.pieces[1]);
  ok(m && m.outline.length === 4 && Math.round(area(m.outline)) === 240000, 'joined back: one rectangle again', m);
  ok(!g.mergeOutlines([[0, 0], [100, 0], [100, 100], [0, 100]], [[100, 100], [200, 100], [200, 200], [100, 200]]), 'two rooms touching only at a corner: no join');
  const part = g.mergeOutlines([[0, 0], [400, 0], [400, 300], [0, 300]], [[400, 100], [600, 100], [600, 200], [400, 200]]);
  ok(part && part.outline.length === 8, 'a niche on part of a wall: joined into one outline', part);
}

// ---------- editor ----------
const config = {
  type: 'custom:floorplan-card',
  card_id: 'split_demo',
  height: 'calc(100vh - 16px)',
  view_mode: '2d',
  effects: 'off',
  floors: [
    {
      id: 'f0',
      name: 'EG',
      rooms: [
        { id: 'wohnen', name: 'Wohnen', points: [[0, 0], [700, 0], [700, 450], [0, 450]], lights: ['light.demo_a'], floor: { type: 'planks' } },
        { id: 'bad', name: 'Bad', points: [[700, 0], [950, 0], [950, 450], [700, 450]] },
      ],
      devices: [],
      openings: [{ id: 'win', type: 'window', a: [600, 0], b: [680, 0] }, { id: 'dbad', type: 'door', a: [700, 200], b: [700, 290] }],
      furniture: [
        { id: 'sofa', kind: 'sofa', x: 200, y: 250, w: 200, h: 90, rotation: 0 },
        { id: 'tisch', kind: 'dining_table', x: 600, y: 250, w: 120, h: 80, rotation: 0 },
      ],
    },
  ],
};
for (const scheme of ['light', 'dark']) {
  const m = await openMock({ config, size: '1280x860', scheme });
  const { page } = m;
  await wait(900);
  const ED = `document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui')`;
  const E = (expr) => page.evaluate(`(() => { const ed = ${ED}; return ${expr}; })()`);
  await m.card(`(card.openEditor(), true)`);
  await wait(1800);
  ok(await E(`!!ed.shadowRoot.querySelector('.tool[data-tool="split"]')`), `${scheme}: toolbar "Raum teilen"`);
  await E(`(ed.shadowRoot.querySelector('.tool[data-tool="split"]').click(), true)`);
  await wait(200);
  const hint = await E(`ed.shadowRoot.querySelector('.split-hint')?.textContent ?? ''`);
  ok(hint.includes('Ohne Wand') && hint.includes('Mit Wand'), `${scheme}: hint with "Ohne Wand (offen)" / "Mit Wand"`, hint);
  ok(await E(`ed.shadowRoot.querySelector('[data-split-wall="open"]').getAttribute('aria-pressed') === 'true'`), `${scheme}: open (no wall) is the default`);
  // a line that stops in the middle: refused, nothing changes
  await E(`(ed.onTap({ kind: 'room', id: 'wohnen' }, [100, 200]), ed.onTap({ kind: 'room', id: 'wohnen' }, [300, 200]), true)`);
  await wait(200);
  ok((await E(`ed.floor.rooms.length`)) === 2, `${scheme}: line not crossing the room – refused`);
  // the open kitchen: cut at x = 480, top wall to bottom wall
  await E(`(ed._tool = 'split', ed.onTap({ kind: 'room', id: 'wohnen' }, [480, 0]), true)`);
  await wait(150);
  if (out) {
    await E(`(ed.handlers.onHover([480, 450]), true)`);
    await wait(150);
    await page.screenshot({ path: `${out}/split-line-${scheme}.png` });
  }
  await E(`(ed.onTap({ kind: 'room', id: 'wohnen' }, [480, 450]), true)`);
  await wait(400);
  const st = await E(`(() => { const f = ed.floor; const r = (id) => f.rooms.find((x) => x.id === id); const n = f.rooms.find((x) => !['wohnen', 'bad'].includes(x.id)); return { rooms: f.rooms.length, wohnen: r('wohnen').points, lights: r('wohnen').lights, neu: n && { name: n.name, points: n.points, floor: n.floor, lights: n.lights }, sel: ed._sel, pass: (f.openings ?? []).filter((o) => o.type === 'passage').map((o) => [o.a, o.b]), win: (f.openings ?? []).some((o) => o.id === 'win'), door: (f.openings ?? []).some((o) => o.id === 'dbad') }; })()`);
  ok(st.rooms === 3 && st.neu, `${scheme}: one more room`, st);
  ok(Math.round(area(st.wohnen)) === 480 * 450 && st.lights?.[0] === 'light.demo_a', `${scheme}: the larger part keeps the room (4.8 m wide) and its lights`, st);
  ok(st.neu && st.neu.name === 'Küche' && Math.round(area(st.neu.points)) === 220 * 450 && st.neu.floor?.type === 'planks' && !st.neu.lights, `${scheme}: the new part: "Küche", 2.2 m, same floor, no devices of its own yet`, st.neu);
  ok(st.sel?.kind === 'room' && st.sel.id !== 'wohnen', `${scheme}: the new room is selected (to name it)`, st.sel);
  ok(st.pass.length === 1 && st.pass[0][0][0] === 480 && st.pass[0][1][0] === 480, `${scheme}: open: a passage on the cut`, st.pass);
  ok(st.win && st.door, `${scheme}: window and door on the outer walls stay`);
  const between = await E(`(() => { const ps = ed.card.constructor ? null : null; return null; })()`);
  void between;
  const inside = await E(`(() => { const f = ed.floor; const n = f.rooms.find((x) => !['wohnen', 'bad'].includes(x.id)); const pip = (p, pts) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, yi] = pts[i]; const [xj, yj] = pts[j]; if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c; } return c; }; return { sofa: pip([200, 250], f.rooms.find((x) => x.id === 'wohnen').points), tisch: pip([600, 250], n.points), moved: f.furniture.find((x) => x.id === 'tisch').x }; })()`);
  ok(inside.sofa && inside.tisch && inside.moved === 600, `${scheme}: furniture stays where it is – the sofa in Wohnen, the table in the kitchen`, inside);
  if (out) await page.screenshot({ path: `${out}/split-open-${scheme}.png` });
  // undo: one room again
  await E(`(ed.undo(), true)`);
  await wait(250);
  ok((await E(`ed.floor.rooms.length`)) === 2 && !(await E(`(ed.floor.openings ?? []).some((o) => o.type === 'passage')`)), `${scheme}: undo – one room, no passage`);
  // with a wall, from the room's inspector
  await E(`(ed.select({ kind: 'room', id: 'wohnen' }), true)`);
  await wait(300);
  ok(await E(`!!ed.shadowRoot.querySelector('[data-split-room]')`), `${scheme}: room inspector: "Raum teilen …"`);
  await E(`(ed.shadowRoot.querySelector('[data-split-room]').click(), true)`);
  await wait(200);
  ok((await E(`ed._tool`)) === 'split', `${scheme}: it switches the tool on`);
  await E(`(ed.shadowRoot.querySelector('[data-split-wall="wall"]').click(), true)`);
  await wait(100);
  await E(`(ed.onTap({ kind: 'room', id: 'wohnen' }, [0, 300]), ed.onTap({ kind: 'room', id: 'wohnen' }, [700, 300]), true)`);
  await wait(400);
  const w = await E(`(() => { const f = ed.floor; return { rooms: f.rooms.length, pass: (f.openings ?? []).filter((o) => o.type === 'passage').length }; })()`);
  ok(w.rooms === 3 && w.pass === 0, `${scheme}: with a wall – a room more, no passage (the shared edge is a wall)`, w);
  await E(`(ed.undo(), true)`);
  await wait(250);
  // join Wohnen and Bad
  await E(`(ed.select({ kind: 'room', id: 'wohnen' }), true)`);
  await wait(300);
  ok(await E(`!!ed.shadowRoot.querySelector('[data-merge-room="bad"]')`), `${scheme}: room inspector: "Mit „Bad“ zusammenlegen"`);
  await E(`(ed.shadowRoot.querySelector('[data-merge-room="bad"]').click(), true)`);
  await wait(400);
  const j = await E(`(() => { const f = ed.floor; return { rooms: f.rooms.map((r) => r.id), pts: f.rooms[0].points, door: (f.openings ?? []).some((o) => o.id === 'dbad'), win: (f.openings ?? []).some((o) => o.id === 'win') }; })()`);
  ok(j.rooms.length === 1 && j.rooms[0] === 'wohnen' && Math.round(area(j.pts)) === 950 * 450 && j.pts.length === 4, `${scheme}: joined – one room of 9.5 × 4.5 m`, j);
  ok(!j.door && j.win, `${scheme}: the door on the former wall goes, the window stays`, j);
  await E(`(ed.undo(), true)`);
  await wait(250);
  ok((await E(`ed.floor.rooms.length`)) === 2, `${scheme}: undo – two rooms again`);
  ok((await m.card(`card.rawConfig.floors[0].rooms.length`)) === 2, `${scheme}: nothing saved (draft only)`);
  errs.push(...m.errors.filter((e) => !/GL Driver|GPU stall/.test(e)));
  await m.browser.close();
}
ok(!errs.length, 'no page errors or warnings', errs);
console.log(fails ? `\n${fails} FAIL` : '\nall ok');
process.exit(fails ? 1 : 0);
