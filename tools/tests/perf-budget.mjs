// Performance budgets of the card, so wall tablets never get slower unnoticed. Runs the built card (dist/, build
// first) in a bare page with a fake Home Assistant (tools/perf/harness.mjs) — no Home Assistant is contacted.
//   sh tools/heavy.sh browser node tools/tests/perf-budget.mjs        exit code 1 when a budget is broken
// Budgets are generous against noise on a busy machine; they catch regressions (a loop that never sleeps, a
// leak, three.js back in the start bundle), not single milliseconds.
import { execFileSync } from 'node:child_process';
import { frames, heap, idle, openCard, pan, scrollPopup, zoom } from '../perf/harness.mjs';
import { noisyIds, planIds } from '../perf/house.mjs';

const BUDGET = {
  startKb: 780, // entry + its static chunks (0.1.0-beta.7: ~754 KB with stairs, appliances, floors bar, people bar; was 1600 KB as one file)
  startFiles: 14,
  idleRafPerS: 1, // a plan where nothing moves requests no animation frames
  idleTaskMsPerS: 15,
  panP95Ms: 70, // 2D, CPU slowed down 4× (a cheap tablet)
  zoomP95Ms: 90,
  noiseRenders: 0, // state changes of entities that are not on the plan
  planRendersPerS: 8, // a plan entity changing 20 times a second redraws at most this often
  popupHeapMb: 1.5, // 200 popups opened and closed
  popupListeners: 50, // a leak per popup would show as hundreds
  floorSwitchHeapMb: 3,
  coveredRendersPerS: 1, // 3D: a running animation (radiators heating) draws nothing while a popup covers the plan
  popupScrollP95Ms: 60, // scrolling the long car popup over the 3D plan, CPU slowed down 4x
  coveredClockMs: 2000, // the animation clock stands still under a popup: after closing, motion goes on where it stopped
};

let fail = 0;
const check = (ok, name, value, limit) => {
  console.log(`${ok ? '  ok:' : '• FAIL:'} ${name}: ${value}${limit !== undefined ? ` (budget ${limit})` : ''}`);
  if (!ok) fail++;
};

// ---- bundle: what a dashboard loads before the plan can appear
const rep = JSON.parse(execFileSync('node', ['tools/perf/bundle-report.mjs', '--json'], { encoding: 'utf8' }));
check(rep.startupBytes / 1024 <= BUDGET.startKb, 'start bundle KB', Math.round(rep.startupBytes / 1024), BUDGET.startKb);
check(rep.startupFiles <= BUDGET.startFiles, 'start bundle files', rep.startupFiles, BUDGET.startFiles);
const three = rep.outputs.find((o) => o.groups.three);
check(!!three && !rep.outputs.filter((o) => o.groups.three).some((o) => o.file === 'floorplan-card.js'), 'three.js only in a lazy chunk', three?.file ?? 'missing');

// ---- 2D: nothing of the 3D scene is fetched, the plan sleeps, gestures stay smooth
{
  const run = await openCard({ view: '2d', calm: true, config: { effects: 'off' } });
  await run.page.waitForTimeout(4000);
  const sceneFetched = run.bytes.files.some((f) => /scene-/.test(f));
  check(!sceneFetched, '2D does not load the 3D scene', run.bytes.files.filter((f) => f.endsWith('.js')).length + ' files');
  const id = await idle(run, 6000);
  check(id.rafPerS <= BUDGET.idleRafPerS, '2D idle animation frames/s', id.rafPerS, BUDGET.idleRafPerS);
  check(id.taskMsPerS <= BUDGET.idleTaskMsPerS, '2D idle CPU ms/s', id.taskMsPerS, BUDGET.idleTaskMsPerS);
  await run.throttle(4);
  // the better of two runs: other work on a shared machine shows up as single slow frames
  const pans = [await frames(run, 3000, () => pan(run)), await frames(run, 3000, () => pan(run))];
  const p = pans[0].p95 <= pans[1].p95 ? pans[0] : pans[1];
  check(p.p95 <= BUDGET.panP95Ms, '2D pan frame p95 ms (CPU ×4)', p.p95, BUDGET.panP95Ms);
  await run.page.waitForTimeout(800);
  await zoom(run, 6); // warm-up: the first zoom after the start also lays out the labels once
  await run.page.waitForTimeout(500);
  const zooms = [await frames(run, 3000, () => zoom(run)), await frames(run, 3000, () => zoom(run))];
  const z = zooms[0].p95 <= zooms[1].p95 ? zooms[0] : zooms[1];
  check(z.p95 <= BUDGET.zoomP95Ms, '2D zoom frame p95 ms (CPU ×4)', z.p95, BUDGET.zoomP95Ms);
  await run.throttle(1);
  // irrelevant state changes do not render; frequent relevant ones are coalesced
  await run.card(`(window.__renders = 0, (() => { const o = card.update.bind(card); card.update = (c) => { window.__renders++; return o(c); }; })(), true)`);
  const noisy = noisyIds(run.house).slice(0, 100);
  for (const e of noisy) await run.setStates({ [e]: String(Math.random()) });
  await run.page.waitForTimeout(300);
  check((await run.page.evaluate(() => window.__renders)) <= BUDGET.noiseRenders, 'renders for 100 unrelated state changes', await run.page.evaluate(() => window.__renders), BUDGET.noiseRenders);
  const temp = planIds(run.house).find((e) => e.startsWith('sensor.'));
  await run.page.evaluate(() => (window.__renders = 0));
  const t0 = Date.now();
  for (let i = 0; i < 40; i++) {
    await run.setStates({ [temp]: (18 + Math.random() * 4).toFixed(1) });
    await run.page.waitForTimeout(50);
  }
  await run.page.waitForTimeout(500);
  const perS = +((await run.page.evaluate(() => window.__renders)) / ((Date.now() - t0) / 1000)).toFixed(1);
  check(perS <= BUDGET.planRendersPerS, 'renders/s for a plan sensor changing 20×/s', perS, BUDGET.planRendersPerS);
  const shown = await run.card(`plan.shadowRoot.textContent.includes(card._hass.states['${temp}'].state.replace('.', ','))`);
  check(shown, 'the last value is on the plan', shown);
  // a furniture-only entity redraws the plan (the piece shows its state)
  await run.setStates({ 'fan.room_0_fan': 'on' });
  await run.page.waitForTimeout(400);
  check(await run.card(`plan.hass.states['fan.room_0_fan'].state === 'on'`), 'furniture entity reaches the plan', 'fan.room_0_fan');
  // popups: no leak of memory, listeners or subscriptions
  const cycle = async (n, target) => {
    for (let i = 0; i < n; i++) {
      await run.card(`(card.ensureLayer().openPopup(${JSON.stringify(target)}), true)`);
      await run.page.waitForTimeout(40);
      await run.card(`(card.ensureLayer().closePopup(), true)`);
      await run.page.waitForTimeout(250);
    }
  };
  await cycle(10, { entity: 'light.room_1_lamp_0' });
  const h0 = await heap(run);
  const l0 = (await run.metrics()).JSEventListeners;
  await cycle(200, { entity: 'light.room_1_lamp_0' });
  const h1 = await heap(run);
  const l1 = (await run.metrics()).JSEventListeners;
  check(h1 - h0 <= BUDGET.popupHeapMb, 'heap growth over 200 popups MB', +(h1 - h0).toFixed(2), BUDGET.popupHeapMb);
  check(l1 - l0 <= BUDGET.popupListeners, 'listener growth over 200 popups', l1 - l0, BUDGET.popupListeners);
  const s0 = await run.page.evaluate(() => window.__fp.subs.length);
  await cycle(20, { entity: 'todo.shopping' });
  const s1 = await run.page.evaluate(() => window.__fp.subs.length);
  check(s1 === s0, 'subscriptions after 20 to-do popups', `${s0} → ${s1}`);
  // lazily loaded parts work: car popup (three.js) and the editor
  await run.card(`(card.ensureLayer().openPopup({ car: card._config.floors[0].furniture.find((f) => f.kind === 'car') }), true)`);
  await run.page.waitForTimeout(2500);
  check(await run.page.evaluate(() => !!document.querySelector('floorplan-card-layer')?.shadowRoot?.querySelector('fp-car-popup')), 'car popup loads on demand', '');
  await run.card(`(card.ensureLayer().closePopup(), true)`);
  await run.page.waitForTimeout(400);
  await run.card(`(card.openEditor(), true)`);
  await run.page.waitForTimeout(3000);
  check(await run.page.evaluate(() => !!document.querySelector('floorplan-card-layer')?.shadowRoot?.querySelector('floorplan-card-editor-ui')), 'editor loads on demand', '');
  console.log('  missing files:', run.bytes.missing.join(', ') || 'none');
  check(!run.errors.filter((e) => !/404/.test(e)).length, '2D page errors', run.errors.slice(0, 3).join(' | ') || 'none');
  await run.close();
}

// ---- 3D: the scene loads on demand, sleeps when nothing moves, releases floors it no longer shows
{
  const run = await openCard({ view: '3d', calm: true, config: { effects: 'off' } });
  await run.page.waitForTimeout(6000);
  check(await run.card(`!!plan.glScene`), '3D scene loaded', run.bytes.files.filter((f) => /scene-/.test(f)).join(','));
  // a popup covers the plan: the radiators' heat streams (a running loop) rest underneath, so scrolling a long
  // popup stays smooth; the loop goes on once it closes
  const renders = () => run.card(`plan.glScene.renders`);
  const rate = async (ms) => {
    const r0 = await renders();
    await run.page.waitForTimeout(ms);
    return +(((await renders()) - r0) / (ms / 1000)).toFixed(1);
  };
  const looping = await rate(2000);
  check(looping >= 2, '3D loop runs while heating (precondition)', `${looping}/s`);
  const clock0 = await run.card(`[plan.glScene.animNow(), performance.now()]`);
  await run.card(`(card.ensureLayer().openPopup({ car: card._config.floors[0].furniture.find((f) => f.kind === 'car') }), true)`);
  await run.page.waitForTimeout(2500);
  const sheet = await run.page.evaluate(() => {
    const s = document.querySelector('floorplan-card-layer').shadowRoot.querySelector('.sheet');
    return { sh: s.scrollHeight, ch: s.clientHeight };
  });
  check(sheet.sh >= sheet.ch * 1.5, 'car popup long enough to scroll', `${sheet.sh}/${sheet.ch} px`);
  const covered = await rate(3000);
  check(covered <= BUDGET.coveredRendersPerS, '3D renders/s under an open popup', covered, BUDGET.coveredRendersPerS);
  await run.throttle(4);
  const scrolls = [await frames(run, 2500, () => scrollPopup(run)), await frames(run, 2500, () => scrollPopup(run))];
  const sc = scrolls[0].p95 <= scrolls[1].p95 ? scrolls[0] : scrolls[1];
  check(sc.p95 <= BUDGET.popupScrollP95Ms, 'long popup scroll frame p95 ms (3D underneath, CPU x4)', sc.p95, BUDGET.popupScrollP95Ms);
  await run.throttle(1);
  await run.card(`(card.ensureLayer().closePopup(), true)`);
  await run.page.waitForTimeout(800);
  const clock1 = await run.card(`[plan.glScene.animNow(), performance.now()]`);
  const advance = Math.round(clock1[0] - clock0[0]);
  check(advance <= BUDGET.coveredClockMs, `animation clock advance over ${Math.round((clock1[1] - clock0[1]) / 1000)} s with the popup open (ms)`, advance, BUDGET.coveredClockMs);
  const after = await rate(2000);
  check(after >= 2, '3D loop runs again after the popup closed', `${after}/s`);
  // a calm plan: radiators that are heating animate on purpose; switch the heating off, then nothing moves
  const off = Object.fromEntries(Object.keys(run.house.states).filter((e) => e.startsWith('climate.')).map((e) => [e, 'off']));
  await run.setStates(off);
  await run.page.waitForTimeout(3000);
  const id = await idle(run, 6000);
  check(id.rafPerS <= BUDGET.idleRafPerS, '3D idle animation frames/s', id.rafPerS, BUDGET.idleRafPerS);
  check(id.taskMsPerS <= BUDGET.idleTaskMsPerS, '3D idle CPU ms/s', id.taskMsPerS, BUDGET.idleTaskMsPerS);
  const sw = async (n) => {
    for (let i = 0; i < n; i++) {
      await run.card(`(card._floorId = card._config.floors[${i % 2}].id, card.requestUpdate(), true)`);
      await run.page.waitForTimeout(500);
    }
  };
  await sw(4);
  await run.page.waitForTimeout(1500);
  const g0 = await heap(run);
  const m0 = await run.card(`plan.glScene.renderer.info.memory`);
  await sw(20);
  await run.page.waitForTimeout(2000);
  const g1 = await heap(run);
  const m1 = await run.card(`plan.glScene.renderer.info.memory`);
  check(g1 - g0 <= BUDGET.floorSwitchHeapMb, 'heap growth over 20 floor switches MB', +(g1 - g0).toFixed(2), BUDGET.floorSwitchHeapMb);
  check(m1.geometries <= m0.geometries + 5 && m1.textures <= m0.textures + 2, 'GPU geometries/textures after 20 floor switches', `${m0.geometries}/${m0.textures} → ${m1.geometries}/${m1.textures}`);
  check(!run.errors.filter((e) => !/404/.test(e)).length, '3D page errors', run.errors.slice(0, 3).join(' | ') || 'none');
  await run.close();
}

console.log(fail ? `${fail} budget(s) broken` : 'all budgets kept');
process.exit(fail ? 1 : 0);
