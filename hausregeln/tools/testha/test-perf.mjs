// Load benchmark against the isolated test Home Assistant (port 8124): bursts of state changes for thousands of
// entities nobody uses plus the fake devices Hausregeln tracks; Home Assistant must stay responsive and Hausregeln's
// handlers must stay within their budget. Also: setup time of the integration, no blocking calls in the event loop.
//   sh tools/heavy.sh testha node hausregeln/tools/testha/test-perf.mjs --start   (--start: start.sh first)
import { execFileSync } from 'node:child_process';
import { token, wsConnect, rest, sleep, ok, failures, until } from './lib.mjs';

const BUDGET = {
  unrelatedUs: 150, // per state change of an entity no rule, room or device list knows (HA's own work included)
  trackedUs: 2500, // per change of a tracked device: rules, rooms, history, panel push, … (HA's own work included)
  loopLagMs: 250, // the event loop runs a scheduled callback this soon after a burst
  pingMs: 500, // a websocket call right after a burst (during one it waits for the burst: it runs in one go)
  setupS: 5, // async_setup_entry of house_rules
};

if (process.argv.includes('--start'))
  // another test HA may still hold the port for a moment: try again for up to 10 minutes
  for (let i = 0; ; i++)
    try {
      execFileSync('sh', [new URL('./start.sh', import.meta.url).pathname], { stdio: 'inherit' });
      break;
    } catch (e) {
      if (i >= 40) throw e;
      await sleep(15000);
    }
// wait until the test HA answers (start.sh only starts the container)
await until(async () => fetch('http://127.0.0.1:8124/api/').then((r) => r.status === 401 || r.status === 200).catch(() => false), 180000, 2000);
const tok = await token();
const ws = await wsConnect(tok);
const api = rest(tok);
// a dropped connection (e.g. the container was replaced) would otherwise end the run silently with exit code 0
process.on('beforeExit', () => {
  if (!finished) {
    console.log('• FAIL: Verbindung zum Test-HA verloren, Messung unvollständig');
    process.exitCode = 1;
  }
});
let finished = false;

let info = await ws.call({ type: 'house_rules/info' }).catch(() => null);
if (!info?.loaded) {
  const flow = await api('POST', '/api/config/config_entries/flow', { handler: 'roomwise' });
  await api('POST', `/api/config/config_entries/flow/${flow.body.flow_id}`, {});
  info = await until(async () => {
    const i = await ws.call({ type: 'house_rules/info' }).catch(() => null);
    return i?.loaded && i;
  }, 30000);
}
ok(info?.loaded, `Hausregeln läuft (${info?.version})`);
await until(async () => (await ws.call({ type: 'house_rules/snapshot' })).devices.length > 10, 90000, 1000);
// a live panel subscription: every change pushes to it, as with an open panel
let pushes = 0;
let history = 0;
await ws.sub({ type: 'house_rules/subscribe' }, (e) => (e?.kind === 'history_add' ? history++ : pushes++));

// setup time (HA keeps it per integration)
const setup = await ws.call({ type: 'integration/setup_info' }).catch(() => []);
const hr = setup.find((s) => s.domain === 'roomwise');
if (hr) ok(hr.seconds <= BUDGET.setupS, `Einrichtung house_rules ${hr.seconds?.toFixed?.(2)} s (Budget ${BUDGET.setupS} s)`);
else console.log('  (integration/setup_info kennt house_rules nicht)');

// warm-up (creates the 2000 benchmark entities once), then the measured burst with a ping alongside
await ws.call({ type: 'hr_fake/burst', count: 2000, rounds: 1 });
await sleep(2000);
pushes = 0;
history = 0;
const r = await ws.call({ type: 'hr_fake/burst', count: 2000, rounds: 5 });
console.log('  Messung:', JSON.stringify(r));
ok(r.unrelated_us <= BUDGET.unrelatedUs, `fremde Zustandsänderung ${r.unrelated_us} µs (Budget ${BUDGET.unrelatedUs})`);
ok(r.tracked_us <= BUDGET.trackedUs, `Änderung eines Hausregeln-Geräts ${r.tracked_us} µs bei ${r.tracked_changes} Änderungen (Budget ${BUDGET.trackedUs})`);
ok(r.loop_lag_ms <= BUDGET.loopLagMs, `Ereignisschleife danach ${r.loop_lag_ms} ms verzögert (Budget ${BUDGET.loopLagMs})`);
// after the burst HA answers quickly again
const t = Date.now();
await ws.call({ type: 'get_config' });
ok(Date.now() - t <= BUDGET.pingMs, `Antwort nach der Welle ${Date.now() - t} ms (Budget ${BUDGET.pingMs})`);
await sleep(1500);
// the panel gets its updates gathered (core.push collects for 0.25 s), not one per change
ok(pushes <= 20, `Panel-Updates während der Welle gebündelt: ${pushes} Update-Nachrichten (dazu ${history} Verlaufseinträge) für ${r.tracked_changes} Geräteänderungen`);

// blocking calls in the event loop (HA's detector logs them)
try {
  const logs = execFileSync('docker', ['logs', '--since', '30m', 'hr-test-ha'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const blocking = logs.split('\n').filter((l) => /Detected blocking call|blocking call to/i.test(l) && /house_rules|floorplan_card/.test(l));
  ok(!blocking.length, `keine blockierenden Aufrufe von house_rules im Log`, blocking.slice(0, 3));
} catch (e) {
  console.log('  (docker logs nicht lesbar:', e.message.split('\n')[0], ')');
}
finished = true;
ws.close();
console.log(failures() ? `${failures()} Fehler` : 'alle Budgets eingehalten');
process.exit(failures() ? 1 : 0);
