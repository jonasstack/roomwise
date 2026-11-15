// Pin a room label by dragging it in the editor, toggle labels off; view check with a temporary config. Nothing saved.
import { openHA } from '../pw.mjs';
const out = process.argv[2] ?? '/tmp';
const { browser, page, errors } = await openHA({ size: '1280x800', kiosk: true, block: ['light', 'climate', 'vacuum', 'cover', 'todo', 'media_player', 'fan', 'switch'] });
const ED = 'floorplan-card-editor-ui';
const ok = (c, m) => console.log(c ? '• ok:' : '• FAIL:', m);
const ed = (fn) => page.evaluate(`(${fn})(document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui'))`);
await page.locator('floorplan-card .chrome .icon-btn[aria-label="Grundriss bearbeiten"]').click();
await page.waitForTimeout(800);
const room = await ed((e) => e._draft.floors[0].rooms.find((r) => r.name === 'Wohnzimmer'));
const label = page.locator(`${ED} fp-plan .label[data-label="${room.id}"]`);
const lb = await label.boundingBox();
const target = await ed(`(e) => { const plan = e.shadowRoot.querySelector('fp-plan'); const r = plan.getBoundingClientRect(); const v = plan.panZoom.view; return { x: r.left + v.tx + (-110) * v.s, y: r.top + v.ty + 500 * v.s }; }`);
await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2);
await page.mouse.down();
for (let i = 1; i <= 12; i++) await page.mouse.move(lb.x + lb.width / 2 + ((target.x - lb.x - lb.width / 2) * i) / 12, lb.y + lb.height / 2 + ((target.y - lb.y - lb.height / 2) * i) / 12);
await page.mouse.up();
await page.waitForTimeout(400);
const pinned = await ed(`(e) => e._draft.floors[0].rooms.find((r) => r.id === '${room.id}').label`);
ok(Array.isArray(pinned) && pinned[0] < 0, `label dragged and pinned at ${JSON.stringify(pinned)}`);
ok((await ed((e) => e._sel?.kind)) === 'room', 'dragging the label selected its room');
ok((await page.locator(`${ED} .panel .title`, { hasText: 'Fixiert' }).count()) === 1, 'inspector shows "Fixiert"');
await page.screenshot({ path: `${out}/pin-editor.png` });
// labels off
await page.locator(`${ED} .tool[aria-label="Schilder ein/aus"]`).click();
await page.waitForTimeout(300);
ok((await page.locator(`${ED} fp-plan .label`).count()) === 0, 'labels hidden in the editor');
await page.screenshot({ path: `${out}/pin-editor-off.png` });
await page.locator(`${ED} .tool[aria-label="Schilder ein/aus"]`).click();
// reset to automatic
await page.evaluate(() => { for (const d of document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui').shadowRoot.querySelectorAll('details.fold')) d.open = true; }); // collapsed groups
await page.locator(`${ED} .panel button.btn`, { hasText: 'Lösen' }).click();
await page.waitForTimeout(200);
ok(!(await ed(`(e) => e._draft.floors[0].rooms.find((r) => r.id === '${room.id}').label`)), 'reset to automatic placement');
await page.locator(`${ED} .tb-left .btn`).click();
await page.waitForTimeout(300);
if (await page.locator(`${ED} .alert`).count()) await page.locator(`${ED} .alert .btn.danger`).click();
await page.waitForTimeout(500);
// view with a temporary pinned label (not saved)
const FIND = `const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } };`;
await page.evaluate(`(() => { ${FIND} const card = find(document);
  card.setConfig({ ...card.rawConfig, floors: card.rawConfig.floors.map((f) => ({ ...f, rooms: f.rooms.map((r) => r.name === 'Wohnzimmer' ? { ...r, label: [-110, 500] } : r.name === 'Küche' ? { ...r, label: [700, 560] } : r) })) }); })()`);
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/pin-view-3d.png` });
await page.locator('floorplan-card .chrome .icon-btn[aria-label="2D"]').click();
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/pin-view-2d.png` });
console.log(errors.length ? errors.join('\n') : 'console: keine Fehler/Warnungen');
await browser.close();
