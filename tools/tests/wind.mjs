// Air streams at open windows are visible and animated in 3D (WebGL floor) and in 2D. Fake states only.
import { openHA } from '../pw.mjs';
const out = process.argv[2] ?? '/tmp';
const scheme = process.argv[3] ?? 'light';
const { browser, page, errors } = await openHA({ size: '1280x800', scheme, kiosk: true });
const ok = (c, m) => console.log(c ? '• ok:' : '• FAIL:', m);
const FIND = `const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } };`;
const card = (expr) => page.evaluate(`(async () => { ${FIND} const card = find(document); const plan = card.shadowRoot.querySelector('fp-plan'); return ${expr}; })()`);
await page.waitForTimeout(1500);
const win = await card(`(() => { const w = card._config.floors[0].openings.find((o) => o.type === 'window' && o.entity); if (!w) return null;
  const orig = card.optimistic.get.bind(card.optimistic); card.optimistic.get = (h, id) => { const s = orig(h, id); return id === w.entity && s ? { ...s, state: 'on' } : s; };
  card._tick++; /* a redraw: changes of other entities do not redraw the plan */ return w.entity; })()`);
ok(!!win, `window with a contact sensor (${win})`);
await page.waitForTimeout(1200);
const stat = () => card(`(() => { const p = [...plan.shadowRoot.querySelectorAll('.air')].filter((el) => el.checkVisibility({ visibilityProperty: true })); return { n: p.length, running: p.filter((el) => el.getAnimations().some((a) => a.playState === 'running')).length, top: !!plan.shadowRoot.querySelector('.winds-top .air') }; })()`);
let s = await stat();
const gl3d = await card(`(() => { const g = plan.glScene; return { ribbons: g.windGroup.children.length, flows: g.windTex.length }; })()`);
const off0 = await card(`plan.glScene.windTex[0]?.tex.offset.x ?? null`);
await page.waitForTimeout(400);
const off1 = await card(`plan.glScene.windTex[0]?.tex.offset.x ?? null`);
ok(gl3d.ribbons > 0 && off0 !== off1, `3D: air ribbons pass through the open windows and flow (${JSON.stringify(gl3d)})`);
await page.screenshot({ path: `${out}/wind-3d-${scheme}.png` });
// room view: only that room's windows blow (nothing shines through other walls)
const rooms = await card(`(() => { const f = card._config.floors[0]; const w = f.openings.find((o) => o.entity === '${win}'); const mid = [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2];
  const near = (r) => r.points.some((p, i) => { const q = r.points[(i + 1) % r.points.length]; const t = Math.max(0, Math.min(1, ((mid[0] - p[0]) * (q[0] - p[0]) + (mid[1] - p[1]) * (q[1] - p[1])) / ((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 || 1))); return Math.hypot(p[0] + t * (q[0] - p[0]) - mid[0], p[1] + t * (q[1] - p[1]) - mid[1]) < 20; });
  const open = new Set(f.openings.filter((o) => o.type === 'window' && o.entity && ['on', 'open'].includes(card.getState(o.entity)?.state)).map((o) => o.id));
  const quiet = f.rooms.find((r) => r.points.length >= 3 && !f.openings.some((o) => open.has(o.id) && near.call(null, { points: r.points }) && (() => { const m = [(o.a[0] + o.b[0]) / 2, (o.a[1] + o.b[1]) / 2]; return r.points.some((p, i) => { const q = r.points[(i + 1) % r.points.length]; const L = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1; const d = Math.abs((q[0] - p[0]) * (p[1] - m[1]) - (p[0] - m[0]) * (q[1] - p[1])) / L; const t = ((m[0] - p[0]) * (q[0] - p[0]) + (m[1] - p[1]) * (q[1] - p[1])) / (L * L); return d < 20 && t > -0.05 && t < 1.05; }); })()));
  return { quiet: quiet?.id, quietName: quiet?.name }; })()`);
if (rooms.quiet) {
  await card(`(plan.focusRoom('${rooms.quiet}'), true)`);
  await page.waitForTimeout(1300);
  const n = await card(`plan.glScene.windGroup.children.length`);
  ok(n === 0, `room view of ${rooms.quietName} (no open window): no air streams shine through its walls (${n})`);
  await card('(plan.resetView(), true)');
  await page.waitForTimeout(900);
}
await card(`(plan.viewMode = '2d', true)`);
await page.waitForTimeout(1200);
s = await stat();
ok(s.n > 0 && s.running > 0, `2D: air streams visible and animated (${JSON.stringify(s)})`);
await page.screenshot({ path: `${out}/wind-2d-${scheme}.png` });
console.log(errors.length ? errors.join('\n') : 'console: keine Fehler/Warnungen');
await browser.close();
