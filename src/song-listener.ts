/**
 * Song recognition: the scheduler of a listening browser (loaded only there, see song.ts). One microphone, one
 * round at a time; wakes for the next due round only (no polling).
 */
import type { CaptureFailure } from './song-capture';
import { LISTEN_MS, type SongDevice, type SongResult } from './song';

/** Wait after switching on / coming back before the first round */
const START_DELAY = 5000;

export interface SongHost {
  /** The fingerprint to the companion; resolves with the song or null (no match) */
  lookup(dev: SongDevice, fingerprint: string, duration: number): Promise<SongResult | null>;
  /** Listening started / stopped, or listening became impossible */
  changed(): void;
}

interface Slot extends SongDevice {
  on: boolean;
  next: number;
}

/**
 * One microphone, one round at a time. `update()` with the devices and their on-state on every change; the
 * scheduler wakes for the next due round only (no polling).
 */
export class SongListener {
  listenMs = LISTEN_MS;
  /** Clock (tests move it) */
  now = () => Date.now();
  /** Why this browser no longer listens (until the page is reloaded) */
  blocked?: CaptureFailure | 'no_server';
  /** Last failure of a round that is tried again later (no sound, audio still locked) */
  lastIssue?: CaptureFailure;
  private slots = new Map<string, Slot>();
  private busy?: { item: string; name: string; abort: AbortController };
  private timer?: number;
  private readonly vis = () => this.visibility();

  constructor(private host: SongHost) {
    document.addEventListener('visibilitychange', this.vis);
  }

  /** Name of the device being listened for right now */
  get listening(): string | undefined {
    return this.busy?.name;
  }

  update(list: (SongDevice & { on: boolean })[]): void {
    const now = this.now();
    const seen = new Set<string>();
    for (const d of list) {
      seen.add(d.item);
      const prev = this.slots.get(d.item);
      const next = d.on ? (prev?.on ? prev.next : now + START_DELAY) : 0;
      this.slots.set(d.item, { ...d, next });
      if (!d.on && this.busy?.item === d.item) this.stop();
    }
    for (const k of [...this.slots.keys()]) if (!seen.has(k)) this.slots.delete(k);
    if (this.busy && !this.slots.get(this.busy.item)?.on) this.stop();
    this.wake();
  }

  /** Plans the next round (tests call it after moving the clock) */
  wake(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.busy || this.blocked || document.hidden) return;
    let due = Infinity;
    for (const s of this.slots.values()) if (s.on) due = Math.min(due, s.next);
    if (due === Infinity) return;
    this.timer = window.setTimeout(() => void this.round(), Math.min(2 ** 31 - 1, Math.max(0, due - this.now())));
  }

  dispose(): void {
    document.removeEventListener('visibilitychange', this.vis);
    clearTimeout(this.timer);
    this.stop();
    this.slots.clear();
  }

  private stop() {
    this.busy?.abort.abort();
  }

  private visibility() {
    if (document.hidden) {
      // never listen in the background
      this.stop();
      clearTimeout(this.timer);
      return;
    }
    const now = this.now();
    for (const s of this.slots.values()) if (s.on) s.next = Math.max(s.next, now + START_DELAY);
    this.wake();
  }

  private async round() {
    const now = this.now();
    const s = [...this.slots.values()].filter((x) => x.on && x.next <= now).sort((a, b) => a.next - b.next)[0];
    if (!s || this.busy || this.blocked || document.hidden) return this.wake();
    s.next = now + s.interval * 60000;
    const abort = new AbortController();
    this.busy = { item: s.item, name: s.name, abort };
    this.host.changed();
    try {
      const { listen } = await import('./song-capture');
      const { fingerprint, duration } = await listen(this.listenMs, abort.signal);
      this.lastIssue = undefined;
      if (this.busy?.abort === abort) this.busy = undefined;
      this.host.changed();
      await this.host.lookup(s, fingerprint, duration).catch((e: { code?: string }) => {
        // no companion, an old one or no API key there: no use listening again on this page
        if (e?.code === 'unknown_command' || e?.code === 'not_loaded' || e?.code === 'no_api_key') this.blocked = 'no_server';
        else console.warn('[floorplan-card] song lookup', e);
      });
    } catch (e) {
      const kind = (e as { kind?: CaptureFailure })?.kind ?? 'failed';
      if (kind === 'denied' || kind === 'unsupported' || kind === 'no_mic') this.blocked = kind;
      else if (kind !== 'aborted') this.lastIssue = kind;
      if (kind === 'failed') console.warn('[floorplan-card] song recognition', e);
    } finally {
      if (this.busy?.abort === abort) this.busy = undefined;
      this.host.changed();
      this.wake();
    }
  }
}

