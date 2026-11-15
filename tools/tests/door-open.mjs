// An open door leaves its passage free in every view: nothing vertical stands between the jambs (the open leaf sits
// at the hinge, lintel and frame head stay above). Covers both hinge sides and both swing directions (interior and
// exterior walls), a door across a split point of its wall (a room corner inside the opening: drawn as one door, no
// jambs in the middle) and a T-junction inside the opening (the other wall stops at the door wall's face).
// Mock harness, no Home Assistant.
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/door-open.mjs [outDir]
import { openMock } from './mock.mjs';
import { KNOWN } from '../pw.mjs';

const out = process.argv[2] ?? '/tmp';
let fails = 0;
const ok = (c, m) => {
  if (!c) fails++;
  console.log(c ? '• ok:' : '• FAIL:', m);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

const doors = [
  { id: 'd1', type: 'door', a: [300, 100], b: [300, 190], entity: 'binary_sensor.demo_door_1' },
  { id: 'd2', type: 'door', a: [60, 300], b: [150, 300], hinge_b: true, entity: 'binary_sensor.demo_door_2' },
  { id: 'd3', type: 'door', a: [400, 300], b: [490, 300], flip: true, entity: 'binary_sensor.demo_door_3' },
  { id: 'd4', type: 'door', a: [0, 400], b: [0, 490], hinge_b: true, flip: true, entity: 'binary_sensor.demo_door_4' },
  // the kitchen's east wall has a corner point at (600, 145): the wall is split inside this door
  { id: 'd5', type: 'door', a: [600, 100], b: [600, 190], entity: 'binary_sensor.demo_door_5' },
  // the wall between the two south rooms (x = 250) meets the living room's south wall inside this door
  { id: 'd6', type: 'door', a: [205, 600], b: [295, 600], entity: 'binary_sensor.demo_door_6' },
];
const cfg = {
  title: 'Demo',
  floors: [
    {
      id: 'eg',
      name: 'EG',
      rooms: [
        { id: 'hall', name: 'Flur', points: rect(0, 0, 300, 300) },
        { id: 'kitchen', name: 'Küche', points: [[300, 0], [600, 0], [600, 145], [600, 300], [300, 300]] },
        { id: 'living', name: 'Wohnen', points: rect(0, 300, 600, 600) },
        { id: 'bath', name: 'Bad', points: rect(0, 600, 250, 800) },
        { id: 'office', name: 'Büro', points: rect(250, 600, 600, 800) },
      ],
      openings: doors,
      furniture: [],
      devices: [],
    },
  ],
};
const doorStates = (s) => Object.fromEntries(doors.map((d) => [d.entity, { state: s, attributes: { device_class: 'door' } }]));

/**
 * WebGL: wall geometry straight over points of each door's passage (between the jambs, along and across the wall),
 * probed with vertical rays against every wall triangle (merged or not) in plan coordinates: the highest hit (the
 * lintel's top) and the lowest (a free passage: the frame head's underside; anything standing in it: near the floor).
 */
const probeGl = (m) =>
  m.card(`(() => {
    const walls = plan.glScene?.walls;
    if (!walls) return null;
    walls.updateMatrixWorld(true);
    const inv = walls.matrixWorld.clone().invert();
    const tris = [];
    walls.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      const mat = inv.clone().multiply(o.matrixWorld).elements;
      const pos = o.geometry.attributes.position;
      const idx = o.geometry.index;
      const n = idx ? idx.count : pos.count;
      const v = (i) => {
        const k = idx ? idx.getX(i) : i;
        const x = pos.getX(k), y = pos.getY(k), z = pos.getZ(k);
        return [mat[0] * x + mat[4] * y + mat[8] * z + mat[12], mat[1] * x + mat[5] * y + mat[9] * z + mat[13], mat[2] * x + mat[6] * y + mat[10] * z + mat[14]];
      };
      for (let i = 0; i + 2 < n; i += 3) tris.push([v(i), v(i + 1), v(i + 2)]);
    });
    const hits = (x, y) => {
      let top = -Infinity, low = Infinity;
      for (const [a, b, c] of tris) {
        const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
        if (Math.abs(d) < 1e-9) continue;
        const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d;
        const l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
        const l3 = 1 - l1 - l2;
        if (l1 < 0 || l2 < 0 || l3 < 0) continue;
        const z = l1 * a[2] + l2 * b[2] + l3 * c[2];
        top = Math.max(top, z);
        low = Math.min(low, z);
      }
      return [top, low];
    };
    const doors = ${JSON.stringify(doors)};
    const res = {};
    for (const d of doors) {
      const dx = d.b[0] - d.a[0], dy = d.b[1] - d.a[1];
      const L = Math.hypot(dx, dy);
      const nx = -dy / L, ny = dx / L;
      let top = -Infinity, low = Infinity;
      for (const t of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) for (const s of [-2, 0, 2]) {
        const [hi, lo] = hits(d.a[0] + dx * t + nx * s, d.a[1] + dy * t + ny * s);
        top = Math.max(top, hi);
        low = Math.min(low, lo);
      }
      res[d.id] = { top: Math.round(top), low: Math.round(low) };
    }
    return res;
  })()`);

/** 2D: threshold opacity and leaf angle per door */
const look2d = (m) =>
  m.card(`Object.fromEntries([...plan.shadowRoot.querySelectorAll('.opening.door')].map((g) => [g.querySelector('.hit').dataset.opening, { threshold: +getComputedStyle(g.querySelector('.threshold')).opacity, leaf: g.querySelector('.leaf').style.transform }]))`);

const errors = [];
// ---- 2D
{
  const m = await openMock({ config: { ...cfg, view_mode: '2d' }, states: doorStates('on'), size: '1000x800' });
  await wait(1500);
  const open = await look2d(m);
  ok(doors.every((d) => open[d.id]?.threshold === 1 && /rotate\((-)?82deg\)/.test(open[d.id].leaf)), `2D open: threshold in the frame, leaf swung at its hinge (${JSON.stringify(open)})`);
  await m.page.screenshot({ path: `${out}/door-open-2d.png` });
  await m.setStates(doorStates('off'));
  await wait(900);
  const shut = await look2d(m);
  ok(doors.every((d) => shut[d.id]?.threshold === 1 && /rotate\(0deg\)/.test(shut[d.id].leaf)), `2D closed: threshold and leaf in the frame (${JSON.stringify(shut)})`);
  errors.push(...m.errors);
  await m.browser.close();
}
// ---- WebGL 3D
{
  const m = await openMock({ config: { ...cfg, view_mode: '3d', renderer: 'webgl' }, states: doorStates('on'), size: '1000x800' });
  await wait(2500);
  const open = await probeGl(m);
  // free: the lowest thing over the passage is the frame head under the lintel (door top 86 % of the wall height)
  ok(open && doors.every((d) => open[d.id].top > 40 && open[d.id].low >= 0.8 * open[d.id].top), `WebGL open: lintel above, nothing standing in the passage (${JSON.stringify(open)})`);
  await m.page.screenshot({ path: `${out}/door-open-webgl.png` });
  await m.setStates(doorStates('off'));
  await wait(1500);
  const shut = await probeGl(m);
  ok(shut && doors.every((d) => shut[d.id].top > 40 && shut[d.id].low < 5), `WebGL closed: the leaf fills the frame (${JSON.stringify(shut)})`);
  errors.push(...m.errors);
  await m.browser.close();
}
// ---- CSS 3D
{
  const m = await openMock({ config: { ...cfg, view_mode: '3d', renderer: 'css' }, states: doorStates('on'), size: '1000x800' });
  await wait(2000);
  const count = () => m.card(`({ pieces: plan.shadowRoot.querySelectorAll('.p3.wallp').length, leaves: plan.shadowRoot.querySelectorAll('.door3').length })`);
  const open = await count();
  await m.page.screenshot({ path: `${out}/door-open-css3d.png` });
  await m.setStates(doorStates('off'));
  await wait(900);
  const shut = await count();
  ok(open.leaves === doors.length && open.pieces === shut.pieces, `CSS 3D: one leaf per door, lintels stay when open (${JSON.stringify(open)} / closed ${JSON.stringify(shut)})`);
  errors.push(...m.errors);
  await m.browser.close();
}

const errs = errors.filter((e) => !KNOWN.some((r) => r.test(e)) && !/GL Driver Message/.test(e));
ok(!errs.length, errs.length ? `console: ${errs.join(' | ')}` : 'console: no errors or warnings');
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
