// Song recognition of the companion integration against the isolated companion test Home Assistant (never a real one):
// no API key → refused; the options flow (key, own server URL, invalid input); a fingerprint → AcoustID (the stand-in
// /api/fp_fake/acoustid of fp_fake, no real network) → title / artist / album, event floorplan_card_song, one sensor
// per device, floorplan_card/songs; no match, a weak match, too often, a refused key, invalid input, a non-admin
// tablet, kept across a reload. Run inside the test HA lock:
//   sh tools/heavy.sh testha sh -c 'sh tools/companion/testha/start.sh fresh && node tools/companion/test-songs.mjs'
import { token, wsConnect, userToken, rest, ok, failures, until, sleep } from '../../hausregeln/tools/testha/lib.mjs';

const tok = await token();
const api = rest(tok);
const ws = await wsConnect(tok);
let info = await ws.call({ type: 'floorplan_card/info' }).catch(() => undefined);
if (!info?.loaded) {
  const flow = await api('POST', '/api/config/config_entries/flow', { handler: 'floorplan_card' });
  if (flow.body?.type === 'form') await api('POST', `/api/config/config_entries/flow/${flow.body.flow_id}`, {});
  info = await until(() => ws.call({ type: 'floorplan_card/info' }).then((i) => (i.loaded ? i : undefined)).catch(() => undefined), 15000);
}
ok(info?.loaded && info.features?.includes('songs') && info.song_key === false, 'companion loaded, offers songs, no API key yet', info);

const FP = 'AQAAmatch_' + 'x'.repeat(300);
const lookup = (w, extra = {}) => w.call({ type: 'floorplan_card/song/lookup', card_id: 'songcard', item_id: 'tv1', name: 'Fernseher', fingerprint: FP, duration: 10, ...extra });
const err = (p) => p.then(() => 'no error', (e) => e.message);

ok(/^no_api_key/.test(await err(lookup(ws))), 'without an API key: no_api_key, nothing asked');

// options: the key (and the stand-in as the server)
const entry = (await api('GET', '/api/config/config_entries/entry')).body.find((e) => e.domain === 'floorplan_card');
const setOptions = async (input) => {
  const f = await api('POST', '/api/config/config_entries/options/flow', { handler: entry.entry_id });
  return (await api('POST', `/api/config/config_entries/options/flow/${f.body.flow_id}`, input)).body;
};
const bad = await setOptions({ acoustid_key: 'x', acoustid_url: 'ftp://nope' });
ok(bad.type === 'form' && bad.errors?.acoustid_key === 'invalid_key' && bad.errors?.acoustid_url === 'invalid_url', 'options: a bad key and a bad URL are refused', bad);
const FAKE = 'http://127.0.0.1:8123/api/fp_fake/acoustid';
const done = await setOptions({ acoustid_key: 'TestKey123', acoustid_url: FAKE });
ok(done.type === 'create_entry', 'options: key and own server saved', done);
info = await ws.call({ type: 'floorplan_card/info' });
ok(info.song_key === true, 'info: an API key is set (the key itself is never sent)', info);
ok(!JSON.stringify(info).includes('TestKey123'), 'info does not contain the key');

// a match
const events = [];
await ws.sub({ type: 'subscribe_events', event_type: 'floorplan_card_song' }, (e) => events.push(e.data));
const r1 = await lookup(ws);
ok(r1.match === true && r1.song?.title === 'Demo Song' && r1.song.artist === 'Demo Band feat. Guest' && r1.song.album === 'Demo Album' && !!r1.song.at, 'match: title, joined artists, album', r1);
const asked = await ws.call({ type: 'fp_fake/acoustid' });
const q = asked.at(-1);
ok(asked.length === 1 && q.client === 'TestKey123' && q.fingerprint === FP && q.duration === '10' && /recordings/.test(q.meta) && q.format === 'json', 'AcoustID asked once with key, fingerprint, duration', q);
ok(Object.keys(q).sort().join() === 'client,duration,fingerprint,format,meta', 'nothing but these fields goes out', Object.keys(q));
await until(() => events.length);
ok(events[0]?.item_id === 'tv1' && events[0].card_id === 'songcard' && events[0].title === 'Demo Song' && events[0].score === 0.93 && !('fingerprint' in events[0]), 'event floorplan_card_song with the song (no fingerprint)', events[0]);
const sensor = await until(async () => (await api('GET', '/api/states')).body.find((s) => s.entity_id.startsWith('sensor.') && s.attributes.item_id === 'tv1'), 8000);
ok(sensor?.state === 'Demo Song – Demo Band feat. Guest' && sensor.attributes.album === 'Demo Album' && sensor.attributes.recording_id && sensor.attributes.recognized_at, 'sensor per device: state "Title – Artist", attributes', sensor);
ok(/fernseher/.test(sensor?.entity_id ?? '') && /Fernseher/.test(sensor?.attributes.friendly_name ?? ''), 'sensor named after the device', sensor?.entity_id);
ok(/^too_often/.test(await err(lookup(ws))), 'the same device again right away: too_often (AcoustID not asked)');
ok((await ws.call({ type: 'fp_fake/acoustid' })).length === 1, 'still one request');

// no match / weak match: nothing stored, no sensor
const r2 = await lookup(ws, { item_id: 'tv2', fingerprint: 'AQAAnothing_here' });
const r3 = await lookup(ws, { item_id: 'tv3', fingerprint: 'AQAAweak_one' });
ok(r2.match === false && r2.song === null && r3.match === false, 'no result and a score below the threshold: no match', [r2, r3]);
let songs = (await ws.call({ type: 'floorplan_card/songs', card_id: 'songcard' })).songs;
ok(Object.keys(songs).join() === 'tv1' && songs.tv1.title === 'Demo Song', 'songs: only the recognized device', songs);
ok(Object.keys((await ws.call({ type: 'floorplan_card/songs', card_id: 'othercard' })).songs).length === 0, 'songs of another card: none');

// invalid input
ok(/invalid_format/.test(await err(lookup(ws, { item_id: 'tv5', fingerprint: 'abc!<script>' }))), 'fingerprint with foreign characters refused');
ok(/invalid_format/.test(await err(lookup(ws, { item_id: 'tv5', duration: 0 }))), 'duration 0 refused');
ok(/invalid_format/.test(await err(lookup(ws, { item_id: 'tv5', fingerprint: 'A'.repeat(20001) }))), 'too long fingerprint refused');

// a wall tablet signed in as a plain user may look up and read
const user = await wsConnect(await userToken(tok, 'tablet'));
await sleep(500);
const r4 = await lookup(user, { item_id: 'tv4', name: 'Radio' });
ok(r4.match === true, 'non-admin user: lookup works', r4);
ok(Object.keys((await user.call({ type: 'floorplan_card/songs', card_id: 'songcard' })).songs).sort().join() === 'tv1,tv4', 'non-admin user: songs readable');

// a key AcoustID refuses
await setOptions({ acoustid_key: 'badkey12345', acoustid_url: FAKE });
ok(/^invalid_key/.test(await err(lookup(ws, { item_id: 'tv6' }))), 'refused key: invalid_key');
await setOptions({ acoustid_key: 'TestKey123', acoustid_url: FAKE });

// kept across a reload of the integration (sensor back with its state)
await api('POST', `/api/config/config_entries/entry/${entry.entry_id}/reload`);
await until(() => ws.call({ type: 'floorplan_card/info' }).then((i) => i.loaded).catch(() => false), 15000);
songs = (await ws.call({ type: 'floorplan_card/songs', card_id: 'songcard' })).songs;
ok(songs.tv1?.title === 'Demo Song' && songs.tv4?.title === 'Demo Song', 'after a reload: the last songs are still there', songs);
const again = await until(async () => (await api('GET', '/api/states')).body.find((s) => s.entity_id === sensor?.entity_id && s.state !== 'unavailable'), 10000);
ok(again?.state === 'Demo Song – Demo Band feat. Guest', 'after a reload: the sensor shows the song again', again);

user.close();
ws.close();
console.log(failures() ? `${failures()} FAILED` : 'all ok');
process.exit(failures() ? 1 : 0);
