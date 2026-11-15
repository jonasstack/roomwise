// First run: a card with no floor plan (minimal YAML and getStubConfig) shows the welcome panel with three paths
// (draw, from Home Assistant's areas, an example) and Hausregeln's assistant when it is installed; each path opens
// the editor (areas / example as an unsaved draft); the editor's short tour starts once per user, can be skipped
// and is remembered. The config is replaced inside the test page only — nothing is saved, the editor is closed
// without saving, all service calls are intercepted.
//   FP_LOCAL=1 node tools/tests/first-run.mjs [outdir] [light|dark] [lang]
//   against the isolated test HA: node tools/tests/testha-card.mjs tools/tests/first-run.mjs [outdir] …
import { openHA } from '../pw.mjs';
const out = process.argv[2] ?? '/tmp';
const scheme = process.argv[3] ?? 'light';
const lang = process.argv[4];
const { browser, page, errors } = await openHA({ scheme, block: ['light', 'switch', 'climate', 'cover', 'lock', 'button', 'vacuum', 'media_player', 'tts', 'notify', 'script', 'automation', 'scene', 'homeassistant'] });
const findCard = `(() => {
  const find = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.tagName === 'FLOORPLAN-CARD') return el;
      if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; }
    }
  };
  return find(document);
})()`;
const fail = [];
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) fail.push(msg);
};

// optional: show the card in another language (every hass the dashboard hands over is patched, in this page only)
if (lang)
  await page.evaluate(([lang, sel]) => {
    const card = eval(sel);
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(card), 'hass');
    const patch = (h) => ({ ...h, language: lang, locale: { ...(h.locale ?? {}), language: lang } });
    Object.defineProperty(card, 'hass', { configurable: true, get: () => card._hass, set: (h) => desc.set.call(card, patch(h)) });
    card.hass = card._hass;
  }, [lang, findCard]);

// 1. minimal YAML: just the type
await page.evaluate((sel) => eval(sel).setConfig({ type: 'custom:floorplan-card', card_id: 'fp_firstrun' }), findCard);
await page.waitForTimeout(600);
let info = await page.evaluate((sel) => {
  const card = eval(sel);
  const ob = card.shadowRoot.querySelector('.onboard');
  return {
    onboard: !!ob,
    title: ob?.querySelector('.onboard-title')?.textContent.trim(),
    button: ob?.querySelector('.onboard-start')?.textContent.trim(),
    tip: ob?.querySelector('.onboard-tip')?.textContent.trim(),
    pencil: !!card.shadowRoot.querySelector('.chrome .right [aria-label]'),
  };
}, findCard);
console.log(JSON.stringify(info));
check(info.onboard, 'minimal config shows the welcome panel');
check(!!info.button, 'admin sees the "draw floor plan" button');
const paths = await page.evaluate((sel) => {
  const card = eval(sel);
  const one = (c) => {
    const b = card.shadowRoot.querySelector(`.onboard-${c}`);
    return b ? { title: b.querySelector('.title')?.textContent.trim(), disabled: b.disabled } : null;
  };
  return { start: one('start'), areas: one('areas'), example: one('example'), hr: one('hr'), areasHa: Object.keys(card._hass.areas ?? {}).length, hrOn: !!card.hrLink?.available };
}, findCard);
console.log(JSON.stringify(paths));
check(paths.start && paths.areas && paths.example, 'three paths: draw, from Home Assistant, example');
check(!!paths.areas?.disabled === !paths.areasHa, '"from Home Assistant" only with areas');
check(!!paths.hr === paths.hrOn, 'Hausregeln assistant offered exactly when Hausregeln is installed');
await page.screenshot({ path: `${out}/first-run-${scheme}${lang ? '-' + lang : ''}.png` });

// the tour is remembered per user: start as a user who has not seen it yet
const resetTour = () =>
  page.evaluate(async (sel) => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('fp-tour-')) localStorage.removeItem(k);
    await eval(sel)._hass.callWS({ type: 'frontend/set_user_data', key: 'roomwise_editor_tour', value: null });
  }, findCard);
await resetTour();
const editorState = () =>
  page.evaluate(() => {
    const layer = document.querySelector('floorplan-card-layer');
    const ed = layer?.shadowRoot?.querySelector('floorplan-card-editor-ui');
    const tour = ed?.shadowRoot?.querySelector('fp-editor-tour');
    return {
      open: !!layer?._editor,
      rooms: ed?._draft?.floors.reduce((n, f) => n + f.rooms.length, 0),
      floors: ed?._draft?.floors.length,
      dirty: !!ed?.dirty,
      cardId: ed?._draft?.card_id,
      tour: tour ? (tour.shadowRoot.querySelector('.title')?.textContent.trim() ?? '') : null,
      toast: layer?._toast?.text,
    };
  });
const tourClick = (cls) =>
  page.evaluate((cls) => document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui').shadowRoot.querySelector('fp-editor-tour').shadowRoot.querySelector(`.${cls}`).click(), cls);
const closeEditor = async () => {
  await page.evaluate(() => document.querySelector('floorplan-card-layer').closeEditor());
  await page.waitForTimeout(500);
};
const click = async (cls) => {
  await page.evaluate(([sel, cls]) => eval(sel).shadowRoot.querySelector(`.onboard-${cls}`).click(), [findCard, cls]);
  await page.waitForTimeout(1500);
};

// 2. "draw": opens the editor (portal layer) on the empty plan, the tour starts; closed again — never saved
await click('start');
let ed = await editorState();
check(ed.open, 'button opens the editor');
check(ed.tour !== null, `the tour starts on the first visit (${ed.tour})`);
await page.screenshot({ path: `${out}/first-run-editor-${scheme}${lang ? '-' + lang : ''}.png` });
let steps = 1;
for (let i = 0; i < 10 && (await editorState()).tour !== null; i++) {
  if (i === 1) await page.screenshot({ path: `${out}/first-run-tour-${scheme}${lang ? '-' + lang : ''}.png` });
  await tourClick('next');
  await page.waitForTimeout(300);
  if ((await editorState()).tour !== null) steps++;
}
check(steps === 5 && (await editorState()).tour === null, `tour walks through 5 tools and ends (${steps})`);
await closeEditor();
check(await page.evaluate(() => !document.querySelector('floorplan-card-layer')?._editor), 'editor closed again (not saved)');
await click('start');
check((await editorState()).tour === null, 'the tour is remembered (not again)');
await closeEditor();

// 3. "example": the editor opens with the demo flat as an unsaved draft; Skip ends the tour at once
await resetTour();
await click('example');
ed = await editorState();
check(ed.open && ed.rooms === 6 && ed.dirty && ed.cardId === 'fp_firstrun', `example: 6 rooms in the draft, unsaved, card id kept (${JSON.stringify(ed)})`);
check(!!ed.toast, 'example: a hint says that only Save keeps it');
check(ed.tour !== null, 'the tour starts with the example too');
await tourClick('skip');
await page.waitForTimeout(300);
check((await editorState()).tour === null, 'Skip ends the tour');
await page.screenshot({ path: `${out}/first-run-example-${scheme}${lang ? '-' + lang : ''}.png` });
await closeEditor();

// 4. "from Home Assistant": one rectangle per area, one floor per HA floor
if (paths.areasHa) {
  const expect = await page.evaluate((sel) => {
    const h = eval(sel)._hass;
    const areas = Object.values(h.areas);
    const floors = new Set(areas.map((a) => a.floor_id).filter((f) => f && h.floors?.[f]));
    return { rooms: areas.length, floors: Math.max(1, floors.size) };
  }, findCard);
  await click('areas');
  ed = await editorState();
  check(ed.open && ed.rooms === expect.rooms && ed.floors === expect.floors && ed.dirty, `areas: ${ed.rooms} rooms on ${ed.floors} floor(s) (expected ${JSON.stringify(expect)})`);
  await page.screenshot({ path: `${out}/first-run-areas-${scheme}${lang ? '-' + lang : ''}.png` });
  await closeEditor();
}

// 5. Hausregeln's assistant: a link to /hausregeln/setup
if (paths.hr) {
  await click('hr');
  check((await page.evaluate(() => location.pathname)) === '/hausregeln/setup', 'Hausregeln link opens its setup assistant');
  await page.screenshot({ path: `${out}/first-run-hr-setup-${scheme}${lang ? '-' + lang : ''}.png` });
  await page.goBack();
  await page.waitForSelector('floorplan-card', { timeout: 15000 });
  await page.waitForTimeout(1500);
  await page.evaluate((sel) => eval(sel).setConfig({ type: 'custom:floorplan-card', card_id: 'fp_firstrun' }), findCard);
  await page.waitForTimeout(600);
}

// 3. getStubConfig (what the card picker inserts): sensible, renders without errors
const stub = await page.evaluate((sel) => {
  const card = eval(sel);
  const cfg = card.constructor.getStubConfig(card._hass);
  card.setConfig(cfg);
  return { floors: cfg.floors.length, name: cfg.floors[0].name, rooms: cfg.floors[0].rooms.length, card_id: !!cfg.card_id, areas: Object.keys(card._hass.areas ?? {}).length };
}, findCard);
await page.waitForTimeout(1500);
console.log(JSON.stringify(stub));
check(stub.card_id && stub.floors === 1, 'stub config has a card_id and one floor');
check(stub.rooms === Math.min(8, stub.areas), 'stub config: one room per area (max 8)');
info = await page.evaluate((sel) => !!eval(sel).shadowRoot.querySelector('.onboard'), findCard);
check(!info || stub.rooms === 0, 'no welcome panel once rooms exist');
await page.screenshot({ path: `${out}/first-run-stub-${scheme}${lang ? '-' + lang : ''}.png` });

// 4. stub without areas (a fresh HA) → empty floor → welcome panel
await page.evaluate((sel) => {
  const card = eval(sel);
  card.setConfig(card.constructor.getStubConfig({ ...card._hass, areas: {} }));
}, findCard);
await page.waitForTimeout(600);
info = await page.evaluate((sel) => !!eval(sel).shadowRoot.querySelector('.onboard'), findCard);
check(info, 'stub without areas shows the welcome panel');

check(errors.length === 0, `no console errors (${errors.length})`);
for (const e of errors) console.log('  ', e);
await browser.close();
console.log(fail.length ? `FAILED: ${fail.length}` : 'all ok');
process.exit(fail.length ? 1 : 0);
