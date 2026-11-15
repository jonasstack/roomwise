// Screenshots of the real panel in the isolated test HA (port 8124), with a few example rules.
// Usage: node tools/testha/ui-shots.mjs <outdir>
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { token, wsConnect, URL0, sleep } from './lib.mjs';
const require = createRequire(new URL('../../../package.json', import.meta.url));
const { chromium } = require('playwright');
const out = process.argv[2] || 'dist/shots-live';
const tok = await token();
const ws = await wsConnect(tok);
const snap = await ws.call({ type: 'house_rules/snapshot' });
if (!snap.rules.length) {
  for (const s of snap.suggestions.filter((x) => x.rule)) await ws.call({ type: 'house_rules/rule/save', rule: { ...s.rule, suggestion: s.id } });
  await ws.call({ type: 'house_rules/rule/save', rule: { name: 'Licht beim Heimkommen', when: [{ subject: 'binary_sensor.haustuer', verb: 'opens' }], then: [{ subject: 'light.flurlicht', verb: 'turn_on', brightness: 70, for: '5m' }], only: [{ subject: 'sun', verb: 'is_down' }] } });
}
ws.close();
const browser = await chromium.launch();
const errors = [];
async function open(w, h, scheme) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme });
  await ctx.addInitScript(([u, t]) => {
    localStorage.setItem('hassTokens', JSON.stringify({ hassUrl: u, clientId: u + '/', access_token: t, refresh_token: '', expires_in: 1e9, expires: Date.now() + 1e12 }));
  }, [URL0, tok]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('console', (m) => m.type() === 'error' && !/favicon|manifest/.test(m.text()) && errors.push(m.text()));
  await p.goto(URL0 + '/hausregeln');
  await p.waitForSelector('house-rules-panel', { timeout: 30000 });
  await sleep(2500);
  return p;
}
const shot = (p, name, full = false) => p.screenshot({ path: join(out, name + '.png'), fullPage: full });
const panel = (p) => p.locator('house-rules-panel');
let p = await open(1280, 900, 'light');
await shot(p, 'L01-rules');
await panel(p).locator('nav button:has-text("Räume")').click();
await sleep(500);
await shot(p, 'L02-rooms');
await p.locator('hr-rooms-view .rl-tile .rl-open').first().click();
await sleep(600);
await shot(p, 'L03-room-detail');
await p.keyboard.press('Escape');
await panel(p).locator('nav button:has-text("Geräte")').click();
await sleep(500);
await shot(p, 'L04-devices');
await p.locator('hr-devices-view .rl-tile:has-text("Fenstersensor Küche") .rl-open').click();
await sleep(600);
await shot(p, 'L05-device');
await p.keyboard.press('Escape');
await panel(p).locator('nav button:has-text("Verlauf")').click();
await sleep(500);
await shot(p, 'L06-history');
await panel(p).locator('nav button:has-text("Regeln")').click();
await sleep(300);
await p.locator('hr-rules-view #ask').fill('Wenn die Haustür aufgeht und niemand zuhause ist, schick mir eine Nachricht');
await p.locator('hr-rules-view .send').click();
await sleep(2500);
await shot(p, 'L07-from-text');
await p.locator('house-rules-editor button:has-text("Jetzt prüfen")').click();
await sleep(800);
await p.locator('house-rules-editor .body').evaluate((e) => (e.scrollTop = 500));
await shot(p, 'L08-test');
await p.locator('house-rules-editor button:has-text("Sichern")').click();
await sleep(1200);
await shot(p, 'L09-saved');
await panel(p).locator('nav button:has-text("Zuhause")').click();
await sleep(500);
await shot(p, 'L12-home', true);
await panel(p).locator('nav button:has-text("Alarm")').click();
await sleep(500);
await shot(p, 'L13-alarm', true);
await panel(p).locator('nav .gear').click();
await sleep(400);
await shot(p, 'L10-settings', true);
await p.locator('hr-settings-view .wiz .btn').click();
await sleep(1500);
for (let i = 0; i < 13; i++) {
  await shot(p, `L20-wizard-${String(i).padStart(2, '0')}`);
  const next = p.locator('hr-setup-wizard footer .btn.primary');
  if ((await next.textContent())?.includes('Fertig')) break;
  // skip: nothing is changed in the test HA by the screenshots
  const skip = p.locator('hr-setup-wizard footer .btn.plain');
  await ((await skip.count()) ? skip : next).click();
  await sleep(900);
}
await p.locator('hr-setup-wizard footer .btn.primary').click();
await sleep(500);
await p.close();
p = await open(390, 844, 'dark');
await shot(p, 'L11-phone-dark');
await panel(p).locator('nav .gear').click();
await sleep(500);
await shot(p, 'L14-phone-settings', true);
await browser.close();
console.log(errors.length ? 'ERRORS:\n' + [...new Set(errors)].join('\n') : 'no console errors');
