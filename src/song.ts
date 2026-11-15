/**
 * Song recognition for media devices that cannot report what they play (infrared): the scheduler in the card.
 * Only a browser the owner picked for a device listens, only while that device is on, only while the page is visible,
 * every few minutes for about 10 s. The scheduler (song-listener.ts) and listening / fingerprinting (song-capture.ts)
 * are loaded only on a browser that listens;
 * only the fingerprint goes to the companion integration, which asks AcoustID. Off by default everywhere.
 */
import type { FloorplanCardConfig, HomeAssistant, MediaControlsConfig, SongRecognizeConfig } from './types';
import { browserOf, screenOf } from './client-info';

const ID_KEY = 'roomwise-browser-id';
/** Seconds of sound per round, minutes between rounds (default), wait after switching on / coming back */
export const LISTEN_MS = 10000;
export const DEFAULT_INTERVAL = 3;
/** A result older than this is not shown as "playing now" */
export const SONG_MAX_AGE = 60 * 60000;
/** Window event when this browser recognized a song (an open popup updates) */
export const SONG_EVENT = 'roomwise-song';

export interface SongResult {
  title: string;
  artist?: string;
  album?: string;
  /** ISO time of the recognition */
  at: string;
}

let memoId: string | undefined;
/** This browser's own random id (kept in its local storage): how the editor names the browsers that may listen */
export function browserId(): string {
  if (memoId) return memoId;
  try {
    memoId = localStorage.getItem(ID_KEY) ?? undefined;
    if (!memoId) localStorage.setItem(ID_KEY, (memoId = 'b' + Math.random().toString(36).slice(2, 12)));
  } catch {
    // no storage (private window): an id for this page load only
  }
  return (memoId ??= 'b' + Math.random().toString(36).slice(2, 12));
}

/** A first name for this browser in the editor: screen class and browser family, nothing that names the device */
export function defaultBrowserName(): string {
  const b = browserOf(navigator.userAgent).browser;
  const fam: Record<string, string> = { ha_app: 'Home Assistant App', fully: 'Fully Kiosk', samsung: 'Samsung Internet', edge: 'Edge', opera: 'Opera', firefox: 'Firefox', chrome: 'Chrome', safari: 'Safari' };
  const s = screenOf();
  return `${s === 'phone' ? 'Phone' : s === 'tablet' ? 'Tablet' : 'Desktop'} · ${fam[b] ?? 'Browser'}`;
}

/** Recognition switched on for this media block at all */
export const songEnabled = (m: MediaControlsConfig | undefined): m is MediaControlsConfig & { recognize: SongRecognizeConfig } => !!m?.recognize?.enabled;

/** Is the device on? undefined = nothing tells (no entity): then nobody listens */
export function deviceOn(hass: HomeAssistant, entity: string | undefined): boolean | undefined {
  const s = entity ? hass.states[entity] : undefined;
  if (!s) return undefined;
  return !['off', 'standby', 'unavailable', 'unknown', 'idle', 'paused', ''].includes(s.state);
}

export interface SongDevice {
  item: string;
  name: string;
  /** Entity that tells whether the device is on */
  entity?: string;
  interval: number;
}

/** The media devices of a plan this browser should listen for */
export function songDevices(cfg: FloorplanCardConfig | undefined, nameOf: (item: { name?: string; entity?: string; kind?: string }) => string): SongDevice[] {
  const me = browserId();
  const out: SongDevice[] = [];
  for (const fl of cfg?.floors ?? [])
    for (const x of [...(fl.furniture ?? []), ...(fl.devices ?? [])] as { id: string; name?: string; entity?: string; kind?: string; media?: MediaControlsConfig }[]) {
      if (!songEnabled(x.media) || !x.media.recognize.listeners?.some((l) => l.id === me)) continue;
      const r = x.media.recognize;
      out.push({ item: x.id, name: nameOf(x), entity: r.entity || x.entity, interval: Math.min(60, Math.max(1, Number(r.interval) || DEFAULT_INTERVAL)) });
    }
  return out;
}

/** "vor 2 Min." style age of a result in minutes (0 = just now) */
export const songAgeMin = (r: SongResult, now = Date.now()) => Math.max(0, Math.floor((now - Date.parse(r.at)) / 60000));
