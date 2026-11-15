// Alignment mode for the vacuum's map: open, auto, drag, focus a room, match points, Escape, Done. Never saves.
import { openHA } from '../pw.mjs';
const out = process.argv[2] ?? '/tmp';
const size = process.argv[3] ?? '1280x900';
const { browser, page, errors } = await openHA({ size, kiosk: true, companion: true, block: ['light', 'climate', 'vacuum', 'cover', 'media_player', 'fan', 'switch', 'tts', 'notify'] });
const ED = 'floorplan-card-editor-ui';
const ok = (c, m) => console.log(c ? '• ok:' : '• FAIL:', m);
const ed = (fn) => page.evaluate(`(${fn})(document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui'))`);
const tf = () => ed(`(e) => e._draft.floors[0].furniture.find((f) => f.kind === 'robot_vacuum').vacuum?.transform`);
await page.locator('floorplan-card .chrome .icon-btn[aria-label="Grundriss bearbeiten"]').click();
await page.waitForTimeout(1200);
await ed(`(e) => e.select({ kind: 'furniture', id: e._draft.floors[0].furniture.find((f) => f.kind === 'robot_vacuum').id })`);
await page.waitForTimeout(3000);
await page.locator(`${ED} .panel button.row`, { hasText: 'Karte auflegen' }).click();
await page.waitForTimeout(1500);
ok(await page.locator(`${ED} .editor.aligning`).count() === 1, 'alignment mode open');
ok(await page.locator(`${ED} .tools, ${ED} .panel`).count() === 0, 'no tools, no panel');
ok(await page.locator(`${ED} fp-plan .piece`).count() === 0, 'no furniture on the plan');
await page.screenshot({ path: `${out}/mode-open-${size}.png` });
// Escape must not leave
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
ok(await page.locator(`${ED} .editor.aligning`).count() === 1, 'Escape does not leave the mode');
// tapping something else does nothing
const box = await page.locator(`${ED} fp-plan`).boundingBox();
await page.mouse.click(box.x + 60, box.y + 60);
await page.waitForTimeout(300);
ok(await page.locator(`${ED} .editor.aligning`).count() === 1, 'tap beside keeps the mode');
// auto
await page.locator(`${ED} .va-actions .btn`, { hasText: 'Automatisch' }).click();
await page.waitForTimeout(1500);
const t0 = await tf();
console.log('  auto:', JSON.stringify(t0), 'rooms:', (await page.locator(`${ED} .va-room`).allTextContents()).join(' | '));
// drag the map anywhere
const c = { x: box.x + box.width * 0.45, y: box.y + box.height * 0.45 };
await page.mouse.move(c.x, c.y); await page.mouse.down();
for (let i = 1; i <= 8; i++) await page.mouse.move(c.x + 5 * i, c.y + 3 * i);
await page.mouse.up(); await page.waitForTimeout(300);
const t1 = await tf();
ok(t1.x !== t0.x && t1.y !== t0.y, `drag moves the map (${t0.x},${t0.y} → ${t1.x},${t1.y})`);
await page.keyboard.press('Control+z'); await page.waitForTimeout(300);
ok((await tf()).x === t0.x, 'undo restores it');
// nudge and keys
await page.locator(`${ED} .va-step[aria-label="Nach rechts"]`).click(); await page.waitForTimeout(200);
ok((await tf()).x === t0.x + 2, 'nudge right 2 cm');
await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(200);
ok((await tf()).x === t0.x, 'arrow keys nudge');
// a room on its own: tap its chip → only that room, drag moves only it
const vac = () => ed(`(e) => e._draft.floors[0].furniture.find((f) => f.kind === 'robot_vacuum').vacuum`);
await page.locator(`${ED} .va-room`).nth(3).click(); await page.waitForTimeout(1200);
const roomId = await ed(`(e) => e._align.room`);
ok(!!roomId && (await page.locator(`${ED} .va-roombar`).count()) === 1, `room mode (${roomId})`);
ok(await ed(`(e) => e.shadowRoot.querySelector('fp-plan').shadowRoot.querySelectorAll('.vac-room').length`) === 1, 'only that room is shown');
ok(await ed(`(e) => !!e.shadowRoot.querySelector('fp-plan').shadowRoot.querySelector('.va-target')`), 'its counterpart in the plan is outlined');
await page.screenshot({ path: `${out}/mode-room-${size}.png` });
const tBefore = await tf();
const v0 = await vac();
const b2 = await page.locator(`${ED} fp-plan`).boundingBox();
const c2 = { x: b2.x + b2.width * 0.5, y: b2.y + b2.height * 0.3 };
await page.mouse.move(c2.x, c2.y); await page.mouse.down();
for (let i = 1; i <= 6; i++) await page.mouse.move(c2.x + 4 * i, c2.y);
await page.mouse.up(); await page.waitForTimeout(300);
const v1 = await vac();
ok(v1.rooms?.[roomId]?.x > (v0.rooms?.[roomId]?.x ?? 0) && JSON.stringify(v1.transform) === JSON.stringify(tBefore), `drag moves only the room (x ${v0.rooms?.[roomId]?.x ?? 0} → ${v1.rooms?.[roomId]?.x}), whole map unchanged`);
await page.locator(`${ED} .va-step[aria-label="Rechts drehen"]`).click(); await page.waitForTimeout(200);
ok(Math.abs((await vac()).rooms[roomId].rot - ((v1.rooms[roomId].rot ?? 0) + 0.5)) < 0.01, 'turn the room by 0.5°');
// cut out: a rectangle in the room, then tap it to bring it back
await page.locator(`${ED} .va-actions .btn`, { hasText: 'Zuschneiden' }).click();
await page.mouse.move(c2.x - 30, c2.y - 20); await page.mouse.down();
for (let i = 1; i <= 6; i++) await page.mouse.move(c2.x - 30 + 10 * i, c2.y - 20 + 7 * i);
await page.mouse.up(); await page.waitForTimeout(300);
ok(((await vac()).crop ?? []).length === (v0.crop ?? []).length + 1, 'a rectangle cuts an area out');
await page.screenshot({ path: `${out}/mode-crop-${size}.png` });
await page.mouse.click(c2.x, c2.y + 5); await page.waitForTimeout(300);
ok(((await vac()).crop ?? []).length === (v0.crop ?? []).length, 'tapping the cut-out brings it back');
await page.locator(`${ED} .va-actions .btn`, { hasText: 'Zuschneiden' }).click();
await page.locator(`${ED} .va-roombar .btn`).click(); await page.waitForTimeout(800);
ok(!(await ed(`(e) => e._align.room`)) && (await page.locator(`${ED} .va-room`).count()) === 5, 'back to the whole map');
// tapping a room on the map opens it on its own
const roomScreen = await ed(`(e) => { const vm = e.alignMap; const r = vm.rooms[1]; const m = r.pts[Math.floor(r.pts.length / 2)]; const p = e.vacEdit().m.toPlan(m[0], m[1]); const plan = e.shadowRoot.querySelector('fp-plan'); const rc = plan.getBoundingClientRect(); const v = plan.panZoom.view; return [rc.left + v.tx + p[0] * v.s, rc.top + v.ty + p[1] * v.s, r.id]; }`);
await page.mouse.click(roomScreen[0], roomScreen[1]); await page.waitForTimeout(800);
ok((await ed(`(e) => e._align.room`)) === roomScreen[2], 'tapping a room on the map opens it');
await page.locator(`${ED} .va-roombar .btn`).click(); await page.waitForTimeout(600);
// match points: two map spots → two plan spots (here: map points of the current fit = identity check)
await page.locator(`${ED} .va-actions .btn`, { hasText: 'Punkte zuordnen' }).click();
const pairs = await ed(`(e) => { const f = e._draft.floors[0]; const rooms = f.rooms; return [rooms[0].points[2], rooms[4].points[1]]; }`);
const toScreen = (p) => ed(`(e) => { const plan = e.shadowRoot.querySelector('fp-plan'); const r = plan.getBoundingClientRect(); const v = plan.panZoom.view; return [r.left + v.tx + ${p[0]} * v.s, r.top + v.ty + ${p[1]} * v.s]; }`);
for (const p of pairs) {
  const s = await toScreen([p[0] + 30, p[1] + 30]);
  await page.mouse.click(s[0], s[1]); await page.waitForTimeout(250);
  const q = await toScreen(p);
  await page.mouse.click(q[0], q[1]); await page.waitForTimeout(250);
}
const t2 = await tf();
const n = await ed(`(e) => e._align.pairs.length`);
ok(n === 2 && (t2.x !== t0.x || t2.y !== t0.y), `two pairs set and applied (${JSON.stringify(t2)})`);
await page.screenshot({ path: `${out}/mode-pairs-${size}.png` });
// done
await page.locator(`${ED} .va-done`).click(); await page.waitForTimeout(500);
ok(await page.locator(`${ED} .editor.aligning`).count() === 0 && await page.locator(`${ED} .panel`).count() === 1, 'Done returns to the editor (inspector open)');
// discard everything
await page.locator(`${ED} .tb-left .btn`).click();
await page.waitForTimeout(300);
if (await page.locator(`${ED} .alert`).count()) await page.locator(`${ED} .alert .btn.danger`).click();
console.log(errors.length ? errors.join('\n') : 'console: ok');
await browser.close();
