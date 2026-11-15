// Dumps registries + states into tools/.cache/inventory.json and prints a summary.
import { connect } from './ha.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
const ha = await connect();
const [entities, devices, areas, floors, states] = await Promise.all([
  ha.call({ type: 'config/entity_registry/list' }),
  ha.call({ type: 'config/device_registry/list' }),
  ha.call({ type: 'config/area_registry/list' }),
  ha.call({ type: 'config/floor_registry/list' }),
  ha.call({ type: 'get_states' }),
]);
ha.close();
mkdirSync(new URL('./.cache/', import.meta.url), { recursive: true });
writeFileSync(new URL('./.cache/inventory.json', import.meta.url), JSON.stringify({ entities, devices, areas, floors, states }));
const devArea = Object.fromEntries(devices.map((d) => [d.id, d.area_id]));
const areaName = Object.fromEntries(areas.map((a) => [a.area_id, a.name]));
const reg = Object.fromEntries(entities.map((e) => [e.entity_id, e]));
const byDomain = {}, byArea = {};
for (const s of states) {
  const dom = s.entity_id.split('.')[0];
  byDomain[dom] = (byDomain[dom] || 0) + 1;
  const e = reg[s.entity_id];
  const a = areaName[e?.area_id || devArea[e?.device_id]] || '(ohne Area)';
  (byArea[a] ||= {})[dom] = (byArea[a][dom] || 0) + 1;
}
console.log(`states=${states.length} entities=${entities.length} devices=${devices.length} areas=${areas.length} floors=${floors.length}`);
console.log('Areas:', areas.map((a) => `${a.name} [${a.area_id}] floor=${a.floor_id}`).join(' | '));
console.log('By domain:', Object.entries(byDomain).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '));
const interesting = ['light', 'climate', 'vacuum', 'cover', 'media_player', 'todo', 'fan', 'switch'];
for (const [a, d] of Object.entries(byArea)) console.log(`  ${a}: ` + interesting.filter((k) => d[k]).map((k) => `${k}:${d[k]}`).join(' ') + `  (total ${Object.values(d).reduce((x, y) => x + y, 0)})`);
for (const dom of ['light', 'climate', 'vacuum', 'cover', 'todo', 'media_player']) {
  console.log(`\n# ${dom}`);
  for (const s of states.filter((s) => s.entity_id.startsWith(dom + '.'))) {
    const e = reg[s.entity_id];
    console.log(`  ${s.entity_id} = ${s.state}  "${s.attributes.friendly_name}"  area=${areaName[e?.area_id || devArea[e?.device_id]] || '-'}`);
  }
}
