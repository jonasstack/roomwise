/**
 * <hr-heat-plans>: the area "Heizung" (the controller in heating.py), since the redesign as tiles and pop-ups.
 * Tiles: "Standard für alle Räume" (house-wide defaults every room follows per section unless it has its own
 * setting, shown as "Wie im ganzen Haus" / "Eigene Einstellung"), "Ganzes Haus" (outside thermometer, summer, heat
 * demand, valve exercise, reminders, guardrails, cost, heating assistant) and one tile per room (order and hiding:
 * the page gear, components/room-arrange.ts). A room opens its pop-up: on/off and gear in the head, the heating mode
 * Intelligent/Zeitplan right above the comfort temperature (slider, saved as the room's comfort), then its parts as
 * a list, each a second pop-up: Zeiten (own schedule; "Sonst" outside the blocks) or Intelligent (learned plan,
 * fixed times, style, room type, evening, observing, guardrails, "So denkt deine Heizung" = heat-explain.ts),
 * Sparen (nobody there, house modes), Fenster offen, Lüften, Von Hand & Vorheizen. The room's gear: thermostats,
 * thermometer, frost protection, valves, cost estimate, found devices and the room's sensors (shared pop-up,
 * event "hr-room-settings"). Every change is saved right away.
 */
import { css, html, nothing, type TemplateResult } from 'lit';
import { mdiAutoFix, mdiChevronRight, mdiClose, mdiPlus, mdiRadiator, mdiWindowOpenVariant, mdiThermometer, mdiHomeThermometerOutline, mdiCogOutline, mdiClockOutline, mdiHomeExportOutline, mdiWeatherWindy, mdiHandBackRight, mdiTune } from '@mdi/js';
import { StoreElement } from '../base';
import type { HeatBlock, HeatBlockLevel, HeatBuilding, HeatDefaults, HeatEnergySummary, HeatFound, HeatGuard, HeatLevel, HeatPlan, HeatPlanView, HeatRoomKind, HeatRoomType, HeatRoomTypeInfo, HeatSection, HeatSmart, HeatStatus, HeatStyle, HeatingConfig, PlanDays, Room } from '../model';
import './heat-explain';
import '../setup/heat-wizard';
import '../components/pop';
import { hiddenRoomsNote } from '../components/room-arrange';
import { registerPage } from '../components/page';
import { fixButton, icon, shared } from '../design/shared';
import { kit } from '../design/kit';
import { durationStepper, formatSeconds } from '../components/duration';
import { LiveStore } from '../live';
import { t, tn, type I18nKey } from '../i18n';
import { HEAT_BUILDINGS, buildingLabel, heatStyles, levelLabel } from './heat-common';

/** the second pop-up over a room: its gear (basics) or one part of its plan */
type Sub = '' | 'basics' | 'times' | 'smart' | 'save' | 'window' | 'vent' | 'manual';
const MANUAL_LABEL = (): Record<HeatPlan['manual'], string> => ({ smart: t('heat.p_manual_smart'), next_block: t('heat.p_manual_next'), hours: t('heat.p_manual_hours'), room_empty: t('heat.p_manual_empty'), never: t('heat.p_manual_never') });

const DAYS: [PlanDays, string][] = [
  ['all', 'Täglich'],
  ['workdays', 'Werktags'],
  ['weekend', 'Wochenende'],
];
const LEVELS: [HeatBlockLevel, string][] = [
  ['comfort', 'Komfort'],
  ['eco', 'Sparen'],
  ['night', 'Nacht'],
  ['custom', 'Eigene'],
];
const TEMP_ROWS: [HeatLevel, string, string][] = [
  ['comfort', 'Komfort', 'Wenn ihr den Raum nutzt'],
  ['base', 'Sonst', 'Außerhalb der Zeiten'],
  ['eco', 'Sparen', 'Alle weg oder Raum lange leer'],
  ['night', 'Nacht', 'Hausmodus „Schlafen“'],
  ['frost', 'Frostschutz', 'Urlaub und offenes Fenster (wenn nicht aus)'],
];
const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const SMART0: HeatSmart = { mode: 'schedule', style: 'comfort', ramp: { step: null, minutes: null }, shadow_days: 7, shadow_since: null, guard: {}, valve: { on: false }, radiator_w: null, area: null };
const GUARD0: HeatGuard = { max: 24, min: 15, occupied_min: 18, max_setback: 4, never: { on: false, from: '00:00', to: '05:00' } };
const STYLE_RAMP: Record<HeatStyle, [number, number]> = { comfort: [0.5, 15], eco: [0.5, 20], sport: [0, 0] };
const n = (v: number | null | undefined, d = 1) => (v == null ? '–' : String(Math.round(v * 10 ** d) / 10 ** d).replace('.', ','));
const deg = (v: number | null | undefined) => (v == null ? '–' : `${n(v)}\u00a0°C`);

const styles = css`
  :host {
    display: flex;
    flex-direction: column;
    gap: var(--hr-space-4);
  }
  .lead {
    color: var(--hr-label-2);
    font-size: var(--hr-text-subhead);
    margin: 0;
  }
  .label {
    font-size: var(--hr-text-footnote);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--hr-label-2);
    margin: var(--hr-space-2) var(--hr-space-2) 0;
  }
  .note {
    font-size: var(--hr-text-footnote);
    color: var(--hr-label-2);
    margin: 0 var(--hr-space-2);
    line-height: 1.4;
  }
  /* the pop-up body is a flex column: its parts keep their height and the body scrolls */
  hr-pop > * {
    flex-shrink: 0;
  }
  /* inside the pop-ups the groups lie on the page colour: white boxes */
  .group {
    background: var(--hr-surface);
    border-radius: var(--hr-radius-l);
    box-shadow: var(--hr-shadow-1);
  }
  /* tiles */
  .rl-tile.heating .rl-ic {
    background: color-mix(in srgb, var(--hr-orange) var(--hr-tint), transparent);
    color: var(--hr-orange);
  }
  .rl-grid {
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  }
  @media (max-width: 640px) {
    .rl-grid {
      grid-template-columns: 1fr;
    }
  }
  .rl-tile .temps {
    display: flex;
    align-items: baseline;
    gap: var(--hr-space-3);
  }
  .rl-tile .temps b {
    font-size: var(--hr-text-title1);
    font-weight: 700;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
  }
  .rl-tile .temps span {
    font-size: var(--hr-text-footnote);
    color: var(--hr-label-2);
  }
  /* room pop-up: mode switch above the temperature, then the slider */
  .modesw {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 3px;
    padding: 3px;
    border-radius: var(--hr-radius-m);
    background: var(--hr-fill);
  }
  .modesw button {
    min-height: 44px;
    border-radius: calc(var(--hr-radius-m) - 3px);
    font-weight: 600;
    font-size: var(--hr-text-subhead);
    color: var(--hr-label-2);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }
  .modesw button[aria-pressed='true'] {
    background: var(--hr-surface-raised);
    color: var(--hr-label);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
  }
  .target {
    display: flex;
    align-items: baseline;
    gap: var(--hr-space-5);
    flex-wrap: wrap;
  }
  .target div {
    display: flex;
    flex-direction: column;
  }
  .target b {
    font-size: var(--hr-text-large);
    font-weight: 800;
    letter-spacing: -0.03em;
    font-variant-numeric: tabular-nums;
    line-height: 1.05;
  }
  .target .now b {
    font-size: var(--hr-text-title1);
    font-weight: 600;
    color: var(--hr-label-2);
  }
  .target small {
    font-size: var(--hr-text-footnote);
    color: var(--hr-label-2);
  }
  input[type='range'] {
    width: 100%;
    accent-color: var(--hr-orange);
    margin: 0;
  }
  .ticks {
    display: flex;
    justify-content: space-between;
    font-size: var(--hr-text-caption);
    color: var(--hr-label-3);
    font-variant-numeric: tabular-nums;
  }
  .rl-item .main .grow b {
    font-size: var(--hr-text-body);
  }
  .head-sw {
    display: inline-flex;
    align-items: center;
    gap: var(--hr-space-2);
    font-size: var(--hr-text-footnote);
    color: var(--hr-label-2);
  }
  .live {
    display: flex;
    flex-direction: column;
    gap: var(--hr-space-2);
  }
  .live .line {
    font-size: var(--hr-text-subhead);
    line-height: 1.45;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chips button {
    border: 0;
    border-radius: 999px;
    padding: 6px 12px;
    font: inherit;
    font-size: var(--hr-text-footnote);
    font-weight: 600;
    background: var(--hr-fill);
    color: var(--hr-label);
    cursor: pointer;
  }
  .chips button[aria-pressed='true'] {
    background: var(--hr-accent);
    color: #fff;
  }
  .slot {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: var(--hr-space-2);
    padding: var(--hr-space-3);
    border-radius: var(--hr-radius-l);
    background: var(--hr-surface);
    box-shadow: var(--hr-shadow-1);
  }
  .slot .top {
    display: flex;
    flex-wrap: wrap;
    gap: var(--hr-space-2);
    align-items: center;
  }
  .slot .full {
    grid-column: 1 / -1;
    display: flex;
    flex-wrap: wrap;
    gap: var(--hr-space-2);
    align-items: center;
  }
  input[type='time'],
  select {
    font: inherit;
    padding: 6px 8px;
    border-radius: 8px;
    border: 1px solid var(--hr-separator);
    background: var(--hr-surface);
    color: var(--hr-label);
    max-width: 100%;
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
    min-width: 4.4em;
    text-align: center;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .suggest {
    display: flex;
    align-items: center;
    gap: var(--hr-space-2);
    flex-wrap: wrap;
    padding: var(--hr-space-2) var(--hr-space-3);
    border-radius: 12px;
    background: color-mix(in srgb, var(--hr-accent) 10%, transparent);
    font-size: var(--hr-text-footnote);
  }
  .suggest span {
    flex: 1;
    min-width: 12em;
  }
  .hint {
    padding: var(--hr-space-2) var(--hr-space-3);
    border-radius: 12px;
    background: color-mix(in srgb, var(--hr-orange) 14%, transparent);
    font-size: var(--hr-text-footnote);
  }
  .therm {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 2px var(--hr-space-3);
  }
  .bar {
    grid-column: 1 / -1;
    height: 6px;
    border-radius: 3px;
    background: var(--hr-fill);
    overflow: hidden;
  }
  .bar i {
    display: block;
    height: 100%;
    background: var(--hr-orange);
  }
  .row.wrap {
    flex-wrap: wrap;
  }
  .seg.wrap {
    flex-wrap: wrap;
    border-radius: 18px;
  }
  .ownrow {
    display: flex;
    align-items: center;
    gap: var(--hr-space-2);
    min-height: 28px;
    padding: 0 var(--hr-space-1);
    font-size: var(--hr-text-footnote);
    color: var(--hr-label-2);
  }
  .ownrow.own {
    color: var(--hr-accent);
    font-weight: 600;
  }
  .tl {
    display: flex;
    height: 14px;
    border-radius: 7px;
    overflow: hidden;
    background: var(--hr-fill);
  }
  .tl i {
    display: block;
    height: 100%;
    min-width: 1px;
  }
  .tl i.airing {
    background-image: repeating-linear-gradient(135deg, transparent 0 3px, color-mix(in srgb, var(--hr-accent) 45%, transparent) 3px 6px);
  }
  .axis {
    display: flex;
    justify-content: space-between;
    font-size: var(--hr-text-caption);
    color: var(--hr-label-3);
  }
  ul.segs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: var(--hr-text-subhead);
  }
  ul.segs li.now {
    font-weight: 600;
  }
  ul.segs small {
    color: var(--hr-label-2);
    font-weight: 400;
  }
`;

function stepper(value: number, unit: string, set: (v: number) => void, step: number, min: number, max: number, label = ''): TemplateResult {
  const r = (v: number) => Math.round(v * 10) / 10;
  return html`<span class="stepper">
    <button aria-label="${label} weniger" @click=${() => set(Math.max(min, r(value - step)))}>−</button>
    <output>${n(value)} ${unit}</output>
    <button aria-label="${label} mehr" @click=${() => set(Math.min(max, r(value + step)))}>+</button>
  </span>`;
}

function sw(on: boolean, label: string, toggle: () => void): TemplateResult {
  return html`<button class="switch" role="switch" aria-label=${label} aria-checked=${on ? 'true' : 'false'} @click=${(e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    toggle();
  }}></button>`;
}

function row(title: string, sub: string | TemplateResult | undefined, control: TemplateResult | typeof nothing): TemplateResult {
  return html`<div class="row wrap"><span class="grow"><div class="title">${title}</div>${sub ? html`<div class="sub">${sub}</div>` : nothing}</span>${control}</div>`;
}

// ------------------------------------------------------------------ sections shared by a room and the house-wide defaults
type Win = Omit<HeatPlan['window'], 'contacts' | 'extra'>;

function windowRows(w: Win, frost: number, set: (w: Win) => void): TemplateResult {
  return html`${row('Heizung runter, wenn ein Fenster offen ist', 'Kurz aufmachen zählt nicht', sw(w.on, 'Fenster', () => set({ ...w, on: !w.on })))}
  ${w.on
    ? html`${row('Erst abwarten', 'So lange muss es offen sein', durationStepper(w.delay, (x) => set({ ...w, delay: x }), 0, 60))}
        <div class="row wrap"><span class="grow"><div class="title">Dann</div></span><div class="seg"><button aria-pressed=${w.action === 'off' ? 'true' : 'false'} @click=${() => set({ ...w, action: 'off' })}>Aus</button><button aria-pressed=${w.action === 'frost' ? 'true' : 'false'} @click=${() => set({ ...w, action: 'frost' })}>Frostschutz ${n(frost)}°</button></div></div>
        ${row('Nach dem Schließen warten', 'Bis sich die Luft beruhigt hat, dann wieder die Temperatur, die jetzt gilt', durationStepper(w.resume, (x) => set({ ...w, resume: x }), 0, 120))}
        ${row('Lüften am Temperatursturz erkennen', 'Für Fenster ohne Kontakt: fällt die Raumtemperatur schnell, gilt das Fenster als offen', sw(w.drop, 'Temperatursturz', () => set({ ...w, drop: !w.drop })))}
        ${w.drop ? row('Sturz um mindestens', 'in 5 Min.', stepper(w.drop_k, '°C', (x) => set({ ...w, drop_k: x }), 0.1, 0.3, 5, 'Sturz')) : nothing}`
    : nothing}`;
}

function presenceRows(pr: HeatPlan['presence'], eco: number, set: (pr: HeatPlan['presence']) => void, senses: boolean | null): TemplateResult {
  return html`${row('Alle weg: sparen', `Auf ${deg(eco)}, auch im Hausmodus „Weg“`, sw(pr.away, 'Alle weg', () => set({ ...pr, away: !pr.away })))}
  ${pr.away
    ? html`${row('Nach', 'So lange müssen alle weg sein', durationStepper(pr.away_after, (v) => set({ ...pr, away_after: v }), 0, 720))}
        ${row('Auf dem Heimweg wieder heizen', 'Sobald sich jemand dem Zuhause nähert', sw(pr.home_soon, 'Heimweg', () => set({ ...pr, home_soon: !pr.home_soon })))}`
    : nothing}
  ${senses !== false
    ? html`${row('Raum lange leer: sparen', `Auf ${deg(eco)}, bis wieder jemand reinkommt`, sw(pr.empty, 'Raum leer', () => set({ ...pr, empty: !pr.empty })))}
        ${pr.empty ? row('Nach', undefined, durationStepper(pr.empty_after, (v) => set({ ...pr, empty_after: v }), 0, 720)) : nothing}`
    : html`<div class="row"><span class="grow sub">„Raum leer“ braucht Anwesenheits- oder Bewegungsmelder im Raum (Reiter Räume).</span></div>`}`;
}

function modeRows(sleep: boolean, guests: boolean, temps: Pick<HeatPlan['temps'], 'night' | 'frost'>, set: (v: { sleep: boolean; guests: boolean }) => void): TemplateResult {
  return html`${row('Schlafen: Nacht', `${deg(temps.night)}, solange der Hausmodus „Schlafen“ ist`, sw(sleep, 'Schlafen', () => set({ sleep: !sleep, guests })))}
    ${row('Gäste: den ganzen Tag Komfort', 'Kein Sparen, wenn der Raum leer ist', sw(guests, 'Gäste', () => set({ sleep, guests: !guests })))}
    ${row('Urlaub: Frostschutz', `${deg(temps.frost)}, immer im Hausmodus „Urlaub“`, html``)}`;
}

type ManualSet = { manual: HeatPlan['manual']; manual_hours: number; manual_max: number };

function manualRows(manual: HeatPlan['manual'], hours: number, max: number, set: (v: ManualSet) => void): TemplateResult {
  const v = { manual, manual_hours: hours, manual_max: max };
  return html`<div class="seg wrap">
      ${(
        [
          ['smart', 'Intelligent (empfohlen)'],
          ['next_block', 'Bis zur nächsten Zeit'],
          ['hours', 'Für Stunden'],
          ['room_empty', 'Bis der Raum leer ist'],
          ['never', 'Gleich zurück'],
        ] as const
      ).map(([k, l]) => html`<button aria-pressed=${manual === k ? 'true' : 'false'} @click=${() => set({ ...v, manual: k })}>${l}</button>`)}
    </div>
    ${manual === 'smart'
      ? html`<p class="note">Bleibt, bis sich wirklich etwas ändert: anderer Hausmodus, alle gehen, der Raum ist lange leer oder der Plan wechselt (Komfort, Absenken, Nacht). Ein gelüftetes Fenster beendet es nicht.</p>
          <div class="group">${row('Höchstens', 'Danach gilt in jedem Fall wieder der Plan', durationStepper(max * 60, (x) => set({ ...v, manual_max: Math.min(12, Math.max(1, x / 60)) }), 60, 720))}</div>`
      : nothing}
    ${manual === 'hours' ? html`<div class="group">${row('Wie lange', undefined, durationStepper(hours * 60, (x) => set({ ...v, manual_hours: Math.max(0.05, x / 60) }), 1, 2880))}</div>` : nothing}`;
}

function preheatRows(ph: HeatPlan['preheat'], set: (ph: HeatPlan['preheat']) => void, sub: string | TemplateResult, rate: number | undefined): TemplateResult {
  const learn = ph.learn !== false;
  return html`${row('Vorheizen', sub, sw(ph.on, 'Vorheizen', () => set({ ...ph, on: !ph.on })))}
    ${ph.on ? row('Höchstens so früh', undefined, durationStepper(ph.max, (v) => set({ ...ph, max: v }), 0, 360)) : nothing}
    ${ph.on
      ? html`<div class="row wrap"><span class="grow"><div class="title">Aufheiztempo</div><div class="sub">${learn ? 'Hausregeln merkt sich, wie schnell der Raum warm wird' : 'Du gibst vor, wie schnell der Raum warm wird'}</div></span><div class="seg"><button aria-pressed=${learn ? 'true' : 'false'} @click=${() => set({ ...ph, learn: true })}>Lernen</button><button aria-pressed=${learn ? 'false' : 'true'} @click=${() => set({ ...ph, learn: false, rate: ph.rate ?? rate ?? 1.5 })}>Fest</button></div></div>
          ${learn ? nothing : row('Raum wird warm um', 'pro Stunde', stepper(ph.rate ?? 1.5, '°C', (v) => set({ ...ph, rate: v }), 0.1, 0.2, 6, 'Aufheiztempo'))}`
      : nothing}`;
}

/** "wie im ganzen Haus" or "eigene Einstellung" for one or more sections of a room */
function ownRow(own: boolean, reset: () => void): TemplateResult {
  return html`<div class="ownrow ${own ? 'own' : ''}"><span class="grow">${own ? t('heat.own') : t('heat.like_house')}</span>${own ? html`<button class="btn small plain" @click=${reset}>${t('heat.reset_house')}</button>` : nothing}</div>`;
}

export class HrHeatPlans extends StoreElement {
  static override properties = { ...StoreElement.properties, _room: { state: true }, _habits: { state: true }, _explain: { state: true }, _wizard: { state: true }, _cost: { state: true }, _pv: { state: true }, _pvDay: { state: true }, _part: { state: true }, _house: { state: true }, _arrange: { state: true } };
  declare _room: string;
  declare _habits: Record<string, { busy: boolean; blocks?: HeatBlock[]; note?: string }>;
  /** room whose "So denkt deine Heizung" is open */
  declare _explain: string;
  declare _wizard: boolean;
  declare _cost: HeatEnergySummary | null;
  /** learned plans of intelligent rooms (house_rules/heating/plan), loaded when "Zeiten" is shown */
  declare _pv: Record<string, { at: number; busy: boolean; v: HeatPlanView | null }>;
  declare _pvDay: 'today' | 'tomorrow';
  /** second pop-up over the open room */
  declare _part: Sub;
  /** open house pop-up: Standard für alle Räume / Ganzes Haus */
  declare _house: '' | 'defaults' | 'house';
  declare _arrange: boolean;
  private _autoWizard = false;

  constructor() {
    super();
    this._room = '';
    this._habits = {};
    this._explain = '';
    this._wizard = false;
    this._cost = null;
    this._pv = {};
    this._pvDay = 'today';
    this._part = '';
    this._house = '';
    this._arrange = false;
  }

  override updated(): void {
    // first time in "Heizung" (admins, thermostats there, assistant not done): the heating assistant opens once
    const h = this.store.plans?.heating;
    if (!this._autoWizard && h && this.store.admin && !h.config.smart?.setup_done && this._rooms.length) {
      this._autoWizard = true;
      let later = false;
      try {
        later = sessionStorage.getItem('hr-heat-wizard-later') === '1';
      } catch {
        /* no storage: just open */
      }
      if (!later) this._wizard = true;
    }
  }

  static override styles = [shared, kit, styles];

  // ------------------------------------------------------------------ data
  private get _rooms(): Room[] {
    const s = this.store;
    return s.rooms.filter((r) => s.devices.some((d) => d.kind === 'climate' && d.room === r.id) || s.plans?.heat[r.id]?.on);
  }
  private _plan(rid: string): HeatPlan | undefined {
    return this.store.plans?.heat[rid];
  }
  private _now(rid: string): HeatStatus | null {
    return this.store.plans?.now[rid]?.heat ?? null;
  }
  private _found(rid: string): HeatFound | undefined {
    return this.store.plans?.heating?.rooms[rid];
  }
  private _save(rid: string, patch: Partial<HeatPlan>) {
    const p = this._plan(rid);
    if (p) this.store.planSet('heat', rid, { ...p, ...patch });
  }
  private _global(patch: Partial<HeatingConfig>) {
    this.store.heatingSet(patch as Record<string, unknown>);
  }
  private _name(id: string | null | undefined): string {
    if (!id) return '';
    return this.store.device(id)?.name ?? this.store.entity(id)?.name ?? id;
  }
  /** entities of a domain with a unit / device class (from the live states), e.g. thermometers */
  private _states(pred: (id: string, a: Record<string, unknown>) => boolean): { entity_id: string; name: string }[] {
    const s = this.store;
    if (!(s instanceof LiveStore)) return s.allEntities().filter((e) => pred(e.entity_id, {}));
    return Object.entries(s.hass.states)
      .filter(([id, st]) => pred(id, st.attributes))
      .map(([id, st]) => ({ entity_id: id, name: String(st.attributes.friendly_name ?? id) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  /** turned on for the first time: take the suggestions of the room (thermostats and windows are "all of the room" anyway) */
  private _turnOn(r: Room, p: HeatPlan) {
    this._save(r.id, { on: !p.on });
  }

  // ------------------------------------------------------------------ overview
  private _houseBody() {
    const h = this.store.plans?.heating;
    if (!h) return nothing;
    const g = h.config;
    const s = this.store;
    const thermo = this._states((id, a) => (id.startsWith('sensor.') && (a.device_class === 'temperature' || a.unit_of_measurement === '°C')) || id.startsWith('weather.'));
    const demandEnts = this._states((id) => /^(switch|input_boolean|climate)\./.test(id) && !/^climate\./.test(id)).concat(this._states((id) => id.startsWith('climate.') && !s.devices.some((d) => d.entity_id === id && d.room)));
    const persons = s.persons;
    return html`
        <span class="label">Außentemperatur</span>
        <select aria-label="Außenthermometer" @change=${(e: Event) => this._global({ outside: (e.target as HTMLSelectElement).value || null })}>
          <option value="" ?selected=${h.outside.auto}>Automatisch${h.outside.auto && h.outside.entity ? `: ${h.outside.name}` : ''}</option>
          ${thermo.map((x) => html`<option value=${x.entity_id} ?selected=${!h.outside.auto && x.entity_id === g.outside}>${x.name}</option>`)}
        </select>
        <p class="note">Für den Sommerbetrieb, wie lange gelüftet werden soll und die Schimmelgefahr.</p>

        ${g.summer.on
          ? html`<span class="label">Sommer</span>
              <div class="group">
                ${row('Heizungen aus, wenn es draußen warm ist', h.summer ? 'Gerade Sommer' : undefined, sw(g.summer.on, 'Sommerbetrieb', () => this._global({ summer: { ...g.summer, on: !g.summer.on } })))}
                ${row('Wärmer als', undefined, stepper(g.summer.above, '°C', (v) => this._global({ summer: { ...g.summer, above: v } }), 0.5, 10, 30, 'Sommer ab'))}
                ${row('Mindestens', 'So lange, bevor umgeschaltet wird (und zurück 1 °C kälter)', durationStepper(g.summer.hold, (v) => this._global({ summer: { ...g.summer, hold: v } }), 0, 1440))}
              </div>`
          : nothing}

        ${g.demand.on
          ? html`<span class="label">Wärmeanforderung (Kessel / Wärmepumpe)</span>
        <div class="group">
          ${row('Kessel nur bei Bedarf an', h.demand.on ? `Gerade an: ${h.demand.why}` : `Gerade aus: ${h.demand.why}`, sw(g.demand.on, 'Wärmeanforderung', () => this._global({ demand: { ...g.demand, on: !g.demand.on } })))}
          ${g.demand.on
            ? html`<div class="row wrap"><span class="grow"><div class="title">Schaltet</div></span>
                  <select aria-label="Kessel" @change=${(e: Event) => this._global({ demand: { ...g.demand, entity: (e.target as HTMLSelectElement).value || null } })}>
                    <option value="" ?selected=${!g.demand.entity}>Nichts (nur anzeigen)</option>
                    ${demandEnts.map((x) => html`<option value=${x.entity_id} ?selected=${x.entity_id === g.demand.entity}>${x.name}</option>`)}
                  </select></div>
                ${row('An, wenn ein Ventil weiter offen ist als', 'Thermostate ohne Ventilwert zählen, wenn sie heizen', stepper(g.demand.above, '%', (v) => this._global({ demand: { ...g.demand, above: v } }), 5, 1, 100, 'Ventil'))}
                ${row('Mindestens an', undefined, durationStepper(g.demand.min_on, (v) => this._global({ demand: { ...g.demand, min_on: v } }), 0, 240))}
                ${row('Mindestens aus', undefined, durationStepper(g.demand.min_off, (v) => this._global({ demand: { ...g.demand, min_off: v } }), 0, 240))}`
            : nothing}
        </div>
        <p class="note">Auch ohne Schalter zeigt <code>binary_sensor.heizung_waermeanforderung</code>, ob gerade Wärme gebraucht wird.</p>`
          : nothing}

        ${g.exercise.on
          ? html`<span class="label">Ventilschutz</span>
        <div class="group">
          ${row('Ventile einmal pro Woche ganz öffnen', `Damit sie im Sommer nicht festsitzen${h.last_exercise ? ` · zuletzt ${new Date(h.last_exercise).toLocaleDateString('de-DE')}` : ''}${h.exercise_until && h.exercise_until * 1000 > Date.now() ? ' · läuft gerade' : ''}`, sw(g.exercise.on, 'Ventilschutz', () => this._global({ exercise: { ...g.exercise, on: !g.exercise.on } })))}
          ${g.exercise.on
            ? html`<div class="row wrap"><div class="seg">${WEEKDAYS.map((d, i) => html`<button aria-pressed=${g.exercise.weekday === i ? 'true' : 'false'} @click=${() => this._global({ exercise: { ...g.exercise, weekday: i } })}>${d}</button>`)}</div>
                  <input type="time" aria-label="Uhrzeit" .value=${g.exercise.time} @change=${(e: Event) => this._global({ exercise: { ...g.exercise, time: (e.target as HTMLInputElement).value } })} /></div>
                ${row('Wie lange offen', g.summer.on ? 'Nur im Sommerbetrieb (im Winter bewegen sie sich ohnehin)' : undefined, durationStepper(g.exercise.minutes, (v) => this._global({ exercise: { ...g.exercise, minutes: Math.max(0.05, v) } }), 0, 30))}`
            : nothing}
          <div class="row"><button class="btn small" @click=${() => this.store.heatingDo('exercise')}>Jetzt einmal durchführen</button></div>
        </div>`
          : nothing}

        ${this._houseSmart(g)}

        ${g.notify.length
          ? html`<span class="label">Erinnerungen (Lüften, Fenster zu)</span>
              <div class="chips">
                ${persons.map((p) => html`<button aria-pressed=${g.notify.includes(p.id) ? 'true' : 'false'} @click=${() => this._global({ notify: g.notify.includes(p.id) ? g.notify.filter((x) => x !== p.id) : [...g.notify, p.id] })}>${p.name}</button>`)}
              </div>
              <p class="note">Aufs Handy, nur wer gerade zuhause ist. Immer: <code>sensor.&lt;raum&gt;_lueften</code> und das Ereignis <code>house_rules_ventilate</code> (z. B. für die Grundriss-Karte).</p>
              <div class="group">
                ${row('Nachts keine Nachrichten', g.quiet.on ? `${g.quiet.from}–${g.quiet.to}` : undefined, sw(g.quiet.on, 'Ruhezeit', () => this._global({ quiet: { ...g.quiet, on: !g.quiet.on } })))}
                ${g.quiet.on
                  ? html`<div class="row wrap"><span class="grow">von</span><input type="time" aria-label="Ruhe von" .value=${g.quiet.from} @change=${(e: Event) => this._global({ quiet: { ...g.quiet, from: (e.target as HTMLInputElement).value } })} /><span>bis</span><input type="time" aria-label="Ruhe bis" .value=${g.quiet.to} @change=${(e: Event) => this._global({ quiet: { ...g.quiet, to: (e.target as HTMLInputElement).value } })} /></div>`
                  : nothing}
              </div>`
          : nothing}

        ${this._houseOff(g, persons)}
    `;
  }

  /** "Ganzes Haus": what is switched off stays out of the way – listed at the end, each with "Einschalten" */
  private _houseOff(g: HeatingConfig, persons: { id: string; name: string }[]) {
    const off: [string, string, () => void][] = [];
    if (!g.summer.on) off.push([t('heat.off_summer'), t('heat.off_summer_sub'), () => this._global({ summer: { ...g.summer, on: true } })]);
    if (!g.demand.on) off.push([t('heat.off_demand'), t('heat.off_demand_sub'), () => this._global({ demand: { ...g.demand, on: true } })]);
    if (!g.exercise.on) off.push([t('heat.off_exercise'), t('heat.off_exercise_sub'), () => this._global({ exercise: { ...g.exercise, on: true } })]);
    // switched on for everybody; whoever should not get them is taken out above
    if (!g.notify.length && persons.length) off.push([t('heat.off_notify'), t('heat.off_notify_sub'), () => this._global({ notify: persons.map((p) => p.id) })]);
    if (!off.length) return nothing;
    return html`<span class="label">${t('heat.off_title')}</span>
      <div class="group">
        ${off.map(([title, sub, on]) => row(title, sub, html`<button class="btn small" @click=${on}>${t('heat.turn_on')}</button>`))}
      </div>
      <p class="note">${t('heat.off_note')}</p>`;
  }

  private _houseSmart(g: HeatingConfig) {
    const sm = g.smart ?? { guard: GUARD0, energy: { kind: 'auto', meter: null, price: null, gas_kwh_m3: 10.3, cop: 3.2, efficiency: 0.92 }, setup_done: false };
    const gd = sm.guard;
    const setG = (patch: Partial<HeatGuard>) => this._global({ smart: { guard: { ...gd, ...patch } } } as Partial<HeatingConfig>);
    const c = this._cost;
    return html`<span class="label">Grenzen für intelligentes Heizen</span>
      <div class="group">
        ${row('Nie wärmer als', undefined, stepper(gd.max, '°C', (v) => setG({ max: v }), 0.5, 10, 30, 'Höchstens'))}
        ${row('Nie kälter als', 'Auch beim Absenken', stepper(gd.min, '°C', (v) => setG({ min: v }), 0.5, 5, 25, 'Mindestens'))}
        ${row('Jemand im Raum: mindestens', undefined, stepper(gd.occupied_min, '°C', (v) => setG({ occupied_min: v }), 0.5, 5, 28, 'Belegt mindestens'))}
        ${row('Höchstens so weit absenken', 'Unter Komfort', stepper(gd.max_setback, '°C', (v) => setG({ max_setback: v }), 0.5, 0, 10, 'Absenken'))}
        ${row('Nicht heizen in der Zeit', gd.never.on ? `${gd.never.from}–${gd.never.to}: nur die Untergrenze` : undefined, sw(gd.never.on, 'Nicht heizen', () => setG({ never: { ...gd.never, on: !gd.never.on } })))}
        ${gd.never.on
          ? html`<div class="row wrap"><span class="grow">von</span><input type="time" aria-label="Nicht heizen von" .value=${gd.never.from} @change=${(e: Event) => setG({ never: { ...gd.never, from: (e.target as HTMLInputElement).value } })} /><span>bis</span><input type="time" aria-label="Nicht heizen bis" .value=${gd.never.to} @change=${(e: Event) => setG({ never: { ...gd.never, to: (e.target as HTMLInputElement).value } })} /></div>`
          : nothing}
      </div>
      <p class="note">Grenzen gehen immer vor; je Raum lassen sie sich unter „Intelligent heizen“ anders einstellen.</p>
      <span class="label">Verbrauch und Kosten (geschätzt)</span>
      <div class="group">
        ${c
          ? html`${row('Heute', `${n(c.today.kwh)} kWh Wärme${c.today.cost != null ? ` · ${n(c.today.cost, 2)} €` : ''}`, html``)}
              ${row('Letzte 7 Tage', `${n(c.week.kwh)} kWh${c.week.cost != null ? ` · ${n(c.week.cost, 2)} €` : ''}${c.week.saved_kwh > 0 ? ` · etwa ${n(c.week.saved_kwh)} kWh gespart` : ''}`, html``)}
              ${row('Letzte 30 Tage', `${n(c.month.kwh)} kWh${c.month.cost != null ? ` · ${n(c.month.cost, 2)} €` : ''}${c.month.saved_kwh > 0 ? ` · etwa ${n(c.month.saved_kwh)} kWh gespart` : ''}`, html``)}
              <div class="row"><span class="grow sub">${c.from_meter ? `Aus dem Zähler (${c.meter.label}).` : 'Ohne Zähler aus Heizkörperleistung und Ventilstunden geschätzt.'} „Gespart“: verglichen mit immer Komfort.</span></div>`
          : html`<div class="row"><button class="btn small" @click=${() => this._loadCost()}>Schätzung anzeigen</button></div>`}
      </div>
      ${this.store.admin ? html`<div class="row"><button class="btn small tinted" @click=${() => (this._wizard = true)}>Heizungs-Assistent ${sm.setup_done ? 'erneut starten' : 'starten'}</button></div>` : nothing}`;
  }

  /** house-wide defaults: every room follows them unless it has its own setting for a section */
  private _defaults() {
    const h = this.store.plans?.heating;
    const d: HeatDefaults | undefined = h?.config.defaults;
    if (!h || !d) return nothing;
    const setD = (patch: Record<string, unknown>) => this._global({ defaults: patch } as unknown as Partial<HeatingConfig>);
    const temps = { comfort: d.comfort.comfort, ...d.temps };
    const heated = this._rooms.filter((r) => this._plan(r.id)?.on);
    const own = heated.filter((r) => (this._plan(r.id)?.own ?? []).length);
    const v = d.vent;
    const air = h.config.smart?.airing ?? { morning: null, minutes: 10, rooms: [] };
    const setAir = (patch: Partial<typeof air>) => this._global({ smart: { airing: { ...air, ...patch } } } as unknown as Partial<HeatingConfig>);
    const style = heatStyles().find((x) => x[0] === d.style.style);
    return html`
        <p class="note">${t('heat.defaults_lead')}</p>
        ${own.length ? html`<p class="note">${t('heat.defaults_own', { rooms: own.map((r) => r.name).join(', ') })}</p>` : nothing}

        <span class="label">${t('heat.building')}</span>
        <select aria-label=${t('heat.building')} @change=${(e: Event) => setD({ smart: { building: (e.target as HTMLSelectElement).value } })}>
          ${HEAT_BUILDINGS.map((b) => html`<option value=${b} ?selected=${d.building.building === b}>${buildingLabel(b)}</option>`)}
        </select>
        <p class="note">${t('heat.building_note')}</p>

        <span class="label">${t('heat.style')}</span>
        <div class="seg wrap" role="radiogroup" aria-label=${t('heat.style')}>${heatStyles().map(([k, l]) => html`<button role="radio" aria-pressed=${d.style.style === k ? 'true' : 'false'} @click=${() => setD({ smart: { style: k } })}>${l}</button>`)}</div>
        <p class="note">${style?.[2]}</p>

        <span class="label">Temperaturen</span>
        <div class="group">${TEMP_ROWS.map(([k, tt, sub]) => row(tt, sub, stepper(temps[k], '°C', (x) => setD({ temps: { [k]: x } }), 0.5, 5, k === 'frost' ? 20 : 28, tt)))}</div>

        <span class="label">Wenn niemand da ist</span>
        <div class="group">${presenceRows(d.presence, temps.eco, (x) => setD({ presence: x }), null)}</div>

        <span class="label">Hausmodus</span>
        <div class="group">${modeRows(d.modes.sleep, d.modes.guests, temps, (x) => setD(x))}</div>

        <span class="label">Am Thermostat oder in der App verstellt</span>
        ${manualRows(d.manual.manual, d.manual.manual_hours, d.manual.manual_max ?? 4, (x) => setD(x))}

        <span class="label">Fenster offen</span>
        <div class="group">${windowRows(d.window, temps.frost, (x) => setD({ window: x }))}</div>

        <span class="label">${t('heat.airing_title')}</span>
        <div class="group">
          ${row(t('heat.airing_morning'), air.morning == null ? t('heat.airing_unknown') : t('heat.airing_prior_note'), sw(!!air.morning, t('heat.airing_morning'), () => setAir({ morning: !air.morning })))}
          ${air.morning ? row(t('heat.airing_minutes'), undefined, durationStepper(air.minutes, (x) => setAir({ minutes: Math.max(1, x) }), 1, 60)) : nothing}
        </div>

        <span class="label">Lüftungsplan und Erinnerungen</span>
        <div class="group">
          ${row('Ans Lüften erinnern', 'Nach Luftfeuchte oder CO₂, Sensoren und feste Zeiten je Raum', sw(v.on, 'Lüften erinnern', () => setD({ vent: { ...v, on: !v.on } })))}
          ${v.on
            ? html`${row('Luftfeuchte über', undefined, html`${v.humidity_on ? stepper(v.humidity, '%', (x) => setD({ vent: { ...v, humidity: x } }), 5, 30, 95, 'Feuchte') : nothing}${sw(v.humidity_on, 'Feuchte', () => setD({ vent: { ...v, humidity_on: !v.humidity_on } }))}`)}
                ${row('CO₂ über', undefined, html`${v.co2_on ? stepper(v.co2, 'ppm', (x) => setD({ vent: { ...v, co2: x } }), 100, 400, 5000, 'CO2') : nothing}${sw(v.co2_on, 'CO2', () => setD({ vent: { ...v, co2_on: !v.co2_on } }))}`)}
                ${row('Erst nach', 'So lange muss der Wert darüber liegen', durationStepper(v.wait, (x) => setD({ vent: { ...v, wait: x } }), 0, 120))}
                ${row('Vor Schimmel warnen', undefined, sw(v.mould, 'Schimmel', () => setD({ vent: { ...v, mould: !v.mould } })))}
                ${row('„Fenster wieder zu“', undefined, sw(v.close, 'Fenster zu erinnern', () => setD({ vent: { ...v, close: !v.close } })))}`
            : nothing}
        </div>

        <span class="label">${t('heat.defaults_schedule')}</span>
        <div class="group">${preheatRows(d.preheat, (x) => setD({ preheat: x }), 'Rechtzeitig warm zum Beginn einer Zeit', undefined)}</div>

        <span class="label">${t('heat.defaults_smart')}</span>
        <div class="group">
          ${row('Erst beobachten', t('heat.shadow_note'), stepper(d.shadow.shadow_days, 'Tage', (x) => setD({ smart: { shadow_days: x } }), 1, 0, 60, 'Beobachten'))}
          ${row('Ventil direkt steuern', t('heat.valve_default_note'), sw(d.valve.valve.on, 'Ventil direkt', () => setD({ smart: { valve: { on: !d.valve.valve.on } } })))}
        </div>
    `;
  }

  private async _loadCost() {
    this._cost = (await this.store.heatingExplain('_house').catch(() => null))?.energy ?? null;
  }

  /** "Abends ausklingen": in the evening the room may cool down slowly instead of being heated until bedtime */
  private _evening(sm: HeatSmart, save: (patch: Partial<HeatSmart>) => void) {
    const ev = { on: false, temp: 20, from: null as string | null, ...sm.evening };
    const set = (patch: Partial<typeof ev>) => save({ evening: { ...ev, ...patch } });
    const auto = ev.from == null;
    return html`<span class="label">${t('heat.evening')}</span>
      <div class="group">
        ${row(t('heat.evening'), ev.on ? t('heat.evening_on', { deg: n(ev.temp), from: auto ? t('heat.evening_auto') : ev.from ?? '' }) : t('heat.evening_note'), sw(ev.on, t('heat.evening'), () => set({ on: !ev.on })))}
        ${ev.on
          ? html`${row(t('heat.evening_temp'), undefined, stepper(ev.temp, '°C', (v) => set({ temp: v }), 0.5, 10, 25, t('heat.evening_temp')))}
              <div class="row wrap">
                <span class="grow">${t('heat.evening_from')}</span>
                <div class="seg" role="radiogroup" aria-label=${t('heat.evening_from')}>
                  <button role="radio" aria-pressed=${auto ? 'true' : 'false'} @click=${() => !auto && set({ from: null })}>${t('heat.evening_auto_short')}</button>
                  <button role="radio" aria-pressed=${auto ? 'false' : 'true'} @click=${() => auto && set({ from: '22:00' })}>${t('heat.evening_fixed')}</button>
                </div>
                ${auto ? nothing : html`<input type="time" aria-label=${t('heat.evening_from')} .value=${ev.from ?? '22:00'} @change=${(e: Event) => set({ from: (e.target as HTMLInputElement).value || '22:00' })} />`}
              </div>`
          : nothing}
      </div>`;
  }

  /** "Kurz daheim": an hour or two in the room (e.g. home only briefly in the evening) does not need the full
   * comfort temperature */
  private _short(sm: HeatSmart, save: (patch: Partial<HeatSmart>) => void) {
    const sh = { on: false, temp: 19.5, hours: 2, ...sm.short };
    const set = (patch: Partial<typeof sh>) => save({ short: { ...sh, ...patch } });
    return html`<span class="label">${t('heat.short')}</span>
      <div class="group">
        ${row(t('heat.short'), sh.on ? t('heat.short_on', { deg: n(sh.temp), h: n(sh.hours) }) : t('heat.short_note'), sw(sh.on, t('heat.short'), () => set({ on: !sh.on })))}
        ${sh.on
          ? html`${row(t('heat.short_temp'), undefined, stepper(sh.temp, '°C', (v) => set({ temp: v }), 0.5, 10, 25, t('heat.short_temp')))}
              <div class="row wrap">
                <span class="grow">${t('heat.short_hours')}</span>
                <div class="seg" role="radiogroup" aria-label=${t('heat.short_hours')}>
                  ${[1, 1.5, 2, 3].map((h) => html`<button role="radio" aria-pressed=${sh.hours === h ? 'true' : 'false'} @click=${() => set({ hours: h })}>${t('heat.short_h', { h: n(h) })}</button>`)}
                </div>
              </div>`
          : nothing}
      </div>`;
  }

  /** "Raumart": automatic (detected from the Home Assistant area, with the reason) or set by hand */
  private _roomType(sm: HeatSmart, info: HeatRoomTypeInfo | undefined, save: (patch: Partial<HeatSmart>) => void) {
    const cur = sm.room_type ?? 'auto';
    const kindLabel = (k: HeatRoomKind) => t(`heat.rt_${k}` as I18nKey);
    const detected = info ? t('heat.rt_detected', { kind: kindLabel(info.auto), why: t(`heat.rt_why_${info.source}` as I18nKey, { detail: info.detail }) }) : '';
    return html`<span class="label">${t('heat.rt_title')}</span>
      <div class="seg wrap" role="radiogroup" aria-label=${t('heat.rt_title')}>
        ${(['auto', 'normal', 'short', 'pass'] as HeatRoomType[]).map((k) => html`<button role="radio" aria-pressed=${cur === k ? 'true' : 'false'} @click=${() => cur !== k && save({ room_type: k })}>${t(`heat.rt_${k}` as I18nKey)}</button>`)}
      </div>
      <p class="note">${t(`heat.rt_note_${info?.kind ?? (cur === 'auto' ? 'normal' : cur)}` as I18nKey)}${detected ? html`<br />${detected}` : nothing}</p>`;
  }

  /** what Hausregeln found in the room, each with "ändern / nicht verwenden" (the choice counts everywhere) */
  private _foundList(f: HeatFound | undefined) {
    if (!f || !this.store.admin) return nothing;
    const parts: [string, string[]][] = [
      ['Thermostate', f.thermostats],
      ['Thermometer', f.sensors],
      ['Fenster und Türen', [...f.contacts, ...f.doors]],
      ['Luftfeuchte und CO₂', [...f.humidity, ...f.co2]],
    ];
    const n = parts.reduce((a, [, l]) => a + l.length, 0);
    if (!n) return nothing;
    return html`<details class="found">
      <summary class="note">Erkannt im Raum: ${n} Geräte. Falsch erkannt? Ändern oder nicht verwenden.</summary>
      ${parts.map(([title, list]) =>
        list.length
          ? html`<span class="label">${title}</span>
              <div class="group">
                ${list.map((e) => html`<div class="row fixrow"><span class="pick"><span class="grow"><div class="title">${this._name(e)}</div><div class="sub">${e}</div></span></span>${fixButton(this, e)}</div>`)}
              </div>`
          : nothing,
      )}
    </details>`;
  }

  private async _suggest(rid: string) {
    this._habits = { ...this._habits, [rid]: { busy: true } };
    try {
      const res = await this.store.planHabits(rid);
      this._habits = { ...this._habits, [rid]: { busy: false, note: res.note, blocks: res.windows.map((w) => ({ from: w.from, to: w.to, days: w.days, level: w.level ?? 'comfort', temp: w.temp })) } };
    } catch (e) {
      this._habits = { ...this._habits, [rid]: { busy: false, note: (e as Error).message } };
    }
  }

  private _reset(rid: string, secs: HeatSection[]) {
    const p = this._plan(rid);
    if (p) this.store.planSet('heat', rid, { ...p, own: (p.own ?? []).filter((s) => !secs.includes(s)), reset: secs });
  }
  private _own(p: HeatPlan, secs: HeatSection[]): boolean {
    return secs.some((s) => (p.own ?? []).includes(s));
  }

  /** the learned plan of an intelligent room (loaded on demand, at most every 5 minutes) */
  private _loadPlan(rid: string, force = false) {
    const cur = this._pv[rid];
    if (cur?.busy || (!force && cur && Date.now() - cur.at < 300000)) return;
    this._pv = { ...this._pv, [rid]: { at: Date.now(), busy: true, v: cur?.v ?? null } };
    this.store
      .heatingPlan(rid)
      .then((v) => (this._pv = { ...this._pv, [rid]: { at: Date.now(), busy: false, v } }))
      .catch(() => (this._pv = { ...this._pv, [rid]: { at: Date.now(), busy: false, v: null } }));
  }

  private _learned(r: Room, p: HeatPlan) {
    queueMicrotask(() => this._loadPlan(r.id));
    const pv = this._pv[r.id]?.v;
    if (!pv) return html`<p class="note">${this._pv[r.id]?.busy ? t('heat.plan_loading') : t('heat.plan_none')}</p>`;
    const segs = this._pvDay === 'tomorrow' ? pv.tomorrow : pv.today;
    const temps = segs.map((s) => s.temp);
    const lo = Math.min(...temps);
    const hi = Math.max(...temps);
    const mins = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
    const nowM = new Date().getHours() * 60 + new Date().getMinutes();
    const shade = (v: number) => `color-mix(in srgb, var(--hr-orange) ${Math.round(18 + 82 * (hi > lo ? (v - lo) / (hi - lo) : 0.2))}%, var(--hr-surface))`;
    const learning = pv.learned_days < pv.min_days;
    const wins = this._pvDay === 'tomorrow' ? pv.windows.tomorrow : pv.windows.today;
    const air = this._pvDay === 'tomorrow' ? pv.airing.tomorrow : pv.airing.today;
    const span = (ws: { from: string; to: string }[]) => ws.map((w) => `${w.from}–${w.to}`).join(', ');
    return html`<div class="seg" role="radiogroup" aria-label=${t('heat.plan_day')}>
        <button role="radio" aria-pressed=${this._pvDay === 'today' ? 'true' : 'false'} @click=${() => (this._pvDay = 'today')}>${t('heat.today')}</button>
        <button role="radio" aria-pressed=${this._pvDay === 'tomorrow' ? 'true' : 'false'} @click=${() => (this._pvDay = 'tomorrow')}>${t('heat.tomorrow')}</button>
      </div>
      <div class="tl" role="img" aria-label=${t('heat.plan_day')}>${segs.map((s) => html`<i class=${s.level === 'airing' ? 'airing' : ''} title="${s.from}–${s.to}: ${deg(s.temp)} · ${levelLabel(s.level)} · ${s.why}" style="flex:${mins(s.to) - mins(s.from)};background-color:${shade(s.temp)}"></i>`)}</div>
      <div class="axis"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div>
      <ul class="segs">
        ${segs.map(
          (s) => html`<li class=${this._pvDay === 'today' && mins(s.from) <= nowM && nowM < mins(s.to === '24:00' ? '23:59' : s.to) ? 'now' : ''}><b>${s.from}–${s.to}</b> ${deg(s.temp)} · ${levelLabel(s.level)} <small>· ${s.why} · ${t('heat.sure', { pct: Math.round(s.confidence * 100) })}</small></li>`,
        )}
      </ul>
      <div class="group">
        ${row(t('heat.plan_learned'), learning ? t('heat.plan_learning', { n: pv.learned_days, min: pv.min_days }) : t('heat.plan_days', { n: pv.learned_days, pct: Math.round(pv.confidence * 100) }), html``)}
        ${pv.kind === 'short' ? row(t('heat.plan_short'), wins.length ? t('heat.plan_short_windows', { times: span(wins) }) : t('heat.plan_short_none'), html``) : nothing}
        ${pv.kind === 'pass' ? row(t('heat.plan_pass'), t('heat.plan_pass_text'), html``) : nothing}
        ${row(t('heat.plan_airing'), air.length ? t(air[0].source === 'prior' ? 'heat.plan_airing_prior' : 'heat.plan_airing_learned', { times: span(air) }) : t('heat.plan_airing_none'), html``)}
        ${pv.airing.pattern.kind === 'stoss' ? row(t('heat.pattern_stoss'), t('heat.pattern_stoss_text', { n: pv.airing.pattern.n, minutes: pv.airing.pattern.median_min ?? 0 }), html``) : nothing}
        ${pv.airing.pattern.kind === 'tilt' ? html`<div class="hint">${t('heat.pattern_tilt_text', { minutes: pv.airing.pattern.median_min ?? 0 })}</div>` : nothing}
        ${row(t('heat.plan_lead'), t(pv.model.learned ? 'heat.plan_lead_learned' : 'heat.plan_lead_prior', { minutes: pv.model.lead_min, lag: pv.model.lag_min, building: buildingLabel(pv.building) }), html``)}
        ${pv.model.inert ? row(t('heat.plan_inert'), t('heat.plan_inert_text'), html``) : nothing}
        ${pv.home_known ? nothing : row(t('heat.plan_home'), t('heat.plan_home_text'), html``)}
      </div>
      <div class="row"><button class="btn small plain" ?disabled=${this._pv[r.id]?.busy} @click=${() => this._loadPlan(r.id, true)}>${t('heat.plan_refresh')}</button><button class="btn small tinted" @click=${() => (this._explain = r.id)}>So denkt deine Heizung</button></div>
      <p class="note">${t('heat.plan_note')}</p>`;
  }

  private _blocks(r: Room, p: HeatPlan) {
    const blk = (i: number, patch: Partial<HeatBlock>) => this._save(r.id, { blocks: p.blocks.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
    return html`${p.blocks.map(
      (b, i) => html`<div class="slot">
        <div class="top">
          <input type="time" .value=${b.from} aria-label="Von" @change=${(e: Event) => blk(i, { from: (e.target as HTMLInputElement).value })} />
          <span>bis</span>
          <input type="time" .value=${b.to} aria-label="Bis" @change=${(e: Event) => blk(i, { to: (e.target as HTMLInputElement).value })} />
        </div>
        <button class="icon-btn" aria-label="Zeit entfernen" @click=${() => this._save(r.id, { blocks: p.blocks.filter((_y, j) => j !== i) })}>${icon(mdiClose, 18)}</button>
        <div class="full">
          <div class="seg wrap">${LEVELS.map(([l, tt]) => html`<button aria-pressed=${b.level === l ? 'true' : 'false'} @click=${() => blk(i, { level: l })}>${tt}${l !== 'custom' ? ` ${n(p.temps[l])}°` : ''}</button>`)}</div>
          ${b.level === 'custom' ? stepper(b.temp, '°C', (v) => blk(i, { temp: v }), 0.5, 5, 28, 'Temperatur') : nothing}
        </div>
        <div class="full"><div class="seg">${DAYS.map(([d, l]) => html`<button aria-pressed=${b.days === d ? 'true' : 'false'} @click=${() => blk(i, { days: d })}>${l}</button>`)}</div></div>
      </div>`,
    )}`;
  }

  // ------------------------------------------------------------------ room tile
  private _roomTile(r: Room) {
    const p = this._plan(r.id);
    const st = this._now(r.id);
    if (!p) return nothing;
    const smart = p.smart?.mode === 'smart';
    const line = p.on && st ? (st.manual ? t('heat.p_manual_now') : st.until ? t('heat.p_level_until', { level: levelLabel(st.level), until: st.until }) : levelLabel(st.level)) : p.on ? t('heat.p_starting') : p.vent.on ? t('heat.p_vent_only') : t('heat.p_off_tap');
    const warn = (st?.hints?.length ?? 0) > 0 || (st?.unreachable?.length ?? 0) > 0;
    const open = () => this._openRoom(r.id);
    return html`<div class="rl-tile ${p.on && st?.heating ? 'heating' : ''} ${p.on ? '' : 'off'}">
      <button class="rl-open" aria-label=${t('heat.p_open_room', { room: r.name })} @click=${open}></button>
      <div class="top">
        <span class="rl-ic">${icon(mdiRadiator, 26)}</span>
        <div class="grow"><h3>${r.name}</h3><div class="state">${p.on && st?.heating ? t('heat.p_heats') : p.on ? t('heat.p_regulated') : t('heat.p_not_regulated_short')}${st?.valve != null && p.on ? ` · ${t('heat.p_valve', { n: n(st.valve, 0) })}` : ''}</div></div>
        ${sw(p.on, t('heat.p_regulates', { room: r.name }), () => this._turnOn(r, p))}
      </div>
      <div class="temps">
        <b>${st?.current != null ? deg(st.current) : '–'}</b>
        <span>${p.on && st?.temp != null ? t('heat.p_target', { deg: deg(st.temp) }) : t('heat.p_comfort', { deg: deg(p.temps.comfort) })}</span>
      </div>
      <div class="foot">
        <span>${line}</span>
        <span class="rl-chips">
          <span class="rl-chip ${smart ? 'acc' : ''}">${smart ? t('heat.p_mode_smart') : t('heat.p_mode_schedule')}</span>
          ${warn ? html`<span class="rl-chip warm">${t('heat.p_check')}</span>` : nothing}
          ${st?.vent?.state === 'ventilate' ? html`<span class="rl-chip acc">${t('heat.p_airing')}</span>` : nothing}
        </span>
      </div>
    </div>`;
  }

  private _openRoom(rid: string) {
    this._room = rid;
    this._part = '';
  }

  // ------------------------------------------------------------------ room pop-up
  private _live(r: Room, p: HeatPlan, st: HeatStatus | null) {
    if (!p.on && st?.vent?.state !== 'ventilate') return html`<div class="rl-info">${icon(mdiRadiator, 18)}<span>${t('heat.p_off_note', { room: r.in })}</span></div>`;
    if (!st || (!st.manual && !(st.hints ?? []).length)) return nothing;
    return html`<div class="live">
      ${st.manual ? html`<div class="rl-now"><span class="grow"><b>${t('heat.p_manual_now')}</b><small>${st.line.replace(`${r.name}: `, '')}</small></span><button class="btn small tinted" @click=${() => this.store.heatingDo('clear_manual', r.id)}>${t('heat.p_back_to_plan')}</button></div>` : nothing}
      ${(st.hints ?? []).map((h) => html`<div class="hint">${h}</div>`)}
    </div>`;
  }

  private _roomPop(r: Room) {
    const p = this._plan(r.id);
    if (!p) return nothing;
    const st = this._now(r.id);
    const sm = { ...SMART0, ...(p.smart ?? {}) };
    const smart = sm.mode === 'smart';
    const ss = st?.smart;
    const phase = ss?.phase ?? (smart ? (sm.shadow_since ? 'shadow' : 'active') : 'schedule');
    const setMode = (mode: 'smart' | 'schedule') => mode !== sm.mode && this._save(r.id, { smart: { ...sm, mode } });
    const comfort = p.temps.comfort;
    const setComfort = (v: number) => this._save(r.id, { temps: { ...p.temps, comfort: v } });
    const pr = p.presence;
    const w = p.window;
    const v = p.vent;
    const item = (key: Sub, ic: string, title: string, sub: string, on?: boolean) =>
      html`<div class="rl-item ${on === false ? 'off' : ''}"><button class="main" @click=${() => (this._part = key)}><span class="ico">${icon(ic, 20)}</span><span class="grow"><b>${title}</b><small>${sub}</small></span><span class="go">${icon(mdiChevronRight, 20)}</span></button></div>`;
    const status = p.on && st ? st.line.replace(`${r.name}: `, '') : t('heat.p_not_regulated');
    return html`<hr-pop heading=${r.name} .sub=${status} @close=${() => (this._room = '')}>
      <span slot="head" class="head-sw">${sw(p.on, t('heat.p_regulates', { room: r.name }), () => this._turnOn(r, p))}</span>
      <button slot="head" class="icon-btn" aria-label=${t('heat.p_basics')} title=${t('heat.p_basics')} @click=${() => (this._part = 'basics')}>${icon(mdiCogOutline, 22)}</button>
      ${this._live(r, p, st)}
      <div class="rl-sec">
        <span class="eyebrow">${t('heat.p_heat_mode')}</span>
        <div class="modesw" role="radiogroup" aria-label=${t('heat.p_heat_mode')}>
          <button role="radio" aria-pressed=${smart ? 'true' : 'false'} @click=${() => setMode('smart')}>${icon(mdiAutoFix, 18)}${t('heat.p_mode_smart')}</button>
          <button role="radio" aria-pressed=${smart ? 'false' : 'true'} @click=${() => setMode('schedule')}>${icon(mdiClockOutline, 18)}${t('heat.p_mode_schedule')}</button>
        </div>
        <p class="note">${smart ? t('heat.p_smart_lead', { n: p.blocks.length }) : t('heat.p_schedule_lead')}</p>
      </div>
      ${smart && phase === 'shadow'
        ? html`<div class="suggest">${icon(mdiAutoFix, 18)}<span>${ss?.shadow?.ready ? t('heat.p_shadow_done') : t('heat.p_shadow_left', { n: n(ss?.shadow?.left ?? sm.shadow_days) })} ${ss?.would?.temp != null ? t('heat.p_would', { deg: deg(ss.would.temp), why: ss.would.why }) : ''}</span><button class="btn small tinted" @click=${() => this.store.heatingDo('takeover', r.id)}>${t('heat.p_takeover')}</button></div>`
        : nothing}
      <div class="rl-box">
        <div class="target">
          <div><b>${deg(comfort)}</b><small>${t('heat.p_comfort_label')}</small></div>
          <div class="now"><b>${st?.current != null ? deg(st.current) : '–'}</b><small>${t('heat.p_now_in', { room: r.in })}</small></div>
        </div>
        <input type="range" min="12" max="28" step="0.5" .value=${String(comfort)} aria-label=${t('heat.p_comfort_label')} @change=${(e: Event) => setComfort(Number((e.target as HTMLInputElement).value))} />
        <div class="ticks"><span>12 °</span><span>16 °</span><span>20 °</span><span>24 °</span><span>28 °</span></div>
        <small>${smart ? t('heat.p_comfort_smart') : t('heat.p_comfort_schedule', { base: deg(p.temps.base) })}</small>
        <small>${t('heat.p_comfort_except', {
          list: [
            t('heat.p_ex_away', { deg: deg(p.temps.eco) }),
            t('heat.p_ex_night', { deg: deg(p.temps.night) }),
            ...(smart && sm.short?.on ? [t('heat.p_ex_short', { h: n(sm.short.hours), deg: deg(sm.short.temp) })] : []),
            ...(smart && sm.evening?.on ? [t('heat.p_ex_evening', { deg: deg(sm.evening.temp) })] : []),
          ].join(' · '),
        })}</small>
      </div>
      <div class="rl-sec">
        <span class="eyebrow">${t('heat.p_plan_in', { room: r.in })}</span>
        <div class="rl-list">
          ${smart
            ? item('smart', mdiAutoFix, t('heat.p_smart_title'), phase === 'shadow' ? t('heat.p_shadow_left', { n: n(ss?.shadow?.left ?? sm.shadow_days) }) : `${heatStyles().find((x) => x[0] === sm.style)?.[1] ?? ''} · ${p.blocks.length ? t('heat.times_fixed_n', { n: p.blocks.length }) : t('heat.times_fixed_none')}`)
            : item('times', mdiClockOutline, t('heat.p_times'), `${t('heat.p_blocks_n', { n: p.blocks.length })} · ${t('heat.p_else', { deg: deg(p.temps.base) })}`)}
          ${item('save', mdiHomeExportOutline, t('heat.p_save'), pr.away || pr.empty ? `${[pr.away ? t('heat.p_save_away') : '', pr.empty ? t('heat.p_save_empty') : ''].filter(Boolean).join(' · ')} → ${deg(p.temps.eco)}` : t('heat.p_off_word'), pr.away || pr.empty)}
          ${item('window', mdiWindowOpenVariant, t('heat.p_window'), w.on ? t('heat.p_window_sub', { after: formatSeconds(w.delay * 60), action: w.action === 'off' ? t('heat.p_off_word') : t('heat.p_frost') }) : t('heat.p_off_word'), w.on)}
          ${item('vent', mdiWeatherWindy, t('heat.airing_title'), v.on ? (st?.vent?.reason ? t('heat.p_vent_on_now', { why: st.vent.reason }) : t('heat.p_vent_on')) : t('heat.p_off_word'), v.on)}
          ${item('manual', mdiHandBackRight, t('heat.p_manual'), `${MANUAL_LABEL()[p.manual]}${!smart ? ` · ${p.preheat.on ? t('heat.p_preheat_on', { max: formatSeconds(p.preheat.max * 60) }) : t('heat.p_preheat_off')}` : ''}`)}
        </div>
        <p class="note">${t('heat.p_defaults_hint')} <button class="btn small plain" @click=${() => ((this._room = ''), (this._house = 'defaults'))}>${t('heat.defaults_title')}</button></p>
      </div>
      <button slot="foot" class="btn primary" @click=${() => (this._room = '')}>${t('common.done')}</button>
    </hr-pop>`;
  }

  /** the second pop-up over the room: one part of its plan */
  private _subPop(r: Room) {
    const p = this._plan(r.id);
    if (!p || !this._part) return nothing;
    const f = this._found(r.id);
    const close = () => (this._part = '');
    const [title, body] = (
      {
        basics: () => [t('heat.p_basics'), this._basics(r, p, f)],
        times: () => [t('heat.p_times'), this._times(r, p)],
        smart: () => [t('heat.p_smart_title'), this._smartPop(r, p)],
        save: () => [t('heat.p_save'), this._savePop(r, p)],
        window: () => [t('heat.p_window'), this._windowPop(r, p, f)],
        vent: () => [t('heat.airing_title'), this._ventPop(r, p, f)],
        manual: () => [t('heat.p_manual'), this._manualPop(r, p)],
      } as Record<Exclude<Sub, ''>, () => [string, TemplateResult]>
    )[this._part]();
    return html`<hr-pop heading=${title} .sub=${r.name} @close=${close}>
      ${body}
      <button slot="foot" class="btn primary" @click=${close}>${t('common.done')}</button>
    </hr-pop>`;
  }

  /** gear of the room: devices, temperatures, valves, cost estimate, what was found */
  private _basics(r: Room, p: HeatPlan, f: HeatFound | undefined) {
    const s = this.store;
    const roomTherms = s.devices.filter((d) => d.kind === 'climate' && d.room === r.id).map((d) => d.entity_id);
    const therms = p.thermostats.length ? p.thermostats : roomTherms;
    const toggleTherm = (e: string) => {
      const cur = therms.includes(e) ? therms.filter((x) => x !== e) : [...therms, e];
      this._save(r.id, { thermostats: cur.length === roomTherms.length && cur.every((x) => roomTherms.includes(x)) ? [] : cur });
    };
    const sensors = this._states((id, a) => id.startsWith('sensor.') && (a.device_class === 'temperature' || a.unit_of_measurement === '°C'));
    const sugSensor = f?.sensors.find((e) => e !== p.sensor);
    const calib = Object.keys(f?.calibration ?? {}).length > 0;
    const sm = { ...SMART0, ...(p.smart ?? {}) };
    const save = (patch: Partial<HeatSmart>) => this._save(r.id, { smart: { ...sm, ...patch } });
    const tp = p.temps;
    return html`<span class="label">Thermostate</span>
      <div class="chips">${[...new Set([...roomTherms, ...p.thermostats])].map((e) => html`<button aria-pressed=${therms.includes(e) ? 'true' : 'false'} @click=${() => toggleTherm(e)}>${this._name(e)}</button>`)}</div>
      ${roomTherms.length ? nothing : html`<p class="note">Diesem Raum ist noch kein Thermostat zugeordnet (Reiter Geräte).</p>`}

      <span class="label">Raumthermometer</span>
      <select aria-label="Raumthermometer" @change=${(e: Event) => this._save(r.id, { sensor: (e.target as HTMLSelectElement).value || null })}>
        <option value="" ?selected=${!p.sensor}>Keins: das Thermostat misst selbst</option>
        ${sensors.map((x) => html`<option value=${x.entity_id} ?selected=${x.entity_id === p.sensor}>${x.name}</option>`)}
      </select>
      ${!p.sensor && sugSensor
        ? html`<div class="suggest">${icon(mdiThermometer, 18)}<span>Vorschlag: <b>${this._name(sugSensor)}</b> steht im Raum und misst genauer als das Thermostat am Heizkörper.</span><button class="btn small tinted" @click=${() => this._save(r.id, { sensor: sugSensor })}>Übernehmen</button></div>`
        : nothing}
      ${p.sensor
        ? html`<div class="seg wrap">
              ${(
                [
                  ['auto', 'Automatisch'],
                  ['offset', 'Thermostat abgleichen'],
                  ['target', 'Ziel korrigieren'],
                  ['off', 'Nur anzeigen'],
                ] as const
              ).map(([k, l]) => html`<button aria-pressed=${p.calibrate === k ? 'true' : 'false'} @click=${() => this._save(r.id, { calibrate: k })}>${l}</button>`)}
            </div>
            <p class="note">${calib ? 'Das Thermostat hat einen Abgleich (Kalibrierung): Hausregeln stellt ihn höchstens alle 30 Min. nach.' : 'Das Thermostat hat keinen Abgleich: Hausregeln stellt das Ziel um den Unterschied höher oder tiefer (höchstens 3 °C).'}</p>`
        : nothing}

      <span class="label">${t('heat.p_temps')}</span>
      ${ownRow(this._own(p, ['comfort', 'temps']), () => this._reset(r.id, ['comfort', 'temps']))}
      <div class="group">
        ${row(t('heat.p_frost'), 'Urlaub und offenes Fenster (wenn nicht aus)', stepper(tp.frost, '°C', (v) => this._save(r.id, { temps: { ...tp, frost: v } }), 0.5, 5, 20, t('heat.p_frost')))}
        <div class="row"><span class="grow sub">${t('heat.p_temps_where', { comfort: deg(tp.comfort), base: deg(tp.base), eco: deg(tp.eco), night: deg(tp.night) })}</span></div>
      </div>

      <span class="label">${t('heat.p_sensors')}</span>
      <div class="group">
        <button class="row" @click=${() => this.dispatchEvent(new CustomEvent('hr-room-settings', { detail: { id: r.id }, bubbles: true, composed: true }))}>
          <span class="grow"><div class="title">${t('heat.p_sensors_link')}</div><div class="sub">${t('heat.p_sensors_sub')}</div></span>${icon(mdiChevronRight, 20)}
        </button>
      </div>

      ${this._valves(r, p, f, sm, save)}

      <span class="label">Für die Kostenschätzung</span>
      <div class="group">
        ${row('Heizkörper zusammen', sm.radiator_w ? undefined : 'Geschätzt aus der Raumgröße (sonst 1 kW je Thermostat)', stepper(sm.radiator_w ?? 1000, 'W', (v) => save({ radiator_w: v }), 100, 100, 20000, 'Heizkörper'))}
        ${row('Raumgröße', sm.area ? undefined : 'Aus dem Grundriss, wenn es einen gibt', stepper(sm.area ?? 15, 'm²', (v) => save({ area: v }), 1, 1, 500, 'Fläche'))}
      </div>
      ${this._foundList(f)}`;
  }

  private _valves(r: Room, p: HeatPlan, f: HeatFound | undefined, sm: HeatSmart, save: (patch: Partial<HeatSmart>) => void) {
    const st = this._now(r.id);
    const ss = st?.smart;
    const therms = st?.thermostats ?? [];
    const h = this.store.plans?.heating;
    const smart = sm.mode === 'smart';
    return html`<span class="label">Ventile & Wärmeanforderung</span>
      <div class="group">
        ${therms.length
          ? therms.map(
              (t) => html`<div class="row"><span class="grow therm">
                  <span class="title">${t.name}${t.available ? '' : ' · nicht erreichbar'}</span>
                  <span class="sub">${t.mode === 'off' ? 'aus' : `Ziel ${deg(t.target)}`} · misst ${deg(t.current)}${t.correction ? ` · Ziel ${t.correction > 0 ? '+' : ''}${n(t.correction)} °C korrigiert` : ''}${t.calibration ? ` · Abgleich ${n(t.calibration.value)} °C` : ''}</span>
                  ${t.valve != null ? html`<span class="bar" aria-label="Ventil ${n(t.valve, 0)} %"><i style="width:${Math.max(0, Math.min(100, t.valve))}%"></i></span><span class="sub">Ventil ${n(t.valve, 0)} %${t.action === 'heating' ? ' · heizt' : ''}</span>` : html`<span class="sub">${t.action === 'heating' ? 'heizt gerade' : t.action === 'idle' ? 'heizt gerade nicht' : 'meldet keinen Ventilwert'}</span>`}
                </span></div>`,
            )
          : html`<div class="row"><span class="grow sub">Erscheint, sobald die Heizung ${r.in} eingeschaltet ist.</span></div>`}
        ${row('Klemmende Ventile melden', 'Öffnet nicht, obwohl es zu kalt ist, oder steht lange offen, ohne dass es wärmer wird', sw(p.valves.stuck, 'Ventile prüfen', () => this._save(r.id, { valves: { stuck: !p.valves.stuck } })))}
        ${ss?.valve?.available
          ? html`${row('Ventil direkt steuern', sm.valve.on ? ss.valve.why || 'wartet' : 'Das Thermostat hat ein steuerbares Ventil. Hausregeln regelt dann selbst, wie weit es öffnet – sparsam gefunkt, bei Problemen zurück zur normalen Regelung.', sw(sm.valve.on, 'Ventil direkt', () => save({ valve: { on: !sm.valve.on } })))}
            <div class="row"><span class="grow sub">${this._own(p, ['valve']) ? t('heat.own') : t('heat.like_house')}${sm.valve.on && !smart ? ' · Wirkt nur, wenn der Raum intelligent heizt (nach der Beobachtung).' : ''}</span>${this._own(p, ['valve']) ? html`<button class="btn small plain" @click=${() => this._reset(r.id, ['valve'])}>${t('heat.reset_house')}</button>` : nothing}</div>`
          : nothing}
      </div>
      <p class="note">Ventilwerte liest Hausregeln von selbst aus den üblichen Integrationen (Attribute wie <code>valve_position</code> oder <code>pi_heating_demand</code>, Sensoren mit % am selben Gerät). ${h?.config.demand.on ? `Wärmeanforderung ${h.demand.on ? 'gerade an' : 'gerade aus'}; ` : ''}Kessel und Ventilschutz gelten für das ganze Haus (Kachel „Ganzes Haus“).</p>`;
  }

  /** "Zeiten" of a room with its own schedule */
  private _times(r: Room, p: HeatPlan) {
    const hab = this._habits[r.id];
    const addBlock = () => this._save(r.id, { blocks: [...p.blocks, { from: '17:00', to: '22:00', days: 'all', level: 'comfort', temp: p.temps.comfort }] });
    return html`<span class="label">Wann wie warm</span>
      ${this._blocks(r, p)}
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn small tinted" @click=${addBlock}>${icon(mdiPlus, 16)}Zeit</button>
        <button class="btn small" ?disabled=${hab?.busy} @click=${() => this._suggest(r.id)}>${icon(mdiAutoFix, 16)}${hab?.busy ? 'Schaue in den Verlauf …' : 'Aus Gewohnheiten vorschlagen'}</button>
      </div>
      ${hab && !hab.busy
        ? html`<div class="group">
            <div class="row"><span class="grow sub">${hab.note}</span></div>
            ${(hab.blocks ?? []).map((w) => html`<div class="row"><span class="grow"><div class="title">${w.from}–${w.to}</div><div class="sub">${DAYS.find((d) => d[0] === w.days)?.[1]} · Komfort</div></span></div>`)}
            ${hab.blocks?.length
              ? html`<div class="row"><button class="btn small tinted" @click=${() => {
                  this._save(r.id, { blocks: hab.blocks! });
                  this._habits = { ...this._habits, [r.id]: { busy: false, note: 'Übernommen.' } };
                }}>Diese Zeiten übernehmen</button></div>`
              : nothing}
          </div>`
        : nothing}
      <span class="label">${t('heat.p_else_title')}</span>
      <div class="group">${row(t('heat.p_else_row'), t('heat.p_else_sub'), stepper(p.temps.base, '°C', (v) => this._save(r.id, { temps: { ...p.temps, base: v } }), 0.5, 5, 28, t('heat.p_else_row')))}</div>
      <p class="note">Werktags richtet sich nach dem Arbeitstag-Sensor, wenn es einen gibt.</p>`;
  }

  /** "Intelligent": style, room type, evening, observing, learned plan, fixed times, guardrails */
  private _smartPop(r: Room, p: HeatPlan) {
    const st = this._now(r.id);
    const sm = { ...SMART0, ...(p.smart ?? {}) };
    const ss = st?.smart;
    const save = (patch: Partial<HeatSmart>) => this._save(r.id, { smart: { ...sm, ...patch } });
    const [defStep, defMin] = STYLE_RAMP[sm.style];
    const step = sm.ramp.step ?? defStep;
    const minutes = sm.ramp.minutes ?? defMin;
    const g = { ...(this.store.plans?.heating?.config.smart?.guard ?? GUARD0) };
    const own = Object.keys(sm.guard ?? {}).length > 0;
    const og = { ...g, ...sm.guard };
    const setOwn = (patch: Partial<HeatGuard>) => save({ guard: { ...sm.guard, ...patch } });
    const phase = ss?.phase ?? (sm.shadow_since ? 'shadow' : 'active');
    const addBlock = () => this._save(r.id, { blocks: [...p.blocks, { from: '17:00', to: '22:00', days: 'all', level: 'comfort', temp: p.temps.comfort }] });
    return html`<p class="note">${t('heat.smart_note')}</p>
      ${phase === 'active' && ss?.chain?.length ? html`<p class="note">Gerade: ${ss.chain.join(' · ')}${ss.confidence != null ? ` · sicher ${Math.round(ss.confidence * 100)} %` : ''}</p>` : nothing}

      <span class="label">${t('heat.plan_title')}</span>
      ${this._learned(r, p)}

      <span class="label">${t('heat.fixed_title')}</span>
      <p class="note">${t('heat.fixed_note')}</p>
      ${this._blocks(r, p)}
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn small tinted" @click=${addBlock}>${icon(mdiPlus, 16)}${t('heat.fixed_add')}</button></div>

      <span class="label">Stil</span>
      ${ownRow(this._own(p, ['style']), () => this._reset(r.id, ['style']))}
      <div class="seg wrap" role="radiogroup" aria-label="Stil">${heatStyles().map(([k, l]) => html`<button role="radio" aria-pressed=${sm.style === k ? 'true' : 'false'} @click=${() => save({ style: k })}>${l}</button>`)}</div>
      <p class="note">${heatStyles().find((x) => x[0] === sm.style)?.[2]}</p>
      <div class="group">
        ${row('Beim Aufheizen in Schritten', step ? `${n(step)} °C alle ${minutes} Min.${sm.ramp.step == null ? ' (wie der Stil)' : ''}` : 'Gleich auf das Ziel', stepper(step, '°C', (v) => save({ ramp: { step: v, minutes: minutes || 10 } }), 0.5, 0, 5, 'Schritt'))}
        ${step ? row('Alle', undefined, durationStepper(minutes, (v) => save({ ramp: { step, minutes: v } }), 1, 120)) : nothing}
        ${sm.ramp.step != null ? html`<div class="row"><button class="btn small plain" @click=${() => save({ ramp: { step: null, minutes: null } })}>Wie der Stil</button></div>` : nothing}
      </div>
      ${this._evening(sm, save)}
      ${this._short(sm, save)}
      ${this._roomType(sm, ss?.room_type, save)}
      <span class="label">${t('heat.building')}</span>
      ${ownRow(this._own(p, ['building']), () => this._reset(r.id, ['building']))}
      <select aria-label=${t('heat.building')} @change=${(e: Event) => save({ building: (e.target as HTMLSelectElement).value as HeatBuilding })}>
        ${HEAT_BUILDINGS.map((b) => html`<option value=${b} ?selected=${(sm.building ?? 'unknown') === b}>${buildingLabel(b)}</option>`)}
      </select>
      <p class="note">${t('heat.building_note')}</p>
      <span class="label">${t('heat.shadow_title')}</span>
      ${ownRow(this._own(p, ['shadow']), () => this._reset(r.id, ['shadow']))}
      <div class="group">
        ${row('Erst beobachten', phase === 'shadow' ? 'läuft' : 'Beim nächsten Einschalten', stepper(sm.shadow_days, 'Tage', (v) => save({ shadow_days: v }), 1, 0, 60, 'Beobachten'))}
        ${phase === 'shadow' ? html`<div class="row"><button class="btn small tinted" @click=${() => this.store.heatingDo('takeover', r.id)}>${t('heat.p_takeover')}</button></div>` : nothing}
        ${phase === 'active' ? html`<div class="row"><button class="btn small plain" @click=${() => this.store.heatingDo('shadow', r.id)}>Wieder nur beobachten</button></div>` : nothing}
      </div>
      <span class="label">Grenzen für diesen Raum</span>
      <div class="group">
        ${row('Eigene Grenzen', own ? undefined : `Wie im ganzen Haus: ${n(g.min)}–${n(g.max)} °C`, sw(own, 'Eigene Grenzen', () => save({ guard: own ? {} : { max: g.max, min: g.min } })))}
        ${own
          ? html`${row('Nie wärmer als', undefined, stepper(og.max, '°C', (v) => setOwn({ max: v }), 0.5, 10, 30, 'Höchstens'))}
            ${row('Nie kälter als', undefined, stepper(og.min, '°C', (v) => setOwn({ min: v }), 0.5, 5, 25, 'Mindestens'))}
            ${row('Jemand im Raum: mindestens', undefined, stepper(og.occupied_min, '°C', (v) => setOwn({ occupied_min: v }), 0.5, 5, 28, 'Belegt'))}
            ${row('Höchstens so weit absenken', undefined, stepper(og.max_setback, '°C', (v) => setOwn({ max_setback: v }), 0.5, 0, 10, 'Absenken'))}`
          : nothing}
      </div>
      <div class="row"><button class="btn small tinted" @click=${() => (this._explain = r.id)}>So denkt deine Heizung</button><button class="btn small plain" @click=${() => this.store.heatingDo('reset_learning', r.id)}>Gelerntes vergessen</button></div>`;
  }

  /** "Sparen": nobody there, and the house modes */
  private _savePop(r: Room, p: HeatPlan) {
    const senses = r.presence.length + r.motion.length > 0 || r.door_logic;
    return html`<span class="label">Wenn niemand da ist</span>
      ${ownRow(this._own(p, ['presence']), () => this._reset(r.id, ['presence']))}
      <div class="group">
        ${presenceRows(p.presence, p.temps.eco, (v) => this._save(r.id, { presence: v }), senses)}
        ${row(t('heat.p_eco_row'), t('heat.p_eco_sub'), stepper(p.temps.eco, '°C', (v) => this._save(r.id, { temps: { ...p.temps, eco: v } }), 0.5, 5, 28, t('heat.p_eco_row')))}
      </div>
      <span class="label">Hausmodus</span>
      ${ownRow(this._own(p, ['modes']), () => this._reset(r.id, ['modes']))}
      <div class="group">
        ${modeRows(p.sleep, p.guests, p.temps, (v) => this._save(r.id, v))}
        ${row(t('heat.p_night_row'), t('heat.p_night_sub'), stepper(p.temps.night, '°C', (v) => this._save(r.id, { temps: { ...p.temps, night: v } }), 0.5, 5, 28, t('heat.p_night_row')))}
      </div>`;
  }

  /** "Fenster offen": which windows count (also from another room), what happens, the temperature drop */
  private _windowPop(r: Room, p: HeatPlan, f: HeatFound | undefined) {
    const s = this.store;
    const w = p.window;
    const roomWin = f?.contacts ?? [];
    const contacts = w.contacts.length ? w.contacts : roomWin;
    const doors = f?.doors ?? [];
    const toggleContact = (e: string) => {
      if (roomWin.includes(e) || w.contacts.includes(e)) {
        const cur = contacts.includes(e) ? contacts.filter((x) => x !== e) : [...contacts, e];
        this._save(r.id, { window: { ...w, contacts: cur.length === roomWin.length && cur.every((x) => roomWin.includes(x)) ? [] : cur } });
      } else {
        const ex = w.extra.includes(e) ? w.extra.filter((x) => x !== e) : [...w.extra, e];
        this._save(r.id, { window: { ...w, extra: ex } });
      }
    };
    const on = (e: string) => contacts.includes(e) || w.extra.includes(e);
    const others = s.devices.filter((d) => (d.kind === 'window' || d.kind === 'door') && !roomWin.includes(d.entity_id) && !doors.includes(d.entity_id) && !w.extra.includes(d.entity_id));
    return html`${ownRow(this._own(p, ['window']), () => this._reset(r.id, ['window']))}
      <div class="group">${windowRows(w, p.temps.frost, (x) => this._save(r.id, { window: { ...w, ...x } }))}</div>
      ${Object.keys(f?.own_window ?? {}).length ? html`<p class="note">Das Thermostat erkennt offene Fenster auch selbst. Meldet es das, lässt Hausregeln es in Ruhe.</p>` : nothing}
      <span class="label">Fenster und Türen</span>
      <div class="chips">
        ${[...new Set([...roomWin, ...doors, ...w.contacts, ...w.extra])].map((e) => html`<button aria-pressed=${on(e) ? 'true' : 'false'} @click=${() => toggleContact(e)}>${this._name(e)}</button>`)}
      </div>
      ${others.length
        ? html`<select aria-label="Weitere Fenster oder Türen" @change=${(e: Event) => {
            const v = (e.target as HTMLSelectElement).value;
            if (v) this._save(r.id, { window: { ...w, extra: [...w.extra, v] } });
          }}>
            <option value="">+ aus einem anderen Raum (z. B. offene Tür zum Flur)</option>
            ${others.map((d) => html`<option value=${d.entity_id}>${d.name}${s.room(d.room) ? ` (${s.room(d.room)!.name})` : ''}</option>`)}
          </select>`
        : nothing}
      <p class="note">${roomWin.length ? 'Fenster des Raums sind von selbst dabei.' : 'Keine Fensterkontakte im Raum: oben kann Hausregeln Lüften am Temperatursturz erkennen.'}</p>`;
  }

  /** "Lüften": reminders by time, humidity and CO₂, mould, "Fenster wieder zu" */
  private _ventPop(r: Room, p: HeatPlan, f: HeatFound | undefined) {
    const v = p.vent;
    const st = this._now(r.id);
    const hum = this._states((id, a) => id.startsWith('sensor.') && a.device_class === 'humidity');
    const co2 = this._states((id, a) => id.startsWith('sensor.') && (a.device_class === 'carbon_dioxide' || (a.unit_of_measurement === 'ppm' && /co2/i.test(id))));
    const humAuto = f?.humidity[0];
    const co2Auto = f?.co2[0];
    const vs = st?.vent;
    return html`${ownRow(this._own(p, ['vent']), () => this._reset(r.id, ['vent']))}
      <div class="group">
        ${row('Ans Lüften erinnern', vs && v.on ? `Jetzt: ${vs.state === 'ok' ? 'alles gut' : vs.reason}${vs.humidity != null ? ` · ${n(vs.humidity, 0)} %` : ''}${vs.co2 != null ? ` · ${n(vs.co2, 0)} ppm` : ''} · Stoßlüften ${vs.minutes} Min.` : 'Nach Uhrzeit, Luftfeuchte oder CO₂ – auch wenn Hausregeln die Heizung hier nicht regelt', sw(v.on, 'Lüften erinnern', () => this._save(r.id, { vent: { ...v, on: !v.on } })))}
      </div>
      ${v.on
        ? html`<span class="label">Zu festen Zeiten</span>
            <div class="chips">
              ${v.times.map((t) => html`<button aria-pressed="true" aria-label="${t} entfernen" @click=${() => this._save(r.id, { vent: { ...v, times: v.times.filter((x) => x !== t) } })}>${t} ×</button>`)}
              <input type="time" aria-label="Lüftungszeit hinzufügen" @change=${(e: Event) => {
                const t = (e.target as HTMLInputElement).value;
                if (t) this._save(r.id, { vent: { ...v, times: [...v.times, t] } });
              }} />
            </div>
            <p class="note">Wurde in der Stunde davor gelüftet (Fenster mindestens 2 Min. offen), kommt keine Erinnerung.</p>
            <div class="group">
              ${row('Luftfeuchte über', hum.length ? (v.humidity_sensor ? this._name(v.humidity_sensor) : humAuto ? `${this._name(humAuto)} (automatisch)` : 'kein Sensor im Raum') : 'kein Feuchtesensor', html`${v.humidity_on ? stepper(v.humidity, '%', (x) => this._save(r.id, { vent: { ...v, humidity: x } }), 5, 30, 95, 'Feuchte') : nothing}${sw(v.humidity_on, 'Feuchte', () => this._save(r.id, { vent: { ...v, humidity_on: !v.humidity_on } }))}`)}
              ${v.humidity_on && hum.length > 1
                ? html`<div class="row"><select aria-label="Feuchtesensor" @change=${(e: Event) => this._save(r.id, { vent: { ...v, humidity_sensor: (e.target as HTMLSelectElement).value || null } })}><option value="" ?selected=${!v.humidity_sensor}>Automatisch</option>${hum.map((x) => html`<option value=${x.entity_id} ?selected=${x.entity_id === v.humidity_sensor}>${x.name}</option>`)}</select></div>`
                : nothing}
              ${row('CO₂ über', co2.length ? (v.co2_sensor ? this._name(v.co2_sensor) : co2Auto ? `${this._name(co2Auto)} (automatisch)` : 'kein Sensor im Raum') : 'kein CO₂-Sensor', html`${v.co2_on ? stepper(v.co2, 'ppm', (x) => this._save(r.id, { vent: { ...v, co2: x } }), 100, 400, 5000, 'CO2') : nothing}${sw(v.co2_on, 'CO2', () => this._save(r.id, { vent: { ...v, co2_on: !v.co2_on } }))}`)}
              ${v.co2_on && co2.length > 1
                ? html`<div class="row"><select aria-label="CO2-Sensor" @change=${(e: Event) => this._save(r.id, { vent: { ...v, co2_sensor: (e.target as HTMLSelectElement).value || null } })}><option value="" ?selected=${!v.co2_sensor}>Automatisch</option>${co2.map((x) => html`<option value=${x.entity_id} ?selected=${x.entity_id === v.co2_sensor}>${x.name}</option>`)}</select></div>`
                : nothing}
              ${row('Erst nach', 'So lange muss der Wert darüber liegen', durationStepper(v.wait, (x) => this._save(r.id, { vent: { ...v, wait: x } }), 0, 120))}
              ${row('Vor Schimmel warnen', `Feuchte an kalten Außenwänden aus Raumfeuchte, Raum- und Außentemperatur${vs?.mould != null ? ` · jetzt etwa ${vs.mould} %` : ''} (ab 80 % kritisch)`, sw(v.mould, 'Schimmel', () => this._save(r.id, { vent: { ...v, mould: !v.mould } })))}
              ${row('„Fenster wieder zu“', `Wenn beim Heizen zu lange offen: ${v.close_after ? formatSeconds(v.close_after * 60) : `nach der empfohlenen Dauer + 5 Min. (jetzt ${(vs?.minutes ?? 10) + 5} Min.)`}`, sw(v.close, 'Fenster zu erinnern', () => this._save(r.id, { vent: { ...v, close: !v.close } })))}
              ${v.close ? row('Eigene Zeit', '0 Sek. = nach Außentemperatur', durationStepper(v.close_after, (x) => this._save(r.id, { vent: { ...v, close_after: x } }), 0, 240)) : nothing}
            </div>
            <p class="note">Stoßlüften: je kälter draußen, desto kürzer (unter 0 °C 5 Min., bis 10 °C 10 Min., im Sommer 25 Min.). Wer benachrichtigt wird, steht unter „Ganzes Haus“.</p>`
        : nothing}`;
  }

  /** "Von Hand & Vorheizen": changed at the thermostat or in the app; preheating for the own schedule */
  private _manualPop(r: Room, p: HeatPlan) {
    const h = this.store.plans?.heating;
    const st = this._now(r.id);
    const learn = p.preheat.learn !== false;
    const smart = p.smart?.mode === 'smart';
    return html`<span class="label">Am Thermostat oder in der App verstellt</span>
      ${ownRow(this._own(p, ['manual']), () => this._reset(r.id, ['manual']))}
      ${manualRows(p.manual, p.manual_hours, p.manual_max ?? 4, (v) => this._save(r.id, v))}
      <p class="note">Ein offenes Fenster, Sommer und Urlaub gehen trotzdem vor. Wer bei offenem Fenster von Hand hochdreht, bekommt Wärme.</p>
      <span class="label">${t('heat.level_preheat')}</span>
      ${smart
        ? html`<p class="note">${t('heat.p_preheat_smart')}</p>`
        : html`${ownRow(this._own(p, ['preheat']), () => this._reset(r.id, ['preheat']))}
            <div class="group">
              ${preheatRows(p.preheat, (ph) => this._save(r.id, { preheat: ph }), html`Rechtzeitig warm zum Beginn einer Zeit. ${st?.rate ? `Der Raum heizt etwa ${n(st.rate)} °C pro Stunde${learn ? (st.rate_learned ? ' (gelernt)' : ' (geschätzt, wird gelernt)') : ' (fest eingestellt)'}.` : ''}`, st?.rate)}
            </div>`}
      <span class="label">Sanft zu den Batterien</span>
      <p class="note">Kleine Korrekturen (unter 1 °C) gehen höchstens alle ${n(h?.config.gap ?? 5)} Min. an ein Thermostat, große Wechsel (neue Zeit, Fenster, Hausmodus) sofort. Nicht erreichbare Thermostate werden übersprungen.</p>`;
  }

  private _closeWizard() {
    this._wizard = false;
    try {
      sessionStorage.setItem('hr-heat-wizard-later', '1');
    } catch {
      /* no storage */
    }
  }

  /** page gear: arrange the room tiles (Standard and Ganzes Haus are tiles of their own) */
  openGear(): void {
    this._arrange = true;
  }

  // ------------------------------------------------------------------ page
  override render() {
    const s = this.store;
    if (!s.plans) return html`<p class="lead">Heizung ist noch nicht verfügbar.</p>`;
    const all = this._rooms;
    const shown = s.orderedRooms('heat').filter((r) => all.includes(r));
    const r = all.find((x) => x.id === this._room);
    const ex = all.find((x) => x.id === this._explain);
    const h = s.plans.heating;
    const d = h?.config.defaults;
    const style = d ? heatStyles().find((x) => x[0] === d.style.style) : undefined;
    const heated = all.filter((x) => this._plan(x.id)?.on);
    const own = heated.filter((x) => (this._plan(x.id)?.own ?? []).length);
    return html`
      <div class="rl-grid">
        ${d
          ? html`<div class="rl-tile small acc">
              <button class="rl-open" aria-label=${t('heat.defaults_title')} @click=${() => (this._house = 'defaults')}></button>
              <div class="top"><span class="rl-ic">${icon(mdiTune, 24)}</span><div class="grow"><h3>${t('heat.defaults_title')}</h3><div class="state">${t('heat.defaults_sub', { style: style?.[1] ?? '', building: buildingLabel(d.building.building), comfort: deg(d.comfort.comfort) })}</div></div><span class="go">${icon(mdiChevronRight, 20)}</span></div>
              <div class="foot"><span>${own.length ? t('heat.defaults_own', { rooms: own.map((x) => x.name).join(', ') }) : t('heat.p_defaults_all')}</span></div>
            </div>`
          : nothing}
        ${h
          ? html`<div class="rl-tile small acc">
              <button class="rl-open" aria-label=${t('heat.p_house')} @click=${() => (this._house = 'house')}></button>
              <div class="top"><span class="rl-ic">${icon(mdiHomeThermometerOutline, 24)}</span><div class="grow"><h3>${t('heat.p_house')}</h3><div class="state">${t('heat.p_house_sub', { outside: deg(h.outside.value) })}</div></div><span class="go">${icon(mdiChevronRight, 20)}</span></div>
              <div class="foot"><span class="rl-chips">
                <span class="rl-chip ${h.summer ? 'warm' : ''}">${h.summer ? t('heat.p_summer_on') : t('heat.p_heating_season')}</span>
                ${h.config.demand.on ? html`<span class="rl-chip ${h.demand.on ? 'yes' : ''}">${t(h.demand.on ? 'heat.p_demand_on' : 'heat.p_demand_off')}</span>` : nothing}
                ${h.config.exercise.on ? html`<span class="rl-chip">${t('heat.p_exercise')}</span>` : nothing}
              </span></div>
            </div>`
          : nothing}
        ${shown.map((x) => this._roomTile(x))}
      </div>
      ${all.length ? hiddenRoomsNote(s, 'heat', () => (this._arrange = true)) : html`<p class="lead">Noch keinem Raum ist ein Thermostat zugeordnet (Reiter Geräte).</p>`}

      ${this._house === 'defaults' ? html`<hr-pop heading=${t('heat.defaults_title')} .sub=${t('heat.p_defaults_pop_sub')} @close=${() => (this._house = '')}>${this._defaults()}<button slot="foot" class="btn primary" @click=${() => (this._house = '')}>${t('common.done')}</button></hr-pop>` : nothing}
      ${this._house === 'house' ? html`<hr-pop heading=${t('heat.p_house')} .sub=${t('heat.p_house_pop_sub')} @close=${() => (this._house = '')}>${this._houseBody()}<button slot="foot" class="btn primary" @click=${() => (this._house = '')}>${t('common.done')}</button></hr-pop>` : nothing}
      ${r ? this._roomPop(r) : nothing}
      ${r ? this._subPop(r) : nothing}
      ${ex ? html`<hr-pop wide heading="So denkt deine Heizung" .sub=${ex.name} @close=${() => (this._explain = '')}><hr-heat-explain .store=${s} .room=${ex.id}></hr-heat-explain></hr-pop>` : nothing}
      ${this._arrange ? html`<hr-room-arrange .store=${s} page="heat" @close=${() => (this._arrange = false)}></hr-room-arrange>` : nothing}
      ${this._wizard ? html`<hr-sheet width="720" label="Heizungs-Assistent" @close=${() => this._closeWizard()}><hr-heat-wizard .store=${s} @close=${() => this._closeWizard()}></hr-heat-wizard></hr-sheet>` : nothing}
    `;
  }
}
customElements.define('hr-heat-plans', HrHeatPlans);

registerPage('heat', {
  gear: true,
  plan: true,
  sub: (s) => {
    const p = s.plans;
    if (!p) return '';
    const ids = Object.keys(p.heat).filter((id) => p.heat[id]?.on);
    const heating = ids.filter((id) => p.now[id]?.heat?.heating).length;
    const out = p.heating?.outside.value;
    return [tn('heat.p_page_rooms', ids.length), t('heat.p_page_heating', { n: heating }), out != null ? t('heat.p_page_outside', { deg: deg(out) }) : ''].filter(Boolean).join(' · ');
  },
});
