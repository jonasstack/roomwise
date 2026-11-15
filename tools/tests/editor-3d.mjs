// Editor in 3D on a notebook: orbit, zoom, wall-mount a TV, drag accuracy in 3D. Discarded (nothing saved).
import { openHA } from '../pw.mjs';
const out = process.argv[2] ?? '/tmp';
const scheme = process.argv[3] ?? 'light';
const { browser, page, errors } = await openHA({ size: '1440x900', scheme, kiosk: true, block: ['light', 'climate', 'vacuum', 'cover', 'todo', 'media_player', 'fan', 'switch'] });
const ED = 'floorplan-card-editor-ui';
const ok = (c, m) => console.log(c ? '• ok:' : '• FAIL:', m);
const ed = (fn) => page.evaluate(`(${fn})(document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui'))`);
await page.locator('floorplan-card .chrome .icon-btn[aria-label="Grundriss bearbeiten"]').click();
await page.waitForTimeout(800);
await page.locator(`${ED} .tb-right fp-segmented button`, { hasText: '3D' }).click();
await page.waitForTimeout(900);
ok(await ed((e) => e.shadowRoot.querySelector('fp-plan').is3d), 'editor switched to 3D');
await page.screenshot({ path: `${out}/ed3d-1-${scheme}.png` });
// orbit with the right mouse button
const box = await page.locator(`${ED} fp-plan`).boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
const spin0 = await ed((e) => e.shadowRoot.querySelector('fp-plan').spin);
await page.mouse.move(cx, cy);
await page.mouse.down({ button: 'right' });
for (let i = 1; i <= 10; i++) await page.mouse.move(cx + i * 12, cy + i * 6);
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(400);
const spin1 = await ed((e) => e.shadowRoot.querySelector('fp-plan').spin);
const tilt1 = await ed((e) => e.shadowRoot.querySelector('fp-plan').tilt);
ok(Math.abs(spin1 - spin0 - 48) < 2 && tilt1 < 48, `right-drag orbits (spin ${spin0}→${spin1.toFixed(0)}°, tilt ${tilt1.toFixed(0)}°)`);
// flatter + zoom in = step inside
await page.locator(`${ED} .cam-btn[aria-label="Flacher (mehr hinein)"]`).click();
await page.locator(`${ED} .cam-btn[aria-label="Flacher (mehr hinein)"]`).click();
await page.mouse.move(cx, cy);
await page.mouse.wheel(0, -600);
await page.waitForTimeout(700);
await page.screenshot({ path: `${out}/ed3d-2-inside-${scheme}.png` });
// back to a calm angle for placing
await page.locator(`${ED} .zoom .icon-btn`).click();
await page.waitForTimeout(400);
await page.locator(`${ED} .cam-btn[aria-label="Draufsicht"]`).click();
await page.waitForTimeout(500);
await page.locator(`${ED} .cam-btn[aria-label="Flacher (mehr hinein)"]`).click();
await page.locator(`${ED} .cam-btn[aria-label="Flacher (mehr hinein)"]`).click();
await page.locator(`${ED} .cam-btn[aria-label="Flacher (mehr hinein)"]`).click();
await page.waitForTimeout(500);
// add a TV, make it wall-mounted, drag it close to the top wall of the living room
await page.locator(`${ED} .tool[data-panel="furniture"]`).click();
await page.locator(`${ED} .lib-search`).fill('fernseher');
await page.waitForTimeout(200);
await page.locator(`${ED} .furn[data-kind="tv"]`).click();
await page.waitForTimeout(400);
await page.evaluate(() => { for (const d of document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui').shadowRoot.querySelectorAll('details.fold')) d.open = true; }); // collapsed groups
await page.locator(`${ED} .panel .chip`, { hasText: 'An der Wand' }).click();
// room labels float above the plan and would catch the grab where they cover the new TV
await ed((e) => { e._showLabels = false; });
await page.waitForTimeout(300);
const room = await ed((e) => e._draft.floors[0].rooms.find((r) => r.name === 'Wohnzimmer'));
const ys = room.points.map((p) => p[1]);
const xs = room.points.map((p) => p[0]);
const topY = Math.min(...ys);
const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
const tvId = await ed((e) => e._sel.id);
const tv = await ed(`(e) => e._draft.floors[0].furniture.find((f) => f.id === '${tvId}')`);
// screen positions of world points through the 3D projection: search via the plan's toWorld
const toScreen = async (wx, wy) =>
  ed(`(e) => { const plan = e.shadowRoot.querySelector('fp-plan'); const pz = plan.panZoom; const r = plan.getBoundingClientRect();
    let best = null; for (let sx = 0; sx < r.width; sx += 6) for (let sy = 0; sy < r.height; sy += 6) { const w = pz.toWorld(sx, sy); const d = Math.hypot(w[0] - ${wx}, w[1] - ${wy}); if (!best || d < best.d) best = { d, x: r.left + sx, y: r.top + sy }; }
    return best; }`);
// grab the visible 3D body of the TV (it hangs 1 m above its floor footprint)
const from = await ed(`(e) => { const plan = e.shadowRoot.querySelector('fp-plan'); const r = plan.pieceRect('${tvId}');
  for (let fy = 0.5; fy > 0.05; fy -= 0.1) for (let fx = 0.5; fx < 0.95; fx += 0.1) { const x = r.x + r.w * fx, y = r.y + r.h * fy; if (plan.pieceAt(x, y) === '${tvId}') return { x, y }; }
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; }`);
const grabbed = await toScreen(tv.x, tv.y);
const to = await ed(`(e) => { const plan = e.shadowRoot.querySelector('fp-plan'); const pz = plan.panZoom; const r = plan.getBoundingClientRect(); plan.dragZ = 100 + 85 * 0.62 * 0.5;
    let best = null; for (let sx = 0; sx < r.width; sx += 4) for (let sy = 0; sy < r.height; sy += 4) { const w = pz.toWorld(sx, sy); const d = Math.hypot(w[0] - ${midX}, w[1] - ${topY + 30}); if (!best || d < best.d) best = { d, x: r.left + sx, y: r.top + sy }; }
    plan.dragZ = 0; return best; }`);
await page.mouse.move(from.x, from.y);
await page.mouse.down();
for (let i = 1; i <= 14; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 14, from.y + ((to.y - from.y) * i) / 14);
await page.mouse.up();
await page.waitForTimeout(400);
const tv2 = await ed(`(e) => e._draft.floors[0].furniture.find((f) => f.id === '${tvId}')`);
const wall = await ed((e) => e._draft.wall_width ?? 8);
ok(tv2.variant === 'wall', 'TV set to wall mounted');
ok(Math.abs(tv2.y - (topY + wall / 2 + tv2.h / 2 + 0.5)) < 1.5 && !tv2.rotation, `TV docked to the wall (y=${tv2.y}, wall at ${topY}, rotation ${tv2.rotation ?? 0})`);
ok(Math.abs(tv2.x - midX) < 25, `3D drag landed where aimed (x=${tv2.x}, target ${midX})`);
await page.locator(`${ED} .tool[data-panel="furniture"]`).click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/ed3d-3-tv-${scheme}.png` });
await page.locator(`${ED} .tb-left .btn`).click();
await page.waitForTimeout(300);
if (await page.locator(`${ED} .alert`).count()) await page.locator(`${ED} .alert .btn.danger`).click();
console.log(errors.length ? errors.join('\n') : 'console: keine Fehler/Warnungen');
await browser.close();
