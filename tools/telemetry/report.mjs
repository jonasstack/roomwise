#!/usr/bin/env node
// Reads the anonymous diagnostics of roomwise (telemetry/worker) for the developers.
//   ROOMWISE_TELEMETRY_URL=https://roomwise-telemetry.<account>.workers.dev \
//   ROOMWISE_TELEMETRY_TOKEN=… node tools/telemetry/report.mjs [stats|errors|install <id>] [--days 30] [--json]
// The token comes only from the environment (never put it into a file of this repository).
const args = process.argv.slice(2);
const flag = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const cmd = args.find((a) => !a.startsWith('--') && a !== flag('--days')) ?? 'stats';
const days = Number(flag('--days', 30)) || 30;
const base = (process.env.ROOMWISE_TELEMETRY_URL ?? '').replace(/\/+$/, '');
const token = process.env.ROOMWISE_TELEMETRY_TOKEN ?? '';
if (!base || !token) {
  console.error('ROOMWISE_TELEMETRY_URL and ROOMWISE_TELEMETRY_TOKEN must be set.');
  process.exit(2);
}

const path = cmd === 'errors' ? `/v1/errors?days=${days}` : cmd === 'install' ? `/v1/install/${args[args.indexOf('install') + 1] ?? ''}` : `/v1/stats?days=${days}`;
const res = await fetch(base + path, { headers: { authorization: `Bearer ${token}` } });
const data = await res.json().catch(() => null);
if (!res.ok) {
  console.error(`HTTP ${res.status}`, data ?? '');
  process.exit(1);
}
if (args.includes('--json') || cmd === 'install') {
  console.log(JSON.stringify(data, null, 2));
  process.exit(0);
}

const table = (title, rows, cols) => {
  if (!rows?.length) return;
  console.log(`\n${title}`);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  console.log('  ' + cols.map((c, i) => c.padEnd(w[i])).join('  '));
  for (const r of rows.slice(0, 25)) console.log('  ' + cols.map((c, i) => String(r[c] ?? '').padEnd(w[i])).join('  '));
  if (rows.length > 25) console.log(`  … ${rows.length - 25} more (--json for all)`);
};

if (cmd === 'errors') {
  console.log(`Errors of the last ${days} days`);
  for (const e of data.errors) {
    console.log(`\n${e.exc_type}  ×${e.count} in ${e.installs} installs  versions ${e.versions.join(', ')}  [${e.fingerprint}]`);
    for (const f of e.frames) console.log(`    ${f}`);
  }
  process.exit(0);
}

console.log(`roomwise diagnostics – ${data.installs} installs in the last ${data.days} days`);
table('roomwise versions', data.versions.roomwise, ['value', 'installs']);
table('Home Assistant versions', data.versions.ha, ['value', 'installs']);
table('Python', data.versions.python, ['value', 'installs']);
table('Language', data.language, ['value', 'installs']);
table('Unit system', data.unit_system, ['value', 'installs']);
table('Installation', data.installation, ['value', 'installs']);
table('Features on', data.features, ['feature', 'on', 'installs']);
table('Domains', data.domains, ['key', 'total', 'installs']);
table('Device classes', data.device_classes, ['key', 'total', 'installs']);
table('Integrations per domain', data.platforms, ['domain', 'platform', 'total', 'installs']);
table('Capability shapes', data.shapes, ['domain', 'platform', 'shape', 'total', 'installs']);
table('Counts (sum over installs)', data.counts, ['key', 'total', 'installs']);
for (const [k, rows] of Object.entries(data.clients)) table(`Cards: ${k}`, rows, ['value', 'cards', 'installs']);
console.log('\nroomwise parts', data.roomwise);
