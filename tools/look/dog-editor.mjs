// The dog in the editor: inspector picture, 3D dog editor (turn, paint, gear, poses). Read-only: everything is
// cancelled at the end, nothing is saved.
import { openHA } from '../pw.mjs';
import { cardFn } from '../design/fake.mjs';
const out = process.argv[2] ?? '/tmp';
const ok = (c, m) => console.log(c ? '  ok:' : '• FAIL:', m);
const { browser, page, errors } = await openHA({ size: process.env.SIZE ?? '1366x900', kiosk: true, block: ['light', 'climate', 'vacuum', 'cover', 'media_player', 'fan', 'switch', 'tts', 'notify', 'select', 'house_rules'] });
const card = cardFn(page);
await page.waitForTimeout(3000);
await card(`(card.openEditor(), true)`);
await page.waitForTimeout(3000);
const E = (e) => page.evaluate(`(() => { const ed = document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui'); return ${e}; })()`);
const id = await E(`ed.floor.furniture.find((x) => x.kind === 'dog')?.id`);
await E(`(ed.select({ kind: 'furniture', id: ${JSON.stringify(id)} }), true)`);
await page.waitForTimeout(3500);
ok(await E(`!!ed.shadowRoot.querySelector('.dog-pic img')`), 'inspector shows a 3D picture of the dog');
await page.screenshot({ path: `${out}/de-inspector.png` });
if (process.env.ED3D) {
  await E(`(ed._view3d = true, ed.requestUpdate(), true)`);
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${out}/de-editor3d.png` });
}
if (process.env.ONLY_INSPECTOR) { await E(`(ed.shadowRoot.querySelector('.tb-left .btn').click(), true)`); await browser.close(); process.exit(0); }
await page.locator('floorplan-card-layer floorplan-card-editor-ui [data-dog-design]').click();
await page.waitForTimeout(4000);
const D = (e) => page.evaluate(`(() => { const d = document.querySelector('floorplan-card-layer').shadowRoot.querySelector('fp-dog-editor'); return ${e}; })()`);
ok(await D(`!!d && d._ready`), 'dog editor open, dog loaded');
await page.screenshot({ path: `${out}/de-open.png` });
// turn
const st = await page.locator('floorplan-card-layer fp-dog-editor .stage').boundingBox();
const cx = st.x + st.width / 2, cy = st.y + st.height / 2;
await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 160, cy + 10, { steps: 8 }); await page.mouse.up();
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/de-turned.png` });
// gear
await D(`(d.setPet((p) => { p.harness = '#3f8ed8'; p.bandana = '#d8483a'; }), true)`);
await page.waitForTimeout(2500);
await D(`(d.studio.view('side'), true)`);
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/de-gear.png` });
// paint: a stroke across the body
await page.locator('floorplan-card-layer fp-dog-editor [data-mode=paint]').click();
await D(`(d._color = '#c9893c', d._brush = 'l', true)`);
await page.mouse.move(cx - 60, cy - 10); await page.mouse.down(); await page.mouse.move(cx + 60, cy - 10, { steps: 14 }); await page.mouse.up();
await page.waitForTimeout(600);
const n = await D(`(d._f.pet?.paint ?? []).length`);
ok(n >= 1, `painted strokes: ${n}`);
await page.screenshot({ path: `${out}/de-paint.png` });
for (const pose of ['Sit', 'Lie', 'Sleep']) {
  await D(`(d._pose = ${JSON.stringify(pose)}, d.studio.setPose(${JSON.stringify(pose)}), d.studio.view('default'), true)`);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${out}/de-pose-${pose}.png` });
}
// cancel everything
await page.locator('floorplan-card-layer fp-dog-editor .bar .btn.plain').click();
await page.waitForTimeout(400);
ok(!(await D(`!!d`)), 'cancel closes the dog editor');
await E(`(ed.shadowRoot.querySelector('.tb-left .btn').click(), true)`);
console.log(errors.length ? errors.join('\n') : 'page: no errors');
await browser.close();
