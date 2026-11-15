// Light switches count as lamps of their room: a switch named after a light in the room's area (a relay behind a lamp)
// is switched with the room's lights – by its own domain (switch.turn_on), the lamps by light.turn_on; a socket or
// a mode toggle ("Licht Automatik") is no lamp. Mock harness, nothing saved.
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/switch-lights.mjs
import { openMock } from './mock.mjs';

let fails = 0;
const ok = (c, m, extra) => {
  if (!c) fails++;
  console.log(c ? '• ok:' : '• FAIL:', m, !c && extra !== undefined ? JSON.stringify(extra).slice(0, 400) : '');
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const flur = { id: 'r1', name: 'Flur', area: 'flur', points: [[0, 0], [500, 0], [500, 400], [0, 400]] };
const config = { type: 'custom:floorplan-card', card_id: 'switch_lights', height: 'calc(100vh - 16px)', view_mode: '2d', effects: 'off', floors: [{ id: 'f0', name: 'Erdgeschoss', rooms: [flur], devices: [] }] };
const states = {
  'light.flur_decke': { state: 'off', attributes: { friendly_name: 'Flur Decke', supported_color_modes: ['onoff'] } },
  'switch.flur_licht': { state: 'off', attributes: { friendly_name: 'Flur Licht' } },
  'switch.steckdose_flur': { state: 'off', attributes: { friendly_name: 'Steckdose Flur', device_class: 'outlet' } },
  'input_boolean.flur_licht_automatik': { state: 'on', attributes: { friendly_name: 'Flur Licht Automatik' } },
};
const entities = Object.fromEntries(Object.keys(states).map((id) => [id, { entity_id: id, area_id: 'flur' }]));
const areas = { flur: { area_id: 'flur', name: 'Flur' } };
const m = await openMock({ config, states, entities, areas });
await wait(900);
const lights = await m.card(`card.actionHost.roomLights(card.rawConfig.floors[0].rooms[0])`);
ok(lights.includes('light.flur_decke') && lights.includes('switch.flur_licht'), 'the lamp and the light switch are the room\'s lights', lights);
ok(!lights.includes('switch.steckdose_flur') && !lights.includes('input_boolean.flur_licht_automatik'), 'no socket, no mode toggle', lights);

await m.clearCalls();
await m.card(`(card.gesture({ kind: 'room', id: 'r1' }, 'double_tap'), true)`);
await wait(500);
const calls = await m.calls();
ok(calls.some((c) => c.domain === 'switch' && c.service === 'turn_on' && JSON.stringify(c).includes('switch.flur_licht')), 'double tap: the light switch by switch.turn_on', calls);
ok(calls.some((c) => c.domain === 'light' && c.service === 'turn_on' && JSON.stringify(c).includes('light.flur_decke')), '… and the lamp by light.turn_on', calls);
ok(!calls.some((c) => c.domain === 'light' && JSON.stringify(c).includes('switch.')), 'never light.turn_on for a switch', calls);
ok(!m.errors.length, 'no page errors or warnings', m.errors);
await m.browser.close();
console.log(fails ? `\n${fails} FAIL` : '\nall ok');
process.exit(fails ? 1 : 0);
