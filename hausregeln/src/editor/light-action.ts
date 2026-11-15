/**
 * <hr-light-action>: how lights should look, like Home Assistant's light.turn_on: on/off/scene, brightness in % or
 * 0–255, white tone (presets, Kelvin), any colour (swatches, picker, hex, RGB/RGBW/RGBWW/HS/XY numbers), the white
 * channel, effects from the lamps' effect lists, fade, flash, and each lamp its own (or the same for all).
 * Offers only what at least one of the lamps can do and says what the others do instead.
 * "Live an der Lampe" (lightlive.ts): while on, every change – also while a slider moves – goes to the real lamps
 * (each lamp its own: only the opened lamp); they are put back when it is switched off, the window closes or the
 * page is left, unless "so lassen" is ticked. Shows what each lamp reports right now (to read, copy or take over).
 * Fires "change" with detail = the new LightAction.
 */
// i18n: complete
import { css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { StoreElement } from '../base';
import type { LightAction, LightColor } from '../model';
import { shared } from '../design/shared';
import { t } from '../i18n';
import { LightLive, isLight, reported, settingOf } from '../lightlive';
import {
  FEATURE_FLASH,
  FEATURE_TRANSITION,
  PRESETS,
  SWATCHES,
  colorKind,
  convert,
  cssColor,
  dimmable,
  hasColor,
  hasWhite,
  hexToRgb,
  lightCaps,
  nums,
  rgbToHex,
  unionCaps,
  type LightCaps,
} from '../lightspec';

type Setting = Partial<Omit<LightAction, 'per_light' | 'scene'>>;
type Format = 'rgb' | 'rgbw' | 'rgbww' | 'hs' | 'xy';
const FORMATS: Format[] = ['rgb', 'rgbw', 'rgbww', 'hs', 'xy'];
const CHANNELS: Record<Format, [string, number, number, number][]> = {
  rgb: [['R', 0, 255, 1], ['G', 0, 255, 1], ['B', 0, 255, 1]],
  rgbw: [['R', 0, 255, 1], ['G', 0, 255, 1], ['B', 0, 255, 1], ['W', 0, 255, 1]],
  rgbww: [['R', 0, 255, 1], ['G', 0, 255, 1], ['B', 0, 255, 1], ['CW', 0, 255, 1], ['WW', 0, 255, 1]],
  hs: [['H', 0, 360, 1], ['S', 0, 100, 1]],
  xy: [['x', 0, 1, 0.001], ['y', 0, 1, 0.001]],
};

export class HrLightAction extends StoreElement {
  static override properties = {
    ...StoreElement.properties,
    value: { attribute: false },
    lights: { attribute: false },
    scenes: { type: Boolean },
    _open: { state: true },
    _live: { state: true },
    _keep: { state: true },
    _liveNote: { state: true },
  };
  declare value: LightAction;
  /** the lamps this is for (capabilities, "each lamp its own") */
  declare lights: string[];
  /** offer "activate a scene" */
  declare scenes: boolean;
  declare _open: string | null;
  /** live mode is on */
  declare _live: boolean;
  /** "so lassen": the lamps stay as shown when live mode ends */
  declare _keep: boolean;
  declare _liveNote: string | null;
  private _ctl: LightLive | undefined;
  /** leaving the page: put the lamps back (best effort, the connection may already be gone) */
  private readonly _bye = () => void this._endLive();

  constructor() {
    super();
    this.lights = [];
    this.scenes = false;
    this._open = null;
    this._live = false;
    this._keep = false;
    this._liveNote = null;
  }

  static override styles = [
    shared,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-2);
      }
      .range {
        display: flex;
        align-items: center;
        gap: var(--hr-space-2);
      }
      .range input[type='range'] {
        flex: 1;
      }
      .range output {
        min-width: 4.5em;
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .note {
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
      }
      .label {
        font-size: var(--hr-text-footnote);
        font-weight: 600;
        color: var(--hr-label-2);
      }
      .swatches {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .swatches button {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        border: 2px solid transparent;
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--hr-label) 15%, transparent);
      }
      .swatches button[aria-pressed='true'] {
        border-color: var(--hr-label);
      }
      .chan {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: center;
      }
      .chan label {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
      }
      input.num,
      input.hex,
      select {
        min-height: 36px;
        padding: 0 8px;
        border-radius: var(--hr-radius-s, 8px);
        border: 1px solid var(--hr-separator, color-mix(in srgb, var(--hr-label) 20%, transparent));
        background: var(--hr-bg);
        color: var(--hr-label);
        font: inherit;
      }
      input.num {
        width: 4.6em;
      }
      input.hex {
        width: 7em;
        font-family: var(--hr-font-mono, monospace);
      }
      input.picker {
        width: 44px;
        height: 36px;
        padding: 0;
        border: none;
        background: none;
      }
      .dot {
        display: inline-block;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--hr-label) 15%, transparent);
        vertical-align: middle;
      }
      details > summary {
        cursor: pointer;
        padding: 4px 0;
      }
      .more {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-2);
      }
      .lamp {
        border-radius: var(--hr-radius-m);
        background: var(--hr-surface);
        padding: var(--hr-space-2) var(--hr-space-3);
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-2);
      }
      .lamp > button.head {
        display: flex;
        align-items: center;
        gap: var(--hr-space-2);
        min-height: 40px;
        text-align: left;
        font-weight: 600;
      }
      .live {
        border-radius: var(--hr-radius-m);
        background: var(--hr-surface);
        padding: var(--hr-space-2) var(--hr-space-3);
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .live.on {
        box-shadow: inset 0 0 0 1.5px var(--hr-green);
      }
      .live .top {
        display: flex;
        align-items: center;
        gap: var(--hr-space-2);
      }
      .live .top .grow {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .live .title {
        font-weight: 600;
        display: inline-flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--hr-space-2);
      }
      .pulse {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--hr-green);
        animation: pulse 1.6s ease-in-out infinite;
      }
      @keyframes pulse {
        50% {
          opacity: 0.3;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .pulse {
          animation: none;
        }
      }
      .live label.keep {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: 32px;
        font-size: var(--hr-text-footnote);
      }
      .note.warn {
        color: var(--hr-red);
      }
      .now {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .now .rep {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px 6px;
        font-size: var(--hr-text-footnote);
      }
      .now code {
        font-family: var(--hr-font-mono, monospace);
        font-size: var(--hr-text-caption);
        padding: 1px 6px;
        border-radius: 6px;
        background: var(--hr-fill);
        user-select: all;
      }
      .lamp > button.head span.grow {
        flex: 1;
        font-weight: 400;
        color: var(--hr-label-2);
        font-size: var(--hr-text-footnote);
      }
    `,
  ];

  private _emit(v: LightAction) {
    this.value = v;
    this.dispatchEvent(new CustomEvent('change', { detail: v }));
  }

  private _caps(e: string): LightCaps {
    return this.store?.device(e)?.light ?? lightCaps(undefined);
  }

  private _name(e: string): string {
    return this.store?.device(e)?.name ?? e;
  }

  // ------------------------------------------------------------------ live at the lamp
  /** the lamps live mode may drive: lights only */
  private _lamps(): string[] {
    return (this.lights ?? []).filter(isLight);
  }

  /** guests only look and use: they never drive lamps from an editor (Home Assistant also checks every call) */
  private get _mayLive(): boolean {
    return !!this.store?.canEdit;
  }

  private _startLive() {
    if (this._ctl || !this.store) return;
    if (!this._mayLive) {
      this._liveNote = t('light.live_guest');
      return;
    }
    const store = this.store;
    this._ctl = new LightLive(
      { state: (e) => store.lightState(e), call: (s, e, d) => store.lightCall(s, e, d), preview: (m) => store.lightPreview(m) },
      (err, e) => this._liveFailed(err, e),
    );
    this._ctl.start(this._lamps());
    this._live = true;
    this._liveNote = null;
    window.addEventListener('pagehide', this._bye);
    this._push();
  }

  /** live mode off: the lamps back as they were, unless "so lassen" */
  private _endLive(): Promise<void> {
    const ctl = this._ctl;
    if (!ctl) return Promise.resolve();
    this._ctl = undefined;
    this._live = false;
    window.removeEventListener('pagehide', this._bye);
    return ctl.stop(!this._keep);
  }

  private _liveFailed(err: unknown, e: string) {
    const code = (err as { code?: string } | null)?.code;
    const msg = String((err as Error)?.message ?? err);
    if (!e) {
      // the whole preview (the integration refused it or ended it): its message says why
      this._liveNote = code === 'unauthorized' && msg ? msg : t('light.live_ended', { error: msg });
      void this._endLive();
    } else if (code === 'unauthorized') {
      this._liveNote = t('light.live_denied', { name: this._name(e) });
      void this._endLive();
    } else this._liveNote = t('light.live_failed', { name: this._name(e), error: String((err as Error)?.message ?? err) });
  }

  /** which lamps show which setting now: each lamp its own = only the opened lamp; a scene is not shown live */
  private _targets(a: LightAction): [string[], LightAction][] {
    if (!a || a.mode === 'scene') return [];
    const lamps = this._lamps();
    if (!a.per_light) return [[lamps, a]];
    const e = this._open;
    if (!e || !lamps.includes(e)) return [];
    const { per_light: per, ...all } = a;
    return [[[e], { ...all, mode: all.mode === 'off' ? 'off' : 'on', ...(per[e] ?? {}) } as LightAction]];
  }

  private _push() {
    if (!this._ctl) return;
    for (const [ids, s] of this._targets(this.value)) this._ctl.show(ids, s);
  }

  /** while a slider or the colour picker moves (before "change"): only to the lamps, nothing is saved yet */
  private _peek(lights: string[], s: Setting) {
    this._ctl?.show(lights, s);
  }

  protected override updated(changed: PropertyValues): void {
    super.updated(changed);
    if (this._ctl && (changed.has('value') || changed.has('_open') || changed.has('lights'))) this._push();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    // the window closed (or the editor went away): put the lamps back; moved elements come back at once and stay live
    if (this._ctl)
      setTimeout(() => {
        if (!this.isConnected) void this._endLive();
      }, 0);
  }

  private _liveBar(a: LightAction): TemplateResult | typeof nothing {
    if (!this._lamps().length) return nothing;
    const on = this._live;
    const each = !!a.per_light;
    return html`<div class="live ${on ? 'on' : ''}">
      <div class="top">
        <span class="grow">
          <span class="title">${t('light.live')}${on ? html`<span class="pill live"><span class="pulse"></span>${t('light.live_on')}</span>` : nothing}</span>
          <span class="note">${t(each ? 'light.live_note_each' : 'light.live_note')}</span>
        </span>
        <button class="switch" role="switch" aria-label=${t('light.live')} aria-checked=${on ? 'true' : 'false'} ?disabled=${!this._mayLive}
          @click=${() => (on ? void this._endLive() : this._startLive())}></button>
      </div>
      ${on ? html`<label class="keep"><input type="checkbox" .checked=${this._keep} @change=${(e: Event) => (this._keep = (e.target as HTMLInputElement).checked)} />${t('light.live_keep')}</label>` : nothing}
      ${!this._mayLive ? html`<p class="note">${t('light.live_guest')}</p>` : nothing}
      ${on && a.mode === 'scene' ? html`<p class="note">${t('light.live_scene')}</p>` : nothing}
      ${on && each && a.mode !== 'scene' && !(this._open && this._lamps().includes(this._open)) ? html`<p class="note">${t('light.live_pick_lamp')}</p>` : nothing}
      ${this._liveNote ? html`<p class="note warn" role="alert">${this._liveNote}</p>` : nothing}
    </div>`;
  }

  /** what the lamps report right now (brightness 0–255, colour mode, hs/xy/rgb …), each with "take over" */
  private _now(lamps: string[], take: (s: Setting) => void): TemplateResult | typeof nothing {
    const list = lamps.filter(isLight);
    if (!list.length || !this.store) return nothing;
    return html`<details class="now-box" ?open=${this._live}>
      <summary class="label">${t('light.reported')}</summary>
      <div class="now">
        ${list.map((e) => {
          const st = this.store.lightState(e);
          const r = reported(st);
          const s = settingOf(st);
          return html`<div class="rep" data-entity=${e}>
            ${list.length > 1 ? html`<b>${this._name(e)}</b>` : nothing}
            ${!r ? html`<span class="note">${t('light.reported_unknown')}</span>` : !r.on ? html`<code>${t('light.off')}</code>` : r.values.map(([k, v]) => html`<code>${k} ${v}</code>`)}
            ${s && this.store.canEdit ? html`<button class="btn small plain" @click=${() => take(s)}>${t('light.take_over')}</button>` : nothing}
          </div>`;
        })}
      </div>
    </details>`;
  }

  override render() {
    const a = this.value ?? { mode: 'on', brightness: 80, color: 'warm' };
    const lights = this.lights ?? [];
    const caps = unionCaps(lights.map((e) => this._caps(e)));
    const each = !!a.per_light;
    return html`
      <div class="seg">
        <button aria-pressed=${a.mode === 'on' ? 'true' : 'false'} @click=${() => this._emit({ ...a, mode: 'on' })}>${t('light.mode_on')}</button>
        <button aria-pressed=${a.mode === 'off' ? 'true' : 'false'} @click=${() => this._emit({ ...a, mode: 'off' })}>${t('light.mode_off')}</button>
        ${this.scenes ? html`<button aria-pressed=${a.mode === 'scene' ? 'true' : 'false'} @click=${() => this._emit({ ...a, mode: 'scene' })}>${t('light.mode_scene')}</button>` : nothing}
      </div>
      ${this._liveBar(a)}
      ${a.mode === 'scene' ? this._scene(a) : nothing}
      ${a.mode !== 'scene' && lights.length > 1
        ? html`<div class="seg">
            <button aria-pressed=${each ? 'false' : 'true'} @click=${() => { const { per_light: _p, ...rest } = a; this._emit(rest as LightAction); }}>${t('light.same_for_all')}</button>
            <button aria-pressed=${each ? 'true' : 'false'} @click=${() => this._emit({ ...a, per_light: a.per_light ?? {} })}>${t('light.each_own')}</button>
          </div>`
        : nothing}
      ${a.mode === 'on' && !each ? this._settings(a, caps, (s) => this._emit({ ...a, ...s } as LightAction), lights) : nothing}
      ${a.mode !== 'scene' && !each ? this._now(lights, (s) => this._emit({ ...a, ...s } as LightAction)) : nothing}
      ${a.mode !== 'scene' && each ? lights.map((e) => this._lamp(a, e)) : nothing}
    `;
  }

  private _scene(a: LightAction) {
    const list = (this.store?.devices ?? []).filter((d) => d.entity_id.startsWith('scene.'));
    return html`<span class="label">${t('light.scene_pick')}</span>
      <select aria-label=${t('light.scene_pick')} @change=${(e: Event) => this._emit({ ...a, scene: (e.target as HTMLSelectElement).value })}>
        <option value="" ?selected=${!a.scene}>…</option>
        ${list.map((d) => html`<option value=${d.entity_id} ?selected=${a.scene === d.entity_id}>${d.name}</option>`)}
        ${a.scene && !list.some((d) => d.entity_id === a.scene) ? html`<option value=${a.scene} selected>${a.scene}</option>` : nothing}
      </select>
      <p class="note">${t('light.scene_note')}</p>`;
  }

  /** one lamp in "each lamp its own": like all, or its own setting */
  private _lamp(a: LightAction, e: string) {
    const own = a.per_light?.[e];
    const mine: Setting = { mode: 'on', brightness: a.brightness, color: a.color, ...(a.effect ? { effect: a.effect } : {}), ...own };
    const setOwn = (s: Setting | null) => {
      const per = { ...(a.per_light ?? {}) };
      if (s) per[e] = s;
      else delete per[e];
      this._emit({ ...a, per_light: per });
    };
    const open = this._open === e;
    return html`<div class="lamp">
      <button class="head" aria-expanded=${open ? 'true' : 'false'} @click=${() => (this._open = open ? null : e)}>
        <span class="dot" style="background:${mine.mode === 'off' ? 'transparent' : cssColor(mine.color)}"></span>${this._name(e)}
        <span class="grow">${own ? (mine.mode === 'off' ? t('light.off') : `${mine.brightness ?? a.brightness} %`) : t('light.like_all')}</span>
      </button>
      ${open
        ? html`<div class="seg">
              <button aria-pressed=${!own ? 'true' : 'false'} @click=${() => setOwn(null)}>${t('light.like_all')}</button>
              <button aria-pressed=${own && mine.mode !== 'off' ? 'true' : 'false'} @click=${() => setOwn({ ...mine, mode: 'on' })}>${t('light.own_on')}</button>
              <button aria-pressed=${own && mine.mode === 'off' ? 'true' : 'false'} @click=${() => setOwn({ ...mine, mode: 'off' })}>${t('light.mode_off')}</button>
            </div>
            ${own && mine.mode !== 'off' ? this._settings(mine, this._caps(e), (s) => setOwn({ ...mine, ...s }), [e]) : nothing}
            ${this._now([e], (s) => setOwn({ ...mine, ...s, mode: 'on' }))}`
        : nothing}
    </div>`;
  }

  /** brightness, colour, effect, fade, flash for lamps with these capabilities */
  private _settings(a: Setting, caps: LightCaps, set: (s: Setting) => void, lights: string[]): TemplateResult {
    const raw = typeof a.bri === 'number';
    const bri = Number(a.brightness ?? 80);
    const kind = colorKind(a.color);
    const tab = kind === 'preset' || kind === 'kelvin' ? 'white' : kind === 'none' ? 'none' : kind === 'white' ? 'channel' : 'color';
    const caps1 = lights.map((e) => [e, this._caps(e)] as const);
    const noColor = caps1.filter(([, c]) => !hasColor(c)).map(([e]) => this._name(e));
    const noWhite = caps1.filter(([, c]) => !hasWhite(c) && !hasColor(c)).map(([e]) => this._name(e));
    const onOff = caps1.filter(([, c]) => !dimmable(c)).map(([e]) => this._name(e));
    // live at the lamp: while dragging already (the value itself is set on "change")
    const peek = (s: Setting) => this._peek(lights, { ...a, ...s });
    const briOf = (e: Event): Setting => {
      const v = Number((e.target as HTMLInputElement).value);
      return raw ? { bri: v, brightness: Math.max(1, Math.round(v / 2.55)) } : { brightness: v, bri: undefined };
    };
    return html`
      ${dimmable(caps)
        ? html`<div class="range">
            <input type="range" min="1" max=${raw ? 255 : 100} .value=${String(raw ? a.bri : bri)} aria-label=${t('light.brightness')}
              @input=${(e: Event) => peek(briOf(e))} @change=${(e: Event) => set(briOf(e))} />
            <output>${raw ? `${a.bri}/255` : `${bri} %`}</output>
            <button class="btn small plain" title=${t('light.unit_toggle')} @click=${() => set(raw ? { bri: undefined } : { bri: Math.round(bri * 2.55) })}>${raw ? '%' : '0–255'}</button>
          </div>`
        : nothing}
      ${onOff.length ? html`<p class="note">${t('light.only_on_off', { names: onOff.join(', ') })}</p>` : nothing}
      ${hasColor(caps) || hasWhite(caps)
        ? html`<div class="seg">
              <button aria-pressed=${tab === 'white' ? 'true' : 'false'} @click=${() => set({ color: 'warm' })}>${t('light.tab_white')}</button>
              ${hasColor(caps) ? html`<button aria-pressed=${tab === 'color' ? 'true' : 'false'} @click=${() => set({ color: tab === 'color' ? a.color : ('#ff8a3d' as LightColor) })}>${t('light.tab_color')}</button>` : nothing}
              ${caps.modes.includes('white') ? html`<button aria-pressed=${tab === 'channel' ? 'true' : 'false'} @click=${() => set({ color: 'white' })}>${t('light.white_channel')}</button>` : nothing}
              <button aria-pressed=${tab === 'none' ? 'true' : 'false'} @click=${() => set({ color: 'none' })}>${t('light.keep_color')}</button>
            </div>
            ${tab === 'white' ? this._white(a, caps, set, peek) : nothing}
            ${tab === 'color' ? this._color(a, caps, set, peek) : nothing}
            ${tab === 'color' && noColor.length ? html`<p class="note">${t('light.no_color', { names: noColor.join(', ') })}</p>` : nothing}
            ${tab === 'white' && noWhite.length ? html`<p class="note">${t('light.no_white', { names: noWhite.join(', ') })}</p>` : nothing}`
        : nothing}
      ${caps.effects.length || caps.features & (FEATURE_TRANSITION | FEATURE_FLASH)
        ? html`<details ?open=${!!(a.effect || a.transition || a.flash)}><summary class="label">${t('light.more')}</summary><div class="more">${this._extras(a, caps, set)}</div></details>`
        : nothing}
    `;
  }

  /** effect, fade, flash */
  private _extras(a: Setting, caps: LightCaps, set: (s: Setting) => void): TemplateResult {
    return html`
      ${caps.effects.length
        ? html`<span class="label">${t('light.effect')}</span>
            <select aria-label=${t('light.effect')} @change=${(e: Event) => set({ effect: (e.target as HTMLSelectElement).value || undefined })}>
              <option value="" ?selected=${!a.effect}>${t('light.no_effect')}</option>
              ${caps.effects.map((x) => html`<option value=${x} ?selected=${a.effect === x}>${x}</option>`)}
            </select>`
        : nothing}
      ${caps.features & FEATURE_TRANSITION
        ? html`<div class="range">
            <span class="label">${t('light.fade')}</span>
            <input type="range" min="0" max="30" step="0.5" .value=${String(a.transition ?? 0)} aria-label=${t('light.fade')}
              @change=${(e: Event) => { const v = Number((e.target as HTMLInputElement).value); set({ transition: v || undefined }); }} />
            <output>${a.transition ? `${a.transition} s` : t('light.fade_none')}</output>
          </div>
          ${a.transition ? html`<p class="note">${t('light.fade_both')}</p>` : nothing}`
        : nothing}
      ${caps.features & FEATURE_FLASH
        ? html`<div class="seg">
            <button aria-pressed=${!a.flash ? 'true' : 'false'} @click=${() => set({ flash: undefined })}>${t('light.flash_none')}</button>
            <button aria-pressed=${a.flash === 'short' ? 'true' : 'false'} @click=${() => set({ flash: 'short' })}>${t('light.flash_short')}</button>
            <button aria-pressed=${a.flash === 'long' ? 'true' : 'false'} @click=${() => set({ flash: 'long' })}>${t('light.flash_long')}</button>
          </div>`
        : nothing}
    `;
  }

  private _white(a: Setting, caps: LightCaps, set: (s: Setting) => void, peek: (s: Setting) => void) {
    const c = String(a.color ?? 'warm');
    const lo = Math.min(caps.min_k, 2200);
    const hi = Math.max(caps.max_k, 6500);
    const k = c.startsWith('k:') ? Number(c.slice(2)) : ({ kerze: 2200, warm: 2700, neutral: 4000, kalt: 5500 } as Record<string, number>)[c] ?? 3000;
    return html`<div class="seg">
        ${PRESETS.map(([p, key]) => html`<button aria-pressed=${c === p ? 'true' : 'false'} @click=${() => set({ color: p as LightColor })}>${t(key)}</button>`)}
      </div>
      <div class="range">
        <span class="dot" style="background:${cssColor(`k:${k}`)}"></span>
        <input type="range" min=${lo} max=${hi} step="50" .value=${String(k)} aria-label=${t('light.kelvin')}
          @input=${(e: Event) => peek({ color: `k:${(e.target as HTMLInputElement).value}` as LightColor })}
          @change=${(e: Event) => set({ color: `k:${(e.target as HTMLInputElement).value}` as LightColor })} />
        <output>${k} K</output>
      </div>`;
  }

  private _color(a: Setting, caps: LightCaps, set: (s: Setting) => void, peek: (s: Setting) => void) {
    const c = String(a.color ?? '#ff8a3d');
    const kind = colorKind(c);
    const fmt: Format = (FORMATS as string[]).includes(kind) ? (kind as Format) : 'rgb';
    const hex = convert(c, 'rgb');
    const offered = FORMATS.filter((f) => f === 'rgb' || f === 'hs' || caps.modes.includes(f));
    const values = fmt === 'rgb' ? hexToRgb(c) : nums(c);
    const setChannel = (i: number, v: number) => {
      const next = [...values];
      next[i] = v;
      set({ color: (fmt === 'rgb' ? rgbToHex(next[0], next[1], next[2]) : `${fmt}:${next.join(',')}`) as LightColor });
    };
    return html`<div class="swatches">
        ${SWATCHES.map((s) => html`<button style="background:${s}" aria-label=${s} aria-pressed=${hex === s ? 'true' : 'false'} @click=${() => set({ color: (fmt === 'rgb' ? s : convert(s, fmt)) as LightColor })}></button>`)}
      </div>
      <input class="picker" type="color" .value=${hex} aria-label=${t('light.tab_color')}
        @input=${(e: Event) => peek({ color: convert((e.target as HTMLInputElement).value, fmt) as LightColor })}
        @change=${(e: Event) => set({ color: convert((e.target as HTMLInputElement).value, fmt) as LightColor })} />
      <details>
      <summary class="label">${t('light.exact')}</summary>
      <div class="chan">
        <input class="hex" .value=${hex} aria-label=${t('light.hex')} @change=${(e: Event) => { const v = (e.target as HTMLInputElement).value.trim(); if (/^#?[0-9a-f]{6}$/i.test(v)) set({ color: convert(v.startsWith('#') ? v : `#${v}`, fmt) as LightColor }); }} />
        <select aria-label=${t('light.format')} @change=${(e: Event) => set({ color: convert(c, (e.target as HTMLSelectElement).value as Format) as LightColor })}>
          ${offered.map((f) => html`<option value=${f} ?selected=${f === fmt}>${f.toUpperCase()}</option>`)}
        </select>
      </div>
      <div class="chan">
        ${CHANNELS[fmt].map(
          ([label, min, max, step], i) => html`<label>${label}<input class="num" type="number" min=${min} max=${max} step=${step} .value=${String(values[i] ?? 0)} @change=${(e: Event) => setChannel(i, Math.max(min, Math.min(max, Number((e.target as HTMLInputElement).value))))} /></label>`,
        )}
      </div>
      </details>`;
  }
}
customElements.define('hr-light-action', HrLightAction);
