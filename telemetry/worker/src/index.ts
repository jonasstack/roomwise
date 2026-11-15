/**
 * roomwise diagnostics server (Cloudflare Worker + D1). See README.md and PRIVACY.md at the repository root.
 *
 *   POST   /v1/report          weekly report of one install (validated, ≤ 64 KB, upsert per install and day)
 *   POST   /v1/error           one error (validated, ≤ 16 KB, deduplicated by fingerprint, counted)
 *   DELETE /v1/install/<id>    delete everything of one install
 *   GET    /v1/stats?days=30   aggregates for the developers            (Authorization: Bearer READ_TOKEN)
 *   GET    /v1/errors?days=30  top errors                               (Bearer)
 *   GET    /v1/install/<id>    raw reports of one install, for debugging (Bearer)
 *
 * Privacy: the worker never reads, stores or logs IP addresses or request headers (except Content-Length /
 * Authorization to do its job); it stores only the validated JSON. A daily cron deletes old rows.
 */
import { ERROR, REPORT, UUID, validate } from './schema';

export interface Env {
  DB: D1Database;
  READ_TOKEN: string;
}

const MAX_REPORT = 64 * 1024;
const MAX_ERROR = 16 * 1024;
const REPORTS_PER_DAY = 5;
const ERRORS_PER_DAY = 30;
const DELETES_PER_DAY = 10;
const KEEP_REPORT_DAYS = 400;
const KEEP_ERROR_DAYS = 180;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const now = () => Math.floor(Date.now() / 1000);

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** constant-time comparison of the bearer token */
async function authorized(req: Request, env: Env): Promise<boolean> {
  const got = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!env.READ_TOKEN || env.READ_TOKEN.length < 16 || !got) return false;
  const [a, b] = await Promise.all([sha256(got), sha256(env.READ_TOKEN)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Reads a JSON body of at most `max` bytes (also when Content-Length is missing or wrong) */
async function body(req: Request, max: number): Promise<{ ok: true; value: unknown } | { ok: false; res: Response }> {
  if (!/^application\/json\b/i.test(req.headers.get('content-type') ?? '')) return { ok: false, res: json({ error: 'json_expected' }, 415) };
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > max) return { ok: false, res: json({ error: 'too_large' }, 413) };
  const buf = await req.arrayBuffer();
  if (buf.byteLength > max) return { ok: false, res: json({ error: 'too_large' }, 413) };
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(buf)) };
  } catch {
    return { ok: false, res: json({ error: 'invalid_json' }, 400) };
  }
}

/** true while the install is below its daily limit for this kind (counts the request) */
async function allow(env: Env, id: string, kind: string, limit: number): Promise<boolean> {
  const row = await env.DB.prepare('INSERT INTO rate (install_id, kind, day, count) VALUES (?1, ?2, ?3, 1) ON CONFLICT (install_id, kind, day) DO UPDATE SET count = count + 1 RETURNING count')
    .bind(id, kind, day())
    .first<{ count: number }>();
  return (row?.count ?? 0) <= limit;
}

async function report(req: Request, env: Env): Promise<Response> {
  const b = await body(req, MAX_REPORT);
  if (!b.ok) return b.res;
  const err = validate(REPORT, b.value);
  if (err) return json({ error: 'invalid', detail: err }, 400);
  const r = b.value as { install_id: string; schema: number; versions: { roomwise: string; ha: string }; ha: { language: string } };
  if (!(await allow(env, r.install_id, 'report', REPORTS_PER_DAY))) return json({ error: 'rate_limited' }, 429);
  await env.DB.prepare(
    `INSERT INTO reports (install_id, day, received_at, schema, roomwise_version, ha_version, language, payload) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT (install_id, day) DO UPDATE SET received_at = excluded.received_at, schema = excluded.schema, roomwise_version = excluded.roomwise_version,
       ha_version = excluded.ha_version, language = excluded.language, payload = excluded.payload`,
  )
    .bind(r.install_id, day(), now(), r.schema, r.versions.roomwise, r.versions.ha, r.ha.language, JSON.stringify(b.value))
    .run();
  return json({ ok: true });
}

async function error(req: Request, env: Env): Promise<Response> {
  const b = await body(req, MAX_ERROR);
  if (!b.ok) return b.res;
  const err = validate(ERROR, b.value);
  if (err) return json({ error: 'invalid', detail: err }, 400);
  const e = b.value as { install_id: string; type: string; frames: string[]; count: number; versions: { roomwise: string } };
  if (!(await allow(env, e.install_id, 'error', ERRORS_PER_DAY))) return json({ error: 'rate_limited' }, 429);
  // the server decides the fingerprint: type + frames without line numbers (stable across releases)
  const fp = (await sha256(e.type + '|' + e.frames.map((f) => f.replace(/:\d+ /, ' ')).join('|'))).slice(0, 24);
  const t = now();
  const old = await env.DB.prepare('SELECT versions FROM errors WHERE fingerprint = ?1').bind(fp).first<{ versions: string }>();
  const versions = [...new Set([...(old ? (JSON.parse(old.versions) as string[]) : []), e.versions.roomwise])].slice(-10);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO errors (fingerprint, exc_type, frames, versions, first_seen, last_seen, count) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)
       ON CONFLICT (fingerprint) DO UPDATE SET frames = excluded.frames, versions = excluded.versions, last_seen = excluded.last_seen, count = count + excluded.count`,
    ).bind(fp, e.type, JSON.stringify(e.frames), JSON.stringify(versions), t, e.count),
    env.DB.prepare(
      `INSERT INTO error_installs (fingerprint, install_id, last_day, count) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (fingerprint, install_id) DO UPDATE SET last_day = excluded.last_day, count = count + excluded.count`,
    ).bind(fp, e.install_id, day(), e.count),
  ]);
  return json({ ok: true, fingerprint: fp });
}

async function remove(id: string, env: Env): Promise<Response> {
  if (!(await allow(env, id, 'delete', DELETES_PER_DAY))) return json({ error: 'rate_limited' }, 429);
  const res = await env.DB.batch([
    env.DB.prepare('DELETE FROM reports WHERE install_id = ?1').bind(id),
    env.DB.prepare('DELETE FROM error_installs WHERE install_id = ?1').bind(id),
  ]);
  // the rate row of this very request goes too: nothing of the id is left
  await env.DB.prepare('DELETE FROM rate WHERE install_id = ?1').bind(id).run();
  return json({ ok: true, deleted: res.reduce((n, r) => n + (r.meta.changes ?? 0), 0) });
}

// ---------------------------------------------------------------------- read API (developers)
async function stats(env: Env, days: number): Promise<Response> {
  const since = day(Date.now() - days * 86400_000);
  // the newest report of every install in the window
  const latest = `SELECT r.payload FROM reports r JOIN (SELECT install_id, MAX(day) d FROM reports WHERE day >= ?1 GROUP BY install_id) m ON r.install_id = m.install_id AND r.day = m.d`;
  const q = async <T>(sql: string) => (await env.DB.prepare(sql).bind(since).all<T>()).results;
  const by = (path: string) => q<{ value: string | null; installs: number }>(`SELECT json_extract(payload, '${path}') value, COUNT(*) installs FROM (${latest}) GROUP BY value ORDER BY installs DESC LIMIT 50`);
  const summed = (path: string, limit = 100) =>
    q<{ key: string; total: number; installs: number }>(`SELECT j.key key, SUM(j.value) total, COUNT(*) installs FROM (${latest}) l, json_each(l.payload, '${path}') j GROUP BY j.key ORDER BY installs DESC, total DESC LIMIT ${limit}`);
  const [installs, roomwise, ha, python, language, units, installation] = await Promise.all([
    q<{ n: number }>(`SELECT COUNT(*) n FROM (${latest})`),
    by('$.versions.roomwise'),
    by('$.versions.ha'),
    by('$.versions.python'),
    by('$.ha.language'),
    by('$.ha.unit_system'),
    by('$.ha.installation'),
  ]);
  const [domains, deviceClasses, counts] = await Promise.all([summed('$.entities.domains'), summed('$.entities.device_classes', 200), summed('$.counts', 40)]);
  const platforms = await q<{ domain: string; platform: string; total: number; installs: number }>(
    `SELECT d.key domain, p.key platform, SUM(p.value) total, COUNT(*) installs FROM (${latest}) l, json_each(l.payload, '$.platforms') d, json_each(d.value) p
     GROUP BY d.key, p.key ORDER BY installs DESC, total DESC LIMIT 300`,
  );
  const features = await q<{ feature: string; on: number; installs: number }>(
    `SELECT j.key feature, SUM(CASE WHEN j.value THEN 1 ELSE 0 END) "on", COUNT(*) installs FROM (${latest}) l, json_each(l.payload, '$.features') j GROUP BY j.key ORDER BY "on" DESC`,
  );
  const shapes = await q<{ domain: string; platform: string; shape: string; total: number; installs: number }>(
    `SELECT json_extract(j.value, '$.domain') domain, json_extract(j.value, '$.platform') platform, json_extract(j.value, '$.shape') shape, SUM(json_extract(j.value, '$.count')) total, COUNT(*) installs
     FROM (${latest}) l, json_each(l.payload, '$.shapes') j GROUP BY domain, platform, shape ORDER BY installs DESC, total DESC LIMIT 200`,
  );
  const client = (field: string) =>
    q<{ value: string; cards: number; installs: number }>(
      `SELECT json_extract(j.value, '$.${field}') value, SUM(json_extract(j.value, '$.count')) cards, COUNT(DISTINCT l.payload) installs FROM (${latest}) l, json_each(l.payload, '$.clients') j GROUP BY value ORDER BY cards DESC`,
    );
  const [browsers, engines, webgl, gpus, tiers, screens] = await Promise.all([client('browser'), client('engine'), client('webgl'), client('gpu'), client('tier'), client('screen')]);
  const roomwiseParts = await q<{ floorplan_card: number; entry_alert: number; pets: number; vacuum: number }>(
    `SELECT SUM(json_extract(payload, '$.roomwise.floorplan_card')) floorplan_card, SUM(json_extract(payload, '$.roomwise.entry_alert')) entry_alert,
       SUM(json_extract(payload, '$.roomwise.pets') > 0) pets, SUM(json_extract(payload, '$.roomwise.vacuum_adapters') != '{}') vacuum FROM (${latest})`,
  );
  return json({
    days,
    installs: installs[0]?.n ?? 0,
    versions: { roomwise, ha, python },
    language,
    unit_system: units,
    installation,
    domains,
    device_classes: deviceClasses,
    platforms,
    shapes,
    features,
    roomwise: roomwiseParts[0] ?? {},
    counts,
    clients: { browsers, engines, webgl, gpus, tiers, screens },
  });
}

async function topErrors(env: Env, days: number): Promise<Response> {
  const since = now() - days * 86400;
  const rows = await env.DB.prepare(
    `SELECT e.fingerprint, e.exc_type, e.frames, e.versions, e.first_seen, e.last_seen, e.count, (SELECT COUNT(*) FROM error_installs i WHERE i.fingerprint = e.fingerprint) installs
     FROM errors e WHERE e.last_seen >= ?1 ORDER BY installs DESC, e.count DESC LIMIT 100`,
  )
    .bind(since)
    .all<{ frames: string; versions: string }>();
  return json({ days, errors: rows.results.map((r) => ({ ...r, frames: JSON.parse(r.frames), versions: JSON.parse(r.versions) })) });
}

async function raw(id: string, env: Env): Promise<Response> {
  const reports = await env.DB.prepare('SELECT day, received_at, payload FROM reports WHERE install_id = ?1 ORDER BY day DESC LIMIT 60').bind(id).all<{ payload: string }>();
  const errors = await env.DB.prepare('SELECT i.fingerprint, i.last_day, i.count, e.exc_type, e.frames FROM error_installs i JOIN errors e USING (fingerprint) WHERE i.install_id = ?1 ORDER BY i.last_day DESC').bind(id).all<{ frames: string }>();
  return json({ install_id: id, reports: reports.results.map((r) => ({ ...r, payload: JSON.parse(r.payload) })), errors: errors.results.map((e) => ({ ...e, frames: JSON.parse(e.frames) })) });
}

/** daily: delete what is older than the retention times in PRIVACY.md */
export async function cleanup(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM reports WHERE day < ?1').bind(day(Date.now() - KEEP_REPORT_DAYS * 86400_000)),
    env.DB.prepare('DELETE FROM error_installs WHERE last_day < ?1').bind(day(Date.now() - KEEP_ERROR_DAYS * 86400_000)),
    env.DB.prepare('DELETE FROM errors WHERE last_seen < ?1').bind(now() - KEEP_ERROR_DAYS * 86400),
    env.DB.prepare('DELETE FROM rate WHERE day < ?1').bind(day(Date.now() - 2 * 86400_000)),
  ]);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, '');
    try {
      if (req.method === 'POST' && p === '/v1/report') return await report(req, env);
      if (req.method === 'POST' && p === '/v1/error') return await error(req, env);
      const inst = p.match(/^\/v1\/install\/([^/]+)$/);
      if (inst && !UUID.test(inst[1])) return json({ error: 'invalid_id' }, 400);
      if (inst && req.method === 'DELETE') return await remove(inst[1], env);
      if (req.method === 'GET' && (p === '/v1/stats' || p === '/v1/errors' || inst)) {
        if (!(await authorized(req, env))) return json({ error: 'unauthorized' }, 401);
        const days = Math.min(400, Math.max(1, Number(url.searchParams.get('days')) || 30));
        if (p === '/v1/stats') return await stats(env, days);
        if (p === '/v1/errors') return await topErrors(env, days);
        return await raw(inst![1], env);
      }
      if (req.method === 'GET' && (p === '' || p === '/v1')) return json({ service: 'roomwise diagnostics', privacy: 'https://github.com/jonasstack/roomwise/blob/main/PRIVACY.md' });
      return json({ error: 'not_found' }, 404);
    } catch {
      // no details, no request data in any log
      return json({ error: 'server_error' }, 500);
    }
  },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await cleanup(env);
  },
} satisfies ExportedHandler<Env>;
