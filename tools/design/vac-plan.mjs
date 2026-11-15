// Alignment mode: sides/corners on their own, plan walls onto the map, rooms from the map. Never saves.
import { openHA } from '../pw.mjs';
const out = process.argv[2] ?? '/tmp';
const { browser, page, errors } = await openHA({ size: '1280x900', kiosk: true, companion: true, block: ['light', 'climate', 'vacuum', 'cover', 'media_player', 'fan', 'switch', 'tts', 'notify'] });
const ED = 'floorplan-card-editor-ui';
const ok = (c, m) => console.log(c ? '• ok:' : '• FAIL:', m);
const ed = (fn) => page.evaluate(`(${fn})(document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui'))`);
await page.locator('floorplan-card .chrome .icon-btn[aria-label="Grundriss bearbeiten"]').click();
await page.waitForTimeout(1200);
// the plan without its bathroom (draft only): to add it from the map later
await ed(`(e) => e.mutate((_x, f) => { f.rooms = f.rooms.filter((r) => r.name !== 'Bad'); })`);
await ed(`(e) => e.select({ kind: 'furniture', id: e._draft.floors[0].furniture.find((f) => f.kind === 'robot_vacuum').id })`);
await page.waitForTimeout(2500);
await page.locator(`${ED} .panel button.row`, { hasText: 'Karte auflegen' }).click();
await page.waitForTimeout(1800);
const box = () => ed(`(e) => { const v = e.vacEdit(); return { b: v.box, tf: e.alignPiece.vacuum.transform, rooms: e.alignPiece.vacuum.rooms }; }`);
const dragHandle = async (hd, dx, dy) => {
  const b = await page.locator(`${ED} .h[data-handle="${hd}"]`).boundingBox();
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  // past the tap slop at once (a slow software-rendered page could otherwise turn it into a long press)
  await page.mouse.move(x + dx * 0.4, y + dy * 0.4);
  for (let i = 4; i <= 8; i++) { await page.mouse.move(x + (dx * i) / 8, y + (dy * i) / 8); if (process.env.DBG && i === 4) console.log('  ', hd, await ed(`(e) => e.drag?.type + ' ' + (e.drag?.orig?.side ?? '') + ' ' + JSON.stringify(e.alignPiece.vacuum.transform)`)); }
  await page.mouse.up(); await page.waitForTimeout(300);
};
ok((await page.locator(`${ED} .h.vacedge`).count()) === 8, 'eight side/corner handles');
let a = await box();
await dragHandle('vac-e:r', 40, 0);
let b = await box();
ok(Math.abs(b.b.minX - a.b.minX) < 3 && b.b.maxX > a.b.maxX + 20 && b.tf.scaleY !== undefined, `right side: wider, left side stays (${Math.round(a.b.minX)}→${Math.round(b.b.minX)}, ${Math.round(a.b.maxX)}→${Math.round(b.b.maxX)})`);
a = b;
{
  const hb = await page.locator(`${ED} .h[data-handle="vac-e:t"]`).boundingBox();
  console.log('  top handle', JSON.stringify(hb), await page.evaluate(([x, y]) => { let el = document.elementFromPoint(x, y); while (el?.shadowRoot) { const inner = el.shadowRoot.elementFromPoint(x, y); if (!inner || inner === el) break; el = inner; } return el?.tagName + '.' + el?.className + ' ' + (el?.dataset?.handle ?? ''); }, [hb.x + hb.width / 2, hb.y + hb.height / 2]));
}
await dragHandle('vac-e:t', 0, -30);
b = await box();
ok(Math.abs(b.b.maxY - a.b.maxY) < 3 && b.b.minY < a.b.minY - 15, `top side: taller, bottom stays (${Math.round(a.b.minY)}→${Math.round(b.b.minY)}, ${Math.round(a.b.maxY)}→${Math.round(b.b.maxY)})`);
a = b;
await dragHandle('vac-e:bl', -20, 20);
b = await box();
ok(Math.abs(b.b.maxX - a.b.maxX) < 3 && Math.abs(b.b.minY - a.b.minY) < 3, 'bottom-left corner: top-right stays');
await page.screenshot({ path: `${out}/edges.png` });
await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
// a room on its own: its left side
await page.locator(`${ED} .va-room`).nth(1).click(); await page.waitForTimeout(1200);
const rid = await ed(`(e) => e._align.room`);
a = await box();
await dragHandle('vac-e:l', -30, 0);
b = await box();
ok(Math.abs(b.b.maxX - a.b.maxX) < 3 && b.b.minX < a.b.minX - 10 && b.rooms?.[rid]?.scale > 1, `room ${rid}: left side wider, right side stays`);
await page.locator(`${ED} .va-roombar .btn`).click(); await page.waitForTimeout(600);
// plan walls onto the map
await page.locator(`${ED} .va-actions .btn`, { hasText: 'Plan anpassen' }).click(); await page.waitForTimeout(400);
const nW = await page.locator(`${ED} .h.planwall`).count();
ok(nW >= 8, `a handle on every wall (${nW})`);
const rooms0 = await ed(`(e) => JSON.stringify(e.floor.rooms.map((r) => r.points))`);
const hb = await page.locator(`${ED} .h.planwall`).first().boundingBox();
await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2); await page.mouse.down();
for (let i = 1; i <= 6; i++) await page.mouse.move(hb.x + hb.width / 2 + 3 * i, hb.y + hb.height / 2 + 3 * i);
await page.mouse.up(); await page.waitForTimeout(300);
const rooms1 = await ed(`(e) => JSON.stringify(e.floor.rooms.map((r) => r.points))`);
ok(rooms1 !== rooms0, 'dragging a wall handle moves that wall');
const square = await ed(`(e) => e.floor.rooms.every((r) => r.points.every((p, i) => { const q = r.points[(i + 1) % r.points.length]; return Math.abs(p[0] - q[0]) < 0.2 || Math.abs(p[1] - q[1]) < 0.2; }))`);
ok(square, 'all rooms stay square');
await page.keyboard.press('Control+z'); await page.waitForTimeout(200);
await page.locator(`${ED} .va-sub .btn`, { hasText: 'Alle Wände' }).click(); await page.waitForTimeout(400);
const rooms2 = await ed(`(e) => JSON.stringify(e.floor.rooms.map((r) => r.points))`);
ok(rooms2 !== rooms0 && (await ed(`(e) => e.floor.rooms.every((r) => r.points.every((p, i) => { const q = r.points[(i + 1) % r.points.length]; return Math.abs(p[0] - q[0]) < 0.2 || Math.abs(p[1] - q[1]) < 0.2; }))`)), 'all walls fitted to the map, still square');
await page.screenshot({ path: `${out}/walls.png` });
await page.keyboard.press('Control+z'); await page.waitForTimeout(200);
// the missing bathroom from the map
const btn = page.locator(`${ED} .va-sub .btn`, { hasText: 'Fehlende Räume' });
ok((await btn.count()) === 1, 'offers to add the missing room');
await btn.click(); await page.waitForTimeout(400);
const bad = await ed(`(e) => e.floor.rooms.find((r) => r.name === 'Badezimmer')?.points`);
ok(!!bad && bad.length >= 4, `bathroom added from the map ${JSON.stringify(bad)}`);
await page.screenshot({ path: `${out}/created.png` });
await page.locator(`${ED} .va-done`).click(); await page.waitForTimeout(400);
await page.locator(`${ED} .tb-left .btn`).click(); await page.waitForTimeout(300);
if (await page.locator(`${ED} .alert`).count()) await page.locator(`${ED} .alert .btn.danger`).click();
console.log(errors.length ? errors.join('\n') : 'console: ok');
await browser.close();
