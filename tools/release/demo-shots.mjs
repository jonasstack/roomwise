// Screenshots for the README and the user guide, made from the demo home (examples/demo.json) on the isolated
// test Home Assistant (127.0.0.1:8124, fake devices) – never from a real home. Sun, weather and a few light states
// are faked in the page only; every service call is intercepted.
//
//   npm run build && (cd hausregeln && node tools/build.mjs)
//   sh tools/heavy.sh testha sh -c 'sh hausregeln/tools/testha/start.sh && node tools/release/demo-shots.mjs [outdir]'
//
// Leaves a dashboard "roomwise-demo" in the test HA (harmless; written again on every run; see demo-setup.mjs).
import { mkdirSync } from 'node:fs';
import { setupDemo } from './demo-setup.mjs';

const OUT = process.argv[2] ?? 'docs/screenshots';
mkdirSync(OUT, { recursive: true });

// demo home on the test HA; points pw.mjs at it
await setupDemo();
const { openHA } = await import('../pw.mjs');
const BLOCK = ['light', 'climate', 'vacuum', 'cover', 'todo', 'media_player', 'fan', 'switch', 'homeassistant', 'scene', 'script', 'lock', 'button', 'notify', 'tts', 'house_rules', 'alarm_control_panel'];
const FIND = `const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } }; const card = find(document);`;

/** fake sun, weather and device states (in this page only) */
async function scene(page, { weather = 'sunny', elevation = 25, azimuth = 200, lights = [], heat = [], open = [], cleaning = false, temp = 14 }) {
  await page.evaluate(([FIND, sc]) => {
    const card = new Function(`${FIND} return card;`)();
    const ha = document.querySelector('home-assistant');
    let d;
    for (let p = Object.getPrototypeOf(card); p && !d; p = Object.getPrototypeOf(p)) d = Object.getOwnPropertyDescriptor(p, 'hass');
    const patch = (h) => {
      const st = { ...h.states };
      const set = (id, state, attributes = {}) => (st[id] = { entity_id: id, last_changed: new Date().toISOString(), last_updated: new Date().toISOString(), context: { id: '' }, ...(st[id] ?? {}), state, attributes: { ...(st[id]?.attributes ?? {}), ...attributes } });
      set('sun.sun', sc.elevation > 0 ? 'above_horizon' : 'below_horizon', { elevation: sc.elevation, azimuth: sc.azimuth, friendly_name: 'Sonne' });
      const weathers = Object.keys(st).filter((id) => id.startsWith('weather.'));
      for (const id of weathers.length ? weathers : ['weather.demo']) set(id, sc.weather, { friendly_name: 'Wetter', temperature: sc.temp, temperature_unit: '°C', humidity: 70, cloud_coverage: sc.weather === 'sunny' ? 8 : 92, wind_speed: 14, wind_bearing: 250, wind_speed_unit: 'km/h' });
      for (const id of Object.keys(st)) {
        if (id.startsWith('light.')) set(id, sc.lights.includes(id) ? 'on' : 'off', sc.lights.includes(id) ? { brightness: 190, color_mode: 'color_temp', color_temp_kelvin: 2700, supported_color_modes: ['color_temp', 'hs'] } : {});
        if (id.startsWith('climate.')) set(id, 'heat', { hvac_action: sc.heat.includes(id) ? 'heating' : 'idle', temperature: sc.heat.includes(id) ? 22 : 20, current_temperature: sc.heat.includes(id) ? 20.5 : 20.5 });
        if (id.startsWith('binary_sensor.') && /fenster|tuer|haustuer/.test(id)) set(id, sc.open.includes(id) ? 'on' : 'off');
      }
      // shorter names than the test instance's fake devices carry
      const NAMES = { 'light.sofalicht': 'Stehlampe', 'climate.heizung_wohnzimmer': 'Heizung Wohnzimmer', 'climate.heizung_kueche': 'Heizung Küche', 'climate.heizung_bad': 'Handtuchheizkörper', 'vacuum.robo': 'Saugroboter', 'media_player.homepod': 'Lautsprecher Wohnzimmer', 'sensor.temp_wohnzimmer': 'Temperatur Wohnzimmer' };
      for (const [id, name] of Object.entries(NAMES)) if (st[id]) st[id] = { ...st[id], attributes: { ...st[id].attributes, friendly_name: name } };
      if (st['vacuum.robo']) set('vacuum.robo', sc.cleaning ? 'cleaning' : 'docked', { battery_level: 87, fan_speed: 'balanced', fan_speed_list: ['quiet', 'balanced', 'turbo', 'max'] });
      if (st['sensor.temp_wohnzimmer']) set('sensor.temp_wohnzimmer', '21.4');
      if (st['sensor.temp_bad']) set('sensor.temp_bad', '22.8');
      if (st['sensor.feuchte_bad']) set('sensor.feuchte_bad', '58');
      return { ...h, states: st };
    };
    Object.defineProperty(card, 'hass', { configurable: true, set(h) { d.set.call(this, patch(h)); }, get() { return d.get.call(this); } });
    card.hass = ha.hass;
  }, [FIND, { weather, elevation, azimuth, lights, heat, open, cleaning, temp }]);
  await page.waitForTimeout(2500);
}

const ev = (page, body) => page.evaluate(`(() => { ${FIND} ${body} })()`);
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png` });
async function popup(page, name, target, wait = 1200) {
  await ev(page, `card.ensureLayer().openPopup(${target}); return true;`);
  await page.waitForTimeout(wait);
  await shot(page, name);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
}
const EVENING = { weather: 'sunny', elevation: 8, azimuth: 255, lights: ['light.sofalicht', 'light.kuechenlicht', 'light.kleines_licht'], heat: ['climate.heizung_wohnzimmer'] };
const DAY = { weather: 'sunny', elevation: 38, azimuth: 190, lights: [], heat: [] };
const NIGHT = { weather: 'clear-night', elevation: -15, azimuth: 300, lights: ['light.sofalicht', 'light.flurlicht', 'light.badlicht'], heat: ['climate.heizung_bad'], temp: 6 };
const errors = [];

for (const scheme of ['light', 'dark']) {
  const { browser, page, errors: e } = await openHA({ size: '1280x800', scheme, block: BLOCK, kiosk: true });
  await page.waitForTimeout(4000);
  if (scheme === 'light') {
    await scene(page, EVENING);
    await shot(page, 'weather-evening-sun-light');
    await scene(page, DAY);
    await shot(page, 'overview-3d-light');
    await scene(page, { ...DAY, weather: 'rainy', elevation: 20, open: ['binary_sensor.fenster_wohnzimmer'], temp: 9 });
    await shot(page, 'weather-rain-light');
    await scene(page, EVENING);
    await popup(page, 'popup-light-light', `{ entity: 'light.sofalicht' }`);
    await popup(page, 'popup-climate-light', `{ entity: 'climate.heizung_wohnzimmer' }`);
    await popup(page, 'popup-room-light', `{ room: card._config.floors[0].rooms[0] }`);
    await ev(page, `card.setForce2d(true); return true;`);
    await page.waitForTimeout(2500);
    await shot(page, 'overview-2d-light');
    await ev(page, `card.setForce2d(false); return true;`);
    await page.waitForTimeout(1500);
  } else {
    await scene(page, NIGHT);
    await shot(page, 'overview-3d-dark');
    await scene(page, { ...NIGHT, cleaning: true });
    await popup(page, 'popup-vacuum-dark', `{ entity: 'vacuum.robo' }`, 2500);
    await popup(page, 'popup-media-dark', `{ entity: 'media_player.homepod' }`);
    await popup(page, 'popup-light-dark', `{ entity: 'light.sofalicht' }`);
  }
  // editor: a room selected, then the object library
  await ev(page, `card.openEditor(); return true;`);
  await page.waitForTimeout(3500);
  const E = (body) => page.evaluate(`(() => { const ed = document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui'); ${body} })()`);
  await E(`ed.select({ kind: 'room', id: 'room_living' }); return true;`);
  await page.waitForTimeout(1500);
  await shot(page, `editor-room-${scheme}`);
  if (scheme === 'light') {
    await page.locator('floorplan-card-layer floorplan-card-editor-ui [data-panel=furniture]').click();
    await page.waitForTimeout(1500);
    await shot(page, 'editor-furniture-light');
  }
  await E(`ed.shadowRoot.querySelector('.tb-left .btn').click(); return true;`);
  await page.waitForTimeout(800);
  errors.push(...e.map((x) => `${scheme}: ${x}`));
  await browser.close();
}
{
  const { browser, page, errors: e } = await openHA({ size: '800x1280', scheme: 'light', block: BLOCK, kiosk: true });
  await page.waitForTimeout(4000);
  await scene(page, EVENING);
  await shot(page, 'portrait-light');
  errors.push(...e.map((x) => `portrait: ${x}`));
  await browser.close();
}
console.log(errors.length ? `console errors:\n  ${errors.join('\n  ')}` : 'console ok');
console.log('screenshots in', OUT);
process.exit(0);
