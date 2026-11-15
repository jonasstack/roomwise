// Label style "wall": values engraved into walls (or the floor), no floating labels, tap opens the heating,
// labels move when the view turns. Temporary config only; climate calls intercepted.
import { openHA, tapAt } from '../pw.mjs';
const out = process.argv[2] ?? '/tmp';
const scheme = process.argv[3] ?? 'light';
const { browser, page, errors } = await openHA({ size: '1280x800', scheme, kiosk: true, block: ['climate', 'light', 'switch'] });
const ok = (c, m) => console.log(c ? '• ok:' : '• FAIL:', m);
const FIND = `const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } };`;
const card = (expr) => page.evaluate(`(async () => { ${FIND} const card = find(document); const plan = card.shadowRoot.querySelector('fp-plan'); return ${expr}; })()`);
await page.waitForTimeout(1500);
const climate = await card(`Object.keys(card._hass.states).find((e) => e.startsWith('climate.'))`);
await card(`(card.setConfig({ ...card.rawConfig, label_style: 'wall', floors: card.rawConfig.floors.map((f, i) => i ? f : { ...f, rooms: f.rooms.map((r) => ({ ...r, climate: r.climate ?? '${climate}' })) }) }), true)`);
await page.waitForTimeout(2500);
const n = await card(`plan.glScene.wallLabelGroup.children.length`);
const rooms = await card(`card._config.floors[0].rooms.filter((r) => !r.outdoor && r.points.length >= 3 && (r.temperature || r.climate)).length`);
ok(n > 0 && n >= rooms - 1, `values engraved (${n} of ${rooms} rooms)`);
ok((await card(`plan.shadowRoot.querySelectorAll('.labels .label').length`)) === 0, 'no floating labels in 3D');
const where = () => card(`(() => { const g = plan.glScene; const m = g.wallLabelGroup.children.find((c) => c.position.z > 10) ?? g.wallLabelGroup.children[0]; const p = m.getWorldPosition(m.position.clone()).project(g.camera); return { room: m.userData.room, x: (p.x + 1) / 2 * g.view.width, y: (1 - p.y) / 2 * g.view.height, pos: [Math.round(m.position.x), Math.round(m.position.y)] }; })()`);
const w0 = await where();
const vp = await card(`(() => { const r = plan.shadowRoot.querySelector('.viewport').getBoundingClientRect(); return [r.left, r.top]; })()`);
await tapAt(page, vp[0] + w0.x, vp[1] + w0.y);
await page.waitForTimeout(900);
const popup = await page.evaluate(() => document.querySelector('floorplan-card-layer')?._stack?.at(-1)?.entity ?? null);
ok(popup?.startsWith('climate.'), `tap on an engraving opens the heating (${popup})`);
await page.screenshot({ path: `${out}/wall-labels-${scheme}.png` });
await page.evaluate(() => { const l = document.querySelector('floorplan-card-layer'); if (l) l._stack = []; });
// turn the view: labels move to the walls facing the viewer
const before = JSON.stringify(await card(`plan.glScene.wallLabelGroup.children.map((m) => [Math.round(m.position.x), Math.round(m.position.y)])`));
await card(`(plan.rotateBy(90), true)`);
await page.waitForTimeout(2500);
const after = JSON.stringify(await card(`plan.glScene.wallLabelGroup.children.map((m) => [Math.round(m.position.x), Math.round(m.position.y)])`));
ok(before !== after, 'after turning the view the values moved to visible walls');
await card(`(plan.rotateBy(-90), true)`);
console.log(errors.length ? errors.join('\n') : 'console: keine Fehler/Warnungen');
await browser.close();
