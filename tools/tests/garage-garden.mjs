// Garage & garden on the mock harness (no Home Assistant; neutral demo home): garage door in the wall (2D, WebGL, CSS-3D),
// gate, popups with the confirmation before opening, mower, irrigation zones, room kinds and the editor's garage tool.
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/garage-garden.mjs [outDir] [light|dark]
import { openMock, demoHome, demoStates, demoEntities } from './mock.mjs';
import { KNOWN } from '../pw.mjs';

const out = process.argv[2] ?? '/tmp';
const scheme = process.argv[3] ?? 'light';
let fails = 0;
const ok = (c, m) => {
  if (!c) fails++;
  console.log(c ? '• ok:' : '• FAIL:', m);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const LAYER = `document.querySelector('floorplan-card-layer').shadowRoot`;
/** the second step before anything opens: drag the sheet's knob to the end */
const slideOpen = async () => {
  const b = await page.evaluate(`(() => { const s = ${LAYER}.querySelector('fp-slide-confirm'); const k = s.shadowRoot.querySelector('.knob').getBoundingClientRect(); const tr = s.shadowRoot.querySelector('.track').getBoundingClientRect(); return { x: k.x + k.width / 2, y: k.y + k.height / 2, end: tr.right - 6 }; })()`);
  await page.mouse.move(b.x, b.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(b.x + ((b.end - b.x) * i) / 10, b.y);
  await page.mouse.up();
  await wait(300);
};

const cfg = demoHome();
const m = await openMock({ config: { ...cfg, view_mode: '3d' }, states: demoStates(), entities: demoEntities, size: '1280x1024', scheme });
const { page } = m;
await wait(2000);

// ---------- WebGL ----------
ok(await m.card('plan.is3d && !!plan.glScene'), 'WebGL 3D view');
const pos = (id) => m.card(`plan.glScene.garagePos.get(${JSON.stringify(id)}) ?? null`);
ok((await pos('gd1')) === 0, 'garage door drawn closed');
// look at the garage door from the drive (the front walls turn see-through otherwise)
await m.card(`(plan.setSpin(180), true)`);
await wait(900);
await page.screenshot({ path: `${out}/garage-3d-closed-${scheme}.png` });
await m.setStates({ 'cover.demo_garage': { state: 'open', attributes: { current_position: 100 } } });
await wait(400);
const mid = await pos('gd1');
await wait(3200);
const end = await pos('gd1');
ok(mid > 0 && mid < 1 && end === 1, `garage door runs open (${mid?.toFixed(2)} → ${end})`);
await page.screenshot({ path: `${out}/garage-3d-open-${scheme}.png` });
// running without a position report: at motor speed towards where it goes
await m.setStates({ 'cover.demo_garage': { state: 'closing', attributes: { current_position: null } } });
await wait(1500);
const run1 = await pos('gd1');
await wait(1500);
const run2 = await pos('gd1');
ok(run1 < 1 && run2 < run1 && run2 > 0, `closing without position: moves steadily (${run1?.toFixed(2)} → ${run2?.toFixed(2)})`);
await m.setStates({ 'cover.demo_garage': { state: 'closed', attributes: { current_position: 0 } } });
await wait(3200);
ok((await pos('gd1')) === 0, 'and ends closed');
// gate piece
await m.setStates({ 'cover.demo_gate': { state: 'open' } });
await wait(3200);
ok((await pos('gate')) === 1, 'gate leaves turned open');
const gateAnim = await m.card(`(() => { const g = plan.glScene.furniture.children.find((c) => c.userData.id === 'gate'); return g ? g.getObjectByName('leaf0')?.rotation.z.toFixed(2) : 'missing'; })()`);
ok(Math.abs(Number(gateAnim) - (85 * Math.PI) / 180) < 0.02, `gate leaf at 85° (${gateAnim} rad)`);
// mower: drives over the lawn (not the whole plot)
await m.setStates({ 'lawn_mower.demo_mower': { state: 'mowing' } });
await wait(800);
const p0 = await m.card(`(() => { const g = plan.glScene.furniture.children.find((c) => c.userData.id === 'mower'); return [g.position.x, g.position.y]; })()`);
await wait(1200);
const p1 = await m.card(`(() => { const g = plan.glScene.furniture.children.find((c) => c.userData.id === 'mower'); return [g.position.x, g.position.y]; })()`);
const lawn = cfg.floors[0].rooms.find((r) => r.id === 'lawn').points;
const inLawn = (p) => p[0] >= lawn[0][0] - 1 && p[0] <= lawn[1][0] + 1 && p[1] >= lawn[0][1] - 1 && p[1] <= lawn[2][1] + 1;
ok(p0.join() !== p1.join() && inLawn(p1), `mower drives its lanes on the lawn (${p1.map(Math.round)})`);
// irrigation zone: spray + wet area while the valve is open
await m.setStates({ 'valve.demo_zone_1': { state: 'open' } });
await wait(900);
const zone = await m.card(`(() => { const g = plan.glScene.furniture.children.find((c) => c.userData.id === 'zone1'); return g ? { anim: !!g.userData.anim, sprites: g.children.filter((c) => c.isSprite).length } : null; })()`);
ok(zone?.anim && zone.sprites >= 10, `irrigation zone sprays (${zone?.sprites} drops)`);
// car away: the car in the garage turns into a ghost
await m.setStates({ 'device_tracker.demo_car': { state: 'not_home' } });
await wait(900);
ok((await m.card(`plan.furnSig(plan.floor).get('car')`)).startsWith('car:1'), 'car away is shown as away');
await m.setStates({ 'device_tracker.demo_car': { state: 'home' }, 'cover.demo_garage': { state: 'open', attributes: { current_position: 100 } } });
await m.card(`(plan.setSpin(0), true)`);
await wait(2400);
await page.screenshot({ path: `${out}/garden-3d-${scheme}.png` });

// ---------- 2D ----------
await m.card(`(card.setConfig({ ...card.rawConfig, view_mode: '2d' }), true)`);
await wait(1500);

ok(!(await m.card('plan.is3d')), '2D view');
const g2 = await m.card(`(() => { const el = plan.shadowRoot.querySelector('.opening.garage'); return el ? { cls: el.getAttribute('class'), t: el.querySelector('.gtrack').style.transform } : null; })()`);
ok(g2 && /\bopen\b/.test(g2.cls) && /scaleY\(-?1\)/.test(g2.t), `2D garage door open (${g2?.t})`);
const gate2 = await m.card(`plan.shadowRoot.querySelector('[data-furniture="gate"] .gleaf')?.style.transform`);
ok(/rotate\(85/.test(gate2 ?? ''), `2D gate leaves open (${gate2})`);
const rings = await m.card(`plan.shadowRoot.querySelectorAll('.ffx.water .ring').length`);
const zoneOn = await m.card(`!!plan.shadowRoot.querySelector('[data-furniture="zone1"] .zone.on')`);
ok(rings >= 4 && zoneOn, `2D watering: zone tinted, ${rings} drop rings`);
const plotStyle = await m.card(`(() => { const el = plan.shadowRoot.querySelector('.room.plot'); return el ? getComputedStyle(el).strokeDasharray : null; })()`);
ok(plotStyle && plotStyle !== 'none', `plot drawn as a dashed line (${plotStyle})`);
await m.setStates({ 'cover.demo_garage': { state: 'opening', attributes: { current_position: 40 } } });
await wait(300);
ok(/moving/.test(await m.card(`plan.shadowRoot.querySelector('.opening.garage').getAttribute('class')`)), 'running door marked as moving');
await page.screenshot({ path: `${out}/garage-2d-${scheme}.png` });
await m.setStates({ 'cover.demo_garage': { state: 'closed', attributes: { current_position: 0 } } });
await wait(1800);

// ---------- popups ----------
const center = (sel) => m.card(`(() => { const r = plan.shadowRoot.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r && r.width ? [r.x + r.width / 2, r.y + r.height / 2] : null; })()`);
/** bring a world rectangle (cm) into view */
const focusWorld = (x, y, w, h) => m.card(`(() => { const pz = plan.panZoom; const v = pz.view; pz.focusRect({ x: v.tx + ${x} * v.s, y: v.ty + ${y} * v.s, w: ${w} * v.s, h: ${h} * v.s }); return true; })()`);
const tap = async (xy) => {
  await page.mouse.click(xy[0], xy[1]);
  await wait(700);
};
const popup = (tag) => page.evaluate(`!!${LAYER}.querySelector('.sheet ${tag}')`);
const closePopup = async () => {
  await page.evaluate(`${LAYER}.querySelector('.sheet > *')?.shadowRoot.querySelector('.close')?.click()`);
  await wait(600);
};
await m.clearCalls();
const gd = await center('.opening.garage .hit');
await tap(gd);
ok(await popup('fp-cover-popup'), 'tap on the garage door opens its popup');
ok(await page.evaluate(`!!${LAYER}.querySelector('fp-cover-popup').shadowRoot.querySelector('svg.pic.garage')`), 'popup shows the garage door picture');
// (the sheet fades in; a loaded machine may take a moment)
await page.waitForFunction(`getComputedStyle(${LAYER}.querySelector('.sheet')).opacity === '1'`, null, { timeout: 8000 }).catch(() => {});
await page.screenshot({ path: `${out}/garage-popup-${scheme}.png` });
const inPopup = (tag, sel) => `${LAYER}.querySelector('${tag}').shadowRoot.querySelector('${sel}')`;
await page.evaluate(`${inPopup('fp-cover-popup', '[data-action="open"]')}.click()`);
await wait(400);
const confirmText = await page.evaluate(`${LAYER}.querySelector('.open-confirm .alert-text')?.textContent`);
ok(!!confirmText && (await m.calls()).length === 0, `opening asks first (slide sheet): "${confirmText}"`);
await page.screenshot({ path: `${out}/garage-confirm-${scheme}.png` });
await page.evaluate(`${LAYER}.querySelector('.open-cancel').click()`);
await wait(300);
ok((await m.calls()).length === 0, 'cancel: nothing happens');
await page.evaluate(`${inPopup('fp-cover-popup', '[data-action="open"]')}.click()`);
await wait(300);
await slideOpen();
let calls = await m.calls();
ok(calls.some((c) => c.domain === 'cover' && c.service === 'open_cover' && c.target?.entity_id === 'cover.demo_garage'), 'confirmed: cover.open_cover');
await closePopup();
// gate: a tap opens the gate picture
await focusWorld(900, 700, 800, 400);
await wait(900);
await tap(await center('[data-furniture="gate"] .fhit'));
ok(await page.evaluate(`!!${LAYER}.querySelector('fp-cover-popup')?.shadowRoot.querySelector('svg.pic.gate')`), 'tap on the gate opens its popup with the gate picture');
await closePopup();
// gate with a direct toggle on tap: still asks first
await m.card(`(card.setConfig({ ...card.rawConfig, floors: card.rawConfig.floors.map((f) => ({ ...f, furniture: f.furniture.map((p) => (p.id === 'gate' ? { ...p, tap_action: { action: 'toggle' } } : p)) })) }), true)`);
await m.setStates({ 'cover.demo_gate': { state: 'closed' } });
await wait(1200);

await m.clearCalls();
await m.card(`(card.gesture({ kind: 'furniture', id: 'gate' }, 'tap'), true)`);
await wait(500);
const gateConfirm = await page.evaluate(`!!${LAYER}.querySelector('.open-confirm')`);
ok(gateConfirm && (await m.calls()).length === 0, 'gate set to toggle: asks before moving (slide sheet)');
await slideOpen();
calls = await m.calls();
ok(calls.some((c) => c.domain === 'cover' && c.service === 'open_cover' && c.target?.entity_id === 'cover.demo_gate'), 'confirmed: gate opens');
// closing the open gate from afar: the same slide sheet (nobody sees who is underneath)
await m.setStates({ 'cover.demo_gate': { state: 'open' } });
await wait(600);
await m.clearCalls();
await m.card(`(card.gesture({ kind: 'furniture', id: 'gate' }, 'tap'), true)`);
await wait(500);
const closeText = await page.evaluate(`${LAYER}.querySelector('.open-confirm .alert-text')?.textContent`);
ok(!!closeText && /schließen|close/i.test(closeText) && (await m.calls()).length === 0, `closing asks first (slide sheet): "${closeText}"`);
await slideOpen();
calls = await m.calls();
ok(calls.some((c) => c.domain === 'cover' && c.target?.entity_id === 'cover.demo_gate'), 'confirmed: gate closes', calls);
// mower popup
await m.setStates({ 'lawn_mower.demo_mower': { state: 'docked' } });
await wait(600);
await m.clearCalls();
await focusWorld(500, 450, 900, 500);
await wait(900);
await tap(await center('[data-furniture="mower"] .fhit'));
ok(await popup('fp-lawn-mower-popup'), 'tap on the mower opens its popup');
const msub = await page.evaluate(`${inPopup('fp-lawn-mower-popup', '.head-sub')}?.textContent`);
ok(/84 %/.test(msub ?? ''), `mower popup shows the battery (${msub?.trim()})`);
await page.waitForFunction(`getComputedStyle(${LAYER}.querySelector('.sheet')).opacity === '1'`, null, { timeout: 8000 }).catch(() => {});
await page.screenshot({ path: `${out}/mower-popup-${scheme}.png` });
await page.evaluate(`${inPopup('fp-lawn-mower-popup', '[data-action="start"]')}.click()`);
await wait(300);
ok((await m.calls()).some((c) => c.domain === 'lawn_mower' && c.service === 'start_mowing'), 'start: lawn_mower.start_mowing');
await closePopup();
// valve popup
await m.clearCalls();
await tap(await center('[data-furniture="zone2"] .fhit'));
ok(await popup('fp-valve-popup'), 'tap on an irrigation zone opens the valve popup');
await page.evaluate(`${inPopup('fp-valve-popup', '[data-action="open"]')}.click()`);
await wait(300);
ok((await m.calls()).some((c) => c.domain === 'valve' && c.service === 'open_valve' && c.target?.entity_id === 'valve.demo_zone_2'), 'water on: valve.open_valve');
await wait(300);
await page.waitForFunction(`getComputedStyle(${LAYER}.querySelector('.sheet')).opacity === '1'`, null, { timeout: 8000 }).catch(() => {});
await page.screenshot({ path: `${out}/valve-popup-${scheme}.png` });
await closePopup();

// ---------- CSS-3D fallback ----------
await m.card(`(card.setConfig({ ...card.rawConfig, view_mode: '3d', renderer: 'css' }), true)`);
await m.setStates({ 'cover.demo_garage': { state: 'open', attributes: { current_position: 100 } }, 'cover.demo_gate': { state: 'open' } });
await wait(1800);
const css3 = await m.card(`(() => { const el = plan.shadowRoot.querySelector('.garage3'); return el ? el.style.transform : null; })()`);
ok(!!css3 && /scaleZ\(0\.02\)/.test(css3), `CSS-3D garage door up (${css3})`);
await page.screenshot({ path: `${out}/garage-css3d-${scheme}.png` });

// ---------- editor ----------
await m.card(`(card.setConfig({ ...card.rawConfig, view_mode: '2d', renderer: 'auto' }), true)`);
await wait(1000);
await page.evaluate(() => window.__fpCard.shadowRoot.querySelector('.chrome .icon-btn[aria-label="Grundriss bearbeiten"]')?.click());
await wait(1200);
const ED = `${LAYER}.querySelector('floorplan-card-editor-ui')`;
ok(await page.evaluate(`!!${ED}`), 'editor open');
const n0 = await page.evaluate(`${ED}._draft.floors[0].openings.length`);
await page.evaluate(`${ED}.shadowRoot.querySelector('.tool[data-tool="garage"]').click()`);
await wait(300);
// tap on the kitchen's top wall (x 800, y 0)
const wp = await page.evaluate(`(() => { const p = ${ED}.shadowRoot.querySelector('fp-plan'); const r = p.panZoom.viewport_.getBoundingClientRect(); const v = p.panZoom.view; return [r.left + v.tx + 800 * v.s, r.top + v.ty + 0 * v.s]; })()`);
await page.mouse.click(wp[0], wp[1]);
await wait(600);
const placed = await page.evaluate(`${ED}._draft.floors[0].openings.at(-1)`);
const n1 = await page.evaluate(`${ED}._draft.floors[0].openings.length`);
ok(n1 === n0 + 1 && placed.type === 'garage' && Math.round(Math.hypot(placed.b[0] - placed.a[0], placed.b[1] - placed.a[1])) === 250, `garage tool places a 250 cm garage door on the wall (${JSON.stringify(placed?.a)}–${JSON.stringify(placed?.b)})`);
await page.evaluate(`[...${ED}.shadowRoot.querySelectorAll('fp-segmented')].find((s) => (s.options ?? []).some((o) => o.value === 'roller'))?.dispatchEvent(new CustomEvent('value-change', { detail: { value: 'roller' } }))`);
await wait(300);
ok((await page.evaluate(`${ED}._draft.floors[0].openings.at(-1).variant`)) === 'roller', 'variant: roller door');
await page.screenshot({ path: `${out}/garage-editor-${scheme}.png` });
// room kind: the kitchen becomes a garage (walls stay, concrete floor)
await page.evaluate(`${ED}.select({ kind: 'room', id: 'kitchen' })`);
await wait(400);
await page.evaluate(`[...${ED}.shadowRoot.querySelectorAll('fp-segmented.room-kind')][0]?.dispatchEvent(new CustomEvent('value-change', { detail: { value: 'garage' } }))`);
await wait(300);
const kit = await page.evaluate(`${ED}._draft.floors[0].rooms.find((r) => r.id === 'kitchen')`);
ok(kit.kind === 'garage' && !kit.outdoor && kit.floor?.type === 'tiles', `room kind garage keeps a chosen floor (${kit.kind}, ${kit.floor?.type})`);
await page.evaluate(`[...${ED}.shadowRoot.querySelectorAll('fp-segmented.room-kind')][0]?.dispatchEvent(new CustomEvent('value-change', { detail: { value: 'plot' } }))`);
await wait(300);
const kit2 = await page.evaluate(`${ED}._draft.floors[0].rooms.find((r) => r.id === 'kitchen')`);
ok(kit2.kind === 'plot' && kit2.outdoor && !kit2.floor, 'room kind plot: outdoor, no ground');
// library: the new pieces are there
await page.evaluate(`${ED}.shadowRoot.querySelector('.tool[data-panel="furniture"]').click()`);
await wait(400);
await page.evaluate(`(() => { const i = ${ED}.shadowRoot.querySelector('.lib-search'); i.value = 'bewässerung'; i.dispatchEvent(new Event('input')); })()`);
await wait(400);
ok(await page.evaluate(`!!${ED}.shadowRoot.querySelector('.furn[data-kind="irrigation_zone"]')`), 'library: irrigation zone');
await page.evaluate(`(() => { const i = ${ED}.shadowRoot.querySelector('.lib-search'); i.value = 'steckdose'; i.dispatchEvent(new Event('input')); })()`);
await wait(400);
ok(await page.evaluate(`!!${ED}.shadowRoot.querySelector('.furn[data-kind="garden_socket"]')`), 'library: outdoor socket');

const errs = m.errors.filter((e) => !KNOWN.some((r) => r.test(e)));
ok(!errs.length, errs.length ? `console: ${errs.join(' | ')}` : 'console: no errors or warnings');
await m.browser.close();
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
