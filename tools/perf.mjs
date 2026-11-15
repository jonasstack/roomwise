// Performance profile of the card on a throttled CPU (emulates a slow wall tablet).
// Read-only: nothing is switched or saved. Usage: node tools/perf.mjs [label] [throttle=4]
import { openHA } from './pw.mjs';
const label = process.argv[2] ?? 'run';
const rate = Number(process.argv[3] ?? 4);
const { browser, page, errors } = await openHA({ size: '1280x800', kiosk: true, block: ['light', 'switch', 'fan', 'climate', 'media_player', 'tts'] });
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
const FIND = `const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } };`;
const card = (expr) => page.evaluate(`(async () => { ${FIND} const card = find(document); const plan = card.shadowRoot.querySelector('fp-plan'); return ${expr}; })()`);
await page.waitForTimeout(1500);
await cdp.send('Emulation.setCPUThrottlingRate', { rate });

const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
const window_ = async (ms, during) => {
  await card(`(window.__stopRaf = false, window.__frames = [], window.__lt = 0, (function f(t){ window.__frames.push(t); if (!window.__stopRaf) requestAnimationFrame(f); })(performance.now()), true)`);
  await page.evaluate(() => {
    window.__stopRaf = false;
    window.__po?.disconnect();
    window.__po = new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt += e.duration; });
    window.__po.observe({ entryTypes: ['longtask'] });
  });
  const m0 = await metrics();
  const t0 = Date.now();
  if (during) await during();
  const rest = ms - (Date.now() - t0);
  if (rest > 0) await page.waitForTimeout(rest);
  const m1 = await metrics();
  const r = await page.evaluate(() => {
    window.__stopRaf = true;
    const f = window.__frames;
    const d = f.slice(1).map((t, i) => t - f[i]);
    d.sort((a, b) => a - b);
    return { frames: f.length, p95: d[Math.floor(d.length * 0.95)] ?? 0, longtask: window.__lt };
  });
  const sec = (Date.now() - t0) / 1000;
  const per = (k) => (((m1[k] ?? 0) - (m0[k] ?? 0)) * 1000) / sec;
  return {
    fps: +(r.frames / sec).toFixed(1),
    p95ms: +r.p95.toFixed(1),
    longtaskMsPerS: +(r.longtask / sec).toFixed(0),
    scriptMsPerS: +per('ScriptDuration').toFixed(0),
    styleMsPerS: +per('RecalcStyleDuration').toFixed(0),
    layoutMsPerS: +per('LayoutDuration').toFixed(0),
    taskMsPerS: +per('TaskDuration').toFixed(0),
  };
};

const out = { label, rate };
out.nodes = await card(`plan.shadowRoot.querySelectorAll('*').length`);
out.faces = await card(`plan.shadowRoot.querySelectorAll('.f').length`);
out.animated = await card(`(() => { let n = 0; const walk = (root) => { for (const el of root.querySelectorAll('*')) { if (el.getAnimations && el.getAnimations().length) n++; if (el.shadowRoot) walk(el.shadowRoot); } }; walk(card.shadowRoot); return n; })()`);
out.idle = await window_(5000);
// a state update (what every relevant HA change costs)
out.renderMs = await card(`(async () => { const ts = []; for (let i = 0; i < 6; i++) { const t = performance.now(); card.requestUpdate('_tick', -1); await card.updateComplete; await plan.updateComplete; ts.push(performance.now() - t); } ts.sort((a, b) => a - b); return +ts[3].toFixed(1); })()`);
// pan gesture
const box = await page.locator('floorplan-card fp-plan').boundingBox();
out.pan = await window_(2500, async () => {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 0; i < 40; i++) await page.mouse.move(cx + Math.sin(i / 6) * 120, cy + Math.cos(i / 6) * 60);
  await page.mouse.up();
});
out.errors = errors.length;
console.log(JSON.stringify(out));
await browser.close();
