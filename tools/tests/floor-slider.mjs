// The floor picker at rest is only a slim strip on the right edge (a dot per floor), so the plan uses the space;
// touching / dragging / hovering it or focusing it with the keyboard opens the wheel over the plan, which folds back
// shortly after. The floor the card shows on opening is set in the editor (Darstellung, or per floor); a start floor
// per person wins. Mock harness, nothing saved.
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/floor-slider.mjs [outDir]
import { openMock } from './mock.mjs';

const out = process.argv[2];
let fails = 0;
const ok = (c, m, extra) => {
  if (!c) fails++;
  console.log(c ? '• ok:' : '• FAIL:', m, !c && extra !== undefined ? JSON.stringify(extra).slice(0, 400) : '');
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const errs = [];
const sq = (id, name, x, y) => ({ id, name, points: [[x, y], [x + 400, y], [x + 400, y + 300], [x, y + 300]] });
const floors = [
  { id: 'eg', name: 'Erdgeschoss', level: 0, rooms: [sq('w', 'Wohnzimmer', 0, 0), sq('k', 'Küche', 400, 0)], devices: [] },
  { id: 'og', name: 'Obergeschoss', level: 1, rooms: [sq('s', 'Schlafzimmer', 0, 0), sq('b', 'Bad', 400, 0)], devices: [] },
];
const base = { type: 'custom:floorplan-card', card_id: 'floor_slider', height: 'calc(100vh - 16px)', view_mode: '2d', effects: 'off' };
const SL = `window.__fpCard.shadowRoot.querySelector('fp-floor-slider')`;
const PLAN = `window.__fpCard.shadowRoot.querySelector('fp-plan')`;

// ---- the floor on opening
{
  const m = await openMock({ config: { ...base, floors, default_floor: 'og' } });
  await wait(900);
  ok((await m.card('card._floorId')) === 'og', 'default_floor: the card opens on "Obergeschoss"');
  errs.push(...m.errors);
  await m.browser.close();
}
{
  const m = await openMock({ config: { ...base, floors, default_floor: 'og', users: { demo: { floor: 'eg' } } } });
  await wait(900);
  ok((await m.card('card._floorId')) === 'eg', "a person's start floor wins over the card's");
  errs.push(...m.errors);
  await m.browser.close();
}

// ---- the slim strip, opening and folding
for (const [size, scheme] of [['1280x800', 'light'], ['390x844', 'dark']]) {
  const m = await openMock({ config: { ...base, floors }, size, scheme, touch: size.startsWith('390') });
  const { page } = m;
  await wait(1000);
  const box = (sel) => page.evaluate(`(() => { const e = ${SL}.shadowRoot.querySelector('${sel}'); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, op: getComputedStyle(e).opacity }; })()`);
  const host = await page.evaluate(`(() => { const r = ${SL}.getBoundingClientRect(); return { w: r.width, x: r.x }; })()`);
  ok(host.w > 0 && host.w <= 14, `${size}: at rest only a slim strip (${host.w}px)`, host);
  ok((await box('.pill')).op === '0' && !(await page.evaluate(`${SL}.open`)), `${size}: the wheel is folded away`);
  const inset = await page.evaluate(`${PLAN}.insetRight`);
  ok(inset > 0 && inset <= 40, `${size}: the plan keeps only the strip clear (insetRight ${inset})`, inset);
  if (out) await page.screenshot({ path: `${out}/floor-slider-rest-${size}-${scheme}.png` });

  // drag on the strip: opens, moves to the other floor, folds back later
  const hit = await box('.hit');
  const cx = hit.x + hit.w / 2;
  const cy = hit.y + hit.h / 2;
  const before = await m.card('card._floorId');
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy + 20, { steps: 3 });
  ok(await page.evaluate(`${SL}.open`), `${size}: dragging the strip opens the wheel`);
  await page.mouse.move(cx, cy + 70, { steps: 6 });
  if (out) await page.screenshot({ path: `${out}/floor-slider-drag-${size}-${scheme}.png` });
  await page.mouse.up();
  await wait(900);
  const after = await m.card('card._floorId');
  ok(after !== before, `${size}: dragging changes the floor (${before} → ${after})`);
  await page.mouse.move(10, 10);
  await wait(2200);
  ok(!(await page.evaluate(`${SL}.open`)), `${size}: folds back after letting go`);

  // a tap on the strip only opens it
  const now = await m.card('card._floorId');
  await page.mouse.click(cx, cy);
  await wait(300);
  ok((await page.evaluate(`${SL}.open`)) && (await m.card('card._floorId')) === now, `${size}: a tap on the strip opens it without changing the floor`);
  // then a tap on a row of the wheel picks it
  const pill = await box('.pill');
  const target = now === 'og' ? 1 : -1; // rows: top floor first
  await page.mouse.click(pill.x + pill.w / 2, pill.y + pill.h / 2 + target * (size.startsWith('390') ? 40 : 44));
  await wait(900);
  ok((await m.card('card._floorId')) !== now, `${size}: a tap on a row of the open wheel picks that floor`);
  await page.mouse.move(10, 10);
  await wait(3000);

  // keyboard: focus opens it, arrows change the floor
  const k0 = await m.card('card._floorId');
  // keyboard: tab through until the floor picker has the focus
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(`${SL}.shadowRoot.activeElement?.classList.contains('pill') ?? false`)) break;
  }
  await wait(200);
  ok(await page.evaluate(`${SL}.open`), `${size}: keyboard focus opens the wheel`);
  await page.keyboard.press(k0 === 'og' ? 'ArrowDown' : 'ArrowUp');
  await wait(900);
  ok((await m.card('card._floorId')) !== k0, `${size}: arrow keys change the floor`);
  ok((await page.evaluate(`${SL}.shadowRoot.querySelector('.pill').getAttribute('role')`)) === 'slider', `${size}: still a slider for screen readers`);
  errs.push(...m.errors);
  await m.browser.close();
}

// ---- the plan is bigger than with the full-width wheel reserved
{
  const m = await openMock({ config: { ...base, floors } });
  await wait(1000);
  const s1 = await m.page.evaluate(`${PLAN}.panZoom.fit.s`);
  const s0 = await m.page.evaluate(`(() => { const p = ${PLAN}; const pz = p.panZoom; const keep = pz.insetRight; pz.insetRight = 120; pz.computeFit(); const s = pz.fit.s; pz.insetRight = keep; pz.computeFit(); return s; })()`);
  ok(s1 > s0, `the plan fits bigger with the slim strip (scale ${s1.toFixed(3)} vs ${s0.toFixed(3)} with a 96 px wheel reserved, +${Math.round((s1 / s0 - 1) * 100)} %)`);
  errs.push(...m.errors);
  await m.browser.close();
}

ok(!errs.length, 'no page errors or warnings', errs);
console.log(fails ? `\n${fails} FAIL` : '\nall ok');
process.exit(fails ? 1 : 0);
