import { LitElement, html, nothing, svg } from 'lit';
import type { FloorConfig, HomeAssistant, Point } from '../types';
import { t } from '../i18n';
import { vacuumInfo, vacuumMaps } from '../entry-server';
import { homeFromMaps, pickInfo, readVacuumMaps, STOREY_PICKS, type FloorPick, type MapTurn, type VacuumHomeResult, type VacuumMapsRead, type VacuumSource } from '../vacuum-plan';
import { haFloorsSorted } from '../home-floors';
import { guessHome, type HomeGuess, type HomeKind } from '../home-floors';

/**
 * First steps "from the vacuum's map" (loaded only when chosen): pick the vacuum (or all of them — a house with one
 * per floor), read every map it keeps (companion), make a plan of the home from them — one floor per map, put on
 * Home Assistant's floors — and show it as a preview, one tab per floor. "Flat or house" and the number of floors
 * are suggested (Home Assistant's floors, several maps, areas like a garden or stairs) and can be changed. A map the
 * robot keeps but the integration has not loaded is named, with a hint; switching the robot's map only after a
 * second tap and only while it is docked. "Apply" opens the editor with it as an unsaved draft. No map yet: a
 * mapping run (after a second tap), and the map is read again every 20 s until it is there.
 * Renders into the card's own shadow root (light DOM) so the card's styles apply. Part of the editor's bundle.
 */
export class FpVacuumStart extends LitElement {
  static override properties = {
    hass: { attribute: false },
    mode: {},
    home: { attribute: false },
    _vac: { state: true },
    _st: { state: true },
    _res: { state: true },
    _confirm: { state: true },
    _kind: { state: true },
    _n: { state: true },
    _tab: { state: true },
    _switch: { state: true },
    _picks: { state: true },
    _turns: { state: true },
    _same: { state: true },
  };

  declare hass: HomeAssistant;
  /** 'card': a new card (flat or house); 'floor': fill the one empty floor shown */
  declare mode: 'card' | 'floor';
  /** the first steps' answer to "flat or house?" (else suggested here, with the maps counted) */
  declare home?: { kind: HomeKind; n: number };
  /** a vacuum's entity, or '*' for all of them */
  declare _vac?: string;
  declare _st?: 'loading' | 'no_companion' | 'unsupported' | 'no_map' | 'mapping' | 'too_few' | 'not_loaded' | 'preview';
  declare _res?: VacuumHomeResult;
  declare _confirm?: boolean;
  declare _kind: HomeKind;
  declare _n: number;
  declare _tab: number;
  /** "switch to map …": tapped once (asks), keyed by `entity|map id` */
  declare _switch?: string;
  /** which floor each map is (`entity|map id` → pick); unset: still to choose */
  declare _picks: Record<string, FloorPick | undefined>;
  /** how each map's floor is turned */
  declare _turns: Record<string, MapTurn>;
  /** "Für alle Etagen gleich": a turn goes to every map */
  declare _same: boolean;
  /** "Apply": the plan (all floors for a new card, the first for one floor) */
  onApply?: (res: VacuumHomeResult) => void;
  onBack?: () => void;
  private sources: (VacuumSource & { select?: string | null })[] = [];
  private maps?: VacuumMapsRead;
  private guess?: HomeGuess;
  private touched = false;
  private timer?: number;

  constructor() {
    super();
    this.mode = 'card';
    this._kind = 'flat';
    this._n = 1;
    this._tab = 0;
    this._picks = {};
    this._turns = {};
    this._same = true;
  }

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
    return id === '*' ? t('vacplan.all') : String(this.hass.states[id]?.attributes?.friendly_name ?? id);
  }

  private async pick(id: string) {
    clearInterval(this.timer);
    this._vac = id;
    this._st = 'loading';
    this._res = undefined;
    this._confirm = false;
    this._tab = 0;
    this._picks = {};
    this._turns = {};
    this._same = true;
    this.maps = undefined;
    this.touched = false;
    await this.read();
  }

  /** Read the maps again; without any keep looking every 20 s */
  private async read() {
    const id = this._vac;
    if (!id) return;
    const ids = id === '*' ? this.vacuums() : [id];
    const sources: typeof this.sources = [];
    let companion = false;
    let supported = false;
    for (const e of ids) {
      const info = await vacuumInfo(this.hass, e);
      if (!info) continue;
      companion = true;
      if (!info.adapter) continue;
      supported = true;
      const all = await vacuumMaps(this.hass, e);
      if (all?.maps.length) sources.push({ entity: e, adapter: info.adapter, maps: all.maps, select: all.select });
    }
    if (this._vac !== id) return;
    if (!companion) return void (this._st = 'no_companion');
    if (!supported) return void (this._st = 'unsupported');
    this.sources = sources;
    const geo = sources.flatMap((s) => s.maps.filter((m) => m.map?.rooms.some((r) => r.pts.length)));
    if (!geo.length) {
      clearInterval(this.timer);
      this.timer = window.setInterval(() => void this.read(), 20000);
      // the robot keeps maps, the integration has none of them loaded
      if (sources.some((s) => s.maps.length)) return void (this._st = 'not_loaded');
      if (this._st !== 'mapping') this._st = 'no_map';
      return;
    }
    clearInterval(this.timer);
    if (!this.touched) {
      this.guess = guessHome(this.hass, geo.length);
      const h = this.home ? { ...this.home, n: Math.max(this.home.n, this.home.kind === 'house' ? geo.length : 1) } : this.guess;
      if (this.home) this.guess = { ...this.guess, why: undefined };
      this._kind = this.mode === 'floor' ? 'flat' : h.kind;
      this._n = this.mode === 'floor' ? 1 : h.n;
    }
    this.make();
  }

  private make() {
    // the maps are read (and the suggestions made) once per reading; picks and turns are kept by map
    if (!this.maps || this.maps.maps.length !== this.sources.flatMap((s) => s.maps.filter((m) => m.map?.rooms.some((r) => r.pts.length))).length) {
      this.maps = readVacuumMaps(this.sources, this.hass);
      const picks = { ...this._picks };
      for (const m of this.maps?.maps ?? []) if (!(m.key in picks)) picks[m.key] = m.guess;
      this._picks = picks;
    }
    const res = this.maps ? homeFromMaps(this.maps, this.needPick() ? this._picks : {}, this._turns, { hass: this.hass, kind: this._kind, n: this._kind === 'house' ? Math.max(2, this._n) : 1, pending: this.needPick() }) : undefined;
    if (res && this.mode === 'floor') res.floors = res.floors.filter((f) => f.rooms.length).slice(0, 1);
    this._res = res;
    this._tab = Math.min(this._tab, Math.max(0, (res?.floors.length ?? 1) - 1));
    this._st = res ? 'preview' : 'too_few';
  }

  private setKind(kind: HomeKind, n?: number) {
    this.touched = true;
    this._kind = kind;
    this._n = Math.max(kind === 'house' ? 2 : 1, Math.min(6, n ?? (kind === 'house' ? Math.max(2, this._n) : 1)));
    this.make();
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

  /** Switch the robot to a map the integration has not loaded (second tap; only while docked) */
  private async switchMap(entity: string, select: string, name: string, key: string) {
    if (this._switch !== key) return void (this._switch = key);
    this._switch = undefined;
    await this.hass.callService('select', 'select_option', { option: name }, { entity_id: select });
    clearInterval(this.timer);
    this.timer = window.setInterval(() => void this.read(), 20000);
  }

  private preview(f: FloorConfig) {
    const rooms = f.rooms;
    if (!rooms.length) return html`<div class="vp-empty onboard-tip">${t('vacplan.floor_empty')}</div>`;
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
    const dock = f.furniture?.find((x) => x.kind === 'robot_dock');
    return html`<svg class="vp-preview" viewBox=${vb} role="img" aria-label=${t('vacplan.preview', { n: rooms.length, d: f.openings?.length ?? 0 })}>
      ${rooms.map((r, i) => svg`<polygon class="vp-room" style=${`--i:${i % 6}`} points=${r.points.map((p) => p.join(',')).join(' ')}></polygon>`)}
      ${(f.openings ?? []).map((o) => svg`<line class="vp-door" x1=${o.a[0]} y1=${o.a[1]} x2=${o.b[0]} y2=${o.b[1]}></line>`)}
      ${dock ? svg`<circle class="vp-dock" cx=${dock.x} cy=${dock.y} r=${fs * 0.6}></circle>` : nothing}
      ${rooms.map((r) => {
        const [x, y] = mid(r.points);
        return svg`<text class="vp-name" x=${x} y=${y} font-size=${fs}>${r.name}</text>`;
      })}
    </svg>`;
  }

  /** "Flat or house?" and how many floors — suggested, always changeable */
  private homeQuestion() {
    if (this.mode === 'floor') return nothing;
    const why = this.guess?.why;
    return html`<div class="vp-home">
      <div class="vp-q">${t('home.question')}</div>
      <div class="vp-seg" role="group" aria-label=${t('home.question')}>
        <button class="btn pressable ${this._kind === 'flat' ? 'accent' : ''}" data-home="flat" aria-pressed=${this._kind === 'flat'} @click=${() => this.setKind('flat')}>${t('home.flat')}</button>
        <button class="btn pressable ${this._kind === 'house' ? 'accent' : ''}" data-home="house" aria-pressed=${this._kind === 'house'} @click=${() => this.setKind('house')}>${t('home.house')}</button>
      </div>
      ${this._kind === 'house'
        ? html`<div class="vp-n">
            <span>${t('home.floors')}</span>
            <button class="icon-btn pressable" data-floors-minus aria-label=${t('home.fewer')} ?disabled=${this._n <= 2} @click=${() => this.setKind('house', this._n - 1)}><ha-icon icon="mdi:minus"></ha-icon></button>
            <b class="num" data-floors-n>${this._n}</b>
            <button class="icon-btn pressable" data-floors-plus aria-label=${t('home.more')} ?disabled=${this._n >= 6} @click=${() => this.setKind('house', this._n + 1)}><ha-icon icon="mdi:plus"></ha-icon></button>
          </div>`
        : nothing}
      ${why && !this.touched ? html`<div class="onboard-tip vp-why">${t(`home.why_${why}`)}</div>` : nothing}
    </div>`;
  }

  /** Maps the robot keeps that the integration has not loaded: say so; switch only after asking, only docked */
  private missingHints() {
    const miss = this._res?.missing ?? this.sources.flatMap((s) => s.maps.filter((m) => !m.map).map((m) => ({ entity: s.entity, id: m.id, name: m.name || m.id })));
    if (!miss.length) return nothing;
    return html`<div class="vp-missing">
      ${miss.map((m) => {
        const src = this.sources.find((s) => s.entity === m.entity);
        const docked = this.hass.states[m.entity]?.state === 'docked';
        const key = `${m.entity}|${m.id}`;
        return html`<div class="onboard-tip vp-miss" data-map=${m.id}>
          ${t('vacplan.not_loaded', { map: m.name })}
          ${src?.select
            ? docked
              ? html`<button class="btn pressable vp-switch" @click=${() => this.switchMap(m.entity, src.select!, m.name, key)}>
                  ${this._switch === key ? t('vacplan.switch_confirm', { map: m.name }) : t('vacplan.switch', { map: m.name })}
                </button>`
              : html`<span class="vp-dockfirst">${t('vacplan.switch_docked')}</span>`
            : nothing}
        </div>`;
      })}
    </div>`;
  }

  /** Several maps, or a house: say which floor each map is (a suggestion at most, confirmed by the person) */
  private needPick(): boolean {
    return this.mode === 'card' && ((this.maps?.maps.length ?? 0) > 1 || this._kind === 'house');
  }

  /** The maps still without a floor (not counting "skip") */
  private unpicked(): string[] {
    if (!this.needPick()) return [];
    return (this.maps?.maps ?? []).filter((m) => !this._picks[m.key]).map((m) => m.key);
  }

  /** A pick for one map; a floor another map has already: the two swap */
  private setPick(key: string, pick: FloorPick | undefined) {
    const picks = { ...this._picks };
    const before = picks[key];
    if (pick && pick !== 'skip' && !pick.startsWith('own:'))
      for (const [k, v] of Object.entries(picks)) if (k !== key && v === pick) picks[k] = before && before !== 'skip' ? before : undefined;
    picks[key] = pick;
    this._picks = picks;
    this.touched = true;
    this.make();
  }

  /** Turn the shown map (or all of them, "Für alle Etagen gleich") */
  private turn(key: string | undefined, fn: (t: MapTurn) => MapTurn) {
    const keys = this._same || !key ? (this.maps?.maps ?? []).map((m) => m.key) : [key];
    const turns = { ...this._turns };
    for (const k of keys) turns[k] = fn(turns[k] ?? { q: 0, fine: 0, mirror: false });
    this._turns = turns;
    this.make();
  }

  private mapLabel(key: string): string {
    const m = this.maps?.maps.find((x) => x.key === key);
    if (!m) return key;
    const several = new Set(this.maps!.maps.map((x) => x.entity)).size > 1;
    const map = m.mapName || m.mapId;
    return several ? `${map} · ${this.name(m.entity)}` : map;
  }

  /** "Welche Etage ist welche?": one row per map, a choice of floors; the suggestion marked as one, unsure: "Bitte wählen" */
  private picksList(curKey?: string) {
    if (!this.needPick() || !this.maps) return nothing;
    const ha = haFloorsSorted(this.hass);
    const offers: FloorPick[] = ha.length ? [...ha].reverse().map((h) => `ha:${h.floor_id}`) : [...STOREY_PICKS].reverse();
    const level = (o: FloorPick) => (o.startsWith('ha:') ? this.hass.floors?.[o.slice(3)]?.level : undefined);
    return html`<div class="vp-picks" role="group" aria-label=${t('vacplan.which_floor')}>
      <div class="vp-q">${t('vacplan.which_floor')}</div>
      ${this.maps.maps.map((m) => {
        const pick = this._picks[m.key];
        const own = !!pick?.startsWith('own:');
        const sel = own ? 'own' : (pick ?? '');
        const suggested = !!pick && pick === m.guess;
        const state = !pick ? 'open' : suggested ? 'suggested' : 'chosen';
        const label = t('vacplan.map_is', { map: this.mapLabel(m.key) });
        return html`<div class="vp-pick-row ${m.key === curKey ? 'cur' : ''}" data-map-key=${m.key} data-state=${state}>
          <button class="vp-map-name" @click=${() => this.showMap(m.key)}>${label}</button>
          <select class="field inline vp-floor-pick" aria-label=${label} @change=${(e: Event) => {
            const v = (e.target as HTMLSelectElement).value;
            this.setPick(m.key, v === 'own' ? `own:${own ? pick!.slice(4) : ''}` : v || undefined);
          }}>
            <option value="" ?selected=${sel === ''} disabled>${t('vacplan.pick_please')}</option>
            ${offers.map((o) => {
              const lv = level(o);
              return html`<option value=${o} ?selected=${sel === o}>${pickInfo(o, this.hass)?.name ?? o}${typeof lv === 'number' ? ` (${lv})` : ''}</option>`;
            })}
            <option value="own" ?selected=${sel === 'own'}>${t('vacplan.pick_own')}</option>
            <option value="skip" ?selected=${sel === 'skip'}>${t('vacplan.pick_skip')}</option>
          </select>
          ${own
            ? html`<input class="field inline vp-own" type="text" maxlength="40" .value=${pick!.slice(4)} placeholder=${t('vacplan.pick_own_ph')} aria-label=${t('vacplan.pick_own_ph')}
                @change=${(e: Event) => this.setPick(m.key, `own:${(e.target as HTMLInputElement).value.trim()}`)} />`
            : nothing}
          <span class="vp-pick-note">${!pick ? t(m.why === 'conflict' ? 'vacplan.pick_conflict' : 'vacplan.pick_unsure') : suggested ? t(m.why === 'areas' ? 'vacplan.pick_by_rooms' : 'vacplan.pick_by_name') : nothing}</span>
        </div>`;
      })}
    </div>`;
  }

  /** Show the floor a map became (its tab) */
  private showMap(key: string) {
    const i = this.sortedFloors().findIndex((f) => this._res?.source?.[f.id] === key);
    if (i >= 0) this._tab = i;
  }

  private sortedFloors(): FloorConfig[] {
    return [...(this._res?.floors ?? [])].sort((a, b) => (b.level ?? 0) - (a.level ?? 0));
  }

  /** "Richtig herum": quarter turns, mirror, a fine correction – the preview turns at once */
  private turnControls(key: string | undefined) {
    if (!key) return nothing;
    const tr = this._turns[key] ?? { q: 0, fine: 0, mirror: false };
    const many = (this.maps?.maps.length ?? 0) > 1;
    return html`<div class="vp-turn" data-turn-key=${key}>
      <div class="vp-q">${t('vacplan.turn_title')}</div>
      <div class="vp-buttons">
        <button class="btn pressable" data-turn="-1" aria-label=${t('vacplan.turn_left')} title=${t('vacplan.turn_left')} @click=${() => this.turn(key, (x) => ({ ...x, q: x.q - 1 }))}><ha-icon icon="mdi:rotate-left"></ha-icon>90°</button>
        <button class="btn pressable" data-turn="1" aria-label=${t('vacplan.turn_right')} title=${t('vacplan.turn_right')} @click=${() => this.turn(key, (x) => ({ ...x, q: x.q + 1 }))}><ha-icon icon="mdi:rotate-right"></ha-icon>90°</button>
        <button class="btn pressable ${tr.mirror ? 'accent' : ''}" data-mirror aria-pressed=${tr.mirror} @click=${() => this.turn(key, (x) => ({ ...x, mirror: !x.mirror }))}><ha-icon icon="mdi:flip-horizontal"></ha-icon>${t('vacplan.mirror')}</button>
      </div>
      <label class="vp-fine">
        <span>${t('vacplan.fine')}</span>
        <input type="range" min="-15" max="15" step="0.5" data-fine .value=${String(tr.fine)} @input=${(e: Event) => {
          const v = Number((e.target as HTMLInputElement).value);
          this.turn(key, (x) => ({ ...x, fine: v }));
        }} />
        <output class="num">${tr.fine > 0 ? '+' : ''}${tr.fine}°</output>
      </label>
      ${many ? html`<label class="vp-same"><input type="checkbox" data-same .checked=${this._same} @change=${(e: Event) => (this._same = (e.target as HTMLInputElement).checked)} /> ${t('vacplan.turn_all')}</label>` : nothing}
      <div class="onboard-tip">${t('vacplan.turn_hint')}</div>
    </div>`;
  }

  /** Before "Apply": which map becomes which floor, one line each */
  private summary() {
    if (!this.needPick() || !this.maps) return nothing;
    return html`<ul class="vp-assign">
      ${this.maps.maps.map((m) => {
        const pick = this._picks[m.key];
        const name = !pick ? t('vacplan.pick_please') : pick === 'skip' ? t('vacplan.pick_skip') : pickInfo(pick, this.hass)?.name || t('vacplan.pick_own');
        return html`<li data-assign=${m.key}>${t('vacplan.assign_line', { map: this.mapLabel(m.key), floor: name })}${pick && pick === m.guess ? html` <span class="vp-sug">${t('vacplan.suggested')}</span>` : nothing}</li>`;
      })}
    </ul>`;
  }

  override render() {
    const vacs = this.vacuums();
    const st = this._st;
    const back = html`<button class="btn pressable vp-back" @click=${() => this.onBack?.()}>${t('vacplan.back')}</button>`;
    const style = html`<style>
      .vp { display: flex; flex-direction: column; gap: 12px; width: 100%; text-align: center; }
      .vp-preview { width: 100%; max-height: 42vh; background: var(--fp-fill-2, rgba(120, 120, 128, 0.08)); border-radius: 12px; }
      .vp-room { fill: hsl(calc(200 + var(--i) * 32) 55% 60% / 0.28); stroke: var(--fp-label, #1c1c1e); stroke-width: 6; stroke-linejoin: round; }
      .vp-door { stroke: var(--fp-bg, #fff); stroke-width: 9; }
      .vp-dock { fill: var(--fp-accent, #0a84ff); }
      .vp-name { fill: var(--fp-label, #1c1c1e); text-anchor: middle; dominant-baseline: middle; font-weight: 600; }
      .vp-buttons, .vp-seg, .vp-tabs, .vp-n { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; align-items: center; }
      .vp-home { display: flex; flex-direction: column; gap: 6px; align-items: center; }
      .vp-q { font-weight: 600; }
      .vp-tabs .btn { min-height: 34px; }
      .vp-empty { padding: 32px 12px; background: var(--fp-fill-2, rgba(120, 120, 128, 0.08)); border-radius: 12px; }
      .vp-missing { display: flex; flex-direction: column; gap: 6px; }
      .vp-miss { display: flex; flex-direction: column; gap: 6px; align-items: center; }
      .vp-picks, .vp-turn { display: flex; flex-direction: column; gap: 8px; align-items: stretch; text-align: left; }
      .vp-picks .vp-q, .vp-turn .vp-q { text-align: center; }
      .vp-pick-row { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; padding: 8px 10px; border-radius: 12px; background: var(--fp-fill-2, rgba(120, 120, 128, 0.08)); }
      .vp-pick-row.cur { outline: 2px solid var(--fp-accent, #0a84ff); }
      .vp-pick-row[data-state='open'] { background: color-mix(in srgb, var(--fp-orange, #ff9500) 14%, transparent); }
      .vp-map-name { flex: 1 1 140px; text-align: left; border: 0; background: none; color: inherit; font: inherit; font-weight: 600; cursor: pointer; padding: 0; }
      .vp-floor-pick { flex: 0 1 200px; }
      .vp-own { flex: 1 1 140px; }
      .vp-pick-note { flex-basis: 100%; font-size: var(--fp-text-caption, 12px); color: var(--fp-label-2, #6e6e73); }
      .vp-pick-row[data-state='open'] .vp-pick-note { color: var(--fp-orange, #c93400); font-weight: 600; }
      .vp-fine { display: flex; gap: 10px; align-items: center; justify-content: center; }
      .vp-fine input { flex: 0 1 220px; }
      .vp-same { display: flex; gap: 6px; align-items: center; justify-content: center; }
      .vp-assign { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; font-size: var(--fp-text-subhead, 14px); }
      .vp-sug { color: var(--fp-label-2, #6e6e73); font-size: var(--fp-text-caption, 12px); }
    </style>`;
    if (!vacs.length) return html`${style}<div class="vp"><div class="onboard-text">${t('vacplan.none')}</div><div class="vp-buttons">${back}</div></div>`;
    if (!this._vac || (vacs.length > 1 && !st)) {
      const choices = this.mode === 'card' && vacs.length > 1 ? ['*', ...vacs] : vacs;
      return html`${style}<div class="vp">
        <div class="onboard-text">${t('vacplan.pick')}</div>
        <div class="group onboard-paths">
          ${choices.map(
            (id) => html`<button class="row pressable onboard-path vp-pick" data-entity=${id} @click=${() => this.pick(id)}>
              <ha-icon icon=${id === '*' ? 'mdi:home-floor-0' : 'mdi:robot-vacuum'}></ha-icon>
              <div class="grow"><div class="title">${this.name(id)}</div>${id === '*' ? html`<div class="subtitle">${t('vacplan.all_sub')}</div>` : nothing}</div>
              <ha-icon class="chev" icon="mdi:chevron-right"></ha-icon>
            </button>`,
          )}
        </div>
        <div class="vp-buttons">${back}</div>
      </div>`;
    }
    const name = this.name(this._vac);
    const pickOther = vacs.length > 1 ? html`<button class="btn pressable" @click=${() => ((this._vac = undefined), (this._st = undefined))}>${t('vacplan.other')}</button>` : nothing;
    let body: unknown;
    if (st === 'loading') body = html`<div class="onboard-text" role="status">${t('vacplan.loading')}</div>`;
    else if (st === 'no_companion') body = html`<div class="onboard-text">${t('vacplan.no_companion')}</div>`;
    else if (st === 'unsupported') body = html`<div class="onboard-text">${t('vacplan.unsupported', { name })}</div>`;
    else if (st === 'too_few') body = html`<div class="onboard-text">${t('vacplan.too_few')}</div>`;
    else if (st === 'not_loaded') body = html`${this.missingHints()}<div class="onboard-tip" role="status">${t('vacplan.waiting')}</div>`;
    else if (st === 'no_map' || st === 'mapping')
      body = html`<div class="onboard-text vp-nomap">${t(st === 'mapping' ? 'vacplan.mapping' : 'vacplan.no_map', { name })}</div>
        ${st === 'no_map' && this._vac !== '*'
          ? html`<div class="vp-buttons">
              <button class="btn accent pressable vp-maprun" @click=${() => this.mappingRun()}>
                <ha-icon icon="mdi:map-search-outline"></ha-icon>${this._confirm ? t('vacplan.map_run_confirm', { name }) : t('vacplan.map_run')}
              </button>
            </div>`
          : html`<div class="onboard-tip" role="status">${t('vacplan.waiting')}</div>`}`;
    else if (st === 'preview' && this._res) {
      const floors = this.sortedFloors();
      const cur = floors[Math.min(this._tab, floors.length - 1)];
      const curKey = this._res.source?.[cur.id] ?? (this.maps?.maps.length === 1 ? this.maps.maps[0].key : undefined);
      const open = this.unpicked();
      const rooms = this._res.floors.reduce((n, f) => n + f.rooms.length, 0);
      const doors = this._res.floors.reduce((n, f) => n + (f.openings?.length ?? 0), 0);
      body = html`${this.homeQuestion()}
        ${this.picksList(curKey)}
        ${floors.length > 1
          ? html`<div class="vp-tabs" role="tablist">
              ${floors.map(
                (f, i) => html`<button class="btn pressable vp-tab ${i === this._tab ? 'accent' : ''}" role="tab" aria-selected=${i === this._tab} data-floor=${f.id} @click=${() => (this._tab = i)}>
                  ${f.name}${f.rooms.length ? ` · ${f.rooms.length}` : ''}
                </button>`,
              )}
            </div>`
          : nothing}
        ${this.preview(cur)}
        ${this.turnControls(curKey)}
        <div class="onboard-text vp-summary">${floors.length > 1 ? t('vacplan.preview_floors', { f: floors.length, n: rooms, d: doors }) : t('vacplan.preview', { n: rooms, d: doors })}</div>
        ${this.missingHints()}
        <div class="onboard-tip">${t('vacplan.preview_hint')}</div>
        ${this.summary()}
        ${open.length ? html`<div class="onboard-tip vp-open" role="status">${t('vacplan.pick_first', { n: open.length })}</div>` : nothing}
        <div class="vp-buttons">
          <button class="btn accent pressable vp-apply" ?disabled=${open.length > 0} @click=${() => this._res && !this.unpicked().length && this.onApply?.(this._res)}>
            <ha-icon icon="mdi:check"></ha-icon>${t('vacplan.apply')}
          </button>
          <button class="btn pressable vp-retry" @click=${() => this.pick(this._vac!)}>${t('vacplan.retry')}</button>
        </div>`;
    }
    return html`${style}<div class="vp" data-state=${st ?? ''}>
      <div class="onboard-text"><b>${name}</b></div>
      ${body}
      <div class="vp-buttons">${pickOther}${back}</div>
    </div>`;
  }
}

if (!customElements.get('fp-vacuum-start')) customElements.define('fp-vacuum-start', FpVacuumStart);
