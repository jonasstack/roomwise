// View rotation, per-user default, idle return, wall paint, editor settings. Temporary config only (never saved).
import { openHA } from '../pw.mjs';
const out = process.argv[2] ?? '/tmp';
const scheme = process.argv[3] ?? 'light';
const { browser, page, errors } = await openHA({ size: '1280x800', scheme, kiosk: true, touch: true, block: ['light', 'climate', 'vacuum', 'cover', 'todo', 'media_player', 'fan', 'switch'] });
const FIND = `const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } };`;
const card = (expr) => page.evaluate(`(() => { ${FIND} const card = find(document); const plan = card.shadowRoot.querySelector('fp-plan'); return ${expr}; })()`);
const ok = (c, m) => console.log(c ? '• ok:' : '• FAIL:', m);
const cdp = await page.context().newCDPSession(page);
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });

// temporary config: wall paints, a long idle return first (screenshots with software WebGL take seconds)
await card(`(card.setConfig({ ...card.rawConfig, idle_reset: 60, wall_color: '#c98b6b',
  floors: card.rawConfig.floors.map((f) => ({ ...f, rooms: f.rooms.map((r, i) => ({ ...r, wall_color: ['#a9b9c9', '#b9c4ae', '#e6c9c1'][i % 3] })) })) }), true)`);
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/rot-0-${scheme}.png` });

// compass tap rotates 90°
await page.locator('floorplan-card .compass').tap();
await page.waitForTimeout(600);
ok((await card('plan.spin')) === 90, `compass tap rotates to ${await card('plan.spin')}°`);
await page.screenshot({ path: `${out}/rot-90-${scheme}.png` });

// two-finger rotation (touch)
const box = await page.locator('floorplan-card fp-plan').boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
await touch('touchStart', [[cx - 100, cy], [cx + 100, cy]]);
for (let i = 1; i <= 12; i++) {
  const a = (i * 4 * Math.PI) / 180; // up to 48°
  await touch('touchMove', [[cx - 100 * Math.cos(a), cy - 100 * Math.sin(a)], [cx + 100 * Math.cos(a), cy + 100 * Math.sin(a)]]);
  await page.waitForTimeout(16);
}
await touch('touchEnd', []);
await page.waitForTimeout(500);
const s2 = await card('plan.spin');
ok(s2 > 110 && s2 < 140, `two-finger rotation → ${s2.toFixed(1)}° (free angle kept)`);
await page.screenshot({ path: `${out}/rot-free-${scheme}.png` });
ok(await card(`!card.shadowRoot.querySelector('.reset').classList.contains('hidden')`), 'reset button visible after rotating');

// idle return (3 s from the last touch)
await card(`(card.setConfig({ ...card.rawConfig, idle_reset: 3 }), true)`);
await touch('touchStart', [[cx, cy]]);
await touch('touchEnd', []);
await page.waitForTimeout(3800);
ok(Math.abs((await card('plan.spin')) % 360) < 0.5, `returned to default orientation after inactivity (${await card('plan.spin')}°)`);

// per-user default orientation + view
const uid = await page.evaluate(() => document.querySelector('home-assistant').hass.user.id);
await card(`(card.setConfig({ ...card.rawConfig, users: { '${uid}': { orientation: 270, view_mode: '2d' } } }), true)`);
await page.waitForTimeout(900);
ok((await card('plan.spin')) % 360 === 270 && !(await card('plan.is3d')), `per-user default: 270° and 2D (${await card('plan.spin')}°, 3D=${await card('plan.is3d')})`);
await page.screenshot({ path: `${out}/rot-user-${scheme}.png` });
await card(`(card.setConfig({ ...card.rawConfig, users: undefined }), true)`);
await page.waitForTimeout(600);

// shift + wheel rotation (desktop)
await page.mouse.move(cx, cy);
await page.keyboard.down('Shift');
for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 100);
await page.keyboard.up('Shift');
await page.waitForTimeout(600);
ok(Math.abs(((await card('plan.spin')) % 360) - 30) < 1, `shift+wheel rotates (${await card('plan.spin')}°)`);

// editor settings + room paint (discarded)
await page.locator('floorplan-card .chrome .icon-btn[aria-label="Grundriss bearbeiten"]').tap();
await page.waitForTimeout(700);
await page.locator('floorplan-card-editor-ui .tool[data-panel="settings"]').tap();
await page.waitForTimeout(900);
await page.evaluate(() => { for (const d of document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui').shadowRoot.querySelectorAll('details.fold')) d.open = true; }); // collapsed groups
await page.locator('floorplan-card-editor-ui .panel .section-title', { hasText: 'Startansicht' }).scrollIntoViewIfNeeded();
await page.screenshot({ path: `${out}/rot-settings-${scheme}.png` });
ok((await page.locator('floorplan-card-editor-ui .panel .user-block').count()) > 0, `user list loaded (${await page.locator('floorplan-card-editor-ui .panel .user-block').count()} users)`);
await page.locator('floorplan-card-editor-ui .tb-left .btn').tap();
await page.waitForTimeout(300);
if (await page.locator('floorplan-card-editor-ui .alert').count()) await page.locator('floorplan-card-editor-ui .alert .btn.danger').tap();
console.log(errors.length ? errors.join('\n') : 'console: keine Fehler/Warnungen');
await browser.close();
