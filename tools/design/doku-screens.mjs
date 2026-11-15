// Screenshots for the doku "Oberfläche" tab (docs/doku/assets/screens/) plus the boxes of the important controls in
// percent of the picture, printed as JSON (for the hotspots in docs/doku/screens/*.md). Every screen is also saved as
// an HTML copy (docs/doku/pages/<id>.html, flattened shadow DOM: doku-page.mjs); --no-html skips that.
// Made from the demo home (examples/demo.json) on the isolated test HA (tools/release/demo-setup.mjs) unless
// FP_DASHBOARD names another dashboard of a test instance. Daylight and sunny weather are faked in the page
// (FP_SCENE='{"weather":"rainy",…}' for another scene, see fake.mjs); the demo has no car integration, so the car
// overview gets a neutral demo car (tools/tests/mock.mjs) in the page only. Read-only: popups and editor are opened
// and closed again, nothing is saved, service calls are intercepted.
// Usage: sh tools/heavy.sh testha sh tools/design/doku-screens.sh [basis,mehr]   (starts the test HA, then this script)
//        node tools/design/doku-screens.mjs [outdir] [basis,mehr] [--no-html]   (default: both groups)
import { mkdirSync } from 'node:fs';
import { SETUP } from '../tests/floors-setup.mjs';
import { demoCar } from '../tests/mock.mjs';
import { fakeStates } from './fake.mjs';
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const OUT = args[0] ?? 'docs/doku/assets/screens';
const GROUPS = (args[1] ?? 'basis,mehr').split(',');
if (!process.env.FP_DASHBOARD) await (await import('../release/demo-setup.mjs')).setupDemo();
const { openHA } = await import('../pw.mjs');
const pages = process.argv.includes('--no-html') ? null : await (await import('./doku-page.mjs')).docPages();
const W = 1280, H = 800;
mkdirSync(OUT, { recursive: true });
const { browser, page, errors } = await openHA({ size: `${W}x${H}`, kiosk: true, block: ['light', 'climate', 'vacuum', 'cover', 'todo', 'media_player', 'fan', 'switch', 'homeassistant', 'scene', 'script', 'lock', 'button', 'notify', 'tts'] });
const FIND = `const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } }; const card = find(document); const plan = card.shadowRoot.querySelector('fp-plan');`;
const ev = (body) => page.evaluate(`(() => { ${FIND} ${body} })()`);
const pct = (b) => (b ? [b.x / W, b.y / H, b.width / W, b.height / H].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 1000) / 10) : null);
const box = async (sel) => pct(await page.locator(sel).first().boundingBox().catch(() => null));
const out = {};
const shot = async (name, boxes) => {
  // popups fade in: wait until no finite animation runs any more (picture and HTML copy show the same state)
  await page
    .waitForFunction(() => [...document.getAnimations(), ...(document.querySelector('floorplan-card-layer')?.shadowRoot?.getAnimations() ?? [])].every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity), null, { timeout: 4000, polling: 100 })
    .catch(() => {});
  await page.screenshot({ path: `${OUT}/${name}.png` });
  out[name] = {};
  for (const [k, v] of Object.entries(boxes)) out[name][k] = typeof v === 'string' ? await box(v) : v;
  if (pages) await pages.save(page, { id: name, url: process.env.FP_DASHBOARD });
};
// open states of a screen (doku standard 9: pages/<id>.s<n>.html, HTML copy only): open a closed section, save, close
const state = async (id, label, sel) => {
  if (!pages) return;
  const loc = page.locator(`${sel} >> visible=true`).first();
  try {
    if (!(await loc.count())) throw new Error(`nothing visible: ${sel}`);
    const el = await loc.elementHandle(); // the selector no longer matches once the section is open
    await el.click({ timeout: 5000 });
    await page.waitForTimeout(700);
    await pages.state(page, { id, url: process.env.FP_DASHBOARD, label, trigger: sel });
    await el.click({ timeout: 3000 });
    await page.waitForTimeout(400);
  } catch (e) {
    console.error(`state ${id} „${label}“: ${String(e.message).split('\n')[0]}`);
  }
};
await page.waitForTimeout(2500);
// faked states for the shots (see fake.mjs): by default a sunny day, whatever the time on the test instance, with the
// first lamp of the demo on (its control panel is one of the screens)
const SCENE = process.env.FP_SCENE
  ? JSON.parse(process.env.FP_SCENE)
  : {
      weather: 'sunny',
      states: {
        'sun.sun': { state: 'above_horizon', attributes: { elevation: 25, azimuth: 200 } },
        'light.sofalicht': { state: 'on', attributes: { brightness: 191, color_mode: 'color_temp', color_temp_kelvin: 2700, min_color_temp_kelvin: 2000, max_color_temp_kelvin: 6500, supported_color_modes: ['color_temp', 'hs'] } },
      },
    };
await fakeStates(page, SCENE);

if (GROUPS.includes('basis')) {
// overview: a lamp, the dog and a room label measured on the plan
const pieces = await ev(`
  const fl = card._config.floors[0];
  const lamp = (fl.furniture ?? []).find((f) => /lamp|light/.test(f.kind) && f.entity);
  const dog = (fl.furniture ?? []).find((f) => f.kind === 'dog');
  const r = (id) => { const b = id && plan.pieceRect(id); if (!b) return null; const o = plan.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.w, height: b.h }; };
  return { lamp: r(lamp?.id), dog: r(dog?.id) };`);
await shot('uebersicht', {
  weather: 'floorplan-card .chrome .weather',
  mode: 'floorplan-card .chrome .left > :last-child',
  view: 'floorplan-card .chrome .right .icon-btn >> nth=0',
  edit: 'floorplan-card .chrome .right .icon-btn >> nth=-1',
  compass: 'floorplan-card .compass',
  lamp: pct(pieces.lamp),
  dog: pct(pieces.dog),
});

// popups (opened through the card's layer): the first lamp and the first thermostat placed in the plan
const linked = (re) => ev(`return card._config.floors.flatMap((f) => [...(f.furniture ?? []), ...(f.devices ?? [])]).map((x) => x.entity).find((e) => e && ${re}.test(e)) ?? null;`);
for (const [name, entity] of [['licht', await linked('/^light\\./')], ['heizung', await linked('/^climate\\./')]]) {
  if (!entity) continue;
  await ev(`card.ensureLayer().openPopup({ entity: '${entity}' });`);
  await page.waitForTimeout(1000);
  await shot(`popup-${name}`, { sheet: 'floorplan-card-layer .sheet' });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
}
// car overview: the demo car has no integration, so a neutral demo car is linked in the page only
let car = await ev(`return (card._config.floors[0].furniture ?? []).find((f) => f.kind === 'car' && (f.entity || f.entities)) ?? null;`);
const demo = car ? null : demoCar();
if (demo) {
  await fakeStates(page, { ...SCENE, add: demo });
  car = await ev(`const f = (card._config.floors[0].furniture ?? []).find((f) => f.kind === 'car'); return f ? { ...f, entity: 'sensor.demo_car_state_of_charge' } : null;`);
}
if (car) {
  await ev(`card.ensureLayer().openPopup({ car: ${JSON.stringify(car)} });`);
  await page.waitForTimeout(3500); // the car picture is rendered first, the sheet fades in after it
  await shot('popup-auto', { sheet: 'floorplan-card-layer .sheet' });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
}
if (demo) await fakeStates(page, SCENE);

// editor with the dog selected
await ev(`card.openEditor();`);
await page.waitForTimeout(3000);
const E = (body) => page.evaluate(`(() => { const ed = document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui'); ${body} })()`);
const dogId = await E(`return ed.floor.furniture.find((x) => x.kind === 'dog')?.id ?? null;`);
if (dogId) await E(`ed.select({ kind: 'furniture', id: ${JSON.stringify(dogId)} }); return true;`);
await page.waitForTimeout(3500);
const ED = 'floorplan-card-layer floorplan-card-editor-ui';
await shot('editor', {
  toolbar: `${ED} .toolbar`,
  tools: `${ED} .tools`,
  draw: `${ED} [data-tool=draw]`,
  objects: `${ED} [data-panel=furniture]`,
  settings: `${ED} [data-panel=settings]`,
  rules: `${ED} [data-panel=rules]`,
  panel: `${ED} .panel`,
  save: `${ED} .save`,
  dogcard: `${ED} [data-dog-design]`,
});
await state('editor', 'Maße & Lage aufgeklappt', `${ED} .panel details:not([open]) > summary:has-text("Maße")`);
// object library
await page.locator(`${ED} [data-panel=furniture]`).click();
await page.waitForTimeout(1200);
await shot('objekte', { panel: `${ED} .panel`, search: `${ED} .panel input` });
// settings
await page.locator(`${ED} [data-panel=settings]`).click();
await page.waitForTimeout(1200);
await shot('einstellungen', { panel: `${ED} .panel` });
await state('einstellungen', 'Etagen aufgeklappt', `${ED} .panel details:not([open]) > summary:has-text("Etagen")`);
await state('einstellungen', 'Erweitert aufgeklappt', `${ED} .panel details:not([open]) > summary:has-text("Erweitert")`);
// dog editor (back to the dog first)
if (dogId) {
  await E(`ed.select({ kind: 'furniture', id: ${JSON.stringify(dogId)} }); return true;`);
  await page.waitForTimeout(2500);
  await page.locator(`${ED} [data-dog-design]`).click();
  await page.waitForTimeout(5000);
  const DE = 'floorplan-card-layer fp-dog-editor';
  await shot('hunde-editor', { stage: `${DE} .stage`, paint: `${DE} [data-mode=paint]`, poses: `${DE} .brushbar`, panel: `${DE} .panel`, done: `${DE} [data-done]` });
  await page.locator(`${DE} .bar .btn.plain`).click();
  await page.waitForTimeout(500);
}
await E(`ed.shadowRoot.querySelector('.tb-left .btn').click(); return true;`);
await page.waitForTimeout(500);
}

if (GROUPS.includes('mehr')) {
  const SHEET = 'floorplan-card-layer .sheet';
  const popup = async (name, target, wait = 1200) => {
    await ev(`card.ensureLayer().openPopup(${target}); return true;`);
    await page.waitForTimeout(wait);
    await shot(name, { sheet: SHEET });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  };
  // room (living room), vacuum, speaker, list
  await popup('popup-raum', `{ room: card._config.floors[0].rooms.find((r) => r.name === 'Wohnzimmer') ?? card._config.floors[0].rooms[0] }`);
  const vac = await ev(`return Object.keys(card.hass.states).find((e) => e.startsWith('vacuum.')) ?? null;`);
  if (vac) await popup('popup-saugroboter', `{ entity: '${vac}' }`, 2500);
  const media = await ev(`const all = Object.entries(card.hass.states).filter(([e, s]) => e.startsWith('media_player.') && s.state !== 'unavailable'); return (all.find(([e]) => /wohnzimmer|living/.test(e)) ?? all[0])?.[0] ?? null;`);
  if (media) await popup('popup-musik', `{ entity: '${media}' }`);
  const todo = await ev(`return Object.entries(card.hass.states).find(([e, s]) => e.startsWith('todo.') && s.state !== 'unavailable')?.[0] ?? null;`);
  if (todo) await popup('popup-liste', `{ entity: '${todo}' }`, 1800);

  // 2D view (remembered in the test browser only)
  await ev(`card.setForce2d(true); return true;`);
  await page.waitForTimeout(2500);
  await shot('uebersicht-2d', { view: 'floorplan-card .chrome .right .icon-btn >> nth=0', plan: 'floorplan-card fp-plan' });
  await ev(`card.setForce2d(false); return true;`);
  await page.waitForTimeout(1500);

  // Hausregeln: rules panel in the editor (closed without saving)
  await ev(`card.openEditor();`);
  await page.waitForTimeout(3000);
  const ED = 'floorplan-card-layer floorplan-card-editor-ui';
  if (await page.locator(`${ED} [data-panel=rules]`).count()) {
    await page.locator(`${ED} [data-panel=rules]`).click();
    await page.waitForTimeout(2000);
    await shot('editor-regeln', { panel: `${ED} .panel`, rules: `${ED} [data-panel=rules]` });
  }
  const E = (body) => page.evaluate(`(() => { const ed = document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui'); ${body} })()`);
  await E(`ed.shadowRoot.querySelector('.tb-left .btn').click(); return true;`);
  await page.waitForTimeout(800);

  // floors: a three-storey home set in the page only (never saved), slider on the right
  await ev(`return ${SETUP};`);
  await page.waitForTimeout(3500);
  await shot('etagen', { slider: 'floorplan-card fp-floor-slider', stairs: 'floorplan-card fp-plan [data-stairs]' });
}
console.log(JSON.stringify(out, null, 1));
if (pages) {
  for (const r of pages.results) console.error(`page ${r.id}: ${Math.round(r.size / 1024)} KB, ${r.sheets} style sheets, ${r.files} files`);
  await pages.close();
}
console.error(errors.length ? errors.join('\n') : 'page: no errors');
await browser.close();
