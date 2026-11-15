/**
 * "Live an der Lampe": a light setting shown on the real lamps while it is edited.
 *   * previewCall: what light.turn_on gets for one lamp – the rules of lightspec.py service_data (what Hausregeln
 *     sends when the rule runs: brightness in % or exact 0–255, the white channel, colour per lamp capability,
 *     a white-only lamp the nearest white). A colour the lamp has no own mode for goes as rgb_color / hs_color /
 *     xy_color and Home Assistant converts it (rgb_to_xy is the same conversion as Home Assistant's). No fade, no
 *     flash: the preview should show the result at once.
 *   * restoreCall: the lamp's state as it was (on/off, brightness, colour mode + colour, effect) to put it back.
 *   * LightLive: sends throttled (one call per lamp every ~150 ms, the last value wins, calls of one lamp in order),
 *     remembers every lamp before it touches it and puts back exactly the lamps it touched. With a current
 *     integration it hands all of that to house_rules/light/preview (the same rules, run there); previewCall and
 *     restoreCall are the fallback for older integrations and the example data.
 * Lights only (light.*), never locks, covers or anything else.
 */
// i18n: complete
import type { LightAction } from './model';
import { PRESET_K, colorKind, dimmable, hasColor, hasWhite, hexToRgb, lightCaps, nums, toRgb, type LightCaps } from './lightspec';

export interface LampState {
  state: string;
  attributes: Record<string, any>;
}
export type LightSetting = Partial<Omit<LightAction, 'per_light' | 'scene'>>;
export interface LightCall {
  service: 'turn_on' | 'turn_off';
  data: Record<string, unknown>;
}
/** how LightLive reaches the lamps (the store: Home Assistant, or the example data) */
export interface LiveIO {
  state(entityId: string): LampState | undefined;
  call(service: 'turn_on' | 'turn_off', entityId: string, data: Record<string, unknown>): Promise<unknown>;
  /** the integration's preview command (house_rules/light/preview); rejects with code "unknown_command" on older ones */
  preview?(msg: Record<string, unknown>): Promise<unknown>;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const r1 = (v: number) => Math.round(v * 10) / 10;
export const isLight = (e: string) => e.startsWith('light.');

/** CCT of an xy point (McCamy), with the sRGB primaries like lightspec.py xy_to_kelvin(_srgb_xy(…)) */
function nearestKelvin([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => ((c /= 255) > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92);
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const X = R * 0.4124 + G * 0.3576 + B * 0.1805;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const Z = R * 0.0193 + G * 0.1192 + B * 0.9505;
  const s = X + Y + Z;
  const [x, y] = s ? [X / s, Y / s] : [0.3127, 0.329];
  const n = (x - 0.332) / (0.1858 - y || 1e-6);
  return 449 * n ** 3 + 3525 * n ** 2 + 6823.3 * n + 5520.33;
}

/** the colour part of light.turn_on for a lamp with these capabilities (empty: keep the colour / it has none) */
export function previewColor(caps: LightCaps, color: string | undefined): Record<string, unknown> {
  const s = String(color ?? '').trim().toLowerCase();
  let kind = colorKind(s);
  const ct = (k: number) => ({ color_temp_kelvin: Math.trunc(clamp(k, caps.min_k, caps.max_k)) });
  if (kind === 'none') return {};
  let k = kind === 'preset' ? PRESET_K[s] : kind === 'kelvin' ? clamp(nums(s)[0] || 2700, 1000, 12000) : 0;
  if (kind === 'white') {
    if (caps.modes.includes('white')) return { white: true };
    if (hasWhite(caps)) return ct(4000);
    if (!hasColor(caps)) return {};
    k = 4000;
    kind = 'kelvin';
  }
  if (kind === 'preset' || kind === 'kelvin') {
    if (hasWhite(caps)) return ct(k);
    if (!hasColor(caps)) return {};
    const [r, g, b] = toRgb(`k:${Math.round(k)}`);
    return { rgb_color: [r, g, b] };
  }
  // a colour
  if (!hasColor(caps)) return hasWhite(caps) ? ct(nearestKelvin(toRgb(s))) : {};
  const n = nums(s);
  if (kind === 'rgb') return { rgb_color: hexToRgb(s) };
  if (kind === 'hs') return { hs_color: [r1(((n[0] % 360) + 360) % 360), r1(clamp(n[1], 0, 100))] };
  if (kind === 'xy') return { xy_color: [Math.round(clamp(n[0], 0, 1) * 1e4) / 1e4, Math.round(clamp(n[1], 0, 1) * 1e4) / 1e4] };
  // rgbw / rgbww: as they are where the lamp has that mode, else as RGB (Home Assistant converts)
  if (caps.modes.includes(kind)) return { [`${kind}_color`]: n.map((v) => Math.round(clamp(v, 0, 255))) };
  return { rgb_color: toRgb(s) };
}

const bri255 = (a: LightSetting) =>
  typeof a.bri === 'number' ? Math.trunc(clamp(a.bri, 1, 255)) : Math.round(clamp(typeof a.brightness === 'number' ? a.brightness : 100, 1, 100) * 2.55);

/** light.turn_on / turn_off for one lamp so it shows this setting now */
export function previewCall(st: LampState | undefined, a: LightSetting): LightCall {
  if (a.mode === 'off') return { service: 'turn_off', data: {} };
  const caps = lightCaps(st);
  const data: Record<string, unknown> = {};
  if (dimmable(caps)) {
    if (typeof a.bri === 'number') data.brightness = bri255(a);
    else data.brightness_pct = Math.trunc(clamp(typeof a.brightness === 'number' ? a.brightness : 100, 1, 100));
  }
  const col = previewColor(caps, a.color);
  if (col.white) {
    // white mode: the brightness goes into "white" (Home Assistant's way for the white channel)
    delete data.brightness;
    delete data.brightness_pct;
    data.white = bri255(a);
  } else Object.assign(data, col);
  if (a.effect && caps.effects.includes(a.effect)) data.effect = a.effect;
  return { service: 'turn_on', data };
}

/** the call that puts the lamp back the way it was (null: unknown or unavailable, leave it) */
export function restoreCall(st: LampState | null | undefined): LightCall | null {
  if (!st || (st.state !== 'on' && st.state !== 'off')) return null;
  if (st.state === 'off') return { service: 'turn_off', data: {} };
  const a = st.attributes ?? {};
  const data: Record<string, unknown> = {};
  const mode = String(a.color_mode ?? '');
  if (mode === 'white') data.white = typeof a.brightness === 'number' ? a.brightness : 255;
  else if (typeof a.brightness === 'number') data.brightness = Math.max(1, a.brightness);
  const keep = (key: string) => Array.isArray(a[key]) && (data[key] = [...a[key]]);
  if (mode === 'color_temp' && typeof a.color_temp_kelvin === 'number') data.color_temp_kelvin = a.color_temp_kelvin;
  else if (mode === 'hs' || mode === 'rgb' || mode === 'xy' || mode === 'rgbw' || mode === 'rgbww') keep(`${mode}_color`);
  // the effect it had ("off" / "None" too, if its list has it: that ends an effect the preview started)
  if (typeof a.effect === 'string' && ((a.effect_list as string[] | undefined) ?? []).includes(a.effect)) data.effect = a.effect;
  return { service: 'turn_on', data };
}

/** what the lamp reports right now, as values to read and copy: "128/255", "hs", "hs 30, 80", "xy 0.55, 0.4" … */
export function reported(st: LampState | undefined): { on: boolean; values: [string, string][] } | null {
  if (!st) return null;
  const a = st.attributes ?? {};
  const on = st.state === 'on';
  const v: [string, string][] = [];
  const list = (x: unknown) => (Array.isArray(x) ? x.map((n) => (typeof n === 'number' ? String(Math.round(n * 1000) / 1000) : String(n))).join(', ') : '');
  if (on && typeof a.brightness === 'number') v.push(['bri', `${a.brightness}/255`]);
  if (on && a.color_mode) v.push(['color_mode', String(a.color_mode)]);
  if (on && typeof a.color_temp_kelvin === 'number') v.push(['K', String(a.color_temp_kelvin)]);
  for (const key of ['hs', 'xy', 'rgb', 'rgbw', 'rgbww']) if (on && Array.isArray(a[`${key}_color`])) v.push([key, list(a[`${key}_color`])]);
  if (on && a.effect && !['none', 'off', 'None'].includes(String(a.effect))) v.push(['effect', String(a.effect)]);
  return { on, values: v };
}

/** the lamp's state as a light setting (to take it over into the editor); null when it is not on */
export function settingOf(st: LampState | undefined): LightSetting | null {
  if (!st || st.state !== 'on') return null;
  const a = st.attributes ?? {};
  const out: LightSetting = { mode: 'on' };
  if (typeof a.brightness === 'number') {
    out.bri = a.brightness;
    out.brightness = Math.max(1, Math.round(a.brightness / 2.55));
  }
  const m = String(a.color_mode ?? '');
  const arr = (k: string) => (Array.isArray(a[k]) ? (a[k] as number[]) : null);
  const hex = (c: number[]) => `#${c.map((x) => Math.round(clamp(x, 0, 255)).toString(16).padStart(2, '0')).join('')}`;
  if (m === 'color_temp' && typeof a.color_temp_kelvin === 'number') out.color = `k:${Math.round(a.color_temp_kelvin)}` as LightAction['color'];
  else if (m === 'rgb' && arr('rgb_color')) out.color = hex(arr('rgb_color')!) as LightAction['color'];
  else if (m === 'hs' && arr('hs_color')) out.color = `hs:${arr('hs_color')!.map(r1).join(',')}` as LightAction['color'];
  else if (m === 'xy' && arr('xy_color')) out.color = `xy:${arr('xy_color')!.map((x) => Math.round(x * 1e4) / 1e4).join(',')}` as LightAction['color'];
  else if ((m === 'rgbw' || m === 'rgbww') && arr(`${m}_color`)) out.color = `${m}:${arr(`${m}_color`)!.map(Math.round).join(',')}` as LightAction['color'];
  else if (m === 'white') out.color = 'white' as LightAction['color'];
  if (a.effect && ((a.effect_list as string[] | undefined) ?? []).includes(a.effect) && !['none', 'off', 'None'].includes(String(a.effect))) out.effect = String(a.effect);
  return out;
}

/** Sends a setting to lamps while live mode is on and puts them back afterwards.
 * With the integration's preview command (io.preview: house_rules/light/preview, lightpreview.py) the integration
 * sends, remembers and puts back – its calls do not count as "by hand" for the light plan, which keeps its hands off
 * meanwhile, and it puts the lamps back by itself when the connection drops or nothing comes for 3 minutes (a
 * keep-alive goes every minute). Without it (older integration, example data) the panel calls light.turn_on itself. */
export class LightLive {
  /** direct mode: each lamp as it was before live mode touched it (null: not known) */
  private readonly before = new Map<string, LampState | null>();
  private readonly touched = new Set<string>();
  private readonly want = new Map<string, LightSetting>();
  private readonly sent = new Map<string, string>();
  private readonly queue = new Map<string, Promise<unknown>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private alive: ReturnType<typeof setInterval> | undefined;
  private lastAt = -Infinity;
  /** pending: the integration is asked; server: it runs the preview; direct: the panel calls the lamps */
  private mode: 'pending' | 'server' | 'direct' = 'direct';
  private session: string | null = null;
  private started: Promise<void> = Promise.resolve();
  private chain: Promise<unknown> = Promise.resolve();
  active = false;

  /** onError: a call failed (e.g. "unauthorized": Home Assistant does not let this user control the lamp;
   * entityId "" = the whole preview, the error's message says why) */
  constructor(
    private readonly io: LiveIO,
    private readonly onError: (err: unknown, entityId: string) => void,
    readonly every = 150,
    readonly keepEvery = 60000,
  ) {}

  /** the integration runs this preview (false: the panel calls the lamps itself) */
  get onServer(): boolean {
    return this.mode === 'server';
  }

  /** live mode on: remember the lamps as they are now (or let the integration do it) */
  start(ids: string[]): void {
    this.active = true;
    const lamps = ids.filter(isLight);
    if (!this.io.preview) {
      this.mode = 'direct';
      for (const e of lamps) this.remember(e);
      return;
    }
    this.mode = 'pending';
    this.started = this.io
      .preview({ action: 'start', lights: lamps })
      .then((r) => {
        this.session = (r as { session: string }).session;
        this.mode = 'server';
        this.alive = setInterval(() => this.keep(), this.keepEvery);
        if (!this.active) return; // stopped meanwhile: stop() ends the session
        this.kick();
      })
      .catch((err) => {
        if ((err as { code?: string })?.code === 'unknown_command') {
          // an older integration: the panel sends itself
          this.mode = 'direct';
          for (const e of lamps) this.remember(e);
          if (this.active) this.kick();
          return;
        }
        this.active = false;
        this.want.clear();
        this.onError(err, '');
      });
  }

  private keep(): void {
    if (this.mode !== 'server' || !this.session || !this.io.preview) return;
    this.io.preview({ action: 'keep', session: this.session }).catch((err) => {
      if (!this.active) return;
      // the integration ended it (restarted, or it was idle too long): live mode is over
      this.active = false;
      this.clearTimers();
      this.onError(err, '');
    });
  }

  private remember(e: string): void {
    if (this.before.has(e)) return;
    const st = this.io.state(e);
    this.before.set(e, st ? { state: st.state, attributes: JSON.parse(JSON.stringify(st.attributes ?? {})) } : null);
  }

  /** show this setting on these lamps (throttled: the first at once, then at most every `every` ms, last value wins) */
  show(ids: string[], a: LightSetting): void {
    if (!this.active) return;
    for (const e of ids.filter(isLight)) this.want.set(e, a);
    this.kick();
  }

  private kick(): void {
    if (this.mode === 'pending' || this.timer !== undefined || !this.want.size) return;
    const wait = this.lastAt + this.every - Date.now();
    if (wait <= 0) this.flush();
    else this.timer = setTimeout(() => this.flush(), wait);
  }

  private flush(): void {
    this.timer = undefined;
    this.lastAt = Date.now();
    const settings: Record<string, LightSetting> = {};
    for (const [e, a] of this.want) {
      const out = this.mode === 'server' ? a : previewCall(this.io.state(e), a);
      const key = JSON.stringify(out);
      if (this.sent.get(e) === key) continue;
      this.sent.set(e, key);
      this.touched.add(e);
      if (this.mode === 'server') settings[e] = a;
      else {
        this.remember(e);
        this.send(e, out as LightCall, true);
      }
    }
    this.want.clear();
    if (Object.keys(settings).length && this.session && this.io.preview) {
      const session = this.session;
      this.chain = this.chain
        .then(() => this.io.preview!({ action: 'apply', session, settings }))
        .then((r) => {
          for (const e of (r as { failed?: string[] })?.failed ?? []) {
            this.sent.delete(e);
            this.onError({ code: 'failed', message: '' }, e);
          }
        })
        .catch((err) => this.onError(err, ''));
    }
  }

  /** direct mode: one lamp's calls one after the other (a slow lamp never gets an old value after a newer one) */
  private send(e: string, c: LightCall, report: boolean): Promise<unknown> {
    const next = (this.queue.get(e) ?? Promise.resolve())
      .then(() => this.io.call(c.service, e, c.data))
      .catch((err) => {
        if (report) this.onError(err, e);
      });
    this.queue.set(e, next);
    return next;
  }

  private clearTimers(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.alive !== undefined) clearInterval(this.alive);
    this.timer = this.alive = undefined;
  }

  /** lamps that got a live value so far */
  get changed(): string[] {
    return [...this.touched];
  }

  /** live mode off; restore = put every touched lamp back the way it was (else it stays as shown: "so lassen") */
  async stop(restore = true): Promise<void> {
    this.active = false;
    this.want.clear();
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.started;
    this.clearTimers();
    this.lastAt = -Infinity;
    this.sent.clear();
    this.touched.clear();
    if (this.mode === 'server' && this.session && this.io.preview) {
      const session = this.session;
      this.session = null;
      const done = this.chain.then(() => this.io.preview!({ action: 'stop', session, restore })).catch(() => undefined);
      this.chain = done;
      await done;
      return;
    }
    const back = restore ? [...this.before.keys()].filter((e) => this.queue.has(e)).map((e) => [e, restoreCall(this.before.get(e))] as const) : [];
    this.before.clear();
    await Promise.all(back.map(([e, c]) => (c ? this.send(e, c, false) : this.queue.get(e))));
    this.queue.clear();
  }
}
