// Atmosphere at different times of day / weather. Sun, weather and (at night) living room lights are
// faked inside the page only — nothing in HA is changed.
import { openHA } from '../pw.mjs';
const out = process.argv[2] ?? '/tmp';
const scheme = process.argv[3] ?? 'light';
const { browser, page, errors } = await openHA({ size: '1280x800', scheme, kiosk: true, block: ['light', 'switch'] });
const FIND = `const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } };`;
await page.evaluate(`(() => { ${FIND} const card = find(document);
  let real = card._hass;
  window.__fpOverride = {};
  Object.defineProperty(card, '_hass', {
    configurable: true,
    get() { const o = window.__fpOverride; if (!real) return real; return { ...real, states: { ...real.states, ...o } }; },
    set(v) { real = v; },
  });
  window.__fpCard = card;
})()`);
const scenes = [
  ['day', { elevation: 48, azimuth: 190 }, { state: 'sunny', cloud_coverage: 5 }],
  ['golden', { elevation: 4, azimuth: 255 }, { state: 'sunny', cloud_coverage: 10 }],
  ['sunset', { elevation: -2.5, azimuth: 290 }, { state: 'partlycloudy', cloud_coverage: 35 }],
  ['night', { elevation: -28, azimuth: 340 }, { state: 'clear-night', cloud_coverage: 0 }],
  ['cloudy', { elevation: 30, azimuth: 160 }, { state: 'rainy', cloud_coverage: 95 }],
];
for (const [name, sun, w] of scenes) {
  await page.evaluate(([sun, w, name]) => {
    const card = window.__fpCard;
    const real = Object.getOwnPropertyDescriptor(card, '_hass').get.call({});
    const states = document.querySelector('home-assistant').hass.states;
    const wid = card._config.weather ?? Object.keys(states).find((e) => e.startsWith('weather.'));
    const o = {
      'sun.sun': { entity_id: 'sun.sun', state: sun.elevation > 0 ? 'above_horizon' : 'below_horizon', attributes: { ...sun }, last_changed: '', last_updated: '', context: {} },
    };
    if (wid) o[wid] = { ...states[wid], state: w.state, attributes: { ...states[wid].attributes, cloud_coverage: w.cloud_coverage } };
    if (name === 'night') {
      const plan = card.shadowRoot.querySelector('fp-plan');
      const room = card._config.floors[0].rooms.find((r) => r.name === 'Wohnzimmer');
      for (const id of plan.roomLights(room)) o[id] = { ...states[id], state: 'on', attributes: { ...states[id].attributes, brightness: 220 } };
    }
    window.__fpOverride = o;
    card._tick++; // a redraw: changes of other entities do not redraw the plan
  }, [sun, w, name]);
  await page.waitForTimeout(1600);
  await page.screenshot({ path: `${out}/atmo-${name}-${scheme}.png` });
  console.log('• shot', name);
}
console.log(errors.length ? errors.join('\n') : 'console: keine Fehler/Warnungen');
await browser.close();
