// Alignment mode: the view moves with right mouse, middle mouse, Ctrl+drag and Space+drag; the map does not. Never saves.
import { openHA } from '../pw.mjs';
const { browser, page, errors } = await openHA({ size: '1280x900', kiosk: true, companion: true, block: ['light', 'climate', 'vacuum', 'cover', 'media_player', 'fan', 'switch', 'tts', 'notify'] });
const ED = 'floorplan-card-editor-ui';
const ok = (c, m) => console.log(c ? '• ok:' : '• FAIL:', m);
const ed = (fn) => page.evaluate(`(${fn})(document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui'))`);
await page.locator('floorplan-card .chrome .icon-btn[aria-label="Grundriss bearbeiten"]').click();
await page.waitForTimeout(1200);
await ed(`(e) => e.select({ kind: 'furniture', id: e._draft.floors[0].furniture.find((f) => f.kind === 'robot_vacuum').id })`);
await page.waitForTimeout(2500);
await page.locator(`${ED} .panel button.row`, { hasText: 'Karte auflegen' }).click();
await page.waitForTimeout(1500);
const state = () => ed(`(e) => { const v = e.shadowRoot.querySelector('fp-plan').panZoom.view; const t = e.alignPiece.vacuum.transform; return { tx: Math.round(v.tx), ty: Math.round(v.ty), x: t.x, y: t.y }; }`);
const box = await page.locator(`${ED} fp-plan`).boundingBox();
const c = { x: box.x + box.width * 0.5, y: box.y + box.height * 0.35 };
const drag = async (opts = {}, mods = []) => {
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down(opts);
  for (let i = 1; i <= 10; i++) await page.mouse.move(c.x + 6 * i, c.y + 4 * i);
  await page.mouse.up(opts);
  for (const m of mods) await page.keyboard.up(m);
  await page.waitForTimeout(400);
};
for (const [name, opts, mods] of [['right mouse', { button: 'right' }, []], ['middle mouse', { button: 'middle' }, []], ['Ctrl + drag', {}, ['Control']], ['Space + drag', {}, ['Space']]]) {
  const a = await state();
  await drag(opts, mods);
  const b = await state();
  ok((b.tx !== a.tx || b.ty !== a.ty) && b.x === a.x && b.y === a.y, `${name}: view moves (${a.tx},${a.ty} → ${b.tx},${b.ty}), map stays`);
}
const a = await state();
await drag();
const b = await state();
ok(b.x !== a.x && b.tx === a.tx, `left drag moves the map (${a.x} → ${b.x}), view stays`);
await page.locator(`${ED} .va-done`).click();
await page.waitForTimeout(400);
await page.locator(`${ED} .tb-left .btn`).click();
await page.waitForTimeout(300);
if (await page.locator(`${ED} .alert`).count()) await page.locator(`${ED} .alert .btn.danger`).click();
console.log(errors.length ? errors.join('\n') : 'console: ok');
await browser.close();
