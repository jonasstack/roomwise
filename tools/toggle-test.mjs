// Safe toggle test: snapshot -> off -> verify -> restore exact attributes -> verify.
import { connect } from './ha.mjs';
const id = process.argv[2];
const ha = await connect();
const get = async () => (await ha.call({ type: 'get_states' })).find((s) => s.entity_id === id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const before = await get();
const pick = ({ brightness, color_mode, color_temp_kelvin, hs_color, rgbw_color, rgbww_color, effect }) =>
  ({ brightness, color_mode, color_temp_kelvin, hs_color, rgbw_color, rgbww_color, effect });
console.log('vorher :', before.state, JSON.stringify(pick(before.attributes)));
let events = 0;
await ha.subscribe({ type: 'subscribe_trigger', trigger: { platform: 'state', entity_id: id } }, () => events++);
const t0 = Date.now();
await ha.call({ type: 'call_service', domain: 'light', service: 'turn_off', target: { entity_id: id } });
await sleep(2500);
console.log('aus    :', (await get()).state, `(${Date.now() - t0} ms)`);
const a = before.attributes;
const data = { brightness: a.brightness };
if (a.color_mode === 'color_temp') data.color_temp_kelvin = a.color_temp_kelvin;
else if (a.color_mode === 'rgbw') data.rgbw_color = a.rgbw_color;
else if (a.color_mode === 'rgbww') data.rgbww_color = a.rgbww_color;
else if (a.hs_color) data.hs_color = a.hs_color;
if (before.state === 'on') await ha.call({ type: 'call_service', domain: 'light', service: 'turn_on', target: { entity_id: id }, service_data: data });
await sleep(2500);
const after = await get();
console.log('nachher:', after.state, JSON.stringify(pick(after.attributes)));
console.log('Live-Events über Websocket empfangen:', events);
ha.close();
