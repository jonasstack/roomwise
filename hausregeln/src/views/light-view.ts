/**
 * <hr-light-plans>: the "Licht" page. Equal room tiles (order and hiding shared with the other pages, see
 * room-arrange.ts) with the light's state, presence, lux and a switch for the room's light rules. A tile opens the
 * room's pop-up: its light plan (one row per rule → "Regel ansehen und ändern"), the intelligent light and the
 * vacation light ("bewohnt wirken"), and "Neue Lichtregel" (assistant or an own fixed rule: kind → when / as long as
 * → only if → lights and values, also "je nach …" → afterwards → name). The gear in the room's pop-up holds what only
 * the light does (room empties, after switching by hand, guests); sensors and brightness are in the one pop-up
 * "Raum einstellen" (event hr-room-settings). The page's gear: arrange rooms, links to the settings.
 */
import { css, html, nothing, type TemplateResult } from 'lit';
import { mdiClose, mdiLightningBolt, mdiInfinity, mdiLightbulbOff, mdiLightbulbOn, mdiLightbulbOutline, mdiPlus, mdiPencil, mdiArrowUp, mdiArrowDown, mdiCheckboxMarked, mdiCheckboxBlankOutline, mdiAirplane, mdiAutoFix, mdiBrain, mdiChevronRight, mdiCogOutline, mdiFloorPlan } from '@mdi/js';
import { StoreElement } from '../base';
import type { Clause, Device, LightAction, LightColor, LightPlan, LightRule, LightRuleKind, Room, SimConfig, SimView } from '../model';
import { clauseText } from '../describe';
import { icon, shared } from '../design/shared';
import { LiveStore } from '../live';
import '../components/conditions';
import '../editor/light-action';
import { lightText } from '../lightspec';
import { fmtTime, t } from '../i18n';
import { durationStepper, formatSeconds } from '../components/duration';
import { fire, fixButton } from '../design/shared';
import { featureHint } from '../components/feature';
import '../components/sheet';
import '../components/pop';
import '../components/room-arrange';
import '../components/light-add';
import { hiddenRoomsNote } from '../components/room-arrange';
import { registerPage } from '../components/page';
import { kit } from '../design/kit';
import type { Store } from '../store';
import { smartLabel } from './light-smart';
import { swatches, swatchStyles } from '../components/swatches';
import '../components/live-toggle';
import './light-glow';
import './light-cal';
import { glowMap } from './light-glow';
import { floorplanAvailable } from '../setup/dashboard';
import { assistantButton, autoAssistant, needsAssistant } from '../assistant/base';

type Pop = '' | 'basics' | 'smart' | 'vac' | 'rule' | 'delete' | 'new' | 'page' | 'arrange' | 'glow' | 'cal';

const COLORS: [LightColor, string][] = [
  ['kerze', 'Kerze'],
  ['warm', 'Warm'],
  ['neutral', 'Neutral'],
  ['kalt', 'Kalt'],
];
const KIND: Record<LightRuleKind, { label: string; hint: string; icon: string }> = {
  when: { label: 'Wenn etwas passiert', hint: 'Z. B. jemand kommt rein, setzt sich aufs Sofa, der Fernseher geht an. Danach bleibt es so, bis eine andere Regel etwas sagt.', icon: mdiLightningBolt },
  while: { label: 'Solange etwas gilt', hint: 'Z. B. solange der Fernseher läuft: gedimmt. Du legst fest, was danach passiert.', icon: mdiInfinity },
  never_on: { label: 'Nie an, solange …', hint: 'Z. B. die Deckenleuchte geht nicht an, solange der Fernseher läuft. Gewinnt gegen alle anderen Regeln.', icon: mdiLightbulbOff },
  keep_on: { label: 'Nie aus, solange …', hint: 'Z. B. solange der Fernseher läuft, bleibt das Sofalicht an, auch wenn du kurz rausgehst.', icon: mdiLightbulbOn },
};
const uid = () => Math.random().toString(36).slice(2, 8);

/** how a colour value reads: "warm", "3200 K", "Farbe #ff8800" */
function colorText(c: string): string {
  const preset = COLORS.find((x) => x[0] === c);
  if (preset) return preset[1].toLowerCase();
  if (c.startsWith('k:')) return `${c.slice(2)} K`;
  if (c.startsWith('#')) return `Farbe ${c}`;
  return c;
}

/** Kelvin → a CSS colour for the swatch */
function kelvinCss(k: number): string {
  const t = Math.max(0, Math.min(1, (k - 2000) / 4500));
  const r = 255;
  const g = Math.round(170 + 75 * t);
  const b = Math.round(90 + 165 * t);
  return `rgb(${r},${g},${b})`;
}

/** presets + own white (Kelvin slider) + any colour (colour picker) */
function colorEditor(value: string, set: (c: LightColor) => void): TemplateResult {
  const white = value.startsWith('k:');
  const k = white ? Number(value.slice(2)) : 3000;
  // easy colours as big fields (components/swatches.ts), the exact white tone as an extra
  return html`<div class="colors">
    ${swatches(value, (c) => set(c as LightColor))}
    <div class="seg">
      <button aria-pressed=${white ? 'true' : 'false'} @click=${() => set(`k:${k}` as LightColor)}>${t('sw.exact_white')}</button>
    </div>
    ${white
      ? html`<div class="range"><span class="swatch" style="background:${kelvinCss(k)}"></span><input type="range" min="2000" max="6500" step="100" .value=${String(k)} aria-label=${t('sw.exact_white')} @change=${(e: Event) => set(`k:${(e.target as HTMLInputElement).value}` as LightColor)} /><output>${k} K</output></div>`
      : nothing}
  </div>`;
}

const styles = css`
  :host {
    display: flex;
    flex-direction: column;
    gap: var(--hr-space-3);
  }
  .lead {
    color: var(--hr-label-2);
    font-size: var(--hr-text-subhead);
    margin: 0;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chips span,
  .chips button {
    border: 0;
    border-radius: 999px;
    padding: 6px 12px;
    font: inherit;
    font-size: var(--hr-text-footnote);
    font-weight: 600;
    background: var(--hr-fill);
    color: var(--hr-label);
  }
  .chips button {
    cursor: pointer;
  }
  .chips button[aria-pressed='true'],
  .chips span.on {
    background: var(--hr-accent);
    color: #fff;
  }
  .chips span.yes {
    background: color-mix(in srgb, var(--hr-green) 18%, transparent);
    color: var(--hr-green);
  }
  details.card {
    padding: 0;
  }
  details.card > summary {
    list-style: none;
    display: flex;
    align-items: center;
    gap: var(--hr-space-3);
    padding: var(--hr-space-3) var(--hr-space-4);
    cursor: pointer;
  }
  details.card > summary::-webkit-details-marker {
    display: none;
  }
  details.card > summary .grow {
    flex: 1;
    min-width: 0;
  }
  details.card > summary b {
    display: block;
  }
  details.card > summary .sub {
    font-size: var(--hr-text-footnote);
    color: var(--hr-label-2);
  }
  details[open] > summary .chev {
    transform: rotate(180deg);
  }
  .inner {
    padding: 0 var(--hr-space-4) var(--hr-space-4);
    display: flex;
    flex-direction: column;
    gap: var(--hr-space-2);
  }
  .label {
    font-size: var(--hr-text-footnote);
    font-weight: 600;
    color: var(--hr-label-2);
    margin: var(--hr-space-2) var(--hr-space-1) 0;
  }
  .note {
    font-size: var(--hr-text-footnote);
    color: var(--hr-label-2);
    margin: 0;
  }
  .sentence {
    font-family: var(--hr-font-sentence);
    font-size: var(--hr-text-subhead);
    line-height: 1.45;
  }
  .rule .kind {
    width: 36px;
    height: 36px;
    border-radius: 10px;
    display: grid;
    place-items: center;
    background: color-mix(in srgb, var(--hr-accent) 14%, transparent);
    color: var(--hr-accent);
    flex: none;
  }
  .rule.never_on .kind {
    background: color-mix(in srgb, var(--hr-red) 14%, transparent);
    color: var(--hr-red);
  }
  .rule.keep_on .kind {
    background: color-mix(in srgb, var(--hr-green) 14%, transparent);
    color: var(--hr-green);
  }
  .rule.off {
    opacity: 0.55;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .stepper {
    display: inline-flex;
    align-items: center;
    gap: var(--hr-space-2);
  }
  .stepper button {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    border: 0;
    background: var(--hr-fill);
    color: var(--hr-label);
    font-size: 18px;
    cursor: pointer;
  }
  .stepper output {
    min-width: 4.2em;
    text-align: center;
    font-weight: 600;
  }
  .range {
    display: flex;
    align-items: center;
    gap: var(--hr-space-2);
    min-height: 36px;
    flex-shrink: 0;
  }
  .range input {
    flex: 1 1 auto;
    min-width: 0;
    width: 100%;
    margin: 0;
  }
  .range output {
    flex: none;
    min-width: 3.4em;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  select,
  input.text,
  input[type='time'] {
    font: inherit;
    padding: 6px 8px;
    border-radius: 8px;
    border: 1px solid var(--hr-separator);
    background: var(--hr-surface);
    color: var(--hr-label);
    max-width: 100%;
  }
  .box {
    padding: var(--hr-space-3);
    border-radius: 12px;
    background: var(--hr-bg);
    display: flex;
    flex-direction: column;
    gap: var(--hr-space-2);
  }
  .tl .bar {
    position: relative;
    height: 10px;
    border-radius: 5px;
    background: linear-gradient(90deg, #1d2440 0%, #3b5b8c 25%, #f2c14e 50%, #e07a3f 75%, #1d2440 100%);
    opacity: 0.35;
  }
  .tl .bar span {
    position: absolute;
    top: -3px;
    bottom: -3px;
    border-radius: 6px;
    background: var(--hr-accent);
    opacity: 1;
  }
  .tl .ticks {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    color: var(--hr-label-2);
    margin-top: 2px;
  }
  .wiz .box {
    background: var(--hr-surface);
    border: 1px solid var(--hr-separator);
  }
  .facts {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px var(--hr-space-3);
    font-size: var(--hr-text-subhead);
  }
  .facts span {
    display: contents;
  }
  .facts b {
    color: var(--hr-label-2);
    font-weight: 600;
  }
  .ways {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: var(--hr-text-subhead);
  }
  .way {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
    margin: 0 6px 0 2px;
  }
  .way small {
    color: var(--hr-label-3);
    font-size: var(--hr-text-caption);
  }
  .sim {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .simrow {
    display: grid;
    grid-template-columns: 6.5em 1fr;
    align-items: center;
    gap: var(--hr-space-2);
  }
  .simrow.off {
    opacity: 0.4;
  }
  .simname {
    font-size: var(--hr-text-footnote);
    color: var(--hr-label-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .simbar {
    position: relative;
    height: 16px;
    border-radius: 4px;
    background: var(--hr-fill);
    overflow: hidden;
  }
  .simbar i,
  .simlegend i {
    position: absolute;
    top: 0;
    bottom: 0;
    border-radius: 3px;
    background: var(--hr-accent);
  }
  .simbar i.pass,
  .simlegend i.pass {
    background: color-mix(in srgb, var(--hr-accent) 40%, transparent);
  }
  .simbar i.bed,
  .simbar i.wake,
  .simbar i.night,
  .simlegend i.bed {
    background: #8e7cc3;
  }
  .simbar .now {
    position: absolute;
    top: -2px;
    bottom: -2px;
    width: 2px;
    background: var(--hr-red, #e5484d);
  }
  .simticks {
    position: relative;
    height: 14px;
    font-size: var(--hr-text-caption);
    color: var(--hr-label-3);
  }
  .simticks span {
    position: absolute;
    top: 0;
    transform: translateX(-50%);
    white-space: nowrap;
  }
  .simticks span:first-child {
    transform: none;
  }
  .simticks span:last-child {
    transform: translateX(-100%);
  }
  .simlegend {
    display: flex;
    flex-wrap: wrap;
    gap: var(--hr-space-3);
    font-size: var(--hr-text-caption);
    color: var(--hr-label-2);
  }
  .simlegend span {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .simlegend i {
    position: static;
    display: inline-block;
    width: 14px;
    height: 10px;
  }
  .colors {
    display: flex;
    flex-direction: column;
    gap: var(--hr-space-2);
  }
  .swatch {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    flex: none;
    border: 1px solid var(--hr-separator);
  }
  input.picker {
    width: 56px;
    height: 36px;
    padding: 0;
    border: 0;
    background: none;
    flex: none;
  }
  .own-end {
    display: flex;
    flex-direction: column;
    gap: var(--hr-space-3);
    padding: var(--hr-space-3) var(--hr-space-4);
    border-radius: var(--hr-radius-m, 12px);
  }
  .own-end .seg {
    align-self: flex-start;
  }
  .check {
    display: flex;
    gap: var(--hr-space-3);
    align-items: flex-start;
    text-align: left;
    padding: var(--hr-space-3);
    border-radius: 12px;
    border: 0;
    background: var(--hr-surface);
    color: var(--hr-label);
    font: inherit;
    cursor: pointer;
  }
  .check > svg {
    flex: none;
    color: var(--hr-accent);
  }
  .check b {
    display: block;
  }
  .check span span {
    font-size: var(--hr-text-footnote);
    color: var(--hr-label-2);
  }
  .variant {
    border-left: 4px solid var(--hr-accent);
  }
  .variant .vh {
    display: flex;
    align-items: center;
    gap: var(--hr-space-2);
  }
  .variant .vh b {
    flex: 1;
  }
  .variant hr-conditions {
    min-width: 0;
  }
  /* assistant */
  .wiz {
    display: flex;
    flex-direction: column;
    gap: var(--hr-space-3);
    padding: var(--hr-space-4);
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    min-height: 0;
  }
  /* a scrolling column must never squeeze its children (else sliders slide over the text above) */
  .wiz > *,
  .box > *,
  .inner > * {
    min-width: 0;
    flex-shrink: 0;
  }
  input[type='range'] {
    height: 28px;
  }
  .dots {
    display: flex;
    gap: 6px;
    justify-content: center;
  }
  .dots span {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--hr-fill);
  }
  .dots span.on {
    background: var(--hr-accent);
  }
  .wiz h3 {
    margin: 0;
    font-size: var(--hr-text-title3, 20px);
  }
  .kinds {
    display: grid;
    gap: var(--hr-space-2);
  }
  .kinds button {
    display: flex;
    gap: var(--hr-space-3);
    align-items: flex-start;
    text-align: left;
    padding: var(--hr-space-3);
    border-radius: 12px;
    border: 2px solid transparent;
    background: var(--hr-surface);
    color: var(--hr-label);
    font: inherit;
    cursor: pointer;
  }
  .kinds button[aria-pressed='true'] {
    border-color: var(--hr-accent);
  }
  .kinds b {
    display: block;
    color: var(--hr-label);
    font-size: var(--hr-text-body);
  }
  .kinds svg {
    flex: none;
    color: var(--hr-accent);
  }
  .kinds span {
    font-size: var(--hr-text-footnote);
    color: var(--hr-label-2);
  }
  .nav {
    display: flex;
    justify-content: space-between;
    gap: var(--hr-space-2);
    padding: var(--hr-space-3) var(--hr-space-4);
    border-top: 1px solid var(--hr-separator);
  }

  /* the room pop-up's light plan: kind of rule as a coloured square */
  .rl-item .k {
    width: 36px;
    height: 36px;
    border-radius: var(--hr-radius-s);
    display: grid;
    place-items: center;
    flex: none;
    color: #fff;
    background: var(--hr-when, var(--hr-accent));
  }
  .rl-item .k.while {
    background: var(--hr-while, var(--hr-accent));
  }
  .rl-item .k.never_on {
    background: var(--hr-red);
  }
  .rl-item .k.keep_on {
    background: var(--hr-green);
  }
  .rl-item small.clamp {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .rl-item .live {
    color: var(--hr-green);
    font-weight: 600;
  }
  button.rl-item {
    cursor: pointer;
  }
  .wiz.flat {
    padding: 0;
    overflow: visible;
    min-height: auto;
    flex: none;
  }
  /* three equal room tiles per row on a laptop (as designed) */
  .rl-grid {
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  }
`;

function stepper(value: number, unit: string, set: (v: number) => void, step: number, min: number, max: number): TemplateResult {
  return html`<span class="stepper">
    <button aria-label="weniger" @click=${() => set(Math.max(min, value - step))}>−</button>
    <output>${value} ${unit}</output>
    <button aria-label="mehr" @click=${() => set(Math.min(max, value + step))}>+</button>
  </span>`;
}

export class HrLightPlans extends StoreElement {
  static override properties = {
    ...StoreElement.properties,
    _room: { state: true },
    _wiz: { state: true },
    _step: { state: true },
    _pop: { state: true },
    _rule: { state: true },
    _sim: { state: true },
    _simDay: { state: true },
    _glowMap: { state: true },
    _others: { state: true },
    _lightAdd: { state: true },
  };
  /** "Licht hinzufügen" open: for which room, and from a light rule (then "Nur in dieser Regel" too) */
  declare _lightAdd: { room: string; rule: boolean } | null;
  /** the light rule's lamp choice shows the lamps of the other rooms too ("+ Lichter aus anderen Räumen") */
  declare _others: boolean;
  /** the pop-up open on top of the room's (or of the page) */
  declare _pop: Pop;
  /** the light rule shown in "Regel ansehen und ändern" */
  declare _rule: string;
  declare _sim: SimView | null;
  declare _simDay: number;
  /** the floor plan card is set up (with rooms): only then the Reinschau-Licht is offered */
  declare _glowMap: boolean;
  declare _room: string;
  declare _wiz: LightRule | null;
  declare _step: number;

  constructor() {
    super();
    this._room = '';
    this._wiz = null;
    this._step = 0;
    this._pop = '';
    this._rule = '';
    this._sim = null;
    this._simDay = 0;
    this._glowMap = false;
  }

  static override styles = [shared, kit, swatchStyles, styles];

  override connectedCallback() {
    super.connectedCallback();
    this._loadSim();
    if (floorplanAvailable(this.store)) glowMap(this.store).then((f) => (this._glowMap = !!f?.some((x) => x.rooms.length)));
  }

  /** Reinschau-Licht: a tile of its own, only when the floor plan card is set up */
  private _glowTile() {
    const n = Object.values(this.store.plans?.light ?? {}).filter((p) => p.glow?.on).length;
    return html`<div class="rl-tile acc">
      <button class="rl-open" aria-label=${t('glow.title')} @click=${() => (this._pop = 'glow')}></button>
      <div class="top">
        <span class="rl-ic">${icon(mdiFloorPlan, 24)}</span>
        <span class="grow"><h2>${t('glow.title')}</h2><div class="state">${t('glow.tile_sub')}</div></span>
        <span class="go">${icon(mdiChevronRight, 20)}</span>
      </div>
      <div class="foot"><span>${n ? t('glow.n_on', { n }) : t('glow.none_on')}</span></div>
    </div>`;
  }

  private async _loadSim(day = this._simDay) {
    const d = new Date(Date.now() - 4 * 3600 * 1000 + day * 86400 * 1000);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    this._sim = await this.store.sim('view', iso).catch(() => null);
  }

  private async _simSet(patch: Partial<SimConfig>) {
    this._sim = await this.store.sim('set', patch).catch(() => this._sim);
    if (this._simDay) await this._loadSim();
  }

  private _openVac() {
    this._pop = 'vac';
    this._loadSim();
  }

  /** link from Zuhause → Urlaub: "vacation:<room>" opens that room's vacation settings */
  protected override reveal(anchor: string): void {
    const m = /^vacation:(.+)$/.exec(anchor);
    if (!m) return super.reveal(anchor);
    this._room = m[1];
    this._openVac();
  }

  /** the assistant keeps its own draft: live updates wait until it is closed */
  protected override frozen(): boolean {
    return !!this._wiz;
  }

  override updated(changed: Map<string, unknown>): void {
    super.updated?.(changed);
    if (changed.has('_wiz') && !this._wiz) this.thaw();
    // first visit without any setup: the feature's assistant (light first, then the vacation)
    const s = this.store;
    if (s.plans) {
      autoAssistant(this, s, 'light');
      if (!needsAssistant(s, 'light')) autoAssistant(this, s, 'vacation');
    }
  }

  // ------------------------------------------------------------------ data
  /** every room – a room without lamps shows a hint to assign them (Raum einstellen) */
  private get _rooms(): Room[] {
    return this.store.rooms;
  }

  private _plan(rid: string): LightPlan | undefined {
    return this.store.plans?.light[rid];
  }

  private _save(rid: string, patch: Partial<LightPlan>) {
    const p = this._plan(rid);
    if (p) this.store.planSet('light', rid, { ...p, ...patch });
  }

  /** the lights of a room (for "Live an den Lampen" when a setting says "all in the room") */
  private _roomLightIds(r: Room): string[] {
    return this.store.devices.filter((d) => d.kind === 'light' && d.room === r.id).map((d) => d.entity_id);
  }

  private _name(id: string) {
    return this.store.device(id)?.name ?? this.store.entity(id)?.name ?? id;
  }

  /** "Alle im Raum" are the lights found in the room: each with "ändern / nicht verwenden" (counts everywhere) */
  private _foundLights(own: Device[]) {
    if (!own.length || !this.store.admin) return nothing;
    return html`<details class="found">
      <summary class="note">Erkannte Lichter im Raum: ${own.length}. Falsch erkannt? Ändern oder nicht verwenden.</summary>
      <div class="group">${own.map((d) => html`<div class="row fixrow"><span class="pick"><span class="grow"><div class="title">${d.name}</div></span></span>${fixButton(this, d.entity_id)}</div>`)}</div>
    </details>`;
  }

  /** lights to choose from: the room's first, then lights without a room (best name match first) */
  private _lightChoice(r: Room) {
    const s = this.store;
    const own = s.devices.filter((d) => d.kind === 'light' && d.room === r.id);
    const stem = r.name.toLowerCase().replace(/e$/, '');
    const loose = s.devices
      .filter((d) => d.kind === 'light' && !d.room)
      .sort((a, b) => Number(b.name.toLowerCase().includes(stem)) - Number(a.name.toLowerCase().includes(stem)) || a.name.localeCompare(b.name, 'de'));
    return { own, loose };
  }

  private _lightsText(r: Room, ids: string[]) {
    return ids.length ? ids.map((e) => this._name(e)).join(', ') : `alle Lichter ${r.in}`;
  }

  private _actionText(a: LightAction) {
    return a.mode === 'on' ? `${t('light.on')}, ${lightText(a)}` : lightText(a);
  }

  private _conds(list: Clause[], joiner = 'und') {
    return list.map((c) => clauseText(this.store, c, 'and')).join(` ${joiner} `);
  }

  private _except(x: LightRule) {
    const parts = [];
    if ((x.except ?? []).length) parts.push(`außer wenn ${this._conds(x.except!, 'oder')}`);
    const names = (x.allow ?? []).map((a) => (a.startsWith('rule:') ? this.store.rule(a.slice(5))?.name : (Object.values(this.store.plans?.light ?? {}).flatMap((p) => p.rules).find((y) => `light:${y.id}` === a)?.name)) ?? a);
    if (names.length) parts.push(`erlaubt für: ${names.join(', ')}`);
    return parts.length ? `, ${parts.join(', ')}` : '';
  }

  private _cond_link(r: Room, x: LightRule) {
    const parts = [];
    if (x.when.length) parts.push(this._conds(x.when));
    const names = (x.linked ?? []).map((id) => this._plan(r.id)?.rules.find((y) => y.id === id)?.name).filter(Boolean);
    if (names.length) parts.push(`„${names.join('“ und „')}“ gilt`);
    return parts.join(' und ') || '…';
  }

  /** the rule as one sentence */
  private _sentence(r: Room, x: LightRule): string {
    const lights = this._lightsText(r, x.lights);
    const variants = x.variants.length ? `; je nach: ${x.variants.map((v) => `${this._conds(v.when)} → ${this._actionText(v)}`).join('; ')}` : '';
    switch (x.kind) {
      case 'when':
        return `Wenn ${this._conds(x.trigger, 'oder') || '…'}${x.when.length ? `, nur wenn ${this._conds(x.when)}` : ''}: ${lights} ${this._actionText(x.action)}${variants}.`;
      case 'while':
        return `Solange ${this._conds(x.when) || '…'}: ${lights} ${this._actionText(x.action)}${variants}${(x.block_lights ?? []).length ? `. Gesperrt: ${x.block_lights!.map((e) => this._name(e)).join(', ')}${this._except(x)}` : ''}. Danach${x.follow_empty !== false ? ' (erst nach dem Nachlauf von „Wenn niemand mehr da ist“, ggf. gedimmt)' : ' (sofort)'}: ${{ restore: 'wieder wie vorher', off: 'aus', nothing: 'bleibt, wie es ist', others: 'was die anderen Regeln sagen' }[x.after]}.`;
      case 'never_on':
        return `${lights} nie von selbst an, solange ${this._cond_link(r, x)}${this._except(x)}.`;
      case 'keep_on':
        return `${lights} nie aus, solange ${this._cond_link(r, x)}${this._except(x)}. Danach, wenn niemand da ist: ${{ off: 'aus', dim: 'dimmen', keep: 'anlassen' }[x.empty_after]}.`;
    }
  }

  // ------------------------------------------------------------------ room basics (light only)
  /** gear in the room pop-up: what the light does when the room empties, after switching by hand, with guests.
   * The room's sensors and brightness live in the one pop-up "Raum einstellen" (shared with Heizung and Räume). */
  private _basicsPop(r: Room, p: LightPlan) {
    const em = p.empty;
    const st = this.store.plans?.now[r.id]?.light;
    const sensorNames = [...r.presence, ...r.motion, ...r.zones].map((e) => this._name(e));
    const close = () => (this._pop = '');
    return html`<hr-pop narrow heading=${t('light.basics')} .sub=${t('light.basics_sub', { room: r.name })} @close=${close}>
      <div class="rl-box">
        <div class="line">
          <span class="grow"><b>${t('light.sensors')}</b><small>${sensorNames.length ? sensorNames.join(', ') : t('light.no_sensors')} · ${r.lux ? `${this._name(r.lux)}${st?.lux != null ? ` · ${t('light.lux_now', { lux: Math.round(st.lux) })}` : ''}` : t('light.no_lux')}</small></span>
          <button class="btn small" @click=${() => fire(this, 'hr-room-settings', { id: r.id })}>${t('light.room_settings')}</button>
        </div>
      </div>
      <div class="rl-sec">
        <span class="eyebrow">${t('light.when_empty')}</span>
        <div class="rl-box">
          <div class="line"><span class="grow"><b>${t('light.applies_after')}</b><small>${t('light.applies_after_sub')}</small></span>${durationStepper(em.delay, (x) => this._save(r.id, { empty: { ...em, delay: x } }), 0, 120)}</div>
          <div class="line">
            <div class="seg">
              <button aria-pressed=${em.mode === 'off' ? 'true' : 'false'} @click=${() => this._save(r.id, { empty: { ...em, mode: 'off' } })}>${t('light.empty_off')}</button>
              <button aria-pressed=${em.mode === 'dim' ? 'true' : 'false'} @click=${() => this._save(r.id, { empty: { ...em, mode: 'dim' } })}>${t('light.empty_dim')}</button>
              <button aria-pressed=${em.mode === 'keep' ? 'true' : 'false'} @click=${() => this._save(r.id, { empty: { ...em, mode: 'keep' } })}>${t('light.empty_keep')}</button>
            </div>
          </div>
          ${em.mode === 'dim'
            ? html`<div class="line"><span class="grow"><b>${t('light.dim_to')}</b></span>${stepper(em.dim, '%', (x) => this._save(r.id, { empty: { ...em, dim: Math.max(1, x) } }), 5, 1, 100)}</div>
                <div class="line"><span class="grow"><b>${t('light.then_off')}</b><small>${t('light.then_off_sub')}</small></span>${durationStepper(em.dim_for, (x) => this._save(r.id, { empty: { ...em, dim_for: x } }), 0, 120)}</div>`
            : nothing}
        </div>
        <p class="rl-note">${t('light.keep_on_exception')}</p>
      </div>
      <div class="rl-sec">
        <span class="eyebrow">${t('light.manual')}</span>
        <div class="seg">
          <button aria-pressed=${p.manual === 'room_empty' ? 'true' : 'false'} @click=${() => this._save(r.id, { manual: 'room_empty' })}>${t('light.manual_room_empty')}</button>
          <button aria-pressed=${p.manual === '30m' ? 'true' : 'false'} @click=${() => this._save(r.id, { manual: '30m' })}>${t('light.manual_30m')}</button>
          <button aria-pressed=${p.manual === 'none' ? 'true' : 'false'} @click=${() => this._save(r.id, { manual: 'none' })}>${t('light.manual_none')}</button>
        </div>
        <p class="rl-note">${t('light.manual_note')}</p>
      </div>
      <div class="rl-sec">
        <span class="eyebrow">${t('light.guests')}</span>
        <div class="rl-box">
          <div class="line"><span class="grow"><b>${t('light.guests_keep')}</b><small>${t('light.guests_keep_sub')}</small></span><button class="switch" role="switch" aria-label=${t('light.guests_keep')} aria-checked=${p.guests_keep ? 'true' : 'false'} @click=${() => this._save(r.id, { guests_keep: !p.guests_keep })}></button></div>
        </div>
      </div>
      <button slot="foot" class="btn primary" @click=${close}>${t('common.done')}</button>
    </hr-pop>`;
  }

  /** today's sunset as minutes after midnight (for the vacation timeline) */
  private _sunset(): number {
    const live = this.store instanceof LiveStore ? this.store : undefined;
    const nxt = live?.hass.states['sun.sun']?.attributes.next_setting as string | undefined;
    if (!nxt) return 18 * 60 + 45;
    const d = new Date(nxt);
    return d.getHours() * 60 + d.getMinutes();
  }

  private _vacTimes(v: LightPlan['vacation']): { from: number; to: number; fromText: string } {
    const hm = (t: string) => {
      const [h, m] = t.split(':').map(Number);
      return (h || 0) * 60 + (m || 0);
    };
    const from = v.start === 'sunset' ? this._sunset() + v.offset : hm(v.time);
    const off = v.offset ? ` ${v.offset > 0 ? '+' : '−'} ${formatSeconds(Math.abs(v.offset) * 60)}` : '';
    return { from, to: hm(v.end), fromText: v.start === 'sunset' ? `Sonnenuntergang${off}` : v.time };
  }

  private _timeline(from: number, to: number) {
    const pct = (m: number) => `${(Math.max(0, Math.min(1440, m)) / 1440) * 100}%`;
    const clock = (m: number) => `${String(Math.floor((((m % 1440) + 1440) % 1440) / 60)).padStart(2, '0')}:${String((((m % 60) + 60) % 60)).padStart(2, '0')}`;
    return html`<div class="tl">
      <div class="bar"><span style="left:${pct(from)};width:calc(${pct(to)} - ${pct(from)})"></span></div>
      <div class="ticks"><span>0</span><span>6</span><span>12</span><span>18</span><span>24 Uhr</span></div>
      <div class="note">heute etwa ${clock(from)} bis ${clock(to)}</div>
    </div>`;
  }

  /** one line about the room's vacation light (row in the room pop-up) */
  private _vacSummary(r: Room, p: LightPlan): string {
    const v = p.vacation;
    if (!v.on) return t('light.vac_off');
    if (this._sim?.config.smart) return t('light.vac_smart');
    const tm = this._vacTimes(v);
    return t('light.vac_fixed', { from: tm.fromText, to: v.end, pct: v.brightness });
  }

  /** "Urlaub: bewohnt wirken" of a room: the sentence, then everything to set up (fixed times or intelligent) */
  private _vacationPop(r: Room, p: LightPlan) {
    const v = p.vacation;
    const vac = (patch: Partial<LightPlan['vacation']>) => this._save(r.id, { vacation: { ...v, ...patch } });
    const { own, loose } = this._lightChoice(r);
    const tm = this._vacTimes(v);
    const lights = v.lights.length ? v.lights.map((e) => this._name(e)).join(', ') : `alle Lichter ${r.in}`;
    const close = () => (this._pop = '');
    return html`<hr-pop heading=${t('light.vac_title')} .sub=${t('light.vac_sub', { room: r.name })} @close=${close}>
      <button slot="head" class="switch" role="switch" aria-label=${t('light.vac_title')} aria-checked=${v.on ? 'true' : 'false'} @click=${() => vac({ on: !v.on })}></button>
      <div class="rl-info">${t('light.vac_lead')}</div>
      ${v.on && this._sim?.config.smart
        ? html`<p class="sentence">Intelligent: ${lights} gehen an, wenn hier sonst jemand wäre und es dunkel ist – gelernt aus eurem Alltag${this._sim.days ? ` (${this._sim.days} Tage)` : ' (lernt noch, bis dahin ein üblicher Tag)'}, mit Wegen durch die Wohnung.</p>`
        : v.on
          ? html`<p class="sentence">${lights} gehen ab <b>${tm.fromText}</b> an (${v.brightness} %, ${colorText(v.color)}) und um <b>${v.end}</b> wieder aus${v.random ? ', jeden Tag ein paar Minuten anders' : ''}.</p>`
          : nothing}
      <div class="wiz flat">
        <div class="box">
          <b>1 · Welche Lichter?</b>
          <div class="chips">
            <button aria-pressed=${!v.lights.length ? 'true' : 'false'} @click=${() => vac({ lights: [] })}>Alle ${r.in}</button>
            ${[...own, ...loose].map((l) => html`<button aria-pressed=${v.lights.includes(l.entity_id) ? 'true' : 'false'} @click=${() => vac({ lights: v.lights.includes(l.entity_id) ? v.lights.filter((x) => x !== l.entity_id) : [...v.lights, l.entity_id] })}>${l.name}</button>`)}
          </div>
        </div>
        <div class="box">
          <b>2 · Wie?</b>
          <div class="seg">
            <button aria-pressed=${this._sim?.config.smart ? 'true' : 'false'} @click=${() => this._simSet({ smart: true })}>Intelligent (lernt mit)</button>
            <button aria-pressed=${this._sim && !this._sim.config.smart ? 'true' : 'false'} @click=${() => this._simSet({ smart: false })}>Fester Zeitplan</button>
          </div>
          <p class="note">Gilt für die ganze Wohnung. Intelligent: Räume, Zeiten und Wege so wie bei euch im Alltag, Licht nur, wo es gerade dunkel ist.</p>
        </div>
        ${this._sim?.config.smart ? this._simSections(this._sim, r) : this._fixedSections(r, p)}
      </div>
      <div class="rl-box">
        <div class="line">
          <span class="grow"><b>${t('light.vac_when')}</b><small>${t('light.vac_when_sub')}</small></span>
          <button class="btn small" @click=${() => (close(), this._room = '', fire(this, 'hr-tab', 'settings#urlaub'))}>${t('light.vac_mode')}</button>
        </div>
      </div>
      ${assistantButton(this, this.store, 'vacation') === nothing ? nothing : html`<div>${assistantButton(this, this.store, 'vacation')}</div>`}
      <button slot="foot" class="btn primary" @click=${close}>${t('common.done')}</button>
    </hr-pop>`;
  }

  private _fixedSections(r: Room, p: LightPlan) {
    const v = p.vacation;
    const vac = (patch: Partial<LightPlan['vacation']>) => this._save(r.id, { vacation: { ...v, ...patch } });
    const t = this._vacTimes(v);
    return html`
        <div class="box">
          <b>3 · Wann an?</b>
          <div class="seg">
            <button aria-pressed=${v.start === 'sunset' ? 'true' : 'false'} @click=${() => vac({ start: 'sunset' })}>Bei Sonnenuntergang</button>
            <button aria-pressed=${v.start === 'time' ? 'true' : 'false'} @click=${() => vac({ start: 'time' })}>Feste Uhrzeit</button>
          </div>
          ${v.start === 'sunset'
            ? html`<div class="row wrap"><span class="grow"><div class="title">${v.offset === 0 ? 'Genau dann' : v.offset > 0 ? 'Danach' : 'Davor'}</div><div class="sub">Versatz zum Sonnenuntergang</div></span>
                <span class="stepper"><button aria-label="früher" @click=${() => vac({ offset: Math.max(-120, v.offset - 5) })}>−</button><output>${v.offset > 0 ? '+' : v.offset < 0 ? '−' : ''}${formatSeconds(Math.abs(v.offset) * 60)}</output><button aria-label="später" @click=${() => vac({ offset: Math.min(240, v.offset + 5) })}>+</button></span></div>`
            : html`<div class="row wrap"><span class="grow"><div class="title">Um</div></span><input type="time" .value=${v.time} @change=${(e: Event) => vac({ time: (e.target as HTMLInputElement).value })} /></div>`}
        </div>
        <div class="box">
          <b>4 · Wann aus?</b>
          <div class="row wrap"><span class="grow"><div class="title">Um</div></span><input type="time" .value=${v.end} @change=${(e: Event) => vac({ end: (e.target as HTMLInputElement).value })} /></div>
        </div>
        <div class="box">
          <b>5 · Wie hell?</b>
          <div class="range"><input type="range" min="1" max="100" .value=${String(v.brightness)} @change=${(e: Event) => vac({ brightness: Number((e.target as HTMLInputElement).value) })} /><output>${v.brightness} %</output></div>
          ${colorEditor(v.color, (c) => vac({ color: c }))}
          <hr-live-toggle .store=${this.store} .lights=${v.lights.length ? v.lights : this._roomLightIds(r)} .setting=${{ brightness: v.brightness, color: v.color }}></hr-live-toggle>
        </div>
        <div class="box">
          <div class="row"><span class="grow"><b>6 · Jeden Tag etwas anders</b><div class="sub">An- und Ausschalten um bis zu 15 Minuten verschoben, damit es nicht nach Zeitschaltuhr aussieht</div></span><button class="switch" role="switch" aria-label="Zufall" aria-checked=${v.random ? 'true' : 'false'} @click=${() => vac({ random: !v.random })}></button></div>
        </div>
        ${this._timeline(t.from, t.to)}`;
  }

  /** intelligent: what was learned, the ways, options and the simulated day */
  private _simSections(sim: SimView, r: Room) {
    const s = this.store;
    const name = (id: string | null) => (id ? (s.rooms.find((x) => x.id === id)?.name ?? id) : '–');
    const p = this._plan(r.id)!;
    const v = p.vacation;
    const vac = (patch: Partial<LightPlan['vacation']>) => this._save(r.id, { vacation: { ...v, ...patch } });
    const wd = sim.times.workday ?? sim.times.all;
    const we = sim.times.weekend ?? sim.times.all;
    const shown = [...new Set(sim.timeline.map((x) => x.room))];
    return html`
      <div class="box">
        <b>3 · Was gelernt wurde</b>
        ${sim.days
          ? html`<p class="note">Aus ${sim.days} Tagen (${sim.first?.split('-').reverse().slice(0, 2).join('.')}. – ${sim.last?.split('-').reverse().slice(0, 2).join('.')}.), jede Nacht kommt ein Tag dazu. Urlaubs- und Wegtage zählen nicht.</p>
              <div class="facts">
                ${wd ? html`<span><b>Werktags</b> auf ~${wd.wake ?? '–'}, ins Bett ~${wd.bed ?? '–'}</span>` : nothing}
                ${we && we !== wd ? html`<span><b>Wochenende</b> auf ~${we.wake ?? '–'}, ins Bett ~${we.bed ?? '–'}</span>` : nothing}
                <span><b>Schlafzimmer</b> ${name(sim.bedroom)}</span>
                <span><b>Nachts auf</b> ${wd?.night_p != null ? `in ${Math.round(wd.night_p * 100)} % der Nächte` : '–'}${sim.night_room ? `, meist ${name(sim.night_room)}` : ''}</span>
              </div>`
          : html`<p class="note">Noch nichts gelernt: HA hat (noch) keine Aufzeichnung der Belegung. Bis genug da ist (4 Tage), spielt es einen üblichen Tag: werktags 6:45 auf, 23 Uhr ins Bett, abends Wohnzimmer und Küche.</p>`}
        <button class="btn small" ?disabled=${sim.learning} @click=${async () => (this._sim = await s.sim('learn').catch(() => this._sim))}>${sim.learning ? 'Lernt …' : 'Jetzt neu lernen'}</button>
      </div>
      <div class="box">
        <b>4 · Wege durch die Wohnung</b>
        <p class="note">${sim.floorplan ? 'Aus den Türen im Grundriss' : 'Ohne Grundriss'}${sim.days ? ' und aus euren Raumwechseln' : ''}. Auf dem Weg geht das Licht kurz an, z. B. im Flur.${sim.entrance ? ` Haustür: ${name(sim.entrance)}.` : ''}</p>
        <div class="ways">${this._ways(sim, name)}</div>
      </div>
      ${this._darkBox(sim, name)}
      <div class="box">
        <b>6 · Einstellungen</b>
        <span class="label">Wie viele Personen</span>
        <div class="seg">${[0, 1, 2].map((n) => html`<button aria-pressed=${sim.config.people === n ? 'true' : 'false'} @click=${() => this._simSet({ people: n })}>${n ? String(n) : `Automatisch (${Math.max(1, Math.min(2, s.residents.filter((x) => x.counts).length || 1))})`}</button>`)}</div>
        <p class="note">Automatisch: so viele, wie hier wohnen (höchstens 2). Jede läuft für sich, wie im echten Leben.</p>
        <div class="row"><span class="grow"><div class="title">Morgens Licht</div><div class="sub">Beim Aufstehen, wenn es noch dunkel ist</div></span><button class="switch" role="switch" aria-label="Morgens" aria-checked=${sim.config.morning ? 'true' : 'false'} @click=${() => this._simSet({ morning: !sim.config.morning })}></button></div>
        <div class="row"><span class="grow"><div class="title">Nachts mal auf</div><div class="sub">So oft wie bei euch, kurz und gedimmt</div></span><button class="switch" role="switch" aria-label="Nachts" aria-checked=${sim.config.night ? 'true' : 'false'} @click=${() => this._simSet({ night: !sim.config.night })}></button></div>
        <span class="label">Helligkeit ${r.in}, wenn nichts gelernt ist</span>
        <div class="range"><input type="range" min="1" max="100" .value=${String(v.brightness)} @change=${(e: Event) => vac({ brightness: Number((e.target as HTMLInputElement).value) })} /><output>${v.brightness} %</output></div>
        ${colorEditor(v.color, (c) => vac({ color: c }))}
        <hr-live-toggle .store=${this.store} .lights=${v.lights.length ? v.lights : this._roomLightIds(r)} .setting=${{ brightness: v.brightness, color: v.color }}></hr-live-toggle>
      </div>
      <div class="box">
        <b>7 · So sähe es aus</b>
        <div class="seg">
          ${['Heute', 'Morgen'].map((l, i) => html`<button aria-pressed=${this._simDay === i ? 'true' : 'false'} @click=${() => { this._simDay = i; this._loadSim(i); }}>${l}</button>`)}
        </div>
        <p class="note">Jeder Tag anders. Ob das Licht wirklich angeht, entscheidet die Helligkeit im Moment. ${sim.rooms.length < shown.length ? 'Blasse Räume machen nicht mit (dort Urlaub einschalten).' : ''}</p>
        ${this._simBars(sim, shown)}
      </div>`;
  }

  /** when it is dark enough for a light: sun, light sensor, habits, never between */
  private _darkBox(sim: SimView, name: (id: string | null) => string) {
    const d = sim.config.dark;
    const set = (patch: Partial<typeof d>) => this._simSet({ dark: { ...d, ...patch } });
    const times: Record<string, string> = { morning: 'morgens', day: 'tagsüber', evening: 'abends', night: 'nachts' };
    const step = (v: number, delta: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v + delta));
    return html`<div class="box">
      <b>5 · Wann ist es dunkel genug?</b>
      <p class="note">Ein Licht geht nur an, wenn alle eingeschalteten Prüfungen zustimmen.</p>
      <div class="row">
        <span class="grow"><div class="title">Sonne</div><div class="sub">Erst wenn sie tief genug steht${sim.sun != null ? ` · jetzt ${Math.round(sim.sun)}° hoch` : ''}</div></span>
        <button class="switch" role="switch" aria-label="Sonne" aria-checked=${d.sun ? 'true' : 'false'} @click=${() => set({ sun: !d.sun })}></button>
      </div>
      ${d.sun
        ? html`<div class="row wrap">
              <span class="grow"><div class="title">Tiefer als</div><div class="sub">0° = Sonnenuntergang · 3° ≈ ½ Std. davor · −4° ≈ ½ Std. danach</div></span>
              <span class="stepper"><button aria-label="tiefer" @click=${() => set({ sun_below: step(d.sun_below, -1, -8, 20) })}>−</button><output>${d.sun_below}°</output><button aria-label="höher" @click=${() => set({ sun_below: step(d.sun_below, 1, -8, 20) })}>+</button></span>
            </div>`
        : nothing}
      <div class="row wrap">
        <span class="grow"><div class="title">Lichtsensor des Raums</div><div class="sub">${d.lux_below ? `Unter ${d.lux_below} lx in jedem Raum` : 'Automatisch: unter dem Wert, bei dem ihr dort sonst Licht anmacht (gelernt), sonst der Grenzwert des Raums'}. Räume ohne Sensor: nur Sonne und Gewohnheit.</div></span>
        <button class="switch" role="switch" aria-label="Lichtsensor" aria-checked=${d.lux ? 'true' : 'false'} @click=${() => set({ lux: !d.lux })}></button>
      </div>
      ${d.lux
        ? html`<div class="seg">
              <button aria-pressed=${!d.lux_below ? 'true' : 'false'} @click=${() => set({ lux_below: 0 })}>Automatisch</button>
              <button aria-pressed=${d.lux_below ? 'true' : 'false'} @click=${() => set({ lux_below: d.lux_below || 50 })}>Fester Wert</button>
            </div>
            ${d.lux_below
              ? html`<div class="row wrap"><span class="grow"><div class="title">Licht unter</div></span><span class="stepper"><button aria-label="weniger" @click=${() => set({ lux_below: step(d.lux_below, d.lux_below > 100 ? -25 : -5, 5, 2000) })}>−</button><output>${d.lux_below} lx</output><button aria-label="mehr" @click=${() => set({ lux_below: step(d.lux_below, d.lux_below >= 100 ? 25 : 5, 5, 2000) })}>+</button></span></div>`
              : nothing}
            ${Object.keys(sim.lux ?? {}).length
              ? html`<div class="facts">${Object.entries(sim.lux ?? {}).map(
                  ([rid, l]) => html`<span><b>${name(rid)}</b> unter ${l.limit} lx (${l.source})${l.now != null ? ` · jetzt ${Math.round(l.now)} lx` : ''}</span>`,
                )}</div>`
              : nothing}`
        : nothing}
      <div class="row wrap">
        <span class="grow"><div class="title">Wie ihr es gewohnt seid</div><div class="sub">Nur zu Tageszeiten, zu denen ihr im Raum sonst Licht macht. Räume, die ihr auch tagsüber beleuchtet (z. B. ein Bad ohne Fenster), gehen dann auch tagsüber, die Sonne zählt dort nicht.${sim.days < 4 ? ' Greift ab 4 gelernten Tagen.' : ''}</div></span>
        <button class="switch" role="switch" aria-label="Gewohnheiten" aria-checked=${d.habits ? 'true' : 'false'} @click=${() => set({ habits: !d.habits })}></button>
      </div>
      ${d.habits && Object.keys(sim.habits ?? {}).length
        ? html`<div class="facts">${Object.entries(sim.habits ?? {}).map(([rid, b]) => html`<span><b>${name(rid)}</b> ${b.map((x) => times[x] ?? x).join(', ') || '–'}</span>`)}</div>`
        : nothing}
      <div class="row wrap">
        <span class="grow"><div class="title">Nie zwischen</div><div class="sub">Egal was die Prüfungen sagen</div></span>
        ${d.never
          ? html`<input type="time" .value=${d.never_from} @change=${(e: Event) => set({ never_from: (e.target as HTMLInputElement).value })} /><span>–</span><input type="time" .value=${d.never_to} @change=${(e: Event) => set({ never_to: (e.target as HTMLInputElement).value })} />`
          : nothing}
        <button class="switch" role="switch" aria-label="Nie zwischen" aria-checked=${d.never ? 'true' : 'false'} @click=${() => set({ never: !d.never })}></button>
      </div>
      ${Object.keys(sim.now ?? {}).length
        ? html`<span class="label">Gerade</span>
            <div class="facts">${Object.entries(sim.now ?? {}).map(([rid, n]) => html`<span><b>${name(rid)}</b> ${n.dark ? 'dunkel genug' : `kein Licht: ${n.why}`}</span>`)}</div>`
        : nothing}
    </div>`;
  }

  /** the connections: the room with most neighbours first, then the other pairs */
  private _ways(sim: SimView, name: (id: string | null) => string) {
    const nb = Object.entries(sim.neighbours).sort((a, b) => b[1].length - a[1].length);
    if (!nb.length) return html`<span class="note">Noch keine.</span>`;
    const [hub, list] = nb[0];
    const seen = new Set<string>();
    const pairs: { a: string; b: string; source: string }[] = [];
    for (const [room, n] of nb.slice(1))
      for (const x of n) {
        const key = [room, x.room].sort().join('|');
        if (x.room === hub || seen.has(key)) continue;
        seen.add(key);
        pairs.push({ a: room, b: x.room, source: x.source });
      }
    return html`<div><b>${name(hub)}</b> ↔ ${list.map((x) => html`<span class="way">${name(x.room)}<small>${x.source}</small></span>`)}</div>
      ${pairs.map((x) => html`<div><b>${name(x.a)}</b> ↔ <span class="way">${name(x.b)}<small>${x.source}</small></span></div>`)}`;
  }

  /** the simulated day as bars per room (04:00 → 04:00) */
  private _simBars(sim: SimView, rooms: string[]) {
    const s = this.store;
    const pct = (m: number) => `${(Math.max(0, Math.min(1440, m)) / 1440) * 100}%`;
    const now = new Date();
    const nowM = (now.getHours() * 60 + now.getMinutes() - 240 + 1440) % 1440;
    const order = s.rooms.map((x) => x.id).filter((id) => rooms.includes(id));
    return html`<div class="sim">
      ${order.map(
        (rid) => html`<div class="simrow ${sim.rooms.includes(rid) ? '' : 'off'}">
          <span class="simname">${s.rooms.find((x) => x.id === rid)?.name ?? rid}</span>
          <span class="simbar">
            ${sim.timeline
              .filter((x) => x.room === rid)
              .map((x) => html`<i class=${x.kind} title="${x.start}–${x.end}" style="left:${pct(x.from)};width:max(2px, calc(${pct(x.to)} - ${pct(x.from)}))"></i>`)}
            ${this._simDay === 0 ? html`<b class="now" style="left:${pct(nowM)}"></b>` : nothing}
          </span>
        </div>`,
      )}
      <div class="simrow"><span></span><span class="simticks">${['4', '10', '16', '22', '4 Uhr'].map((t, i) => html`<span style="left:${i * 25}%">${t}</span>`)}</span></div>
      <div class="simlegend"><span><i class="stay"></i>da</span><span><i class="pass"></i>vorbei</span><span><i class="bed"></i>aufstehen / ins Bett / nachts</span></div>
    </div>`;
  }

  // ------------------------------------------------------------------ rules of a room
  private _setRules(r: Room, list: LightRule[]) {
    this._save(r.id, { rules: list });
  }

  /** the room's light plan: one row per rule (opens "Regel ansehen und ändern"), switch on the right */
  private _ruleList(r: Room, p: LightPlan) {
    const st = this.store.plans?.now[r.id]?.light;
    if (!p.rules.length) return html`<p class="rl-note">${t('light.no_rules', { room: r.in })}</p>`;
    return html`<div class="rl-list">
      ${p.rules.map(
        (x, i) => html`<div class="rl-item rule ${x.enabled ? '' : 'off'}">
          <button class="main" @click=${() => ((this._rule = x.id), (this._pop = 'rule'))}>
            <span class="k ${x.kind}">${icon(KIND[x.kind].icon, 20)}</span>
            <span class="grow"><b>${x.name || this._autoName(r, x)}</b><small class="clamp">${this._sentence(r, x)}${st?.active.includes(x.name) ? html` · <span class="live">${t('light.active_now')}</span>` : nothing}</small></span>
          </button>
          <button class="switch" role="switch" aria-label=${t('light.rule_toggle', { name: x.name })} aria-checked=${x.enabled ? 'true' : 'false'} @click=${() => this._setRules(r, p.rules.map((y, j) => (j === i ? { ...y, enabled: !y.enabled } : y)))}></button>
        </div>`,
      )}
    </div>`;
  }

  /** "Regel ansehen und ändern": sentence, edit, order, delete */
  private _rulePop(r: Room, p: LightPlan) {
    const i = p.rules.findIndex((y) => y.id === this._rule);
    const x = p.rules[i];
    const close = () => (this._pop = '');
    if (!x) return nothing;
    const st = this.store.plans?.now[r.id]?.light;
    const move = (d: number) => {
      const list = [...p.rules];
      const j = i + d;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      this._setRules(r, list);
    };
    return html`<hr-pop narrow heading=${x.name || this._autoName(r, x)} .sub=${html`${KIND[x.kind].label}${st?.active.includes(x.name) ? html` <span class="rl-chip yes">${t('light.active_now')}</span>` : nothing}`} @close=${close}>
      <button slot="head" class="switch" role="switch" aria-label=${t('light.rule_toggle', { name: x.name })} aria-checked=${x.enabled ? 'true' : 'false'} @click=${() => this._setRules(r, p.rules.map((y, j) => (j === i ? { ...y, enabled: !y.enabled } : y)))}></button>
      <div class="rl-box"><p class="sentence">${this._sentence(r, x)}</p></div>
      <div class="rl-box">
        <div class="line">
          <span class="grow"><b>${t('light.order')}</b><small>${t('light.order_sub', { n: i + 1, of: p.rules.length })}</small></span>
          <button class="btn small" ?disabled=${i === 0} aria-label=${t('light.up')} @click=${() => move(-1)}>${icon(mdiArrowUp, 16)}</button>
          <button class="btn small" ?disabled=${i === p.rules.length - 1} aria-label=${t('light.down')} @click=${() => move(1)}>${icon(mdiArrowDown, 16)}</button>
        </div>
      </div>
      <button slot="foot" class="btn danger" @click=${() => (this._pop = 'delete')}>${t('common.delete')}</button>
      <button slot="foot" class="btn primary" @click=${() => ((this._pop = ''), this._open(structuredClone(x), 1))}>${icon(mdiPencil, 16)}${t('light.edit')}</button>
    </hr-pop>`;
  }

  private _deletePop(r: Room, p: LightPlan) {
    const x = p.rules.find((y) => y.id === this._rule);
    const close = () => (this._pop = 'rule');
    if (!x) return nothing;
    return html`<hr-pop narrow heading=${t('light.delete_q', { name: x.name || this._autoName(r, x) })} @close=${close}>
      <p class="rl-note">${t('light.delete_text', { room: r.name })}</p>
      <button slot="foot" class="btn" @click=${close}>${t('common.cancel')}</button>
      <button slot="foot" class="btn danger" @click=${() => {
        this._setRules(r, p.rules.filter((y) => y.id !== x.id));
        this._pop = '';
        this._rule = '';
      }}>${t('common.delete')}</button>
    </hr-pop>`;
  }

  /** a new rule with this kind set (skips the kind step) */
  private _newOfKind(r: Room, k: LightRuleKind) {
    const x = this._blank(r);
    this._pop = '';
    this._open({ ...x, kind: k, trigger: k === 'when' ? x.trigger : [], when: k === 'when' ? x.when : x.when.filter((c) => c.verb !== 'is_dark' && c.subject !== 'sun') }, 1);
  }

  /** "Neue Lichtregel": with the assistant or an own fixed rule of one of the four kinds */
  private _newPop(r: Room) {
    const close = () => (this._pop = '');
    const assist = assistantButton(this, this.store, 'light') !== nothing;
    return html`<hr-pop narrow heading=${t('light.new_rule')} .sub=${r.name} @close=${close}>
      ${assist
        ? html`<div class="rl-list">
            <button class="rl-item" @click=${() => (close(), fire(this, 'hr-assistant', { feature: 'light' }))}>
              <span class="ico">${icon(mdiAutoFix, 20)}</span>
              <span class="grow"><b>${t('light.with_assistant')}</b><small>${t('light.with_assistant_sub')}</small></span>
              <span class="go">${icon(mdiChevronRight, 20)}</span>
            </button>
          </div>`
        : nothing}
      <div class="rl-sec">
        <span class="eyebrow">${t('light.own_rule')}</span>
        <div class="rl-list">
          ${(Object.keys(KIND) as LightRuleKind[]).map(
            (k) => html`<button class="rl-item rule" @click=${() => this._newOfKind(r, k)}>
              <span class="k ${k}">${icon(KIND[k].icon, 20)}</span>
              <span class="grow"><b>${KIND[k].label}</b><small>${KIND[k].hint}</small></span>
              <span class="go">${icon(mdiChevronRight, 20)}</span>
            </button>`,
          )}
        </div>
        <p class="rl-note">${t('light.own_rule_note')}</p>
      </div>
    </hr-pop>`;
  }

  // ------------------------------------------------------------------ pop-ups of the page
  /** the page's gear: arrange rooms, words in rules, vacation mode, all settings */
  private _pagePop() {
    const s = this.store;
    const close = () => (this._pop = '');
    const hid = s.hiddenRooms('light').length;
    const go = (where: string) => (close(), fire(this, 'hr-tab', where));
    const row = (title: string, sub: string, run: () => void) => html`<button class="rl-item" @click=${run}>
      <span class="grow"><b>${title}</b><small>${sub}</small></span><span class="go">${icon(mdiChevronRight, 20)}</span>
    </button>`;
    return html`<hr-pop narrow heading=${t('light.page_title')} .sub=${t('light.page_sub')} @close=${close}>
      <div class="rl-list">
        ${row(t('arrange.title'), hid ? t('light.n_hidden', { n: hid }) : t('light.arrange_sub'), () => (this._pop = 'arrange'))}
        ${row(t('cal.menu'), t('cal.menu_sub'), () => (this._pop = 'cal'))}
      </div>
      <div class="rl-sec">
        <span class="eyebrow">${t('light.global')}</span>
        <div class="rl-list">
          ${row(t('light.words'), t('light.words_sub'), () => go('settings#woerter'))}
          ${row(t('light.vac_mode'), t('light.vac_mode_sub'), () => go('settings#urlaub'))}
          ${row(t('light.all_settings'), t('light.all_settings_sub'), () => go('settings'))}
        </div>
      </div>
      ${assistantButton(this, s, 'light') === nothing ? nothing : html`<div>${assistantButton(this, s, 'light')}</div>`}
      <button slot="foot" class="btn primary" @click=${close}>${t('common.done')}</button>
    </hr-pop>`;
  }

  /** opened by the panel's gear in the head */
  openGear(): void {
    this._pop = 'page';
  }

  // ------------------------------------------------------------------ tiles and the room pop-up
  /** what the lights of the room do right now: "Licht aus", "Sofalicht an · 20 %", "2 Lichter an" */
  private _lightState(r: Room): string {
    const on = this.store.devices.filter((d) => d.kind === 'light' && d.room === r.id && d.state === 'on');
    if (!on.length) return t('light.all_off');
    if (on.length === 1) return `${on[0].name} ${on[0].detail ?? t('light.on')}`;
    return t('light.n_on', { n: on.length });
  }

  private _presence(r: Room) {
    const st = this.store.plans?.now[r.id]?.light;
    if (!st) return nothing;
    const occ = this.store.occupancy[r.id];
    return html`<span class="rl-chip ${st.occupied ? 'yes' : ''}">${st.occupied ? (occ?.empty_at ? t('light.soon_empty', { time: fmtTime(occ.empty_at * 1000) }) : t('light.someone')) : t('light.nobody')}</span>${st.lux != null ? html`<span class="rl-chip">${Math.round(st.lux)} lx</span>` : nothing}`;
  }

  private _tile(r: Room) {
    const s = this.store;
    const p = this._plan(r.id);
    if (!p) return nothing;
    const st = s.plans?.now[r.id]?.light;
    const active = p.on ? (st?.active.length ?? 0) : 0;
    const lit = s.devices.some((d) => d.kind === 'light' && d.room === r.id && d.state === 'on');
    const whiles = p.rules.filter((x) => x.kind === 'while' && st?.active.includes(x.name));
    return html`<div class="rl-tile ${lit ? 'lit' : ''} ${p.on ? '' : 'off'}">
      <button class="rl-open" aria-label=${t('light.open_room', { room: r.name })} @click=${() => this._openRoom(r.id)}></button>
      <div class="top">
        <span class="rl-ic">${icon(lit ? mdiLightbulbOn : mdiLightbulbOutline, 24)}</span>
        <span class="grow"><h2>${r.name}</h2><div class="state">${p.on ? this._lightState(r) : t('light.rules_off')}</div></span>
        <button class="switch" role="switch" aria-label=${t('light.rules_on_x', { room: r.name })} aria-checked=${p.on ? 'true' : 'false'} @click=${() => this._save(r.id, { on: !p.on })}></button>
      </div>
      <div class="rl-chips">${s.devices.some((d) => d.kind === 'light' && d.room === r.id) ? nothing : html`<button class="rl-chip warm" data-no-lamp @click=${() => (this._lightAdd = { room: r.id, rule: false })}>${t('light.no_lamp')}</button>`}${this._presence(r)}${whiles.map((x) => html`<span class="rl-chip acc">${t('light.x_applies', { name: x.name })}</span>`)}</div>
      <div class="foot">
        <span>${p.rules.length === 1 ? t('light.one_rule') : t('light.n_rules', { n: p.rules.length })} · ${!p.on ? t('light.paused') : active ? (active === 1 ? t('light.one_active') : t('light.n_active', { n: active })) : t('light.none_active')}</span>
        <span>${t('light.smart_x', { mode: smartLabel(p.smart?.mode) })}</span>
      </div>
    </div>`;
  }

  private _openRoom(id: string) {
    this._room = id;
    this._pop = '';
  }

  private _roomPop(r: Room, p: LightPlan) {
    const s = this.store;
    const sm = p.smart?.mode ?? 'off';
    const ag = s.plans?.now[r.id]?.light?.smart?.agree;
    const close = () => ((this._room = ''), (this._pop = ''));
    return html`<hr-pop heading=${r.name} .sub=${html`${this._presence(r)}${p.on ? nothing : html`<span class="rl-chip warm">${t('light.rules_off')}</span>`}`} @close=${close}>
      <button slot="head" class="switch" role="switch" aria-label=${t('light.rules_on_x', { room: r.name })} aria-checked=${p.on ? 'true' : 'false'} @click=${() => this._save(r.id, { on: !p.on })}></button>
      <button slot="head" class="icon-btn" aria-label=${t('light.basics')} title=${t('light.basics')} @click=${() => (this._pop = 'basics')}>${icon(mdiCogOutline, 22)}</button>
      <div class="rl-sec">
        <span class="eyebrow">${t('light.plan_in', { room: r.in, n: p.rules.length })}</span>
        ${this._ruleList(r, p)}
        <p class="rl-note">${t('light.how_rules_short')}</p>
      </div>
      <div class="rl-sec">
        <span class="eyebrow">${t('light.more_room')}</span>
        <div class="rl-list">
          <button class="rl-item" @click=${() => (this._pop = 'smart')}>
            <span class="ico">${icon(mdiBrain, 20)}</span>
            <span class="grow"><b>${t('light.smart')}</b><small>${sm === 'off' ? t('light.smart_off_sub') : `${smartLabel(sm)}${ag?.n ? ` · ${t('light.smart_agree', { same: ag.same, n: ag.n })}` : ''}`}</small></span>
            <span class="rl-chip ${sm === 'off' ? '' : 'acc'}">${smartLabel(sm)}</span>
            <span class="go">${icon(mdiChevronRight, 20)}</span>
          </button>
          ${s.on('vacation')
            ? html`<button class="rl-item" @click=${() => this._openVac()}>
                <span class="ico">${icon(mdiAirplane, 20)}</span>
                <span class="grow"><b>${t('light.vac_title')}</b><small>${this._vacSummary(r, p)}</small></span>
                <span class="rl-chip ${p.vacation.on ? 'acc' : ''}">${p.vacation.on ? t('light.on') : t('light.off')}</span>
                <span class="go">${icon(mdiChevronRight, 20)}</span>
              </button>`
            : nothing}
        </div>
        ${s.on('vacation') ? nothing : featureHint(this, 'vacation', 'Im Urlaub gehen dann Lichter an und aus, damit es bewohnt wirkt.')}
      </div>
      <button slot="foot" class="btn" @click=${close}>${t('common.done')}</button>
      <button slot="foot" class="btn primary" @click=${() => (this._pop = 'new')}>${icon(mdiPlus, 18)}${t('light.new_rule')}</button>
    </hr-pop>`;
  }

  private _smartPop(r: Room) {
    const close = () => (this._pop = '');
    return html`<hr-pop heading=${t('light.smart')} .sub=${t('light.smart_sub', { room: r.name })} @close=${close}>
      <hr-light-smart .store=${this.store} .room=${r} @hr-light-new-rule=${(e: Event) => {
        e.stopPropagation();
        this._pop = 'new';
      }}></hr-light-smart>
      <button slot="foot" class="btn primary" @click=${close}>${t('common.done')}</button>
    </hr-pop>`;
  }

  private _blank(r: Room): LightRule {
    return {
      id: uid(),
      name: '',
      enabled: true,
      kind: 'when',
      // on when someone comes in, and also when it gets dark while someone is there
      trigger: [{ subject: `room:${r.id}`, verb: 'is_occupied' }, r.lux ? { subject: `room:${r.id}`, verb: 'is_dark' } : { subject: 'sun', verb: 'is_down' }],
      when: [{ subject: `room:${r.id}`, verb: 'is_occupied' }, r.lux ? { subject: `room:${r.id}`, verb: 'is_dark' } : { subject: 'sun', verb: 'is_down' }],
      lights: [],
      action: { mode: 'on', brightness: 80, color: 'warm' },
      variants: [],
      after: 'others',
      empty_after: 'off',
      follow_empty: true,
    };
  }

  private _open(x: LightRule, step: number) {
    this._wiz = x;
    this._step = step;
  }

  // ------------------------------------------------------------------ assistant
  private _steps(x: LightRule): string[] {
    switch (x.kind) {
      case 'when':
        return ['kind', 'trigger', 'when', 'light', 'name'];
      case 'while':
        return ['kind', 'when', 'light', 'block', 'after', 'name'];
      case 'never_on':
        return ['kind', 'when', 'lights', 'except', 'name'];
      case 'keep_on':
        return ['kind', 'when', 'lights', 'except', 'after', 'name'];
    }
  }

  /** suggestions for conditions in this room */
  private _presets(r: Room, forTrigger: boolean): { label: string; clause: Clause }[] {
    const s = this.store;
    const tv = s.devices.find((d) => d.kind === 'media' && d.room === r.id && /tv|fernseh|monitor/i.test(d.name)) ?? s.devices.find((d) => d.kind === 'media' && d.room === r.id);
    const zones = s.devices.filter((d) => d.kind === 'zone' && d.room === r.id);
    const out: { label: string; clause: Clause }[] = [
      { label: forTrigger ? 'Jemand kommt rein' : 'Jemand im Raum', clause: { subject: `room:${r.id}`, verb: 'is_occupied' } },
      ...zones.map((z) => ({ label: z.name, clause: { subject: `zone:${z.entity_id}`, verb: 'is_occupied' } })),
      ...(tv ? [{ label: 'Fernseher an', clause: { subject: tv.entity_id, verb: 'is_on' } as Clause }] : []),
      { label: r.lux ? 'Raum ist dunkel' : 'Sonne unter', clause: r.lux ? { subject: `room:${r.id}`, verb: 'is_dark' } : { subject: 'sun', verb: 'is_down' } },
      ...(r.lux ? [{ label: 'Unter 30 lx', clause: { subject: r.lux, verb: 'is_below', value: 30 } as Clause }] : []),
      { label: 'Abends', clause: { subject: 'time', verb: 'evening' } },
      { label: 'Nachts', clause: { subject: 'time', verb: 'night' } },
      { label: 'Hausmodus Schlafen', clause: { subject: 'mode', verb: 'is', mode: 'sleep' } },
      { label: 'Werktags', clause: { subject: 'time', verb: 'workdays' } },
    ];
    if (!forTrigger && tv) out.push({ label: 'Fernseher aus', clause: { subject: tv.entity_id, verb: 'is_off' } });
    return out;
  }

  /** checkbox: wait for the room's "nobody there any more" time (and dim) before "afterwards" */
  private _followEmpty(r: Room, x: LightRule, up: (patch: Partial<LightRule>) => void) {
    const p = this._plan(r.id)!;
    const on = x.follow_empty !== false;
    const em = p.empty;
    const how = em.mode === 'dim' ? `${formatSeconds(em.delay * 60)} warten, dann auf ${em.dim} % dimmen${em.dim_for ? ` (${formatSeconds(em.dim_for * 60)})` : ''}` : em.mode === 'keep' ? `${formatSeconds(em.delay * 60)} warten, dann anlassen` : `${formatSeconds(em.delay * 60)} warten`;
    return html`<button class="check" role="checkbox" aria-checked=${on ? 'true' : 'false'} @click=${() => up({ follow_empty: !on })}>
      ${icon(on ? mdiCheckboxMarked : mdiCheckboxBlankOutline, 24)}
      <span><b>Erst wie bei „Wenn niemand mehr da ist“</b><span>${on ? `Gilt es nicht mehr: ${how}, erst dann das hier. Einstellbar in den Grundeinstellungen des Raums.` : 'Aus: Darunter stellst du eine eigene Abklingzeit für diese Regel ein.'}</span></span>
    </button>
    ${on ? nothing : this._ownEnd(x, up)}`;
  }

  /** own cool-down of a while rule (instead of the room's) */
  private _ownEnd(x: LightRule, up: (patch: Partial<LightRule>) => void) {
    const o = x.own_end ?? { delay: 0, dim: 0, dim_for: 0 };
    const set = (patch: Partial<typeof o>) => up({ own_end: { ...o, ...patch } });
    return html`<div class="box own-end">
      <span class="label">Eigene Abklingzeit</span>
      <div class="row wrap"><span class="grow"><div class="title">Erst warten</div><div class="sub">So lange bleibt alles, wie es ist. 0 Sek. = sofort</div></span>${durationStepper(o.delay, (v) => set({ delay: v }), 0, 120)}</div>
      <div class="seg">
        <button aria-pressed=${o.dim ? 'false' : 'true'} @click=${() => set({ dim: 0 })}>Nicht dimmen</button>
        <button aria-pressed=${o.dim ? 'true' : 'false'} @click=${() => set({ dim: o.dim || 10 })}>Dann dimmen</button>
      </div>
      ${o.dim
        ? html`<div class="range"><input type="range" min="1" max="100" .value=${String(o.dim)} aria-label="Dimmen auf" @change=${(e: Event) => set({ dim: Number((e.target as HTMLInputElement).value) })} /><output>${o.dim} %</output></div>
            <div class="row wrap"><span class="grow"><div class="title">Gedimmt für</div><div class="sub">Danach das, was du gleich einstellst. 0 Sek. = bleibt gedimmt</div></span>${durationStepper(o.dim_for, (v) => set({ dim_for: v }), 0, 120)}</div>`
        : nothing}
    </div>`;
  }

  /** "these may switch it on anyway": light rules of the room and house rules */
  private _allowChips(r: Room, x: LightRule, up: (patch: Partial<LightRule>) => void) {
    const allow = x.allow ?? [];
    const toggle = (k: string) => up({ allow: allow.includes(k) ? allow.filter((y) => y !== k) : [...allow, k] });
    const light = (this._plan(r.id)?.rules ?? []).filter((y) => y.id !== x.id && (y.kind === 'when' || y.kind === 'while'));
    const house = this.store.rules;
    return html`<span class="label">Diese Regeln dürfen trotzdem einschalten</span>
      <p class="note">Gesperrt ist es für alles andere: andere Lichtregeln, Hausregeln und HA-Automationen. Schaltet so etwas trotzdem ein, geht es sofort wieder aus. Von Hand darfst du immer.</p>
      ${light.length ? html`<span class="note">Lichtregeln ${r.in}</span>
          <div class="chips">${light.map((y) => html`<button aria-pressed=${allow.includes(`light:${y.id}`) ? 'true' : 'false'} @click=${() => toggle(`light:${y.id}`)}>${y.name || this._autoName(r, y)}</button>`)}</div>` : nothing}
      ${house.length ? html`<span class="note">Hausregeln</span>
          <div class="chips">${house.map((y) => html`<button aria-pressed=${allow.includes(`rule:${y.id}`) ? 'true' : 'false'} @click=${() => toggle(`rule:${y.id}`)}>${y.name}</button>`)}</div>` : nothing}`;
  }

  /** the room's "while" rules (to tie a never/keep rule to) */
  private _whileRules(r: Room, x: LightRule): LightRule[] {
    return (this._plan(r.id)?.rules ?? []).filter((y) => y.kind === 'while' && y.id !== x.id);
  }

  /** few, short suggestions for a variant (the full list stays in the other steps) */
  private _variantPresets(r: Room): { label: string; clause: Clause }[] {
    const keep = ['Abends', 'Nachts', 'Fernseher an', 'Hausmodus Schlafen'];
    return this._presets(r, false).filter((x) => keep.includes(x.label));
  }

  /** on/off/scene, brightness, any colour, effect, fade, each lamp its own (hr-light-action, lightspec.ts) */
  private _actionEditor(a: LightAction, set: (a: LightAction) => void, lights: string[]) {
    return html`<hr-light-action .store=${this.store} .value=${a} .lights=${lights} scenes @change=${(e: CustomEvent<LightAction>) => set(e.detail)}></hr-light-action>`;
  }

  private _wizard(r: Room) {
    const x = this._wiz!;
    const steps = this._steps(x);
    const step = steps[Math.min(this._step, steps.length - 1)];
    const up = (patch: Partial<LightRule>) => (this._wiz = { ...x, ...patch });
    const { own, loose } = this._lightChoice(r);
    const ruleLights = x.lights.length ? x.lights : own.map((l) => l.entity_id);
    const pick = (id: string) => up({ lights: x.lights.includes(id) ? x.lights.filter((y) => y !== id) : [...x.lights, id] });
    const shown = new Set([...own, ...loose].map((l) => l.entity_id));
    // lamps of other rooms: the chosen ones always show (with their room), all of them after "+ Lichter aus anderen Räumen"
    const otherRooms = this.store.rooms
      .filter((o) => o.id !== r.id)
      .map((o) => ({ room: o, lights: this.store.devices.filter((d) => d.kind === 'light' && d.room === o.id) }))
      .filter((o) => o.lights.length);
    const chosenOther = otherRooms.flatMap((o) => o.lights.filter((l) => x.lights.includes(l.entity_id)).map((l) => ({ l, room: o.room })));
    const lightChips = html`<div class="chips">
      <button aria-pressed=${!x.lights.length ? 'true' : 'false'} @click=${() => up({ lights: [] })}>Alle ${r.in}</button>
      ${[...own, ...loose].map((l) => html`<button aria-pressed=${x.lights.includes(l.entity_id) ? 'true' : 'false'} @click=${() => pick(l.entity_id)}>${l.name}${l.room ? '' : ' ·'}</button>`)}
      ${this._others ? nothing : chosenOther.filter(({ l }) => !shown.has(l.entity_id)).map(({ l, room }) => html`<button aria-pressed="true" @click=${() => pick(l.entity_id)}>${l.name} · ${room.name}</button>`)}
    </div>
    ${otherRooms.length
      ? this._others
        ? html`${otherRooms.map(
              (o) => html`<div class="hint" style="margin:10px 0 4px">${o.room.name}</div>
                <div class="chips">${o.lights.map((l) => html`<button aria-pressed=${x.lights.includes(l.entity_id) ? 'true' : 'false'} @click=${() => pick(l.entity_id)}>${l.name}</button>`)}</div>`,
            )}
            <button class="btn small" style="margin-top:8px" @click=${() => (this._others = false)}>${t('light.others_hide')}</button>`
        : html`<button class="btn small" style="margin-top:8px" data-other-lights @click=${() => (this._others = true)}>${icon(mdiPlus, 16)} ${t('light.others_add')}</button>`
      : nothing}
    <button class="btn small ${own.length ? '' : 'primary'}" style="margin-top:8px" data-light-add @click=${() => (this._lightAdd = { room: r.id, rule: true })}>${icon(mdiPlus, 16)} ${t('light.add_title')}</button>
    ${this._foundLights(own)}`;
    let body: TemplateResult;
    switch (step) {
      case 'kind':
        body = html`<h3>Was für eine Regel?</h3>
          <div class="kinds">
            ${(Object.keys(KIND) as LightRuleKind[]).map(
              (k) => html`<button aria-pressed=${x.kind === k ? 'true' : 'false'} @click=${() => up({ kind: k, trigger: k === 'when' ? (x.trigger.length ? x.trigger : [{ subject: `room:${r.id}`, verb: 'is_occupied' }]) : [], when: k === 'when' ? x.when : x.when.filter((c) => c.verb !== 'is_dark' && c.subject !== 'sun') })}>
                ${icon(KIND[k].icon, 24)}<span><b>${KIND[k].label}</b><span>${KIND[k].hint}</span></span>
              </button>`,
            )}
          </div>`;
        break;
      case 'trigger':
        body = html`<h3>Wann soll es passieren?</h3>
          <p class="note">Sobald eins davon eintritt (eins reicht).</p>
          <hr-conditions advanced .store=${this.store} .clauses=${x.trigger} .presets=${this._presets(r, true)} joiner="oder" heading="Wann?" @change=${(e: CustomEvent<Clause[]>) => up({ trigger: e.detail })}></hr-conditions>`;
        break;
      case 'when':
        body = html`<h3>${x.kind === 'when' ? 'Nur wenn …' : 'Solange …'}</h3>
          <p class="note">${x.kind === 'when' ? 'Freiwillig: Das muss außerdem stimmen, z. B. dunkel oder abends. Alle müssen stimmen; „oder …“ an einer Zeile für Alternativen.' : 'Alle müssen stimmen; „oder …“ an einer Zeile für Alternativen.'}</p>
          <hr-conditions advanced .store=${this.store} .clauses=${x.when} .presets=${this._presets(r, false)} heading=${x.kind === 'when' ? 'Nur wenn' : 'Solange'} @change=${(e: CustomEvent<Clause[]>) => up({ when: e.detail })}></hr-conditions>
          ${(x.kind === 'never_on' || x.kind === 'keep_on') && this._whileRules(r, x).length
            ? html`<span class="label">… oder gekoppelt an eine Lichtregel</span>
                <p class="note">Gilt nur, solange diese „Solange“-Regel(n) gelten (zusätzlich zu den Bedingungen oben, falls welche da sind).</p>
                <div class="chips">${this._whileRules(r, x).map(
                  (w) => html`<button aria-pressed=${(x.linked ?? []).includes(w.id) ? 'true' : 'false'} @click=${() => up({ linked: (x.linked ?? []).includes(w.id) ? (x.linked ?? []).filter((y) => y !== w.id) : [...(x.linked ?? []), w.id] })}>${w.name}</button>`,
                )}</div>`
            : nothing}`;
        break;
      case 'light':
        body = html`<h3>Was soll passieren?</h3>
          <span class="label">Welche Lichter</span>
          ${lightChips}
          <span class="label">Wie</span>
          ${this._actionEditor(x.action, (a) => up({ action: a }), ruleLights)}
          <span class="label">Je nach … (freiwillig)</span>
          <p class="note">Varianten, z. B. abends wärmer, nachts nur 5 %, Fernseher an: 20 %. Die erste, die passt, gilt; sonst das oben.</p>
          ${x.variants.map(
            (v, i) => html`<div class="box variant">
              <div class="vh"><b>Variante ${i + 1}</b><button class="icon-btn" aria-label="Variante entfernen" @click=${() => up({ variants: x.variants.filter((_y, j) => j !== i) })}>${icon(mdiClose, 18)}</button></div>
              <hr-conditions advanced .store=${this.store} .clauses=${v.when} .presets=${v.when.length ? [] : this._variantPresets(r)} heading="Wenn …" @change=${(e: CustomEvent<Clause[]>) => up({ variants: x.variants.map((y, j) => (j === i ? { ...y, when: e.detail } : y)) })}></hr-conditions>
              ${this._actionEditor(v, (a) => up({ variants: x.variants.map((y, j) => (j === i ? { id: y.id, when: y.when, ...a } : y)) }), ruleLights)}
            </div>`,
          )}
          <div class="chips">
            <button @click=${() => up({ variants: [...x.variants, { id: uid(), when: [{ subject: 'time', verb: 'evening' }], mode: 'on', brightness: 50, color: 'warm' }] })}>+ Abends</button>
            <button @click=${() => up({ variants: [...x.variants, { id: uid(), when: [{ subject: 'time', verb: 'night' }], mode: 'on', brightness: 5, color: 'kerze' }] })}>+ Nachts</button>
            <button @click=${() => up({ variants: [...x.variants, { id: uid(), when: [], mode: 'on', brightness: 30, color: 'warm' }] })}>+ Eigene Variante</button>
          </div>`;
        break;
      case 'block':
        body = html`<h3>Sperren (freiwillig)</h3>
          <p class="note">Solange diese Regel gilt, dürfen diese Lichter nicht angehen, weder durch andere Regeln noch durch Automationen. Sind sie schon an, bleiben sie, wie sie sind.</p>
          <div class="chips">
            ${[...own, ...loose].map((l) => html`<button aria-pressed=${(x.block_lights ?? []).includes(l.entity_id) ? 'true' : 'false'} @click=${() => up({ block_lights: (x.block_lights ?? []).includes(l.entity_id) ? (x.block_lights ?? []).filter((y) => y !== l.entity_id) : [...(x.block_lights ?? []), l.entity_id] })}>${l.name}</button>`)}
          </div>
          ${(x.block_lights ?? []).length
            ? html`<span class="label">Außer wenn …</span>
                <p class="note">Gilt eine davon, ist die Sperre aufgehoben, z. B. Hausmodus Gäste.</p>
                <hr-conditions advanced .store=${this.store} .clauses=${x.except ?? []} .presets=${this._variantPresets(r)} joiner="oder" heading="Außer wenn" @change=${(e: CustomEvent<Clause[]>) => up({ except: e.detail })}></hr-conditions>
                ${this._allowChips(r, x, up)}`
            : nothing}`;
        break;
      case 'except':
        body = html`<h3>Außer wenn … (freiwillig)</h3>
          <p class="note">Gilt eine davon, ist die Regel aufgehoben. Z. B. „Deckenleuchte nie an beim Fernsehen, außer im Hausmodus Gäste“.</p>
          <hr-conditions advanced .store=${this.store} .clauses=${x.except ?? []} .presets=${this._variantPresets(r)} joiner="oder" heading="Außer wenn" @change=${(e: CustomEvent<Clause[]>) => up({ except: e.detail })}></hr-conditions>
          ${x.kind === 'never_on' ? this._allowChips(r, x, up) : nothing}`;
        break;
      case 'lights':
        body = html`<h3>Welche Lichter?</h3>
          <p class="note">${x.kind === 'never_on' ? 'Diese gehen nicht von selbst an, solange die Bedingung gilt. Sind sie schon an, bleiben sie.' : 'Diese gehen nicht aus, solange die Bedingung gilt: weder durch andere Regeln, noch wenn der Raum kurz leer ist, noch durch andere Automationen.'}</p>
          ${lightChips}`;
        break;
      case 'after': {
        // "Aus" at the end of a rule only touches its own lamps – say so when it has picked some
        const ownOnly = x.lights.length ? (x.lights.length === 1 ? `Nur ${this._name(x.lights[0])}, die anderen Lampen bleiben, wie sie sind` : 'Nur die Lampen dieser Regel, die anderen bleiben, wie sie sind') : `Alle Lampen ${r.in}`;
        body =
          x.kind === 'while'
            ? html`<h3>Und wenn es nicht mehr gilt?</h3>
                <div class="kinds">
                  ${(
                    [
                      ['others', 'Was die anderen Regeln sagen', 'Z. B. die „Wenn“-Regel vom Reinkommen'],
                      ['restore', 'Wieder wie vorher', 'So, wie die Lichter vorher waren'],
                      ['off', 'Aus', ownOnly],
                      ['nothing', 'Bleibt, wie es ist', ''],
                    ] as const
                  ).map(([k, l, h]) => html`<button aria-pressed=${x.after === k ? 'true' : 'false'} @click=${() => up({ after: k })}><span><b>${l}</b><span>${h}</span></span></button>`)}
                </div>
                ${this._followEmpty(r, x, up)}`
            : html`<h3>Und wenn es nicht mehr gilt und niemand da ist?</h3>
                <p class="note">Z. B. der Fernseher ist aus und du bist schon im Bett.</p>
                <div class="kinds">
                  ${(
                    [
                      ['off', 'Aus', ownOnly],
                      ['dim', 'Erst dimmen', 'Wie unter „Wenn niemand mehr da ist“ eingestellt'],
                      ['keep', 'Anlassen', ''],
                    ] as const
                  ).map(([k, l, h]) => html`<button aria-pressed=${x.empty_after === k ? 'true' : 'false'} @click=${() => up({ empty_after: k })}><span><b>${l}</b><span>${h}</span></span></button>`)}
                </div>`;
        break;
      }
      default:
        body = html`<h3>Name und Überblick</h3>
          <input class="text" .value=${x.name} placeholder=${this._autoName(r, x)} @input=${(e: Event) => up({ name: (e.target as HTMLInputElement).value })} />
          <p class="sentence">${this._sentence(r, { ...x, name: x.name || this._autoName(r, x) })}</p>`;
    }
    const last = this._step >= steps.length - 1;
    const p = this._plan(r.id)!;
    const save = () => {
      const rule = { ...x, name: x.name || this._autoName(r, x) };
      const exists = p.rules.some((y) => y.id === rule.id);
      this._save(r.id, { rules: exists ? p.rules.map((y) => (y.id === rule.id ? rule : y)) : [...p.rules, rule] });
      this._wiz = null;
    };
    return html`<hr-sheet width="600" label="Lichtregel" @close=${() => (this._wiz = null)}>
      <div class="wiz">
        <div class="dots">${steps.map((_s, i) => html`<span class=${i <= this._step ? 'on' : ''}></span>`)}</div>
        ${body}
      </div>
      <div class="nav">
        <button class="btn" @click=${() => (this._step > 0 ? (this._step = this._step - 1) : (this._wiz = null))}>${this._step > 0 ? 'Zurück' : 'Abbrechen'}</button>
        ${last ? html`<button class="btn primary" @click=${save}>Speichern</button>` : html`<button class="btn primary" ?disabled=${step === 'trigger' && !x.trigger.length} @click=${() => (this._step = this._step + 1)}>Weiter</button>`}
      </div>
    </hr-sheet>`;
  }

  private _autoName(r: Room, x: LightRule): string {
    const first = (list: Clause[]) => (list[0] ? clauseText(this.store, list[0], 'and') : '');
    switch (x.kind) {
      case 'when':
        return `Wenn ${first(x.trigger)}`.slice(0, 50);
      case 'while':
        return `Solange ${first(x.when)}`.slice(0, 50);
      case 'never_on':
        return `Nie an: ${first(x.when)}`.slice(0, 50);
      case 'keep_on':
        return `Bleibt an: ${first(x.when)}`.slice(0, 50);
    }
  }

  // ------------------------------------------------------------------ page
  override render() {
    const s = this.store;
    if (!s.plans) return html`<p class="lead">${t('light.not_yet')}</p>`;
    const all = this._rooms;
    if (!all.length) return html`<p class="lead">${t('light.no_rooms')}</p>`;
    const shown = new Set(all.map((x) => x.id));
    const rooms = s.orderedRooms('light').filter((x) => shown.has(x.id));
    const r = all.find((x) => x.id === this._room);
    const p = r ? this._plan(r.id) : undefined;
    return html`
      <div class="rl-grid">${this._glowMap ? this._glowTile() : nothing}${rooms.map((x) => this._tile(x))}</div>
      ${hiddenRoomsNote(s, 'light', () => (this._pop = 'arrange'))}
      ${r && p ? this._roomPop(r, p) : nothing}
      ${r && p && this._pop === 'basics' ? this._basicsPop(r, p) : nothing}
      ${r && p && this._pop === 'smart' ? this._smartPop(r) : nothing}
      ${r && p && this._pop === 'vac' ? this._vacationPop(r, p) : nothing}
      ${r && p && (this._pop === 'rule' || this._pop === 'delete') ? this._rulePop(r, p) : nothing}
      ${r && p && this._pop === 'delete' ? this._deletePop(r, p) : nothing}
      ${r && this._pop === 'new' ? this._newPop(r) : nothing}
      ${this._pop === 'page' ? this._pagePop() : nothing}
      ${this._pop === 'arrange' ? html`<hr-room-arrange .store=${s} page="light" @close=${() => (this._pop = '')}></hr-room-arrange>` : nothing}
      ${this._pop === 'glow' ? html`<hr-light-glow .store=${s} @close=${() => (this._pop = '')}></hr-light-glow>` : nothing}
      ${this._pop === 'cal' ? html`<hr-light-cal .store=${s} @close=${() => (this._pop = '')}></hr-light-cal>` : nothing}
      ${r && this._wiz ? this._wizard(r) : nothing}
      ${this._lightAdd ? this._lightAddPop() : nothing}
    `;
  }

  /** "Licht hinzufügen": a lamp or light switch of the house for this room (for good) or only for the open rule */
  private _lightAddPop() {
    const a = this._lightAdd!;
    const room = this.store.rooms.find((x) => x.id === a.room);
    if (!room) return nothing;
    const pick = (e: CustomEvent<{ entity_id: string; assign: boolean }>) => {
      const w = this._wiz;
      // the rule takes it when it is only for the rule, or when the rule names its lamps one by one
      if (a.rule && w && (!e.detail.assign || w.lights.length) && !w.lights.includes(e.detail.entity_id)) this._wiz = { ...w, lights: [...w.lights, e.detail.entity_id] };
      this._lightAdd = null;
    };
    return html`<hr-light-add .store=${this.store} .room=${room} ?forRule=${a.rule} @pick=${pick} @close=${() => (this._lightAdd = null)}></hr-light-add>`;
  }
}
customElements.define('hr-light-plans', HrLightPlans);

/** rooms the light page shows: all of them */
function lightRooms(s: Store): Room[] {
  return s.rooms;
}

registerPage('light', {
  gear: true,
  plan: true,
  sub: (s) => {
    if (!s.plans) return '';
    const rooms = lightRooms(s);
    const plans = rooms.map((r) => s.plans!.light[r.id]).filter(Boolean);
    const rules = plans.reduce((a, p) => a + p.rules.length, 0);
    const active = rooms.reduce((a, r) => a + (s.plans!.light[r.id]?.on ? (s.plans!.now[r.id]?.light?.active.length ?? 0) : 0), 0);
    return html`<b>${rooms.length === 1 ? t('light.sub_room_one') : t('light.sub_rooms', { n: rooms.length })}</b> · ${rules === 1 ? t('light.sub_rule_one') : t('light.sub_rules', { n: rules })} · ${active === 1 ? t('light.one_active') : t('light.n_active', { n: active })}`;
  },
});
