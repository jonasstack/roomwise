// Wi-Fi networks of the companion integration (QR codes on the tablets) against the isolated test Home Assistant (never a
// real one): admins store them, signed-in users read the ones for everyone, "admins only" stays with admins, a
// non-admin can never write, the checks a phone would refuse (SSID, password length), and no password or SSID in
// the diagnostics. Run inside the test HA lock:
//   sh tools/heavy.sh testha sh -c 'sh hausregeln/tools/testha/start.sh && node tools/tests/testha-setup.mjs && node tools/companion/test-wifi.mjs'
import { existsSync, readFileSync } from 'node:fs';
import { token, wsConnect, userToken, rest, ok, failures, until } from '../../hausregeln/tools/testha/lib.mjs';

const tok = await token();
const api = rest(tok);
const ws = await wsConnect(tok);
let info = await ws.call({ type: 'floorplan_card/info' }).catch(() => undefined);
if (!info?.loaded) {
  const flow = await api('POST', '/api/config/config_entries/flow', { handler: 'floorplan_card' });
  if (flow.body?.type === 'form') await api('POST', `/api/config/config_entries/flow/${flow.body.flow_id}`, {});
  info = await until(() => ws.call({ type: 'floorplan_card/info' }).then((i) => (i.loaded ? i : undefined)).catch(() => undefined), 15000);
}
ok(info?.loaded && info.features?.includes('wifi'), 'companion loaded, offers wifi', info);

const empty = await ws.call({ type: 'floorplan_card/wifi/get' });
ok(Array.isArray(empty.networks) && empty.networks.length === 0, 'no networks at first');

const PW_HOME = 'Demo-Passwort;mit:Sonderzeichen';
const PW_GUEST = 'gast-demo-2026';
const nets = [
  { name: 'Zuhause', ssid: 'Demo Home', password: PW_HOME, security: 'wpa3', admins_only: true },
  { name: 'Gäste', ssid: 'Demo-Gast', password: PW_GUEST, security: 'wpa2', hidden: true },
  { name: 'Offen', ssid: 'Demo Open', password: 'wird verworfen', security: 'nopass' },
];
const set = await ws.call({ type: 'floorplan_card/wifi/set', networks: nets });
ok(set.networks === 3, 'admin: three networks stored', set);
const all = (await ws.call({ type: 'floorplan_card/wifi/get' })).networks;
ok(all.length === 3 && all.every((n) => /^net_[0-9a-f]{8}$/.test(n.id)), 'admin: all three with ids', all);
ok(all[0].password === PW_HOME && all[0].security === 'wpa3' && all[0].admins_only === true, 'admin: password, security and "admins only" read back');
ok(all[1].hidden === true && all[2].password === '' && all[2].security === 'nopass', 'hidden flag kept, open network without password');

// ids stay when the list is saved again (the editor sends them back)
const again = (await ws.call({ type: 'floorplan_card/wifi/set', networks: all }), (await ws.call({ type: 'floorplan_card/wifi/get' })).networks);
ok(again.map((n) => n.id).join() === all.map((n) => n.id).join(), 'ids kept on a second save');

// the checks a phone would refuse
const refused = async (networks) => String(await ws.call({ type: 'floorplan_card/wifi/set', networks }).then(() => 'stored', (e) => e.message));
ok((await refused([{ ssid: 'x', password: 'kurz', security: 'wpa2' }])).startsWith('invalid_password'), 'password under 8 characters refused');
ok(!(await refused([{ ssid: 'x', password: 'kurz', security: 'wpa2' }])).includes('kurz'), 'the error never repeats the password');
ok((await refused([{ ssid: 'x'.repeat(33), password: '12345678' }])).startsWith('invalid'), 'SSID over 32 bytes refused');
ok((await refused([{ ssid: '', password: '12345678' }])).startsWith('invalid'), 'empty SSID refused');
ok((await refused([{ ssid: 'x', password: '12345678', security: 'wep' }])).startsWith('invalid'), 'unknown encryption refused');
ok((await refused(Array.from({ length: 11 }, (_, i) => ({ ssid: `n${i}`, security: 'nopass' })))).startsWith('too_many'), 'more than 10 networks refused');
ok((await ws.call({ type: 'floorplan_card/wifi/get' })).networks.length === 3, 'a refused save changes nothing');

// a wall tablet (non-admin) reads what it may show, never writes
const user = await userToken(tok, 'tablet', false);
const uws = await wsConnect(user);
const seen = (await uws.call({ type: 'floorplan_card/wifi/get' })).networks;
ok(seen.length === 2 && !seen.some((n) => n.ssid === 'Demo Home'), 'non-admin: only the networks for everyone', seen.map((n) => n.ssid));
ok(seen.every((n) => !('admins_only' in n)) && seen[0].password === PW_GUEST, 'non-admin: password of the guest network (for the QR code), no admin flag');
const write = await uws.call({ type: 'floorplan_card/wifi/set', networks: [] }).catch((e) => e.message);
ok(String(write).startsWith('unauthorized'), 'non-admin: wifi/set refused');
uws.close();

// diagnostics: only counts
const entry = (await api('GET', '/api/config/config_entries/entry')).body.find((e) => e.domain === 'floorplan_card');
const diag = await api('GET', `/api/diagnostics/config_entry/${entry.entry_id}`);
const d = JSON.stringify(diag.body);
ok(diag.status === 200 && diag.body?.data?.wifi?.networks === 3, 'diagnostics: number of networks', diag.body?.data?.wifi);
ok(![PW_HOME, PW_GUEST, 'Demo Home', 'Demo-Gast', 'Gäste'].some((s) => d.includes(s)), 'diagnostics: no password, SSID or name');

// stored in Home Assistant's own storage, in a file of its own (not in the dashboard)
const dash = JSON.stringify((await ws.call({ type: 'lovelace/config' }).catch(() => ({}))) ?? {});
ok(!dash.includes(PW_GUEST), 'not in the dashboard config');
const files = ['hausregeln/.cache/testha/.storage/floorplan_card.wifi', 'tools/.cache/fp-testha/.storage/floorplan_card.wifi'];
await until(() => files.some((f) => existsSync(f)), 6000).catch(() => {});
const file = files.find((f) => existsSync(f));
if (file) {
  await until(() => readFileSync(file, 'utf8').includes('Demo-Gast'), 5000);
  ok(readFileSync(file, 'utf8').includes('Demo-Gast'), `stored in ${file.split('/').slice(-2).join('/')}`);
} else console.log('  (storage file not reachable from here: skipped)');

await ws.call({ type: 'floorplan_card/wifi/set', networks: [] });
ok((await ws.call({ type: 'floorplan_card/wifi/get' })).networks.length === 0, 'cleared');
ws.close();
console.log(failures() ? `\n${failures()} FAILED` : '\nall ok');
process.exit(failures() ? 1 : 0);
