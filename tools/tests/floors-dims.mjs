// Editor: live wall lengths + floor materials (discarded, nothing saved).
// View: temporary config with floors + an open window (simulated in the page only) to check wind/sun.
import { openHA, tapAt } from '../pw.mjs';
const out = process.argv[2] ?? '/tmp';
const scheme = process.argv[3] ?? 'light';
const BLOCK = ['light', 'climate', 'vacuum', 'cover', 'todo', 'media_player', 'fan', 'switch', 'homeassistant'];
const { browser, page, errors } = await openHA({ size: '1280x800', scheme, block: BLOCK, kiosk: true });
const ED = 'floorplan-card-editor-ui';
const FIND = `const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } };`;
const w2s = (x, y) =>
  page.evaluate(([x, y]) => {
    const ed = document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui');
    const plan = ed.shadowRoot.querySelector('fp-plan');
    const r = plan.getBoundingClientRect();
    const v = plan.panZoom.view;
    return { x: r.left + v.tx + x * v.s, y: r.top + v.ty + y * v.s };
  }, [x, y]);

// --- Editor: draw a rectangle and an L-room, watch the dimension labels
await page.locator('floorplan-card .chrome .icon-btn[aria-label="Grundriss bearbeiten"]').click();
await page.waitForTimeout(700);
await page.locator(`${ED} .tool[data-tool="draw"]`).click();
await page.waitForTimeout(600);
const a = await w2s(100, 100);
const b = await w2s(520, 420);
await page.mouse.move(a.x, a.y);
await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / 10, a.y + ((b.y - a.y) * i) / 10);
await page.waitForTimeout(200);
await page.screenshot({ path: `${out}/dims-rect-drag-${scheme}.png` });
console.log('rect drag labels:', (await page.locator(`${ED} fp-plan .dim`).allTextContents()).join(' | '));
await page.mouse.up();
await page.waitForTimeout(400);
// polygon with hover preview
await page.locator(`${ED} .tool[data-tool="draw"]`).click();
await page.waitForTimeout(600);
for (const p of [[520, 100], [860, 100], [860, 300]]) {
  const s = await w2s(...p);
  await tapAt(page, s.x, s.y);
  await page.waitForTimeout(120);
}
const h = await w2s(700, 420);
await page.mouse.move(h.x, h.y);
await page.waitForTimeout(200);
await page.screenshot({ path: `${out}/dims-polygon-hover-${scheme}.png` });
console.log('polygon labels:', (await page.locator(`${ED} fp-plan .dim`).allTextContents()).join(' | '));
// one-finger style drag places the next point
const d1 = await w2s(860, 300);
const d2 = await w2s(700, 300);
await page.mouse.move(d1.x, d1.y);
await page.mouse.down();
for (let i = 1; i <= 8; i++) await page.mouse.move(d1.x + ((d2.x - d1.x) * i) / 8, d1.y + ((d2.y - d1.y) * i) / 8);
await page.mouse.up();
await page.waitForTimeout(200);
console.log('points after drag-place:', JSON.stringify(await page.evaluate(() => document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui')._drawing)));
await page.keyboard.press('Escape');
await page.locator(`${ED} .tool[data-tool="select"]`).click();
await page.waitForTimeout(600);
// select the rectangle room, set herringbone floor, edit a wall length
const c = await w2s(300, 260);
await tapAt(page, c.x, c.y);
await page.waitForTimeout(400);

await page.evaluate(() => { for (const d of document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui').shadowRoot.querySelectorAll('details.fold')) d.open = true; }); // collapsed groups
await page.locator(`${ED} .panel .mat[data-floor="herringbone"]`).click();
await page.waitForTimeout(200);
const len = page.locator(`${ED} .panel .wall-row input.len`).first();
await len.fill('4.5');
await len.press('Enter');
await page.waitForTimeout(300);
const pts = await page.evaluate(() => document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui')._draft.floors[0].rooms[0].points);
console.log('rect points after setting wall 1 to 4.5 m:', JSON.stringify(pts));
await page.locator(`${ED} .panel .mat[data-floor="herringbone"]`).scrollIntoViewIfNeeded();
await page.screenshot({ path: `${out}/floor-editor-${scheme}.png` });
await page.locator(`${ED} .tb-left .btn`).click();
await page.waitForTimeout(300);
await page.locator(`${ED} .alert .btn.danger`).click();
await page.waitForTimeout(500);

// --- View: temporary demo config (not saved) with floors + open window
await page.evaluate(`(() => { ${FIND}
  const card = find(document);
  const W = 'binary_sensor.fenster_kueche';
  const fake = (st) => ({ ...st, [W]: { ...st[W], state: 'on' } });
  const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(card), 'hass');
  Object.defineProperty(card, 'hass', { configurable: true, get() { return desc.get.call(this); }, set(h) { desc.set.call(this, { ...h, states: fake(h.states) }); } });
  card.setConfig({ ...card.rawConfig, floors: [{ id: 'demo', name: 'Demo', devices: [], furniture: [
      { id: 'f1', kind: 'sofa', x: 200, y: 380, w: 220, h: 95 }, { id: 'f2', kind: 'rug', x: 230, y: 250, w: 200, h: 140 },
      { id: 'f3', kind: 'counter', x: 720, y: 40, w: 300, h: 62 }, { id: 'f4', kind: 'bathtub', x: 840, y: 520, w: 170, h: 75, rotation: 90 } ],
    rooms: [
      { id: 'r1', name: 'Wohnzimmer', points: [[0,0],[540,0],[540,460],[0,460]], floor: { type: 'herringbone', color: '#c99a62' } },
      { id: 'r2', name: 'Küche', points: [[540,0],[880,0],[880,300],[540,300]], floor: { type: 'hex', color: '#a8b8a0', size: 22 } },
      { id: 'r3', name: 'Schlafzimmer', points: [[0,460],[540,460],[540,760],[0,760]], floor: { type: 'planks', color: '#e3c9a0' } },
      { id: 'r4', name: 'Flur', points: [[540,300],[880,300],[880,420],[700,420],[700,760],[540,760]], floor: { type: 'checker', color: '#f4f4f2', size: 30 } },
      { id: 'r5', name: 'Bad', points: [[700,420],[880,420],[880,760],[700,760]], floor: { type: 'tiles', color: '#8fa9c0', size: 30 } } ],
    openings: [
      { id: 'o1', type: 'window', a: [660, 0], b: [780, 0], entity: W },
      { id: 'o2', type: 'window', a: [880, 540], b: [880, 660] },
      { id: 'o3', type: 'window', a: [0, 560], b: [0, 680] },
      { id: 'o4', type: 'door', a: [540, 340], b: [540, 430] } ] }] });
  card.hass = document.querySelector('home-assistant').hass;
})()`);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/floors-view-3d-${scheme}.png` });
await page.locator('floorplan-card .chrome .icon-btn[aria-label="2D"]').click();
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/floors-view-2d-${scheme}.png` });
console.log(errors.length ? errors.join('\n') : 'console: keine Fehler/Warnungen');
await browser.close();
