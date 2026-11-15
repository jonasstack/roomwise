/**
 * <hr-setup-wizard>: "Einrichtung". Leads step by step and roughly through everything and sets it up for real:
 * who lives here and the house mode, rooms and their sensors (with the way to "Raum einstellen"), how rules work
 * (with example rules from the real devices), then ONE step with every function on / off, and after it only the
 * steps of the functions that are on – alarm system, window warning, light (with "Lampen abgleichen"), heating,
 * vacation, robot vacuum, AI – each with its own assistant where there is one; floor plan / wall tablet, the
 * Reinschau-Licht (only with a floor plan card), anonymous diagnostics (only once its server exists), and a summary
 * of what is on and what is off. Every step can be skipped; progress is kept in the integration
 * (house_rules/setup/save) and can be resumed – also after a detour (e.g. "Lampen abgleichen" in Licht).
 * Drawn as a pop-up of the redesign (<hr-pop>).
 */
import { css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { mdiCheck, mdiCheckboxBlankOutline, mdiCheckboxMarked, mdiChevronRight, mdiClose, mdiFloorPlan, mdiTabletDashboard, mdiCellphone, mdiHomeHeart, mdiAutoFix, mdiPalette, mdiLightbulbOn, mdiCogOutline, mdiInformationOutline } from '@mdi/js';
import { StoreElement } from '../base';
import { fire, fixButton, icon, shared } from '../design/shared';
import { wizardStyles } from './wizard-styles';
import { kit } from '../design/kit';
import '../components/pop';
import type { AssistantId, FeatureId, SetupStep, SetupSuggest } from '../model';
import { FEATURES } from '../components/feature';
import { createDashboard, findEntryAlert, findFloorplanCard, floorplanAvailable, stubCard, type DashKind } from './dashboard';
import '../views/ai-settings';
import '../views/telemetry-settings';
import '../views/light-cal';
import '../views/light-glow';

interface StepMeta {
  id: SetupStep;
  title: string;
  /** short name for the progress line */
  short: string;
}

const ALL: StepMeta[] = [
  { id: 'welcome', title: 'Willkommen', short: 'Start' },
  { id: 'people', title: 'Wer wohnt hier?', short: 'Bewohner' },
  { id: 'rooms', title: 'Räume und Sensoren', short: 'Räume' },
  { id: 'rules', title: 'So funktionieren Regeln', short: 'Regeln' },
  { id: 'features', title: 'Was soll roomwise für dich tun?', short: 'Funktionen' },
  { id: 'alarm', title: 'Alarmanlage einrichten', short: 'Alarm' },
  { id: 'windows', title: 'Fenster-Warnung beim Gehen', short: 'Fenster' },
  { id: 'light', title: 'Licht automatisch', short: 'Licht' },
  { id: 'heating', title: 'Heizung', short: 'Heizung' },
  { id: 'vacation', title: 'Im Urlaub bewohnt wirken', short: 'Urlaub' },
  { id: 'vacuum', title: 'Saugroboter-Pause', short: 'Sauger' },
  { id: 'ai', title: 'KI-Anbindung', short: 'KI' },
  { id: 'tablet', title: 'Hast du ein Wandtablet?', short: 'Tablet' },
  { id: 'glow', title: 'Reinschau-Licht', short: 'Reinschau' },
  { id: 'diagnostics', title: 'Anonym bei der Verbesserung helfen?', short: 'Diagnose' },
  { id: 'done', title: 'Das ist jetzt eingerichtet', short: 'Fertig' },
];

type Ans = Record<string, any>;

/** the step of each function (only shown while it is on) */
const STEP_FEATURE: Partial<Record<SetupStep, FeatureId>> = { alarm: 'alarm', windows: 'window_warning', light: 'light', heating: 'heating', vacation: 'vacation', vacuum: 'vacuum', ai: 'ai', glow: 'light' };
/** the functions of the step "Funktionen", in this order */
const FEATURE_LIST: FeatureId[] = ['light', 'heating', 'alarm', 'window_warning', 'vacation', 'mode_auto', 'vacuum', 'ai'];
/** functions with an assistant of their own (assistant/*.ts) */
const ASSISTED: Partial<Record<FeatureId, AssistantId>> = { light: 'light', alarm: 'alarm', window_warning: 'window_warning', vacation: 'vacation', vacuum: 'vacuum', mode_auto: 'mode_auto' };

export class HrSetupWizard extends StoreElement {
  static override properties = {
    ...StoreElement.properties,
    _step: { state: true },
    _sug: { state: true },
    _ans: { state: true },
    _busy: { state: true },
    _msg: { state: true },
    _plan: { state: true },
    _side: { state: true },
  };
  declare _step: SetupStep;
  declare _sug: SetupSuggest | null;
  declare _ans: Ans;
  declare _busy: boolean;
  declare _msg: string;
  /** an already drawn floor plan in some dashboard (read only) */
  declare _plan: { card: Record<string, unknown>; dashboard: string } | null | undefined;
  /** a pop-up opened from a step, drawn on top: "Lampen abgleichen" or the Reinschau-Licht */
  declare _side: '' | 'cal' | 'glow';
  /** the floor plan card's own front door warning, for a one-time import */
  private _cardAlert: { entry: Record<string, unknown>; openings: Record<string, unknown>[]; dashboard: string } | null | undefined = undefined;
  /** chosen sensors per room (wizard step "Räume") */
  private _rooms: Record<string, string[]> = {};
  /** alarm PIN typed in the wizard: never part of the saved answers */
  private _pin = '';
  private _roomsInit = false;

  constructor() {
    super();
    this._step = 'welcome';
    this._sug = null;
    this._ans = {};
    this._busy = false;
    this._msg = '';
    this._plan = undefined;
    this._side = '';
  }

  override connectedCallback(): void {
    super.connectedCallback();
    const st = this.store?.setup;
    if (st && !st.done && st.step && st.step !== 'done') this._step = st.step;
    this._ans = { ...(st?.answers ?? {}) };
    this._load();
  }

  private async _load() {
    this.store
      .callHA<{ available: boolean }>({ type: 'house_rules/telemetry/get' })
      .then((t) => {
        this._telemetry = !!t?.available;
        this.requestUpdate();
      })
      .catch(() => undefined);
    this._sug = (await this.store.setupSuggest().catch(() => null)) ?? null;
    if (this._sug && !this._roomsInit) {
      this._roomsInit = true;
      for (const r of this._sug.rooms) this._rooms[r.id] = r.candidates.map((c) => c.entity_id);
    }
  }

  /** anonymous diagnostics can be switched on (the server is deployed); unknown until asked */
  private _telemetry?: boolean;

  private get _steps(): StepMeta[] {
    // only the steps of the functions that are on; no robot vacuum: no step for it; the Reinschau-Licht only with a
    // floor plan card; no diagnostics server yet: nothing to ask
    return ALL.filter((s) => {
      const f = STEP_FEATURE[s.id];
      if (f && !this._featOn(f)) return false;
      if (s.id === 'vacuum' && !(this._sug?.vacuums.length ?? 0)) return false;
      if (s.id === 'glow' && !floorplanAvailable(this.store)) return false;
      return s.id !== 'diagnostics' || this._telemetry === true;
    });
  }

  /** a function on in this setup: the answer of the step "Funktionen", else as it is now */
  private _featOn(f: FeatureId): boolean {
    const v = (this._ans.features ?? {})[f];
    return typeof v === 'boolean' ? v : this.store.on(f);
  }

  private _set(patch: Ans) {
    this._ans = { ...this._ans, ...patch };
  }

  static override styles = [
    shared,
    wizardStyles,
    kit,
    css`
      :host {
        display: contents;
      }
      .wiz-top {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .wiz-top .count {
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
      }
      footer.wiz-foot {
        display: flex;
        align-items: center;
        gap: var(--hr-space-2);
        width: 100%;
        flex-wrap: wrap;
      }
      footer.wiz-foot .spacer {
        flex: 1;
      }
      .rl-item .ico.f {
        color: var(--hr-accent);
      }
      .rl-item.dim .ico.f {
        color: var(--hr-label-3);
      }
      footer.wiz-foot {
        padding: 0;
        border: 0;
      }
      .rl-item.dim .ico,
      .rl-item.dim b {
        color: var(--hr-label-2);
      }
      button.rl-item[disabled] {
        opacity: 1;
        cursor: default;
      }
      .rl-item .box {
        color: var(--hr-accent);
        display: grid;
        place-items: center;
        flex: none;
      }
      .rl-item .box.off {
        color: var(--hr-label-3);
      }
      .rl-box .lead {
        color: var(--hr-accent);
        flex: none;
      }
      .room-h {
        display: flex;
        align-items: center;
        gap: var(--hr-space-2);
        justify-content: space-between;
      }
      .room-h h3 {
        margin: 0;
      }
    `,
  ];

  // ------------------------------------------------------------------ building blocks
  /** fix: a found device, with "ändern / nicht verwenden" next to it (counts everywhere, the proposals reload) */
  private _check(on: boolean, title: string, sub: string, toggle: () => void, fix?: string) {
    const inner = html`<span class="box ${on ? '' : 'off'}">${icon(on ? mdiCheckboxMarked : mdiCheckboxBlankOutline, 24)}</span>
      <span class="grow"><b>${title}</b>${sub ? html`<small>${sub}</small>` : nothing}</span>`;
    if (fix && this.store.admin)
      return html`<div class="rl-item"><button class="main" role="checkbox" aria-checked=${on ? 'true' : 'false'} @click=${toggle}>${inner}</button>${fixButton(this, fix)}</div>`;
    return html`<button class="rl-item" role="checkbox" aria-checked=${on ? 'true' : 'false'} @click=${toggle}>${inner}</button>`;
  }

  /** the proposals come from the devices: when the user corrects one (kind, room, not used), ask again */
  private _devKey = '';
  override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    const key = `${this.store.devices.length}|${this.store.devicesUnused.map((u) => u.entity_id).join()}|${this.store.devices.map((d) => `${d.kind}${d.room ?? ''}`).join()}`;
    if (this._devKey && key !== this._devKey && this._sug) this.store.setupSuggest().then((sug) => sug && ((this._sug = sug), this.requestUpdate())).catch(() => undefined);
    this._devKey = key;
  }

  private _yesNo(key: string, yes: [string, string], no: [string, string], icons: [string, string] = [mdiCheck, mdiClose]) {
    const v = this._ans[key];
    return html`<div class="choice" role="radiogroup">
      <button role="radio" aria-pressed=${v === true ? 'true' : 'false'} @click=${() => this._set({ [key]: true })}>${icon(icons[0], 24)}<span><b>${yes[0]}</b><small>${yes[1]}</small></span></button>
      <button role="radio" aria-pressed=${v === false ? 'true' : 'false'} @click=${() => this._set({ [key]: false })}>${icon(icons[1], 24)}<span><b>${no[0]}</b><small>${no[1]}</small></span></button>
    </div>`;
  }

  private _toggleIn(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  }

  // ------------------------------------------------------------------ steps
  private _welcome() {
    return html`${icon(mdiHomeHeart, 44)}
      <p class="intro">Hausregeln macht dein Zuhause von selbst ein bisschen schlauer: Licht, Heizung, Alarmanlage und eigene Regeln, geschrieben wie ein Satz. Dieser Assistent führt dich in ein paar Minuten durch alles und richtet es gleich richtig ein.</p>
      <ul class="plain">
        <li>Jeder Schritt erklärt kurz, worum es geht.</li>
        <li>Du kannst jeden Schritt überspringen und später unter <b>Einstellungen</b> weitermachen.</li>
        <li>Es schaltet nichts von selbst, bevor du es eingeschaltet hast.</li>
      </ul>`;
  }

  private _people() {
    const s = this.store;
    const list = this._sug?.residents ?? s.residents;
    const excluded = list.filter((p) => !p.counts).map((p) => p.entity_id);
    const toggle = async (id: string) => {
      const next = excluded.includes(id) ? excluded.filter((x) => x !== id) : [...excluded, id];
      await s.residentsSet(next);
      if (this._sug) this._sug = { ...this._sug, residents: list.map((p) => ({ ...p, counts: !next.includes(p.entity_id) })) };
    };
    const modes = this._ans.modes ?? { away: true, sleep: false, vacation: false };
    const setMode = (k: string) => this._set({ modes: { ...modes, [k]: !modes[k] } });
    const state: Record<string, string> = { home: 'Zuhause', not_home: 'unterwegs' };
    return html`<p class="intro">Wer hier wohnt, zählt für „alle sind weg“ und „jemand ist zuhause“. Das nutzen Hausmodus, Regeln und Alarmanlage. Nimm Gäste, Tablets oder Admin-Zugänge heraus.</p>
      <div class="rl-list">
        ${list.length
          ? list.map((p) => this._check(p.counts, p.name, p.tracked ? `Ortung: ${state[p.state] ?? p.state}` : 'Keine Ortung, zählt deshalb nicht mit', () => toggle(p.entity_id)))
          : html`<div class="rl-item"><small>Keine Personen in Home Assistant. Leg sie unter Einstellungen → Personen an und gib ihnen ihr Handy zur Ortung.</small></div>`}
      </div>
      <h3>Hausmodus</h3>
      <p class="rl-note">Der Hausmodus ist ein Wort für die Lage im Haus: Zuhause, Weg, Schlafen, Urlaub oder Gäste. Soll er von selbst wechseln?</p>
      <div class="rl-list">
        ${this._check(modes.away, '„Weg“, wenn alle weg sind', 'und „Zuhause“, sobald jemand heimkommt', () => setMode('away'))}
        ${this._check(modes.sleep, '„Schlafen“ nachts, wenn jemand zuhause ist', 'Zeit für „nachts“ unter Einstellungen → Wörter in Regeln', () => setMode('sleep'))}
        ${this._check(modes.vacation, '„Urlaub“, wenn alle seit einem Tag weg sind', '', () => setMode('vacation'))}
      </div>
      <p class="rl-note">Genauer einstellen kannst du das später unter Zuhause → Hausmodus.</p>`;
  }

  private _roomsStep() {
    const sug = this._sug;
    if (!sug) return html`<p class="rl-note">Lade …</p>`;
    if (!sug.rooms.length)
      return html`<p class="intro">Hausregeln nimmt die Bereiche aus Home Assistant als Räume. Es gibt noch keine. Leg sie unter Einstellungen → Bereiche an und ordne deine Geräte zu, dann starte diesen Schritt neu.</p>`;
    return html`<p class="intro">Jeder Raum merkt, ob jemand da ist. Dafür zählen seine Anwesenheits- und Bewegungsmelder. Vorgeschlagen ist, was in Home Assistant im Raum liegt oder vom Namen her passt. Hake ab, was stimmt. Alles Weitere zu einem Raum (wann er leer ist, Türen, Licht, Heizung) steckt in „Raum einstellen“.</p>
      ${sug.rooms.map(
        (r) => html`<div class="room-h"><h3>${r.name}</h3><button class="btn small plain" @click=${() => fire(this, 'hr-room-settings', { id: r.id })}>${icon(mdiCogOutline, 16)}Raum einstellen</button></div>
          <div class="rl-list">
            ${r.candidates.length
              ? r.candidates.map((c) =>
                  this._check(
                    (this._rooms[r.id] ?? []).includes(c.entity_id),
                    c.name,
                    `${c.kind === 'presence' ? 'Anwesenheit' : 'Bewegung'}${c.guess ? ' · noch ohne Raum, passt vom Namen her' : ''}`,
                    () => {
                      this._rooms = { ...this._rooms, [r.id]: this._toggleIn(this._rooms[r.id] ?? [], c.entity_id) };
                      this.requestUpdate();
                    },
                    c.entity_id,
                  ),
                )
              : html`<div class="rl-item"><small>${r.door_logic ? 'Kein Melder, aber eine Tür: Hausregeln schätzt über die Tür, ob jemand drin ist.' : 'Kein Melder gefunden. Ohne Sensor weiß der Raum nicht, ob jemand da ist.'}</small></div>`}
          </div>`,
      )}`;
  }

  private _rulesStep() {
    const ex = this._sug?.examples ?? [];
    const adopted: string[] = this._ans.adopted ?? [];
    const adopt = async (e: SetupSuggest['examples'][number]) => {
      try {
        await this.store.saveRule({ ...e.rule, meta: { ...e.rule.meta, origin: 'suggestion' } });
        this._set({ adopted: [...adopted, e.id] });
        fire(this, 'hr-toast', `„${e.title}“ übernommen`);
      } catch (err) {
        this._msg = (err as Error).message;
      }
    };
    return html`<p class="intro">Eine Regel ist ein Satz. Jeder Teil hat eine Farbe, und so liest du sie:</p>
      <div class="card anatomy">
        <div class="tone-when"><span class="kw">Wenn</span><span>etwas passiert <small>(Auslöser: Tür geht auf, jemand kommt heim, 7 Uhr)</small></span></div>
        <div class="tone-and"><span class="kw">und</span><span>es gerade so ist <small>(Bedingung: dunkel, niemand zuhause)</small></span></div>
        <div class="tone-then"><span class="kw">dann</span><span>tu das <small>(Aktion: Licht an, Nachricht, Heizung aus)</small></span></div>
        <div class="tone-only"><span class="kw">nur</span><span>in diesen Grenzen <small>(nachts, werktags, nicht im Urlaub)</small></span></div>
        <div class="tone-while"><span class="kw">Solange</span><span>es stimmt, gilt die Regel, danach stellt sie alles zurück</span></div>
      </div>
      <h3>Beispiele aus deinem Zuhause</h3>
      ${ex.length
        ? ex.map(
            (e) => html`<div class="card ex">
              <b>${e.title}</b>
              <p>${e.sentence}</p>
              <small>${e.why}</small>
              ${adopted.includes(e.id)
                ? html`<span class="ok">${icon(mdiCheck, 16)}Übernommen</span>`
                : html`<button class="btn small tinted" @click=${() => adopt(e)}>Übernehmen</button>`}
            </div>`,
          )
        : html`<p class="rl-note">Für Beispiele fehlen passende Geräte. Unter „Regeln“ schreibst du einfach einen Satz, z. B. „Wenn die Haustür aufgeht, mach das Flurlicht an“.</p>`}
      <p class="rl-note">Später: unter „Regeln“ einen Satz eintippen oder Bausteine antippen. Jede Regel lässt sich vorher prüfen, ohne dass etwas schaltet.</p>`;
  }

  private _alarmStep() {
    const sug = this._sug;
    const s = this.store;
    const a = this._ans.alarm_cfg ?? {
      sensors: (sug?.alarm.away ?? []).map((d) => d.entity_id),
      persons: 'everyone',
      sirens: [] as string[],
      flash: true,
      arm_away: false,
      disarm_home: false,
    };
    const up = (patch: Ans) => this._set({ alarm_cfg: { ...a, ...patch } });
    const persons = s.persons;
    const isOn = (id: string) => a.persons === 'everyone' || a.persons.includes(id);
    const togglePerson = (id: string) => {
      const next = this._toggleIn(a.persons === 'everyone' ? persons.map((p) => p.id) : a.persons, id);
      up({ persons: next.length === persons.length ? 'everyone' : next });
    };
    return html`<p class="intro">Hausregeln macht aus deinen Tür- und Fensterkontakten und Meldern eine Alarmanlage: Nachricht aufs Handy (mit Knopf „Alarm aus“), Sirene und Licht. Scharf schaltest du sie von Hand oder automatisch, wenn alle weg sind.</p>
      ${this._assist('alarm')}
      ${this._viaAssistant('alarm')
        ? nothing
        : sug
        ? html`<h3>Was soll auslösen, wenn niemand da ist?</h3>
            <div class="rl-list">
              ${sug.alarm.away.length
                ? sug.alarm.away.map((d) => this._check(a.sensors.includes(d.entity_id), d.name, s.room(d.room ?? undefined)?.name ?? '', () => up({ sensors: this._toggleIn(a.sensors, d.entity_id) }), d.entity_id))
                : html`<div class="rl-item"><small>Keine Tür-, Fenster- oder Bewegungsmelder in deinen Räumen gefunden.</small></div>`}
            </div>
            <p class="rl-note">Für „Nacht“ nimmt Hausregeln davon nur Türen und Fenster, für „Zuhause“ nur Türen. Alles änderbar unter Alarmanlage.</p>
            <h3>Wer bekommt die Nachricht?</h3>
            <div class="rl-list">${persons.map((p) => this._check(isOn(p.id), p.name, p.phone ? 'Handy gefunden' : 'Kein Handy mit der Home Assistant-App', () => togglePerson(p.id)))}</div>
            <h3>Was passiert noch?</h3>
            <div class="rl-list">
              ${sug.alarm.sirens.map((d) => this._check(a.sirens.includes(d.entity_id), `Sirene: ${d.name}`, '', () => up({ sirens: this._toggleIn(a.sirens, d.entity_id) })))}
              ${this._check(a.flash, 'Alle Lichter blinken', 'bei Alarm, bis jemand ausschaltet', () => up({ flash: !a.flash }))}
              ${this._check(a.arm_away, 'Scharf, wenn alle weg sind', 'nach 5 Minuten', () => up({ arm_away: !a.arm_away }))}
              ${this._check(a.disarm_home, 'Aus, sobald jemand heimkommt', 'über die Ortung des Handys', () => up({ disarm_home: !a.disarm_home }))}
            </div>
            <h3>PIN zum Ausschalten</h3>
            <div class="rl-list"><div class="row">
              <input class="pin" type="password" inputmode="numeric" autocomplete="new-password" placeholder="PIN, z. B. 4 Ziffern" aria-label="PIN" .value=${this._pin} @input=${(e: Event) => (this._pin = (e.target as HTMLInputElement).value.trim())} />
            </div></div>
            <p class="rl-note">Mit PIN fragt Hausregeln beim Ausschalten danach (auch in der Alarmzentrale von Home Assistant). Ohne PIN kann jeder mit Zugang zu Home Assistant ausschalten. „Alarm aus“ in der Handy-Nachricht bleibt erlaubt, das Handy fragt vorher Face ID bzw. seinen Code ab.</p>`
        : nothing}`;
  }

  private _windowsStep() {
    const sug = this._sug?.window_warning;
    const w = this._ans.windows_cfg ?? { doors: (sug?.doors ?? []).map((d) => d.entity_id), only_last: true, lights: false, announce: true, import: false };
    const up = (patch: Ans) => this._set({ windows_cfg: { ...w, ...patch } });
    if (this._cardAlert === undefined) {
      this._cardAlert = null;
      findEntryAlert(this.store).then((c) => {
        this._cardAlert = c;
        if (c && this._ans.windows_cfg?.import === undefined) up({ import: true });
        this.requestUpdate();
      });
    }
    const card = this._cardAlert;
    return html`<p class="intro">Geht die Haustür auf, während noch Fenster offen sind, erinnert Hausregeln daran: Licht blinkt kurz rot, und wenn niemand bestätigt, kommt eine Durchsage „Noch offen: Küchenfenster“.</p>
      ${this._assist('window_warning')}
      ${!this._viaAssistant('window_warning')
        ? card
          ? html`<div class="rl-list">${this._check(w.import, `Einstellungen der Grundriss-Karte übernehmen`, `Die Karte im Dashboard „${card.dashboard}“ hat schon eine Haustür-Warnung. Die Karte selbst bleibt unverändert.`, () => up({ import: !w.import }))}</div>
              ${w.import ? nothing : this._windowsOptions(w, up)}`
          : this._windowsOptions(w, up)
        : nothing}`;
  }

  private _windowsOptions(w: Ans, up: (p: Ans) => void) {
    const sug = this._sug?.window_warning;
    return html`<h3>Welche Tür?</h3>
      <div class="rl-list">
        ${(this._sug?.alarm.away ?? []).filter((d) => d.kind === 'door').map((d) => this._check(w.doors.includes(d.entity_id), d.name, (sug?.doors ?? []).some((x) => x.entity_id === d.entity_id) ? 'vorgeschlagen' : '', () => up({ doors: this._toggleIn(w.doors, d.entity_id) })))}
      </div>
      <p class="rl-note">Gezählt werden alle Fenster (${sug?.windows.length ?? 0}), auch neue.</p>
      <div class="rl-list">
        ${this._check(w.only_last, 'Nur, wenn der Letzte geht', 'wenn höchstens eine Person zuhause ist', () => up({ only_last: !w.only_last }))}
        ${this._check(w.lights, 'Flurlicht blinkt 3× rot', 'danach wieder wie vorher', () => up({ lights: !w.lights }))}
        ${this._check(w.announce, 'Durchsage nach 30 Sekunden', 'auf den Lautsprechern der Alarmanlage, wenn niemand bestätigt', () => up({ announce: !w.announce }))}
      </div>`;
  }

  private _lightStep() {
    const sug = this._sug;
    const rooms = (sug?.rooms ?? []).filter((r) => r.lights.length);
    const chosen: string[] = this._ans.light_rooms ?? rooms.filter((r) => (this._rooms[r.id] ?? r.candidates.map((c) => c.entity_id)).length).map((r) => r.id);
    return html`<p class="intro">Licht geht von selbst an, wenn jemand im Raum ist und es dunkel ist, und aus, wenn der Raum leer ist. Wer von Hand schaltet, hat Vorrang. Später kannst du je Raum genaue Lichtregeln bauen (Tageszeit, Fernsehen, Schlafen).</p>
      ${this._assist('light')}
      ${!this._viaAssistant('light')
        ? html`<h3>In diesen Räumen</h3>
            <div class="rl-list">
              ${rooms.length
                ? rooms.map((r) => {
                    const sensors = (this._rooms[r.id] ?? []).length || r.door_logic;
                    return this._check(chosen.includes(r.id), r.name, `${r.lights.length} ${r.lights.length === 1 ? 'Licht' : 'Lichter'}${sensors ? '' : ' · kein Melder, der Raum weiß nicht, ob jemand da ist'}`, () => this._set({ light_rooms: this._toggleIn(chosen, r.id) }));
                  })
                : html`<div class="rl-item"><small>Keine Lichter in deinen Räumen gefunden.</small></div>`}
            </div>`
        : nothing}
      <div class="rl-box">
        <div class="line">
          <span class="lead">${icon(mdiPalette, 24)}</span>
          <span class="grow"><b>Lampen aufeinander abgleichen</b><small>Lampen verschiedener Hersteller zeigen „dasselbe“ Warmweiß oder Rot oft verschieden. Raum für Raum stellst du jede Lampe von Hand nach, bis alle gleich aussehen. Hausregeln merkt sich das je Lampe.</small></span>
          <button class="btn small tinted" @click=${() => (this._side = 'cal')}>Abgleichen</button>
        </div>
      </div>
      <p class="rl-note">Geht auch später: Licht → Zahnrad oben → „Lampen abgleichen“.</p>`;
  }

  private _simpleStep(f: FeatureId, intro: string, extra?: TemplateResult) {
    return html`<p class="intro">${intro}</p>
      ${this._assist(f)} ${extra && !this._viaAssistant(f) ? extra : nothing}`;
  }

  /** "Lieber ausführlich?": the function's own assistant (assistant/*.ts), drawn on top; the step then adds nothing */
  private _assist(f: FeatureId) {
    const id = ASSISTED[f];
    if (!id) return nothing;
    const used = this._viaAssistant(f);
    return html`<div class="rl-box">
      <div class="line">
        <span class="lead">${icon(mdiAutoFix, 24)}</span>
        <span class="grow"
          ><b>${used ? 'Mit dem Assistenten eingerichtet' : 'Lieber ausführlich?'}</b
          ><small>${used ? '„Weiter“ ändert daran nichts mehr. Du kannst den Assistenten noch einmal öffnen.' : `Der Assistent für ${FEATURES[f].label} fragt Schritt für Schritt alles ab. Oder du nimmst unten die schnelle Einrichtung.`}</small></span
        >
        <button
          class="btn small ${used ? '' : 'tinted'}"
          @click=${() => {
            this._set({ [`${f}_assistant`]: true });
            fire(this, 'hr-assistant', { feature: id });
          }}
        >
          ${used ? 'Nochmal öffnen' : 'Assistent starten'}
        </button>
      </div>
    </div>`;
  }

  private _viaAssistant(f: FeatureId): boolean {
    return this._ans[`${f}_assistant`] === true;
  }

  // ------------------------------------------------------------------ step "Funktionen"
  private _featuresStep() {
    const s = this.store;
    const cur: Record<string, boolean> = this._ans.features ?? {};
    const toggle = (f: FeatureId) => {
      const on = !this._featOn(f);
      const next: Record<string, boolean> = { ...cur, [f]: on };
      // what a function needs comes with it, and goes off with what it needs
      const need = FEATURES[f].needs;
      if (on && need) next[need] = true;
      if (!on) for (const g of FEATURE_LIST) if (FEATURES[g].needs === f) next[g] = false;
      this._set({ features: next });
    };
    const shown = FEATURE_LIST.filter((f) => f !== 'vacuum' || (this._sug?.vacuums.length ?? 0) > 0);
    return html`<p class="intro">Schalte ein, was roomwise für dich tun soll. Für jede eingeschaltete Funktion kommt danach ein kurzer Schritt (oder ihr Assistent), alles andere bleibt aus und aus dem Weg.</p>
      <div class="rl-list">
        ${shown.map((f) => {
          const m = FEATURES[f];
          const on = this._featOn(f);
          return html`<div class="rl-item ${on ? '' : 'dim'}">
            <span class="ico f">${icon(m.icon, 22)}</span>
            <span class="grow"><b>${m.label}</b><small>${m.sub}${m.needs ? html` · braucht ${FEATURES[m.needs].label}` : nothing}</small></span>
            <button class="switch" role="switch" aria-label=${m.label} aria-checked=${on ? 'true' : 'false'} ?disabled=${!s.haAdmin} @click=${() => toggle(f)}></button>
          </div>`;
        })}
      </div>
      <p class="rl-note">Ein- und ausschalten geht jederzeit unter Einstellungen → Funktionen. Ausgeschaltetes stellt nichts um, die Einstellungen bleiben erhalten.</p>`;
  }

  // ------------------------------------------------------------------ step "Reinschau-Licht" (only with a floor plan card)
  private _glowStep() {
    return html`<p class="intro">Ein leerer Raum glimmt ganz leicht, solange nebenan jemand ist und die Tür dazwischen offen steht. So siehst du beim Reinschauen, ob dort etwas liegt, ohne das volle Licht anzumachen.</p>
      <div class="rl-box">
        <div class="line">
          <span class="lead">${icon(mdiLightbulbOn, 24)}</span>
          <span class="grow"><b>Raum für Raum auf dem Grundriss</b><small>Tipp einen Raum an, wähle die Nachbarräume (Türen mit Sensor sind schon vorgeschlagen), die Lampen und wie hell. Eingeschaltet wird nur, was du dort einschaltest.</small></span>
          <button class="btn small tinted" @click=${() => (this._side = 'glow')}>Einrichten</button>
        </div>
      </div>
      <p class="rl-note">Geht auch später: Licht → Kachel „Reinschau-Licht“. Wann es überhaupt glimmen darf (nachts, bei Dunkelheit, Uhrzeit), stellst du dort einmal für alle Räume ein.</p>`;
  }

  private _tabletStep() {
    const s = this.store;
    const avail = floorplanAvailable(s);
    if (!avail)
      return html`<p class="intro">Für ein Wandtablet gibt es die <b>Grundriss-Karte</b>: dein Zuhause als Plan zum Antippen, mit Licht, Heizung, Alarm und Regeln. Sie gehört zu <b>roomwise</b>, ist hier aber nicht installiert.</p>
        <p class="rl-note">Sobald die Grundriss-Karte (Integration „Grundriss-Karte“) installiert ist, kannst du diesen Schritt unter Einstellungen → Einrichtung wiederholen. Für jetzt einfach weiter.</p>`;
    const tablet = this._ans.tablet;
    const want: boolean | undefined = tablet === true ? true : this._ans.floorplan_view;
    const kind: DashKind = tablet === true ? 'tablet' : 'view';
    const made: string | undefined = this._ans.dashboard;
    if (this._plan === undefined) {
      this._plan = null;
      findFloorplanCard(s).then((p) => (this._plan = p ?? null));
    }
    const create = async () => {
      this._busy = true;
      this._msg = '';
      try {
        const path = await createDashboard(s, kind, this._plan?.card ?? stubCard(s));
        if (path) this._set({ dashboard: path });
        else fire(this, 'hr-toast', 'Vorschau: kein Dashboard angelegt');
      } catch (e) {
        this._msg = (e as Error).message;
      }
      this._busy = false;
    };
    return html`<p class="intro">Die <b>Grundriss-Karte</b> zeigt dein Zuhause als Plan zum Antippen. Auf einem Tablet an der Wand ist sie die Steuerzentrale, auf Handy und PC ein schneller Überblick.</p>
      ${this._yesNo('tablet', ['Ja, ich habe ein Wandtablet', 'Eine eigene Ansicht, die den ganzen Bildschirm füllt.'], ['Nein', 'Vielleicht trotzdem den Grundriss am Handy oder PC?'], [mdiTabletDashboard, mdiCellphone])}
      ${tablet === false
        ? html`<h3>Grundriss trotzdem haben?</h3>${this._yesNo('floorplan_view', ['Ja, als Ansicht in der Seitenleiste', 'Für Handy und PC.'], ['Nein, danke', 'Kein neues Dashboard.'], [mdiFloorPlan, mdiClose])}`
        : nothing}
      ${want
        ? made
          ? html`<div class="card ex"><span class="ok">${icon(mdiCheck, 16)}Angelegt</span><p>Neues Dashboard <b>/${made}</b>. Öffne es auf dem ${kind === 'tablet' ? 'Tablet' : 'Handy oder PC'} über die Seitenleiste.</p>
              ${kind === 'tablet' ? html`<small>Tipp fürs Wandtablet: im Browser oder in einer Kiosk-App (z. B. Fully Kiosk) Vollbild einschalten und dieses Dashboard als Startseite setzen.</small>` : nothing}
              <a class="btn small tinted" href="/${made}" target="_top">Öffnen</a></div>`
          : html`<div class="card ex">
              <b>${kind === 'tablet' ? 'Wandtablet-Ansicht anlegen' : 'Grundriss-Ansicht anlegen'}</b>
              <p>${this._plan ? html`Mit deinem Grundriss aus dem Dashboard „${this._plan.dashboard}“.` : 'Mit einem ersten Plan: ein Rechteck je Raum, schon mit Lichtern und Sensoren. Zeichnen kannst du ihn danach in der Karte (Stift).'}</p>
              <small>Es entsteht ein neues Dashboard. Deine bestehenden Dashboards bleiben unverändert.</small>
              <button class="btn small primary" ?disabled=${this._busy} @click=${create}>${this._busy ? 'Lege an …' : 'Jetzt anlegen'}</button>
            </div>`
        : nothing}
      ${this._msg ? html`<p class="err">${this._msg}</p>` : nothing}`;
  }

  private _done() {
    const s = this.store;
    const go = (tab: string) => {
      fire(this, 'hr-tab', tab);
      this._finish();
    };
    const row = (on: boolean, ic: string, title: string, sub: string, tab?: string) => html`<button class="rl-item ${on ? '' : 'dim'}" ?disabled=${!tab} @click=${() => tab && go(tab)}>
      <span class="ico f">${icon(ic, 22)}</span><span class="grow"><b>${title}</b><small>${sub}</small></span>${tab ? html`<span class="go">${icon(mdiChevronRight, 18)}</span>` : nothing}
    </button>`;
    const counting = s.residents.filter((p) => p.counts).map((p) => p.name);
    const lightRooms = Object.entries(s.plans?.light ?? {}).filter(([, p]) => p.on).length;
    const rules = s.rules.length;
    const detail: Partial<Record<FeatureId, string>> = {
      alarm: 'eingerichtet, noch unscharf',
      light: `${lightRooms} ${lightRooms === 1 ? 'Raum' : 'Räume'} mit Lichtregeln`,
      heating: 'Heizpläne unter Heizung',
      vacation: 'im Hausmodus „Urlaub“',
      mode_auto: 'wechselt von selbst',
      ai: s.ai?.provider && s.ai.provider !== 'none' ? `${s.ai.provider}` : 'an, noch nicht verbunden',
    };
    const feats = FEATURE_LIST.filter((f) => f !== 'vacuum' || (this._sug?.vacuums.length ?? 0) > 0);
    const on = feats.filter((f) => s.on(f));
    const off = feats.filter((f) => !s.on(f));
    const tab = (f: FeatureId) => FEATURES[f].tab ?? FEATURES[f].in;
    return html`<p class="intro">Fertig. Hier ist alles auf einen Blick. Tipp auf eine Zeile, um dorthin zu springen. Ändern kannst du alles jederzeit, Funktionen schaltest du unter Einstellungen ein und aus.</p>
      <div class="rl-sec">
        <h3>Zuhause</h3>
        <div class="rl-list">
          ${row(true, mdiHomeHeart, 'Bewohner', counting.length ? counting.join(', ') : 'noch niemand', 'home#residents')}
          ${row(true, mdiCogOutline, 'Räume', `${s.rooms.length} Räume, ${s.rooms.filter((r) => r.presence.length || r.motion.length).length} mit Meldern`, 'rooms')}
          ${row(rules > 0, mdiAutoFix, 'Regeln', rules ? `${rules} ${rules === 1 ? 'Regel' : 'Regeln'}` : 'noch keine', 'rules')}
          ${this._ans.dashboard ? row(true, mdiFloorPlan, 'Grundriss', `Dashboard /${this._ans.dashboard}`) : nothing}
        </div>
      </div>
      <div class="rl-sec">
        <h3>An (${on.length})</h3>
        <div class="rl-list">
          ${on.length ? on.map((f) => row(true, FEATURES[f].icon, FEATURES[f].label, detail[f] ?? 'an', tab(f))) : html`<div class="rl-item"><small>Noch keine Funktion eingeschaltet.</small></div>`}
        </div>
      </div>
      ${off.length
        ? html`<div class="rl-sec">
            <h3>Aus (${off.length})</h3>
            <div class="rl-list">${off.map((f) => row(false, FEATURES[f].icon, FEATURES[f].label, 'aus · einschalten unter Einstellungen → Funktionen', 'settings'))}</div>
          </div>`
        : nothing}`;
  }

  // ------------------------------------------------------------------ applying a step on "Weiter"
  private async _apply(step: SetupStep): Promise<void> {
    const s = this.store;
    const a = this._ans;
    switch (step) {
      case 'people': {
        const modes = a.modes ?? { away: true, sleep: false, vacation: false };
        const any = modes.away || modes.sleep || modes.vacation;
        await s.featuresSet({ mode_auto: any });
        if (any) await s.setupApply('modes', modes);
        break;
      }
      case 'rooms':
        if (this._sug?.rooms.length) {
          const kindOf = (eid: string) => this._sug!.rooms.flatMap((r) => r.candidates).find((c) => c.entity_id === eid)?.kind;
          await s.setupApply('rooms', {
            rooms: this._sug.rooms.map((r) => ({ id: r.id, presence: (this._rooms[r.id] ?? []).filter((e) => kindOf(e) === 'presence'), motion: (this._rooms[r.id] ?? []).filter((e) => kindOf(e) === 'motion') })),
          });
        }
        break;
      case 'features': {
        // switch exactly what changed; each function's details come in its own step
        const changes: Partial<Record<FeatureId, boolean>> = {};
        for (const [f, v] of Object.entries(a.features ?? {})) if (typeof v === 'boolean' && s.on(f as FeatureId) !== v) changes[f as FeatureId] = v;
        if (Object.keys(changes).length) await s.featuresSet(changes);
        break;
      }
      case 'alarm':
        if (this._featOn('alarm') && !this._viaAssistant('alarm')) await this._applyAlarm();
        break;
      case 'windows':
        if (this._featOn('window_warning') && !this._viaAssistant('window_warning')) {
          const w = a.windows_cfg ?? { doors: (this._sug?.window_warning.doors ?? []).map((d) => d.entity_id), only_last: true, lights: false, announce: true };
          if (w.import && this._cardAlert) await s.windowWarningImport(this._cardAlert.entry, this._cardAlert.openings, this._cardAlert.dashboard);
          else {
            const doorRooms = new Set(w.doors.map((d: string) => s.device(d)?.room).filter(Boolean));
            const lights = s.devices.filter((d) => d.kind === 'light' && doorRooms.has(d.room)).map((d) => d.entity_id);
            await s.windowWarningSet({ doors: w.doors, windows: 'all', only_last: w.only_last, lights: { mode: w.lights && lights.length ? 'red' : 'none', entities: lights }, announce: { ...(s.windowWarning?.config.announce ?? { players: [], tts: '', language: '', texts: { general: '', all: '', single: '' } }), mode: w.announce ? 'all' : 'none' } });
          }
        }
        break;
      case 'light':
        if (this._featOn('light') && !this._viaAssistant('light')) {
          const rooms = (this._sug?.rooms ?? []).filter((r) => r.lights.length);
          const chosen: string[] = a.light_rooms ?? rooms.filter((r) => (this._rooms[r.id] ?? []).length).map((r) => r.id);
          if (chosen.length) await s.setupApply('light', { rooms: chosen });
        }
        break;
      case 'heating':
      case 'vacuum':
      case 'ai':
      case 'glow':
        // switched in "Funktionen"; the settings themselves are saved where they are made
        break;
      case 'diagnostics':
        if (typeof a.diagnostics === 'boolean') await s.callHA({ type: 'house_rules/telemetry/set', on: a.diagnostics });
        break;
      case 'vacation':
        if (this._featOn('vacation') && !this._viaAssistant('vacation')) await s.setupApply('vacation', {});
        break;
    }
  }

  private async _applyAlarm() {
    const s = this.store;
    const cfg = s.alarm?.config;
    const sug = this._sug;
    if (!cfg || !sug) return;
    const a = this._ans.alarm_cfg ?? { sensors: sug.alarm.away.map((d) => d.entity_id), persons: 'everyone', sirens: [], flash: true, arm_away: false, disarm_home: false };
    const chosen = new Set<string>(a.sensors);
    const lights = s.devices.filter((d) => d.kind === 'light').map((d) => d.entity_id);
    const mode = (m: 'away' | 'night' | 'home', sensors: string[]) => ({
      ...cfg.modes[m],
      sensors,
      lights: a.flash ? { mode: 'flash' as const, entities: lights } : cfg.modes[m].lights,
      auto: m === 'away' ? { ...cfg.modes[m].auto, arm_away: a.arm_away, away_for: 5, disarm_home: a.disarm_home } : cfg.modes[m].auto,
    });
    if (!s.on('alarm')) await s.featuresSet({ alarm: true });
    await s.alarmConfig({
      enabled: true,
      modes: { away: mode('away', [...chosen]), night: mode('night', sug.alarm.night.filter((e) => chosen.has(e))), home: mode('home', sug.alarm.home.filter((e) => chosen.has(e))) },
      notify: { ...cfg.notify, persons: a.persons },
      sirens: a.sirens,
      ...(this._pin ? { code: this._pin, confirm: 'pin' as const } : cfg.has_code ? {} : { confirm: 'none' as const }),
    });
    this._pin = '';
  }

  // ------------------------------------------------------------------ navigation
  private async _go(delta: number, apply: boolean) {
    const steps = this._steps;
    const i = Math.max(0, steps.findIndex((x) => x.id === this._step));
    if (apply) {
      this._busy = true;
      this._msg = '';
      try {
        await this._apply(this._step);
      } catch (e) {
        this._msg = (e as Error).message || 'Das hat nicht geklappt.';
        this._busy = false;
        return;
      }
      this._busy = false;
    }
    const next = steps[Math.min(steps.length - 1, Math.max(0, i + delta))].id;
    this._step = next;
    this._msg = '';
    this.renderRoot.querySelector('#top')?.scrollIntoView({ block: 'start' });
    await this.store.setupSave({ step: next, answers: this._ans }).catch(() => undefined);
  }

  private async _finish() {
    await this.store.setupSave({ done: true, answers: this._ans }).catch(() => undefined);
    this.dispatchEvent(new CustomEvent('close'));
  }

  private _close() {
    // closed early: keep the progress, do not open by itself again (resume in Einstellungen)
    this.store.setupSave({ step: this._step, answers: { ...this._ans, dismissed: true } }).catch(() => undefined);
    this.dispatchEvent(new CustomEvent('close'));
  }

  private _body(): TemplateResult {
    switch (this._step) {
      case 'welcome':
        return this._welcome();
      case 'people':
        return this._people();
      case 'rooms':
        return this._roomsStep();
      case 'rules':
        return this._rulesStep();
      case 'features':
        return this._featuresStep();
      case 'glow':
        return this._glowStep();
      case 'alarm':
        return this._alarmStep();
      case 'windows':
        return this._windowsStep();
      case 'light':
        return this._lightStep();
      case 'heating':
        return this._simpleStep(
          'heating',
          'Hausregeln steuert deine Heizkörperthermostate: nach Plan je Raum, sparen, wenn niemand da ist, aus bei offenem Fenster. Ohne Heizplan ändert sich noch nichts.',
          html`<div class="rl-box">
            <div class="line">
              <span class="lead">${icon(mdiInformationOutline, 24)}</span>
              <span class="grow"><b>Heizpläne unter „Heizung“</b><small>Dort führt dich ein eigener Assistent Raum für Raum durch Wohlfühl- und Spartemperatur. Deine Einrichtung hier merkt sich, wo du warst.</small></span>
              <button class="btn small tinted" @click=${() => this._detour('heat')}>Zur Heizung</button>
            </div>
          </div>`,
        );
      case 'vacation':
        return this._simpleStep(
          'vacation',
          'Im Hausmodus „Urlaub“ gehen Lichter so an und aus, wie ihr es im Alltag macht, damit es von außen bewohnt wirkt. Hausregeln lernt das aus den letzten Wochen. „Weiter“ richtet es für alle Räume mit Lichtregeln ein.',
        );
      case 'vacuum':
        return this._simpleStep(
          'vacuum',
          `Solange ${this._sug?.vacuums.map((v) => v.name).join(', ') || 'der Saugroboter'} saugt, lösen Bewegungsmelder sonst Licht, „Raum belegt“ oder sogar Alarm aus. Mit der Saugroboter-Pause zählen sie dann nicht (solange er saugt und 2 Minuten danach).`,
        );
      case 'ai':
        return this._simpleStep(
          'ai',
          'Ein Sprachmodell (z. B. Ollama auf deinem Server, Gemini, OpenAI, Claude) prüft Regeln und hilft, Sätze in Regeln zu verwandeln. Wähle Anbieter und Modell:',
          html`<hr-ai-settings .store=${this.store}></hr-ai-settings>`,
        );
      case 'tablet':
        return this._tabletStep();
      case 'diagnostics':
        return html`<p class="intro">Damit roomwise mit möglichst vielen Geräten, Integrationen und Browsern gut funktioniert, kannst du einmal pro Woche anonyme Diagnosedaten senden. Das ist freiwillig und lässt sich jederzeit unter Einstellungen wieder abschalten.</p>
          ${this._yesNo('diagnostics', ['Ja, anonym helfen', 'Nur Anzahlen und Versionen, keine Namen.'], ['Nein, danke', 'Es wird nichts gesendet.'])}
          <hr-telemetry-settings compact .store=${this.store}></hr-telemetry-settings>`;
      case 'done':
        return this._done();
    }
  }

  override render() {
    const steps = this._steps;
    const i = Math.max(0, steps.findIndex((x) => x.id === this._step));
    const meta = steps[i];
    const last = meta.id === 'done';
    // a yes/no step without an answer: "Weiter" = skip
    const unanswered = meta.id === 'diagnostics' && typeof this._ans.diagnostics !== 'boolean';
    return html`<hr-pop heading=${meta.title} .sub=${`Einrichtung · Schritt ${i + 1} von ${steps.length}`} @close=${() => this._close()}>
        <div class="wiz-top" id="top">
          <div class="progress" aria-hidden="true">${steps.map((_s, j) => html`<span class=${j <= i ? 'on' : ''} title=${_s.short}></span>`)}</div>
        </div>
        ${this._body()} ${this._msg && meta.id !== 'tablet' ? html`<p class="err">${this._msg}</p>` : nothing}
        <footer slot="foot" class="wiz-foot">
          ${i > 0 ? html`<button class="btn" ?disabled=${this._busy} @click=${() => this._go(-1, false)}>Zurück</button>` : nothing}
          <span class="spacer"></span>
          ${!last && i > 0 ? html`<button class="btn plain" ?disabled=${this._busy} @click=${() => this._go(1, false)}>Überspringen</button>` : nothing}
          ${last
            ? html`<button class="btn primary" @click=${() => this._finish()}>Fertig</button>`
            : html`<button class="btn primary" ?disabled=${this._busy} @click=${() => this._go(1, !unanswered)}>${i === 0 ? "Los geht's" : this._busy ? 'Speichere …' : 'Weiter'}</button>`}
        </footer>
      </hr-pop>
      ${this._side === 'cal' ? html`<hr-light-cal .store=${this.store} @close=${() => (this._side = '')}></hr-light-cal>` : nothing}
      ${this._side === 'glow' ? html`<hr-light-glow .store=${this.store} @close=${() => (this._side = '')}></hr-light-glow>` : nothing}`;
  }

  /** leave the setup for another page (the heating plans): the progress stays, Einstellungen → Einrichtung goes on */
  private async _detour(tab: string) {
    await this.store.setupSave({ step: this._step, answers: { ...this._ans, dismissed: true } }).catch(() => undefined);
    fire(this, 'hr-tab', tab);
    this.dispatchEvent(new CustomEvent('close'));
  }
}
customElements.define('hr-setup-wizard', HrSetupWizard);
