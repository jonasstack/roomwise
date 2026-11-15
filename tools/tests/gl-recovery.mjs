// The 3D view after an update of the card while a wall tablet keeps the page open: its 3D chunk is gone from the
// server (404). The card must not stay in CSS 3D for good (box car, layered dog, values as banners instead of
// engraved): it reloads once nobody touches it and then shows WebGL again — one dog, values engraved into the walls. Also checks the same in a normal start. No Home Assistant (tools/perf/harness.mjs).
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/gl-recovery.mjs [outdir]
import { openCard } from '../perf/harness.mjs';
import { house } from '../perf/house.mjs';

const out = process.argv[2];
let failed = 0;
const ok = (c, m) => {
  console.log(c ? '• ok:' : '• FAIL:', m);
  if (!c) failed++;
};

// the demo house with a car, a dog and engraved values
const h = house({ rooms: 4, extra: 10, calm: true });
const f0 = h.config.floors[0];
f0.furniture = [
  ...f0.furniture.filter((f) => f.kind !== 'car'),
  { id: 'car1', kind: 'car', variant: 'merc_a', x: 210, y: 180, w: 180, h: 440, rotation: 90 },
  { id: 'dog1', kind: 'dog', variant: 'medium', x: 300, y: 300, w: 72, h: 26, name: 'Rex' },
];
const config = { floors: h.config.floors, label_style: 'wall' };

/** What the 3D view shows right now */
const look = (run) =>
  run.card(`(() => {
    const g = plan.glScene;
    const labels = plan.shadowRoot.querySelectorAll('.labels .label').length;
    if (!g) return { gl: false, labels, css3d: !!plan.shadowRoot.querySelector('.furn3d') };
    const dogs = g.petGroup.children.filter((c) => c.userData.id === 'dog1');
    const skeletons = new Set();
    let skinned = 0;
    for (const d of dogs) d.traverse((o) => { if (o.isSkinnedMesh) { skinned++; skeletons.add(o.skeleton.bones[0]?.uuid); } });
    return { gl: true, labels, engraved: g.wallLabelGroup.children.length, dogs: dogs.length, skinned, skeletons: skeletons.size };
  })()`);

const check3d = (s, when) => {
  ok(s.gl, `${when}: WebGL scene`);
  ok(s.dogs === 1 && s.skeletons === 1 && s.skinned > 0, `${when}: one dog with one rig (${s.dogs} dog groups, ${s.skeletons} rigs, ${s.skinned} skinned meshes)`);
  ok(s.engraved > 0 && s.labels === 0, `${when}: values engraved into the walls, no banners (${s.engraved} engraved, ${s.labels} banners)`);
};

// ---- a normal start
{
  const run = await openCard({ view: '3d', rooms: 4, extra: 10, calm: true, config });
  await run.page.waitForTimeout(8000);
  check3d(await look(run), 'normal start');
  if (out) await run.page.screenshot({ path: `${out}/gl-recovery-start.png` });
  ok(!run.errors.length, `console: ${run.errors.join(' | ') || 'no errors'}`);
  await run.close();
}

// ---- the 3D chunk was deleted by an update: CSS 3D at first, then a reload once the page is idle
{
  let blocked = 0;
  const run = await openCard({ view: '3d', rooms: 4, extra: 10, calm: true, config, fail: (p) => /^chunks\/scene-/.test(p) && blocked++ === 0 });
  await run.page.waitForTimeout(3000);
  const before = await look(run);
  ok(!before.gl && before.css3d, `chunk missing: CSS 3D for now (${JSON.stringify(before)})`);
  const reloaded = run.page.waitForEvent('load', { timeout: 40000 }).then(() => true, () => false);
  ok(await reloaded, 'the page reloads by itself once nobody touches it');
  await run.page.waitForFunction(() => window.__fp?.firstPlan > 0, null, { timeout: 60000 });
  await run.page.waitForTimeout(8000);
  check3d(await look(run), 'after the reload');
  if (out) await run.page.screenshot({ path: `${out}/gl-recovery-reloaded.png` });
  // a second failure in the same session must not reload again (no reload loop)
  const guard = await run.page.evaluate(() => sessionStorage.getItem('fp-chunk-reload'));
  ok(!!guard, 'reload remembered for this session (at most one per 10 minutes)');
  await run.close();
}

console.log(failed ? `${failed} FAILED` : 'all ok');
process.exit(failed ? 1 : 0);
