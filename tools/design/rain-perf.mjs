// Cost of the weather under rain (faked state). Headless Chromium renders WebGL in software, so GPU work
// shows up as CPU time — a fair proxy for a weak tablet GPU. Usage: node tools/design/rain-perf.mjs [cond] [shot.png]
import { openHA } from '../pw.mjs';
import { fakeStates } from './fake.mjs';
const cond = process.argv[2] ?? 'pouring';
const shot = process.argv[3];
const { browser, page, errors } = await openHA({ size: '1280x800', kiosk: true, block: ['light', 'climate', 'vacuum', 'cover', 'media_player', 'fan', 'switch', 'tts', 'notify'] });
await page.waitForTimeout(1500);
await fakeStates(page, { weather: cond, cover: 95, wind: 25, lights: false, heat: false, open: [] });
await page.waitForTimeout(3000);
if (shot) await page.screenshot({ path: shot });
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
const m = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
const m0 = await m();
const t0 = Date.now();
await page.evaluate(() => { window.__n = 0; const f = () => { window.__n++; if (!window.__stop) requestAnimationFrame(f); }; requestAnimationFrame(f); });
await page.waitForTimeout(6000);
const frames = await page.evaluate(() => { window.__stop = true; return window.__n; });
const m1 = await m();
const sec = (Date.now() - t0) / 1000;
const per = (k) => +((((m1[k] ?? 0) - (m0[k] ?? 0)) * 1000) / sec).toFixed(0);
console.log(JSON.stringify({ cond, local: !!process.env.FP_LOCAL, fps: +(frames / 6).toFixed(1), taskMsPerS: per('TaskDuration'), scriptMsPerS: per('ScriptDuration'), errors: errors.length }));
await browser.close();
