// Touch taps on the visible body of every linked object (overview, rotated, room zoom): the card must resolve exactly that object.
// Actions are not executed (resolution only). Run with PW_DPR=2 for tablet density.
import { openHA } from '../pw.mjs';
const { browser, page } = await openHA({ size: '1280x800', kiosk: true, touch: true, block: ['light', 'switch', 'fan', 'climate', 'media_player', 'vacuum', 'input_boolean', 'homeassistant'] });
const FIND = `const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } };`;
const card = (expr) => page.evaluate(`(() => { ${FIND} const card = find(document); const plan = card.shadowRoot.querySelector('fp-plan'); return ${expr}; })()`);
await page.waitForTimeout(2500);
const check = async (label) => {
  const r = await card(`(() => { const gl = plan.glScene; const vp = plan.shadowRoot.querySelector('.viewport').getBoundingClientRect();
    const fur = card._config.floors[0].furniture.filter((f) => f.entity); let ok = 0, bad = [];
    for (const f of fur) { const rr = plan.pieceRect(f.id); if (!rr || rr.w < 2) continue; const cx = rr.x + rr.w / 2, cy = rr.y + rr.h / 2; if (cx < vp.left || cy < vp.top || cx > vp.right || cy > vp.bottom) continue;
      const hit = gl.pick(cx - vp.left, cy - vp.top); if (hit === f.id) ok++; else bad.push(f.kind + '->' + (card._config.floors[0].furniture.find((q) => q.id === hit)?.kind ?? hit)); }
    return ok + ' ok, bad: ' + bad.join(', '); })()`);
  console.log(label.padEnd(16), r);
};
// real touch taps: tap the center of each linked piece and see which item the card resolves
const taps = async (label) => {
    // a point on the visible body of each piece (projection-based search), skipping pieces hidden by walls/labels
  const pieces = await card(`(() => { const vp = plan.shadowRoot.querySelector('.viewport').getBoundingClientRect(); const out = [];
    for (const f of card._config.floors[0].furniture.filter((f) => f.entity)) { const r = plan.pieceRect(f.id); if (!r || r.w < 4 || plan.pieceInfo(f.id)?.visible === false) continue;
      let pt = null; for (let fy = 0.5; fy < 0.95 && !pt; fy += 0.1) for (let fx = 0.5; fx > 0.1 && !pt; fx -= 0.1) { const x = r.x + r.w * fx, y = r.y + r.h * fy; const topEl = plan.shadowRoot.elementFromPoint(x, y); const overlay = topEl && topEl.closest('.world-top .label, .world-top .marker-wrap'); if (!overlay && plan.glScene.pick(x - vp.left, y - vp.top, () => true) === f.id) pt = { x, y }; }
      if (pt && pt.x > vp.left + 5 && pt.y > vp.top + 5 && pt.x < vp.right - 5 && pt.y < vp.bottom - 5) out.push({ id: f.id, kind: f.kind, ...pt }); }
    return out; })()`);
  // record what the card resolves, without running the actions (no pop-ups in the way)
  await card(`(() => { window.__tg = []; card.handlers.onTapDown = (tg) => { window.__tg.push(tg); }; card.handlers.onTap = () => {}; card.handlers.onDoubleTap = () => {}; return true; })()`);
  const res = [];
  for (const p of pieces) {
    await card(`(window.__tg = [], true)`);
    await page.touchscreen.tap(p.x, p.y);
    await page.waitForTimeout(450);
    await page.waitForTimeout(500);
    const tg = await card(`window.__tg[0]`);
    const got = tg?.kind === 'furniture' ? await card(`card._config.floors[0].furniture.find((q) => q.id === '${tg?.id}')?.kind`) : tg?.kind;
    res.push((tg?.id === p.id ? 'OK ' : 'BAD ') + p.kind + '->' + got);
  }
  console.log(label.padEnd(16), res.join(' | '));
};
await taps('overview taps');
// unlinked pieces (not rugs): the tap is swallowed — no room action, no zoom
{
  await card(`(() => { card.handlers.onTap = (tg) => { window.__lastTap = tg; card['gesture'](tg, 'tap'); }; return true; })()`);
  const un = await card(`(() => { const vp = plan.shadowRoot.querySelector('.viewport').getBoundingClientRect(); const out = [];
    for (const f of card._config.floors[0].furniture.filter((f) => !f.entity && f.kind !== 'rug')) { const r = plan.pieceRect(f.id); if (!r || r.w < 10) continue; let pt = null;
      for (let fy = 0.5; fy < 0.95 && !pt; fy += 0.1) for (let fx = 0.5; fx > 0.1 && !pt; fx -= 0.1) { const x = r.x + r.w * fx, y = r.y + r.h * fy; if (x < vp.left + 20 || y < vp.top + 20 || x > vp.right - 20 || y > vp.bottom - 20) continue; const topEl = plan.shadowRoot.elementFromPoint(x, y); if (topEl && topEl.closest('.world-top')) continue; if (plan.glScene.pick(x - vp.left, y - vp.top, () => true) === f.id) pt = { x, y }; }
      if (pt) out.push({ id: f.id, kind: f.kind, ...pt }); if (out.length >= 5) break; }
    return out; })()`);
  const res = [];
  for (const p of un) {
    await card(`(window.__lastTap = null, true)`);
    await page.touchscreen.tap(p.x, p.y);
    await page.waitForTimeout(600);
    const st = await card(`({ tg: window.__lastTap, focused: plan.focused, popup: !!document.querySelector('floorplan-card-layer')?.shadowRoot?.querySelector('.sheet-wrap') })`);
    res.push((st.tg?.kind === 'furniture' && st.tg.id === p.id && !st.focused && !st.popup ? 'OK ' : 'BAD ') + p.kind + '->' + (st.tg?.kind ?? '-') + (st.focused ? ' (zoomed!)' : ''));
    if (st.focused) { await card(`(plan.resetView(), true)`); await page.waitForTimeout(900); }
  }
  console.log('unlinked taps'.padEnd(16), res.join(' | '));
}
await card(`(plan.setSpin(90), true)`); await page.waitForTimeout(1500);
await taps('spin 90 taps');
await card(`(plan.focusRoom(card._config.floors[0].rooms.find((x) => x.name === 'Küche').id), true)`); await page.waitForTimeout(2000);
await taps('focus taps');
await browser.close();
