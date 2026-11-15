// Zoom-to-room action with view side. Temporary config only (never saved).
import { openHA, tapAt } from '../pw.mjs';
const out = process.argv[2] ?? '/tmp';
const scheme = process.argv[3] ?? 'light';
const { browser, page, errors } = await openHA({ size: '1280x800', scheme, kiosk: true, block: ['light', 'climate', 'vacuum', 'cover', 'todo', 'media_player', 'fan', 'switch'] });
const ok = (c, m) => console.log(c ? '• ok:' : '• FAIL:', m);
const FIND = `const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } };`;
const card = (expr) => page.evaluate(`(() => { ${FIND} const card = find(document); const plan = card.shadowRoot.querySelector('fp-plan'); return ${expr}; })()`);
await card(`(card.setConfig({ ...card.rawConfig, floors: card.rawConfig.floors.map((f) => ({ ...f, rooms: f.rooms.map((r) =>
  r.name === 'Küche' ? { ...r, tap_action: { action: 'zoom' }, view_angle: 180 } : r.name === 'Wohnzimmer' ? { ...r, tap_action: { action: 'zoom' }, view_angle: 90 } : r) })) }), true)`);
await page.waitForTimeout(1200);
const roomPt = (name) =>
  card(`(() => { const id = card.rawConfig.floors[0].rooms.find((r) => r.name === '${name}').id; const path = plan.shadowRoot.querySelector('path.room[data-room="' + id + '"]'); const r = path.getBoundingClientRect();
    for (let fy = 0.3; fy <= 0.9; fy += 0.05) for (let fx = 0.2; fx <= 0.8; fx += 0.05) { const x = r.left + r.width * fx, y = r.top + r.height * fy; const topEl = plan.shadowRoot.elementFromPoint(x, y); if (topEl && topEl.closest('.world-top .label, .world-top .marker-wrap')) continue; const hit = plan.hitTestInner({ clientX: x, clientY: y, composedPath: () => plan.shadowRoot.elementsFromPoint(x, y) }); if (hit?.kind !== 'room' || hit.id !== id) continue; if (plan.roomAt(x, y) === id && [[0, 0], [12, 0], [-12, 0], [0, 12], [0, -12], [9, 9], [-9, 9], [9, -9], [-9, -9]].every(([dx, dy]) => !plan.pieceAt(x + dx, y + dy))) return [x, y]; } })()`);
let p = await roomPt('Küche');
await tapAt(page, p[0], p[1]);
await page.waitForTimeout(1500);
ok(await card('plan.focused && plan.is3d'), 'tap zooms onto the kitchen and stays in 3D');
ok(Math.abs(((await card('plan.spin')) % 360 + 360) % 360 - 180) < 1, `kitchen seen from its configured side (${await card('plan.spin')}°)`);
await page.screenshot({ path: `${out}/zoom-kitchen-${scheme}.png` });
// tap beside the room returns
await tapAt(page, 300, 120);
await page.waitForTimeout(800);
ok(!(await card('plan.focused')) && Math.abs(((((await card('plan.spin')) - (await card('plan.defaultSpin'))) % 360) + 360) % 360) < 1, 'tap beside returns to the overview (default orientation)');
p = await roomPt('Wohnzimmer');
await tapAt(page, p[0], p[1]);
await page.waitForTimeout(1500);
ok(Math.abs(((await card('plan.spin')) % 360 + 360) % 360 - 90) < 1, `living room from the right (${await card('plan.spin')}°)`);
await page.screenshot({ path: `${out}/zoom-living-${scheme}.png` });
// same room again toggles back
p = await roomPt('Wohnzimmer');
await tapAt(page, p[0], p[1]);
await page.waitForTimeout(800);
ok(!(await card('plan.focused')), 'tapping the focused room again returns');
// editor side picker
await page.locator('floorplan-card .chrome .icon-btn[aria-label="Grundriss bearbeiten"]').click();
await page.waitForTimeout(800);
const r = await page.locator('floorplan-card-editor-ui fp-plan path.room').first().boundingBox();
await page.mouse.click(r.x + r.width * 0.2, r.y + r.height * 0.8);
await page.waitForTimeout(500);
// the view side sits in a collapsed group ("Ansicht beim Antippen")
const vf = page.locator('floorplan-card-editor-ui .panel details.fold', { has: page.locator('.side-picker') });
if (await vf.count()) await vf.locator('summary').click();
await page.locator('floorplan-card-editor-ui .panel .side.right').scrollIntoViewIfNeeded();
await page.locator('floorplan-card-editor-ui .panel .side.right').click();
await page.waitForTimeout(300);
ok((await page.evaluate(() => { const ed = document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui'); return ed.findSel(ed._sel)?.view_angle; })) === 90, 'editor: view side set to "from right" (90°)');
await page.screenshot({ path: `${out}/zoom-editor-${scheme}.png` });
await page.locator('floorplan-card-editor-ui .tb-left .btn').click();
await page.waitForTimeout(300);
if (await page.locator('floorplan-card-editor-ui .alert').count()) await page.locator('floorplan-card-editor-ui .alert .btn.danger').click();
console.log(errors.length ? errors.join('\n') : 'console: keine Fehler/Warnungen');
await browser.close();
