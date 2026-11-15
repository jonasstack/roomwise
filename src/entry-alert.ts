import type { EntryAlertConfig, FloorplanCardConfig, HassEntity, HomeAssistant, OpeningConfig } from './types';
import { openingState } from './openings';
import { pointInPolygon } from './geometry';
import { getLanguage } from './i18n';
import { ackServer, serverActive, serverKey, subscribeAlert, type ServerAlertState } from './entry-server';

/**
 * Front door warning. When the front door opens while windows are open:
 * open windows blink, a pop-up lists them, a remote button (or the pop-up) acknowledges; without
 * acknowledgement an announcement is spoken via TTS after a timeout — general, all at once, or one
 * window after another in a checking order (the next one once the previous is closed).
 * The warning ends when acknowledged or when all windows are closed.
 *
 * Runs in the card, i.e. on devices that show the dashboard; `announce_users` limits who speaks.
 */
export interface OpenWindow {
  id: string;
  name: string;
}

export interface EntryAlertState {
  active: boolean;
  /** 'alarm': triangle, red sky, pulsing windows, announcement pending; 'linger': acknowledged, windows still marked for a few seconds */
  phase?: 'alarm' | 'linger';
  windows: OpenWindow[];
  /** Seconds until the announcement (while waiting) */
  remaining?: number;
  spoken: boolean;
}

export const ENTRY_DEFAULTS = {
  timeout: 30,
  mode: 'all' as const,
  blink: true,
  /** Seconds the open windows stay marked after acknowledging */
  linger: 5,
};

export function defaultTexts() {
  return getLanguage() === 'en'
    ? { general: 'Attention, windows are still open.', all: 'Still open: {fenster}.', single: '{fenster} is still open.' }
    : { general: 'Achtung, es sind noch Fenster offen.', all: 'Noch offen: {fenster}.', single: '{fenster} ist noch offen.' };
}

export class EntryAlertController {
  state: EntryAlertState = { active: false, windows: [], spoken: false };
  private doorOpen?: boolean;
  private ackBaseline?: string;
  private timer?: number;
  private countdown?: number;
  private current?: string;
  private lingerTimer?: number;
  private hass?: HomeAssistant;
  private cfg?: FloorplanCardConfig;

  constructor(
    private getState: (id: string) => HassEntity | undefined,
    private onChange: () => void,
  ) {}

  private get ec(): EntryAlertConfig | undefined {
    return this.cfg?.entry_alert;
  }

  private door(): OpeningConfig | undefined {
    const id = this.ec?.door;
    if (!id) return undefined;
    for (const f of this.cfg?.floors ?? []) {
      const o = f.openings?.find((x) => x.id === id);
      if (o) return o;
    }
    return undefined;
  }

  windows(): OpenWindow[] {
    return this.cfg ? windowsOf(this.cfg) : [];
  }

  private openWindows(): OpenWindow[] {
    const byId = new Map<string, string>();
    for (const f of this.cfg?.floors ?? []) for (const o of f.openings ?? []) if (o.entity) byId.set(o.id, o.entity);
    return this.windows().filter((w) => openingState(this.getState(byId.get(w.id)!)) === 'open');
  }

  private ackStamp(): string | undefined {
    const id = this.ec?.ack_entity;
    if (!id) return undefined;
    const s = this.getState(id);
    return s ? `${s.state}|${s.last_changed}` : undefined;
  }

  /** Hausregeln runs the window warning (its Fenster-Warnung beim Gehen is on): set by the card */
  private hr?: { ack: () => void; st: ServerAlertState | null };
  private hrSig?: string;

  /** Follow Hausregeln' warning (`st` = its state, `ack` acknowledges there), or stop following (null) */
  setHr(link: { st?: ServerAlertState | null; ack: () => void } | null) {
    if (!link) {
      if (!this.hr) return;
      this.hr = undefined;
      this.hrSig = undefined;
      this.mirror(null);
      return;
    }
    this.hr = { ack: link.ack, st: link.st ?? null };
    this.follow(false);
    const sig = JSON.stringify(link.st ?? null);
    if (sig !== this.hrSig) {
      this.hrSig = sig;
      this.mirror(link.st ?? null);
    }
  }

  /** Call on every hass update */
  update(hass: HomeAssistant, cfg: FloorplanCardConfig) {
    const cfgChanged = cfg !== this.cfg;
    this.hass = hass;
    this.cfg = cfg;
    // Hausregeln runs it: nothing here but showing its state (setHr); windows are found through the plan's openings
    if (this.hr) {
      if (cfgChanged) this.mirror(this.hr.st);
      return;
    }
    // the server runs the warning: every tablet shows the server's state (same windows, same moment,
    // acknowledged everywhere at once)
    if (this.server()) {
      this.follow(true);
      const door = this.door();
      this.doorOpen = door?.entity ? openingState(this.getState(door.entity)) === 'open' : undefined;
      return;
    }
    this.follow(false);
    const door = this.door();
    if (!door?.entity) {
      if (this.state.active) this.finish();
      this.doorOpen = undefined;
      return;
    }
    const open = openingState(this.getState(door.entity)) === 'open';
    const opened = this.doorOpen === false && open; // only a real transition, not the first state seen
    this.doorOpen = open;
    if (opened) this.start();
    if (!this.state.active) return;
    // acknowledged remotely?
    const stamp = this.ackStamp();
    if (this.state.phase === 'alarm' && stamp !== undefined && stamp !== this.ackBaseline) this.acknowledge();
    const windows = this.openWindows();
    if (!windows.length) return this.finish();
    const changed = windows.map((w) => w.id).join() !== this.state.windows.map((w) => w.id).join();
    this.state = { ...this.state, windows };
    // one after another: the current window was closed -> announce the next one
    if (this.state.phase === 'alarm' && this.state.spoken && (this.ec?.mode ?? ENTRY_DEFAULTS.mode) === 'sequential' && this.current && !windows.some((w) => w.id === this.current)) {
      this.current = windows[0].id;
      this.speak(this.text('single', [windows[0]]));
    }
    if (changed) this.onChange();
  }

  /** Simulate / test from the editor */
  start() {
    const windows = this.openWindows();
    if (!windows.length) return;
    this.clearTimers();
    this.ackBaseline = this.ackStamp();
    this.current = undefined;
    const timeout = Math.max(0, this.ec?.timeout ?? ENTRY_DEFAULTS.timeout);
    this.state = { active: true, phase: 'alarm', windows, spoken: false, remaining: timeout };
    this.timer = window.setTimeout(() => this.announce(), timeout * 1000);
    if (this.ec?.flash_lights?.length && this.mayAnnounce() && !this.server()) void this.flashLights(this.ec.flash_lights);
    this.onChange();
  }

  /** The companion integration speaks and flashes; the cards only show the warning */
  private server(): boolean {
    return !!this.hr || serverActive(this.hass, this.cfg);
  }

  private sub?: Promise<() => void>;

  /** Subscribe to (or leave) the server's warning state */
  private follow(on: boolean) {
    if (on === !!this.sub) return;
    if (!on) {
      void this.sub?.then((u) => u()).catch(() => {});
      this.sub = undefined;
      return;
    }
    const hass = this.hass!;
    this.sub = subscribeAlert(hass, serverKey(this.cfg), (st) => this.mirror(st));
    this.sub.catch(() => (this.sub = undefined));
  }

  /** Show what the server says */
  private mirror(st: ServerAlertState | null) {
    this.clearTimers();
    clearTimeout(this.lingerTimer);
    if (!st?.active) {
      if (this.state.active) {
        this.state = { active: false, windows: [], spoken: false };
        this.onChange();
      }
      return;
    }
    const byEntity = new Map<string, string>();
    for (const f of this.cfg?.floors ?? []) for (const o of f.openings ?? []) if (o.entity) byEntity.set(o.entity, o.id);
    const names = new Map(this.windows().map((w) => [w.id, w.name]));
    const windows = st.windows.map((e) => byEntity.get(e)).filter((id): id is string => !!id).map((id) => ({ id, name: names.get(id) ?? id }));
    const tick = () => {
      const remaining = st.deadline ? Math.max(0, Math.ceil((st.deadline - Date.now()) / 1000)) : undefined;
      this.state = { active: true, phase: st.phase === 'linger' ? 'linger' : 'alarm', windows, spoken: st.spoken, remaining };
      this.onChange();
    };
    tick();
    if (st.deadline && st.phase === 'alarm') this.countdown = window.setInterval(tick, 1000);
  }

  /** Button press or a tap on the tablet: alarm off, open windows stay marked for a few seconds */
  acknowledge(fromTap = false) {
    if (!this.state.active || this.state.phase === 'linger') return;
    // server warning: acknowledged there, every tablet gets the result
    if (this.server()) {
      if (fromTap) {
        if (this.hr) this.hr.ack();
        else ackServer(this.hass, this.cfg);
      }
      this.state = { ...this.state, phase: 'linger', remaining: undefined };
      this.onChange();
      return;
    }
    this.flashAbort = true; // lights return to their state right away
    this.clearTimers();
    this.current = undefined;
    this.state = { ...this.state, phase: 'linger', remaining: undefined };
    this.lingerTimer = window.setTimeout(() => this.finish(), ENTRY_DEFAULTS.linger * 1000);
    this.onChange();
  }

  private finish() {
    this.clearTimers();
    clearTimeout(this.lingerTimer);
    this.current = undefined;
    this.state = { active: false, windows: [], spoken: false };
    this.onChange();
  }

  private clearTimers() {
    clearTimeout(this.timer);
    clearInterval(this.countdown);
    this.timer = undefined;
    this.countdown = undefined;
  }

  private announce() {
    clearInterval(this.countdown);
    this.countdown = undefined;
    const windows = this.openWindows();
    if (!windows.length) return this.finish();
    this.state = { ...this.state, windows, spoken: true, remaining: undefined };
    const mode = this.ec?.mode ?? ENTRY_DEFAULTS.mode;
    if (mode === 'general') this.speak(this.text('general', windows));
    else if (mode === 'all') this.speak(this.text('all', windows));
    else if (mode === 'sequential') {
      this.current = windows[0].id;
      this.speak(this.text('single', [windows[0]]));
    }
    this.onChange();
  }

  text(kind: 'general' | 'all' | 'single', windows: OpenWindow[]) {
    const d = defaultTexts();
    const tpl = (kind === 'general' ? this.ec?.text_general : kind === 'all' ? this.ec?.text_all : this.ec?.text_single) || d[kind];
    const and = getLanguage() === 'en' ? ' and ' : ' und ';
    const names = windows.map((w) => w.name);
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')}${and}${names[names.length - 1]}` : (names[0] ?? '');
    return tpl.replaceAll('{fenster}', list).replaceAll('{anzahl}', String(windows.length));
  }

  /** Whether this device should speak (announce_users) */
  private mayAnnounce(): boolean {
    const users = this.ec?.announce_users;
    if (!users?.length) return true;
    return !!this.hass?.user?.id && users.includes(this.hass.user.id);
  }

  // ---------- Attention: lights flash red ----------

  private flashing = false;
  private flashAbort = false;

  /** Flash the lights red at 100 % three times, then restore each light's previous state */
  private async flashLights(ids: string[]) {
    const hass = this.hass;
    if (!hass || this.flashing) return;
    const lights = ids.filter((id) => id.startsWith('light.') && this.getState(id) && this.getState(id)!.state !== 'unavailable');
    if (!lights.length) return;
    this.flashing = true;
    this.flashAbort = false;
    const saved = lights.map((id) => ({ id, restore: restoreData(this.getState(id)!) }));
    const color = lights.filter((id) => supportsColor(this.getState(id)!));
    const plain = lights.filter((id) => !color.includes(id));
    const call = (service: string, entity: string[], data: Record<string, unknown> = {}) =>
      entity.length ? hass.callService('light', service, data, { entity_id: entity }).catch((e: unknown) => console.warn('floorplan-card: light flash', e)) : Promise.resolve();
    const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
    try {
      for (let i = 0; i < FLASHES && !this.flashAbort; i++) {
        await Promise.all([call('turn_on', color, { rgb_color: [255, 0, 0], brightness: 255, transition: 0 }), call('turn_on', plain, { brightness: 255, transition: 0 })]);
        await wait(FLASH_ON_MS);
        await call('turn_off', lights, { transition: 0 });
        await wait(FLASH_OFF_MS);
      }
    } finally {
      // previous state: off stays off; on gets its brightness and color (mode) back
      await Promise.all(saved.map(({ id, restore }) => (restore ? call('turn_on', [id], { ...restore, transition: 0 }) : call('turn_off', [id], { transition: 0 }))));
      this.flashing = false;
    }
  }

  private async speak(message: string) {
    const ec = this.ec;
    const hass = this.hass;
    if (!hass || !ec?.tts_entity || !ec.media_player || !message || !this.mayAnnounce() || this.server()) return;
    const language = ec.tts_language || (await ttsLanguage(hass, ec.tts_entity));
    hass
      .callService(
        'tts',
        'speak',
        { media_player_entity_id: ec.media_player, message, cache: true, ...(language ? { language } : {}) },
        { entity_id: ec.tts_entity },
      )
      .catch((err: unknown) => console.warn('floorplan-card: TTS failed', err));
  }

  destroy() {
    this.follow(false);
    this.clearTimers();
    clearTimeout(this.lingerTimer);
  }
}

/** All windows with a contact sensor, in checking order, with readable names ("Küche Fenster 2");
 * the ones the owner left out (`entry_alert.exclude`) only with `withExcluded` (editor) */
export function windowsOf(cfg: FloorplanCardConfig, withExcluded = false): OpenWindow[] {
  const all: OpenWindow[] = [];
  const excluded = new Set(withExcluded ? [] : (cfg.entry_alert?.exclude ?? []));
  for (const f of cfg.floors ?? []) {
    const wins = (f.openings ?? []).filter((o) => o.type === 'window' && o.entity);
    for (const o of wins) {
      if (excluded.has(o.id)) continue;
      const mid: [number, number] = [(o.a[0] + o.b[0]) / 2, (o.a[1] + o.b[1]) / 2];
      const room = f.rooms.find((r) => r.points.length >= 3 && nearPolygon(mid, r.points));
      const sameRoom = wins.filter((w) => room && nearPolygon([(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2], room.points));
      const idx = sameRoom.indexOf(o);
      const base = getLanguage() === 'en' ? 'window' : 'Fenster';
      const name = o.name ?? (room ? `${room.name} ${base}${sameRoom.length > 1 ? ` ${idx + 1}` : ''}` : base);
      all.push({ id: o.id, name });
    }
  }
  const order = cfg.entry_alert?.order ?? [];
  return all.sort((a, b) => rank(order, a.id) - rank(order, b.id));
}

const FLASHES = 3;
const FLASH_ON_MS = 700;
const FLASH_OFF_MS = 550;
const COLOR_MODES = ['hs', 'xy', 'rgb', 'rgbw', 'rgbww'];

function supportsColor(s: HassEntity): boolean {
  const modes = (s.attributes.supported_color_modes as string[] | undefined) ?? [];
  return modes.some((m) => COLOR_MODES.includes(m));
}

/** Service data that brings a light back to its current state (undefined = it is off) */
export function restoreData(s: HassEntity): Record<string, unknown> | undefined {
  if (s.state !== 'on') return undefined;
  const a = s.attributes;
  const data: Record<string, unknown> = {};
  if (typeof a.brightness === 'number') data.brightness = a.brightness;
  switch (a.color_mode) {
    case 'hs':
      if (a.hs_color) data.hs_color = a.hs_color;
      break;
    case 'xy':
      if (a.xy_color) data.xy_color = a.xy_color;
      break;
    case 'rgb':
      if (a.rgb_color) data.rgb_color = a.rgb_color;
      break;
    case 'rgbw':
      if (a.rgbw_color) data.rgbw_color = a.rgbw_color;
      break;
    case 'rgbww':
      if (a.rgbww_color) data.rgbww_color = a.rgbww_color;
      break;
    case 'color_temp':
      if (typeof a.color_temp_kelvin === 'number') data.color_temp_kelvin = a.color_temp_kelvin;
      else if (typeof a.color_temp === 'number') data.color_temp = a.color_temp;
      break;
  }
  if (a.effect && a.effect !== 'none' && Array.isArray(a.effect_list) && a.effect_list.includes(a.effect)) data.effect = a.effect;
  return data;
}

const langCache = new Map<string, Promise<string[]>>();

/** Languages a TTS engine supports (cached) */
export function ttsLanguages(hass: HomeAssistant, engine: string): Promise<string[]> {
  if (!langCache.has(engine))
    langCache.set(
      engine,
      hass
        .callWS<{ provider?: { supported_languages?: string[] } }>({ type: 'tts/engine/get', engine_id: engine })
        .then((r) => r.provider?.supported_languages ?? [])
        .catch(() => []),
    );
  return langCache.get(engine)!;
}

/** Home Assistant's language matched to what the engine supports ("de" → "de" or "de-DE") */
export async function ttsLanguage(hass: HomeAssistant, engine: string): Promise<string | undefined> {
  const want = (hass.locale?.language ?? hass.language ?? 'en').toLowerCase();
  const base = want.split('-')[0];
  const langs = await ttsLanguages(hass, engine);
  const lower = langs.map((l) => l.toLowerCase());
  const pick =
    langs[lower.indexOf(want)] ??
    langs[lower.indexOf(base)] ??
    langs[lower.indexOf(`${base}-${base}`)] ??
    langs[lower.findIndex((l) => l.startsWith(base + '-') || l.startsWith(base + '_'))];
  return pick ?? (langs.length ? undefined : base);
}

function rank(order: string[], id: string) {
  const i = order.indexOf(id);
  return i < 0 ? 1e6 : i;
}

/** Point inside or within a wall's width of a room polygon (window midpoints lie on the wall line) */
function nearPolygon(p: [number, number], poly: [number, number][]) {
  if (pointInPolygon(p, poly)) return true;
  for (const [dx, dy] of [[8, 0], [-8, 0], [0, 8], [0, -8]]) if (pointInPolygon([p[0] + dx, p[1] + dy], poly)) return true;
  return false;
}
