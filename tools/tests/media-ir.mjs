// Media devices with own buttons (scripts, e.g. for devices only reachable by infrared): a custom button runs
// script.turn_on with its variables, a script set for a slot wins over the media_player's own feature (an empty slot
// uses the entity), a pure infrared piece without any entity opens the same popup without a made-up state, a device
// marker with a plain switch opens it too, and the editor adds / removes inputs and buttons and saves them.
// Mock harness (no Home Assistant, neutral demo home).
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/media-ir.mjs [outDir]
import { openMock, demoHome, demoStates, demoEntities } from './mock.mjs';

const out = process.argv[2];
let fails = 0;
const ok = (c, m) => {
  if (!c) fails++;
  console.log(c ? '• ok:' : '• FAIL:', m);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const cfg = demoHome();
const fl = cfg.floors[0];
// a speaker the entity controls itself; only "next" goes to a script
fl.furniture.push({ id: 'spk', kind: 'speaker', entity: 'media_player.demo_speaker', x: 80, y: 80, w: 14, h: 14, media: { next: { script: 'script.demo_ir_next' } } });
// a TV that only listens to infrared: no entity at all
fl.furniture.push({
  id: 'tv',
  kind: 'tv',
  name: 'Fernseher',
  x: 300,
  y: 20,
  w: 145,
  h: 8,
  media: {
    power: { script: 'script.demo_ir_power' },
    volume_up: { script: 'script.demo_ir_volume', variables: { step: 1 } },
    volume_down: { script: 'script.demo_ir_volume', variables: { step: -1 } },
    sources: [
      { name: 'HDMI 1', script: 'script.demo_ir_input', variables: { input: 'hdmi1' } },
      { name: 'TV', script: 'script.demo_ir_input', variables: { input: 'tv' } },
    ],
    buttons: [{ name: 'Menü', icon: 'mdi:menu', script: 'script.demo_ir_key', variables: { key: 'menu' } }],
  },
});
// "Other": a device marker with a plain switch (smart plug of an amplifier) and an input script
fl.devices.push({ id: 'amp', entity: 'switch.demo_amp', x: 700, y: 100, media: { sources: [{ name: 'Phono', script: 'script.demo_ir_input' }] } });

const states = {
  ...demoStates(),
  // PAUSE | VOLUME_SET | VOLUME_MUTE | PREV | NEXT | TURN_ON | TURN_OFF | SELECT_SOURCE | PLAY
  'media_player.demo_speaker': { state: 'playing', attributes: { friendly_name: 'Lautsprecher', supported_features: 18877, volume_level: 0.3, source_list: ['Radio', 'Line-in'], source: 'Radio', media_title: 'Demo' } },
  'switch.demo_amp': { state: 'on', attributes: { friendly_name: 'Verstärker' } },
  'script.demo_ir_next': { state: 'off', attributes: { friendly_name: 'IR Weiter' } },
  'script.demo_ir_power': { state: 'off', attributes: { friendly_name: 'IR Power' } },
  'script.demo_ir_volume': { state: 'off', attributes: { friendly_name: 'IR Lautstärke' } },
  'script.demo_ir_input': { state: 'off', attributes: { friendly_name: 'IR Eingang' } },
  'script.demo_ir_key': { state: 'off', attributes: { friendly_name: 'IR Taste' } },
};
const m = await openMock({ config: { ...cfg, view_mode: '2d' }, states, entities: demoEntities, size: '1280x900', fake: { companion: true } });
const { page } = m;
const POP = `document.querySelector('floorplan-card-layer').shadowRoot.querySelector('fp-media-player-popup')`;
const inPop = (expr) => page.evaluate(`(() => { const p = ${POP}; const r = p?.shadowRoot; return ${expr}; })()`);
const click = (sel) => inPop(`(r.querySelector(${JSON.stringify(sel)}).click(), true)`);
const scripts = async () => (await m.calls()).filter((c) => c.domain === 'script');
const closeAll = async () => {
  await page.keyboard.press('Escape');
  await wait(500);
};

// 1) native vs script: next → the script, previous / mute → the media_player
await m.card(`(card.gesture({ kind: 'furniture', id: 'spk' }, 'tap'), true)`);
await wait(600);
ok(await inPop('!!r'), 'speaker: tap opens the media popup');
await m.clearCalls();
await click('[aria-label="Nächster Titel"]');
await wait(200);
let c = await m.calls();
ok(c.length === 1 && c[0].domain === 'script' && c[0].service === 'turn_on' && c[0].target?.entity_id === 'script.demo_ir_next', `next: the script wins over the native feature (${JSON.stringify(c.map((x) => `${x.domain}.${x.service}`))})`);
await m.clearCalls();
await click('[aria-label="Vorheriger Titel"]');
await wait(200);
c = await m.calls();
ok(c.length === 1 && c[0].domain === 'media_player' && c[0].service === 'media_previous_track', `previous (no script): the media_player itself (${JSON.stringify(c.map((x) => `${x.domain}.${x.service}`))})`);
ok(await inPop('!!r.querySelector("fp-slider")'), 'volume: native slider stays (no step scripts)');
await m.clearCalls();
await click('[aria-label="Stumm"]');
await wait(200);
c = await m.calls();
ok(c.length === 1 && c[0].service === 'volume_mute' && c[0].data?.is_volume_muted === true, 'mute: native volume_mute');
ok(await inPop('[...r.querySelectorAll(".chips .chip")].map((b) => b.textContent.trim()).join("|") === "Radio|Line-in"'), 'sources: the native list (no own inputs)');
await closeAll();

// 2) pure infrared TV: same layout, no made-up state, custom button with variables
await m.card(`(card.gesture({ kind: 'furniture', id: 'tv' }, 'tap'), true)`);
await wait(600);
ok(await inPop('!!r'), 'IR TV without an entity: tap opens the media popup');
const head = await inPop('[r.querySelector(".head-title")?.textContent.trim(), r.querySelector(".head-sub")?.textContent.trim()]');
ok(head?.[0] === 'Fernseher' && head?.[1] === 'Fernbedienung', `head: its name, "Fernbedienung" instead of a state (${JSON.stringify(head)})`);
ok(await inPop('!r.querySelector(".now") && !r.querySelector(".tile.on") && !r.querySelector(".icon-btn.accent")'), 'no now-playing block, nothing shown as on');
ok(await inPop('[...r.querySelectorAll(".chips .chip")].every((b) => !b.hasAttribute("aria-pressed"))'), 'inputs: no chip claims to be the active one');
if (out) await page.screenshot({ path: `${out}/media-ir-popup.png` });
await m.clearCalls();
await click('.head [aria-label="Ein/Aus"]');
await click('[aria-label="Lauter"]');
await inPop('([...r.querySelectorAll(".chips .chip")].find((b) => b.textContent.trim() === "HDMI 1").click(), true)');
await click('.own-btn[aria-label="Menü"]');
await wait(300);
c = await scripts();
const want = [
  ['script.demo_ir_power', {}],
  ['script.demo_ir_volume', { variables: { step: 1 } }],
  ['script.demo_ir_input', { variables: { input: 'hdmi1' } }],
  ['script.demo_ir_key', { variables: { key: 'menu' } }],
];
ok(c.length === 4 && want.every(([id, data], i) => c[i].service === 'turn_on' && c[i].target?.entity_id === id && JSON.stringify(c[i].data) === JSON.stringify(data)), `power, volume up, input, custom button → script.turn_on with the right script and variables (${JSON.stringify(c.map((x) => [x.target?.entity_id, x.data]))})`);
ok((await m.calls()).length === 4, 'nothing else was called');
ok(await inPop('r.querySelector("[aria-label=\'Vorheriger Titel\']") === null'), 'no transport row without any playback command');
await closeAll();

// 3) device marker with a plain switch: the media popup with its known state, power falls back to the switch
await m.card(`(card.gesture({ kind: 'device', id: 'amp' }, 'tap'), true)`);
await wait(600);
ok(await inPop('!!r'), 'switch device with own inputs: tap opens the media popup');
await m.clearCalls();
await click('.head [aria-label="Ausschalten"]');
await wait(200);
c = await m.calls();
ok(c.length === 1 && c[0].domain === 'homeassistant' && c[0].service === 'turn_off' && c[0].target?.entity_id === 'switch.demo_amp', `power (no script): the switch itself (${JSON.stringify(c.map((x) => `${x.domain}.${x.service}`))})`);
await closeAll();

// 4) editor: add / remove inputs and buttons, a script for a slot, saved into the dashboard
const ED = `document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui')`;
await m.card(`(card.openEditor(), true)`);
await wait(2000);
const ed = (expr) => page.evaluate(`(() => { const ed = ${ED}; const r = ed.shadowRoot; return ${expr}; })()`);
await ed(`(ed.select({ kind: 'furniture', id: 'tv' }), true)`);
await wait(400);
ok(await ed('!!r.querySelector("[data-media-slots]")'), 'TV inspector: own media buttons section');
await ed(`(r.querySelector('[data-media-add-input]').click(), true)`);
await wait(200);
await ed(`(r.querySelector('[data-media-add-button]').click(), true)`);
await wait(200);
const tvDraft = () => ed(`ed._draft.floors[0].furniture.find((x) => x.id === 'tv').media`);
let md = await tvDraft();
ok(md.sources.length === 3 && md.sources[2].name === 'Eingang 3' && md.buttons.length === 2 && md.buttons[1].name === 'Taste 2', `added an input and a button (${md.sources.length} / ${md.buttons.length})`);
// remove the first input, move the new button up
await ed(`(r.querySelector('[data-media-input="0"] [data-media-remove]').click(), true)`);
await wait(200);
await ed(`(r.querySelector('[data-media-button="1"] [aria-label="Nach oben"]').click(), true)`);
await wait(200);
md = await tvDraft();
ok(md.sources.map((s) => s.name).join('|') === 'TV|Eingang 3' && md.buttons.map((b) => b.name).join('|') === 'Taste 2|Menü', `removed / reordered (${md.sources.map((s) => s.name)} · ${md.buttons.map((b) => b.name)})`);
// a script for "mute" through the entity picker
await ed(`([...r.querySelectorAll('[data-media-slots] .pick')].find((b) => b.textContent.includes('Stumm')).click(), true)`);
await wait(500);
const picked = await ed(`(() => { const l = r.querySelector('fp-entity-list')?.shadowRoot; const row = l?.querySelector('.row[data-entity="script.demo_ir_key"]'); row?.click(); return !!row; })()`);
await wait(400);
md = await tvDraft();
ok(picked && md.mute?.script === 'script.demo_ir_key', `mute: script chosen in the picker (${JSON.stringify(md.mute)})`);
if (out) await page.screenshot({ path: `${out}/media-ir-editor.png` });
await ed(`(r.querySelector('.save').click(), true)`);
await wait(1200);
const saved = (await m.fake()).dash.views[0].cards[0].floors[0];
const sm = saved.furniture.find((x) => x.id === 'tv')?.media;
ok(sm?.sources?.length === 2 && sm.buttons?.length === 2 && sm.mute?.script === 'script.demo_ir_key' && sm.power?.script === 'script.demo_ir_power', `saved into the dashboard config (${JSON.stringify(sm)})`);
ok(saved.devices.find((d) => d.id === 'amp')?.media?.sources?.[0]?.name === 'Phono', 'the device marker keeps its inputs');

const errs = m.errors.filter((e) => !/favicon|404/.test(e));
ok(!errs.length, `no console errors (${errs.slice(0, 3).join(' | ')})`);
await m.browser.close();
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
