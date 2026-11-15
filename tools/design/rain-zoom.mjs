// Rain while zooming: does the rain keep falling, and what does it cost? 6 s of trackpad pinching under
// pouring rain (faked). Reports rain frames drawn per second and main-thread task time (software WebGL ≈ GPU).
import { openHA } from '../pw.mjs';
import { fakeStates, FIND } from './fake.mjs';
const { browser, page, errors } = await openHA({ size: '1280x800', kiosk: true, block: ['light', 'climate', 'vacuum', 'cover', 'media_player', 'fan', 'switch', 'tts', 'notify'] });
await page.waitForTimeout(2500);
await fakeStates(page, { weather: 'pouring', cover: 95, wind: 25, lights: false, heat: false, open: [] });
await page.waitForTimeout(3000);
const front = `(() => { ${FIND} const card = find(document); return card.shadowRoot.querySelector('fp-ambient[layer=front]').wx; })()`;
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
const m = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
const measure = async (zooming) => {
  const d0 = await page.evaluate(`${front}.draws`);
  const m0 = await m();
  const t0 = Date.now();
  if (zooming)
    await page.evaluate(`(() => { ${FIND} const card = find(document); const plan = card.shadowRoot.querySelector('fp-plan'); const vp = plan.shadowRoot.querySelector('.viewport'); const r = vp.getBoundingClientRect(); let i = 0; const iv = setInterval(() => { const dy = Math.sin(i++ / 25) * 4; vp.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, ctrlKey: true, clientX: r.left + 640, clientY: r.top + 400, bubbles: true, cancelable: true })); if (i > 360) clearInterval(iv); }, 16); })()`);
  await page.waitForTimeout(6000);
  const m1 = await m();
  const d1 = await page.evaluate(`${front}.draws`);
  const sec = (Date.now() - t0) / 1000;
  return { zooming, rainFps: +((d1 - d0) / sec).toFixed(1), taskMsPerS: +((((m1.TaskDuration - m0.TaskDuration) * 1000) / sec).toFixed(0)) };
};
console.log(JSON.stringify(await measure(false)));
console.log(JSON.stringify(await measure(true)));
console.log(errors.length ? errors.join('\n') : 'page: no errors');
await browser.close();
