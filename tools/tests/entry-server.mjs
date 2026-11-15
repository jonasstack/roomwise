// What the card hands to the companion integration for the front door warning, built from the real card
// config (read-only: nothing is sent to the server).
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { openHA } from '../pw.mjs';
const out = process.argv[2] ?? '/tmp';
execSync(`npx esbuild src/entry-server.ts --bundle --format=iife --global-name=FPES --outfile=${out}/fpes.js --log-level=error`, { stdio: 'inherit' });
const { browser, page, errors } = await openHA({ size: '1280x800', kiosk: true, block: ['light', 'tts'] });
const ok = (c, m) => console.log(c ? '  ok:' : '• FAIL:', m);
await page.addScriptTag({ content: readFileSync(`${out}/fpes.js`, 'utf8') });
const FIND = `const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } };`;
const sc = await page.evaluate(`(async () => { ${FIND} const card = find(document); const hass = document.querySelector('home-assistant').hass; 
  // a plan without its own warning gets one in the page only: the first door with a sensor, a button to acknowledge, one lamp
  const cfg = card.rawConfig.entry_alert?.door ? card.rawConfig : { ...card.rawConfig, entry_alert: { door: card.rawConfig.floors[0].openings.find((o) => o.type === 'door' && o.entity).id, ack_entity: 'input_button.klingel', flash_lights: [card.rawConfig.floors[0].furniture.find((f) => f.entity?.startsWith('light.')).entity], tts_entity: Object.keys(hass.states).find((e) => e.startsWith('tts.')) } };
  return { ...(await FPES.serverConfig(hass, cfg)), ack_want: cfg.entry_alert.ack_entity }; })()`);
ok(sc && sc.door?.startsWith('binary_sensor.'), `front door: ${sc?.door}`);
ok(sc.windows.length >= 1 && sc.windows.every((w) => w.e && w.n), `windows in checking order: ${sc.windows.map((w) => w.n).join(', ')}`);
ok(sc.ack_entity === sc.ack_want, `acknowledged by the switch (${sc.ack_entity})`);
ok(sc.texts.general && sc.texts.all.includes('{fenster}') && sc.texts.single.includes('{fenster}'), 'texts with placeholders');
ok(sc.flash_color.length + sc.flash_plain.length === 1, `lights to flash: ${[...sc.flash_color, ...sc.flash_plain].join(', ')}`);
// the language is only looked up when there is something to speak with (a TTS entity)
if (sc.tts_entity) ok(typeof sc.language === 'string' && sc.language.length >= 2, `TTS language resolved (${sc.language})`);
else ok(sc.language === undefined, 'no TTS entity: nothing to speak, no language looked up');
const none = await page.evaluate(`(async () => { const hass = document.querySelector('home-assistant').hass; return [await FPES.companion(hass), FPES.serverActive(hass, { entry_alert: { server: true } })]; })()`);
ok(!none[0] && none[1] === false, 'without the companion integration the cards keep warning themselves');
console.log(errors.length ? errors.join('\n') : 'console: keine Fehler/Warnungen');
await browser.close();
