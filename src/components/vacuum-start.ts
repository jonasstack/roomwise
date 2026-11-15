import { LitElement, html, nothing, svg } from 'lit';
import type { HomeAssistant, Point } from '../types';
import { t } from '../i18n';
import { vacuumInfo, vacuumMap, type VacuumInfo } from '../entry-server';
import { planFromVacuumMap, type VacuumPlanResult } from '../vacuum-plan';

/**
 * First steps "from the vacuum's map" (loaded only when chosen): pick the vacuum, read its map (companion),
 * show the plan made from it as a preview, "Apply" opens the editor with it as an unsaved draft. No map yet: a
 * mapping run can be started (after a second tap), and the map is read again every 20 s until it is there.
 * Renders into the card's own shadow root (light DOM) so the card's styles apply. Part of the editor's bundle
 * (editor-ui imports it): no extra file at the card's start, and the editor opens next anyway.
 */
export class FpVacuumStart extends LitElement {
  static override properties = {
    hass: { attribute: false },
    _vac: { state: true },
    _st: { state: true },
    _res: { state: true },
    _confirm: { state: true },
  };

  declare hass: HomeAssistant;
  declare _vac?: string;
  declare _st?: 'loading' | 'no_companion' | 'unsupported' | 'no_map' | 'mapping' | 'too_few' | 'preview';
  declare _res?: VacuumPlanResult;
  declare _confirm?: boolean;
  /** "Apply": the plan (for the whole card or the floor shown) */
  onApply?: (res: VacuumPlanResult) => void;
  onBack?: () => void;
  private info?: VacuumInfo;
  private timer?: number;

  protected override createRenderRoot() {
    return this;
  }

  private vacuums(): string[] {
    return Object.keys(this.hass?.states ?? {})
      .filter((id) => id.startsWith('vacuum.'))
      .sort();
  }

  override connectedCallback() {
    super.connectedCallback();
    const v = this.vacuums();
    if (v.length === 1 && !this._vac) void this.pick(v[0]);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    clearInterval(this.timer);
  }

  private name(id: string) {
    return String(this.hass.states[id]?.attributes?.friendly_name ?? id);
  }

  private async pick(id: string) {
    clearInterval(this.timer);
    this._vac = id;
    this._st = 'loading';
    this._res = undefined;
    this._confirm = false;
    this.info = await vacuumInfo(this.hass, id);
    if (this._vac !== id) return;
    if (!this.info) return void (this._st = 'no_companion');
    if (!this.info.adapter) return void (this._st = 'unsupported');
    await this.read();
  }

  /** Read the map again; without one keep looking every 20 s */
  private async read() {
    const id = this._vac;
    if (!id) return;
    const map = await vacuumMap(this.hass, id);
    if (this._vac !== id) return;
    if (!map || !map.rooms.some((r) => r.pts.length)) {
      if (this._st !== 'mapping') this._st = 'no_map';
      clearInterval(this.timer);
      this.timer = window.setInterval(() => void this.read(), 20000);
      return;
    }
    clearInterval(this.timer);
    const res = planFromVacuumMap(map, { entity: id, adapter: this.info?.adapter, hass: this.hass });
    this._res = res;
    this._st = res ? 'preview' : 'too_few';
  }

  private async mappingRun() {
    if (!this._confirm) return void (this._confirm = true);
    const id = this._vac!;
    this._confirm = false;
    await this.hass.callService('vacuum', 'start', {}, { entity_id: id });
    this._st = 'mapping';
    clearInterval(this.timer);
    this.timer = window.setInterval(() => void this.read(), 20000);
  }

  private preview(res: VacuumPlanResult) {
    const rooms = res.floor.rooms;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const r of rooms)
      for (const [x, y] of r.points) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    const m = 30;
    const vb = `${minX - m} ${minY - m} ${maxX - minX + 2 * m} ${maxY - minY + 2 * m}`;
    const fs = Math.max(14, Math.min(40, (maxX - minX) / 28));
    const mid = (pts: Point[]): Point => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
    const dock = res.floor.furniture?.find((f) => f.kind === 'robot_dock');
    return html`<svg class="vp-preview" viewBox=${vb} role="img" aria-label=${t('vacplan.preview', { n: rooms.length, d: res.floor.openings?.length ?? 0 })}>
      ${rooms.map((r, i) => svg`<polygon class="vp-room" style=${`--i:${i % 6}`} points=${r.points.map((p) => p.join(',')).join(' ')}></polygon>`)}
      ${(res.floor.openings ?? []).map((o) => svg`<line class="vp-door" x1=${o.a[0]} y1=${o.a[1]} x2=${o.b[0]} y2=${o.b[1]}></line>`)}
      ${dock ? svg`<circle class="vp-dock" cx=${dock.x} cy=${dock.y} r=${fs * 0.6}></circle>` : nothing}
      ${rooms.map((r) => {
        const [x, y] = mid(r.points);
        return svg`<text class="vp-name" x=${x} y=${y} font-size=${fs}>${r.name}</text>`;
      })}
    </svg>`;
  }

  override render() {
    const vacs = this.vacuums();
    const st = this._st;
    const back = html`<button class="btn pressable vp-back" @click=${() => this.onBack?.()}>${t('vacplan.back')}</button>`;
    const style = html`<style>
      .vp { display: flex; flex-direction: column; gap: 12px; width: 100%; text-align: center; }
      .vp-preview { width: 100%; max-height: 46vh; background: var(--fp-fill-2, rgba(120, 120, 128, 0.08)); border-radius: 12px; }
      .vp-room { fill: hsl(calc(200 + var(--i) * 32) 55% 60% / 0.28); stroke: var(--fp-label, #1c1c1e); stroke-width: 6; stroke-linejoin: round; }
      .vp-door { stroke: var(--fp-bg, #fff); stroke-width: 9; }
      .vp-dock { fill: var(--fp-accent, #0a84ff); }
      .vp-name { fill: var(--fp-label, #1c1c1e); text-anchor: middle; dominant-baseline: middle; font-weight: 600; }
      .vp-buttons { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
    </style>`;
    if (!vacs.length) return html`${style}<div class="vp"><div class="onboard-text">${t('vacplan.none')}</div><div class="vp-buttons">${back}</div></div>`;
    if (!this._vac || (vacs.length > 1 && !st))
      return html`${style}<div class="vp">
        <div class="onboard-text">${t('vacplan.pick')}</div>
        <div class="group onboard-paths">
          ${vacs.map(
            (id) => html`<button class="row pressable onboard-path vp-pick" data-entity=${id} @click=${() => this.pick(id)}>
              <ha-icon icon="mdi:robot-vacuum"></ha-icon>
              <div class="grow"><div class="title">${this.name(id)}</div></div>
              <ha-icon class="chev" icon="mdi:chevron-right"></ha-icon>
            </button>`,
          )}
        </div>
        <div class="vp-buttons">${back}</div>
      </div>`;
    const name = this.name(this._vac);
    const pickOther = vacs.length > 1 ? html`<button class="btn pressable" @click=${() => ((this._vac = undefined), (this._st = undefined))}>${t('vacplan.other')}</button>` : nothing;
    let body: unknown;
    if (st === 'loading') body = html`<div class="onboard-text" role="status">${t('vacplan.loading')}</div>`;
    else if (st === 'no_companion') body = html`<div class="onboard-text">${t('vacplan.no_companion')}</div>`;
    else if (st === 'unsupported') body = html`<div class="onboard-text">${t('vacplan.unsupported', { name })}</div>`;
    else if (st === 'too_few') body = html`<div class="onboard-text">${t('vacplan.too_few')}</div>`;
    else if (st === 'no_map' || st === 'mapping')
      body = html`<div class="onboard-text vp-nomap">${t(st === 'mapping' ? 'vacplan.mapping' : 'vacplan.no_map', { name })}</div>
        ${st === 'no_map'
          ? html`<div class="vp-buttons">
              <button class="btn accent pressable vp-maprun" @click=${() => this.mappingRun()}>
                <ha-icon icon="mdi:map-search-outline"></ha-icon>${this._confirm ? t('vacplan.map_run_confirm', { name }) : t('vacplan.map_run')}
              </button>
            </div>`
          : html`<div class="onboard-tip" role="status">${t('vacplan.waiting')}</div>`}`;
    else if (st === 'preview' && this._res)
      body = html`${this.preview(this._res)}
        <div class="onboard-text vp-summary">${t('vacplan.preview', { n: this._res.floor.rooms.length, d: this._res.floor.openings?.length ?? 0 })}</div>
        <div class="onboard-tip">${t('vacplan.preview_hint')}${this.info?.adapter === 'roborock' ? ' ' + t('vacplan.current_map') : ''}</div>
        <div class="vp-buttons">
          <button class="btn accent pressable vp-apply" @click=${() => this._res && this.onApply?.(this._res)}>
            <ha-icon icon="mdi:check"></ha-icon>${t('vacplan.apply')}
          </button>
          <button class="btn pressable vp-retry" @click=${() => this.pick(this._vac!)}>${t('vacplan.retry')}</button>
        </div>`;
    return html`${style}<div class="vp" data-state=${st ?? ''}>
      <div class="onboard-text"><b>${name}</b></div>
      ${body}
      <div class="vp-buttons">${pickOther}${back}</div>
    </div>`;
  }
}

if (!customElements.get('fp-vacuum-start')) customElements.define('fp-vacuum-start', FpVacuumStart);
