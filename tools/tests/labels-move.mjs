// Labels fade while moving (option) and the room view shows the room's label at the top. Temporary config only.
import { openHA, tapAt } from '../pw.mjs';
const out = process.argv[2] ?? '/tmp';
const scheme = process.argv[3] ?? 'light';
const { browser, page, errors } = await openHA({ size: '1280x800', scheme, kiosk: true, block: ['light', 'switch', 'fan', 'climate', 'media_player', 'vacuum', 'cover', 'todo'] });
const ok = (c, m) => console.log(c ? '• ok:' : '• FAIL:', m);
const FIND = `const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } };`;
const card = (expr) => page.evaluate(`(async () => { ${FIND} const card = find(document); const plan = card.shadowRoot.querySelector('fp-plan'); return ${expr}; })()`);
const setCfg = (extra) => card(`(card.setConfig({ ...card.rawConfig, label_style: undefined, ...${JSON.stringify(extra)}, floors: card.rawConfig.floors.map((f) => ({ ...f, rooms: f.rooms.map((r) => ({ ...r, tap_action: { action: 'zoom' } })) })) }), true)`);
await setCfg({ hide_labels_on_move: true });
await page.waitForTimeout(1200);
const box = await page.locator('floorplan-card fp-plan').boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
const moving = () => card(`plan.shadowRoot.querySelector('.world-top .labels').classList.contains('moving')`);
ok(!(await moving()), 'labels visible at rest');
await page.mouse.move(cx, cy);
await page.mouse.wheel(0, -60);
await page.waitForTimeout(60);
ok(await moving(), 'labels fade out while zooming');
// the zoom glides on for a moment (longer with the test browser's software WebGL): wait for the view to rest
for (let i = 0; i < 30 && (await moving()); i++) await page.waitForTimeout(100);
ok(!(await moving()), 'labels back once the view rests');
await card('(plan.resetView(), true)');
await page.waitForTimeout(800);
// room view badge
const room = await card(`(() => { const r = card._config.floors[0].rooms.find((x) => !x.hide_label && x.points.length >= 3); return { id: r.id, name: r.name }; })()`);
await card(`(plan.focusRoom('${room.id}'), true)`);
await page.waitForTimeout(900);
const badge = () => card(`plan.shadowRoot.querySelector('.focus-badge .label .name')?.textContent ?? ''`);
ok((await badge()) === room.name, `room view shows "${room.name}" at the top (${await badge()})`);
ok(await card(`plan.shadowRoot.querySelector('.labels .label[data-label="${room.id}"]').classList.contains('badged')`), 'its label in the scene steps back');
const top = await card(`plan.shadowRoot.querySelector('.focus-badge').getBoundingClientRect().bottom`);
const roomTop = await card(`(() => { const p = plan.projectedRect(card._config.floors[0].rooms.find((x) => x.id === '${room.id}').points, plan.effectiveWallHeight); const vp = plan.shadowRoot.querySelector('.viewport').getBoundingClientRect(); return vp.top + p.y; })()`);
ok(top <= roomTop + 12, `badge clear of the room (badge bottom ${Math.round(top)} px, room top ${Math.round(roomTop)} px)`);
await page.screenshot({ path: `${out}/focus-badge-${scheme}.png` });
await page.mouse.move(cx, cy);
await page.mouse.wheel(0, -40);
await page.waitForTimeout(150);
ok((await badge()) === '', 'moving the view hides the badge again');
for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(40); }
await page.waitForTimeout(500);
ok(!(await card('plan.focused')), 'zooming out of the room view by hand returns to the overview (no veil left behind)');
ok(!(await card(`plan.shadowRoot.querySelector('.focus-dim')`)), 'no dimming layer remains');
// option off
await card('(plan.resetView(), true)');
await page.waitForTimeout(600);
await setCfg({ focus_badge: false });
await page.waitForTimeout(800);
await card(`(plan.focusRoom('${room.id}'), true)`);
await page.waitForTimeout(900);
ok((await badge()) === '', 'focus_badge: false keeps the label in the scene');
await card('(plan.resetView(), true)');
console.log(errors.length ? errors.join('\n') : 'console: keine Fehler/Warnungen');
await browser.close();
