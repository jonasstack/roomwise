// Headless screenshot of an HA page, logged in via the long-lived token (injected into localStorage).
// Usage: node tools/shot.mjs <path> <out.png> [WxH] [dark|light]
import { chromium } from 'playwright';
import { loadEnv } from './ha.mjs';
const [path = '/grundriss-test/grundriss', out = 'shot.png', size = '1280x800', scheme = 'light'] = process.argv.slice(2);
const [width, height] = size.split('x').map(Number);
const { url, token } = loadEnv();
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, deviceScaleFactor: 1, serviceWorkers: 'block' });
await ctx.addInitScript(([u, t]) => {
  localStorage.setItem('hassTokens', JSON.stringify({
    hassUrl: u, clientId: u + '/', access_token: t, refresh_token: '', token_type: 'Bearer',
    expires_in: 1e9, expires: Date.now() + 1e12,
  }));
}, [url, token]);
const page = await ctx.newPage();
const errors = [];
// Pre-existing issues of this instance (not caused by the card): duplicate clock-weather-card resource, a 3rd-party source map 404.
const KNOWN = [/clock-weather-card/, /scoped-custom-element-registry/, /status of 404/, /Service Worker registration blocked/];
// HA's own service-worker hook fails when tests block service workers (blocked to avoid HA's auto-reload).
const isSwArtifact = (e) => /reading 'addEventListener'/.test(e.message) && /frontend_latest\/app\./.test(e.stack ?? '');
page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !KNOWN.some((r) => r.test(m.text()))) errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => { if (!KNOWN.some((r) => r.test(e.message)) && !isSwArtifact(e)) errors.push('[pageerror] ' + e.message); });
await page.goto(url + path, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
await page.screenshot({ path: out });
console.log('url:', page.url());
console.log(errors.length ? errors.join('\n') : 'console: keine Fehler/Warnungen');
await browser.close();
