// Several floors: scrolling moves the floor focus. One wheel notch = one floor (wheel up = the floor above), a fast
// spin is one step, not all floors; Ctrl + wheel zooms. With one floor, with the setting off and in the editor the
// wheel zooms as before. Touch: two fingers swiping up/down change the floor, pinching zooms. Mock harness.
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/floor-scroll.mjs
import { openMock } from './mock.mjs';

let fails = 0;
const ok = (c, m, extra) => {
  if (!c) fails++;
  console.log(c ? '• ok:' : '• FAIL:', m, !c && extra !== undefined ? JSON.stringify(extra).slice(0, 400) : '');
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const errs = [];
const sq = (id, name, x, y, w = 400, h = 300) => ({ id, name, points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] });
const floors = () => [
  { id: 'og', name: 'Obergeschoss', level: 1, rooms: [sq('s', 'Schlafzimmer', 0, 0), sq('b', 'Bad', 400, 0)], devices: [] },
  { id: 'eg', name: 'Erdgeschoss', level: 0, rooms: [sq('w', 'Wohnzimmer', 0, 0), sq('k', 'Küche', 400, 0)], devices: [] },
  { id: 'ug', name: 'Keller', level: -1, rooms: [sq('hw', 'Hauswirtschaft', 0, 0), sq('l', 'Lager', 400, 0)], devices: [] },
];
const base = { type: 'custom:floorplan-card', card_id: 'scroll_demo', height: 'calc(100vh - 16px)', view_mode: '2d', effects: 'off', default_floor: 'eg' };
const scale = (m) => m.card(`card.shadowRoot.querySelector('fp-plan').panZoom.view.s`);
const center = (m) =>
  m.page.evaluate(() => {
    const r = window.__fpCard.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  });

// --- mouse wheel, three floors ---
{
  const m = await openMock({ config: { ...base, floors: floors() }, size: '1280x800' });
  const { page } = m;
  await wait(1200);
  const [cx, cy] = await center(m);
  await page.mouse.move(cx, cy);
  const s0 = await scale(m);
  await page.mouse.wheel(0, -100);
  await wait(900);
  ok((await m.card('card._floorId')) === 'og', 'wheel up one notch: the floor above');
  ok(Math.abs((await scale(m)) - s0) < 1e-6, 'and no zoom');
  await page.mouse.wheel(0, 100);
  await wait(900);
  ok((await m.card('card._floorId')) === 'eg', 'wheel down one notch: back to the ground floor');
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 100);
  await wait(900);
  ok((await m.card('card._floorId')) === 'ug', 'a fast spin of six notches: one floor, not more', await m.card('card._floorId'));
  await page.mouse.wheel(0, 100);
  await wait(700);
  ok((await m.card('card._floorId')) === 'ug', 'below the lowest floor: stays');
  // Ctrl + wheel zooms
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await wait(700);
  ok((await scale(m)) > s0 * 1.02 && (await m.card('card._floorId')) === 'ug', 'Ctrl + wheel zooms, the floor stays', [s0, await scale(m)]);
  ok(await page.evaluate(() => localStorage.getItem('fp-scroll-hint') === '1'), 'the hint how to zoom was shown once (remembered)');
  // the editor: the wheel zooms
  await page.evaluate(`window.__fpCard.shadowRoot.querySelector('.chrome .icon-btn[aria-label="Grundriss bearbeiten"]').click()`);
  const ED = `document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui')`;
  await page.waitForFunction(`!!${ED}`, null, { timeout: 8000 }).catch(() => {});
  await wait(1200);
  const ef = await page.evaluate(`${ED}.floorId`);
  const es0 = await page.evaluate(`${ED}.shadowRoot.querySelector('fp-plan').panZoom.view.s`);
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -100);
  await wait(700);
  const es1 = await page.evaluate(`${ED}.shadowRoot.querySelector('fp-plan').panZoom.view.s`);
  ok((await page.evaluate(`${ED}.floorId`)) === ef && es1 > es0 * 1.02, 'in the editor the wheel zooms, the floor stays', [ef, es0, es1]);
  errs.push(...m.errors);
  await m.browser.close();
}

// --- one floor, and the setting off: the wheel zooms ---
for (const [label, cfg] of [
  ['one floor', { ...base, floors: [floors()[1]] }],
  ['setting off', { ...base, floors: floors(), scroll_floors: false }],
]) {
  const m = await openMock({ config: cfg, size: '1280x800' });
  await wait(1200);
  const [cx, cy] = await center(m);
  await m.page.mouse.move(cx, cy);
  const s0 = await scale(m);
  await m.page.mouse.wheel(0, -100);
  await wait(700);
  ok((await scale(m)) > s0 * 1.02 && (await m.card('card._floorId')) === 'eg', `${label}: the wheel zooms as before`, [s0, await scale(m), await m.card('card._floorId')]);
  errs.push(...m.errors);
  await m.browser.close();
}

// --- touch: two fingers ---
{
  const m = await openMock({ config: { ...base, floors: floors() }, size: '1024x768', touch: true });
  const { page } = m;
  await wait(1200);
  const cdp = await page.context().newCDPSession(page);
  const [cx, cy] = await center(m);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
  const gesture = async (from, to, steps = 12) => {
    await touch('touchStart', from);
    for (let i = 1; i <= steps; i++) {
      await touch(
        'touchMove',
        from.map(([x, y], k) => [x + ((to[k][0] - x) * i) / steps, y + ((to[k][1] - y) * i) / steps]),
      );
      await wait(16);
    }
    await touch('touchEnd', []);
    await wait(900);
  };
  const s0 = await scale(m);
  await gesture(
    [
      [cx - 60, cy - 60],
      [cx + 60, cy - 60],
    ],
    [
      [cx - 60, cy + 60],
      [cx + 60, cy + 60],
    ],
  );
  ok((await m.card('card._floorId')) === 'og', 'two fingers down: the floor above', await m.card('card._floorId'));
  ok(Math.abs((await scale(m)) - s0) < s0 * 0.02, 'and no zoom', [s0, await scale(m)]);
  await gesture(
    [
      [cx - 60, cy + 60],
      [cx + 60, cy + 60],
    ],
    [
      [cx - 60, cy - 60],
      [cx + 60, cy - 60],
    ],
  );
  ok((await m.card('card._floorId')) === 'eg', 'two fingers up: the floor below', await m.card('card._floorId'));
  const p0 = await scale(m);
  await gesture(
    [
      [cx - 40, cy],
      [cx + 40, cy],
    ],
    [
      [cx - 160, cy],
      [cx + 160, cy],
    ],
  );
  ok((await scale(m)) > p0 * 1.3 && (await m.card('card._floorId')) === 'eg', 'pinching zooms, the floor stays', [p0, await scale(m)]);
  errs.push(...m.errors);
  await m.browser.close();
}

ok(!errs.length, 'no page errors or warnings', errs);
console.log(fails ? `\n${fails} FAIL` : '\nall ok');
process.exit(fails ? 1 : 0);
