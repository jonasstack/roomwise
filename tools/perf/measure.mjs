// Full performance profile of the built card in the fake-HA harness (no Home Assistant involved).
// Usage (one heavy run at a time): sh tools/heavy.sh browser node tools/perf/measure.mjs [dist] [--quick]
//   dist: 'dist' (split build, default) or 'dist/single' (one file). Prints one JSON object.
import { frames, heap, idle, openCard, pan, zoom } from './harness.mjs';
import { noisyIds, planIds } from './house.mjs';

const dist = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'dist';
const quick = process.argv.includes('--quick');
const out = { dist };

// ---- load: fetch + parse + evaluate the entry, time until the plan is drawn (CPU throttled like a tablet)
for (const [rate, weak] of [[1, false], [4, false], [6, true]]) {
  const run = await openCard({ dist, throttle: rate, weak });
  const r = await run.page.evaluate(() => ({ loaded: window.__fp.loaded, firstPlan: window.__fp.firstPlan }));
  const m = await run.metrics();
  out[`load_x${rate}${weak ? '_weak' : ''}`] = { importMs: Math.round(r.loaded), firstPlanMs: Math.round(r.firstPlan), scriptMs: Math.round(m.ScriptDuration * 1000), kbFetched: Math.round(run.bytes.total / 1024), files: run.bytes.files.filter((f) => f.endsWith('.js')).length };
  if (run.errors.length) out[`errors_x${rate}`] = run.errors.slice(0, 5);
  await run.close();
}

for (const view of ['2d', '3d']) {
  const run = await openCard({ dist, view });
  await run.page.waitForTimeout(6000); // scene built, floor rasterized, loops settled
  const o = (out[view] = {});
  o.kbFetched = Math.round(run.bytes.total / 1024);
  o.subscriptions = await run.page.evaluate(() => window.__fp.subs.length);
  o.idle = await idle(run, quick ? 5000 : 10000);
  await run.throttle(4);
  o.pan_x4 = await frames(run, 3000, () => pan(run));
  o.zoom_x4 = await frames(run, 3000, () => zoom(run));
  await run.page.waitForTimeout(1500);
  // state updates nobody on the plan cares about (a busy power meter): 50 per second
  const noisy = noisyIds(run.house).slice(0, 200);
  o.noise_x4 = await frames(run, 4000, async () => {
    for (let i = 0; i < 200; i++) {
      await run.setStates({ [noisy[i]]: String(Math.random()) });
      await run.page.waitForTimeout(20);
    }
  });
  // plan entities changing: 10 per second
  const plan = planIds(run.house).filter((id) => id.startsWith('sensor.'));
  o.planUpdates_x4 = await frames(run, 4000, async () => {
    for (let i = 0; i < 40; i++) {
      await run.setStates({ [plan[i % plan.length]]: (18 + Math.random() * 5).toFixed(1) });
      await run.page.waitForTimeout(100);
    }
  });
  await run.throttle(1);
  await run.page.waitForTimeout(2000);
  o.idleAfter = await idle(run, quick ? 4000 : 8000);
  // popups: open and close a light popup many times; memory must come back
  const cycles = quick ? 40 : 200;
  const popup = async (n) => {
    for (let i = 0; i < n; i++) {
      await run.card(`(card.ensureLayer().openPopup({ entity: 'light.room_1_lamp_0' }), true)`);
      await run.page.waitForTimeout(30);
      await run.card(`(card.ensureLayer().closePopup(), true)`);
      await run.page.waitForTimeout(260);
    }
  };
  await popup(10);
  const h0 = await heap(run);
  const n0 = (await run.metrics()).Nodes;
  const l0 = (await run.metrics()).JSEventListeners;
  await popup(cycles);
  const h1 = await heap(run);
  const m1 = await run.metrics();
  o.popups = { cycles, heapStartMb: h0, heapEndMb: h1, growthMb: +(h1 - h0).toFixed(2), nodesGrowth: m1.Nodes - n0, listenersGrowth: m1.JSEventListeners - l0 };
  // floor switches rebuild the 3D scene: memory and GL objects must be released
  if (view === '3d') {
    const sw = async (n) => {
      for (let i = 0; i < n; i++) {
        await run.card(`(card._floorId = card._config.floors[${i % 2}].id, card.requestUpdate(), true)`);
        await run.page.waitForTimeout(400);
      }
    };
    await sw(4);
    const g0 = await heap(run);
    const gl0 = await run.card(`plan.glScene?.renderer?.info ? { geo: plan.glScene.renderer.info.memory.geometries, tex: plan.glScene.renderer.info.memory.textures } : null`);
    await sw(quick ? 10 : 30);
    await run.page.waitForTimeout(1500);
    const g1 = await heap(run);
    const gl1 = await run.card(`plan.glScene?.renderer?.info ? { geo: plan.glScene.renderer.info.memory.geometries, tex: plan.glScene.renderer.info.memory.textures } : null`);
    o.floorSwitch = { heapGrowthMb: +(g1 - g0).toFixed(2), gl0, gl1 };
  }
  o.heapMb = await heap(run);
  if (run.errors.length) o.errors = run.errors.slice(0, 5);
  await run.close();
}
console.log(JSON.stringify(out, null, 1));
