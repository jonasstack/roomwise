// Gets the companion test Home Assistant (started by tools/companion/testha/start.sh) ready for the tests: waits until it
// runs, onboards it on the first run (token in tools/.cache/companion-test-token), adds the companion integration
// and the test dashboard "fp-test". Only ever against the isolated test instance on port 8124.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const U = process.argv[2] ?? 'http://127.0.0.1:8124';
if (!/127\.0\.0\.1:8124|localhost:8124/.test(U)) throw new Error('only against the isolated test HA on port 8124');
const TOK = new URL('../.cache/companion-test-token', import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (path, opts = {}) => {
  const r = await fetch(U + path, opts);
  const t = await r.text();
  try {
    return { status: r.status, body: JSON.parse(t) };
  } catch {
    return { status: r.status, body: t };
  }
};

async function wsConnect(tok) {
  const ws = new WebSocket(U.replace('http', 'ws') + '/api/websocket');
  let id = 1;
  const pend = new Map();
  await new Promise((res, rej) => {
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: tok }));
      else if (d.type === 'auth_ok') res();
      else if (d.type === 'auth_invalid') rej(new Error('auth'));
      else if (d.type === 'result') {
        const p = pend.get(d.id);
        pend.delete(d.id);
        d.success ? p?.res(d.result) : p?.rej(new Error(d.error?.code + ': ' + d.error?.message));
      }
    };
    ws.onerror = rej;
  });
  return { call: (msg) => new Promise((res, rej) => { const i = id++; pend.set(i, { res, rej }); ws.send(JSON.stringify({ ...msg, id: i })); }), close: () => ws.close() };
}

// 1) up (the frontend answers once Home Assistant has started)
for (let i = 0; i < 120; i++) {
  try {
    const r = await fetch(U + '/manifest.json');
    if (r.status === 200) break;
  } catch {
    /* not yet */
  }
  await sleep(2000);
}
// 2) token: stored, or onboard a fresh instance
let token = existsSync(TOK) ? readFileSync(TOK, 'utf8').trim() : '';
if (token && (await j('/api/', { headers: { Authorization: `Bearer ${token}` } })).status !== 200) token = '';
if (!token) {
  const client_id = `${U}/`;
  // onboarding is ready once it lists its steps
  for (let i = 0; i < 60; i++) {
    const s = await j('/api/onboarding').catch(() => ({}));
    if (Array.isArray(s.body)) break;
    await sleep(2000);
  }
  let u;
  for (let i = 0; i < 30 && !u?.body?.auth_code; i++) {
    u = await j('/api/onboarding/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id, name: 'Test', username: 'test', password: 'test-pass-123', language: 'de' }) });
    if (!u.body?.auth_code) await sleep(2000);
  }
  const tk = await j('/auth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: u.body.auth_code, client_id }) });
  if (!tk.body?.access_token) throw new Error(`onboarding failed: ${JSON.stringify(u.body)} ${JSON.stringify(tk.body)}`);
  const ws0 = await wsConnect(tk.body.access_token);
  token = await ws0.call({ type: 'auth/long_lived_access_token', client_name: 'fp-test', lifespan: 3650 });
  ws0.close();
  mkdirSync(new URL('../.cache/', import.meta.url), { recursive: true });
  writeFileSync(TOK, token);
}
const H = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
for (const step of ['core_config', 'analytics']) await j(`/api/onboarding/${step}`, { method: 'POST', headers: H, body: '{}' });
await j('/api/onboarding/integration', { method: 'POST', headers: H, body: JSON.stringify({ client_id: `${U}/`, redirect_uri: `${U}/?auth_callback=1` }) });
// 3) running (not only the frontend)
for (let i = 0; i < 60; i++) {
  const r = await j('/api/config', { headers: H });
  if (r.status === 200 && r.body.state === 'RUNNING') break;
  await sleep(2000);
}
const ws = await wsConnect(token);
// 4) the companion integration (one click, nothing to fill in)
let info = await ws.call({ type: 'floorplan_card/info' }).catch(() => undefined);
if (!info?.loaded) {
  const flow = await j('/api/config/config_entries/flow', { method: 'POST', headers: H, body: JSON.stringify({ handler: 'roomwise' }) });
  if (flow.body.type === 'form') await j(`/api/config/config_entries/flow/${flow.body.flow_id}`, { method: 'POST', headers: H, body: '{}' });
  for (let i = 0; i < 20 && !info?.loaded; i++) {
    await sleep(500);
    info = await ws.call({ type: 'floorplan_card/info' }).catch(() => undefined);
  }
}
// 5) the test dashboard
const boards = await ws.call({ type: 'lovelace/dashboards/list' });
if (!boards.some((d) => d.url_path === 'fp-test')) await ws.call({ type: 'lovelace/dashboards/create', url_path: 'fp-test', title: 'FP', mode: 'storage', require_admin: false, show_in_sidebar: true });
ws.close();
console.log(info?.loaded ? `test HA ready (companion ${info.version})` : '• FAIL: companion did not load');
process.exit(info?.loaded ? 0 : 1);
