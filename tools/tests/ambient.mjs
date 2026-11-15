// Screenshots of sun/weather effects with simulated sun + weather states (only inside the browser page).
import { openHA } from '../pw.mjs';
const out = process.argv[2] ?? '/tmp';
const scheme = process.argv[3] ?? 'light';
const cases = (process.argv[4] ?? 'sunny,partlycloudy,rainy,snowy,fog,lightning-rainy,golden').split(',');
const { browser, page, errors } = await openHA({ scheme, size: '1280x800', block: ['light', 'climate', 'vacuum', 'cover', 'todo', 'media_player', 'fan', 'switch'] });
for (const c of cases) {
  await page.evaluate((c) => {
    const find = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.tagName === 'FLOORPLAN-CARD') return el;
        if (el.shadowRoot) {
          const f = find(el.shadowRoot);
          if (f) return f;
        }
      }
    };
    const card = find(document);
    const golden = c === 'golden';
    const fake = (states) => ({
      ...states,
      'sun.sun': { ...states['sun.sun'], state: 'above_horizon', attributes: { ...states['sun.sun'].attributes, elevation: golden ? 6 : 38, azimuth: golden ? 255 : 195 } },
      'weather.forecast_home': {
        ...states['weather.forecast_home'],
        state: golden ? 'sunny' : c,
        attributes: { ...states['weather.forecast_home'].attributes, cloud_coverage: { sunny: 5, partlycloudy: 45, rainy: 90, snowy: 95, fog: 80, 'lightning-rainy': 95 }[c] ?? 5, temperature: c === 'snowy' ? -2 : 18, wind_speed: 22, wind_bearing: 250 },
      },
    });
    if (!card.__fpOrig) {
      const proto = Object.getPrototypeOf(card);
      const desc = Object.getOwnPropertyDescriptor(proto, 'hass');
      card.__fpOrig = desc;
      Object.defineProperty(card, 'hass', {
        configurable: true,
        get() { return desc.get.call(this); },
        set(h) { desc.set.call(this, { ...h, states: this.__fake(h.states) }); },
      });
    }
    card.__fake = fake;
    card.hass = document.querySelector('home-assistant').hass;
  }, c);
  await page.waitForTimeout(1600);
  await page.screenshot({ path: `${out}/amb-${c}-${scheme}.png` });
}
console.log(errors.length ? errors.join('\n') : 'console: keine Fehler/Warnungen');
await browser.close();
