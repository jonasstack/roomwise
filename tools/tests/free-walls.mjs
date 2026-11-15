// "Wand ziehen": walls standing on their own (partition, half-height wall, room divider) without drawing a room.
// Logic: they are wall pieces like any other (a door cuts them, the dog walks around them), plan files keep them.
// Editor: the tool draws a polyline (one piece per tap), the last piece is selected; thickness, height (half),
// paint in the inspector; undo; its ends snap. 2D a wall line; 3D a half-height wall at its own height.
// Mock harness, nothing saved.
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/free-walls.mjs [outDir]
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

// ---------- logic ----------
{
  const r = await esbuild.build({
    stdin: { contents: "export { wallPieces } from './src/walls'; export { buildNav, findPath } from './src/petnav'; export { planFile, readPlanFile, normalizeConfig } from './src/config';", resolveDir: process.cwd(), loader: 'ts' },
    bundle: true,
    format: 'esm',
    write: false,
    platform: 'node',
    logLevel: 'silent',
  });
  const g = await import('data:text/javascript;base64,' + Buffer.from(r.outputFiles[0].text).toString('base64'));
  const room = { id: 'r', name: 'Wohnen', points: [[0, 0], [600, 0], [600, 400], [0, 400]] };
  const wall = { id: 'w1', a: [300, 0], b: [300, 280], height: 110 };
  const floor = { id: 'f', name: 'EG', rooms: [room], devices: [], openings: [], walls: [wall] };
  const free = g.wallPieces(floor).filter((p) => p.free);
  ok(free.length === 1 && free[0].kind === 'wall' && free[0].free.height === 110 && free[0].front?.id === 'r', 'a free wall is a wall piece (inside the room, its height along)', free);
  const withDoor = { ...floor, openings: [{ id: 'd', type: 'door', a: [300, 100], b: [300, 180] }] };
  const cut = g.wallPieces(withDoor).filter((p) => p.free);
  ok(cut.length === 3 && cut.some((p) => p.kind === 'door'), 'a door on a free wall cuts it (wall, door, wall)', cut.map((p) => p.kind));
  const pathOf = (f) => {
    const nav = g.buildNav(f, () => undefined, false, 16, false);
    return nav ? g.findPath(nav, [150, 100], [450, 100]) : undefined;
  };
  const open = pathOf({ ...floor, walls: [] });
  const around = pathOf(floor);
  ok(open && Math.max(...open.map((p) => p[1])) < 200, 'dog without the wall: straight across', open);
  ok(around && Math.max(...around.map((p) => p[1])) > 280, 'dog with the wall: around its end', around);
  const cfg = g.normalizeConfig({ type: 'custom:floorplan-card', floors: [floor] });
  const file = g.planFile(cfg);
  const back = g.readPlanFile(JSON.parse(JSON.stringify(file)), cfg);
  ok(back.config?.floors[0].walls?.[0]?.height === 110 && !back.errors.length, 'plan file: exported and read back with the free wall', back.errors);
  const bad = g.readPlanFile({ ...file, config: { ...file.config, floors: [{ ...file.config.floors[0], walls: [{ id: 'x', a: [0, 0] }] }] } }, cfg);
  ok(bad.errors.length > 0, 'plan file: a wall without an end is refused', bad.errors);
}

// ---------- editor + plan ----------
const config = {
  type: 'custom:floorplan-card',
  card_id: 'freewall_demo',
  height: 'calc(100vh - 16px)',
  view_mode: '2d',
  effects: 'off',
  floors: [{ id: 'f0', name: 'EG', rooms: [{ id: 'wohnen', name: 'Wohnen', points: [[0, 0], [700, 0], [700, 450], [0, 450]] }], devices: [], openings: [] }],
};
const plan = `window.__fpCard.shadowRoot.querySelector('fp-plan')`;
for (const scheme of ['light', 'dark']) {
  const m = await openMock({ config, size: '1280x860', scheme });
  const { page } = m;
  await wait(900);
  const ED = `document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui')`;
  const E = (expr) => page.evaluate(`(() => { const ed = ${ED}; return ${expr}; })()`);
  await m.card(`(card.openEditor(), true)`);
  await wait(1800);
  ok(await E(`!!ed.shadowRoot.querySelector('.tool[data-tool="wall"]')`), `${scheme}: toolbar "Wand ziehen"`);
  await E(`(ed.shadowRoot.querySelector('.tool[data-tool="wall"]').click(), true)`);
  await wait(200);
  // a polyline: three taps = two pieces, then "Fertig"
  await E(`(ed.onTap({ kind: 'room', id: 'wohnen' }, [400, 0]), ed.onTap({ kind: 'room', id: 'wohnen' }, [400, 240]), ed.onTap({ kind: 'room', id: 'wohnen' }, [560, 240]), true)`);
  await wait(200);
  const ws = await E(`(ed.floor.walls ?? []).map((w) => [w.a, w.b])`);
  ok(ws.length === 2 && ws[0][0][0] === 400 && ws[0][0][1] === 0 && ws[0][1][1] === 240 && ws[1][1][0] === 560, `${scheme}: two straight pieces, joined, snapped to the wall`, ws);
  if (out) await page.screenshot({ path: `${out}/freewall-draw-${scheme}.png` });
  await E(`(ed.shadowRoot.querySelector('[data-wall-finish]').click(), true)`);
  await wait(300);
  const sel = await E(`ed._sel`);
  ok(sel?.kind === 'wall' && (await E(`ed._tool`)) === 'select', `${scheme}: done – the last piece is selected`, sel);
  const insp = await E(`ed.shadowRoot.textContent`);
  ok(insp.includes('Freie Wand') && insp.includes('Dicke') && insp.includes('Volle Höhe') && insp.includes('Halbhoch'), `${scheme}: inspector: length, thickness, full or half height`);
  await E(`(ed.shadowRoot.querySelector('fp-segmented[data-wall-height]').dispatchEvent(new CustomEvent('value-change', { detail: { value: 'half' } })), true)`);
  await wait(200);
  ok((await E(`ed.floor.walls[1].height`)) === 110, `${scheme}: half height: 110 cm`);
  // selecting by a tap on it, deleting, undo
  await E(`(ed.select(null), ed.onTap({ kind: 'room', id: 'wohnen' }, [402, 120]), true)`);
  await wait(200);
  ok((await E(`ed._sel?.kind === 'wall' && ed._sel.id === ed.floor.walls[0].id`)), `${scheme}: a tap on the wall selects it (not the room)`);
  await E(`(ed.deleteSelection(), true)`);
  await wait(150);
  ok((await E(`ed.floor.walls.length`)) === 1, `${scheme}: deleted`);
  await E(`(ed.undo(), true)`);
  await wait(150);
  ok((await E(`ed.floor.walls.length`)) === 2, `${scheme}: undo – back`);
  // a door on a free wall
  await E(`(ed._tool = 'door', ed.onTap({ kind: 'room', id: 'wohnen' }, [401, 120]), true)`);
  await wait(200);
  const door = await E(`(ed.floor.openings ?? []).find((o) => o.type === 'door')`);
  ok(door && Math.abs(door.a[0] - 400) < 1 && Math.abs(door.b[0] - 400) < 1, `${scheme}: a door can go on a free wall`, door);
  ok(!(await m.card(`(card.rawConfig.floors[0].walls ?? []).length`)), `${scheme}: nothing saved (draft only)`);
  await m.card(`(card.ensureLayer().closeEditor(), true)`);
  await wait(500);
  // the plan: 2D line, 3D half-height wall
  const W = [{ id: 'fw1', a: [400, 0], b: [400, 250] }, { id: 'fw2', a: [400, 250], b: [600, 250], height: 110 }];
  await m.card(`(card.setConfig({ ...card.rawConfig, view_mode: '2d', floors: [{ ...card.rawConfig.floors[0], walls: ${JSON.stringify(W)} }] }), true)`);
  await wait(900);
  const two = await page.evaluate(`(() => { const r = ${plan}.shadowRoot; return { lines: r.querySelectorAll('.walls line.wall.free').length, half: r.querySelectorAll('.walls line.wall.free.half').length }; })()`);
  ok(two.lines === 2 && two.half === 1, `${scheme}: 2D: two wall lines, the half-height one lighter`, two);
  if (out) await page.screenshot({ path: `${out}/freewall-2d-${scheme}.png` });
  await m.card(`(card.setConfig({ ...card.rawConfig, view_mode: undefined, wall_height: 250, floors: [{ ...card.rawConfig.floors[0], walls: ${JSON.stringify(W)} }] }), true)`);
  await wait(3500);
  const h3 = await page.evaluate(`(() => { const p = ${plan}; if (!p.gl) return null; const zs = new Set(); p.gl.walls.updateMatrixWorld(true); p.gl.walls.traverse((o) => { if (!o.isMesh) return; const pos = o.geometry.attributes.position; const e = o.matrixWorld.elements; for (let i = 0; i < pos.count; i++) { const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i); zs.add(Math.round(e[2] * x + e[6] * y + e[10] * z + e[14])); } }); return [...zs].sort((a, b) => a - b); })()`);
  ok(h3 === null || h3.includes(110), `${scheme}: 3D: the half-height wall stands 110 cm high (${JSON.stringify(h3)})`);
  if (out) await page.screenshot({ path: `${out}/freewall-3d-${scheme}.png` });
  errs.push(...m.errors.filter((e) => !/GL Driver|GPU stall/.test(e)));
  await m.browser.close();
}
ok(!errs.length, 'no page errors or warnings', errs);
console.log(fails ? `\n${fails} FAIL` : '\nall ok');
process.exit(fails ? 1 : 0);
