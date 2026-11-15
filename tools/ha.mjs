// Minimal HA websocket helper. Reads HA_URL/HA_TOKEN from the environment or ../.env (never prints the token).
// HA_URL/HA_TOKEN in the environment win: e.g. the isolated test HA (see tools/tests/testha-card.mjs).
// testEnv(): what the browser tests use – never a real home: HA_URL/HA_TOKEN (or FP_HA_URL/FP_HA_TOKEN) from the
// environment, refused on port 8123, else the isolated test HA on 127.0.0.1:8124 with the token
// hausregeln/tools/testha/lib.mjs created there (prepare it with tools/tests/testha-setup.mjs, under tools/heavy.sh testha).
// Usage as module: const ha = await connect(); await ha.call({type:'...'}); ha.close();   connect({ test: true }) in tests
// CLI: node tools/ha.mjs '{"type":"get_config"}'
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export function loadEnv() {
  // values from the environment win over the local .env file (which is optional and never committed)
  const p = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
  const env = {};
  if (existsSync(p))
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2];
    }
  const get = (k) => process.env[k] || env[k];
  return { url: get('HA_URL') || 'http://localhost:8123', token: get('HA_TOKEN'), configDir: get('HA_CONFIG_DIR') };
}

export const TEST_HA = 'http://127.0.0.1:8124';

export function testEnv() {
  const url = process.env.FP_HA_URL || process.env.HA_URL;
  if (url) {
    const u = new URL(url);
    if (u.port === '8123' || (!u.port && /^(localhost|127\.|\[::1\])/.test(u.hostname))) throw new Error('tests never run against port 8123 (a real home): use a test instance');
    const token = process.env.FP_HA_TOKEN || process.env.HA_TOKEN;
    if (!token) throw new Error('a test instance URL needs its token (FP_HA_TOKEN or HA_TOKEN)');
    return { url: url.replace(/\/$/, ''), token, test: true };
  }
  const tok = join(dirname(fileURLToPath(import.meta.url)), '..', 'hausregeln', '.cache', 'test-token');
  if (!existsSync(tok)) throw new Error('no token of the test HA: run tools/tests/testha-setup.mjs first (inside sh tools/heavy.sh testha …)');
  return { url: TEST_HA, token: readFileSync(tok, 'utf8').trim(), test: true };
}

export async function connect({ test = false } = {}) {
  const { url, token } = test ? testEnv() : loadEnv();
  const ws = new WebSocket(url.replace(/^http/, 'ws') + '/api/websocket');
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  await new Promise((resolve, reject) => {
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: token }));
      else if (msg.type === 'auth_ok') resolve();
      else if (msg.type === 'auth_invalid') reject(new Error('auth_invalid'));
      else if (msg.type === 'result' && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.success ? res(msg.result) : rej(new Error(JSON.stringify(msg.error)));
      } else if (msg.type === 'event' && listeners.has(msg.id)) listeners.get(msg.id)(msg.event);
    };
    ws.onerror = (e) => reject(e);
  });
  return {
    call(payload) {
      const mid = ++id;
      ws.send(JSON.stringify({ ...payload, id: mid }));
      return new Promise((res, rej) => pending.set(mid, { res, rej }));
    },
    subscribe(payload, cb) {
      const mid = ++id;
      listeners.set(mid, cb);
      ws.send(JSON.stringify({ ...payload, id: mid }));
      return new Promise((res, rej) => pending.set(mid, { res, rej }));
    },
    close() { ws.close(); },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ha = await connect();
  try { console.log(JSON.stringify(await ha.call(JSON.parse(process.argv[2])), null, 2)); }
  finally { ha.close(); }
}
