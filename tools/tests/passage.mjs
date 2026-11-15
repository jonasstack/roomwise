// Passages ("Wand weg"): an open way between two rooms – no wall there in 2D or 3D. The editor tool opens the wall
// a tap hits over its whole length; a room's inspector removes the wall to a neighbouring room and puts it back;
// undo works; an outer wall is not offered; the dog's way to the front door goes through a passage.
// Mock harness, nothing saved.
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/passage.mjs [outDir]
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

// ---------- logic: walls, shared walls, the dog's way ----------
{
  const r = await esbuild.build({
    stdin: { contents: "export { wallPieces, sharedWalls, passagesBetween } from './src/walls'; export { wayToDoor } from './src/pets';", resolveDir: process.cwd(), loader: 'ts' },
    bundle: true,
    format: 'esm',
    write: false,
    platform: 'node',
    logLevel: 'silent',
  });
  const mod = await import('data:text/javascript;base64,' + Buffer.from(r.outputFiles[0].text).toString('base64'));
  const rooms = [
    { id: 'wohnen', name: 'Wohnen', points: [[0, 0], [500, 0], [500, 400], [0, 400]] },
    { id: 'kueche', name: 'Küche', points: [[500, 0], [900, 0], [900, 400], [500, 400]] },
    { id: 'flur', name: 'Flur', points: [[900, 0], [1100, 0], [1100, 400], [900, 400]] },
  ];
  const front = { id: 'fd', type: 'door', a: [1100, 150], b: [1100, 240] };
  const base = { id: 'f', name: 'EG', rooms, devices: [], openings: [front, { id: 'd2', type: 'door', a: [900, 150], b: [900, 240] }] };
  const between = (f) => mod.wallPieces(f).filter((p) => Math.abs(p.a[0] - 500) < 1 && Math.abs(p.b[0] - 500) < 1);
  ok(between(base).length === 1 && between(base)[0].kind === 'wall', 'without a passage: a wall between Wohnen and Küche');
  const runs = mod.sharedWalls(base, 'wohnen', 'kueche');
  ok(runs.length === 1 && Math.abs(Math.hypot(runs[0][1][0] - runs[0][0][0], runs[0][1][1] - runs[0][0][1]) - 400) < 1, 'shared wall: one run of 400 cm', runs);
  const open = { ...base, openings: [...base.openings, { id: 'p', type: 'passage', a: runs[0][0], b: runs[0][1] }] };
  ok(between(open).length === 0, 'passage over the whole wall: no wall piece left there (no wall, frame or lintel)', between(open));
  ok(mod.passagesBetween(open, 'kueche', 'wohnen').length === 1, 'passagesBetween finds it (either order)');
  const half = { ...base, openings: [...base.openings, { id: 'p', type: 'passage', a: [500, 100], b: [500, 300] }] };
  const hp = between(half);
  ok(hp.length === 2 && hp.every((p) => p.kind === 'wall'), 'a 2 m passage: wall stays left and right of it', hp.map((p) => [p.a, p.b]));
  // the dog's way from Wohnen to the front door: through the passage, then the door
  const way = mod.wayToDoor(open, [100, 200], front);
  ok(way && way.path.length >= 4 && way.path.some((p) => Math.abs(p[0] - 500) < 40), 'dog: the way to the front door goes through the passage', way?.path);
  const noWay = mod.wayToDoor(base, [100, 200], front);
  ok(noWay && !noWay.path.some((p) => Math.abs(p[0] - 500) < 40), 'without it: no way through the wall');
}

// ---------- card + editor ----------
const room = (id, name, x0, x1) => ({ id, name, points: [[x0, 0], [x1, 0], [x1, 400], [x0, 400]] });
const config = {
  type: 'custom:floorplan-card',
  card_id: 'passage_demo',
  height: 'calc(100vh - 16px)',
  view_mode: '2d',
  effects: 'off',
  floors: [{ id: 'f0', name: 'EG', rooms: [room('wohnen', 'Wohnen', 0, 500), room('kueche', 'Küche', 500, 900)], devices: [], openings: [] }],
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
  ok(await E(`!!ed.shadowRoot.querySelector('.tool[data-tool="passage"]')`), `${scheme}: toolbar "Durchgang (Wand weg)"`);
  await E(`(ed.shadowRoot.querySelector('.tool[data-tool="passage"]').click(), true)`);
  await wait(200);
  ok((await E(`ed.shadowRoot.querySelector('.hint')?.textContent ?? ''`)).includes('Wand zwischen zwei Räumen'), `${scheme}: hint where to tap`);
  // outer wall: not offered
  await E(`(ed.onTap({ kind: 'background' }, [250, 2]), true)`);
  await wait(200);
  ok((await E(`(ed.floor.openings ?? []).length`)) === 0, `${scheme}: tap on an outer wall – nothing (only between two rooms)`);
  // the shared wall: opened over its whole length
  await E(`(ed._tool = 'passage', ed.onTap({ kind: 'room', id: 'wohnen' }, [499, 200]), true)`);
  await wait(300);
  const op = await E(`(() => { const o = (ed.floor.openings ?? [])[0]; return o && { type: o.type, a: o.a, b: o.b, sel: ed._sel?.id === o.id, tool: ed._tool }; })()`);
  ok(op && op.type === 'passage' && Math.abs(Math.hypot(op.b[0] - op.a[0], op.b[1] - op.a[1]) - 400) < 1 && op.sel && op.tool === 'select', `${scheme}: tap on the shared wall → a passage over the whole 4 m, selected`, op);
  const insp = await E(`ed.shadowRoot.textContent`);
  ok(insp.includes('Hier steht keine Wand') && insp.includes('Wand wieder einsetzen'), `${scheme}: inspector: what it is, width, "Wand wieder einsetzen"`);
  if (out) await page.screenshot({ path: `${out}/passage-editor-${scheme}.png` });
  await E(`(ed.undo(), true)`);
  await wait(200);
  ok((await E(`(ed.floor.openings ?? []).length`)) === 0, `${scheme}: undo – the wall is back`);
  // the room's inspector: "Wand zu „Küche“ entfernen" and back
  await E(`(ed.select({ kind: 'room', id: 'wohnen' }), true)`);
  await wait(300);
  ok(await E(`!!ed.shadowRoot.querySelector('[data-wall-remove="kueche"]')`), `${scheme}: room inspector offers "Wand zu „Küche“ entfernen"`);
  await E(`(ed.shadowRoot.querySelector('[data-wall-remove="kueche"]').click(), true)`);
  await wait(300);
  ok((await E(`(ed.floor.openings ?? []).filter((o) => o.type === 'passage').length`)) === 1, `${scheme}: removed – one passage`);
  ok(await E(`!!ed.shadowRoot.querySelector('[data-wall-back="kueche"]')`), `${scheme}: then "Wand zu „Küche“ wieder einsetzen"`);
  await E(`(ed.shadowRoot.querySelector('[data-wall-back="kueche"]').click(), true)`);
  await wait(300);
  ok((await E(`(ed.floor.openings ?? []).filter((o) => o.type === 'passage').length`)) === 0, `${scheme}: put back – no passage`);
  ok(!(await m.card(`(card.rawConfig.floors[0].openings ?? []).length`)), `${scheme}: nothing saved (draft only)`);
  await m.card(`(card.ensureLayer().closeEditor(), true)`);
  await wait(600);
  // the card with a passage: 2D gap and threshold, 3D one wall piece less
  const set = (ops, view) => m.card(`(card.setConfig({ ...card.rawConfig, view_mode: ${view ? `'${view}'` : 'undefined'}, floors: [{ ...card.rawConfig.floors[0], openings: ${JSON.stringify(ops)} }] }), true)`);
  const P = [{ id: 'p1', type: 'passage', a: [500, 0], b: [500, 400] }];
  await set(P, '2d');
  await wait(900);
  const p2 = await page.evaluate(`(() => { const r = ${plan}.shadowRoot; return { mask: r.querySelectorAll('#fp-wall-mask line').length, threshold: !!r.querySelector('.opening.passage .threshold'), hit: !!r.querySelector('.opening.passage .hit') }; })()`);
  ok(p2.mask >= 1 && p2.threshold && !p2.hit, `${scheme}: 2D: the wall is cut out, a faint threshold line, not tappable outside the editor`, p2);
  if (out) await page.screenshot({ path: `${out}/passage-2d-${scheme}.png` });
  const count3d = async (ops) => {
    await set(ops);
    await wait(3000);
    return page.evaluate(`(() => { const p = ${plan}; if (!p.gl) return -1; let n = 0; p.gl.walls.traverse((o) => { if (o.isMesh) n += (o.count ?? 1) * (o.geometry.attributes.position?.count ?? 0); }); return n; })()`);
  };
  const withP = await count3d(P);
  if (out) await page.screenshot({ path: `${out}/passage-3d-${scheme}.png` });
  const without = await count3d([]);
  ok(withP > 0 && without > 0 && withP < without, `${scheme}: 3D: no wall where the passage is (${withP} wall vertices, ${without} without it)`);
  errs.push(...m.errors.filter((e) => !/GL Driver|GPU stall/.test(e)));
  await m.browser.close();
}
ok(!errs.length, 'no page errors or warnings', errs);
console.log(fails ? `\n${fails} FAIL` : '\nall ok');
process.exit(fails ? 1 : 0);
