// The floors lie stacked: the shown one in full, the one above and the one below faint (3D: floors and low walls in the
// scene; 2D: offset outlines). Moving the focus (slider, stairs, keyboard) only glides the stack – the plan element
// slides and nothing fades out. Outdoor things (car, driveway, garden) show on every floor. Mock harness.
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/floor-stack.mjs [outDir]
import { openMock } from './mock.mjs';

const out = process.argv[2];
let fails = 0;
const ok = (c, m, extra) => {
  if (!c) fails++;
  console.log(c ? '• ok:' : '• FAIL:', m, !c && extra !== undefined ? JSON.stringify(extra).slice(0, 400) : '');
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const errs = [];
const sq = (id, name, x, y, w = 400, h = 300, extra = {}) => ({ id, name, points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], ...extra });
const floors = () => [
  { id: 'og', name: 'Obergeschoss', level: 1, rooms: [sq('s', 'Schlafzimmer', 0, 0), sq('b', 'Bad', 400, 0)], devices: [] },
  {
    id: 'eg',
    name: 'Erdgeschoss',
    level: 0,
    rooms: [sq('w', 'Wohnzimmer', 0, 0), sq('k', 'Küche', 400, 0), sq('drive', 'Einfahrt', 800, 0, 300, 300, { outdoor: true, floor: { type: 'paving' } })],
    devices: [],
    furniture: [{ id: 'car', kind: 'car', variant: 'compact', name: 'Auto', x: 950, y: 150, w: 420, h: 180, rotation: 90 }],
  },
  { id: 'ug', name: 'Keller', level: -1, rooms: [sq('hw', 'Hauswirtschaft', 0, 0), sq('l', 'Lager', 400, 0)], devices: [] },
];
const base = { type: 'custom:floorplan-card', card_id: 'stack_demo', height: 'calc(100vh - 16px)', default_floor: 'eg' };

for (const [view, scheme] of [
  ['2d', 'light'],
  ['3d', 'dark'],
]) {
  const m = await openMock({ config: { ...base, floors: floors(), view_mode: view }, size: '1280x800', scheme });
  const { page } = m;
  await wait(view === '3d' ? 3500 : 1500);
  const stack = await m.card(`(card.shadowRoot.querySelector('fp-plan').stack ?? []).map((s) => [s.floor.id, s.dz])`);
  ok(stack.length === 2 && stack.some(([id, dz]) => id === 'og' && dz > 0) && stack.some(([id, dz]) => id === 'ug' && dz < 0), `${view}: the ground floor has the upper floor above and the basement below in its stack`, stack);
  if (view === '2d') ok(await m.card(`card.shadowRoot.querySelector('fp-plan').shadowRoot.querySelectorAll('.stack-floor').length === 2`), '2d: both drawn as faint offset outlines');
  if (out) await page.screenshot({ path: `${out}/floor-stack-${view}-eg-${scheme}.png` });
  // the focus moves up: the stack glides (a transform animation on the plan, never an opacity fade)
  const anim = m.card(`(() => { const plan = card.shadowRoot.querySelector('fp-plan'); const seen = []; const t0 = performance.now(); const tick = () => { seen.push([plan.style.opacity, plan.getAnimations().map((a) => a.effect.getKeyframes().map((k) => Object.keys(k).filter((x) => !['offset', 'easing', 'composite', 'computedOffset'].includes(x)).join()).join('/')).join('|')]); if (performance.now() - t0 < 2600) requestAnimationFrame(tick); }; tick(); card.goFloor('og'); return new Promise((r) => setTimeout(() => r(seen), 2700)); })()`);
  const seen = await anim;
  ok((await m.card('card._floorId')) === 'og', `${view}: focus on the upper floor`);
  ok(seen.some(([, a]) => /transform/.test(a)) && !seen.some(([o, a]) => /opacity/.test(a) || (o && Number(o) < 1)), `${view}: it glides (transform only, no fading)`, seen.slice(0, 8));
  await wait(400);
  const stack2 = await m.card(`(card.shadowRoot.querySelector('fp-plan').stack ?? []).map((s) => [s.floor.id, s.dz])`);
  ok(stack2.length === 1 && stack2[0][0] === 'eg' && stack2[0][1] < 0, `${view}: on the upper floor the ground floor lies below`, stack2);
  // outdoor things on every floor
  const has = await m.card(`(() => { const f = card.floor; return { car: (f.furniture ?? []).some((x) => x.id === 'car'), drive: f.rooms.some((r) => r.id === 'drive') }; })()`);
  ok(has.car && has.drive, `${view}: the car and the driveway are on the upper floor too`, has);
  if (out) await page.screenshot({ path: `${out}/floor-stack-${view}-og-${scheme}.png` });
  // reduced motion: just switches
  errs.push(...m.errors.filter((e) => !/GL Driver|GPU stall/.test(e)));
  await m.browser.close();
}
{
  const m = await openMock({ config: { ...base, floors: floors(), view_mode: '2d' }, reducedMotion: 'reduce' });
  await wait(1200);
  await m.card(`(card.goFloor('ug'), true)`);
  await wait(300);
  ok((await m.card('card._floorId')) === 'ug' && !(await m.card(`card.shadowRoot.querySelector('fp-plan').getAnimations().length`)), 'reduced motion: switches without gliding');
  errs.push(...m.errors.filter((e) => !/GL Driver|GPU stall/.test(e)));
  await m.browser.close();
}
ok(!errs.length, 'no page errors or warnings', errs);
console.log(fails ? `\n${fails} FAIL` : '\nall ok');
process.exit(fails ? 1 : 0);
