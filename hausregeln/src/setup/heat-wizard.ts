/**
 * <hr-heat-wizard>: the heating assistant (first time in "Heizung", re-runnable from there).
 * Rooms and thermostats → comfort temperature per room (sensible presets: bath warmer, bedroom cooler) →
 * "Intelligent oder eigener Zeitplan?" → building type (prior for heat-up and cool-down) → style → airing in the
 * morning (prior until the window contacts taught it) → guardrails → direct valve control (only if a thermostat
 * can) → energy source and price (prefilled from the energy dashboard) and room sizes → summary, then everything is
 * saved at once (house_rules/heating/set with the house-wide defaults first, then house_rules/plan/set per room:
 * style and building type follow the house). Same look as the setup wizard.
 */
import { css, html, nothing, type TemplateResult } from 'lit';
import { mdiCheckboxBlankOutline, mdiCheckboxMarked, mdiClose, mdiAutoFix, mdiCalendarClock } from '@mdi/js';
import { StoreElement } from '../base';
import { icon, shared } from '../design/shared';
import { t } from '../i18n';
import type { HeatAiring, HeatAssistant, HeatBlock, HeatBuilding, HeatEnergyKind, HeatGuard, HeatStyle } from '../model';
import { HEAT_BUILDINGS, buildingLabel, buildingText, heatStyles } from '../views/heat-common';

type Step = 'rooms' | 'comfort' | 'mode' | 'building' | 'style' | 'airing' | 'guard' | 'valves' | 'energy' | 'done';
const TITLES: Record<Exclude<Step, 'building' | 'airing'>, [string, string]> = {
  rooms: ['Welche Räume soll Hausregeln heizen?', 'Räume'],
  comfort: ['Wie warm soll es sein?', 'Komfort'],
  mode: ['Intelligent oder eigener Zeitplan?', 'Art'],
  style: ['Wie soll die Heizung heizen?', 'Stil'],
  guard: ['Grenzen, die immer gelten', 'Grenzen'],
  valves: ['Ventile direkt steuern?', 'Ventile'],
  energy: ['Womit heizt du?', 'Energie'],
  done: ['Das wird eingerichtet', 'Fertig'],
};
const title = (s: Step): string => (s === 'building' ? t('heat.wiz_building_title') : s === 'airing' ? t('heat.wiz_airing_title') : TITLES[s][0]);
/** the time block every new room starts with: no "fixed time" for an intelligent room */
const factoryBlock = (b: HeatBlock) => b.from === '06:00' && b.to === '22:00' && b.days === 'all' && b.level === 'comfort';
const KINDS: [HeatEnergyKind, string][] = [
  ['gas', 'Gas'],
  ['heat_pump', 'Wärmepumpe'],
  ['oil', 'Öl'],
  ['heat', 'Fernwärme'],
  ['electric', 'Strom direkt'],
];
const n = (v: number | null | undefined, d = 1) => (v == null ? '–' : String(Math.round(v * 10 ** d) / 10 ** d).replace('.', ','));

export class HrHeatWizard extends StoreElement {
  static override properties = { ...StoreElement.properties, _step: { state: true }, _a: { state: true }, _busy: { state: true }, _msg: { state: true } };
  declare _step: Step;
  declare _a: HeatAssistant | null;
  declare _busy: boolean;
  declare _msg: string;
  private _rooms: Record<string, { on: boolean; comfort: number; smart: boolean; valve: boolean; area: number | null }> = {};
  private _style: HeatStyle = 'comfort';
  private _building: HeatBuilding = 'unknown';
  private _airing: HeatAiring = { morning: null, minutes: 10, rooms: [] };
  private _guard: HeatGuard = { max: 24, min: 15, occupied_min: 18, max_setback: 4, never: { on: false, from: '00:00', to: '05:00' } };
  private _kind: HeatEnergyKind = 'gas';
  private _price: number | null = null;

  constructor() {
    super();
    this._step = 'rooms';
    this._a = null;
    this._busy = false;
    this._msg = '';
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this._load();
  }

  private async _load() {
    const a = await this.store.heatingAssistant().catch(() => null);
    if (!a) {
      this._msg = 'Die Heizungsdaten konnten nicht geladen werden.';
      return;
    }
    for (const r of a.rooms) {
      this._rooms[r.id] = { on: r.on || !a.setup_done, comfort: r.on ? r.temps.comfort : r.comfort, smart: r.mode === 'smart' || !r.on, valve: false, area: r.area };
    }
    this._style = a.style ?? a.rooms.find((r) => r.mode === 'smart')?.style ?? 'comfort';
    this._building = a.building ?? 'unknown';
    // airing prior: the rooms with window contacts unless chosen before
    const withWindows = a.rooms.filter((r) => r.windows).map((r) => r.id);
    this._airing = { morning: a.airing?.morning ?? null, minutes: a.airing?.minutes ?? 10, rooms: a.airing?.rooms?.length ? [...a.airing.rooms] : withWindows };
    this._guard = { ...a.guard };
    const det = a.energy.detected;
    const cfg = a.energy.config;
    this._kind = cfg.kind !== 'auto' ? cfg.kind : det.kind ?? 'gas';
    this._price = cfg.price;
    this._a = a;
  }

  private get _steps(): Step[] {
    const hasValves = (this._a?.rooms ?? []).some((r) => this._rooms[r.id]?.on && Object.keys(r.valves).length);
    const anySmart = Object.values(this._rooms).some((r) => r.on && r.smart);
    return (['rooms', 'comfort', 'mode', 'building', 'style', 'airing', 'guard', 'valves', 'energy', 'done'] as Step[]).filter((s) => (s !== 'valves' || hasValves) && ((s !== 'style' && s !== 'airing') || anySmart));
  }

  static override styles = [
    shared,
    css`
      :host {
        display: flex;
        flex-direction: column;
        min-height: 0;
        max-height: 100%;
      }
      header {
        padding: var(--hr-space-4) var(--hr-space-5) var(--hr-space-2);
        display: flex;
        gap: var(--hr-space-3);
        align-items: flex-start;
      }
      header .grow {
        flex: 1;
      }
      .count {
        font-size: var(--hr-text-caption);
        color: var(--hr-label-2);
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      h2 {
        font-size: var(--hr-text-title2);
        margin-top: 2px;
      }
      .progress {
        display: flex;
        gap: 4px;
        margin-top: var(--hr-space-2);
      }
      .progress span {
        flex: 1;
        height: 4px;
        border-radius: 2px;
        background: var(--hr-fill);
      }
      .progress span.on {
        background: var(--hr-accent);
      }
      .body {
        overflow-y: auto;
        padding: var(--hr-space-3) var(--hr-space-5) var(--hr-space-5);
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-3);
        flex: 1;
        min-height: 0;
      }
      .intro {
        color: var(--hr-label-2);
        font-size: var(--hr-text-subhead);
        line-height: 1.5;
        margin: 0;
      }
      footer {
        display: flex;
        gap: var(--hr-space-2);
        padding: var(--hr-space-3) var(--hr-space-5) calc(var(--hr-space-4) + env(safe-area-inset-bottom, 0px));
        border-top: 0.5px solid var(--hr-separator);
      }
      footer .spacer {
        flex: 1;
      }
      .choice {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr));
        gap: var(--hr-space-3);
      }
      .choice button {
        display: flex;
        gap: var(--hr-space-3);
        align-items: flex-start;
        padding: var(--hr-space-4);
        border-radius: var(--hr-radius-l);
        background: var(--hr-surface);
        box-shadow: var(--hr-shadow-1);
        text-align: left;
      }
      .choice button small {
        display: block;
        color: var(--hr-label-2);
        font-size: var(--hr-text-footnote);
        margin-top: 2px;
        line-height: 1.35;
      }
      .choice button[aria-pressed='true'] {
        box-shadow: inset 0 0 0 2px var(--hr-accent);
      }
      .box {
        color: var(--hr-accent);
        display: flex;
      }
      .box.off {
        color: var(--hr-label-3);
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
      }
      .stepper output {
        min-width: 4.4em;
        text-align: center;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .note {
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
        margin: 0;
      }
      .err {
        color: var(--hr-red);
        font-size: var(--hr-text-footnote);
      }
      input[type='time'] {
        font: inherit;
        padding: 6px 8px;
        border-radius: 8px;
        border: 1px solid var(--hr-separator);
        background: var(--hr-surface);
        color: var(--hr-label);
      }
    `,
  ];

  private _stepper(v: number, unit: string, set: (v: number) => void, step: number, min: number, max: number, label: string): TemplateResult {
    const r = (x: number) => Math.round(x * 100) / 100;
    return html`<span class="stepper"><button aria-label="${label} weniger" @click=${() => (set(Math.max(min, r(v - step))), this.requestUpdate())}>−</button><output>${n(v, 2)} ${unit}</output><button aria-label="${label} mehr" @click=${() => (set(Math.min(max, r(v + step))), this.requestUpdate())}>+</button></span>`;
  }

  private _check(on: boolean, title: string, sub: string, toggle: () => void) {
    return html`<button class="row" role="checkbox" aria-checked=${on ? 'true' : 'false'} @click=${() => (toggle(), this.requestUpdate())}>
      <span class="box ${on ? '' : 'off'}">${icon(on ? mdiCheckboxMarked : mdiCheckboxBlankOutline, 24)}</span>
      <span class="grow"><div class="title">${title}</div>${sub ? html`<div class="sub">${sub}</div>` : nothing}</span>
    </button>`;
  }

  private _row(title: string, sub: string | undefined, control: TemplateResult) {
    return html`<div class="row"><span class="grow"><div class="title">${title}</div>${sub ? html`<div class="sub">${sub}</div>` : nothing}</span>${control}</div>`;
  }

  private _chosen() {
    return (this._a?.rooms ?? []).filter((r) => this._rooms[r.id]?.on);
  }

  private _body(): TemplateResult {
    const a = this._a;
    if (!a) return html`<p class="intro">${this._msg || 'Suche Räume und Thermostate …'}</p>`;
    switch (this._step) {
      case 'rooms':
        return html`<p class="intro">In diesen Räumen gibt es Thermostate. Hausregeln heizt nur die Räume, die du hier auswählst.</p>
          <div class="group">${a.rooms.map((r) => this._check(this._rooms[r.id].on, r.name, `${r.thermostats.length} Thermostat${r.thermostats.length === 1 ? '' : 'e'}${r.has_temp ? '' : ' · meldet keine Raumtemperatur'}`, () => (this._rooms[r.id].on = !this._rooms[r.id].on)))}</div>
          ${a.rooms.length ? nothing : html`<p class="note">Noch keinem Raum ist ein Thermostat zugeordnet (Reiter Geräte).</p>`}`;
      case 'comfort':
        return html`<p class="intro">Die Temperatur, wenn ihr den Raum nutzt. Vorgeschlagen nach dem Raum: im Bad etwas wärmer, im Schlafzimmer kühler.</p>
          <div class="group">${this._chosen().map((r) => this._row(r.name, undefined, this._stepper(this._rooms[r.id].comfort, '°C', (v) => (this._rooms[r.id].comfort = v), 0.5, 12, 28, r.name)))}</div>`;
      case 'mode':
        return html`<p class="intro"><b>Intelligent:</b> die Heizung lernt, wann ihr welchen Raum nutzt (Anwesenheit, Licht, Fernseher, Aufstehen und Schlafengehen), heizt rechtzeitig vor und senkt nur ab, wenn es sich lohnt. Erst beobachtet sie eine Woche und zeigt, wie sie geheizt hätte. <b>Eigener Zeitplan:</b> feste Zeiten wie bisher.</p>
          <div class="group">${this._chosen().map((r) => this._row(r.name, r.senses ? undefined : 'Ohne Melder im Raum lernt sie aus Licht, Geräten und wer zuhause ist', html`<div class="seg"><button aria-pressed=${this._rooms[r.id].smart ? 'true' : 'false'} @click=${() => ((this._rooms[r.id].smart = true), this.requestUpdate())}>${icon(mdiAutoFix, 16)} Intelligent</button><button aria-pressed=${this._rooms[r.id].smart ? 'false' : 'true'} @click=${() => ((this._rooms[r.id].smart = false), this.requestUpdate())}>${icon(mdiCalendarClock, 16)} Zeitplan</button></div>`))}</div>`;
      case 'building':
        return html`<p class="intro">${t('heat.wiz_building_intro')}</p>
          <div class="choice" role="radiogroup">${HEAT_BUILDINGS.map((b) => html`<button role="radio" aria-pressed=${this._building === b ? 'true' : 'false'} @click=${() => ((this._building = b), this.requestUpdate())}><span><b>${buildingLabel(b)}</b><small>${buildingText(b)}</small></span></button>`)}</div>
          <p class="note">${t('heat.wiz_building_note')}</p>`;
      case 'style':
        return html`<p class="intro">${t('heat.wiz_style_intro')}</p>
          <div class="choice" role="radiogroup">${heatStyles().map(([k, l, d]) => html`<button role="radio" aria-pressed=${this._style === k ? 'true' : 'false'} @click=${() => ((this._style = k), this.requestUpdate())}><span><b>${l}</b><small>${d}</small></span></button>`)}</div>`;
      case 'airing': {
        const ai = this._airing;
        const withWindows = this._chosen().filter((r) => r.windows);
        const wake = a.wake?.work;
        return html`<p class="intro">${t('heat.wiz_airing_intro')}</p>
          <div class="seg" role="radiogroup" aria-label=${t('heat.wiz_airing_title')}>
            <button role="radio" aria-pressed=${ai.morning === true ? 'true' : 'false'} @click=${() => ((ai.morning = true), this.requestUpdate())}>${t('heat.yes')}</button>
            <button role="radio" aria-pressed=${ai.morning === false ? 'true' : 'false'} @click=${() => ((ai.morning = false), this.requestUpdate())}>${t('heat.no')}</button>
          </div>
          ${ai.morning
            ? html`<div class="group">
                  ${this._row(t('heat.airing_minutes'), wake ? t('heat.wiz_airing_wake', { time: wake }) : undefined, this._stepper(ai.minutes, 'Min.', (v) => (ai.minutes = v), 5, 5, 60, t('heat.airing_minutes')))}
                </div>
                ${withWindows.length
                  ? html`<p class="note">${t('heat.wiz_airing_rooms')}</p>
                      <div class="group">${withWindows.map((r) => this._check(ai.rooms.includes(r.id), r.name, '', () => (ai.rooms = ai.rooms.includes(r.id) ? ai.rooms.filter((x) => x !== r.id) : [...ai.rooms, r.id])))}</div>`
                  : nothing}`
            : nothing}
          <p class="note">${t('heat.wiz_airing_note')}</p>`;
      }
      case 'guard': {
        const g = this._guard;
        return html`<p class="intro">Diese Grenzen gehen immer vor – auch vor dem, was die Heizung gelernt hat.</p>
          <div class="group">
            ${this._row('Nie wärmer als', undefined, this._stepper(g.max, '°C', (v) => (g.max = v), 0.5, 10, 30, 'Höchstens'))}
            ${this._row('Nie kälter als', 'Auch wenn niemand da ist', this._stepper(g.min, '°C', (v) => (g.min = v), 0.5, 5, 25, 'Mindestens'))}
            ${this._row('Jemand im Raum: mindestens', undefined, this._stepper(g.occupied_min, '°C', (v) => (g.occupied_min = v), 0.5, 5, 28, 'Belegt'))}
            ${this._row('Höchstens so weit absenken', 'Unter Komfort', this._stepper(g.max_setback, '°C', (v) => (g.max_setback = v), 0.5, 0, 10, 'Absenken'))}
            ${this._check(g.never.on, 'Nachts nicht heizen', g.never.on ? `${g.never.from}–${g.never.to}, nur die Untergrenze` : 'Zum Beispiel 0–5 Uhr', () => (g.never.on = !g.never.on))}
            ${g.never.on ? html`<div class="row"><span class="grow">von</span><input type="time" aria-label="von" .value=${g.never.from} @change=${(e: Event) => (g.never.from = (e.target as HTMLInputElement).value)} /><span>bis</span><input type="time" aria-label="bis" .value=${g.never.to} @change=${(e: Event) => (g.never.to = (e.target as HTMLInputElement).value)} /></div>` : nothing}
          </div>`;
      }
      case 'valves':
        return html`<p class="intro">Diese Thermostate lassen ihr Ventil direkt einstellen. Dann regelt Hausregeln selbst, wie weit es öffnet – gelernt je Raum, sparsam gefunkt (Batterie). Bei Problemen geht es von selbst zur normalen Regelung zurück. Wirkt nach der Beobachtungswoche.</p>
          <div class="group">${this._chosen()
            .filter((r) => Object.keys(r.valves).length)
            .map((r) => this._check(this._rooms[r.id].valve, r.name, this._rooms[r.id].smart ? '' : 'Nur mit „Intelligent“', () => (this._rooms[r.id].valve = !this._rooms[r.id].valve)))}</div>`;
      case 'energy': {
        const det = a.energy.detected;
        return html`<p class="intro">Für eine Schätzung von Verbrauch und Kosten. ${det.meter ? html`Aus dem Energie-Dashboard: <b>${a.energy.meter.label}</b>${det.price != null ? `, ${n(det.price, 3)} € je Einheit` : ''}.` : 'Im Energie-Dashboard ist kein Heizungszähler eingetragen – dann schätzt Hausregeln aus Heizkörperleistung und Ventilöffnung.'}</p>
          <div class="seg wrap" role="radiogroup">${KINDS.map(([k, l]) => html`<button role="radio" aria-pressed=${this._kind === k ? 'true' : 'false'} @click=${() => ((this._kind = k), this.requestUpdate())}>${l}</button>`)}</div>
          <div class="group">
            ${this._check(this._price == null, 'Preis aus dem Energie-Dashboard', det.price != null || det.grid_price != null ? '' : 'Dort ist keiner eingetragen', () => (this._price = this._price == null ? 0.12 : null))}
            ${this._price != null ? this._row('Preis je kWh', undefined, this._stepper(this._price, '€', (v) => (this._price = v), 0.01, 0, 2, 'Preis')) : nothing}
          </div>
          ${this._chosen().some((r) => !r.area_from_plan)
            ? html`<p class="note">Raumgrößen (im Grundriss nicht gefunden) – für die Heizkörperleistung, etwa 80 W je m²:</p>
                <div class="group">${this._chosen()
                  .filter((r) => !r.area_from_plan)
                  .map((r) => this._row(r.name, undefined, this._stepper(this._rooms[r.id].area ?? 15, 'm²', (v) => (this._rooms[r.id].area = v), 1, 1, 200, r.name)))}</div>`
            : nothing}`;
      }
      case 'done': {
        const rooms = this._chosen();
        return html`<p class="intro">${rooms.length ? 'Mit „Fertig“ wird das gespeichert. Alles lässt sich unter „Heizung“ je Raum ändern.' : 'Kein Raum ausgewählt – es wird nichts geändert.'}</p>
          <div class="group">${rooms.map((r) => {
            const x = this._rooms[r.id];
            return this._row(r.name, `${n(x.comfort)} °C · ${x.smart ? `intelligent (${heatStyles().find((s) => s[0] === this._style)?.[1]}), erst eine Woche beobachten` : 'eigener Zeitplan'}${x.valve ? ' · Ventil direkt' : ''}`, html``);
          })}</div>
          <p class="note">Grenzen: ${n(this._guard.min)}–${n(this._guard.max)} °C, mit jemandem im Raum mindestens ${n(this._guard.occupied_min)} °C${this._guard.never.on ? `, ${this._guard.never.from}–${this._guard.never.to} nicht heizen` : ''}.</p>
          <p class="note">${t('heat.wiz_done_house', { building: buildingLabel(this._building) })}</p>`;
      }
    }
  }

  private async _finish() {
    const s = this.store;
    const a = this._a;
    if (!a) return;
    this._busy = true;
    try {
      if (!s.on('heating')) await s.featuresSet({ heating: true });
      // no room chosen for the morning airing (an empty list would mean "all rooms"): not aired
      const withWindows = this._chosen().filter((r) => r.windows);
      if (this._airing.morning && !this._airing.rooms.length && withWindows.length) this._airing = { ...this._airing, morning: false };
      // style and building type are house-wide defaults: set them first, the rooms then follow them
      await s.heatingSet({
        defaults: { smart: { style: this._style, building: this._building } },
        smart: { guard: this._guard, energy: { ...a.energy.config, kind: this._kind, price: this._price }, airing: this._airing, setup_done: true },
      });
      for (const r of a.rooms) {
        const x = this._rooms[r.id];
        const plan = s.plans?.heat[r.id];
        if (!plan || !x?.on) continue;
        const cur = plan.smart;
        await s.planSet('heat', r.id, {
          ...plan,
          on: true,
          temps: { ...plan.temps, comfort: x.comfort },
          // an intelligent room learns its times: the factory block (06–22 every day) would heat it all day long
          blocks: (x.smart ? plan.blocks.filter((b) => !factoryBlock(b)) : plan.blocks).map((b) => (b.level === 'comfort' ? { ...b, temp: x.comfort } : b)),
          smart: {
            mode: x.smart ? 'smart' : 'schedule',
            style: this._style,
            ramp: cur?.ramp ?? { step: null, minutes: null },
            shadow_days: cur?.shadow_days ?? 7,
            shadow_since: cur?.shadow_since ?? null,
            guard: cur?.guard ?? {},
            valve: { on: x.valve },
            radiator_w: cur?.radiator_w ?? null,
            area: r.area_from_plan ? (cur?.area ?? null) : x.area,
            building: this._building,
          },
          reset: ['style', 'building'],
        });
      }
      this.dispatchEvent(new CustomEvent('close'));
    } catch (e) {
      this._msg = (e as Error).message || 'Das hat nicht geklappt.';
    } finally {
      this._busy = false;
    }
  }

  override render() {
    const steps = this._steps;
    const i = Math.max(0, steps.indexOf(this._step));
    const last = this._step === 'done';
    const go = (d: number) => {
      this._step = steps[Math.min(steps.length - 1, Math.max(0, i + d))];
      this.renderRoot.querySelector('.body')?.scrollTo({ top: 0 });
    };
    return html`
      <header>
        <div class="grow">
          <span class="count">Heizungs-Assistent · ${i + 1} von ${steps.length}</span>
          <h2>${title(this._step)}</h2>
          <div class="progress" aria-hidden="true">${steps.map((_s, j) => html`<span class=${j <= i ? 'on' : ''}></span>`)}</div>
        </div>
        <button class="icon-btn" aria-label="Später" title="Später" @click=${() => this.dispatchEvent(new CustomEvent('close'))}>${icon(mdiClose, 22)}</button>
      </header>
      <div class="body">${this._body()} ${this._msg && this._a ? html`<p class="err">${this._msg}</p>` : nothing}</div>
      <footer>
        ${i > 0 ? html`<button class="btn" ?disabled=${this._busy} @click=${() => go(-1)}>Zurück</button>` : nothing}
        <span class="spacer"></span>
        ${last
          ? html`<button class="btn primary" ?disabled=${this._busy || !this._a} @click=${() => this._finish()}>${this._busy ? 'Speichere …' : 'Fertig'}</button>`
          : html`<button class="btn primary" ?disabled=${!this._a} @click=${() => go(1)}>Weiter</button>`}
      </footer>
    `;
  }
}
customElements.define('hr-heat-wizard', HrHeatWizard);
