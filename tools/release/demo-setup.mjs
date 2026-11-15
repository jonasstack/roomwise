// The demo home (examples/demo.json) as dashboard "roomwise-demo" on the isolated test Home Assistant
// (127.0.0.1:8124, fake devices) – never a real home. Used by the screenshot scripts (demo-shots.mjs for README and
// user guide, tools/design/doku-screens.mjs for the doku). Waits for the test HA, logs in (lib.mjs onboards a fresh
// instance on its own), sets up Hausregeln, the areas, the card resource and the dashboard, then points tools/pw.mjs
// at it (HA_URL, HA_TOKEN, FP_LOCAL, FP_DASHBOARD). Harmless to run again: the dashboard is written anew each time.
import { readFileSync } from 'node:fs';
import { token, wsConnect, rest, URL0 } from '../../hausregeln/tools/testha/lib.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function setupDemo() {
  // --- wait for the test HA, log in
  for (let i = 0; i < 90; i++) {
    const up = await fetch(URL0 + '/api/').then((r) => r.status).catch(() => 0);
    if (up === 401 || up === 200) break;
    await sleep(2000);
  }
  const tok = await token();
  const api = rest(tok);
  // fully started (else the page shows "Home Assistant has started" and integrations still load)
  for (let i = 0; i < 90 && (await api('GET', '/api/config')).body?.state !== 'RUNNING'; i++) await sleep(2000);
  // Hausregeln set up (as after the one-click config flow), so the card shows house mode and alarm
  const entries = await api('GET', '/api/config/config_entries/entry');
  if (!entries.body.some?.((e) => e.domain === 'house_rules')) {
    const flow = await api('POST', '/api/config/config_entries/flow', { handler: 'house_rules' });
    if (flow.body.flow_id) await api('POST', `/api/config/config_entries/flow/${flow.body.flow_id}`, {});
    await sleep(3000);
  }
  const ws = await wsConnect(tok);
  const r = async (msg) => ws.call(msg);

  // --- areas of the demo home, card resource (answered from dist/ by the test browser), dashboard
  const demo = JSON.parse(readFileSync(new URL('../../examples/demo.json', import.meta.url), 'utf8'));
  const areas = await r({ type: 'config/area_registry/list' });
  for (const room of demo.floors[0].rooms.filter((x) => x.area)) {
    if (!areas.some((a) => a.area_id === room.area || a.name.toLowerCase() === room.name.toLowerCase())) await r({ type: 'config/area_registry/create', name: room.name }).catch(() => {});
  }
  const res = await r({ type: 'lovelace/resources' });
  if (!res.some((x) => x.url.startsWith('/floorplan_card_files/'))) await r({ type: 'lovelace/resources/create', res_type: 'module', url: '/floorplan_card_files/floorplan-card.js' });
  const dashes = await r({ type: 'lovelace/dashboards/list' });
  if (!dashes.some((d) => d.url_path === 'roomwise-demo')) await r({ type: 'lovelace/dashboards/create', url_path: 'roomwise-demo', title: 'roomwise', icon: 'mdi:floor-plan', show_in_sidebar: false, require_admin: false, mode: 'storage' });
  await r({ type: 'lovelace/config/save', url_path: 'roomwise-demo', config: { views: [{ title: 'Plan', path: 'plan', panel: true, cards: [{ ...demo, height: 'calc(100vh - 56px)' }] }] } });
  ws.close?.();

  // --- browser: pw.mjs reads the target from the environment
  process.env.HA_URL = URL0;
  process.env.HA_TOKEN = tok;
  process.env.FP_LOCAL = '1';
  process.env.FP_DASHBOARD = '/roomwise-demo/plan';
  process.env.PW_LOCALE ??= 'de-DE'; // the interface is German first; set PW_LOCALE=en-US for English shots
  return { url: URL0, token: tok, path: '/roomwise-demo/plan' };
}
