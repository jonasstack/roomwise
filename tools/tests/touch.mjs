// Touch tests via CDP touch events: tap, long press, pinch zoom, editor drawing with one finger.
// All service calls are intercepted; the editor is discarded (nothing saved).
import { openHA, piecePoint, roomPoint } from '../pw.mjs';

const out = process.argv[2] ?? '/tmp';
const { browser, page, errors } = await openHA({
  size: '1280x800',
  touch: true,
  block: ['light', 'climate', 'vacuum', 'cover', 'todo', 'media_player', 'fan', 'switch', 'homeassistant'],
});
const cdp = await page.context().newCDPSession(page);
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
const sleep = (ms) => page.waitForTimeout(ms);
const ok = (c, m) => console.log(c ? '• ok:' : '• FAIL:', m);
const card = `(() => { const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } }; return find(document); })()`;

async function tap(x, y, hold = 0) {
  await touch('touchStart', [[x, y]]);
  await sleep(hold || 40);
  await touch('touchEnd', []);
  await sleep(150);
}

// 1) Touch long press on a light opens its popup
const lamp = await piecePoint(page, 'light.');
await tap(lamp[0], lamp[1], 700);
await sleep(600);
ok((await page.locator('floorplan-card-layer .sheet').count()) === 1, 'touch long press on a light opens its popup');
await page.keyboard.press('Escape');
await sleep(400);

// 2) Long press on a room opens the room popup
const roomPt = await roomPoint(page, 1);
await tap(roomPt[0], roomPt[1], 700);
await sleep(600);
ok((await page.locator('fp-room-popup').count()) === 1, 'long press on a room opens the room popup');
await page.keyboard.press('Escape');
await sleep(400);
const calls = await page.evaluate(() => window.__fpCalls.filter((c) => c.domain === 'light'));
ok(calls.length === 0, 'long press did not toggle the lights');

// 3) Pinch zoom with two fingers
const box = await page.locator('floorplan-card fp-plan').boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
const s0 = await page.evaluate(`${card}.shadowRoot.querySelector('fp-plan').panZoom.scale`);
await touch('touchStart', [[cx - 60, cy], [cx + 60, cy]]);
for (let i = 1; i <= 10; i++) {
  await touch('touchMove', [[cx - 60 - i * 15, cy], [cx + 60 + i * 15, cy]]);
  await sleep(16);
}
await touch('touchEnd', []);
await sleep(500);
const s1 = await page.evaluate(`${card}.shadowRoot.querySelector('fp-plan').panZoom.scale`);
ok(s1 > s0 * 1.8, `pinch zoomed in (scale ${s0.toFixed(3)} → ${s1.toFixed(3)})`);
ok(await page.evaluate(`${card}.shadowRoot.querySelector('fp-plan').is3d`), 'pinch zoom keeps the 3D view (no longer flattens to 2D)');
await page.screenshot({ path: `${out}/touch-pinched.png` });
// one-finger pan
const v0 = await page.evaluate(`${card}.shadowRoot.querySelector('fp-plan').panZoom.view.tx`);
await touch('touchStart', [[cx, cy]]);
for (let i = 1; i <= 8; i++) {
  await touch('touchMove', [[cx + i * 20, cy]]);
  await sleep(16);
}
await touch('touchEnd', []);
await sleep(300);
const v1 = await page.evaluate(`${card}.shadowRoot.querySelector('fp-plan').panZoom.view.tx`);
ok(Math.abs(v1 - v0 - 160) < 30, `one-finger drag pans (${(v1 - v0).toFixed(0)} px)`);
ok((await page.evaluate(() => window.__fpCalls.filter((c) => c.domain === 'light'))).length === 0, 'pan did not trigger a tap action');
// double tap resets
await tap(cx, cy);
await sleep(60);
await tap(cx, cy);
await sleep(700);
ok(await page.evaluate(`${card}.shadowRoot.querySelector('fp-plan').is3d`), 'touch double tap resets to the 3D overview');

// 4) Editor with touch: new floor, draw a rectangle with one finger, move a vertex, then discard
await page.locator('floorplan-card .chrome.top .icon-btn[aria-label="Grundriss bearbeiten"]').tap();
await sleep(700);
const ED = 'floorplan-card-editor-ui';
await page.locator(`${ED} .tb-center .tb-add-floor`).tap(); // add floor
await sleep(500);
await page.locator(`${ED} .tool[data-tool="draw"]`).tap();
await sleep(300);
const pb = await page.locator(`${ED} fp-plan`).boundingBox();
const a = [pb.x + pb.width * 0.3, pb.y + pb.height * 0.3];
const b = [pb.x + pb.width * 0.6, pb.y + pb.height * 0.65];
await touch('touchStart', [a]);
for (let i = 1; i <= 12; i++) {
  await touch('touchMove', [[a[0] + ((b[0] - a[0]) * i) / 12, a[1] + ((b[1] - a[1]) * i) / 12]]);
  await sleep(16);
}
await touch('touchEnd', []);
await sleep(400);
const draft = () => page.evaluate(() => document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui')._draft);
let d = await draft();
const fl = d.floors[d.floors.length - 1];
ok(d.floors.length >= 2 && fl.rooms.length === 1 && fl.rooms[0].points.length === 4, 'touch: new floor + rectangle room drawn with one finger');
// drag first vertex with touch
const h = await page.locator(`${ED} fp-plan .h.vertex`).first().boundingBox();
const hx = h.x + h.width / 2;
const hy = h.y + h.height / 2;
await touch('touchStart', [[hx, hy]]);
for (let i = 1; i <= 8; i++) {
  await touch('touchMove', [[hx - i * 8, hy - i * 8]]);
  await sleep(16);
}
await touch('touchEnd', []);
await sleep(300);
d = await draft();
ok(JSON.stringify(d.floors[d.floors.length - 1].rooms[0].points[0]) !== JSON.stringify(fl.rooms[0].points[0]), 'touch: vertex dragged');
// pinch inside the editor
const es0 = await page.evaluate(() => document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui').shadowRoot.querySelector('fp-plan').panZoom.scale);
const ecx = pb.x + pb.width / 2;
const ecy = pb.y + pb.height / 2;
await touch('touchStart', [[ecx - 50, ecy - 50], [ecx + 50, ecy + 50]]);
for (let i = 1; i <= 8; i++) {
  await touch('touchMove', [[ecx - 50 - i * 10, ecy - 50 - i * 10], [ecx + 50 + i * 10, ecy + 50 + i * 10]]);
  await sleep(16);
}
await touch('touchEnd', []);
await sleep(300);
const es1 = await page.evaluate(() => document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui').shadowRoot.querySelector('fp-plan').panZoom.scale);
ok(es1 > es0 * 1.5, 'touch: pinch zoom in the editor');
await page.screenshot({ path: `${out}/touch-editor.png` });
// discard
await page.locator(`${ED} .tb-left .btn`).tap();
await sleep(300);
await page.locator(`${ED} .alert .btn.danger`).tap();
await sleep(500);
ok((await page.locator(ED).count()) === 0, 'editor discarded without saving');
console.log(errors.length ? 'CONSOLE:\n' + errors.join('\n') : 'console: keine Fehler/Warnungen');
await browser.close();
