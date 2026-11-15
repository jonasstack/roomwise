// UI check of "Wo ist wer" in the isolated test HA (port 8124): "Zuhause" shows a tile per person with its status line;
// a tile opens the person pop-up, which loads Home Assistant's own map element (<ha-map>) through the card helpers.
// Run after test-places.mjs.
// Usage: node tools/testha/test-places-ui.mjs [shotdir]
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { token, wsConnect, URL0, ok, failures, until } from './lib.mjs';
const require = createRequire(new URL('../../../package.json', import.meta.url));
const { chromium } = require('playwright');
const out = process.argv[2];
const tok = await token();
const ws = await wsConnect(tok);
// the integration may still be loading on a fresh test HA
await until(async () => (await ws.call({ type: 'house_rules/info' }).catch(() => null))?.loaded, 90000, 1000);
await ws.call({ type: 'house_rules/setup/save', done: true });
// a person with a GPS tracker of hr_fake (the map needs a position); removed again at the end
const NAME = 'Robin Karte';
if (!(await ws.call({ type: 'person/list' })).storage.some((x) => x.name === NAME)) await ws.call({ type: 'person/create', name: NAME, device_trackers: ['device_tracker.handy_robin'] });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, colorScheme: 'light' });
await ctx.addInitScript(([u, t]) => {
  localStorage.setItem('hassTokens', JSON.stringify({ hassUrl: u, clientId: u + '/', access_token: t, refresh_token: '', expires_in: 1e9, expires: Date.now() + 1e12 }));
}, [URL0, tok]);
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(String(e)));
await p.goto(`${URL0}/hausregeln/home`);
const view = p.locator('hr-home-view');
// on a fresh test HA the assistant for the automatic house mode opens by itself: close it
await p.waitForTimeout(3000);
if (await p.locator('hr-assistant-mode').count()) await p.keyboard.press('Escape');
ok(await until(async () => (await view.locator('article.rl-tile:has(.av)', { hasText: NAME }).count()) === 1, 30000, 500), '„Wo ist wer“ zeigt die Personen');
const lines = await view.locator('article.rl-tile:has(.av) .state').allTextContents();
ok(lines.every((l) => l.length > 3), 'jede Person mit Statuszeile', lines);
await view.locator('article.rl-tile:has(.av)', { hasText: NAME }).locator('.rl-open').click();
const pop = p.locator('hr-person-pop');
ok(await until(async () => (await pop.locator('ha-map').count()) === 1, 20000, 500), 'Karte von Home Assistant (ha-map) im Personen-Pop-up geladen');
ok(await until(async () => p.evaluate(() => !!customElements.get('ha-map')), 5000), 'ha-map ist im Panel verfügbar');
if (out) {
  await p.waitForTimeout(2500);
  await p.screenshot({ path: join(out, 'where-live.png') });
}
ok(!errors.length, 'keine Fehler in der Seite', errors);
await browser.close();
for (const x of (await ws.call({ type: 'person/list' })).storage.filter((x) => x.name === NAME)) await ws.call({ type: 'person/delete', person_id: x.id });
ws.close();
console.log(failures() ? `\n${failures()} FEHLER` : '\nalles ok');
process.exit(failures() ? 1 : 0);
