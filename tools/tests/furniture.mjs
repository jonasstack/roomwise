// Furniture library/inspector (discarded) + temporary furnished kitchen/living room in 3D. Nothing saved.
import { openHA } from '../pw.mjs';
const out = process.argv[2] ?? '/tmp';
const scheme = process.argv[3] ?? 'light';
const { browser, page, errors } = await openHA({ size: '1280x800', scheme, kiosk: true, block: ['light', 'climate', 'vacuum', 'cover', 'todo', 'media_player', 'fan', 'switch'] });
const ED = 'floorplan-card-editor-ui';
const ok = (c, m) => console.log(c ? '• ok:' : '• FAIL:', m);
await page.locator('floorplan-card .chrome .icon-btn[aria-label="Grundriss bearbeiten"]').click();
await page.waitForTimeout(800);
await page.locator(`${ED} .tool[data-panel="furniture"]`).click();
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/furn-lib-living-${scheme}.png` });
await page.locator(`${ED} .cat-chips .chip`, { hasText: 'Küchengeräte' }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/furn-lib-appliances-${scheme}.png` });
const n = await page.locator(`${ED} .furn`).count();
ok(n >= 15, `appliance category lists ${n} items`);
await page.locator(`${ED} .lib-search`).fill('airfryer');
await page.waitForTimeout(200);
await page.locator(`${ED} .furn[data-kind="airfryer"]`).click();
await page.waitForTimeout(400);
await page.evaluate(() => { for (const d of document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui').shadowRoot.querySelectorAll('details.fold')) d.open = true; }); // collapsed groups
await page.locator(`${ED} .panel .chip`, { hasText: 'Doppelkorb' }).click();
await page.locator(`${ED} .panel .swatch[aria-label="#c94a3a"]`).first().click();
await page.waitForTimeout(300);
const item = await page.evaluate(() => {
  const ed = document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui');
  return ed._draft.floors[0].furniture.find((f) => f.id === ed._sel?.id);
});
const before = await page.evaluate(() => document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui')._draft.floors[0].furniture.filter((f) => f.kind === 'airfryer').length);
ok(item?.variant === 'dual' && item?.color === '#c94a3a', `airfryer customized (${item?.variant}, ${item?.color}, ${item?.w}x${item?.h})`);
await page.screenshot({ path: `${out}/furn-inspector-${scheme}.png` });
await page.keyboard.press('Control+d');
await page.waitForTimeout(200);
ok((await page.evaluate(() => document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui')._draft.floors[0].furniture.filter((f) => f.kind === 'airfryer').length)) === before + 1, 'Ctrl+D duplicates');
await page.locator(`${ED} .tb-left .btn`).click();
await page.waitForTimeout(300);
if (await page.locator(`${ED} .alert`).count()) await page.locator(`${ED} .alert .btn.danger`).click();
await page.waitForTimeout(400);

// temporary furnished plan
const FIND = `const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } };`;
await page.evaluate(`(() => { ${FIND} const card = find(document);
  const F = (id, kind, x, y, extra = {}) => ({ id, kind, x, y, w: extra.w ?? 60, h: extra.h ?? 60, ...extra });
  const furniture = [
    F('k1', 'counter', 700, 646, { w: 460, h: 62, count: 7, color: '#2f3a3a', accent: '#d2a878' }),
    F('k2', 'cooktop', 600, 646, { w: 60, h: 52, variant: 'induction' }),
    F('k3', 'sink', 760, 646, { w: 80, h: 50, variant: 'drainer' }),
    F('k4', 'airfryer', 860, 646, { w: 40, h: 38, variant: 'dual', color: '#c94a3a' }),
    F('k5', 'thermomix', 500, 646, { w: 33, h: 33 }),
    F('k6', 'kettle', 900, 646, { w: 24, h: 20 }),
    F('k7', 'coffee', 820, 646, { w: 26, h: 44 }),
    F('k8', 'fridge', 905, 560, { w: 60, h: 65, rotation: 270 }),
    F('k9', 'wall_cabinet', 660, 655, { w: 240, h: 35, count: 4, color: '#2f3a3a' }),
    F('k10', 'island', 690, 500, { w: 180, h: 90, count: 3 }),
    F('k11', 'toaster', 640, 500, { w: 30, h: 18 }),
    F('k12', 'trash', 480, 560, { variant: 'sorting', w: 60, h: 35 }),
    F('l1', 'sofa', 180, 600, { variant: 'l', w: 270, h: 160, color: '#8aa0b5' }),
    F('l2', 'rug', 200, 520, { variant: 'stripes', w: 220, h: 150 }),
    F('l3', 'coffee_table', 200, 520, { variant: 'round', w: 80, h: 80 }),
    F('l4', 'tv_stand', 200, 420, { w: 180, h: 42 }),
    F('l5', 'tv', 200, 412, { w: 145, h: 8 }),
    F('l6', 'plant', 360, 430, { variant: 'palm', w: 70, h: 70 }),
    F('l7', 'robot_vacuum', 300, 500, { w: 35, h: 35 }),
    F('l8', 'robot_dock', 40, 430, { w: 45, h: 45 }),
    F('s1', 'bed', 200, 150, { w: 180, h: 205, color: '#8b5e3c', accent: '#e7e1d6' }),
    F('s2', 'nightstand', 85, 70, { w: 45, h: 40 }), F('s3', 'nightstand', 315, 70, { w: 45, h: 40 }),
    F('s4', 'wardrobe', 340, 260, { w: 120, h: 60, rotation: 90, count: 3, variant: 'sliding' }),
    F('b1', 'bathtub', 760, 160, { w: 170, h: 75 }), F('b2', 'washbasin', 880, 250, { variant: 'double', w: 110, h: 48, rotation: 270 }),
    F('b3', 'toilet', 600, 140, { w: 38, h: 60 }), F('b4', 'washer', 620, 280, { w: 60, h: 60 }),
  ];
  card.setConfig({ ...card.rawConfig, floors: card.rawConfig.floors.map((f) => ({ ...f, furniture })) }); })()`);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/furn-3d-${scheme}.png` });
console.log('3D scene:', await page.evaluate(`(() => { ${FIND} const plan = find(document).shadowRoot.querySelector('fp-plan'); return JSON.stringify(plan.glScene ? plan.glScene.stats() : { faces: plan.shadowRoot.querySelectorAll('.furn3d .f').length }); })()`), 'for', 28, 'pieces');
for (const [name, file] of [['Wohnzimmer', 'living'], ['Küche', 'kitchen'], ['Schlafzimmer', 'bedroom'], ['Bad', 'bath']]) {
  await page.evaluate(`(() => { ${FIND} const card = find(document); const plan = card.shadowRoot.querySelector('fp-plan');
    plan.focusRoom(card.rawConfig.floors[0].rooms.find((r) => r.name === '${name}').id); })()`);
  await page.waitForTimeout(1100);
  await page.screenshot({ path: `${out}/furn-3d-${file}-${scheme}.png` });
  await page.evaluate(`(() => { ${FIND} find(document).shadowRoot.querySelector('fp-plan').resetView(); })()`);
  await page.waitForTimeout(600);
}
await page.locator('floorplan-card .chrome .icon-btn[aria-label="2D"]').click();
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/furn-2d-${scheme}.png` });
console.log(errors.length ? errors.join('\n') : 'console: keine Fehler/Warnungen');
await browser.close();
