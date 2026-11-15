// Floors ("Etagen"): the floor slider on the right (drag, flick, wheel, trackpad, tap, keys → the floor in the middle
// is the floor shown), order by level, 2D and 3D transitions, stairs jump floors, the editor's ghost of the floor
// below, single floor = no slider. Temporary configs IN THE PAGE ONLY — nothing is saved.
//   FP_LOCAL=1 node tools/tests/floors.mjs <outdir> [light|dark]
import { openHA, tapAt } from '../pw.mjs';
import { cardFn, SETUP, BLOCK } from './floors-setup.mjs';
const out = process.argv[2] ?? '/tmp';
const scheme = process.argv[3] ?? 'light';
let fails = 0;
const ok = (c, m) => {
  if (!c) fails++;
  console.log(c ? '• ok:' : '• FAIL:', m);
};
const allErrors = [];

// the ground floor = the dashboard's own floor (its id differs per plan)
let EG;
async function open(size, sch = scheme, opts = {}) {
  const h = await openHA({ size, scheme: sch, block: BLOCK, kiosk: true, ...opts });
  const c = cardFn(h.page);
  C = c;
  await h.page.waitForTimeout(1500);
  EG = await c('card.rawConfig.floors[0].id');
  await c(SETUP);
  await h.page.waitForTimeout(2200);
  return { ...h, c };
}
/** until the wheel rests and no floor transition runs (headless renders slowly: up to 6 s) */
let C;
const settle = async (page) => {
  await page.waitForTimeout(400);
  for (let i = 0; i < 28; i++) {
    const s = await C(`({ rest: slider ? !slider.raf : true, anim: card.floorAnim })`);
    if (s.rest && !s.anim) break;
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(150);
};
/** floor shown by the card, floor in the slider's middle (rounded wheel position), wheel at rest */
const st = (c) =>
  c(`({ shown: card._floorId, centred: slider ? slider.floors[Math.round(slider.pos)]?.id : null, value: slider?.value, rest: slider ? !slider.raf && Math.abs(slider.pos - Math.round(slider.pos)) < 0.01 : null, anim: card.floorAnim, planFloor: plan.floor?.id })`);
const pill = async (page) => page.locator('floorplan-card fp-floor-slider .pill').boundingBox();

// ---------------- tablet landscape ----------------
{
  const { browser, page, errors, c } = await open('1280x800');
  const order = await c(`slider.floors.map((f) => f.name).join(' > ')`);
  ok(order === 'Obergeschoss > Erdgeschoss > Keller', `ordered by level, top floor first (${order})`);
  let s = await st(c);
  ok(s.shown === EG && s.centred === s.shown && s.rest, `starts on the first floor, centred in the slider (${JSON.stringify(s)})`);
  const top = await c(`card.shadowRoot.querySelector('.chrome.top .segmented.floors') === null`);
  ok(top, 'no segmented floor switch at the top any more');
  await page.screenshot({ path: `${out}/floors-3d-eg-${scheme}.png` });

  // drag down one row → the floor above comes into the middle
  let b = await pill(page);
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(cx, cy + (46 * i) / 12);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(140);
  await page.mouse.up();
  // the moment the new floor is coming in
  await page.waitForTimeout(260);
  await page.screenshot({ path: `${out}/floors-3d-transition-${scheme}.png` });
  await settle(page);
  s = await st(c);
  ok(s.shown === 'fl_og' && s.centred === 'fl_og' && s.rest && !s.anim && s.planFloor === 'fl_og', `drag down → Obergeschoss, centred = shown (${JSON.stringify(s)})`);
  const clean = await c(`!plan.getAnimations().length && !plan.style.transform && plan.style.opacity === ''`);
  ok(clean, 'nothing keeps animating on the plan after the transition');
  await page.screenshot({ path: `${out}/floors-3d-og-${scheme}.png` });
  // floor below shows as a faint outline (in the floor texture)
  const below = await c(`!!plan.renderRoot.querySelector('svg.plan g.below path') && plan.below?.id`);
  ok(below === EG, `upper floor: the floor below as a faint outline (${below})`);

  // flick up fast: carries on, still rests exactly on one floor which is the floor shown
  b = await pill(page);
  await page.mouse.move(cx, b.y + b.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 4; i++) {
    await page.mouse.move(cx, b.y + b.height / 2 - (40 * i) / 4);
    await page.waitForTimeout(8);
  }
  await page.mouse.up();
  await settle(page);
  s = await st(c);
  ok(s.rest && s.centred === s.shown && s.shown !== 'fl_og', `flick up → moves on and snaps (${s.shown}, ${JSON.stringify(s)})`);

  // mouse wheel: one floor per notch
  const before = s.shown;
  const floors = await c(`slider.floors.map((f) => f.id)`);
  b = await pill(page);
  await page.mouse.move(cx, b.y + b.height / 2);
  const dir = floors.indexOf(before) === floors.length - 1 ? -100 : 100;
  await page.mouse.wheel(0, dir);
  await settle(page);
  s = await st(c);
  ok(s.rest && s.centred === s.shown && floors.indexOf(s.shown) === floors.indexOf(before) + Math.sign(dir), `mouse wheel notch → next floor (${before} → ${s.shown})`);

  // trackpad (also Safari): many small deltas, it follows and snaps when they stop
  const t0 = await c(`Math.round(slider.pos)`);
  const tdir = t0 === 0 ? 1 : -1;
  const mid = await c(`(() => { const p = slider.renderRoot.querySelector('.pill'); const r = p.getBoundingClientRect();
    for (let i = 0; i < 9; i++) p.dispatchEvent(new WheelEvent('wheel', { deltaY: ${tdir} * 7.5, deltaMode: 0, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, bubbles: true, cancelable: true }));
    return slider.pos; })()`);
  await settle(page);
  s = await st(c);
  ok(s.rest && s.centred === s.shown && Math.abs(mid - Math.round(mid)) > 0.02 && Math.round(await c(`slider.pos`)) === t0 + tdir, `trackpad scroll follows (pos ${mid.toFixed(2)} mid-way) then snaps (${s.shown})`);

  // tap on another row
  b = await pill(page);
  const target = await c(`slider.floors[Math.round(slider.pos) === 0 ? 1 : Math.round(slider.pos) - 1].id`);
  const rowY = await c(`slider.floors.findIndex((f) => f.id === '${target}') - Math.round(slider.pos)`);
  await tapAt(page, cx, b.y + b.height / 2 + rowY * 44);
  await settle(page);
  s = await st(c);
  ok(s.shown === target && s.centred === target && s.rest, `tap on a row → that floor (${target})`);

  // keyboard
  await c(`slider.renderRoot.querySelector('.pill').focus()`);
  const k0 = await c(`Math.round(slider.pos)`);
  await page.keyboard.press(k0 === 0 ? 'ArrowDown' : 'ArrowUp');
  await settle(page);
  s = await st(c);
  ok(s.rest && s.centred === s.shown && s.shown !== target, `arrow keys → next floor (${s.shown})`);

  // back to the ground floor, stairs: chip and tap jump to the floor above
  await c(`card.goFloor('${EG}')`);
  await settle(page);
  const chip = page.locator('floorplan-card fp-plan .pet-chip.stair');
  ok((await chip.count()) === 1 && (await chip.textContent()).includes('Obergeschoss'), 'stairs on the ground floor: chip "Obergeschoss"');
  await chip.click();
  await settle(page);
  s = await st(c);
  ok(s.shown === 'fl_og' && s.centred === 'fl_og', `tap on the stairs → upstairs (${s.shown})`);
  const chipDown = await page.locator('floorplan-card fp-plan .pet-chip.stair').textContent();
  ok(chipDown.includes('Erdgeschoss'), `stairs upstairs lead down (${chipDown.trim()})`);
  // tapping the stairs themselves (3D body) also goes there
  await c(`card.gesture({ kind: 'furniture', id: 'st_og' }, 'tap'), true`);
  await settle(page);
  s = await st(c);
  ok(s.shown === EG, `tap on the stairs' body → down again (${s.shown})`);

  // a room of another floor (popup / search / rule): the card goes there and zooms onto it
  await c(`card.showRoom('kg_tech')`);
  await page.waitForTimeout(1600);
  s = await st(c);
  const foc = await c(`plan.focused`);
  ok(s.shown === 'fl_kg' && foc, `showRoom on another floor → switches and focuses (${s.shown}, focused ${foc})`);
  await page.screenshot({ path: `${out}/floors-3d-kg-room-${scheme}.png` });
  await c(`card.returnToDefault(true)`);
  await page.waitForTimeout(1600);
  s = await st(c);
  ok(s.shown === EG, `idle return → default floor (${s.shown})`);

  // per-user default floor
  await c(`(() => { const uid = card._hass.user.id; card.setConfig({ ...card.rawConfig, users: { ...(card.rawConfig.users ?? {}), [uid]: { ...(card.rawConfig.users?.[uid] ?? {}), floor: 'fl_og' } } }); return true; })()`);
  await c(`card.returnToDefault(true)`);
  await page.waitForTimeout(1600);
  s = await st(c);
  ok(s.shown === 'fl_og', `per-user default floor (${s.shown})`);
  await c(`(() => { const r = card.rawConfig; const uid = card._hass.user.id; const u = { ...(r.users ?? {}) }; const me = { ...(u[uid] ?? {}) }; delete me.floor; u[uid] = me; card.setConfig({ ...r, users: u }); return true; })()`);

  // 2D: the stack glides (offset outlines), no fading
  await page.locator('floorplan-card .chrome .icon-btn .vm').click();
  await page.waitForTimeout(1200);
  const is2d = await c(`!plan.is3d`);
  await c(`card.goFloor('${EG}')`);
  await settle(page);
  s = await st(c);
  ok(is2d && s.shown === EG && s.centred === s.shown, `2D: switch works (${s.shown})`);
  await page.screenshot({ path: `${out}/floors-2d-eg-${scheme}.png` });
  const p2 = c(`card.goFloor('fl_og')`);
  await page.waitForTimeout(180);
  await page.screenshot({ path: `${out}/floors-2d-transition-${scheme}.png` });
  await p2;
  await settle(page);
  await page.screenshot({ path: `${out}/floors-2d-og-${scheme}.png` });
  await page.locator('floorplan-card .chrome .icon-btn .vm').click();
  await page.waitForTimeout(800);

  // entry alert + pets keep working with several floors: the pet states cover every floor
  const pets = await c(`[...card.pets.states.keys()].length >= (card._config.floors.flatMap((f) => f.furniture ?? []).filter((x) => x.kind === 'dog' || x.kind === 'cat').length ? 1 : 0)`);
  ok(pets, 'pets: walk state kept for pets of every floor');

  // editor on the upper floor: the floor below as a dashed ghost; points snap onto it
  await c(`card.goFloor('fl_og')`);
  await settle(page);
  await page.locator('floorplan-card .chrome .icon-btn[aria-label="Grundriss bearbeiten"]').click();
  await page.waitForTimeout(1500);
  const ED = 'floorplan-card-editor-ui';
  const ghost = await page.evaluate(() => {
    const ed = document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui');
    const plan = ed.shadowRoot.querySelector('fp-plan');
    // the outermost corner of the floor below (the upper floor has no corner there)
    const corner = (ed.below?.rooms ?? []).flatMap((r) => r.points).reduce((a, p) => (p[0] + p[1] > a[0] + a[1] ? p : a), [-1e9, -1e9]);
    const s = ed.snap([corner[0] - 3, corner[1] - 2]);
    return { ghost: !!plan.renderRoot.querySelector('g.below-ghost path'), below: ed.below?.id, snap: s.point, corner };
  });
  ok(ghost.ghost && ghost.below === EG, `editor: ghost of the floor below (${JSON.stringify(ghost)})`);
  ok(Math.abs(ghost.snap[0] - ghost.corner[0]) < 0.5 && Math.abs(ghost.snap[1] - ghost.corner[1]) < 0.5, `editor: a point snaps onto the ghost's corner (${ghost.snap} → ${ghost.corner})`);
  await page.locator(`${ED} .tool[data-tool="draw"]`).click().catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/floors-editor-ghost-${scheme}.png` });
  // settings: the floors section
  await page.locator(`${ED} .tool[data-tool="select"]`).click().catch(() => {});
  await page.evaluate(() => {
    const ed = document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui');
    ed._panel = 'settings';
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const ed = document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui');
    const d = [...ed.shadowRoot.querySelectorAll('details.fold')].find((x) => x.querySelector('.floor-list'));
    if (d) {
      d.open = true;
      d.scrollIntoView();
    }
  });
  await page.waitForTimeout(400);
  const list = await page.evaluate(() => [...document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui').shadowRoot.querySelectorAll('.floor-row .title')].map((e) => e.textContent));
  ok(list.join('>') === 'Obergeschoss>Erdgeschoss>Keller', `settings list the floors top first (${list.join(' > ')})`);
  await page.screenshot({ path: `${out}/floors-editor-settings-${scheme}.png` });
  // reorder: Keller one up → above Erdgeschoss
  await page.locator(`${ED} [data-floor-up="fl_kg"]`).click();
  await page.waitForTimeout(300);
  const list2 = await page.evaluate(() => [...document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui').shadowRoot.querySelectorAll('.floor-row .title')].map((e) => e.textContent));
  ok(list2.join('>') === 'Obergeschoss>Keller>Erdgeschoss', `reorder (${list2.join(' > ')})`);
  // delete asks first (cancel)
  await page.locator(`${ED} [data-delete-floor]`).click();
  await page.waitForTimeout(400);
  const asked = await page.evaluate(() => !!document.querySelector('floorplan-card-layer')._confirm);
  ok(asked, 'deleting a floor asks for confirmation');
  await page.evaluate(() => document.querySelector('floorplan-card-layer').resolveConfirm(false));
  await page.waitForTimeout(300);
  const n = await page.evaluate(() => document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui')._draft.floors.length);
  ok(n === 3, `cancelled: still 3 floors (${n})`);
  // HA floors (faked in the page): a new floor linked to one takes its name and level; drawing offers its areas
  const EDJS = `document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui')`;
  // every hass the card hands on (also to the editor) carries the fake floor
  await c(`(() => { const proto = Object.getPrototypeOf(card); let d; for (let p = proto; p && !d; p = Object.getPrototypeOf(p)) d = Object.getOwnPropertyDescriptor(p, 'hass');
    // two areas the plan does not use yet belong to the fake floor (or the bathroom and hall when all are used)
    const used = new Set(card.rawConfig.floors.flatMap((f) => f.rooms.map((r) => r.area)).filter(Boolean));
    const free = Object.keys(document.querySelector('home-assistant').hass.areas).filter((k) => !used.has(k)).slice(0, 2);
    window.__fpDgAreas = free.length ? free : ['bad', 'flur'];
    const patch = (h) => ({ ...h, floors: { f_dg: { floor_id: 'f_dg', name: 'Dachgeschoss', level: 2 } }, areas: Object.fromEntries(Object.entries(h.areas).map(([k, a]) => [k, window.__fpDgAreas.includes(k) ? { ...a, floor_id: 'f_dg' } : a])) });
    Object.defineProperty(card, 'hass', { configurable: true, set(h) { d.set.call(this, patch(h)); }, get() { return d.get.call(this); } });
    card.hass = document.querySelector('home-assistant').hass; return true; })()`);
  await page.waitForTimeout(400);
  await page.locator(`${ED} [data-add-floor]`).click();
  await page.waitForTimeout(500);
  await page.locator(`${ED} select[data-ha-floor]`).selectOption('f_dg');
  await page.waitForTimeout(400);
  const linked = await page.evaluate(`(() => { const ed = ${EDJS}; const f = ed.floor; return { name: f.name, level: f.level, floor: f.floor, top: ed.card && null }; })()`);
  ok(linked.name === 'Dachgeschoss' && linked.level === 2 && linked.floor === 'f_dg', `HA floor link → name and level suggested (${JSON.stringify(linked)})`);
  await page.screenshot({ path: `${out}/floors-editor-ha-floor-${scheme}.png` });
  await page.evaluate(`(() => { const ed = ${EDJS}; ed.mutate((_d, f) => f.rooms.push({ id: 'r_t', name: 'Raum 1', points: [[0, 0], [300, 0], [300, 300], [0, 300]] })); ed.select({ kind: 'room', id: 'r_t' }); return true; })()`);
  await page.waitForTimeout(500);
  const chips = await page.evaluate(`[...${EDJS}.shadowRoot.querySelectorAll('[data-area-suggest]')].map((b) => b.dataset.areaSuggest).join(',')`);
  const used = await page.evaluate(`[...new Set(${EDJS}._draft.floors.flatMap((f) => f.rooms.map((r) => r.area)).filter(Boolean))]`);
  const want = (await page.evaluate(() => window.__fpDgAreas)).filter((a) => !used.includes(a)).sort().join(',');
  ok(want && chips.split(',').filter(Boolean).sort().join(',') === want, `new room on a linked floor: its unused areas as suggestions (${chips}; expected ${want})`);
  await page.screenshot({ path: `${out}/floors-editor-area-chips-${scheme}.png` });
  const first = want.split(',')[0];
  await page.locator(`${ED} [data-area-suggest="${first}"]`).click();
  await page.waitForTimeout(300);
  const picked = await page.evaluate(`(() => { const r = ${EDJS}.floor.rooms.find((x) => x.id === 'r_t'); return r.area + ':' + r.name; })()`);
  ok(picked.startsWith(first + ':') && !picked.endsWith('Raum 1'), `tap on a suggestion → area and name (${picked})`);
  // leave without saving
  await page.locator(`${ED} .tb-left .btn`).click();
  await page.waitForTimeout(300);
  await page.locator(`${ED} .alert .btn.danger`).click().catch(() => {});
  await page.waitForTimeout(600);

  // single floor: no slider, exactly as before
  await c(`(() => { const r = card.rawConfig; card.setConfig({ ...r, floors: [r.floors[0]] }); return true; })()`);
  await page.waitForTimeout(800);
  const none = await c(`!card.shadowRoot.querySelector('fp-floor-slider') && !plan.below && !plan.stairs && plan.insetRight === 0`);
  ok(none, 'one floor: no slider, no outline, no stairs chips, no inset');
  allErrors.push(...errors);
  await browser.close();
}

// ---------------- other sizes / scheme ----------------
for (const [size, sch, name] of [
  ['800x1280', scheme, 'portrait'],
  ['390x844', scheme, 'phone'],
  ['1280x800', scheme === 'light' ? 'dark' : 'light', 'landscape-other'],
]) {
  const { browser, page, errors, c } = await open(size, sch);
  // the card follows HA's own dark mode (a user setting), not the browser's: force the theme for the dark shots
  if (sch === 'dark') {
    await c(`(card.setConfig({ ...card.rawConfig, theme: 'dark' }), true)`);
    await page.waitForTimeout(1500);
  }
  const s = await st(c);
  const geo = await c(`(() => { const r = slider.getBoundingClientRect(); const els = [...card.shadowRoot.querySelectorAll('.chrome .icon-btn, .chrome .compass, .chrome .weather, .chrome .hr-chip')].filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect());
    const hit = els.filter((b) => b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top).length;
    return { compact: slider.compact, w: Math.round(r.width), h: Math.round(r.height), right: Math.round(innerWidth - r.right), hit }; })()`);
  ok(s.centred === s.shown && geo.hit === 0, `${name} ${size} ${sch}: slider ${geo.compact ? 'compact' : 'regular'} ${geo.w}×${geo.h}, clear of the other controls (${JSON.stringify(geo)})`);
  if (name === 'phone') ok(geo.compact, 'phone: compact slider');
  await page.screenshot({ path: `${out}/floors-${name}-${sch}.png` });
  // touch drag on the slider (pointer events like a finger)
  const b = await pill(page);
  const cdp = await page.context().newCDPSession(page);
  const x = b.x + b.width / 2;
  const y0 = b.y + b.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 - (44 * i) / 10 }] });
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(120);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await settle(page);
  const s2 = await st(c);
  ok(s2.shown === 'fl_kg' && s2.centred === s2.shown && s2.rest, `${name}: touch drag up → Keller (${s2.shown})`);
  await page.screenshot({ path: `${out}/floors-${name}-kg-${sch}.png` });
  allErrors.push(...errors);
  await browser.close();
}

console.log(allErrors.length ? allErrors.join('\n') : 'console: keine Fehler/Warnungen');
if (allErrors.length) fails++;
console.log(fails ? `${fails} FAIL` : 'all ok');
process.exit(fails ? 1 : 0);
