// "Sensor suchen" in Raum einstellen (preview, example data, nothing saved): every sensor of Home Assistant can be a
// presence / motion sensor of a room – also the radar sensor without a device class that the device list does not
// know. Chosen, it shows in the room's list with its name; choosing it as motion moves it there.
//   node tools/build.mjs && sh ../tools/heavy.sh browser node tools/test-sensor-search.mjs
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

writeFileSync('dist/preview-local.html', `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${readFileSync('dist/preview.html', 'utf8')}</body></html>`);
let fails = 0;
const ok = (c, m, extra) => {
  if (!c) fails++;
  console.log(c ? '  ok:' : '  FAIL:', m, !c && extra !== undefined ? JSON.stringify(extra).slice(0, 300) : '');
};
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('file://' + process.cwd() + '/dist/preview-local.html');
await page.waitForSelector('house-rules-panel');
await page.waitForTimeout(500);
const P = (body) => page.evaluate(new Function(`return (async () => { const panel = document.querySelector('house-rules-panel'); const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const rs = () => panel.shadowRoot.querySelector('hr-room-settings'); ${body} })()`));

await P(`panel.dispatchEvent(new CustomEvent('hr-room-settings', { detail: { id: 'bad' }, bubbles: true, composed: true })); await panel.updateComplete; await sleep(500);`);
ok(await P(`return !!rs()?.shadowRoot.querySelector('[data-find-sensor]');`), 'Raum einstellen (Bad) offers "Sensor suchen"');
await P(`rs().shadowRoot.querySelector('[data-find-sensor]').click(); await rs().updateComplete; await sleep(500);`);
const all = await P(`return [...rs().shadowRoot.querySelectorAll('.find-hit')].map((h) => h.dataset.entity);`);
ok(all.includes('binary_sensor.radar_bad'), 'the search lists the radar sensor without a device class', all);
await P(`const i = rs().shadowRoot.querySelector('[data-sensor-search]'); i.value = 'radar'; i.dispatchEvent(new Event('input')); await sleep(500); await rs().updateComplete;`);
const hits = await P(`return [...rs().shadowRoot.querySelectorAll('.find-hit')].map((h) => ({ id: h.dataset.entity, suggest: h.querySelector('button.suggest')?.textContent.trim() }));`);
ok(hits.length === 1 && hits[0].id === 'binary_sensor.radar_bad' && hits[0].suggest === 'Anwesenheit', '"radar" finds it, suggested as Anwesenheit', hits);
await P(`const h = rs().shadowRoot.querySelector('.find-hit[data-entity="binary_sensor.radar_bad"]'); h.querySelectorAll('.seg-mini button')[0].click(); await sleep(300); await rs().updateComplete;`);
const room = await P(`const r = panel.store.room('bad'); return { presence: r.presence, motion: r.motion };`);
ok(room.presence.includes('binary_sensor.radar_bad'), 'chosen: a presence sensor of the Bad', room);
await P(`rs().shadowRoot.querySelector('hr-pop[heading="Sensor suchen"]').dispatchEvent(new CustomEvent('close')); await sleep(300); await rs().updateComplete;`);
const shown = await P(`return [...rs().shadowRoot.querySelectorAll('.rl-item b')].map((b) => b.textContent.trim());`);
ok(shown.includes('Radar Bad'), 'the room list shows it with its name', shown);
await P(`rs()._find = true; await rs().updateComplete; await sleep(400); const h = rs().shadowRoot.querySelector('.find-hit[data-entity="binary_sensor.radar_bad"]'); h.querySelectorAll('.seg-mini button')[1].click(); await sleep(300);`);
const moved = await P(`const r = panel.store.room('bad'); return { presence: r.presence, motion: r.motion };`);
ok(moved.motion.includes('binary_sensor.radar_bad') && !moved.presence.includes('binary_sensor.radar_bad'), 'as Bewegung: moved from presence to motion', moved);

// zones of a multi-zone presence sensor (FP2 & co.) of another room: offered under "Sensor aus anderem Raum" too
await P(`rs()._find = false; rs()._more = true; await rs().updateComplete; await sleep(300);`);
const other = await P(`return [...rs().shadowRoot.querySelectorAll('.rl-sec .rl-item b')].map((b) => b.textContent.trim());`);
ok(other.includes('Kochfeld'), '"Sensor aus anderem Raum" offers a zone of the Küche', other);
await P(`[...rs().shadowRoot.querySelectorAll('button.rl-item')].find((b) => b.querySelector('b')?.textContent.trim() === 'Kochfeld').click(); await sleep(300);`);
ok((await P(`return panel.store.room('bad').zones;`)).some((z) => z.endsWith('4')), 'chosen: a zone of the Bad');

ok(!errors.length, 'no errors on the page', errors);
await browser.close();
console.log(fails ? `\n${fails} FAIL` : '\nalles ok');
process.exit(fails ? 1 : 0);
