// Idle audit: what keeps working per second (WebGL renders, weather frames, re-renders, CSS animations, paints).
// Usage: node tools/idle-audit.mjs saver|smooth   (read-only)
import { openHA } from './pw.mjs';
const quality = process.argv[2] ?? 'smooth';
const { browser, page } = await openHA({ size: '1280x800', kiosk: true, block: ['light'] });
const cdp = await page.context().newCDPSession(page);
const FIND = `const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } };`;
await page.waitForTimeout(2000);
await page.evaluate(`(() => { ${FIND} const card = find(document); const users = Object.fromEntries(Object.entries(card.rawConfig.users ?? {}).map(([k, v]) => [k, { ...v, weather: ${JSON.stringify(quality)} }])); card.setConfig({ ...card.rawConfig, weather_quality: ${JSON.stringify(quality)}, users }); })()`);
await page.waitForTimeout(2500);
await page.evaluate(`(() => { ${FIND} const card = find(document); const plan = card.shadowRoot.querySelector('fp-plan'); window.__c = { gl: 0, wx: 0, card: 0, plan: 0 };
  const gl = plan.glScene; if (gl) { const r = gl.renderer; const o = r.render.bind(r); r.render = (...a) => { window.__c.gl++; return o(...a); }; }
  for (const amb of card.shadowRoot.querySelectorAll('fp-ambient')) { const wx = amb.wx; if (wx) { const of = wx.frame; wx.frame = () => { window.__c.wx++; of(); }; } }
  const ou = card.update.bind(card); card.update = (c) => { window.__c.card++; return ou(c); };
  const op = plan.update.bind(plan); plan.update = (c) => { window.__c.plan++; return op(c); };
  window.__active = card._config.floors[0].furniture.filter((f) => plan.pieceInfo(f.id)?.fx).map((f) => f.kind + ':' + plan.pieceInfo(f.id).fx);
  let anims = 0; const walk = (root) => { for (const el of root.querySelectorAll('*')) { anims += el.getAnimations().length; if (el.shadowRoot) walk(el.shadowRoot); } }; walk(card.shadowRoot); window.__anims = anims; })()`);
const events = [];
cdp.on('Tracing.dataCollected', (d) => events.push(...d.value));
const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline', transferMode: 'ReportEvents' });
await page.waitForTimeout(10000);
await cdp.send('Tracing.end');
await done;
const c = await page.evaluate(() => ({ ...window.__c, cssAnimations: window.__anims, active: window.__active }));
console.log('  active devices:', c.active.join(', '));
const sum = (n) => events.filter((e) => e.name === n && e.dur).reduce((a, e) => a + e.dur / 1000, 0);
const count = (n) => events.filter((e) => e.name === n).length;
console.log(quality.padEnd(7), JSON.stringify({ perSecond: { glRenders: c.gl / 10, weatherFrames: c.wx / 10, cardRenders: c.card / 10, planRenders: c.plan / 10 }, cssAnimations: c.cssAnimations, paintMsPerS: +(sum('Paint') / 10).toFixed(1), paints: count('Paint') / 10, styleMsPerS: +(sum('UpdateLayoutTree') / 10).toFixed(1), scriptMsPerS: +(sum('FunctionCall') / 10).toFixed(1) }));
await browser.close();
