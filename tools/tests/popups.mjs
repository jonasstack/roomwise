// Opens every popup type and saves screenshots. All service calls are intercepted (nothing reaches HA).
import { openHA, tapAt, piecePoint, roomPoint } from '../pw.mjs';
const out = process.argv[2] ?? '/tmp';
const scheme = process.argv[3] ?? 'light';
const size = process.argv[4] ?? '1280x800';
const ALL = ['light', 'climate', 'vacuum', 'cover', 'todo', 'media_player', 'fan', 'switch', 'homeassistant', 'remote', 'button', 'script', 'scene', 'lock'];
const { browser, page, errors } = await openHA({ scheme, size, block: ALL });
await page.waitForTimeout(4000); // the 3D scene builds first (software WebGL blocks the main thread, a hold timer would fire late)
const shots = [
  ['light', 'light.'],
  ['climate', 'climate.'],
  ['vacuum', 'vacuum.'],
  ['todo', 'todo.'],
  ['media', 'media_player.'],
];
const FIND = `const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } }; const card = find(document);`;
// furniture: long press = the popup (a tap would switch a lamp); device markers: a tap is the popup (hold = HA's dialog)
for (const [name, entity] of shots) {
  const pt = await piecePoint(page, entity);
  const marker = await page.evaluate(`(() => { ${FIND} const f = card._config.floors[0]; const hit = (e) => e && (e === ${JSON.stringify(entity)} || (${JSON.stringify(entity)}.endsWith('.') && e.startsWith(${JSON.stringify(entity)})));
    return !(f.furniture ?? []).some((x) => hit(x.entity)) && (f.devices ?? []).some((x) => hit(x.entity)); })()`);
  // not tappable on the plan (e.g. the vacuum hidden in its dock): open it the way the card does
  if (pt) await tapAt(page, pt[0], pt[1], marker ? 0 : 900);
  else
    await page.evaluate(`(() => { ${FIND} const e = ${JSON.stringify(entity)};
      const ids = card._config.floors.flatMap((f) => [...(f.furniture ?? []), ...(f.devices ?? [])]).map((x) => x.entity).filter(Boolean);
      card.ensureLayer().openPopup({ entity: e.endsWith('.') ? ids.find((x) => x.startsWith(e)) : e }); })()`);
  await page.waitForTimeout(900);
  console.log((await page.locator('floorplan-card-layer .sheet').count()) === 1 ? `• ok: ${name} popup open` : `• FAIL: ${name}: no popup`);
  await page.screenshot({ path: `${out}/popup-${name}-${scheme}-${size}.png` });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
}
// Room popup via long press on the living room (empty spot)
const roomPt = await roomPoint(page, 'Wohnzimmer');
await tapAt(page, roomPt[0], roomPt[1], 900);
await page.waitForTimeout(900);
console.log((await page.locator('fp-room-popup').count()) === 1 ? '• ok: room popup open' : '• FAIL: no room popup');
await page.screenshot({ path: `${out}/popup-room-${scheme}-${size}.png` });
await page.keyboard.press('Escape');
console.log(errors.length ? errors.join('\n') : 'console: keine Fehler/Warnungen');
console.log('calls:', JSON.stringify(await page.evaluate(() => window.__fpCalls)));
await browser.close();
