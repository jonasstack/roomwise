// "Licht hinzufügen" in the preview (example data, nothing saved): a room without a lamp (Bad) says so on its tile;
// the chip opens the search over every lamp and light switch, "Diesem Raum zuordnen" makes the light switch
// "Spiegellicht" a lamp of the Bad. In a light rule "Licht hinzufügen" also offers "Nur in dieser Regel".
//   node tools/build.mjs && sh ../tools/heavy.sh browser node tools/test-light-add.mjs
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
const P = (body) => page.evaluate(new Function(`return (async () => { const panel = document.querySelector('house-rules-panel'); const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); ${body} })()`));

await P(`panel._setTab('light', ''); await panel.updateComplete; await sleep(500);`);
const chip = await P(`const v = panel.shadowRoot.querySelector('hr-light-plans'); const c = v.shadowRoot.querySelector('[data-no-lamp]'); return c ? c.closest('.rl-tile').querySelector('h2').textContent : null;`);
ok(chip === 'Bad', `room without a lamp has the chip (${chip})`);
await P(`const v = panel.shadowRoot.querySelector('hr-light-plans'); v.shadowRoot.querySelector('[data-no-lamp]').click(); await v.updateComplete; await sleep(300);`);
const list = await P(`const v = panel.shadowRoot.querySelector('hr-light-plans'); const a = v.shadowRoot.querySelector('hr-light-add'); if (!a) return null; await a.updateComplete; return { items: [...a.shadowRoot.querySelectorAll('.item')].map((i) => i.dataset.entity), ruleOnly: !!a.shadowRoot.querySelector('[data-rule-only]') };`);
ok(list?.items.includes('switch.spiegellicht') && list.items.some((e) => e.startsWith('light.')), 'the search lists lamps and the light switch', list);
ok(list && !list.ruleOnly, 'from the tile: only "Diesem Raum zuordnen"');
await P(`const v = panel.shadowRoot.querySelector('hr-light-plans'); const a = v.shadowRoot.querySelector('hr-light-add'); const i = a.shadowRoot.querySelector('.search input'); i.value = 'spiegel'; i.dispatchEvent(new Event('input')); await a.updateComplete; await sleep(100);`);
const filtered = await P(`const a = panel.shadowRoot.querySelector('hr-light-plans').shadowRoot.querySelector('hr-light-add'); return [...a.shadowRoot.querySelectorAll('.item')].map((i) => i.dataset.entity);`);
ok(filtered.length === 1 && filtered[0] === 'switch.spiegellicht', `search narrows it (${filtered})`);
await P(`const v = panel.shadowRoot.querySelector('hr-light-plans'); const a = v.shadowRoot.querySelector('hr-light-add'); a.shadowRoot.querySelector('[data-entity="switch.spiegellicht"] [data-assign]').click(); await sleep(400); await v.updateComplete;`);
const after = await P(`const d = panel.store.devices.find((x) => x.entity_id === 'switch.spiegellicht'); const v = panel.shadowRoot.querySelector('hr-light-plans'); return { kind: d.kind, room: d.room, open: !!v.shadowRoot.querySelector('hr-light-add'), chip: !!v.shadowRoot.querySelector('[data-no-lamp]') };`);
ok(after.kind === 'light' && after.room === 'bad', 'assigned: the light switch is a lamp of the Bad', after);
ok(!after.open && !after.chip, 'the search closes, the Bad has a lamp now', after);

// in a light rule: "Licht hinzufügen" with "Nur in dieser Regel"
const step = await P(`const v = panel.shadowRoot.querySelector('hr-light-plans'); const room = panel.store.rooms.find((x) => x.name === 'Wohnzimmer'); const rule = panel.store.plans.light[room.id].rules[0]; v._room = room.id; v._wiz = { ...rule, lights: ['light.sofalicht'] }; v._step = v._steps(v._wiz).indexOf('light'); await v.updateComplete; await sleep(300); const b = v.shadowRoot.querySelector('[data-light-add]'); if (!b) return false; b.click(); await v.updateComplete; await sleep(300); return true;`);
ok(step, 'the rule assistant has "Licht hinzufügen"');
const pick = await P(`const v = panel.shadowRoot.querySelector('hr-light-plans'); const a = v.shadowRoot.querySelector('hr-light-add'); await a.updateComplete; const row = a.shadowRoot.querySelector('[data-entity="light.flurlicht"]'); if (!row) return null; row.querySelector('[data-rule-only]').click(); await sleep(200); await v.updateComplete; return { lights: v._wiz.lights, room: panel.store.devices.find((x) => x.entity_id === 'light.flurlicht').room };`);
ok(pick?.lights.includes('light.flurlicht') && pick.room === 'flur', '"Nur in dieser Regel": the rule takes the lamp, its room stays', pick);
ok(!errors.length, 'no errors on the page', errors);
await browser.close();
console.log(fails ? `\n${fails} FEHLER` : '\nalles ok');
process.exit(fails ? 1 : 0);
