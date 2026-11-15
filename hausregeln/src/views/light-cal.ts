/**
 * <hr-light-cal>: Licht → Seiten-Zahnrad → „Lampen abgleichen“. Lamps of different makers show "the same" colour
 * differently: choose a room and a reference colour (red … pink, warm/neutral/cold white), every lamp of the room
 * goes to it live, and each lamp is corrected by eye (hue and saturation, or Kelvin for whites, and brightness) until
 * they all look alike. Saving remembers the correction per lamp and reference (lightcal.py); every rule, the light plan
 * and the live preview then send each lamp its corrected colour. While calibrating, the preview sends the values
 * exactly ("raw"), not corrected again. Fires "close" (the lamps go back as they were).
 */
import { css, html, nothing } from 'lit';
import { StoreElement } from '../base';
import { shared } from '../design/shared';
import { kit } from '../design/kit';
import type { Device, LightCalEntry, LightCalView } from '../model';
import { t, type I18nKey } from '../i18n';
import '../components/pop';
// i18n: complete

/** what a lamp is sent for the chosen reference while calibrating */
interface Draft {
  h: number;
  s: number;
  k: number;
  /** brightness factor in percent (100 = as asked) */
  b: number;
}

/** brightness the lamps show while comparing */
const BASE_BRI = 60;

export class HrLightCal extends StoreElement {
  static override properties = {
    ...StoreElement.properties,
    _view: { state: true },
    _room: { state: true },
    _ref: { state: true },
    _draft: { state: true },
    _live: { state: true },
    _busy: { state: true },
  };
  declare _view: LightCalView | null;
  declare _room: string;
  declare _ref: string;
  declare _draft: Record<string, Draft>;
  declare _live: boolean;
  declare _busy: boolean;
  private session: string | null = null;
  private sendTimer = 0;

  constructor() {
    super();
    this._view = null;
    this._room = '';
    this._ref = '';
    this._draft = {};
    this._live = false;
    this._busy = false;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.store.lightcalGet().then((v) => (this._view = v), () => (this._view = { lights: {}, colors: {}, whites: {} }));
    const first = this.store.orderedRooms('light').find((r) => this._lamps(r.id).length >= 2) ?? this.store.orderedRooms('light')[0];
    if (first) this._room = first.id;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    void this._stopLive();
  }

  protected override frozen(): boolean {
    return this._live;
  }

  static override styles = [
    shared,
    kit,
    css`
      .refs {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .refs button {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-height: 40px;
        padding: 4px 12px 4px 6px;
        border-radius: var(--hr-radius-full);
        background: var(--hr-fill);
        font-size: var(--hr-text-subhead);
        font-weight: 600;
        color: var(--hr-label-2);
      }
      .refs button[aria-pressed='true'] {
        box-shadow: inset 0 0 0 2px var(--hr-accent);
        color: var(--hr-label);
      }
      .dot {
        width: 26px;
        height: 26px;
        border-radius: 50%;
        flex: none;
        box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
      }
      .lamp {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: var(--hr-space-2) 0;
      }
      .lamp + .lamp {
        border-top: 0.5px solid var(--hr-separator);
        padding-top: var(--hr-space-3);
      }
      .lamp .head {
        display: flex;
        align-items: center;
        gap: var(--hr-space-3);
      }
      .lamp .head b {
        flex: 1;
        min-width: 0;
      }
      .slider {
        display: grid;
        grid-template-columns: 90px 1fr 64px;
        align-items: center;
        gap: var(--hr-space-2);
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
      }
      .slider output {
        text-align: right;
        font-variant-numeric: tabular-nums;
        color: var(--hr-label);
        font-weight: 600;
      }
      input[type='range'] {
        width: 100%;
        accent-color: var(--hr-accent);
      }
      input.hue {
        appearance: none;
        height: 10px;
        border-radius: 5px;
        background: linear-gradient(90deg, #f00, #ff0 16%, #0f0 33%, #0ff 50%, #00f 66%, #f0f 83%, #f00);
      }
      input.kel {
        appearance: none;
        height: 10px;
        border-radius: 5px;
        background: linear-gradient(90deg, #ff9a3c, #fff1dc 50%, #cfe2ff);
      }
      .done {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .done .dot {
        width: 14px;
        height: 14px;
      }
    `,
  ];

  // ------------------------------------------------------------------ helpers
  private _lamps(rid: string): Device[] {
    return this.store.devices.filter((d) => d.kind === 'light' && d.room === rid && d.entity_id.startsWith('light.'));
  }

  private _colorLamp(e: string): boolean {
    const modes: string[] = this.store.lightState(e)?.attributes?.supported_color_modes ?? [];
    return !modes.length || modes.some((m) => ['hs', 'rgb', 'rgbw', 'rgbww', 'xy'].includes(m));
  }

  private _isWhite(ref: string): boolean {
    return !!this._view?.whites[ref];
  }

  private _refs(): string[] {
    const v = this._view;
    return v ? [...Object.keys(v.colors), ...Object.keys(v.whites)] : [];
  }

  private _refCss(ref: string): string {
    const v = this._view;
    if (!v) return '#ccc';
    if (v.colors[ref]) return `hsl(${v.colors[ref][0]} ${v.colors[ref][1]}% 50%)`;
    const k = v.whites[ref] ?? 4000;
    return k < 3200 ? '#ffb46b' : k < 4800 ? '#fff1dc' : '#cfe2ff';
  }

  /** the draft of a lamp for a reference: what is stored, else the reference itself */
  private _start(e: string, ref: string): Draft {
    const v = this._view!;
    const cal: LightCalEntry | undefined = v.lights[e];
    const [h, s] = cal?.hs[ref] ?? v.colors[ref] ?? [0, 0];
    const k = cal?.k[ref] ?? v.whites[ref] ?? 4000;
    return { h, s, k, b: Math.round((cal?.bri ?? 1) * 100) };
  }

  private _choose(rid: string, ref: string) {
    this._room = rid;
    this._ref = ref;
    if (!rid || !ref || !this._view) return;
    this._draft = Object.fromEntries(this._lamps(rid).map((l) => [l.entity_id, this._start(l.entity_id, ref)]));
    this._send();
  }

  private _set(e: string, patch: Partial<Draft>) {
    this._draft = { ...this._draft, [e]: { ...this._draft[e], ...patch } };
    this._send();
  }

  /** the setting a lamp gets while comparing (sent exactly: "raw") */
  private _setting(d: Draft) {
    const white = this._isWhite(this._ref);
    return { mode: 'on', brightness: Math.max(1, Math.min(100, Math.round((BASE_BRI * d.b) / 100))), color: white ? `k:${Math.round(d.k)}` : `hs:${Math.round(d.h)},${Math.round(d.s)}`, raw: true };
  }

  // ------------------------------------------------------------------ live at the lamps
  private async _startLive() {
    if (this.session || !this._room) return;
    const lights = this._lamps(this._room).map((l) => l.entity_id);
    const res = (await this.store.lightPreview({ action: 'start', lights }).catch(() => null)) as { session?: string } | null;
    this.session = res?.session ?? 'demo';
    this._live = true;
    this._send(true);
  }

  private async _stopLive(restore = true) {
    const s = this.session;
    this.session = null;
    this._live = false;
    clearTimeout(this.sendTimer);
    if (s && s !== 'demo') await this.store.lightPreview({ action: 'stop', session: s, restore }).catch(() => null);
    this.thaw();
  }

  /** send what the lamps should show now (throttled: sliders move quickly) */
  private _send(now = false) {
    if (!this.session) return;
    clearTimeout(this.sendTimer);
    const go = () => {
      if (!this.session || this.session === 'demo') return;
      const settings = Object.fromEntries(Object.entries(this._draft).map(([e, d]) => [e, this._setting(d)]));
      void this.store.lightPreview({ action: 'apply', session: this.session, settings }).catch(() => null);
    };
    if (now) go();
    else this.sendTimer = window.setTimeout(go, 150);
  }

  // ------------------------------------------------------------------ saving
  private async _save() {
    if (!this._view || !this._ref) return;
    this._busy = true;
    const white = this._isWhite(this._ref);
    const lights: Record<string, LightCalEntry> = {};
    for (const [e, d] of Object.entries(this._draft)) {
      const cur: LightCalEntry = this._view.lights[e] ?? { hs: {}, k: {}, bri: 1 };
      const next: LightCalEntry = { hs: { ...cur.hs }, k: { ...cur.k }, bri: d.b / 100 };
      if (white) next.k[this._ref] = Math.round(d.k);
      else if (this._colorLamp(e)) next.hs[this._ref] = [Math.round(d.h * 10) / 10, Math.round(d.s * 10) / 10];
      lights[e] = next;
    }
    this._view = await this.store.lightcalSet(lights);
    this._busy = false;
    this.dispatchEvent(new CustomEvent('hr-toast', { detail: t('cal.saved', { ref: t(`cal.ref_${this._ref}` as I18nKey) }), bubbles: true, composed: true }));
  }

  private async _reset(e: string) {
    if (!this._view) return;
    this._view = await this.store.lightcalSet({ [e]: null });
    if (this._ref) this._draft = { ...this._draft, [e]: this._start(e, this._ref) };
    this._send();
  }

  private _close = async () => {
    await this._stopLive();
    this.dispatchEvent(new CustomEvent('close'));
  };

  // ------------------------------------------------------------------ drawing
  private _lampRow(l: Device) {
    const d = this._draft[l.entity_id];
    if (!d) return nothing;
    const white = this._isWhite(this._ref);
    const color = this._colorLamp(l.entity_id);
    const cal = this._view?.lights[l.entity_id];
    const done = cal ? [...Object.keys(cal.hs), ...Object.keys(cal.k)] : [];
    const swatch = white ? this._refCss(this._ref) : `hsl(${d.h} ${d.s}% 50%)`;
    return html`<div class="lamp">
      <div class="head">
        <span class="dot" style="background:${swatch}"></span>
        <b>${l.name}</b>
        ${done.length ? html`<span class="done" title=${t('cal.done_title')}>${done.map((r) => html`<span class="dot" style="background:${this._refCss(r)}"></span>`)}</span>` : nothing}
        ${cal ? html`<button class="btn small plain" @click=${() => this._reset(l.entity_id)}>${t('cal.reset')}</button>` : nothing}
      </div>
      ${white
        ? html`<label class="slider"><span>${t('cal.kelvin')}</span><input class="kel" type="range" min="2000" max="6500" step="50" .value=${String(d.k)} @input=${(e: Event) => this._set(l.entity_id, { k: Number((e.target as HTMLInputElement).value) })} /><output>${Math.round(d.k)} K</output></label>`
        : color
          ? html`<label class="slider"><span>${t('cal.hue')}</span><input class="hue" type="range" min="0" max="359" .value=${String(d.h)} @input=${(e: Event) => this._set(l.entity_id, { h: Number((e.target as HTMLInputElement).value) })} /><output>${Math.round(d.h)}°</output></label>
              <label class="slider"><span>${t('cal.sat')}</span><input type="range" min="0" max="100" .value=${String(d.s)} @input=${(e: Event) => this._set(l.entity_id, { s: Number((e.target as HTMLInputElement).value) })} /><output>${Math.round(d.s)} %</output></label>`
          : html`<small class="muted">${t('cal.white_only')}</small>`}
      <label class="slider"><span>${t('cal.bri')}</span><input type="range" min="30" max="200" step="5" .value=${String(d.b)} @input=${(e: Event) => this._set(l.entity_id, { b: Number((e.target as HTMLInputElement).value) })} /><output>${d.b} %</output></label>
    </div>`;
  }

  override render() {
    const s = this.store;
    const rooms = s.orderedRooms('light').filter((r) => this._lamps(r.id).length);
    const lamps = this._room ? this._lamps(this._room) : [];
    return html`<hr-pop heading=${t('cal.title')} .sub=${t('cal.sub')} @close=${this._close}>
      <p class="rl-note">${t('cal.lead')}</p>
      <div class="rl-sec">
        <h3>${t('cal.room')}</h3>
        <div class="seg" role="radiogroup" aria-label=${t('cal.room')}>
          ${rooms.map((r) => html`<button role="radio" aria-pressed=${this._room === r.id ? 'true' : 'false'} @click=${async () => (await this._stopLive(), this._choose(r.id, this._ref))}>${r.name}</button>`)}
        </div>
      </div>
      <div class="rl-sec">
        <h3>${t('cal.ref')}</h3>
        <div class="refs" role="radiogroup" aria-label=${t('cal.ref')}>
          ${this._refs().map(
            (r) => html`<button role="radio" aria-pressed=${this._ref === r ? 'true' : 'false'} @click=${() => this._choose(this._room, r)}><span class="dot" style="background:${this._refCss(r)}"></span>${t(`cal.ref_${r}` as I18nKey)}</button>`,
          )}
        </div>
      </div>
      ${this._room && this._ref
        ? html`<div class="rl-sec">
            <h3>${t('cal.lamps', { n: lamps.length })}</h3>
            <div class="rl-box">
              <div class="line">
                <span class="grow"><b>${t('cal.live')}</b><small>${this._live ? t('cal.live_on') : t('cal.live_off')}</small></span>
                <button class="switch" role="switch" aria-label=${t('cal.live')} aria-checked=${this._live ? 'true' : 'false'} ?disabled=${!s.canEdit} @click=${() => (this._live ? this._stopLive() : this._startLive())}></button>
              </div>
              ${lamps.map((l) => this._lampRow(l))}
            </div>
            <p class="rl-note">${t('cal.how')}</p>
          </div>`
        : html`<p class="rl-note">${t('cal.pick')}</p>`}
      <button slot="foot" class="btn" @click=${this._close}>${t('common.close')}</button>
      ${this._room && this._ref ? html`<button slot="foot" class="btn primary" ?disabled=${this._busy || !s.canEdit} @click=${() => this._save()}>${t('cal.save')}</button>` : nothing}
    </hr-pop>`;
  }
}
customElements.define('hr-light-cal', HrLightCal);
