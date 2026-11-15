// Build -> copy to <config>/www/floorplan-card/ -> point the Lovelace resource at it with a content-hash cache buster.
// Only ever touches the resource whose URL starts with /local/floorplan-card/.
// Needs the path of your Home Assistant config folder: HA_CONFIG_DIR in the environment or in .env
// (or FP_WWW_DIR / FP_CC_DIR for the two target folders), plus HA_URL and HA_TOKEN.
import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { connect, loadEnv } from './ha.mjs';
import { syncChunks } from './build.mjs';

const { configDir } = loadEnv();
const WWW_DIR = process.env.FP_WWW_DIR || (configDir && `${configDir}/www/floorplan-card`);
if (!WWW_DIR) {
  console.error('Set HA_CONFIG_DIR (the folder that holds configuration.yaml) in the environment or in .env.');
  process.exit(1);
}
mkdirSync(WWW_DIR, { recursive: true });
const BASE = '/local/floorplan-card/floorplan-card.js';

if (!process.argv.includes('--no-build')) execSync('node tools/build.mjs', { stdio: 'inherit' });
const file = 'dist/floorplan-card.js';
const hash = createHash('sha1').update(readFileSync(file)).digest('hex').slice(0, 10);
copyFileSync(file, `${WWW_DIR}/floorplan-card.js`);
// the lazily loaded chunks (editor, 3D scene …) lie next to it; old ones stay a few days for pages still open
syncChunks(`${WWW_DIR}/chunks`);
// models (only copied when changed)
import { cpSync, existsSync, statSync } from 'node:fs';
if (existsSync('dist/models')) cpSync('dist/models', `${WWW_DIR}/models`, { recursive: true, filter: (src) => { try { const dst = src.replace('dist/models', `${WWW_DIR}/models`); return !existsSync(dst) || statSync(dst).size !== statSync(src).size || statSync(src).isDirectory(); } catch { return true; } } });
const url = `${BASE}?v=${hash}`;
// the companion integration carries the card too: keep its copy current
const CC = process.env.FP_CC_DIR || (configDir ? `${configDir}/custom_components/floorplan_card` : '');
if (CC && existsSync(CC)) {
  syncChunks(`${CC}/frontend/chunks`);
  cpSync('custom_components/floorplan_card/frontend', `${CC}/frontend`, { recursive: true });
}

const ha = await connect();
try {
  // once the companion is running it loads the card on every dashboard: our own resource then goes away
  const info = await ha.call({ type: 'floorplan_card/info' }).catch(() => undefined);
  if (info?.loaded) {
    const res = await ha.call({ type: 'lovelace/resources' });
    for (const r of res.filter((x) => x.url.startsWith('/local/floorplan-card/'))) {
      await ha.call({ type: 'lovelace/resources/delete', resource_id: r.id });
      console.log('resource removed (the companion integration serves the card):', r.url);
    }
    console.log('card updated in', `${CC}/frontend`);
    process.exit(0);
  }
  const resources = await ha.call({ type: 'lovelace/resources' });
  const mine = resources.filter((r) => r.url.startsWith('/local/floorplan-card/'));
  if (!mine.length) {
    await ha.call({ type: 'lovelace/resources/create', res_type: 'module', url });
    console.log('resource created:', url);
  } else if (mine[0].url !== url) {
    await ha.call({ type: 'lovelace/resources/update', resource_id: mine[0].id, res_type: 'module', url });
    console.log('resource updated:', url);
  } else console.log('resource unchanged:', url);
} finally {
  ha.close();
}
