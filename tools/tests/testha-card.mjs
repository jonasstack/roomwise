// Runs a browser test of the card against the isolated test Home Assistant (127.0.0.1:8124) instead of a real one:
// prepares a dashboard /grundriss-test/grundriss with an empty card and a resource for the card (served from this
// checkout's dist/ by FP_LOCAL), then starts the test with HA_URL/HA_TOKEN of the test HA.
//   node tools/build.mjs && node tools/tests/testha-card.mjs tools/tests/first-run.mjs [outdir] …
// Start the test HA first (hausregeln/tools/testha/start.sh) and hold the lock: sh tools/heavy.sh testha …
import { spawnSync } from 'node:child_process';
import { URL0, token, wsConnect } from '../../hausregeln/tools/testha/lib.mjs';

const [script, ...args] = process.argv.slice(2);
if (!script) throw new Error('usage: node tools/tests/testha-card.mjs <test.mjs> [args…]');
const tok = await token();
const ws = await wsConnect(tok);
const boards = await ws.call({ type: 'lovelace/dashboards/list' });
if (!boards.some((b) => b.url_path === 'grundriss-test'))
  await ws.call({ type: 'lovelace/dashboards/create', url_path: 'grundriss-test', title: 'Grundriss', mode: 'storage', require_admin: false, show_in_sidebar: false });
await ws.call({
  type: 'lovelace/config/save',
  url_path: 'grundriss-test',
  config: { views: [{ title: 'Grundriss', path: 'grundriss', panel: true, cards: [{ type: 'custom:floorplan-card', card_id: 'fp_testha' }] }] },
});
const resources = await ws.call({ type: 'lovelace/resources' });
if (!resources.some((r) => r.url.startsWith('/floorplan_card_files/floorplan-card.js')))
  await ws.call({ type: 'lovelace/resources/create', res_type: 'module', url: '/floorplan_card_files/floorplan-card.js' });
ws.close();
const r = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit', env: { ...process.env, FP_LOCAL: '1', HA_URL: URL0, HA_TOKEN: tok } });
process.exit(r.status ?? 1);
