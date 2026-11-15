// Helpers for the isolated test Home Assistant (default http://127.0.0.1:8124). Never point this at a real home.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
export const URL0 = process.env.HR_TEST_URL ?? 'http://127.0.0.1:8124';
if (!/127\.0\.0\.1:8124|localhost:8124/.test(URL0)) throw new Error('Tests only run against the isolated test HA on port 8124');
const TOK = new URL('../../.cache/test-token', import.meta.url);

const j = async (path, opts = {}) => {
  const r = await fetch(URL0 + path, opts);
  const t = await r.text();
  try {
    return { status: r.status, body: JSON.parse(t) };
  } catch {
    return { status: r.status, body: t };
  }
};

export async function wsConnect(tok) {
  const ws = new WebSocket(URL0.replace('http', 'ws') + '/api/websocket');
  let id = 1;
  const pend = new Map();
  const subs = new Map();
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
      } else if (d.type === 'event') subs.get(d.id)?.(d.event);
    };
    ws.onerror = rej;
  });
  return {
    call: (msg) =>
      new Promise((res, rej) => {
        const i = id++;
        pend.set(i, { res, rej });
        ws.send(JSON.stringify({ ...msg, id: i }));
      }),
    sub: (msg, cb) =>
      new Promise((res, rej) => {
        const i = id++;
        subs.set(i, cb);
        pend.set(i, { res, rej });
        ws.send(JSON.stringify({ ...msg, id: i }));
      }),
    close: () => ws.close(),
  };
}

export async function token() {
  let tok = existsSync(TOK) ? readFileSync(TOK, 'utf8').trim() : '';
  if (tok && (await j('/api/', { headers: { Authorization: `Bearer ${tok}` } })).status === 200) return tok;
  const client_id = `${URL0}/`;
  const u = await j('/api/onboarding/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id, name: 'Test', username: 'test', password: 'test-pass-123', language: 'de' }),
  });
  const tk = await j('/auth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: u.body.auth_code, client_id }),
  });
  const ws0 = await wsConnect(tk.body.access_token);
  tok = await ws0.call({ type: 'auth/long_lived_access_token', client_name: 'hr-test', lifespan: 3650 });
  ws0.close();
  mkdirSync(new URL('../../.cache/', import.meta.url), { recursive: true });
  writeFileSync(TOK, tok);
  const H = { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' };
  for (const step of ['core_config', 'analytics']) await j(`/api/onboarding/${step}`, { method: 'POST', headers: H, body: '{}' });
  await j('/api/onboarding/integration', { method: 'POST', headers: H, body: JSON.stringify({ client_id, redirect_uri: `${URL0}/?auth_callback=1` }) });
  return tok;
}

export const rest = (tok) => async (method, path, body) =>
  j(path, { method, headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
export const ok = (c, m, extra) => {
  if (!c) fails++;
  console.log(c ? '  ok:' : '• FAIL:', m, !c && extra !== undefined ? JSON.stringify(extra).slice(0, 400) : '');
};
export const failures = () => fails;

/** waits until fn() is truthy (polls), returns its value or undefined */
export async function until(fn, ms = 8000, step = 150) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return undefined;
}

/** a token of a (non-admin) test user, created once in the test HA: for permission checks */
export async function userToken(adminToken, username = 'tablet', admin = false) {
  const ws = await wsConnect(adminToken);
  const users = await ws.call({ type: 'config/auth/list' });
  // newer Home Assistant versions do not list the username: a user of that name counts as existing too
  if (!users.some((u) => u.username === username || u.name === username)) {
    // admin: true/false, or a group id (e.g. "system-read-only")
    const { user } = await ws.call({ type: 'config/auth/create', name: username, group_ids: [typeof admin === 'string' ? admin : admin ? 'system-admin' : 'system-users'], local_only: false });
    await ws.call({ type: 'config/auth_provider/homeassistant/create', user_id: user.id, username, password: 'test-pass-123' }).catch((e) => {
      if (!/already exists/.test(e.message)) throw e;
    });
  }
  ws.close();
  const client_id = `${URL0}/`;
  const flow = await j('/auth/login_flow', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id, handler: ['homeassistant', null], redirect_uri: `${URL0}/?auth_callback=1` }) });
  const step = await j(`/auth/login_flow/${flow.body.flow_id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id, username, password: 'test-pass-123' }) });
  const tk = await j('/auth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: step.body.result, client_id }) });
  return tk.body.access_token;
}
