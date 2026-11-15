// "Etagen-Blick": something worth telling on another floor than the shown one (here: the washer in the basement is
// done) shows that floor faintly below the shown one, with a label at the spot; a tap goes there and opens the
// washer; "Gesehen" makes it go; the most important thing wins (water before the washer); switched off or one floor:
// nothing. Mock harness, nothing saved.
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/floor-peek.mjs [outDir]
import { openMock } from './mock.mjs';

const out = process.argv[2];
let fails = 0;
const ok = (c, m, extra) => {
  if (!c) fails++;
  console.log(c ? '• ok:' : '• FAIL:', m, !c && extra !== undefined ? JSON.stringify(extra).slice(0, 400) : '');
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const errs = [];
const LAYER = `document.querySelector('floorplan-card-layer')?.shadowRoot`;
const sq = (id, name, x, y, w = 400, h = 300) => ({ id, name, points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] });
const floors = () => [
  { id: 'og', name: 'Obergeschoss', level: 1, rooms: [sq('s', 'Schlafzimmer', 0, 0), sq('b', 'Bad', 400, 0)], devices: [] },
  { id: 'eg', name: 'Erdgeschoss', level: 0, rooms: [sq('w', 'Wohnzimmer', 0, 0), sq('k', 'Küche', 400, 0)], devices: [] },
  {
    id: 'ug',
    name: 'Keller',
    level: -1,
    rooms: [sq('hw', 'Hauswirtschaft', 0, 0), sq('lager', 'Lager', 400, 0)],
    devices: [{ id: 'leak', entity: 'binary_sensor.demo_leak', x: 600, y: 150, name: 'Wassermelder Lager' }],
    furniture: [{ id: 'wm', kind: 'washer', name: 'Waschmaschine', entity: 'sensor.demo_washer_state', x: 80, y: 250, w: 60, h: 60 }],
  },
];
const entities = { 'sensor.demo_washer_state': { entity_id: 'sensor.demo_washer_state', device_id: 'dev_wm' } };
const states = (washer = 'Finished', leak = 'off') => ({
  'sensor.demo_washer_state': { state: washer, attributes: { friendly_name: 'Waschmaschine Status' } },
  'binary_sensor.demo_leak': { state: leak, attributes: { friendly_name: 'Wassermelder Lager', device_class: 'moisture' } },
});
const base = { type: 'custom:floorplan-card', card_id: 'peek_demo', height: 'calc(100vh - 16px)', default_floor: 'og' };
const peek = (m) => m.card(`(() => { const p = card.shadowRoot.querySelector('fp-floor-peek'); if (!p) return null; const r = p.getBoundingClientRect(); return { text: p.text, floor: p.floor?.name, severe: p.severe, at: p.at, top: r.top, h: r.height, w: r.width, label: p.shadowRoot?.querySelector('.label')?.textContent?.replace(/\\s+/g, ' ').trim() }; })()`);

for (const [size, scheme, view] of [
  ['1280x800', 'light', '2d'],
  ['1280x800', 'dark', '3d'],
  ['390x844', 'dark', '2d'],
]) {
  const tag = `${size} ${scheme} ${view}`;
  const m = await openMock({ config: { ...base, floors: floors(), view_mode: view }, states: states(), entities, size, scheme });
  const { page } = m;
  await wait(view === '3d' ? 3500 : 1500);
  ok((await m.card('card._floorId')) === 'og', `${tag}: the card shows the upper floor (the basement is two floors down, not in its stack)`);
  let p = await peek(m);
  ok(p && /Waschmaschine fertig/.test(p.text) && p.floor === 'Keller' && !p.severe, `${tag}: the basement peeks in with "Waschmaschine fertig · Keller"`, p);
  ok(p && p.top > 0 && p.w > 100, `${tag}: at the bottom, wide enough`, p);
  const inset = await m.card(`card.shadowRoot.querySelector('fp-plan').insetBottom`);
  const box = await m.card(`(() => { const pl = card.shadowRoot.querySelector('fp-plan'); const pk = card.shadowRoot.querySelector('fp-floor-peek'); return { plan: pl.getBoundingClientRect().bottom, peek: pk.getBoundingClientRect().top }; })()`);
  ok(inset > 40 && inset >= box.plan - box.peek, `${tag}: the building keeps clear of it (insetBottom ${inset})`, box);
  if (out) await page.screenshot({ path: `${out}/floor-peek-${size}-${scheme}-${view}.png` });
  // a tap goes there and opens the washer
  await m.card(`(card.shadowRoot.querySelector('fp-floor-peek').shadowRoot.querySelector('.peek').click(), true)`);
  await wait(view === '3d' ? 3200 : 1800);
  ok((await m.card('card._floorId')) === 'ug', `${tag}: a tap goes to the basement`);
  ok(await page.evaluate(`!!${LAYER}?.querySelector('fp-appliance-popup')`), `${tag}: … and opens the washer`);
  ok(!(await peek(m)), `${tag}: on its own floor nothing peeks in`);
  // "Gesehen": gone, also seen from the ground floor
  await page.evaluate(`${LAYER}.querySelector('fp-appliance-popup').shadowRoot.querySelector('[data-seen]').click()`);
  await wait(400);
  await page.keyboard.press('Escape');
  await m.card(`(card.goFloor('og'), true)`);
  await wait(2200);
  ok(!(await peek(m)), `${tag}: after "Gesehen" nothing peeks in`);
  ok((await m.card(`card.shadowRoot.querySelector('fp-plan').insetBottom`)) === 0, `${tag}: the building has the space again`);
  errs.push(...m.errors.filter((e) => !/GL Driver|GPU stall/.test(e)));
  await m.browser.close();
}

// the basement right below the shown floor: it lies in the stack – there it is a little clearer, with the label at the
// washer; no extra view at the bottom; a tap on the label goes there and opens the washer
const stackChip = (m) => m.card(`(() => { const c = card.shadowRoot.querySelector('fp-plan').shadowRoot.querySelector('.stack-chip'); if (!c) return null; const r = c.getBoundingClientRect(); return { text: c.textContent.replace(/\\s+/g, ' ').trim(), x: r.x + r.width / 2, y: r.y + r.height / 2, floor: c.dataset.stackFloor }; })()`);
for (const view of ['2d', '3d']) {
  const m = await openMock({ config: { ...base, default_floor: 'eg', floors: floors(), view_mode: view }, states: states(), entities, scheme: view === '3d' ? 'dark' : 'light' });
  const { page } = m;
  await wait(view === '3d' ? 3500 : 1500);
  const st = await m.card(`(card.shadowRoot.querySelector('fp-plan').stack ?? []).map((s) => ({ id: s.floor.id, bright: !!s.bright, text: s.text ?? '' }))`);
  ok(st.some((x) => x.id === 'ug' && x.bright) && st.some((x) => x.id === 'og' && !x.bright), `${view}: the basement in the stack is the clearer one, with the message`, st);
  await wait(800);
  const small = await peek(m);
  const chip2 = await stackChip(m);
  ok(!!small !== !!chip2, `${view}: the message shows once – at the washer in the stack, or (out of sight) in the small view`, { small, chip2 });
  if (chip2) ok(/Waschmaschine fertig/.test(chip2.text) && /Keller/.test(chip2.text) && chip2.floor === 'ug', `${view}: the label at the washer ("${chip2.text}")`, chip2);
  const onScreen = chip2 && chip2.x > 16 && chip2.y > 16 && chip2.x < 1264 && chip2.y < 784;
  if (out) await page.screenshot({ path: `${out}/floor-peek-stack-${view}.png` });
  if (!small) {
    // the label in the stack is in sight: no extra view; a tap on the label goes there
    ok(onScreen, `${view}: the label in the stack is in sight (no extra view at the bottom)`, chip2);
    await page.mouse.click(chip2.x, chip2.y);
  } else {
    // out of sight (the washer at the front edge of the basement, far below in 3D): the small view takes over
    ok(/Waschmaschine fertig/.test(small.text), `${view}: the label is out of sight – the small view at the bottom shows it instead`, { chip2, small });
    await m.card(`(card.shadowRoot.querySelector('fp-floor-peek').shadowRoot.querySelector('.peek').click(), true)`);
  }
  await wait(view === '3d' ? 3200 : 1800);
  ok((await m.card('card._floorId')) === 'ug', `${view}: a tap goes to the basement`);
  ok(await page.evaluate(`!!${LAYER}?.querySelector('fp-appliance-popup')`), `${view}: … and opens the washer`);
  errs.push(...m.errors.filter((e) => !/GL Driver|GPU stall/.test(e)));
  await m.browser.close();
}

// the most important thing wins: water before the washer; switched off → nothing; one floor → nothing
{
  const m = await openMock({ config: { ...base, floors: floors(), view_mode: '2d' }, states: states('Finished', 'on'), entities });
  await wait(1500);
  const p = await peek(m);
  ok(p && /Wasser/.test(p.text) && p.severe, 'water in the basement comes before the washer (red)', p);
  await m.setStates({ 'binary_sensor.demo_leak': { state: 'off' } });
  await wait(600);
  const q = await peek(m);
  ok(q && /Waschmaschine/.test(q.text), 'water gone: the washer again', q);
  errs.push(...m.errors.filter((e) => !/GL Driver|GPU stall/.test(e)));
  await m.browser.close();
}
{
  const m = await openMock({ config: { ...base, floors: floors(), view_mode: '2d', floor_peek: false }, states: states(), entities });
  await wait(1500);
  ok(!(await peek(m)), 'switched off (floor_peek: false): nothing peeks in');
  errs.push(...m.errors.filter((e) => !/GL Driver|GPU stall/.test(e)));
  await m.browser.close();
}
{
  const f = floors();
  const one = [{ ...f[1], id: 'eg', name: 'Erdgeschoss', level: 0 }];
  const m = await openMock({ config: { ...base, floors: one, view_mode: '2d' }, states: states(), entities });
  await wait(1500);
  ok(!(await peek(m)), 'one floor: nothing peeks in');
  errs.push(...m.errors.filter((e) => !/GL Driver|GPU stall/.test(e)));
  await m.browser.close();
}
ok(!errs.length, 'no page errors or warnings', errs);
console.log(fails ? `\n${fails} FAIL` : '\nall ok');
process.exit(fails ? 1 : 0);
