// Laptop zoom in 3D (and 2D): the floor point under the pointer must stay under it — per frame, while zooming —
// for mouse-wheel notches and for trackpad pinching (ctrl + wheel). Read-only (nothing reaches HA).
import { openHA } from '../pw.mjs';
import { cardFn } from '../design/fake.mjs';
const ok = (c, m) => console.log(c ? '  ok:' : '• FAIL:', m);
const { browser, page, errors } = await openHA({ size: '1280x800', kiosk: true, block: ['light', 'climate', 'vacuum', 'cover', 'media_player', 'fan', 'switch', 'tts', 'notify', 'select', 'house_rules'] });
const card = cardFn(page);
await page.waitForTimeout(3500);
const run = async (label, events, at) => {
  await card(`(plan.panZoom.reset(false), true)`);
  await page.waitForTimeout(600);
  return card(`new Promise((done) => {
    const pz = plan.panZoom;
    const vp = plan.shadowRoot.querySelector('.viewport');
    const r = vp.getBoundingClientRect();
    const [x, y] = [${at[0]}, ${at[1]}];
    const P0 = plan.is3d ? plan.unprojectWith(plan.viewMatrix(pz.view), x, y, 0) : [(x - pz.view.tx) / pz.view.s, (y - pz.view.ty) / pz.view.s];
    let worst = 0, n = 0, steps = [];
    let lastS = pz.view.s;
    const t0 = performance.now();
    const sample = () => {
      const p = plan.is3d ? plan.unprojectWith(plan.viewMatrix(pz.view), x, y, 0) : [(x - pz.view.tx) / pz.view.s, (y - pz.view.ty) / pz.view.s];
      const err = Math.hypot(p[0] - P0[0], p[1] - P0[1]);
      worst = Math.max(worst, err);
      // zoom per frame (jitter: the scale should change smoothly)
      const k = pz.view.s / lastS; lastS = pz.view.s; if (Math.abs(Math.log(k)) > 1e-4) steps.push(k);
      n++;
      if (performance.now() - t0 < 1400) requestAnimationFrame(sample);
      else {
        const big = Math.max(...steps.map((k) => Math.abs(Math.log(k))));
        done({ worst: +worst.toFixed(1), zoom: +(pz.view.s / pz.fitScale).toFixed(2), frames: n, moving: steps.length, maxStep: +big.toFixed(3) });
      }
    };
    requestAnimationFrame(sample);
    const ev = ${JSON.stringify(events)};
    const gest = (type, scale) => { const g = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperties(g, { scale: { value: scale }, clientX: { value: r.left + x }, clientY: { value: r.top + y } }); return g; };
    ev.forEach((e, i) => setTimeout(() => vp.dispatchEvent(e.g ? gest(e.g, e.scale) : new WheelEvent('wheel', { deltaY: e.dy, deltaMode: 0, ctrlKey: !!e.ctrl, clientX: r.left + x, clientY: r.top + y, bubbles: true, cancelable: true })), e.t));
  })`);
};
const mouse = [0, 60, 120, 400, 460].map((t) => ({ t, dy: -100 }));
// Safari: gesturestart / gesturechange (scale since the start) / gestureend
const safari = [{ t: 0, g: 'gesturestart', scale: 1 }, ...Array.from({ length: 24 }, (_, i) => ({ t: 16 + i * 16, g: 'gesturechange', scale: 1 + (i + 1) * 0.07 })), { t: 420, g: 'gestureend', scale: 2.68 }];
const pinch = Array.from({ length: Number(process.env.PINCH ?? 24) }, (_, i) => ({ t: i * 16, dy: -4, ctrl: true }));
for (const mode of ['3d', '2d']) {
  if ((await card(`plan.is3d`)) !== (mode === '3d')) {
    await card(`(card.setForce2d(${mode === '2d'}), true)`);
    await page.waitForTimeout(2000);
  }
  console.log(`-- ${mode} (is3d=${await card('plan.is3d')})`);
  for (const at of [[900, 300], [400, 600]]) {
    const m = await run('mouse', mouse, at);
    ok(m.worst < 3 && m.zoom > 1.4 && m.moving >= Math.min(6, m.frames - 3), `mouse wheel at ${at}: point drifts ≤ ${m.worst} cm, zoom ×${m.zoom}, glides over ${m.moving} of ${m.frames} frames (biggest step ${m.maxStep})`);
    const p = await run('pinch', pinch, at);
    ok(p.worst < 3 && p.zoom > 1.4, `trackpad pinch at ${at}: point drifts ≤ ${p.worst} cm, zoom ×${p.zoom}`);
    const sf = await run('safari', safari, at);
    ok(sf.worst < 3 && sf.zoom > 1.4, `Safari trackpad pinch (gesture events) at ${at}: point drifts ≤ ${sf.worst} cm, zoom ×${sf.zoom}`);
  }
}
console.log(errors.length ? errors.join('\n') : 'page: no errors');
await browser.close();
