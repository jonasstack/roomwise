// Object catalogue: every kind and variant builds in 2D and 3D without errors, status pieces show the right ring
// for faked states, the library finds new objects and places variants. In-page config only, nothing saved,
// service calls blocked.
import * as esbuild from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openHA } from '../pw.mjs';
import { cardFn } from '../design/fake.mjs';

const out = process.argv[2] ?? '/tmp';
const ok = (c, m) => console.log(c ? '• ok:' : '• FAIL:', m);
const dir = mkdtempSync(join(tmpdir(), 'fpobj-'));
writeFileSync(join(dir, 'e.ts'), `import { FURNITURE } from ${JSON.stringify(resolve('src/furniture.ts'))};
console.log(JSON.stringify(FURNITURE.flatMap((k) => (k.variants ?? [{ id: undefined }]).map((v) => ({ kind: k.kind, variant: v.id, w: v.w ?? k.w, h: v.h ?? k.h })))));`);
await esbuild.build({ entryPoints: [join(dir, 'e.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'e.mjs'), logLevel: 'warning' });
const all = JSON.parse(execFileSync('node', [join(dir, 'e.mjs')]).toString());

const block = ['light', 'climate', 'vacuum', 'cover', 'todo', 'media_player', 'fan', 'switch', 'lock', 'siren', 'alarm_control_panel', 'button', 'valve', 'tts', 'notify', 'input_boolean', 'scene', 'script', 'automation'];
const { browser, page, errors, calls } = await openHA({ size: '1400x900', kiosk: true, block });
const card = cardFn(page);
await page.waitForTimeout(1500);

// 1) everything at once (grid), 2D and 3D
let x = 0, y = 0, rowH = 0;
const furniture = all.map((it, i) => {
  if (x + it.w > 2400) { x = 0; y += rowH + 40; rowH = 0; }
  const f = { id: `o${i}`, kind: it.kind, ...(it.variant ? { variant: it.variant } : {}), x: x + it.w / 2, y: y + it.h / 2, w: it.w, h: it.h };
  x += it.w + 40;
  rowH = Math.max(rowH, it.h);
  return f;
});
const setPlan = (furn, extra = '') => {
  const X1 = Math.max(400, ...furn.map((f) => f.x + f.w / 2)) + 60, Y1 = Math.max(300, ...furn.map((f) => f.y + f.h / 2)) + 60;
  return page.evaluate(`(() => { const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } };
  const card = find(document); const raw = card.__objRaw ?? (card.__objRaw = card.rawConfig); ${extra}
  card.setConfig({ ...raw, floors: [{ ...raw.floors[0], rooms: [{ id: 'r', name: 'Test', outdoor: true, points: [[-40, -40], [${X1}, -40], [${X1}, ${Y1}], [-40, ${Y1}]] }], devices: [], openings: [], furniture: ${JSON.stringify(furn)} }] }); })()`);
};
await setPlan(furniture);
await page.waitForTimeout(1500);
for (const m of ['2d', '3d']) {
  await card(`(plan.viewMode = '${m}', plan.resetView?.(), true)`);
  await page.waitForTimeout(m === '3d' ? 4000 : 1500);
  await page.screenshot({ path: `${out}/objects-all-${m}.png` });
}
// (unlinked pieces are merged into static batches in 3D, so they are not checked one by one here)
ok(!errors.length, `no console errors with all ${furniture.length} kinds/variants`);

// 2) status rings for faked states
const FAKE = {
  'binary_sensor.fp_smoke': { state: 'on', attributes: { device_class: 'smoke' } },
  'binary_sensor.fp_motion': { state: 'on', attributes: { device_class: 'motion' } },
  'lock.fp_door': { state: 'unlocked', attributes: {} },
  'cover.fp_garage': { state: 'open', attributes: {} },
  'binary_sensor.fp_router': { state: 'off', attributes: { device_class: 'connectivity' } },
  'switch.fp_ebike': { state: 'on', attributes: {} },
  'sensor.fp_washer_power': { state: '320', attributes: { unit_of_measurement: 'W', device_class: 'power' } },
  'sensor.fp_tv_power': { state: '1.2', attributes: { unit_of_measurement: 'W', device_class: 'power' } },
  'alarm_control_panel.fp_alarm': { state: 'triggered', attributes: {} },
  'camera.fp_cam': { state: 'streaming', attributes: {} },
};
const S = [
  ['s1', 'sensor', 'smoke', 'binary_sensor.fp_smoke', 'rgb(255, 69, 58)'],
  ['s2', 'sensor', 'motion', 'binary_sensor.fp_motion', 'rgb(255, 179, 64)'],
  ['s3', 'smart_lock', undefined, 'lock.fp_door', 'rgb(255, 179, 64)'],
  ['s4', 'garage_door', undefined, 'cover.fp_garage', 'rgb(255, 179, 64)'],
  ['s5', 'router', undefined, 'binary_sensor.fp_router', 'rgb(255, 69, 58)'],
  ['s6', 'ebike', undefined, 'switch.fp_ebike', 'rgb(62, 224, 122)'],
  // a plainly running appliance has no ring (its own status light shows it, checked below)
  ['s7', 'washer', undefined, 'sensor.fp_washer_power', null],
  ['s8', 'washer', undefined, 'sensor.fp_tv_power', null],
  ['s9', 'alarm_panel', 'hub', 'alarm_control_panel.fp_alarm', 'rgb(255, 69, 58)'],
  ['s10', 'camera', undefined, 'camera.fp_cam', null],
];
const furn2 = S.map(([id, kind, variant, entity], i) => ({ id, kind, ...(variant ? { variant } : {}), entity, x: 100 + i * 220, y: 200, w: 60, h: 60 }));
await setPlan(furn2, `const fake = ${JSON.stringify(FAKE)}; const orig = card.optimistic.get.bind(card.optimistic);
  card.optimistic.get = (h, id) => fake[id] ? { entity_id: id, last_changed: '', last_updated: '', context: {}, ...fake[id] } : orig(h, id);`);
await card(`(plan.viewMode = '2d', plan.resetView?.(), true)`);
await page.waitForTimeout(1500);
const rings = await card(`[...plan.shadowRoot.querySelectorAll('.ffx.power')].map((g) => ({ t: g.getAttribute('transform'), c: getComputedStyle(g.querySelector('.shimmer')).stroke }))`);
for (const [id, kind, variant, entity, color] of S) {
  const f = furn2.find((x) => x.id === id);
  const r = rings.find((g) => g.t?.startsWith(`translate(${f.x} ${f.y})`));
  ok(color ? r?.c === color : !r, `${kind}${variant ? '/' + variant : ''} with ${entity} (${FAKE[entity].state}): ${color ? 'ring ' + color : 'no ring'} (${r?.c ?? 'none'})`);
}
// running vs. idle appliance: the piece itself lights up ("on" state with its status-light colour), no ring
const lit = (id) => card(`(() => { const p = plan.shadowRoot.querySelector('.piece[data-furniture="${id}"]'); return p ? { on: p.classList.contains('fx-power'), glow: p.style.getPropertyValue('--glow') } : null; })()`);
const washerOn = await lit('s7');
const washerIdle = await lit('s8');
ok(washerOn?.on && washerOn.glow === '#8fd3ff', `washer with sensor.fp_washer_power (320): status light on (${JSON.stringify(washerOn)})`);
ok(washerIdle && !washerIdle.on && !washerIdle.glow, `washer with sensor.fp_tv_power (1.2): status light off (${JSON.stringify(washerIdle)})`);
await page.screenshot({ path: `${out}/objects-status-2d.png` });
await card(`(plan.viewMode = '3d', plan.resetView?.(), true)`);
await page.waitForTimeout(2500);
ok(await card(`plan.pieceInfo('s1')?.fx === 'power' && plan.pieceInfo('s1').emissive > 0`), 'smoke detector in 3D: lit and ringed');
await page.screenshot({ path: `${out}/objects-status-3d.png` });

// 3) library: search finds new objects, a variant tile places that variant (editor discarded)
await setPlan([]);
await page.waitForTimeout(800);
const ED = 'floorplan-card-editor-ui';
await page.locator('floorplan-card .chrome .icon-btn[aria-label="Grundriss bearbeiten"]').click();
await page.waitForTimeout(1000);
await page.locator(`${ED} .tool[data-panel="furniture"]`).click();
await page.waitForTimeout(500);
for (const [q, kind] of [['fahrrad', 'bicycle'], ['rauchmelder', 'sensor'], ['balkonkraftwerk', 'solar_panels'], ['wlan', 'access_point'], ['nas', 'network'], ['wallbox', 'wallbox'], ['kamera', 'camera']]) {
  await page.locator(`${ED} .lib-search`).fill(q);
  await page.waitForTimeout(200);
  ok((await page.locator(`${ED} .furn[data-kind="${kind}"]`).count()) > 0, `search "${q}" finds ${kind}`);
}
await page.locator(`${ED} .lib-search`).fill('lastenrad');
await page.waitForTimeout(200);
await page.locator(`${ED} .furn[data-kind="bicycle"][data-variant="cargo"]`).click();
await page.waitForTimeout(400);
const placed = await page.evaluate(() => {
  const deep = (root, tag) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === tag) return el; if (el.shadowRoot) { const f = deep(el.shadowRoot, tag); if (f) return f; } } };
  const ed = deep(document, 'FLOORPLAN-CARD-EDITOR-UI');
  return ed._draft.floors.flatMap((f) => f.furniture ?? []).find((f) => f.id === ed._sel?.id);
});
ok(placed?.kind === 'bicycle' && placed?.variant === 'cargo' && placed?.w === 260, `variant tile places a cargo bike (${JSON.stringify(placed && { kind: placed.kind, variant: placed.variant, w: placed.w })})`);
await page.locator(`${ED} .tool[data-panel="furniture"]`).click();
await page.waitForTimeout(400);
await page.locator(`${ED} .lib-search`).fill('');
await page.locator(`${ED} .cat-chips .chip`, { hasText: 'Alle' }).click();
await page.waitForTimeout(300);
ok((await page.locator(`${ED} .furn-sec`).count()) >= 18, 'all objects grouped by category');
// discard
await page.locator(`${ED} .tb-left .btn`).click();
await page.waitForTimeout(300);
if (await page.locator(`${ED} .alert`).count()) await page.locator(`${ED} .alert .btn.danger`).click();
await page.waitForTimeout(400);
ok(!(await calls()).some((c) => !c.blocked && block.includes(c.domain)), 'no device was switched');
console.log(errors.length ? errors.join('\n') : 'console: keine Fehler/Warnungen');
await browser.close();
