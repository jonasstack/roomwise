// Every time in "Raum einstellen" goes down to 0 in the preview (example data, nothing saved): pressing "weniger" on
// each time stepper ends at "0 Sek." – "leer nach", the door pulse, "hell erst nach" – and the room keeps 0.
//   node tools/build.mjs && sh ../tools/heavy.sh browser node tools/test-zero-times.mjs
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

const res = await page.evaluate(async () => {
  const panel = document.querySelector('house-rules-panel');
  const room = panel.store.rooms.find((r) => r.door_pulse?.length) ?? panel.store.rooms[0];
  // a door pulse to have its stepper shown
  if (!room.door_pulse?.length) {
    const door = panel.store.devices.find((d) => d.kind === 'door');
    if (door) await panel.store.saveRoom({ ...room, door_pulse: [door.entity_id] });
  }
  panel.dispatchEvent(new CustomEvent('hr-room-settings', { detail: { id: room.id }, bubbles: true, composed: true }));
  await panel.updateComplete;
  await new Promise((r) => setTimeout(r, 600));
  const find = (root) => {
    const e = root.querySelector('hr-room-settings');
    if (e) return e;
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; }
    return null;
  };
  const view = find(panel.shadowRoot);
  if (!view) return { view: false };
  const steppers = () => [...view.shadowRoot.querySelectorAll('.stepper')].filter((s) => /Sek\.|Min\.|Std\./.test(s.querySelector('output')?.textContent ?? ''));
  const n = steppers().length;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 60; k++) {
      steppers()[i]?.querySelector('button[aria-label="weniger"]')?.click();
      await view.updateComplete;
    }
  }
  await new Promise((r) => setTimeout(r, 300));
  const r = panel.store.rooms.find((x) => x.id === room.id);
  return { view: true, n, outputs: steppers().map((s) => s.querySelector('output').textContent.trim()), empty_after: r.empty_after, door_pulse_for: r.door_pulse_for, bright_for: r.dark?.bright_for };
});
ok(res.view, 'Raum einstellen offen');
ok(res.n >= 3, `${res.n} Zeit-Stepper gefunden`, res);
ok(res.outputs?.every((o) => o === '0 Sek.'), `alle auf 0: ${res.outputs?.join(', ')}`, res);
ok(res.empty_after === 0, 'leer nach 0', res);
ok(res.door_pulse_for === 0, 'Tür-Puls 0', res);
ok(res.bright_for === 0, 'hell erst nach 0', res);
ok(!errors.length, 'keine Fehler auf der Seite', errors);
await browser.close();
console.log(fails ? `\n${fails} FAIL` : '\nalles ok');
process.exit(fails ? 1 : 0);
