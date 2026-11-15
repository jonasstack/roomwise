// Song recognition of an infrared media device (song.ts, song-capture.ts): nobody listens unless this browser was picked;
// it listens only while the device is on, at the interval, never while the page is hidden, stops at once when the
// device goes off; the microphone indicator shows while it listens; the Chromaprint fingerprint (real WebAssembly, the
// browser's fake microphone) and the duration go to floorplan_card/song/lookup (answered by the mock), nothing else;
// a denied microphone stops it for the page; the media popup shows the last song ("Läuft gerade …, erkannt vor 2 Min.")
// and follows a new one. Mock harness (no Home Assistant, neutral demo home).
//   node tools/build.mjs && sh tools/heavy.sh browser node tools/tests/song.mjs [outDir]
import { openMock, demoHome, demoStates, demoEntities } from './mock.mjs';

// audio may start without a tap (the wall tablet case after its first tap)
process.env.PW_ARGS = [process.env.PW_ARGS ?? '', '--autoplay-policy=no-user-gesture-required'].join(' ');
const out = process.argv[2];
let fails = 0;
const ok = (c, m, extra) => {
  if (!c) fails++;
  console.log(c ? '• ok:' : '• FAIL:', m, !c && extra !== undefined ? JSON.stringify(extra).slice(0, 300) : '');
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const cfg = demoHome();
const tv = { id: 'tv', kind: 'tv', name: 'Fernseher', x: 300, y: 20, w: 145, h: 8, media: { power: { script: 'script.demo_ir_power' }, recognize: { enabled: true, entity: 'switch.demo_tv_plug' } } };
cfg.floors[0].furniture.push(tv);
const ago = new Date(Date.now() - 125000).toISOString();
const m = await openMock({
  config: { ...cfg, view_mode: '2d' },
  states: { ...demoStates(), 'switch.demo_tv_plug': { state: 'off', attributes: { friendly_name: 'TV-Steckdose' } }, 'script.demo_ir_power': { state: 'off' } },
  entities: demoEntities,
  size: '1280x900',
  ws: {
    'floorplan_card/song/lookup': { match: true, song: { title: 'Demo Song', artist: 'Demo Band', album: 'Demo Album', at: new Date().toISOString() } },
    'floorplan_card/songs': { songs: { tv: { title: 'Older Song', artist: 'Demo Band', at: ago } } },
  },
});
const { page } = m;
// a stand-in microphone (the mock page is no secure context, so the browser offers none): a chord with a melody,
// counted, its streams kept (were they stopped?)
await page.evaluate(() => {
  window.__mic = { asks: 0, streams: [] };
  const getUserMedia = async () => {
    window.__mic.asks++;
    const ac = new AudioContext();
    const dst = ac.createMediaStreamDestination();
    const g = ac.createGain();
    g.gain.value = 0.3;
    g.connect(dst);
    for (const [i, f] of [220, 277, 330].entries()) {
      const o = ac.createOscillator();
      o.type = i ? 'sine' : 'sawtooth';
      o.frequency.value = f;
      for (let k = 0; k < 40; k++) o.frequency.setValueAtTime(f * [1, 1.12, 1.26, 1.5][(k + i) % 4], ac.currentTime + k * 0.25);
      o.connect(g);
      o.start();
    }
    const s = dst.stream;
    for (const t of s.getTracks()) t.addEventListener('ended', () => ac.close());
    window.__mic.streams.push(s);
    return s;
  };
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  window.__off = 0;
});
const mic = () => page.evaluate(() => ({ asks: window.__mic.asks, live: window.__mic.streams.filter((s) => s.getTracks().some((t) => t.readyState === 'live')).length }));
const lookups = () => page.evaluate(() => window.__fpWs.filter((x) => x.type === 'floorplan_card/song/lookup'));
const pill = () => m.card(`card.shadowRoot.querySelector('.mic-on')?.textContent.trim() ?? null`);
// moves the listener's clock and lets it plan again
const ahead = (ms) => page.evaluate((ms) => ((window.__off += ms), window.__fpCard.song?.wake(), true), ms);
const setCfg = (c) => m.card(`(card.setConfig(${JSON.stringify(c)}), true)`);

// 1) recognition on, but this browser not picked: nobody listens
await m.setStates({ 'switch.demo_tv_plug': { state: 'on' } });
await wait(300);
ok(!(await m.card('!!card.song')) && (await mic()).asks === 0, 'not picked: no listener, the microphone is never asked');
const me = await page.evaluate(() => localStorage.getItem('roomwise-browser-id'));
ok(/^b[a-z0-9]{6,}$/.test(me ?? ''), 'this browser has its own random id', me);

// 2) picked: listens after the start delay, shows the indicator, sends only fingerprint + duration
tv.media.recognize.listeners = [{ id: me, name: 'Wandtablet' }];
await setCfg({ ...cfg, view_mode: '2d' });
// the scheduler is a chunk of its own, loaded only now
await page.waitForFunction(() => !!window.__fpCard.song, null, { timeout: 5000 }).catch(() => undefined);
ok(await page.evaluate(() => [...document.querySelectorAll('script')].length >= 0 && !!window.__fpCard.song), 'picked: the scheduler is loaded');
await m.card(`(card.song.listenMs = 3000, card.song.now = () => Date.now() + window.__off, card.song.wake(), true)`);
await wait(300);
ok((await mic()).asks === 0, 'switched on: waits a moment first');
await ahead(6000);
await wait(700);
ok((await mic()).asks === 1 && (await mic()).live === 1, 'then listens (one microphone stream)', await mic());
ok(/Mikrofon an/.test((await pill()) ?? '') && /Fernseher/.test((await pill()) ?? ''), 'indicator in the card while listening', await pill());
if (out) await page.screenshot({ path: `${out}/song-listening.png` });
await page.waitForFunction(() => window.__fpWs.some((x) => x.type === 'floorplan_card/song/lookup'), null, { timeout: 15000 }).catch(() => undefined);
let l = await lookups();
ok(l.length === 1, 'one lookup sent', l.length);
const q = l[0] ?? {};
ok(typeof q.fingerprint === 'string' && /^[A-Za-z0-9_-]{20,}$/.test(q.fingerprint) && q.duration === 3, 'Chromaprint fingerprint (base64url) and the seconds heard', { fp: String(q.fingerprint).slice(0, 40), duration: q.duration });
ok(Object.keys(q).sort().join() === 'card_id,duration,fingerprint,item_id,name,type' && q.item_id === 'tv' && q.name === 'Fernseher', 'nothing but ids, name, fingerprint, duration', Object.keys(q));
ok((await mic()).live === 0 && (await pill()) === null, 'after the round: microphone off, indicator gone', await mic());

// 3) interval: not again after 1 min, again after 3 min
await ahead(60000);
await wait(400);
ok((await mic()).asks === 1, 'not again after a minute');
await ahead(125000);
await wait(700);
ok((await mic()).asks === 2 && (await mic()).live === 1, 'again after 3 minutes', await mic());
// 4) the device goes off while listening: stops at once, nothing sent
await m.setStates({ 'switch.demo_tv_plug': { state: 'off' } });
await wait(250);
ok((await mic()).live === 0 && (await pill()) === null, 'device off: microphone stopped right away');
await wait(3500);
ok((await lookups()).length === 1, 'nothing sent for the interrupted round');
await ahead(10 * 60000);
await wait(400);
ok((await mic()).asks === 2, 'off: no more rounds');

// 5) page hidden: stops, no rounds while hidden, starts again after coming back
await m.setStates({ 'switch.demo_tv_plug': { state: 'on' } });
await ahead(6000);
await wait(700);
ok((await mic()).live === 1, 'on again: listens');
const hide = (h) => page.evaluate((h) => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
  document.dispatchEvent(new Event('visibilitychange'));
}, h);
await hide(true);
await wait(250);
ok((await mic()).live === 0 && (await pill()) === null, 'page hidden: microphone stopped right away');
await ahead(10 * 60000);
await wait(400);
const asksHidden = (await mic()).asks;
ok(asksHidden === 3, 'hidden: no rounds', asksHidden);
await hide(false);
await wait(300);
ok((await mic()).asks === 3, 'visible again: waits a moment first');
await ahead(6000);
await wait(700);
ok((await mic()).asks === 4, 'then listens again');
await page.waitForFunction(() => window.__fpWs.filter((x) => x.type === 'floorplan_card/song/lookup').length >= 2, null, { timeout: 15000 }).catch(() => undefined);

// 6) the popup shows the last song, and a new one as it comes
await m.card(`(card.gesture({ kind: 'furniture', id: 'tv' }, 'tap'), true)`);
await wait(700);
const POP = `document.querySelector('floorplan-card-layer').shadowRoot.querySelector('fp-media-player-popup')`;
const song = () => page.evaluate(`(() => { const r = ${POP}?.shadowRoot; return r ? [r.querySelector('.song-title')?.textContent.trim() ?? null, r.querySelector('.song-age')?.textContent.trim() ?? null] : null; })()`);
const s1 = await song();
ok(s1?.[0] === 'Läuft gerade: Older Song – Demo Band' && /^erkannt vor [23] Min\.$/.test(s1?.[1] ?? ''), 'popup: last song from the companion with its age', s1);
ok((await page.evaluate(() => window.__fpWs.filter((x) => x.type === 'floorplan_card/songs').map((x) => x.card_id))).length >= 1, 'popup asked floorplan_card/songs for the card');
if (out) await page.screenshot({ path: `${out}/song-popup.png` });
const cardKey = await page.evaluate(() => window.__fpWs.find((x) => x.type === 'floorplan_card/songs')?.card_id);
await page.evaluate((card) => window.dispatchEvent(new CustomEvent('roomwise-song', { detail: { card, item: 'tv', song: { title: 'Neues Lied', at: new Date().toISOString() } } })), cardKey);
await wait(200);
const s2 = await song();
ok(s2?.[0] === 'Läuft gerade: Neues Lied' && s2?.[1] === 'gerade erkannt', 'popup: follows a song recognized meanwhile (no artist: title only)', s2);
await m.setStates({ 'switch.demo_tv_plug': { state: 'off' } });
await page.keyboard.press('Escape');
await wait(400);

// 7) microphone denied: a hint once, then this page does not try again
await page.evaluate(() => {
  navigator.mediaDevices.getUserMedia = async () => {
    window.__mic.asks++;
    throw new DOMException('Permission denied', 'NotAllowedError');
  };
});
await m.setStates({ 'switch.demo_tv_plug': { state: 'on' } });
await ahead(6000);
await wait(800);
const toast = await page.evaluate(() => document.querySelector('floorplan-card-layer')?.shadowRoot?.querySelector('.toast')?.textContent.trim() ?? null);
ok(/nicht erlaubt/.test(toast ?? ''), 'denied: the card says so', toast);
ok((await m.card('card.song.blocked')) === 'denied', 'denied: blocked for this page');
const asksDenied = (await mic()).asks;
await ahead(30 * 60000);
await wait(400);
ok((await mic()).asks === asksDenied, 'denied: not asked again');

// 8) editor: pick / drop this browser, HTTPS and server hints, interval, switch off
await m.card(`(card.openEditor(), true)`);
await wait(2000);
const ED = `document.querySelector('floorplan-card-layer').shadowRoot.querySelector('floorplan-card-editor-ui')`;
const ed = (expr) => page.evaluate(`(() => { const ed = ${ED}; const r = ed.shadowRoot; return ${expr}; })()`);
await ed(`(ed.select({ kind: 'furniture', id: 'tv' }), true)`);
await wait(400);
const rec = () => ed(`ed._draft.floors[0].furniture.find((x) => x.id === 'tv').media.recognize`);
ok(await ed(`!!r.querySelector('[data-song]') && !!r.querySelector('[data-song-listener="${me}"]') && !r.querySelector('[data-song-add]')`), 'editor: song section, this browser listed, no "add" button');
ok(await ed(`!!r.querySelector('[data-song-https]') && !!r.querySelector('[data-song-server]')`), 'editor: explains HTTPS (page is http) and the missing companion');
await ed(`(r.querySelector('[data-song-listener="${me}"] [data-song-remove]').click(), true)`);
await wait(200);
ok(((await rec()).listeners ?? []).length === 0 && (await ed(`!!r.querySelector('[data-song-add]')`)), 'editor: browser removed, "let this device listen" offered');
await ed(`(r.querySelector('[data-song-add]').click(), true)`);
await wait(200);
let rc = await rec();
ok(rc.listeners?.length === 1 && rc.listeners[0].id === me && /·/.test(rc.listeners[0].name), 'editor: this browser added with a neutral name', rc.listeners);
await ed(`(() => { const i = r.querySelector('[data-song-interval]'); i.value = '5'; i.dispatchEvent(new Event('change')); return true; })()`);
await wait(200);
ok((await rec()).interval === 5, 'editor: interval 5 min');
await ed(`([...r.querySelectorAll('[data-song] button.switch')][0].click(), true)`);
await wait(200);
rc = await rec();
ok(!rc.enabled && rc.listeners?.length === 1, 'editor: switched off (choices kept)', rc);
if (out) await page.screenshot({ path: `${out}/song-editor.png` });
await page.keyboard.press('Escape');
await wait(400);

// 9) the card leaves the page: listener gone
await m.card(`(card.remove(), true)`);
ok(!(await page.evaluate(() => !!window.__fpCard.song)), 'card removed: listener disposed');

ok(!m.errors.some((e) => /pageerror|wasm|chromaprint/i.test(e)), 'no page errors', m.errors.filter((e) => /pageerror|wasm|chromaprint/i.test(e)));
await m.browser.close();
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
