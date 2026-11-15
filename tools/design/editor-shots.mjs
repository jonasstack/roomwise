// Screenshots of every editor panel (tall viewport: whole inspector visible). Does not save.
import { openHA, tapAt } from '../pw.mjs';
import { cardFn } from './fake.mjs';
const out = process.argv[2] ?? '/tmp';
const tag = process.argv[3] ?? 'ed';
const { browser, page, errors } = await openHA({ size: '1280x800', kiosk: true, block: ['light', 'climate', 'vacuum', 'cover', 'todo', 'media_player', 'fan', 'switch', 'tts', 'notify'] });
const card = cardFn(page);
await page.locator('floorplan-card .chrome .icon-btn[aria-label="Grundriss bearbeiten"]').click();
await page.waitForTimeout(1200);
const ed = `card.shadowRoot.querySelector('floorplan-card-editor-ui') ?? document.querySelector('floorplan-card-editor-ui')`;
const sel = async (kind, pred) => {
  await page.evaluate(([kind, pred]) => {
    const deep = (root, tag) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === tag) return el; if (el.shadowRoot) { const f = deep(el.shadowRoot, tag); if (f) return f; } } };
    const e = deep(document, 'FLOORPLAN-CARD-EDITOR-UI');
    const f = e._draft.floors[e._floor ?? 0];
    const list = kind === 'room' ? f.rooms : kind === 'opening' ? f.openings : kind === 'device' ? f.devices : f.furniture;
    const it = list.find(new Function('x', `return ${pred}`));
    e.select({ kind, id: it.id });
  }, [kind, pred]);
  await page.waitForTimeout(700);
};
const shot = async (n) => {
  // the whole panel, unscrolled
  await page.evaluate(() => {
    const deep = (root, tag) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === tag) return el; if (el.shadowRoot) { const f = deep(el.shadowRoot, tag); if (f) return f; } } };
    const e = deep(document, 'FLOORPLAN-CARD-EDITOR-UI');
    const b = e.shadowRoot.querySelector('.panel-body');
    if (b) { b.style.overflow = 'visible'; b.style.maxHeight = 'none'; b.style.flex = 'none'; }
    for (const d of e.shadowRoot.querySelectorAll('details.fold')) d.open = !!window.__openFolds;
  });
  await page.waitForTimeout(300);
  const panel = page.locator('floorplan-card-editor-ui .panel-body').first();
  if (await panel.count()) await panel.screenshot({ path: `${out}/${tag}-${n}.png` }).catch(() => page.screenshot({ path: `${out}/${tag}-${n}.png` }));
  else await page.screenshot({ path: `${out}/${tag}-${n}.png` });
};
await shot('open');
await sel('room', "x.name === 'Wohnzimmer'"); await shot('room');
await sel('furniture', "x.kind === 'radiator'"); await shot('radiator');
await sel('furniture', "x.kind === 'ceiling_lamp'"); await shot('lamp');
await sel('furniture', "x.kind === 'dog'"); await shot('dog');
await sel('furniture', "x.kind === 'robot_vacuum'"); await shot('vacuum');
await sel('furniture', "x.kind === 'car'"); await shot('car');
await sel('opening', "x.type === 'window'"); await shot('window');
await sel('opening', "x.type === 'door'"); await shot('door');
await page.locator('floorplan-card-editor-ui .tool[data-panel="settings"]').click();
await page.waitForTimeout(800);
await shot('settings');
console.log(errors.length ? errors.join('\n') : 'console: ok');
await browser.close();
