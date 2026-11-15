// Close-up of small appliances on a counter + on/off badges + tap feedback. Temporary in-page config,
// faked states, intercepted service calls — nothing is switched or saved.
import { openHA, tapAt } from '../pw.mjs';
const out = process.argv[2] ?? '/tmp';
const scheme = process.argv[3] ?? 'light';
const { browser, page, errors, calls } = await openHA({ size: '1280x800', scheme, kiosk: true, block: ['light', 'climate', 'fan', 'switch', 'vacuum', 'media_player', 'homeassistant', 'input_boolean', 'scene', 'script'] });
const ok = (c, m) => console.log(c ? '• ok:' : '• FAIL:', m);
const FIND = `const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } };`;
const card = (expr) => page.evaluate(`(() => { ${FIND} const card = find(document); const plan = card.shadowRoot.querySelector('fp-plan'); return ${expr}; })()`);
const FAKE = {
  'switch.fp_coffee': { state: 'on', attributes: { friendly_name: 'Kaffeemaschine' } },
  'switch.fp_kettle': { state: 'off', attributes: { friendly_name: 'Wasserkocher' } },
  'vacuum.fp_robot': { state: 'docked', attributes: { friendly_name: 'Robbi' } },
};
await page.evaluate(`(() => { ${FIND} const card = find(document);
  const fake = ${JSON.stringify(FAKE)};
  const orig = card.optimistic.get.bind(card.optimistic);
  card.optimistic.get = (h, id) => fake[id] ? { entity_id: id, last_changed: '', last_updated: '', context: {}, ...fake[id] } : orig(h, id);
  const f0 = card.rawConfig.floors[0];
  const r = f0.rooms.find((x) => x.name === 'Wohnzimmer');
  const xs = r.points.map((p) => p[0]), ys = r.points.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const y = cy - 40;
  const add = [
    { id: 'g0', kind: 'counter', x: cx, y, w: 300, h: 62 },
    { id: 'g1', kind: 'thermomix', x: cx - 128, y: y - 4, w: 33, h: 33 },
    { id: 'g2', kind: 'kettle', x: cx - 92, y: y - 6, w: 24, h: 20, entity: 'switch.fp_kettle' },
    { id: 'g3', kind: 'airfryer', x: cx - 58, y: y - 6, w: 30, h: 36 },
    { id: 'g4', kind: 'coffee', x: cx - 22, y: y - 6, w: 26, h: 44, entity: 'switch.fp_coffee' },
    { id: 'g5', kind: 'espresso', x: cx + 14, y: y - 6, w: 36, h: 40 },
    { id: 'g6', kind: 'toaster', x: cx + 50, y: y - 8, w: 30, h: 18 },
    { id: 'g7', kind: 'mixer', x: cx + 80, y: y - 6, w: 22, h: 36 },
    { id: 'g8', kind: 'blender', x: cx + 105, y: y - 8, w: 18, h: 18 },
    { id: 'g9', kind: 'microwave', x: cx + 126, y: y - 6, w: 30, h: 38, rotation: 0 },
    { id: 'g10', kind: 'robot_dock', x: cx - 110, y: y + 95, w: 45, h: 45 },
    { id: 'g11', kind: 'robot_vacuum', x: cx - 110, y: y + 150, w: 35, h: 35, entity: 'vacuum.fp_robot' },
    { id: 'g12', kind: 'stick_vacuum', x: cx - 50, y: y + 95, w: 26, h: 22 },
    { id: 'g13', kind: 'trash', x: cx, y: y + 95, w: 32, h: 32 },
    { id: 'g14', kind: 'speaker', x: cx + 50, y: y + 95, w: 18, h: 18 },
    { id: 'g15', kind: 'router', x: cx + 90, y: y + 95, w: 25, h: 18 },
    { id: 'g16', kind: 'bread_maker', x: cx + 140, y: y + 95, w: 28, h: 36 },
  ];
  window.__g = { cx, y };
  card.setConfig({ ...card.rawConfig, floors: card.rawConfig.floors.map((f, i) => (i ? f : { ...f, furniture: [...(f.furniture ?? []), ...add] })) });
})()`);
await page.waitForTimeout(1500);
ok(await card(`!plan.shadowRoot.querySelector('.fbadge')`), 'no power badges (state shows on the device itself)');
ok(await card(`plan.pieceInfo('g4')?.fx === 'power' && plan.pieceInfo('g4').emissive > 0`), 'coffee machine (switch on): display lights up');
ok(await card(`!plan.pieceInfo('g2')?.fx`), 'kettle (switch off) stays dark');
// close-up: frame the counter area
await card(`(() => { const g = window.__g; plan.setTilt?.(42); const vp = plan.shadowRoot.querySelector('.viewport').getBoundingClientRect();
  const a = plan.panZoom.worldToScreen ? null : null; return true; })()`);
const rect = await card(`(() => { const els = []; const vp = plan.shadowRoot.querySelector('.viewport').getBoundingClientRect();
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (const e of els) { const r = e.getBoundingClientRect(); x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom); }
  return { x: x0 - vp.left, y: y0 - vp.top, w: x1 - x0, h: y1 - y0 }; })()`);
await card(`(plan.viewMode = '3d', plan.focusRoom(card.rawConfig.floors[0].rooms.find((x) => x.name === 'Wohnzimmer').id), true)`);
await page.waitForTimeout(1600);
await page.screenshot({ path: `${out}/gadgets-room-${scheme}.png` });
const ids = Array.from({ length: 10 }, (_, i) => 'g' + i);
for (let pass = 0; pass < 1; pass++) {
  const rect2 = await card(`(() => { const ids = ${JSON.stringify(ids)}; const vp = plan.shadowRoot.querySelector('.viewport').getBoundingClientRect();
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const id of ids) { const r = plan.pieceRect(id); if (!r) continue; x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); }
    return { x: x0 - vp.left, y: y0 - vp.top, w: x1 - x0, h: y1 - y0 }; })()`);
  await card(`(plan.panZoom.focusRect(${JSON.stringify(rect2)}, 0.9), true)`);
  await page.waitForTimeout(700);
}
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/gadgets-${scheme}.png` });
// tap the kettle badge -> switch.toggle; no tap ring: the kettle shows its own state (status lights)
const b = await card(`(() => { const r = plan.pieceRect('g2'); for (let fy = 0.5; fy < 0.95; fy += 0.1) for (let fx = 0.5; fx > 0.1; fx -= 0.1) { const x = r.x + r.w * fx, y = r.y + r.h * fy; if (plan.pieceAt(x, y) === 'g2') return [x, y]; } return [r.x + r.w / 2, r.y + r.h / 2]; })()`);
await tapAt(page, b[0], b[1]);
const trace = [];
for (let i = 0; i < 4; i++) { await page.waitForTimeout(40); trace.push(await card(`!!plan.shadowRoot.querySelector('.tapfx, .hrpulse')`)); }
await page.screenshot({ path: `${out}/gadgets-tap-${scheme}.png` });
ok(!trace.some(Boolean), `no tap ring on a switch piece with its own effect (${trace.join(',')})`);
await page.waitForTimeout(500);
const c = (await calls()).filter((x) => x.domain === 'switch');
ok(c.length === 1 && c[0].service === 'toggle', `tap toggles the kettle (${JSON.stringify(c.map((x) => x.domain + '.' + x.service))})`);
// a piece that runs a scene: no ring either (tap feedback rings are gone everywhere)
await card(`(() => { const fl = card.rawConfig.floors[0]; const k = fl.furniture.find((x) => x.id === 'g2'); card.setConfig({ ...card.rawConfig, floors: card.rawConfig.floors.map((f, i) => i ? f : { ...f, furniture: f.furniture.map((x) => x.id === 'g2' ? { ...x, entity: 'scene.fp_test', tap_action: { action: 'perform-action', perform_action: 'scene.turn_on', target: { entity_id: 'scene.fp_test' } } } : x) }) }); return true; })()`);
await page.waitForTimeout(900);
await tapAt(page, b[0], b[1]);
await page.waitForTimeout(60);
ok(!(await card(`!!plan.shadowRoot.querySelector('.tapfx, .hrpulse')`)), 'scene piece: no tap ring');
console.log(errors.length ? errors.join('\n') : 'console: keine Fehler/Warnungen');
await browser.close();
