// How temperatures appear (label outside / inside / engraved in the wall): picture tiles at the top of the editor's
// settings ("Darstellung") and as a step of the editor tour – a tap on a tile sets label_style / labels. Also checks
// that "Wer ist wo" sits in the same section. Mock harness (no Home Assistant, neutral demo home).
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/label-style.mjs [outDir] [light|dark]
import { openMock, demoHome, demoStates, demoEntities } from './mock.mjs';

const out = process.argv[2];
const scheme = process.argv[3] ?? 'light';
let fails = 0;
const ok = (c, m) => {
  if (!c) fails++;
  console.log(c ? '• ok:' : '• FAIL:', m);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ED = `document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui')`;

for (const size of ['1280x900', '390x844']) {
  const m = await openMock({ config: { ...demoHome(), view_mode: '2d' }, states: demoStates(), entities: demoEntities, size, scheme });
  const { page } = m;
  await m.card(`(card.openEditor(), true)`);
  await wait(2000);
  await page.evaluate(`${ED}._tour = false`);
  await page.evaluate(`${ED}._panel = 'settings'`);
  await wait(600);
  const tiles = `${ED}.shadowRoot.querySelector('fp-label-style')`;
  ok(await page.evaluate(`!!${tiles}`), `${size}: Raumschilder als Bild-Kacheln in den Einstellungen`);
  const order = await page.evaluate(`(() => { const r = ${ED}.shadowRoot; const s = [...r.querySelectorAll('.section-title')].map((e) => e.textContent.trim()); return s.slice(0, 3); })()`);
  ok(order[0] === 'Darstellung' && order[1] === 'Raumschilder', `${size}: gleich unter der Ansicht (${JSON.stringify(order)})`);
  const labels = await page.evaluate(`[...${tiles}.shadowRoot.querySelectorAll('.ls-tile .lbl')].map((e) => e.textContent)`);
  ok(JSON.stringify(labels) === JSON.stringify(['Schild außen', 'Schild im Raum', 'In die Wand graviert']), `${size}: drei Wahlmöglichkeiten ${JSON.stringify(labels)}`);
  ok((await page.evaluate(`${tiles}.shadowRoot.querySelectorAll('.ls-tile svg').length`)) === 3, `${size}: jede mit Skizze`);
  await page.evaluate(`${tiles}.shadowRoot.querySelector('[data-style="wall"]').click()`);
  await wait(300);
  ok((await page.evaluate(`${ED}._draft.label_style`)) === 'wall', `${size}: Kachel „In die Wand graviert“ setzt label_style: wall`);
  if (out) await page.screenshot({ path: `${out}/label-style-settings-${size}-${scheme}.png` });
  await page.evaluate(`${tiles}.shadowRoot.querySelector('[data-style="inside"]').click()`);
  await wait(300);
  const d = await page.evaluate(`({ s: ${ED}._draft.label_style ?? null, l: ${ED}._draft.labels ?? null })`);
  ok(d.s === null && d.l === 'inside', `${size}: Kachel „Schild im Raum“ → labels: inside (${JSON.stringify(d)})`);
  const people = await page.evaluate(`(() => { const r = ${ED}.shadowRoot; const t = [...r.querySelectorAll('.row .title')].find((e) => /Wer ist wo/.test(e.textContent)); if (!t) return null; const st = [...r.querySelectorAll('.section-title')].filter((s) => s.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING).map((s) => s.textContent.trim()); return st.at(-1); })()`);
  ok(people === 'Raumschilder', `${size}: „Wer ist wo“ steht oben bei der Darstellung (unter: ${people})`);

  // the tour: a step "So erscheinen Temperaturen" with the same tiles
  await page.evaluate(`(${ED}._panel = null, ${ED}._tour = true)`);
  await wait(600);
  const tour = `${ED}.shadowRoot.querySelector('fp-editor-tour')`;
  for (let i = 0; i < 8; i++) {
    const has = await page.evaluate(`!!${tour}?.shadowRoot.querySelector('fp-label-style')`);
    if (has) break;
    await page.evaluate(`${tour}.shadowRoot.querySelector('.next').click()`);
    await wait(350);
  }
  const title = await page.evaluate(`${tour}?.shadowRoot.querySelector('.title')?.textContent`);
  ok(title === 'So erscheinen Temperaturen', `${size}: Rundgang zeigt „${title}“`);
  if (out) await page.screenshot({ path: `${out}/label-style-tour-${size}-${scheme}.png` });
  await page.evaluate(`${tour}.shadowRoot.querySelector('fp-label-style').shadowRoot.querySelector('[data-style="wall"]').click()`);
  await wait(300);
  ok((await page.evaluate(`${ED}._draft.label_style`)) === 'wall', `${size}: Wahl im Rundgang setzt label_style: wall`);
  ok(m.errors.length === 0, `${size}: keine Konsolenfehler ${m.errors.join(' | ').slice(0, 300)}`);
  await m.browser.close();
}
console.log(fails ? `\n${fails} FAIL` : '\nall ok');
process.exit(fails ? 1 : 0);
