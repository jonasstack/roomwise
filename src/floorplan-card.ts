import { noteTouch } from './activity';
import { companion, companionInfo, companionKnown, onCompanion, serverKey, syncAlert, syncPets, syncVacuums, walkDoneOnServer } from './entry-server';
import { VacuumController } from './vacuum-controller';
import { HR_MODES, houseRules, roomArea, withHrRooms, type HouseRulesLink, type HrMode, type HrPlacePerson, type HrState } from './house-rules';
import { LitElement, css, html, nothing, type PropertyValues } from 'lit';
import { tokens } from './design/tokens';
import { components } from './design/components';
import type { DeviceConfig, FloorConfig, FloorplanCardConfig, FurnitureConfig, HitTarget, HomeAssistant, OpeningConfig, RoomConfig } from './types';
import { OptimisticStore } from './optimistic';
import { furnitureAction, hasDoubleTap, resolveAction, runAction, type ActionHost, type Gesture } from './actions';
import { areaLights } from './ha';
import { formatClock, formatNumber, onLanguageLoaded, setLanguage, t } from './i18n';
import { CardFullscreen, canElementFullscreen } from './fullscreen';
import { areasConfig, normalizeConfig, stubConfig } from './config';
import { examplePlan } from './example-plan';
import type { VacuumPlanResult } from './vacuum-plan';
import { buildingBounds, floorBounds, pointInPolygon } from './geometry';
import { FpPlan } from './components/fp-plan';
import { FloorplanLayer } from './layer/floorplan-layer';
import './components/fp-plan';
import './components/fp-floor-slider';
import type { SliderFloor } from './components/fp-floor-slider';
import { floorBelow, floorOfEntity, floorOfItem, floorShort, orderedFloors, stairsTarget, floorLevel } from './levels';
import './layer/floorplan-layer';
import './config-editor';
import './components/fp-ambient';
import { effectsLevel, isWeakDevice, skyPalette, sunInfo, weatherIcon, weatherInfo } from './ambient';
import { ENTRY_DEFAULTS, EntryAlertController } from './entry-alert';
import { PetController } from './pets';
import { scheduleClientReport } from './client-info';
import { furnitureContents, furnitureLabel, isWifiContent, isWifiPiece, resolveFurniture, wifiContentTarget } from './furniture';
import { hasMediaControls } from './media-controls';
import { formatState, fireEvent, navigate } from './ha';
import { mergePlan, sharesPlans, watchPlan, type SharedPlan } from './shared-plans';
import { traceHref } from './trace';

declare const __VERSION__: string;

/** An animation has run its course: its `finished` promise, or its duration (the promise can come frames late) */
const done = (a: Animation) =>
  Promise.race([a.finished.then(() => undefined, () => undefined), new Promise<void>((r) => setTimeout(r, Number(a.effect?.getTiming().duration ?? 0) + 40))]);

const MODE_ICON: Record<string, string> = { home: 'mdi:home-outline', away: 'mdi:home-export-outline', sleep: 'mdi:weather-night', vacation: 'mdi:airplane', guests: 'mdi:account-multiple-outline' };
/** How somebody travels ("Wer ist wo", from Hausregeln); '' = on the way, how is not known */
const MOVE_ICON: Record<string, string> = { walk: 'mdi:walk', bike: 'mdi:bike', car: 'mdi:car', transit: 'mdi:train', '': 'mdi:map-marker-path' };

/** Shortest time between two redraws caused by state changes (ms); weak devices draw less often */
const REDRAW_GAP = 150;
const REDRAW_GAP_WEAK = 400;

export class FloorplanCard extends LitElement {
  static override properties = {
    _config: { state: true },
    _floorId: { state: true },
    _viewDefault: { state: true },
    _tick: { state: true },
    _force2d: { state: true },
    _fsOffer: { state: true },
    _size: { state: true },
    _spin: { state: true },
    _spinDefault: { state: true },
    _covered: { state: true },
    _alertTick: { state: true },
    _hr: { state: true },
    _modeMenu: { state: true },
    _peopleMenu: { state: true },
    _tripOpen: { state: true },
    _fsUi: { state: true },
    _now: { state: true },
    _tripNow: { state: true },
    _sliderW: { state: true },
    _tripsInset: { state: true },
    _texts: { state: true },
    _shared: { state: true },
    _planState: { state: true },
    _vacStart: { state: true },
  };
  /** First steps "from the vacuum's map" open (its chooser, loaded on demand); 'card': a new card, 'floor': this floor */
  declare _vacStart?: 'card' | 'floor';
  /** Shared floor plan (companion integration) as last pushed; undefined: none, or not loaded yet */
  declare _shared?: SharedPlan;
  /** A shared plan that cannot be shown (yet): loading, deleted, or no companion that keeps shared plans */
  declare _planState?: 'loading' | 'missing' | 'unavailable';
  private planWatch?: { id: string; off: () => void };
  /** Width of the floor slider (the plan keeps the building clear of it) */
  declare _sliderW: number;
  /** px from the top of the plan to below the "on the way" panel (0 = none shown): the building moves down */
  declare _tripsInset: number;
  /** counts up when the texts of a language arrive (English is loaded on demand): draws the card again */
  declare _texts: number;
  /** Hausregeln: live state (undefined: not installed) */
  declare _hr?: HrState;
  declare _modeMenu: boolean;
  declare _peopleMenu: boolean;
  /** "Wer ist wo": the person on the way whose details are unfolded */
  declare _tripOpen?: string;
  /** full screen mode and whether its exit button shows (re-renders the card when either changes) */
  declare _fsUi?: string;
  declare _now: number;
  /** ticks while somebody is on the way: the minutes to the arrival count down between two positions */
  declare _tripNow: number;
  private tripClock?: number;
  private hrLink?: HouseRulesLink;
  private offHr?: () => void;
  private offHrPulse?: () => void;
  private offClientReport?: () => void;
  private hrClock?: number;

  declare _config?: FloorplanCardConfig;
  declare _floorId?: string;
  declare _viewDefault: boolean;
  declare _tick: number;
  declare _alertTick: number;
  /** Front door warning (open windows) */
  entryAlert = new EntryAlertController(
    (id) => this.getState(id),
    () => {
      this._alertTick = (this._alertTick ?? 0) + 1;
      // a tap anywhere on the tablet acknowledges the alarm
      const on = this.entryAlert.state.phase === 'alarm';
      if (on !== this.alarmListening) {
        this.alarmListening = on;
        if (on) this.followAlert();
        if (on) window.addEventListener('pointerdown', this.onAlarmTap, { capture: true });
        else window.removeEventListener('pointerdown', this.onAlarmTap, { capture: true });
      }
    },
  );
  private alarmListening = false;
  /** Pets: walk schedule and presence */
  pets = new PetController(() => this._tick++);
  private memos = new Map<string, { k: string; v: unknown }>();
  private memo<T>(name: string, v: T): T {
    const k = JSON.stringify(v) ?? '';
    const m = this.memos.get(name);
    if (m && m.k === k) return m.v as T;
    this.memos.set(name, { k, v });
    return v;
  }
  declare _force2d: boolean;
  /** "Full screen" offered for a few seconds after opening the dashboard */
  declare _fsOffer: boolean;
  private fsTimer?: number;
  /** real full screen (or kiosk mode where the browser can't): on demand, remembered on this device until switched off */
  private fs: CardFullscreen = new CardFullscreen(
    this,
    () => this.layer,
    () => (this._fsUi = `${this.fs.mode}:${this.fs.revealed}`),
    () => `fp-fs-${this._config?.card_id ?? 'plan'}`,
  );
  declare _size: { w: number; h: number };
  declare _spin: number;
  declare _spinDefault: boolean;
  /** A popup, sheet or the editor of the layer covers the card */
  declare _covered: boolean;
  private idleTimer?: number;
  private ro?: ResizeObserver;
  private holdTimer?: number;
  private held = false;

  private _hass?: HomeAssistant;
  private _raw?: FloorplanCardConfig;
  /** the normalized configuration as stored (the editor works on this); `_config` adds what Hausregeln assigns */
  private _base?: FloorplanCardConfig;
  private layer?: FloorplanLayer;
  private relevant = new Set<string>();
  readonly optimistic = new OptimisticStore(() => {
    this._tick++;
    this.layer?.requestUpdate();
  });

  constructor() {
    super();
    this._viewDefault = true;
    this._tick = 0;
    this._force2d = false;
    this._fsOffer = false;
    this._size = { w: 0, h: 0 };
    this._spin = 0;
    this._spinDefault = true;
    this._sliderW = 0;
    this._tripsInset = 0;
    this._texts = 0;
  }

  // ---------- Lovelace API ----------

  static getConfigElement() {
    return document.createElement('floorplan-card-editor');
  }

  static getStubConfig(hass: HomeAssistant) {
    // called before the card ever saw hass: pick the language now, so the stub's floor name matches
    setLanguage(hass?.locale?.language ?? hass?.language);
    return stubConfig(hass);
  }

  setConfig(config: FloorplanCardConfig) {
    if (!config || typeof config !== 'object') throw new Error('Invalid configuration');
    const first = !this._config;
    this._raw = config;
    this.applyConfig();
    if (first)
      try {
        this._force2d = localStorage.getItem(`fp-2d-${this._config!.card_id ?? 'plan'}`) === '1';
      } catch {
        /* storage blocked */
      }
    this.followPlan();
  }

  /** The config the card works with: the stored one, with a shared plan's content merged in */
  private applyConfig() {
    const raw = this._raw!;
    const shared = raw.plan && this._shared?.id === raw.plan ? this._shared : undefined;
    this._base = normalizeConfig(shared ? mergePlan(raw, shared.plan) : raw);
    // what Hausregeln assigns to the rooms (lights, thermostat) is shown, the editor works on `_base`
    this._config = withHrRooms(this._base, this._hass);
    if (!this._config.floors.some((f) => f.id === this._floorId)) this._floorId = this.defaultFloorId;
    this.computeRelevant();
    this.layer?.setCardConfig(this._config, this._base);
  }

  /** The last revision of the shared plan this card shows (the editor saves on top of it) */
  get sharedPlan(): SharedPlan | undefined {
    return this._raw?.plan && this._shared?.id === this._raw.plan ? this._shared : undefined;
  }

  // ---------- Shared floor plan ----------

  /** Follow the shared plan this card references (one live subscription per plan, shared by every card) */
  private followPlan() {
    const id = this._raw?.plan;
    const want = id && this._hass && this.isConnected && sharesPlans() ? id : undefined;
    if (this.planWatch?.id === want && (want || !id)) return;
    this.planWatch?.off();
    this.planWatch = undefined;
    if (!id) {
      this._shared = undefined;
      this._planState = undefined;
      return;
    }
    if (this._shared?.id !== id) this._shared = undefined;
    if (!want) {
      if (!this._shared) this._planState = this._hass && companionKnown() ? 'unavailable' : 'loading';
      return;
    }
    if (!this._shared) this._planState = 'loading';
    const off = watchPlan(this._hass!, id, (p) => this.applyShared(p), () => (this._planState = 'unavailable'));
    this.planWatch = { id, off };
  }

  /** The editor just saved the shared plan: show it before the companion's push arrives (setConfig follows) */
  showShared(p: SharedPlan) {
    this._shared = p;
    this._planState = undefined;
  }

  private applyShared(p: SharedPlan) {
    if (p.id !== this._raw?.plan) return;
    if (p.deleted) {
      this._shared = undefined;
      this._planState = 'missing';
    } else {
      if (this._shared && this._shared.rev === p.rev) return;
      this._shared = p;
      this._planState = undefined;
    }
    this.applyConfig();
    this._tick++;
    // the plan's dogs, vacuums and front door warning may have changed
    if (this._hass && companionInfo() && this._config) {
      void syncPets(this._hass, this._config);
      void syncAlert(this._hass, this._config, !!this.hrLink?.windowWarningOn);
      void syncVacuums(this._hass, this._config);
      this.pets.watchServer(this._hass, serverKey(this._config), true);
      this.vacuums.watch(this._hass, this._config, true);
    }
  }

  /** A shared plan that has nothing to show yet (an embedded copy, if there is one, shows meanwhile) */
  private get planBlocked(): boolean {
    return !!this._raw?.plan && !this.sharedPlan && !this._raw.floors?.length;
  }

  getCardSize() {
    return 8;
  }

  getGridOptions() {
    return { columns: 'full', rows: 8, min_rows: 4 };
  }

  /** The config exactly as stored in the dashboard (used to find this card when saving). */
  get rawConfig() {
    return this._raw;
  }

  set hass(hass: HomeAssistant) {
    const old = this._hass;
    this._hass = hass;
    setLanguage(hass.locale?.language ?? hass.language);
    this.applyTheme();
    const dropped = this.optimistic.reconcile(hass);
    if (this.layer) this.layer.hass = hass;
    // a tap's confirmed state shows right away; other changes of plan entities are coalesced (a busy sensor
    // must not redraw the plan dozens of times a second on a wall tablet)
    if (!old || dropped) this.redraw();
    else if (this.relevantChanged(old, hass)) this.redrawSoon();
    if (this._config) this.entryAlert.update(hass, this._config);
    // companion integration (server side): asked once per connection
    if (!old || old.connection !== hass.connection) void companion(hass).then(() => this.syncCompanion());
    // Hausregeln (optional): one shared live subscription per connection
    if (!old || old.connection !== hass.connection) this.watchHouseRules(hass);
    else this.hrLink && houseRules(hass);
  }

  /** Hausregeln' Fenster-Warnung beim Gehen is on: the card shows that one (a tap acknowledges it there); its own
   *  warning and the companion's stand aside. Off again: the card's own warning is back (fallback). */
  private hrWarning?: boolean;
  private followHrWarning(link: HouseRulesLink) {
    const on = link.windowWarningOn;
    const w = link.state.windowWarning;
    this.entryAlert.setHr(
      on
        ? {
            st: w ? { active: w.active, phase: w.phase, windows: w.windows ?? [], deadline: w.deadline ? w.deadline * 1000 : null, spoken: !!w.spoken } : null,
            ack: () => void link.ackWindowWarning().catch(() => this.ensureLayer().toast(t('card.action_failed'))),
          }
        : null,
    );
    if (on === this.hrWarning) return;
    this.hrWarning = on;
    // an admin's card takes its warning back from the companion (or hands it over again)
    if (this._hass && this._config && companionInfo()) void syncAlert(this._hass, this._config, on);
  }

  /** Hausregeln assigns lights and thermostats to the rooms: the plan shows those (one source, see hrRoom) */
  private hrRoomsVersion = -1;
  private followHrRooms() {
    const v = this.hrLink?.roomsVersion ?? -1;
    if (v === this.hrRoomsVersion || !this._base) return;
    this.hrRoomsVersion = v;
    const next = withHrRooms(this._base, this._hass);
    if (next === this._config) return;
    this._config = next;
    this.computeRelevant();
    this.layer?.setCardConfig(this._config, this._base);
    this.requestUpdate();
  }

  /** Hausregeln: occupancy, mode, alarm (live) and pulses when a rule runs; nothing at all without it */
  private watchHouseRules(hass: HomeAssistant) {
    this.offHr?.();
    this.offHrPulse?.();
    this.entryAlert.setHr(null);
    this.hrWarning = undefined;
    const link = houseRules(hass);
    void link.start().then((ok) => {
      if (!ok) return;
      this.offHr?.();
      this.offHrPulse?.();
      this.hrLink = link;
      this.offHr = link.listen((s) => {
        this._hr = s;
        this.followHrRooms();
        this.followAlarmClock();
        this.followHrWarning(link);
      });
      // only a real alarm marks the devices that caused it (red); rules that switched something show no rings —
      // the devices' own state (a lamp lighting up) is the feedback
      this.offHrPulse = link.onPulse((ents, kind) => {
        if (kind !== 'alarm' || this._config?.house_rules?.pulse === false) return;
        (this.renderRoot?.querySelector('fp-plan') as FpPlan | null)?.pulseEntities(ents, '#ff3b30');
      });
      // anonymous diagnostics (only counted when the owner opted in): browser and 3D tier, once a day
      this.offClientReport?.();
      this.offClientReport = scheduleClientReport(
        () => {
          const plan = this.renderRoot?.querySelector('fp-plan') as FpPlan | null;
          if (!plan) return null;
          return { frameMs: plan.glScene?.lastFrameMs ?? 0, view: plan.is3d ? '3d' : '2d', profile: this.userDefaults.performance };
        },
        (info) => link.reportClient(info),
      );
    });
  }

  /** While the alarm counts down: tick once a second for the shield */
  private followAlarmClock() {
    const st = this._hr?.alarm?.state;
    const counting = !!this._hr?.alarm?.until && (st === 'arming' || st === 'pending' || st === 'triggered');
    if (counting && !this.hrClock) this.hrClock = window.setInterval(() => (this._now = Date.now()), 1000);
    else if (!counting && this.hrClock) {
      clearInterval(this.hrClock);
      this.hrClock = undefined;
    }
  }

  /** Plan rooms somebody is in (Hausregeln occupancy of the room's area) */
  private hrOccupied(floor: FloorConfig | undefined): Set<string> | undefined {
    const occ = this._hr?.occupancy;
    // occupied rooms are only tinted when switched on in the card settings (off by default)
    if (!occ || !floor || this._config?.house_rules?.occupancy !== true) return undefined;
    const ids = floor.rooms
      .filter((r) => {
        const a = this._hass && roomArea(r, this._hass);
        return !!a && occ[a]?.occupied;
      })
      .map((r) => r.id);
    const key = ids.join(',');
    if (key !== this.hrOccKey) {
      this.hrOccKey = key;
      this.hrOccSet = ids.length ? new Set(ids) : undefined;
    }
    return this.hrOccSet;
  }
  private hrOccKey = '';
  private hrOccSet?: Set<string>;

  /** Hausregeln in the card's head: the alarm (only when not off) and the house mode */
  private renderHouseRules() {
    const hr = this._hr;
    const cfg = this._config;
    if (!hr || !cfg) return nothing;
    const out = [];
    const al = hr.alarm;
    if (cfg.house_rules?.alarm !== false && al && al.state && al.state !== 'disarmed') {
      const left = al.until ? Math.max(0, Math.round(al.until - (this._now || Date.now()) / 1000)) : undefined;
      const clock = left != null && (al.state === 'arming' || al.state === 'pending' || al.state === 'triggered') ? ` · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : '';
      const cls = al.state === 'triggered' ? 'alarm' : al.state === 'pending' ? 'pending' : al.state === 'arming' ? 'arming' : 'armed';
      const text = al.state === 'triggered' ? t('hr.alarm') : al.state === 'pending' ? t('hr.pending') : al.state === 'arming' ? t('hr.arming') : (al.label ?? t('hr.armed'));
      out.push(html`<button class="hr-chip shield ${cls} pressable" title=${t('hr.alarm_center')} @click=${() => this.navigate('/hausregeln/alarm')}>
        <ha-icon .icon=${cls === 'armed' ? 'mdi:shield-check' : cls === 'arming' ? 'mdi:shield-sync-outline' : 'mdi:shield-alert'}></ha-icon>
        <span>${text}${clock}</span>
      </button>`);
    }
    if (cfg.house_rules?.mode !== false && hr.mode) {
      out.push(html`<div class="hr-mode">
        <button
          class="hr-chip mode-chip pressable"
          aria-haspopup="menu"
          aria-expanded=${this._modeMenu ? 'true' : 'false'}
          aria-label=${t('hr.mode_is', { mode: t(`hr.mode_${hr.mode}` as never) })}
          title=${t('hr.mode_is', { mode: t(`hr.mode_${hr.mode}` as never) })}
          @click=${() => (this._modeMenu = !this._modeMenu)}
        >
          <ha-icon .icon=${MODE_ICON[hr.mode] ?? 'mdi:home'}></ha-icon>
        </button>
        ${this._modeMenu
          ? html`<div class="hr-scrim" @click=${() => (this._modeMenu = false)}></div>
              <div class="hr-menu modes" role="menu" aria-label=${t('hr.mode')}>
                ${HR_MODES.map(
                  (m) => html`<button
                    class="hr-item pressable ${m === hr.mode ? 'on' : ''}"
                    role="menuitemradio"
                    aria-checked=${m === hr.mode ? 'true' : 'false'}
                    aria-label=${t(`hr.mode_${m}` as never)}
                    title=${t(`hr.mode_${m}` as never)}
                    @click=${() => this.setMode(m)}
                  >
                    <ha-icon .icon=${MODE_ICON[m]}></ha-icon>
                  </button>`,
                )}
              </div>`
          : nothing}
      </div>`);
    }
    return out;
  }

  /** "Wer ist wo": avatars of the persons (green ring = home); a tap lists where everybody is.
   * With Hausregeln its status lines ("Unterwegs · wahrscheinlich nach Hause · ca. 12 Min."), else the zone from HA. */
  private renderPeople() {
    const hass = this._hass;
    if (!hass || this._config?.people !== true) return nothing;
    const fromHr = this._hr?.places?.persons;
    const people = fromHr?.length
      ? fromHr.map((p) => ({ id: p.entity_id, name: p.name, picture: p.picture ?? undefined, home: p.state === 'zone' && p.place === 'home', moving: p.state === 'moving', line: p.line }))
      : Object.values(hass.states)
          .filter((s) => s.entity_id.startsWith('person.') && s.state !== 'unknown' && s.state !== 'unavailable')
          .map((s) => ({
            id: s.entity_id,
            name: String(s.attributes.friendly_name ?? s.entity_id).split(' ')[0],
            picture: s.attributes.entity_picture as string | undefined,
            home: s.state === 'home',
            moving: false,
            line: s.state === 'home' ? t('people.home') : s.state === 'not_home' ? t('people.away') : s.state,
          }));
    if (!people.length) return nothing;
    // on the way (only Hausregeln knows): pulled out of the group, with how and where to in a small panel below
    const trips = (fromHr ?? []).filter((p) => p.state === 'moving');
    // somebody on the way: count the minutes down between two positions (they keep going)
    if (trips.length && !this.tripClock) this.tripClock = window.setInterval(() => (this._tripNow = Date.now()), 20000);
    else if (!trips.length && this.tripClock) {
      clearInterval(this.tripClock);
      this.tripClock = undefined;
    }
    const tripIds = new Set(trips.map((p) => p.entity_id));
    const staying = people.filter((p) => !tripIds.has(p.id));
    const travelling = people.filter((p) => tripIds.has(p.id));
    const avatar = (p: (typeof people)[number]) =>
      html`<span class="pp-av ${p.home ? 'home' : p.moving ? 'moving' : ''}" style=${p.picture ? `background-image:url("${p.picture}")` : ''}>${p.picture ? '' : p.name.slice(0, 1)}</span>`;
    return html`<div class="hr-mode">
      <button class="hr-chip people pressable" aria-haspopup="menu" aria-expanded=${this._peopleMenu ? 'true' : 'false'} title=${t('people.title')} @click=${() => (this._peopleMenu = !this._peopleMenu)}>
        ${staying.length ? html`<span class="pp-stack">${staying.slice(0, 4).map(avatar)}</span>` : nothing}
        ${travelling.length
          ? html`${staying.length ? html`<span class="pp-sep"></span>` : nothing}<span class="pp-stack pp-away">${travelling.slice(0, 3).map(
              (p) => html`<span class="pp-trip">${avatar(p)}<ha-icon class="pp-mode" .icon=${MOVE_ICON[trips.find((x) => x.entity_id === p.id)?.mode ?? ''] ?? MOVE_ICON['']}></ha-icon></span>`,
            )}</span>`
          : nothing}
      </button>
      ${this._peopleMenu
        ? html`<div class="hr-scrim" @click=${() => (this._peopleMenu = false)}></div>
            <div class="hr-menu people" role="menu">
              ${people.map((p) => html`<button class="hr-item pressable" role="menuitem" @click=${() => { this._peopleMenu = false; fireEvent(this, 'hass-more-info', { entityId: p.id }); }}>${avatar(p)}<span class="pp-text"><b>${p.name}</b><small>${p.line}</small></span></button>`)}
            </div>`
        : trips.length
          ? this.renderTrips(trips)
          : nothing}
    </div>`;
  }

  /** The panel below "Wer ist wo" while somebody is on the way: how, where to, how long; a tap shows more. */
  private renderTrips(trips: HrPlacePerson[]) {
    const clock = (iso?: string | null) => (iso ? formatClock(new Date(iso)) : '');
    return html`<div class="pp-trips">
      ${trips.map((p) => {
        const pr = p.prediction && (p.prediction.probability ?? 0) >= 0.5 ? p.prediction : null;
        const home = pr?.destination === 'home';
        const dest = pr ? (home ? t('people.to_home') : t('people.to_place', { place: pr.name ?? '' })) : t('people.on_way');
        // minutes left now: from the arrival estimated at the last position, counting down until the next one
        const now = this._tripNow || Date.now();
        const left = pr?.arrive_at ? Math.ceil((pr.arrive_at * 1000 - Math.max(now, Date.now())) / 60000) : pr?.eta_min ?? null;
        const eta = left == null ? '' : left <= 0 ? t('people.eta_soon') : t('people.eta_min', { n: left });
        const open = this._tripOpen === p.entity_id;
        const rows: [string, string][] = [];
        if (pr) rows.push([t('people.d_dest'), home ? t('people.home') : (pr.name ?? '')]);
        if (pr?.arrive_at) rows.push([t('people.d_arrive'), t('people.at_clock', { time: formatClock(new Date(pr.arrive_at * 1000)) })]);
        else if (pr?.eta_min != null) rows.push([t('people.d_arrive'), t('people.at_clock', { time: formatClock(new Date(Date.now() + pr.eta_min * 60000)) })]);
        if (pr?.distance_km != null) rows.push([t('people.d_left'), `${formatNumber(pr.distance_km, pr.distance_km < 10 ? 1 : 0)} km`]);
        if (p.since) rows.push([t('people.d_since'), clock(p.since)]);
        if (p.speed_kmh != null) rows.push([t('people.d_speed'), `${formatNumber(p.speed_kmh, 0)} km/h`]);
        if (p.mode) rows.push([t('people.d_mode'), t(`people.mode_${p.mode}` as never)]);
        if (p.updated) rows.push([t('people.d_updated'), clock(p.updated)]);
        return html`<div class="pp-row ${open ? 'open' : ''}">
          <button class="pp-line pressable" aria-expanded=${open ? 'true' : 'false'} @click=${() => (this._tripOpen = open ? undefined : p.entity_id)}>
            <ha-icon .icon=${MOVE_ICON[p.mode ?? ''] ?? MOVE_ICON['']} title=${p.mode ? t(`people.mode_${p.mode}` as never) : t('people.on_way')}></ha-icon>
            <span class="pp-what"><b>${p.name}</b> <span>${dest}</span></span>
            ${eta ? html`<span class="pp-eta">${eta}</span>` : nothing}
          </button>
          ${open
            ? html`<dl class="pp-more">
                ${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}
              </dl>`
            : nothing}
        </div>`;
      })}
    </div>`;
  }

  private setMode(m: HrMode) {
    this._modeMenu = false;
    this.hrLink?.setMode(m).catch(() => this.ensureLayer().toast(t('card.action_failed')));
  }

  /** In-app navigation (Home Assistant's router) */
  private navigate(path: string) {
    history.pushState(null, '', path);
    window.dispatchEvent(new CustomEvent('location-changed', { detail: { replace: false } }));
  }

  /** Follow the companion integration: shared walk check-offs */
  private syncCompanion() {
    if (!this._hass || !this.isConnected) return;
    this.followPlan();
    this.pets.watchServer(this._hass, serverKey(this._config), !!companionInfo());
    // without the companion the card decides about the walks itself (with it: the server's first push)
    if (companionKnown() && !companionInfo()) this.pets.decide(false);
    this.vacuums.watch(this._hass, this._config, !!companionInfo());
    // an admin's card keeps the server's copy of the dogs current (walk times, reminders)
    if (companionInfo() && this._config) {
      void syncPets(this._hass, this._config);
      // the front door warning runs on the server by default (unless Hausregeln runs it)
      void syncAlert(this._hass, this._config, !!this.hrLink?.windowWarningOn);
      void syncVacuums(this._hass, this._config);
    }
    this._tick++;
  }
  private offCompanion?: () => void;
  /** live vacuums: positions straight to the 3D scene */
  private vacuums = new VacuumController(() => (this.renderRoot?.querySelector('fp-plan') as FpPlan | null)?.glScene ?? undefined);

  override updated(changed: Map<string, unknown>) {
    super.updated?.(changed);
    // the scene may just have (re)built a vacuum: give it the latest position
    this.vacuums.pump(this._hass);
    this.measureTrips();
  }

  private offLang?: () => void;
  /** the texts of the language just arrived: the card, the plan and every open popup draw again */
  private redrawTexts() {
    this._texts++;
    const walk = (root: ParentNode | null | undefined) => {
      for (const el of root?.querySelectorAll('*') ?? []) {
        (el as { requestUpdate?: () => void }).requestUpdate?.();
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(this.renderRoot);
    this.layer?.requestUpdate();
    walk(this.layer?.shadowRoot);
  }

  /** The "on the way" panel lies over the top of the plan: the building moves down below it (only as far as needed). */
  private measureTrips() {
    const panel = this.renderRoot.querySelector('.pp-trips');
    const plan = this.renderRoot.querySelector('fp-plan');
    let inset = 0;
    if (panel && plan) {
      inset = Math.max(0, Math.round(panel.getBoundingClientRect().bottom - plan.getBoundingClientRect().top + 8));
      if (!this.tripsObserver) {
        // the panel grows when a trip is opened: measure again
        this.tripsObserver = new ResizeObserver(() => this.measureTrips());
      }
      this.tripsObserver.disconnect();
      this.tripsObserver.observe(panel);
    } else this.tripsObserver?.disconnect();
    if (Math.abs(inset - this._tripsInset) > 1) this._tripsInset = inset;
  }
  private tripsObserver?: ResizeObserver;

  get hass(): HomeAssistant {
    return this._hass!;
  }

  // ---------- Lifecycle ----------

  override connectedCallback() {
    super.connectedCallback();
    // back on the page (or hass came before it was): follow Hausregeln again
    if (this._hass && !this.offHr) this.watchHouseRules(this._hass);
    this.pets.start();
    this.offCompanion = onCompanion(() => this.syncCompanion());
    this.fs.connect();
    // English comes on demand (not in the start bundle): draw everything again once it is there
    this.offLang = onLanguageLoaded(() => this.redrawTexts());
    // full screen was on (reload, restart, view rebuilt): back to it
    this.fs.restore();
    // just opened: full screen is offered for 5 s (only where the browser can do it, and not when it already is or comes back)
    const d = document as Document & { webkitFullscreenElement?: Element };
    if (!this.fs.wanted && canElementFullscreen(this) && !(d.fullscreenElement || d.webkitFullscreenElement)) {
      this._fsOffer = true;
      clearTimeout(this.fsTimer);
      this.fsTimer = window.setTimeout(() => (this._fsOffer = false), 5000);
    }
    if (this._hass) this.syncCompanion();
    this.applyTheme();
    this.ro = new ResizeObserver(() => {
      const r = this.getBoundingClientRect();
      if (Math.abs(r.width - this._size.w) > 1 || Math.abs(r.height - this._size.h) > 1) this._size = { w: r.width, h: r.height };
    });
    this.ro.observe(this);
    this.addEventListener('pointerdown', this.onActivity, { capture: true });
    this.addEventListener('wheel', this.onActivity, { capture: true, passive: true });
    // touch counts as activity also where a browser sends no pointer events for it
    this.addEventListener('touchstart', this.onActivity, { capture: true, passive: true });
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.pets.stop();
    this.vacuums.stop();
    this.offHr?.();
    this.offHrPulse?.();
    this.offHr = this.offHrPulse = undefined;
    this.offClientReport?.();
    this.offClientReport = undefined;
    clearInterval(this.hrClock);
    this.hrClock = undefined;
    clearInterval(this.tripClock);
    this.tripClock = undefined;
    this.offCompanion?.();
    this.offLang?.();
    this.offLang = undefined;
    this.planWatch?.off();
    this.planWatch = undefined;
    this.ro?.disconnect();
    clearTimeout(this.idleTimer);
    clearTimeout(this.redrawTimer);
    this.redrawTimer = undefined;
    this.removeEventListener('pointerdown', this.onActivity, { capture: true });
    this.removeEventListener('wheel', this.onActivity, { capture: true });
    this.removeEventListener('touchstart', this.onActivity, { capture: true });
    // out of full screen / kiosk first: the layer goes back to document.body before it is detached
    this.fs.disconnect();
    this.layer?.detach(this);
    this.layer = undefined;
    this.entryAlert.destroy();
    window.removeEventListener('pointerdown', this.onAlarmTap, { capture: true });
    this.alarmListening = false;
  }

  private applyTheme() {
    const mode = this._config?.theme ?? 'auto';
    const dark = mode === 'dark' || (mode === 'auto' && !!this._hass?.themes?.darkMode);
    this.toggleAttribute('dark', dark);
    if (this.layer) this.layer.dark = dark;
  }

  private computeRelevant() {
    const ids = new Set<string>();
    for (const f of this._config?.floors ?? []) {
      for (const r of f.rooms) {
        (r.lights ?? []).forEach((id) => ids.add(id));
        [r.temperature, r.humidity, r.climate].forEach((id) => id && ids.add(id));
        (r.sensors ?? []).forEach((s) => ids.add(s.entity));
      }
      for (const d of f.devices) ids.add(d.entity);
      for (const o of f.openings ?? []) if (o.entity) ids.add(o.entity);
      // pieces show their entity's state too (lamp, fan, TV, car battery, a dog's presence …)
      for (const p of f.furniture ?? []) {
        if (p.entity) ids.add(p.entity);
        for (const id of Object.values(p.entities ?? {})) if (id) ids.add(id);
      }
    }
    ids.add(this._config?.sun ?? 'sun.sun');
    if (this._config?.weather) ids.add(this._config.weather);
    this.relevant = ids;
  }

  private redrawAt = 0;
  private redrawTimer?: number;
  private redraw() {
    clearTimeout(this.redrawTimer);
    this.redrawTimer = undefined;
    this.redrawAt = performance.now();
    this._tick++;
  }
  /** At most one redraw per REDRAW_GAP for state changes: the first right away, later ones gathered */
  private redrawSoon() {
    if (this.redrawTimer) return;
    const wait = (isWeakDevice() ? REDRAW_GAP_WEAK : REDRAW_GAP) - (performance.now() - this.redrawAt);
    if (wait <= 0) this.redraw();
    else this.redrawTimer = window.setTimeout(() => this.redraw(), wait);
  }

  private autoWeather?: { ents: unknown; id?: string };
  private relevantChanged(old: HomeAssistant, hass: HomeAssistant) {
    if (old.themes?.darkMode !== hass.themes?.darkMode || old.entities !== hass.entities) return true;
    if (!this._config?.weather) {
      // the first weather entity, looked up again only when the registry changes (not on every state change)
      const w = this.autoWeather;
      if (w?.ents !== hass.entities || (w.id && !hass.states[w.id])) this.autoWeather = { ents: hass.entities, id: Object.keys(hass.states).find((id) => id.startsWith('weather.')) };
      const id = this.autoWeather!.id;
      if (id && old.states[id] !== hass.states[id]) return true;
    }
    for (const id of this.relevant) if (old.states[id] !== hass.states[id]) return true;
    // Rooms without explicit lights use area lights.
    for (const f of this._config?.floors ?? [])
      for (const r of f.rooms)
        if (!r.lights && r.area) for (const id of areaLights(hass, r.area, r.exclude)) if (old.states[id] !== hass.states[id]) return true;
    return false;
  }

  // ---------- Default view per user, return after inactivity ----------

  /** Defaults for the signed-in HA user (falls back to the card defaults). */
  private get userDefaults(): { orientation: number; view_mode?: 'auto' | '2d' | '3d'; weather: 'smooth' | 'saver'; performance: 'high' | 'eco'; floor?: string } {
    const u = this._hass?.user?.id ? this._config?.users?.[this._hass.user.id] : undefined;
    return {
      floor: u?.floor ?? this._config?.default_floor,
      orientation: u?.orientation ?? this._config?.orientation ?? 0,
      view_mode: u?.view_mode ?? this._config?.view_mode,
      weather: u?.weather ?? this._config?.weather_quality ?? 'smooth',
      performance: u?.performance ?? this._config?.performance ?? 'high',
    };
  }

  private onActivity = () => {
    noteTouch();
    // decorative life that rested on the unattended tablet picks up again
    (this.renderRoot.querySelector('fp-plan') as FpPlan | null)?.glScene?.requestRender();
    clearTimeout(this.idleTimer);
    const secs = this._config?.idle_reset ?? 120;
    if (secs > 0) this.idleTimer = window.setTimeout(() => this.returnToDefault(true), secs * 1000);
  };

  /** Full screen on / off: the card (with its popups) alone on the screen, else HA's sidebar and header hidden */
  private toggleFullscreen = () => {
    this._fsOffer = false;
    clearTimeout(this.fsTimer);
    this.fs.toggle();
  };

  /** 2D / 3D by hand: remembered on this device */
  private setForce2d(on: boolean) {
    this._force2d = on;
    try {
      localStorage.setItem(`fp-2d-${this._config?.card_id ?? 'plan'}`, on ? '1' : '0');
    } catch {
      /* storage blocked */
    }
  }

  /** Back to the user's default view (rotation, zoom) — after the idle time also to the default floor */
  returnToDefault(idle = false) {
    const plan = this.renderRoot.querySelector('fp-plan') as FpPlan | null;
    // the 2D/3D choice stays as it was set by hand
    plan?.resetView();
    plan?.resetSpin();
    if (idle && this.defaultFloorId && this.defaultFloorId !== this._floorId) void this.goFloor(this.defaultFloorId);
  }

  // ---------- Floors ----------

  /** The floor the card starts on: the user's, the card's, else the first */
  private get defaultFloorId(): string | undefined {
    const floors = this._config?.floors ?? [];
    const want = this.userDefaults.floor;
    return floors.find((f) => f.id === want)?.id ?? floors[0]?.id;
  }

  private floorAnim = 0;
  private previewOn = false;

  /** The slider moves: the plan follows a little (building drifts up / down, fades a touch) — transform only */
  private onFloorPreview = (e: CustomEvent) => {
    if (this.floorAnim) return;
    const plan = this.renderRoot.querySelector('fp-plan') as FpPlan | null;
    if (!plan) return;
    const off = Math.max(-1, Math.min(1, e.detail.offset as number));
    if (Math.abs(off) < 0.002) {
      if (this.previewOn) {
        plan.style.transform = '';
        plan.style.opacity = '';
        this.previewOn = false;
      }
      return;
    }
    this.previewOn = true;
    // offset < 0: towards an upper floor → the building sinks
    const dist = this.floorDistance(plan) * 0.32;
    plan.style.transform = `translate3d(0, ${(-off * dist).toFixed(1)}px, 0)`;
    plan.style.opacity = (1 - Math.abs(off) * 0.28).toFixed(3);
  };

  /** How far the building travels when the floor changes (px): further in 3D, a short slide in 2D */
  private floorDistance(plan: FpPlan) {
    const h = plan.getBoundingClientRect().height || this._size.h || 600;
    return h * (plan.is3d ? 0.26 : 0.08);
  }

  /**
   * Go to another floor. Going up, the shown floor sinks away and the new one comes down from above (down: the
   * other way round); in 2D only a short slide with a cross-fade. The new floor fades in once it is really drawn.
   * Short WAAPI animations of the plan element (transform + opacity): nothing keeps running afterwards.
   */
  async goFloor(id: string) {
    const cfg = this._config;
    const from = this.floor;
    const to = cfg?.floors.find((f) => f.id === id);
    if (!cfg || !to || to.id === this._floorId) return;
    const plan = this.renderRoot.querySelector('fp-plan') as FpPlan | null;
    const token = ++this.floorAnim;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!plan || !from || !plan.animate) {
      this._floorId = id;
      this.floorAnim = 0;
      return;
    }
    const up = floorLevel(cfg, to, this._hass) > floorLevel(cfg, from, this._hass);
    const d3 = plan.is3d;
    const dist = reduce ? 0 : this.floorDistance(plan);
    const sign = up ? 1 : -1;
    const fromT = plan.style.transform || 'translate3d(0, 0, 0)';
    const fromO = plan.style.opacity || '1';
    plan.style.transform = '';
    plan.style.opacity = '';
    this.previewOn = false;
    plan.getAnimations().forEach((a) => a.cancel());
    const out = plan.animate(
      [
        { transform: fromT, opacity: fromO },
        { transform: `translate3d(0, ${sign * dist}px, 0) scale(${d3 && !reduce ? 0.965 : 1})`, opacity: 0 },
      ],
      { duration: reduce ? 120 : d3 ? 170 : 130, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' },
    );
    await done(out);
    if (token !== this.floorAnim) return;
    this._floorId = id;
    await this.updateComplete;
    await plan.floorReady();
    if (token !== this.floorAnim) return;
    const inn = plan.animate(
      [
        { transform: `translate3d(0, ${-sign * dist}px, 0) scale(${d3 && !reduce ? 1.03 : 1})`, opacity: 0 },
        { transform: 'translate3d(0, 0, 0) scale(1)', opacity: 1 },
      ],
      { duration: reduce ? 160 : d3 ? 300 : 220, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'forwards' },
    );
    out.cancel();
    await done(inn);
    if (token !== this.floorAnim) return;
    inn.cancel();
    this.floorAnim = 0;
  }

  /** Show a room wherever it is: switches to its floor first, then zooms onto it */
  async showRoom(roomId: string) {
    const f = this._config && floorOfItem(this._config, roomId);
    if (!f) return;
    if (f.id !== this._floorId) await this.goFloor(f.id);
    (this.renderRoot.querySelector('fp-plan') as FpPlan | null)?.focusRoom(roomId);
  }

  /** Show the floor an entity is on (marker, piece, door / window, room light …) */
  async showEntity(entity: string) {
    const f = this._config && floorOfEntity(this._config, entity);
    if (f && f.id !== this._floorId) await this.goFloor(f.id);
  }

  // ---------- Layer (popups, editor) ----------

  /** The layer opened or closed its last dialog: animations under it rest meanwhile (smooth scrolling on tablets) */
  setCovered(on: boolean) {
    if (this._covered !== on) this._covered = on;
  }

  private ensureLayer(): FloorplanLayer {
    if (!this.layer) {
      this.layer = FloorplanLayer.attach(this);
      this.layer.hass = this._hass!;
      this.layer.dark = this.hasAttribute('dark');
      this.layer.setCardConfig(this._config!, this._base);
      this.fs.adopt(this.layer);
    }
    return this.layer;
  }

  get actionHost(): ActionHost {
    return {
      hass: this._hass!,
      node: this,
      optimistic: this.optimistic,
      openPopup: (target) => this.ensureLayer().openPopup(target),
      confirm: (text) => this.ensureLayer().confirm(text),
      confirmOpen: (req) => this.ensureLayer().confirmOpen(req),
      toast: (text) => this.ensureLayer().toast(text),
      roomLights: (room) => room.lights ?? areaLights(this._hass!, room.area, room.exclude),
      focusRoom: (room, device) => {
        const plan = this.renderRoot.querySelector('fp-plan') as FpPlan | null;
        const target = room ?? (device ? this.floor?.rooms.find((r) => r.points.length >= 3 && pointInPolygon([device.x, device.y], r.points)) : undefined);
        // a room of another floor (e.g. from a popup): go there first
        if (target && !this.floor?.rooms.some((r) => r.id === target.id)) void this.showRoom(target.id);
        else if (target) plan?.focusRoom(target.id);
      },
    };
  }

  getState = (id: string) => this.optimistic.get(this._hass!, id);

  // ---------- Gestures ----------

  private get floor(): FloorConfig | undefined {
    return this._config?.floors.find((f) => f.id === this._floorId) ?? this._config?.floors[0];
  }

  private item(target: HitTarget): { room?: RoomConfig; device?: DeviceConfig; opening?: OpeningConfig } {
    const f = this.floor;
    if (!f || !target.id) return {};
    if (target.kind === 'room') return { room: f.rooms.find((r) => r.id === target.id) };
    if (target.kind === 'device') return { device: f.devices.find((d) => d.id === target.id) };
    if (target.kind === 'opening') return { opening: f.openings?.find((o) => o.id === target.id) };
    if (target.kind === 'furniture') {
      // A piece linked to an entity acts like a device placed at its position
      const p = f.furniture?.find((x) => x.id === target.id);
      if (p?.entity)
        return {
          device: { id: p.id, entity: p.entity, x: p.x, y: p.y, name: p.name, tap_action: p.tap_action, double_tap_action: p.double_tap_action, hold_action: p.hold_action, media: p.media },
        };
    }
    return {};
  }

  /** Tap on a dog / cat: check off the walk that is due, or tell the next one; hold: its presence entity */
  private petGesture(f: FurnitureConfig, gesture: Gesture) {
    const st = this.pets.states.get(f.id);
    const cat = resolveFurniture(f).k?.kind === 'cat';
    const name = f.name || t(cat ? 'pet.cat' : 'pet.dog');
    if (gesture === 'hold') {
      if (f.entity) runAction(this.actionHost, { action: 'more-info', entity: f.entity }, {});
      return;
    }
    if (gesture !== 'tap') return;
    if (st?.mode === 'due' && st.slot) {
      this.pets.markDone(f.id, st.slot);
      // shared with every device (companion integration)
      if (this._hass && companionInfo()) walkDoneOnServer(this._hass, serverKey(this._config), f.id, st.slot);
      this.actionHost.toast(t('pet.done', { t: st.slot }));
      return;
    }
    if (cat || !f.pet?.walks?.length) {
      this.actionHost.toast(st?.mode === 'away' ? t(cat ? 'pet.cat_out' : 'pet.out', { name }) : f.pet?.walks?.length || cat ? t('pet.home', { name }) : t('pet.no_walks'));
      return;
    }
    this.actionHost.toast(st?.next ? t('pet.next', { t: st.next }) : t('pet.all_done'));
  }

  private gesture(target: HitTarget, gesture: Gesture): void {
    if (target.kind === 'furniture') {
      const f = this.floor?.furniture?.find((x) => x.id === target.id);
      if (f && resolveFurniture(f).role === 'pet') return this.petGesture(f, gesture);
      // stairs: up (or down) to the floor they lead to
      if (f && !f.entity && resolveFurniture(f).k?.kind === 'stairs') {
        const to = this._config && stairsTarget(this._config, this._floorId, f, this._hass);
        if (gesture === 'tap' && to) void this.goFloor(to.id);
        return;
      }
      // router / access point: the Wi-Fi QR codes (unless the admin set an own tap action)
      if (f && isWifiPiece(f) && !f.tap_action) {
        if (gesture === 'tap') this.actionHost.openPopup({ wifi: f });
        else if (gesture === 'hold' && f.entity) runAction(this.actionHost, { action: 'more-info', entity: f.entity }, {});
        return;
      }
      // car: its own overview (battery, charging, pre-climatisation, locks, tyres …)
      if (f && resolveFurniture(f).role === 'car' && (f.entity || f.entities)) {
        if (gesture === 'tap') this.actionHost.openPopup({ car: f });
        else if (gesture === 'hold' && f.entity) runAction(this.actionHost, { action: 'more-info', entity: f.entity }, {});
        return;
      }
    }
    // room label: opens the room's heating when the admin set it up, otherwise it acts like the room
    if (target.kind === 'label') {
      const room = this.floor?.rooms.find((r) => r.id === target.id);
      if (gesture === 'tap' && (this._config?.label_tap === 'heating' || this._config?.label_style === 'wall') && room?.climate) {
        runAction(this.actionHost, { action: 'popup', entity: room.climate }, { room });
        return;
      }
      return this.gesture({ kind: 'room', id: target.id }, gesture);
    }
    // a piece holding several devices (cabinet, shelf …): a tap lists them, each opens its own popup
    if (target.kind === 'furniture') {
      const f = this.floor?.furniture?.find((x) => x.id === target.id);
      const inside = f ? furnitureContents(f) : [];
      if (f && inside.length) {
        // only the Wi-Fi QR codes inside (a router Home Assistant does not know): straight to them
        if (gesture === 'tap') this.actionHost.openPopup(inside.length === 1 && isWifiContent(inside[0]) ? { wifi: wifiContentTarget(f) } : { piece: f });
        else if (gesture === 'hold' && f.entity) runAction(this.actionHost, { action: 'more-info', entity: f.entity }, {});
        return;
      }
    }
    // a media piece without an entity (a pure infrared device): a tap opens its own buttons
    if (target.kind === 'furniture') {
      const f = this.floor?.furniture?.find((x) => x.id === target.id);
      if (f && !f.entity && hasMediaControls(f.media)) {
        const k = resolveFurniture(f).k;
        if (gesture === 'tap') this.actionHost.openPopup({ media: f.media, name: f.name || (k ? furnitureLabel(k) : undefined), icon: k?.icon, item: f.id });
        return;
      }
    }
    // a piece without an entity swallows the tap: nothing happens
    if (target.kind === 'furniture' && !this.item(target).device) return;
    if (target.kind === 'background') {
      // Tapping beside a focused room returns to the overview
      const plan = this.renderRoot.querySelector('fp-plan') as FpPlan | null;
      if (gesture === 'tap' && plan?.focused) this.returnToDefault();
      return;
    }
    const ctx = this.item(target);
    const it = ctx.room ?? ctx.device ?? ctx.opening;
    if (!it) return;
    const action = target.kind === 'furniture' ? furnitureAction(it as DeviceConfig, gesture) : resolveAction(it, target.kind, gesture);
    if (gesture === 'hold' && navigator.vibrate) navigator.vibrate(8);
    // garage doors and gates placed as pieces: switching them directly always asks first
    const piece = target.kind === 'furniture' ? this.floor?.furniture?.find((x) => x.id === target.id) : undefined;
    const garage = !!piece && ['garage_door', 'gate'].includes(resolveFurniture(piece).k?.kind ?? '');
    runAction(this.actionHost, action, { ...ctx, garage });
  }

  private handlers = {
    hasDoubleTap: (tg: HitTarget) => {
      if (tg.kind === 'background') return false;
      if (tg.kind === 'furniture' && this.floor?.furniture?.some((f) => f.id === tg.id && (furnitureContents(f).length > 0 || (isWifiPiece(f) && !f.tap_action) || resolveFurniture(f).role === 'pet' || resolveFurniture(f).role === 'car' || resolveFurniture(f).k?.kind === 'stairs'))) return false;
      if (tg.kind === 'label') return false;
      const c = this.item(tg);
      if (tg.kind === 'furniture') return !!c.device && furnitureAction(c.device, 'double_tap').action !== 'none';
      return hasDoubleTap(c.room ?? c.device ?? c.opening, tg.kind);
    },
    onTap: (tg: HitTarget) => this.gesture(tg, 'tap'),
    // instant feedback (before a possible double-tap wait): only lamps bounce once — pieces of a lamp kind or
    // any piece linked to a light
    onTapDown: (tg: HitTarget) => {
      if (tg.kind !== 'furniture') return;
      const f = this.floor?.furniture?.find((x) => x.id === tg.id);
      if (f && (resolveFurniture(f).role === 'light' || (f.entity ?? '').startsWith('light.'))) (this.renderRoot.querySelector('fp-plan') as FpPlan | null)?.bounce(f.id);
    },
    onDoubleTap: (tg: HitTarget) => this.gesture(tg, 'double_tap'),
    onHold: (tg: HitTarget) => this.gesture(tg, 'hold'),
  };

  // ---------- performance overlay (hold the compass for 2 s to toggle it on this device) ----------
  private statsTimer?: number;
  private statsToggled = false;
  // read once (storage access on every render is slow on old WebViews)
  private statsLocal?: boolean;
  private get localStats(): boolean {
    if (this.statsLocal === undefined)
      try {
        this.statsLocal = localStorage.getItem('fp-stats') === '1';
      } catch {
        this.statsLocal = false;
      }
    return this.statsLocal;
  }
  private toggleLocalStats() {
    this.statsLocal = !this.localStats;
    try {
      localStorage.setItem('fp-stats', this.statsLocal ? '1' : '0');
    } catch {
      /* storage blocked */
    }
    this.statsToggled = true;
    if (navigator.vibrate) navigator.vibrate(15);
    this._tick++;
  }

  /** Front door warning: red triangle at the top (no pop-up; a tap anywhere or the button acknowledges) */
  private renderEntryAlert() {
    const st = this.entryAlert.state;
    if (!st.active || st.phase !== 'alarm') return nothing;
    const n = st.windows.length;
    return html`<div class="entry-alert" role="alert" aria-live="assertive">
      <span class="ea-tri"><ha-icon icon="mdi:alert"></ha-icon></span>
      <span class="ea-text">${t(n === 1 ? 'alert.one_open' : 'alert.n_open').replace('{n}', String(n))}</span>
    </div>`;
  }

  /** The warning starts while another floor is shown: go to the floor with the open windows */
  private followAlert() {
    const cfg = this._config;
    if (!cfg || cfg.floors.length < 2) return;
    const ids = new Set(this.entryAlert.state.windows.map((w) => w.id));
    if (!ids.size || this.floor?.openings?.some((o) => ids.has(o.id))) return;
    let best: FloorConfig | undefined;
    let n = 0;
    for (const f of cfg.floors) {
      const k = (f.openings ?? []).filter((o) => ids.has(o.id)).length;
      if (k > n) [best, n] = [f, k];
    }
    if (best) void this.goFloor(best.id);
  }

  /** While the alarm is on, the first tap anywhere on the tablet only acknowledges it */
  private onAlarmTap = (e: Event) => {
    if (this.entryAlert.state.phase !== 'alarm') return;
    this.entryAlert.acknowledge(true);
    if (e.composedPath().includes(this)) {
      e.preventDefault();
      e.stopPropagation();
      // swallow the click that follows this pointer
      const stop = (ev: Event) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener('click', stop, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 600);
    }
  };

  private openEditor() {
    this.ensureLayer().openEditor(this._floorId);
  }

  /** First steps: open the editor with a suggested plan (HA areas, the example) — nothing is saved until "Save" */
  private startWith(kind: 'areas' | 'example') {
    this.ensureLayer().openEditor(undefined, { config: kind === 'areas' ? areasConfig(this._hass!) : examplePlan(), hint: t(kind === 'areas' ? 'editor.start_areas' : 'editor.start_example') });
  }

  /** First steps "from the vacuum's map": load the chooser, then show it in place of the welcome panel */
  private async startVacuum(kind: 'card' | 'floor') {
    try {
      // the chooser is part of the editor's bundle (the editor opens right after it)
      await import('./editor/editor-ui');
    } catch {
      this.ensureLayer().toast(t('card.reload_needed'));
      return;
    }
    this._vacStart = kind;
  }

  /** "Apply" in the chooser: the editor opens with the plan from the map (unsaved until "Save") */
  private applyVacuum(res: VacuumPlanResult) {
    const kind = this._vacStart;
    this._vacStart = undefined;
    const hint = t('vacplan.start_hint');
    if (kind === 'floor' && this._config) {
      const cfg = structuredClone(this._config);
      const f = cfg.floors.find((x) => x.id === this._floorId) ?? cfg.floors[0];
      f.rooms = res.floor.rooms;
      f.openings = [...(f.openings ?? []), ...(res.floor.openings ?? [])];
      f.furniture = [...(f.furniture ?? []), ...(res.floor.furniture ?? [])];
      this.ensureLayer().openEditor(f.id, { config: cfg, hint });
      return;
    }
    this.ensureLayer().openEditor(undefined, { config: { type: 'custom:floorplan-card', floors: [res.floor] }, hint });
  }

  private renderVacuumStart() {
    return html`<div class="onboard">
      <div class="onboard-panel wide">
        <div class="onboard-icon"><ha-icon icon="mdi:robot-vacuum"></ha-icon></div>
        <div class="onboard-title">${t('vacplan.title')}</div>
        <fp-vacuum-start .hass=${this._hass} .onApply=${(r: VacuumPlanResult) => this.applyVacuum(r)} .onBack=${() => (this._vacStart = undefined)}></fp-vacuum-start>
      </div>
    </div>`;
  }

  /** The floor's trace image, when it is chosen to show on the card too (same object while nothing changed) */
  private traceCache?: { src: unknown; href: string; out: { t: NonNullable<FloorConfig['trace']>; href: string } };
  private cardTrace(floor?: FloorConfig) {
    const tr = floor?.trace;
    if (!tr?.show) return undefined;
    const href = traceHref(this._hass, tr, () => this._tick++);
    if (!href) return undefined;
    if (this.traceCache?.src !== tr || this.traceCache.href !== href) this.traceCache = { src: tr, href, out: { t: tr, href } };
    return this.traceCache.out;
  }

  /** A shared plan that cannot be shown: loading, deleted or no companion — say so instead of an empty plan */
  private renderPlanState() {
    const st = this._planState ?? 'loading';
    const admin = !!this._hass?.user?.is_admin;
    return html`<ha-card class="plan-state" style="min-height:240px">
      <div class="onboard">
        <div class="onboard-panel">
          <div class="onboard-icon"><ha-icon icon=${st === 'loading' ? 'mdi:monitor-multiple' : 'mdi:alert-circle-outline'}></ha-icon></div>
          <div class="onboard-title" role=${st === 'loading' ? 'status' : 'alert'}>
            ${st === 'loading' ? t('share.loading') : st === 'missing' ? t('share.missing', { id: this._raw?.plan ?? '' }) : t('share.unavailable')}
          </div>
          ${st !== 'loading' ? html`<div class="onboard-tip">${t(admin ? 'share.fix_admin' : 'share.fix_user')}</div>` : nothing}
        </div>
      </div>
    </ha-card>`;
  }

  /** First run (or an empty floor): what the card is and the ways into the editor */
  private renderOnboarding(cfg: FloorplanCardConfig, canEdit: boolean) {
    if (this._vacStart && canEdit) return this.renderVacuumStart();
    const otherFloors = cfg.floors.some((f) => f.id !== this._floorId && f.rooms.length);
    // a robot vacuum in Home Assistant: its map can become the plan
    const vacuums = Object.keys(this._hass?.states ?? {}).filter((id) => id.startsWith('vacuum.')).length;
    // a brand-new card: three calm paths (draw, from Home Assistant's areas, an example) and Hausregeln's assistant
    if (canEdit && !otherFloors) {
      const areas = Object.values(this._hass?.areas ?? {});
      const floors = new Set(areas.map((a) => a.floor_id).filter(Boolean)).size;
      const path = (cls: string, icon: string, title: string, sub: string, fn: () => void, disabled = false) =>
        html`<button class="row pressable onboard-path ${cls}" ?disabled=${disabled} @click=${fn}>
          <ha-icon .icon=${icon}></ha-icon>
          <div class="grow"><div class="title">${title}</div><div class="subtitle">${sub}</div></div>
          <ha-icon class="chev" icon="mdi:chevron-right"></ha-icon>
        </button>`;
      return html`<div class="onboard">
        <div class="onboard-panel wide">
          <div class="onboard-icon"><ha-icon icon="mdi:floor-plan"></ha-icon></div>
          <div class="onboard-title">${t('card.onboard_title')}</div>
          <div class="onboard-text">${t('card.onboard_text')}</div>
          <div class="group onboard-paths">
            ${path('onboard-start', 'mdi:vector-square-edit', t('card.first_draw'), t('card.first_draw_sub'), () => this.openEditor())}
            ${path(
              'onboard-areas',
              'mdi:home-import-outline',
              t('card.first_areas'),
              areas.length ? t(floors > 1 ? 'card.first_areas_floors_sub' : 'card.first_areas_sub', { n: areas.length, f: floors }) : t('card.first_areas_none'),
              () => this.startWith('areas'),
              !areas.length,
            )}
            ${vacuums ? path('onboard-vacuum', 'mdi:robot-vacuum', t('card.first_vacuum'), t('card.first_vacuum_sub'), () => void this.startVacuum('card')) : nothing}
            ${path('onboard-example', 'mdi:sofa-outline', t('card.first_example'), t('card.first_example_sub'), () => this.startWith('example'))}
            ${sharesPlans()
              ? path('onboard-shared', 'mdi:monitor-multiple', t('share.first'), t('share.first_sub'), () => this.ensureLayer().openEditor(undefined, { share: true }))
              : nothing}
          </div>
          ${this.hrLink?.available
            ? html`<div class="group onboard-paths">
                ${path('onboard-hr', 'mdi:home-lightning-bolt-outline', t('card.first_hr'), t('card.first_hr_sub'), () => navigate('/hausregeln/setup'))}
              </div>`
            : nothing}
          <div class="onboard-tip">${t('card.first_note')}</div>
        </div>
      </div>`;
    }
    return html`<div class="onboard">
      <div class="onboard-panel">
        <div class="onboard-icon"><ha-icon icon="mdi:floor-plan"></ha-icon></div>
        <div class="onboard-title">${t(otherFloors ? 'card.onboard_floor_title' : 'card.onboard_title')}</div>
        <div class="onboard-text">${t('card.onboard_text')}</div>
        ${canEdit
          ? html`<button class="btn accent pressable onboard-start" @click=${this.openEditor}>
                <ha-icon icon="mdi:pencil-outline"></ha-icon>${t('card.onboard_start')}
              </button>
              ${vacuums
                ? html`<button class="btn pressable onboard-vacuum-floor" @click=${() => void this.startVacuum('floor')}>
                    <ha-icon icon="mdi:robot-vacuum"></ha-icon>${t('card.first_vacuum')}
                  </button>`
                : nothing}
              <div class="onboard-tip">${t('card.onboard_tip')}</div>`
          : html`<div class="onboard-tip">${t(cfg.editable === false && this._hass?.user?.is_admin ? 'card.onboard_locked' : 'card.onboard_admin')}</div>`}
      </div>
    </div>`;
  }

  // ---------- Render ----------

  override shouldUpdate(changed: PropertyValues) {
    return !!this._config && (changed.size > 0);
  }

  override render() {
    if (!this._config || !this._hass) return nothing;
    if (this.planBlocked) return this.renderPlanState();
    const cfg = this._config;
    const floor = this.floor;
    // the card keeps its shape on every floor: all floors together decide it (one floor: exactly as before)
    const b = this.allBounds(cfg);
    const aspect = Math.max(0.6, Math.min(2.2, (b.maxX - b.minX + 60) / (b.maxY - b.minY + 60)));
    const style = cfg.height ? `height:${cfg.height}` : `aspect-ratio:${aspect.toFixed(3)}`;
    const canEdit = cfg.editable !== false && !!this._hass.user?.is_admin;
    // full screen: some controls rest hidden until the plan is panned or zoomed
    const fsReveal = this.fs.active ? `fs-reveal${this.fs.revealed ? ' shown' : ''}` : '';
    const level = effectsLevel(cfg);
    // same values → same objects, so child components don't re-render just because the card did
    const weather = this.memo('weather', weatherInfo(this._hass, cfg));
    const sun = this.memo('sun', sunInfo(this._hass, cfg, weather));
    const defaults = this.userDefaults;
    const viewMode = this._force2d ? '2d' : (defaults.view_mode ?? 'auto');
    const plan = this.renderRoot?.querySelector('fp-plan') as FpPlan | null;
    const is3d = plan?.is3d ?? false;
    const night = !!sun && !sun.up;
    const strip = this.stripLayout(floor);
    const sky = level === 'off' ? undefined : skyPalette(sun, weather, this.hasAttribute('dark'));
    const skyVars = sky ? Object.entries(sky.vars).map(([k, v]) => `;${k}:${v}`).join('') : '';
    const multi = cfg.floors.length > 1;
    return html`
      <ha-card style=${style + (strip ? `;--strip-h:${strip.height}px` : '') + skyVars} class=${strip ? 'with-strip' : ''}>
        <fp-ambient layer="back" .covered=${!!this._covered} .quality=${defaults.weather} .alarm=${this.entryAlert.state.phase === 'alarm'} .sun=${sun} .weather=${weather} .level=${level} .north=${cfg.north ?? 0} .spin=${this._spin} .tilt=${is3d ? (plan?.tilt ?? 0) : 0} .night=${sky?.night ?? 0}></fp-ambient>
        <fp-plan
          .hass=${this._hass}
          .floor=${floor}
          .getState=${this.getState}
          .handlers=${this.handlers}
          .wallWidth=${cfg.wall_width ?? 8}
          .wallHeight=${cfg.wall_height ?? 90}
          .backWallHeight=${cfg.back_wall_height ?? 170}
          .viewMode=${viewMode}
          .sun=${level === 'off' ? undefined : sun}
          .night=${sky?.night ?? 0}
          .renderer=${cfg.renderer ?? 'auto'}
          .perf=${defaults.performance}
          .covered=${!!this._covered}
          .stats=${!!cfg.stats || this.localStats}
          .alertWindows=${this.entryAlert.state.active && (this.hrWarning ? (this._hr?.windowWarning?.config?.blink ?? true) : (cfg.entry_alert?.blink ?? ENTRY_DEFAULTS.blink)) ? new Set(this.entryAlert.state.windows.map((w) => w.id)) : undefined}
          .alarm=${this.entryAlert.state.phase === 'alarm'}
          .portrait=${this._size.h > this._size.w * 1.15}
          .effects=${level === 'full' || level === 'lite'}
          .windSpeed=${weather?.windSpeed}
          .defaultSpin=${defaults.orientation}
          .wallColor=${cfg.wall_color}
          .labelMode=${cfg.labels ?? 'auto'}
          .hideLabelsOnMove=${!!cfg.hide_labels_on_move}
          .focusBadge=${cfg.focus_badge !== false}
          .labelTap=${cfg.label_tap === 'heating'}
          .labelStyle=${cfg.label_style ?? 'badge'}
          .pets=${this.pets.update(this._hass, this.petFloor(cfg))}
          .below=${multi && cfg.floor_below !== false ? floorBelow(cfg, floor?.id, this._hass) : undefined}
          belowMode="outline"
          .roomHeight=${floor?.height ?? 250}
          .insetRight=${multi && this._sliderW ? this._sliderW + 24 : 0}
          .insetTop=${this._tripsInset}
          .frameBounds=${multi ? this.allBuilding(cfg) : undefined}
          .stairs=${multi ? this.stairsMap(cfg, floor) : undefined}
          .liveVacuums=${!!companionInfo()}
          .frontDoor=${cfg.entry_alert?.door}
          .hrOccupied=${this.hrOccupied(floor)}
          .trace=${this.cardTrace(floor)}
          .hrAlarmCause=${cfg.house_rules?.alarm !== false && (this._hr?.alarm?.state === 'pending' || this._hr?.alarm?.state === 'triggered') ? (this._hr.alarm.cause ?? undefined) : undefined}
          @fp-spin-change=${(e: CustomEvent) => {
            this._spin = e.detail.spin;
            this._spinDefault = e.detail.isDefault;
          }}
          .tick=${this._tick}
          @fp-view-change=${(e: CustomEvent) => {
            if (this._viewDefault === e.detail.isDefault) return;
            this._viewDefault = e.detail.isDefault;
            this.requestUpdate();
          }}
        ></fp-plan>
        ${this.renderEntryAlert()}
        <fp-ambient layer="front" .covered=${!!this._covered} .quality=${defaults.weather} .sun=${sun} .weather=${weather} .level=${level} .north=${cfg.north ?? 0} .spin=${this._spin} .tilt=${is3d ? (plan?.tilt ?? 0) : 0}></fp-ambient>
        ${!floor?.rooms.length ? this.renderOnboarding(cfg, canEdit) : nothing}
        <div class="chrome top">
          <div class="left">
            ${cfg.title ? html`<div class="title">${cfg.title}</div>` : nothing}
            ${weather
              ? html`<button
                  class="weather pressable"
                  aria-label=${formatState(this._hass, this._hass.states[weather.entity])}
                  @click=${() => fireEvent(this, 'hass-more-info', { entityId: weather.entity })}
                >
                  <ha-icon .icon=${weatherIcon(weather.condition, night)}></ha-icon>
                  ${weather.temperature != null ? html`<span class="num">${formatNumber(weather.temperature, 0)}°</span>` : nothing}
                  <span class="cond">${formatState(this._hass, this._hass.states[weather.entity])}</span>
                </button>`
              : nothing}
            ${this.renderHouseRules()} ${this.renderPeople()}
          </div>
          <div class="right">
            ${this.fs.active
              ? html`<button
                  class="icon-btn raised pressable fs-btn ${fsReveal}"
                  aria-label=${t('card.fullscreen_exit')}
                  title=${t('card.fullscreen_exit')}
                  tabindex=${this.fs.revealed ? '0' : '-1'}
                  @click=${this.toggleFullscreen}
                >
                  <ha-icon icon="mdi:fullscreen-exit"></ha-icon>
                </button>`
              : nothing}
            ${cfg.view_mode !== '2d' && cfg.view_mode !== '3d' && floor?.rooms.length
              ? html`<button
                  class="icon-btn raised pressable vm-btn ${fsReveal}"
                  aria-label=${is3d ? '2D' : '3D'}
                  title=${is3d ? '2D' : '3D'}
                  @click=${() => this.setForce2d(!this._force2d)}
                >
                  <span class="vm">${this._force2d ? '3D' : '2D'}</span>
                </button>`
              : nothing}
            ${canEdit
              ? html`<button class="icon-btn raised pressable" aria-label=${t('card.edit')} title=${t('card.edit')} @click=${this.openEditor}>
                  <ha-icon icon="mdi:pencil-outline"></ha-icon>
                </button>`
              : nothing}
          </div>
        </div>
        ${multi ? this.renderFloorSlider(cfg) : nothing}
        ${strip && floor ? this.renderStrip(floor, strip.cols) : nothing}
        ${this._fsOffer
          ? html`<button class="fs-offer pressable" @click=${this.toggleFullscreen}>
              <ha-icon icon="mdi:fullscreen"></ha-icon><span>${t('card.fullscreen')}</span>
            </button>`
          : nothing}
        <div class="chrome bottom">
          <button
            class="compass pressable ${fsReveal}"
            style=${`--rot:${(cfg.north ?? 0) + this._spin}deg`}
            title=${t('card.rotate')}
            aria-label=${t('card.rotate')}
            @click=${() => {
              if (this.statsToggled) return void (this.statsToggled = false);
              (this.renderRoot.querySelector('fp-plan') as FpPlan)?.rotateBy(90);
            }}
            @pointerdown=${() => {
              clearTimeout(this.statsTimer);
              this.statsTimer = window.setTimeout(() => this.toggleLocalStats(), 2000);
            }}
            @pointerup=${() => clearTimeout(this.statsTimer)}
            @pointerleave=${() => clearTimeout(this.statsTimer)}
          >
            <span class="rose"><span class="needle"></span><span class="n">N</span></span>
          </button>
          <button
            class="icon-btn raised pressable reset ${this._viewDefault && this._spinDefault && !(this.renderRoot?.querySelector('fp-plan') as FpPlan | null)?.focused ? 'hidden' : ''}"
            aria-label=${t('card.reset_view')}
            title=${t('card.reset_view')}
            @click=${() => this.returnToDefault()}
          >
            <ha-icon icon="mdi:fit-to-screen-outline"></ha-icon>
          </button>
        </div>
      </ha-card>
    `;
  }

  /**
   * Portrait cards have spare height under the (landscape-ish) plan: show room tiles there.
   * Returns undefined when there is no room for them.
   */
  private stripLayout(floor?: FloorConfig): { cols: number; height: number } | undefined {
    const { w, h } = this._size;
    const rooms = floor?.rooms.length ?? 0;
    if (!rooms || !w || h < w * 1.15) return undefined;
    const cols = w >= 700 ? 3 : 2;
    const rows = Math.ceil(rooms / cols);
    const height = rows * 76 + (rows - 1) * 12 + 32 + 44;
    const b = floorBounds(floor);
    const planH = ((w - 32) / (b.maxX - b.minX)) * (b.maxY - b.minY) * 0.85 + 160;
    return h - height >= planH ? { cols, height } : undefined;
  }

  private renderStrip(floor: FloorConfig, cols: number) {
    return html`<div class="strip" style=${`grid-template-columns:repeat(${cols}, 1fr)`}>
      ${floor.rooms.map((room) => {
        const lights = this.actionHost.roomLights(room);
        const on = lights.filter((id) => this.getState(id)?.state === 'on').length;
        const temp = room.temperature ? this.getState(room.temperature) : undefined;
        const climate = room.climate ? this.getState(room.climate) : undefined;
        const tv = temp && !isNaN(parseFloat(temp.state)) ? parseFloat(temp.state) : climate?.attributes.current_temperature;
        const sub = [tv != null ? `${formatNumber(tv)}°` : '', lights.length ? t('light.lights_on', { n: on }) : ''].filter(Boolean).join(' · ');
        return html`<button
          class="tile-btn pressable ${on ? 'on' : ''}"
          @pointerdown=${() => {
            this.held = false;
            clearTimeout(this.holdTimer);
            this.holdTimer = window.setTimeout(() => {
              this.held = true;
              this.gesture({ kind: 'room', id: room.id }, 'hold');
            }, 500);
          }}
          @pointerup=${() => clearTimeout(this.holdTimer)}
          @pointerleave=${() => clearTimeout(this.holdTimer)}
          @contextmenu=${(e: Event) => e.preventDefault()}
          @click=${() => {
            if (!this.held) this.gesture({ kind: 'room', id: room.id }, 'tap');
            this.held = false;
          }}
        >
          <span class="tile ${on ? 'on' : ''}"><ha-icon .icon=${on ? 'mdi:lightbulb-group' : 'mdi:lightbulb-group-outline'}></ha-icon></span>
          <span class="tile-text">
            <span class="tile-name">${room.name ?? this._hass?.areas?.[room.area ?? '']?.name ?? ''}</span>
            <span class="tile-sub num">${sub}</span>
          </span>
        </button>`;
      })}
    </div>`;
  }

  /** Bounds of every floor together (card shape) */
  private allBounds(cfg: FloorplanCardConfig) {
    if (cfg.floors.length < 2) return floorBounds(this.floor);
    if (this.boundsFor?.cfg !== cfg) {
      const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (const f of cfg.floors) {
        if (!f.rooms.length && !f.devices.length) continue;
        const fb = floorBounds(f);
        b.minX = Math.min(b.minX, fb.minX);
        b.minY = Math.min(b.minY, fb.minY);
        b.maxX = Math.max(b.maxX, fb.maxX);
        b.maxY = Math.max(b.maxY, fb.maxY);
      }
      this.boundsFor = { cfg, b: isFinite(b.minX) ? b : floorBounds(this.floor) };
    }
    return this.boundsFor.b;
  }
  private boundsFor?: { cfg: FloorplanCardConfig; b: ReturnType<typeof floorBounds> };

  /** The building of every floor together: each floor is framed the same, so the floors stack exactly */
  private allBuilding(cfg: FloorplanCardConfig) {
    if (this.buildingFor?.cfg !== cfg) {
      const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (const f of cfg.floors) {
        if (!f.rooms.length) continue;
        const fb = buildingBounds(f);
        b.minX = Math.min(b.minX, fb.minX);
        b.minY = Math.min(b.minY, fb.minY);
        b.maxX = Math.max(b.maxX, fb.maxX);
        b.maxY = Math.max(b.maxY, fb.maxY);
      }
      this.buildingFor = { cfg, b: isFinite(b.minX) ? b : undefined };
    }
    return this.buildingFor.b;
  }
  private buildingFor?: { cfg: FloorplanCardConfig; b?: ReturnType<typeof floorBounds> };

  /** Pets of every floor: walks keep their state whichever floor is shown (the plan draws its own floor's) */
  private petFloor(cfg: FloorplanCardConfig): FloorConfig | undefined {
    if (cfg.floors.length < 2) return this.floor;
    if (this.petsFor?.cfg !== cfg)
      this.petsFor = { cfg, f: { id: 'all', name: '', rooms: [], devices: [], furniture: cfg.floors.flatMap((f) => (f.furniture ?? []).filter((x) => resolveFurniture(x).role === 'pet')) } };
    return this.petsFor.f;
  }
  private petsFor?: { cfg: FloorplanCardConfig; f: FloorConfig };

  /** Stairs on the shown floor and where a tap takes you */
  private stairsMap(cfg: FloorplanCardConfig, floor: FloorConfig | undefined) {
    const m = new Map<string, { up: boolean; name: string }>();
    if (!floor) return undefined;
    const here = floorLevel(cfg, floor, this._hass);
    for (const f of floor.furniture ?? []) {
      if (f.entity || resolveFurniture(f).k?.kind !== 'stairs') continue;
      const to = stairsTarget(cfg, floor.id, f, this._hass);
      if (to) m.set(f.id, { up: floorLevel(cfg, to, this._hass) > here, name: to.name });
    }
    const key = [...m].map(([k, v]) => `${k}:${v.up}:${v.name}`).join('|');
    if (key !== this.stairsKey) {
      this.stairsKey = key;
      this.stairsVal = m.size ? m : undefined;
    }
    return this.stairsVal;
  }
  private stairsKey = '';
  private stairsVal?: Map<string, { up: boolean; name: string }>;

  /** Floor slider data (top floor first) with a quiet dot where something is going on */
  private sliderFloors(cfg: FloorplanCardConfig): SliderFloor[] {
    const alert = this.entryAlert.state.active ? new Set(this.entryAlert.state.windows.map((w) => w.id)) : undefined;
    const due = new Set([...this.pets.states].filter(([, st]) => st.mode === 'due').map(([id]) => id));
    const list = orderedFloors(cfg, this._hass).map((f): SliderFloor => {
      let dot: SliderFloor['dot'];
      if (alert?.size && f.openings?.some((o) => alert.has(o.id))) dot = 'alert';
      else if (due.size && f.furniture?.some((x) => due.has(x.id))) dot = 'pet';
      else if (f.rooms.some((r) => (r.lights ?? areaLights(this._hass!, r.area, r.exclude)).some((id) => this.getState(id)?.state === 'on')) || f.furniture?.some((x) => x.entity?.startsWith('light.') && this.getState(x.entity)?.state === 'on')) dot = 'light';
      return { id: f.id, name: f.name, short: floorShort(f), dot };
    });
    return this.memo('slider', list);
  }

  private renderFloorSlider(cfg: FloorplanCardConfig) {
    const { w, h } = this._size;
    const compact = (w > 0 && w < 600) || (h > 0 && h < 440);
    const rows = cfg.floors.length >= 4 && !compact && h >= 600 ? 5 : 3;
    return html`<fp-floor-slider
      class="floor-slider"
      .floors=${this.sliderFloors(cfg)}
      .value=${this._floorId}
      ?compact=${compact}
      .rows=${rows}
      @floor-preview=${this.onFloorPreview}
      @floor-select=${(e: CustomEvent) => void this.goFloor(e.detail.id)}
      @floor-size=${(e: CustomEvent) => (this._sliderW = e.detail.width)}
    ></fp-floor-slider>`;
  }

  static override styles = [
    tokens,
    components,
    css`
      :host {
        display: block;
      }
      /* full screen: the card fills the screen, whatever height it has on the dashboard */
      :host(:fullscreen) {
        width: 100%;
        height: 100%;
        background: var(--fp-plan-bg);
      }
      :host(:fullscreen) ha-card {
        height: 100% !important;
        aspect-ratio: auto !important;
        border-radius: 0;
      }
      /* in full screen: leave, 2D/3D and the compass only after panning or zooming, they fade out again when nobody moves the plan */
      .fs-reveal {
        opacity: 0;
        pointer-events: none;
        transition: transform var(--fp-dur-fast) var(--fp-ease), opacity 0.4s ease;
      }
      .fs-reveal.shown {
        opacity: 1;
        pointer-events: auto;
      }
      ha-card {
        position: relative;
        overflow: hidden;
        min-height: 320px;
        border-radius: var(--ha-card-border-radius, var(--fp-radius-xl));
        border: 0;
        background: var(--fp-plan-bg);
        box-shadow: none;
        font-family: var(--fp-font);
        isolation: isolate;
      }
      fp-plan {
        position: absolute;
        inset: 0;
      }
      .with-strip fp-plan {
        bottom: var(--strip-h);
        height: auto;
      }
      .with-strip .chrome.bottom {
        bottom: calc(var(--strip-h) - var(--fp-space-4) * 0.5);
      }
      .strip {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        display: grid;
        gap: var(--fp-space-3);
        padding: var(--fp-space-2) var(--fp-space-4) var(--fp-space-4);
        z-index: 1;
      }
      .tile-btn {
        display: flex;
        align-items: center;
        gap: var(--fp-space-3);
        min-height: 76px;
        padding: 0 var(--fp-space-4);
        border-radius: var(--fp-radius-l);
        background: var(--fp-surface);
        color: var(--fp-label);
        box-shadow: var(--fp-shadow-1);
        text-align: left;
        user-select: none;
        -webkit-user-select: none;
      }
      .tile-btn .tile.on {
        --tile-color: var(--fp-state-light);
      }
      .tile-text {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      .tile-name {
        font-size: var(--fp-text-subhead);
        font-weight: var(--fp-weight-semibold);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .tile-sub {
        font-size: var(--fp-text-footnote);
        color: var(--fp-label-2);
        white-space: nowrap;
      }
      .chrome {
        position: absolute;
        left: var(--fp-space-4);
        right: var(--fp-space-4);
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--fp-space-3);
        pointer-events: none;
      }
      .chrome > * {
        pointer-events: auto;
      }
      .chrome.top {
        top: var(--fp-space-4);
      }
      .chrome .left {
        display: flex;
        align-items: center;
        gap: var(--fp-space-4);
        flex-wrap: wrap;
        pointer-events: none;
      }
      .chrome .left > * {
        pointer-events: auto;
      }
      /* offered for 5 s after opening: full screen */
      .fs-offer {
        position: absolute;
        left: 50%;
        bottom: calc(var(--fp-space-4) + 4px);
        transform: translateX(-50%);
        z-index: 3;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 18px 10px 14px;
        border: none;
        border-radius: var(--fp-radius-full);
        background: color-mix(in srgb, var(--fp-surface) 92%, transparent);
        color: var(--fp-label);
        box-shadow: var(--fp-shadow-2);
        font: inherit;
        font-size: var(--fp-text-subhead);
        font-weight: var(--fp-weight-semibold);
        cursor: pointer;
        -webkit-backdrop-filter: blur(12px);
        backdrop-filter: blur(12px);
        animation: fp-fs-offer 5s ease both;
        --mdc-icon-size: 22px;
      }
      .fs-offer ha-icon {
        color: var(--fp-accent);
      }
      @keyframes fp-fs-offer {
        0% {
          opacity: 0;
          transform: translateX(-50%) translateY(12px);
        }
        8%,
        86% {
          opacity: 1;
          transform: translateX(-50%) translateY(0);
        }
        100% {
          opacity: 0;
          transform: translateX(-50%) translateY(6px);
        }
      }
      .chrome.bottom {
        bottom: var(--fp-space-4);
        align-items: flex-end;
      }
      .chrome .right {
        display: flex;
        gap: var(--fp-space-2);
      }
      .reset {
        transition: opacity var(--fp-dur) var(--fp-ease), transform var(--fp-dur) var(--fp-ease);
      }
      .reset.hidden {
        opacity: 0;
        transform: translateY(8px);
        pointer-events: none;
      }
      fp-ambient {
        z-index: 0;
      }
      /* first run: empty floor → welcome panel (under the chrome, over the plan's own hint) */
      .onboard {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--fp-space-6) var(--fp-space-4);
        background: var(--fp-plan-bg);
      }
      .onboard-panel {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--fp-space-3);
        max-width: 420px;
        text-align: center;
      }
      .onboard-icon {
        width: 64px;
        height: 64px;
        border-radius: var(--fp-radius-l);
        display: flex;
        align-items: center;
        justify-content: center;
        background: color-mix(in srgb, var(--fp-accent) 14%, transparent);
        color: var(--fp-accent);
        --mdc-icon-size: 34px;
      }
      .onboard-title {
        font-size: var(--fp-text-title3);
        font-weight: var(--fp-weight-semibold);
        color: var(--fp-label);
        letter-spacing: -0.01em;
      }
      .onboard-text {
        font-size: var(--fp-text-subhead);
        color: var(--fp-label-2);
        line-height: 1.4;
      }
      .onboard-start {
        margin-top: var(--fp-space-2);
        gap: 8px;
      }
      .onboard-tip {
        font-size: var(--fp-text-footnote);
        color: var(--fp-label-2);
        line-height: 1.4;
      }
      .onboard {
        overflow-y: auto;
      }
      .onboard-panel.wide {
        max-width: 480px;
        width: 100%;
        margin: auto;
      }
      .onboard-paths {
        width: 100%;
        text-align: left;
      }
      .onboard-path {
        width: 100%;
        border: 0;
        background: none;
        font: inherit;
        color: inherit;
        cursor: pointer;
        text-align: left;
      }
      .onboard-path > ha-icon:first-child {
        color: var(--fp-accent);
        --mdc-icon-size: 24px;
        flex: none;
      }
      .onboard-path .chev {
        color: var(--fp-label-3);
        flex: none;
      }
      .onboard-path .title,
      .onboard-path .subtitle {
        white-space: normal;
      }
      .onboard-path[disabled] {
        opacity: 0.55;
        cursor: default;
      }
      /* Front door warning: red triangle at the top */
      .entry-alert {
        position: absolute;
        left: 50%;
        top: calc(var(--fp-space-3) + env(safe-area-inset-top, 0px));
        z-index: 5;
        display: flex;
        align-items: center;
        gap: var(--fp-space-2);
        padding: 6px var(--fp-space-4) 6px 8px;
        border-radius: var(--fp-radius-full);
        background: #ff3b30;
        color: #fff;
        box-shadow: 0 6px 24px rgba(255, 59, 48, 0.45);
        transform: translateX(-50%);
        pointer-events: none;
        animation: ea-in 260ms var(--fp-ease), ea-glow 1.2s ease-in-out infinite;
      }
      .ea-tri {
        display: flex;
        --mdc-icon-size: 30px;
        animation: ea-pulse 1.2s ease-in-out infinite;
      }
      .ea-text {
        font-size: var(--fp-text-subhead);
        font-weight: var(--fp-weight-bold);
        white-space: nowrap;
      }
      @keyframes ea-in {
        from {
          opacity: 0;
          transform: translate(-50%, -16px);
        }
      }
      @keyframes ea-glow {
        50% {
          box-shadow: 0 6px 34px rgba(255, 59, 48, 0.8);
        }
      }
      @keyframes ea-pulse {
        50% {
          transform: scale(1.15);
        }
      }
      fp-plan {
        z-index: 0;
      }
      .vm {
        font-size: var(--fp-text-footnote);
        font-weight: var(--fp-weight-bold);
        letter-spacing: 0.02em;
      }
      .weather {
        display: inline-flex;
        align-items: center;
        gap: var(--fp-space-2);
        min-height: var(--fp-hit);
        padding: 0 var(--fp-space-4) 0 var(--fp-space-3);
        border-radius: var(--fp-radius-full);
        background: var(--fp-surface);
        box-shadow: var(--fp-shadow-2);
        font-size: var(--fp-text-subhead);
        font-weight: var(--fp-weight-semibold);
        color: var(--fp-label);
      }
      .weather ha-icon {
        --mdc-icon-size: 22px;
        color: var(--fp-label-2);
      }
      .weather .cond {
        font-weight: var(--fp-weight-regular);
        color: var(--fp-label-2);
      }
      /* Hausregeln: alarm shield and house mode, same pills as the weather */
      .hr-chip {
        display: inline-flex;
        align-items: center;
        gap: var(--fp-space-2);
        min-height: var(--fp-hit);
        padding: 0 var(--fp-space-4) 0 var(--fp-space-3);
        border-radius: var(--fp-radius-full);
        border: 0;
        background: var(--fp-surface);
        box-shadow: var(--fp-shadow-2);
        font: inherit;
        font-size: var(--fp-text-subhead);
        font-weight: var(--fp-weight-semibold);
        color: var(--fp-label);
        cursor: pointer;
        white-space: nowrap;
      }
      .hr-chip ha-icon {
        --mdc-icon-size: 20px;
        color: var(--fp-label-2);
      }
      .hr-chip.shield.armed ha-icon {
        color: #34c759;
      }
      .hr-chip.shield.arming ha-icon {
        color: #ff9f0a;
      }
      .hr-chip.shield.pending,
      .hr-chip.shield.alarm {
        background: #ff3b30;
        color: #fff;
        animation: hr-alarm 1.2s ease-in-out infinite;
      }
      .hr-chip.shield.pending ha-icon,
      .hr-chip.shield.alarm ha-icon {
        color: #fff;
      }
      .hr-chip span {
        font-variant-numeric: tabular-nums;
      }
      @keyframes hr-alarm {
        50% {
          opacity: 0.72;
        }
      }
      .hr-mode {
        position: relative;
      }
      .hr-chip.people {
        padding: 0 var(--fp-space-2);
      }
      .pp-stack {
        display: flex;
      }
      .pp-stack .pp-av + .pp-av {
        margin-left: -8px;
      }
      .pp-av {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        flex: none;
        display: grid;
        place-items: center;
        font-size: var(--fp-text-caption, 12px);
        font-weight: var(--fp-weight-semibold);
        background: var(--fp-fill, rgba(120, 120, 128, 0.16)) center / cover no-repeat;
        color: var(--fp-label-2);
        box-shadow: 0 0 0 2px var(--fp-surface);
      }
      .pp-av.home {
        box-shadow: 0 0 0 2px var(--fp-surface), 0 0 0 4px #34c759;
      }
      .pp-av.moving {
        box-shadow: 0 0 0 2px var(--fp-surface), 0 0 0 4px var(--fp-accent);
      }
      /* on the way: apart from the group, each with how they travel */
      .pp-sep {
        width: 1px;
        align-self: stretch;
        margin: 8px 2px;
        background: var(--fp-separator, rgba(120, 120, 128, 0.3));
      }
      .pp-away {
        gap: 4px;
      }
      .pp-stack.pp-away .pp-trip + .pp-trip {
        margin-left: 0;
      }
      .pp-trip {
        position: relative;
        display: grid;
      }
      .pp-trip .pp-mode {
        position: absolute;
        right: -4px;
        bottom: -4px;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        display: grid;
        place-items: center;
        background: var(--fp-surface);
        color: var(--fp-label);
        --mdc-icon-size: 12px;
        box-shadow: var(--fp-shadow-1, 0 1px 2px rgba(0, 0, 0, 0.2));
      }
      .pp-trips {
        position: absolute;
        top: calc(100% + 8px);
        left: 0;
        z-index: 3;
        width: max-content;
        min-width: 220px;
        max-width: min(320px, 80vw);
        padding: var(--fp-space-1);
        border-radius: var(--fp-radius-l);
        background: color-mix(in srgb, var(--fp-surface) 94%, transparent);
        box-shadow: var(--fp-shadow-2);
        display: flex;
        flex-direction: column;
        animation: pp-fold var(--fp-dur, 0.25s) var(--fp-ease, ease) both;
        transform-origin: top left;
      }
      @keyframes pp-fold {
        from {
          opacity: 0;
          transform: scaleY(0.6);
        }
      }
      .pp-line {
        display: flex;
        align-items: center;
        gap: var(--fp-space-2);
        width: 100%;
        min-height: 40px;
        padding: 0 var(--fp-space-2);
        border: 0;
        border-radius: var(--fp-radius-m);
        background: none;
        font: inherit;
        font-size: var(--fp-text-footnote, 13px);
        color: var(--fp-label);
        text-align: left;
        cursor: pointer;
      }
      .pp-line ha-icon {
        --mdc-icon-size: 20px;
        color: var(--fp-label-2);
        flex: none;
      }
      .pp-what {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pp-what span {
        color: var(--fp-label-2);
      }
      .pp-eta {
        flex: none;
        font-weight: var(--fp-weight-semibold);
        font-variant-numeric: tabular-nums;
      }
      .pp-more {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 2px var(--fp-space-3);
        margin: 0;
        padding: 0 var(--fp-space-2) var(--fp-space-2) calc(var(--fp-space-2) + 28px);
        font-size: var(--fp-text-footnote, 13px);
      }
      .pp-more dt {
        color: var(--fp-label-2);
      }
      .pp-more dd {
        margin: 0;
        font-variant-numeric: tabular-nums;
      }
      .hr-menu.people {
        min-width: 240px;
      }
      .hr-menu.people .hr-item {
        min-height: 52px;
      }
      .pp-text {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      .pp-text small {
        color: var(--fp-label-2);
        font-size: var(--fp-text-footnote, 13px);
        white-space: normal;
      }
      .hr-scrim {
        position: fixed;
        inset: 0;
        z-index: 4;
      }
      .hr-menu {
        position: absolute;
        top: calc(100% + 8px);
        left: 0;
        z-index: 5;
        min-width: 190px;
        padding: var(--fp-space-1);
        border-radius: var(--fp-radius-l);
        background: var(--fp-surface-raised, var(--fp-surface));
        box-shadow: var(--fp-shadow-3);
        display: flex;
        flex-direction: column;
        animation: hr-menu-in var(--fp-dur, 0.25s) var(--fp-ease, ease) both;
      }
      @keyframes hr-menu-in {
        from {
          opacity: 0;
          transform: translateY(-6px) scale(0.98);
        }
      }
      .hr-item {
        display: flex;
        align-items: center;
        gap: var(--fp-space-3);
        min-height: 44px;
        padding: 0 var(--fp-space-3);
        border: 0;
        border-radius: var(--fp-radius-m);
        background: none;
        font: inherit;
        font-size: var(--fp-text-body);
        color: var(--fp-label);
        cursor: pointer;
        text-align: left;
      }
      .hr-item ha-icon {
        --mdc-icon-size: 20px;
        color: var(--fp-label-2);
      }
      .hr-item.on {
        font-weight: var(--fp-weight-semibold);
      }
      /* house mode: only symbols (the name as tooltip and for screen readers), the active one stands out */
      .hr-chip.mode-chip {
        padding: 0 var(--fp-space-3);
      }
      .hr-menu.modes {
        flex-direction: row;
        min-width: 0;
        gap: 2px;
      }
      .hr-menu.modes .hr-item {
        width: var(--fp-hit);
        padding: 0;
        justify-content: center;
      }
      .hr-menu.modes .hr-item.on {
        background: color-mix(in srgb, var(--fp-accent) 16%, transparent);
      }
      .hr-menu.modes .hr-item.on ha-icon {
        color: var(--fp-accent);
      }
      .hr-item .check {
        margin-left: auto;
        color: var(--fp-accent);
      }
      .compass {
        position: relative;
        width: var(--fp-hit);
        height: var(--fp-hit);
        border-radius: 50%;
        background: var(--fp-surface);
        box-shadow: var(--fp-shadow-2);
      }
      .compass .rose {
        position: absolute;
        inset: 0;
        transform: rotate(var(--rot));
        transition: transform var(--fp-dur-slow) var(--fp-ease-in-out);
      }
      .compass .needle {
        position: absolute;
        left: 50%;
        top: 6px;
        margin-left: -5px;
        border: 5px solid transparent;
        border-top: 0;
        border-bottom: 13px solid var(--fp-red);
      }
      .compass .n {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 5px;
        text-align: center;
        font-size: 10px;
        font-weight: var(--fp-weight-bold);
        color: var(--fp-label-2);
      }
      @media (max-width: 520px) {
        .weather .cond {
          display: none;
        }
      }
      .title {
        font-size: var(--fp-text-title2);
        font-weight: var(--fp-weight-bold);
        letter-spacing: var(--fp-tracking-tight);
        color: var(--fp-label);
        padding: 0 var(--fp-space-1);
        pointer-events: none;
      }
      /* floor slider: right edge, centred on the plan (above the room tiles in portrait) */
      .floor-slider {
        position: absolute;
        right: var(--fp-space-4);
        top: 50%;
        transform: translateY(-50%);
        z-index: 2;
      }
      .with-strip .floor-slider {
        top: calc((100% - var(--strip-h)) / 2);
      }
    `,
  ];
}

if (!customElements.get('floorplan-card')) customElements.define('floorplan-card', FloorplanCard);

(window as any).customCards = (window as any).customCards || [];
if (!(window as any).customCards.some((c: any) => c.type === 'floorplan-card')) {
  // the card picker shows this before any card got hass: take the language from the HA frontend (or the browser)
  try {
    const ha = (document.querySelector('home-assistant') as any)?.hass;
    setLanguage(ha?.locale?.language ?? ha?.language ?? JSON.parse(localStorage.getItem('selectedLanguage') ?? 'null') ?? navigator.language);
  } catch {
    setLanguage(navigator.language);
  }
  (window as any).customCards.push({
    type: 'floorplan-card',
    name: 'Floorplan Card (Grundriss-Karte)',
    description: t('card.description'),
    preview: false,
  });
}

console.info(`%c FLOORPLAN-CARD %c ${typeof __VERSION__ !== 'undefined' ? __VERSION__ : 'dev'} `, 'background:#007aff;color:#fff;border-radius:4px 0 0 4px;padding:2px 4px', 'background:#e5e5ea;color:#1c1c1e;border-radius:0 4px 4px 0;padding:2px 4px');
