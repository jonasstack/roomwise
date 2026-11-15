/**
 * <house-rules-panel>: the "Hausregeln" page in the Home Assistant sidebar.
 * Today it runs on example data (DemoStore); the integration will hand it a live store.
 */
import { css, html, nothing, type PropertyValues } from 'lit';
import { mdiAirplane, mdiBedClock, mdiAccountGroup, mdiHome, mdiWalk, mdiCheckboxMarkedCircleOutline, mdiCogOutline, mdiCheck, mdiChevronRight } from '@mdi/js';
import { StoreElement } from './base';
import type { HouseMode, Rule } from './model';
import { DemoStore } from './mock/demo';
import { LiveStore, liveStore, type HassLike } from './live';
import type { Device } from './model';
import { tokens } from './design/tokens';
import { icon, shared } from './design/shared';
import { MODES, KINDS } from './vocabulary';
import { isActive } from './components/rule-card';
import './components/sheet';
import './components/pop';
import './views/room-settings';
import { PAGES, type GearView } from './components/page';
import { kit } from './design/kit';
import { findFloorplanViews, floorplanAvailable, openPath } from './setup/dashboard';
import './views/rules-view';
import './views/rooms-view';
import './views/plans-view';
import './views/light-view';
import './views/room-detail';
import './views/devices-view';
import './views/device-detail';
import './views/history-view';
import './editor/rule-editor';
import './views/alarm-view';
import './views/places-view';
import './views/group-editor';
import './views/ai-settings';
import './views/alarm-center';
import './views/home-view';
import './views/settings-view';
import './setup/wizard';
import './assistant/light';
import './assistant/alarm';
import './assistant/window';
import './assistant/vacation';
import './assistant/vacuum';
import './assistant/mode';
import { needsAssistant } from './assistant/base';
import type { AssistantId, FeatureId, Group } from './model';
import { featureHint } from './components/feature';
import { quote, setLanguage, t, tn, type I18nKey } from './i18n';
// i18n: complete

type Tab = 'rules' | 'light' | 'heat' | 'alarm' | 'home' | 'rooms' | 'devices' | 'history' | 'settings';

/** The areas: first what runs by itself (rules and the switchable features), then what the house knows. */
/** label: t(`tab.${tab}`) */
const TABS: [Tab, FeatureId?][] = [['rules'], ['light', 'light'], ['heat', 'heating'], ['alarm', 'alarm'], ['home'], ['rooms'], ['devices'], ['history']];
/** areas of older versions */
const OLD_TABS: Record<string, Tab> = { places: 'home' };
/**
 * Deep links to a place inside an area: /hausregeln/<alias> → [area, anchor]. The anchor is handed to the view
 * (property `place`), which scrolls there or opens it. "home/window-warning" is where the window warning used to be.
 */
const ROUTES: Record<string, [Tab, string]> = {
  'window-warning': ['alarm', 'window-warning'],
  'home/window-warning': ['alarm', 'window-warning'],
  vacation: ['settings', 'urlaub'],
  residents: ['home', 'residents'],
};

const MODE_ICONS: Record<HouseMode, string> = { home: mdiHome, away: mdiWalk, sleep: mdiBedClock, vacation: mdiAirplane, guests: mdiAccountGroup };

interface EditorState {
  rule?: Rule;
  isNew?: boolean;
  unsure?: string[];
  fromText?: string;
  source?: string;
  suggestion?: string;
}

/** a button in the toast ("hr-toast" with { text, action }) */
export interface ToastAction {
  label: string;
  run: () => void;
}

export class HouseRulesPanel extends StoreElement {
  static override properties = {
    ...StoreElement.properties,
    narrow: { type: Boolean },
    route: { attribute: false },
    _tab: { state: true },
    _editor: { state: true },
    _room: { state: true },
    _device: { state: true },
    _task: { state: true },
    _choices: { state: true },
    _wizard: { state: true },
    _assistant: { state: true },
    _group: { state: true },
    _toast: { state: true },
    _anchor: { state: true },
    _modePop: { state: true },
    _roomSettings: { state: true },
    _plan: { state: true },
  };
  declare narrow: boolean;
  /** given by Home Assistant: /hausregeln/alarm opens the alarm screen */
  declare route: { prefix: string; path: string } | undefined;
  declare _tab: Tab;
  declare _editor: EditorState | null;
  declare _room: string | null;
  declare _device: string | null;
  declare _task: string | null;
  declare _choices: Record<string, string>;
  declare _wizard: boolean;
  /** the open feature assistant (Licht, Alarmanlage …) */
  declare _assistant: AssistantId | null;
  declare _group: { group?: Group } | null;
  declare _toast: string;
  /** a place inside the current area to scroll to / open (deep link or link from another area), handed over once */
  declare _anchor: string;
  /** the house mode pop-up (from the head) is open */
  declare _modePop: boolean;
  /** "Raum einstellen" (sensors, empty after, dark from) of this room is open: one pop-up for Licht, Heizung, Räume */
  declare _roomSettings: string | null;
  /** first dashboard view with the floor plan card ("Zum Grundriss" in the head), '' = none */
  declare _plan: string | null;
  /** the area a link to a place opened (shown even when its feature is off and it is not in the navigation) */
  private _pinned?: Tab;
  /** a button in the toast, e.g. "Rückgängig" right after deleting a rule */
  private _toastAction?: ToastAction;
  private _toastTimer = 0;

  constructor() {
    super();
    // until Home Assistant hands over hass (and in the preview): ?lang=en or the page's language
    try {
      setLanguage(new URLSearchParams(location.search).get('lang') || document.documentElement.lang || 'de');
    } catch {
      /* no location (tests) */
    }
    this.store = new DemoStore();
    this._tab = 'rules';
    this._editor = null;
    this._room = null;
    this._device = null;
    this._task = null;
    this._choices = {};
    this._wizard = false;
    this._assistant = null;
    this._group = null;
    this._toast = '';
    this._anchor = '';
    this._modePop = false;
    this._roomSettings = null;
    this._plan = null;
    try {
      const raw = localStorage.getItem('house-rules-tab') ?? '';
      const t = (OLD_TABS[raw] ?? raw) as Tab;
      if (t === 'settings' || TABS.some(([x]) => x === t)) this._tab = t;
    } catch {
      /* storage unavailable */
    }
  }

  /** Home Assistant hands us hass; only the theme is used so far. */
  private _hass?: HassLike;

  override set hass(h: HassLike | undefined) {
    this._hass = h;
    this.toggleAttribute('dark', !!h?.themes?.darkMode);
    if (h?.connection) {
      const live = liveStore(h);
      if (this.store !== live) this.store = live;
    }
  }

  /** Deep link into an area, e.g. /hausregeln/settings, or to a place in it, e.g. /hausregeln/window-warning
   * (the floor-plan card links to the window warning) */
  private _routed?: string;
  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    const p = this.route?.path ?? '';
    if (p === this._routed) return;
    this._routed = p;
    const sub = p.replace(/^\/+|\/+$/g, '');
    const t = sub.split('/')[0] as Tab | 'setup' | undefined;
    // /hausregeln/setup: straight into the setup wizard (the floor plan card links here from its first steps)
    if (t === 'setup') {
      this._setTab('settings');
      this._wizard = true;
      this._autoWizard = true;
    } else if (ROUTES[sub]) this._setTab(...ROUTES[sub]);
    else if (t && (t === 'settings' || TABS.some(([x]) => x === t))) this._setTab(t);
  }

  /** `t` may carry a place inside the area: "alarm#window-warning" */
  private _setTab(t: Tab | string, anchor = '') {
    const [tab, hash] = t.split('#') as [Tab, string?];
    this._tab = tab;
    this._anchor = anchor || hash || '';
    this._pinned = this._anchor ? tab : undefined;
    try {
      localStorage.setItem('house-rules-tab', tab);
    } catch {
      /* ignore */
    }
  }

  private _say(text: string, action?: ToastAction) {
    this._toast = text;
    this._toastAction = action;
    clearTimeout(this._toastTimer);
    this._toastTimer = window.setTimeout(() => (this._toast = ''), action ? 8000 : 2600);
  }

  static override styles = [
    tokens,
    shared,
    kit,
    css`
      .side {
        display: flex;
        align-items: center;
        gap: var(--hr-space-3);
      }
      .mode-pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-height: 44px;
        padding: 0 var(--hr-space-4);
        border-radius: var(--hr-radius-full);
        background: var(--hr-surface);
        box-shadow: var(--hr-shadow-1);
        font-size: var(--hr-text-subhead);
        font-weight: 600;
      }
      .mode-pill span {
        color: var(--hr-label-2);
        font-weight: 500;
      }
      .mode-pill .ic {
        color: var(--hr-accent);
      }
      .page-gear {
        width: 44px;
        height: 44px;
        border-radius: 50%;
        display: grid;
        place-items: center;
        background: var(--hr-surface);
        box-shadow: var(--hr-shadow-1);
        color: var(--hr-label-2);
      }
      .head .title p .plan {
        color: var(--hr-accent);
        font-weight: 600;
        font-size: inherit;
      }
      .mode-list .rl-item .ic.chk {
        color: var(--hr-accent);
      }
      @media (max-width: 640px) {
        .side {
          width: 100%;
          justify-content: space-between;
        }
      }
      :host {
        display: block;
        min-height: 100vh;
        background: var(--hr-bg);
      }
      .page {
        max-width: 1240px;
        margin: 0 auto;
        padding-block: var(--hr-space-6) var(--hr-space-8);
        padding-left: max(var(--hr-space-6), env(safe-area-inset-left, 0px));
        padding-right: max(var(--hr-space-6), env(safe-area-inset-right, 0px));
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-6);
      }
      @media (max-width: 640px) {
        .page {
          padding-left: max(var(--hr-space-4), env(safe-area-inset-left, 0px));
          padding-right: max(var(--hr-space-4), env(safe-area-inset-right, 0px));
          padding-top: var(--hr-space-4);
          gap: var(--hr-space-5);
        }
      }
      .demo {
        display: flex;
        align-items: center;
        gap: var(--hr-space-2);
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
        padding: var(--hr-space-2) var(--hr-space-3);
        border-radius: var(--hr-radius-s);
        background: var(--hr-fill);
        align-self: flex-start;
      }
      .head {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-end;
        gap: var(--hr-space-4);
      }
      .head .title {
        flex: 1 1 280px;
      }
      h1 {
        font-size: var(--hr-text-large);
        font-weight: 800;
        letter-spacing: -0.03em;
        line-height: 1.05;
      }
      .head .title p {
        margin-top: 6px;
        color: var(--hr-label-2);
        font-size: var(--hr-text-subhead);
      }
      .head .title p b {
        color: var(--hr-label);
        font-weight: 600;
      }
      .mode {
        display: flex;
        flex-direction: column;
        gap: 6px;
        align-items: flex-end;
        min-width: 0;
        max-width: 100%;
      }
      .mode .eyebrow {
        margin-right: 6px;
      }
      .mode .seg button {
        padding: 0 var(--hr-space-3);
        min-width: 44px;
        justify-content: center;
      }
      .mode .seg button[aria-pressed='true'] .ic {
        color: var(--hr-accent);
      }
      @media (max-width: 640px) {
        .mode {
          align-items: stretch;
          width: 100%;
        }
      }
      nav {
        position: sticky;
        top: env(safe-area-inset-top, 0px);
        z-index: 2;
        display: flex;
        gap: var(--hr-space-1);
        padding: var(--hr-space-2) 0;
        margin: calc(-1 * var(--hr-space-2)) 0;
        background: color-mix(in srgb, var(--hr-bg) 88%, transparent);
        -webkit-backdrop-filter: blur(16px);
        backdrop-filter: blur(16px);
        overflow-x: auto;
        scrollbar-width: none;
        border-bottom: 0.5px solid var(--hr-separator);
      }
      nav::-webkit-scrollbar {
        display: none;
      }
      nav button {
        min-height: 40px;
        padding: 0 var(--hr-space-4);
        border-radius: var(--hr-radius-full);
        font-size: var(--hr-text-subhead);
        font-weight: 600;
        color: var(--hr-label-2);
        white-space: nowrap;
      }
      nav button[aria-current='page'] {
        background: var(--hr-label);
        color: var(--hr-bg);
      }
      .toast {
        position: fixed;
        left: 50%;
        bottom: calc(24px + env(safe-area-inset-bottom, 0px));
        transform: translateX(-50%);
        z-index: 20;
        display: flex;
        align-items: center;
        gap: var(--hr-space-2);
        padding: var(--hr-space-3) var(--hr-space-5);
        border-radius: var(--hr-radius-full);
        background: var(--hr-label);
        color: var(--hr-bg);
        font-weight: 600;
        font-size: var(--hr-text-subhead);
        box-shadow: var(--hr-shadow-3);
        animation: toast var(--hr-dur) var(--hr-ease);
        max-width: calc(100% - 32px);
      }
      .toast-act {
        margin-left: var(--hr-space-2);
        padding: 4px 12px;
        border-radius: var(--hr-radius-full);
        background: color-mix(in srgb, var(--hr-bg) 18%, transparent);
        color: var(--hr-bg);
        font-weight: 700;
      }
      @keyframes toast {
        from {
          opacity: 0;
          transform: translate(-50%, 12px);
        }
      }
      .ww {
        display: flex;
        align-items: center;
        gap: var(--hr-space-3);
        padding: var(--hr-space-3) var(--hr-space-4);
        border-radius: var(--hr-radius-m);
        background: color-mix(in srgb, var(--hr-red) var(--hr-tint), transparent);
        font-size: var(--hr-text-subhead);
      }
      .ww .grow {
        flex: 1;
        min-width: 0;
      }
      .pill.alarm {
        background: var(--hr-red);
        color: #fff;
      }
      .head .title p .pill {
        margin-left: 6px;
        vertical-align: middle;
      }
      nav .spacer {
        flex: 1;
      }
      nav .gear {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-width: 40px;
        color: var(--hr-label-2);
      }
      nav .gear[aria-current='page'] {
        background: var(--hr-label);
        color: var(--hr-bg);
      }
      nav .sep {
        flex: none;
        width: 1px;
        margin: 8px 4px;
        background: var(--hr-separator);
      }
      @media (max-width: 900px) {
        nav .gear .gl {
          display: none;
        }
        nav .gear {
          padding: 0 10px;
        }
      }
      /* phones: the settings sit in the title row (the navigation scrolls sideways, the end is out of sight) */
      .head .gear {
        display: none;
      }
      @media (max-width: 640px) {
        .head .gear {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          align-self: center;
          width: 40px;
          height: 40px;
          border-radius: 50%;
          color: var(--hr-label-2);
        }
        .head .gear[aria-current='page'] {
          background: var(--hr-label);
          color: var(--hr-bg);
        }
        .head .title {
          flex: 1 1 0;
        }
      }
      .menu {
        align-self: center;
        margin-left: -8px;
        color: var(--hr-label);
      }
      .state-msg {
        padding: var(--hr-space-7) var(--hr-space-5);
        text-align: center;
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-2);
      }
      .settings h3 {
        font-size: var(--hr-text-footnote);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--hr-label-2);
        margin: var(--hr-space-5) 0 var(--hr-space-2) var(--hr-space-2);
      }
      .stepper {
        display: inline-flex;
        align-items: center;
        gap: var(--hr-space-2);
      }
      .stepper output {
        min-width: 56px;
        text-align: center;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .stepper button {
        width: 34px;
        height: 34px;
        border-radius: 50%;
        background: var(--hr-fill);
        font-size: 18px;
      }
      .settings .row {
        flex-wrap: wrap;
      }
      .task {
        display: flex;
        flex-direction: column;
        min-height: 0;
      }
      .task header {
        padding: var(--hr-space-5) var(--hr-space-5) var(--hr-space-2);
      }
      .task header p {
        color: var(--hr-label-2);
        font-size: var(--hr-text-subhead);
        margin-top: 4px;
        line-height: 1.4;
      }
      .task .list {
        overflow-y: auto;
        padding: var(--hr-space-3) var(--hr-space-5);
      }
      .task .row,
      hr-pop .row {
        flex-wrap: wrap;
      }
      .blk {
        margin-bottom: var(--hr-space-3);
      }
      .blk summary {
        display: flex;
        gap: var(--hr-space-2);
        cursor: pointer;
        font-size: var(--hr-text-footnote);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--hr-label-2);
        padding: var(--hr-space-2) var(--hr-space-1);
      }
      .task .row .grow,
      hr-pop .row .grow {
        min-width: 160px;
      }
      .task footer {
        display: flex;
        justify-content: flex-end;
        gap: var(--hr-space-2);
        padding: var(--hr-space-3) var(--hr-space-5) var(--hr-space-5);
      }
    `,
  ];

  private _onOpenRule = (e: Event) => {
    const d = (e as CustomEvent<EditorState>).detail ?? {};
    e.stopPropagation();
    this._editor = { ...d };
  };
  private _onOpenDevice = (e: Event) => {
    e.stopPropagation();
    this._device = (e as CustomEvent<{ entity_id: string }>).detail.entity_id;
  };
  private _onOpenRoom = (e: Event) => {
    e.stopPropagation();
    this._room = (e as CustomEvent<{ id: string }>).detail.id;
  };
  private _onGroup = (e: Event) => {
    e.stopPropagation();
    this._group = (e as CustomEvent<{ group?: Group }>).detail ?? {};
  };
  private _onRoomSettings = (e: Event) => {
    e.stopPropagation();
    this._roomSettings = (e as CustomEvent<{ id: string }>).detail.id;
  };
  private _onTab = (e: Event) => {
    e.stopPropagation();
    this._setTab((e as CustomEvent<string>).detail);
  };
  private _onSetup = (e: Event) => {
    e.stopPropagation();
    const d = (e as CustomEvent<{ restart?: boolean }>).detail ?? {};
    if (d.restart) this.store.setupSave({ restart: true });
    this._wizard = true;
  };
  /** feature assistants that already opened by themselves in this visit */
  private _autoAssist = new Set<AssistantId>();
  private _onAssistant = (e: Event) => {
    e.stopPropagation();
    const d = (e as CustomEvent<{ feature: AssistantId; auto?: boolean }>).detail;
    if (!d?.feature) return;
    if (d.auto) {
      // by itself: once, only when nothing else is open and the feature still has no setup
      const busy = this._wizard || !!this._assistant || !!this._editor || !!this._room || !!this._device || !!this._task || !!this._group;
      if (busy || this._autoAssist.has(d.feature) || !needsAssistant(this.store, d.feature)) return;
      this._autoAssist.add(d.feature);
    }
    this._assistant = d.feature;
  };
  /** opened by itself once on a fresh install (until finished or closed with "später") */
  private _autoWizard = false;
  private _onToast = (e: Event) => {
    e.stopPropagation();
    const d = (e as CustomEvent<string | { text: string; action?: ToastAction }>).detail;
    if (typeof d === 'string') this._say(d);
    else this._say(d.text, d.action);
  };
  private _onTask = (e: Event) => {
    e.stopPropagation();
    const d = (e as CustomEvent<{ task: string; suggestion: string }>).detail;
    this._task = d.suggestion;
  };

  override connectedCallback(): void {
    super.connectedCallback();
    this._findPlan();
    this.addEventListener('hr-open-rule', this._onOpenRule);
    this.addEventListener('hr-open-device', this._onOpenDevice);
    this.addEventListener('hr-open-room', this._onOpenRoom);
    this.addEventListener('hr-room-settings', this._onRoomSettings);
    this.addEventListener('hr-task', this._onTask);
    this.addEventListener('hr-open-group', this._onGroup);
    this.addEventListener('hr-toast', this._onToast);
    this.addEventListener('hr-tab', this._onTab);
    this.addEventListener('hr-setup', this._onSetup);
    this.addEventListener('hr-assistant', this._onAssistant);
  }
  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener('hr-open-rule', this._onOpenRule);
    this.removeEventListener('hr-open-device', this._onOpenDevice);
    this.removeEventListener('hr-open-room', this._onOpenRoom);
    this.removeEventListener('hr-room-settings', this._onRoomSettings);
    this.removeEventListener('hr-task', this._onTask);
    this.removeEventListener('hr-open-group', this._onGroup);
    this.removeEventListener('hr-toast', this._onToast);
    this.removeEventListener('hr-tab', this._onTab);
    this.removeEventListener('hr-setup', this._onSetup);
    this.removeEventListener('hr-assistant', this._onAssistant);
  }

  /** "Zum Grundriss" in the head: the first dashboard view with the floor plan card (read once, only reads) */
  private _planAsked = false;
  private _findPlan() {
    const s = this.store;
    if (this._planAsked || !(s instanceof LiveStore) || !s.ready || !floorplanAvailable(s)) return;
    this._planAsked = true;
    findFloorplanViews(s).then(
      (p) => (this._plan = p[0]?.path ?? ''),
      () => (this._plan = ''),
    );
  }

  /** Is an area in the navigation? A switched-off feature hides its area. The alarm area also holds the window
   * warning, so it stays while either of them is on. */
  private _tabOn(t: Tab, f?: FeatureId): boolean {
    return !f || this.store.on(f) || (t === 'alarm' && this.store.on('window_warning'));
  }

  /** the area to show: a switched-off feature's area falls back to the rules */
  private _current(): Tab {
    const f = TABS.find(([x]) => x === this._tab)?.[1];
    // a link to a place (e.g. the card's "switch on in Hausregeln") shows its area even while it is hidden
    return this._tabOn(this._tab, f) || this._pinned === this._tab ? this._tab : 'rules';
  }

  protected override updated(changed: PropertyValues): void {
    super.updated(changed);
    // the anchor went to the view once; cleared so that the same link works again (not before the view is drawn:
    // a deep link arrives before the live data)
    if (this._anchor && this._drawn) queueMicrotask(() => (this._anchor = ''));
  }

  /** the area's view was drawn in the last render (not the loading message) */
  private _drawn = false;

  private _view() {
    this._drawn = true;
    switch (this._current()) {
      case 'rules':
        return html`<hr-rules-view data-view .store=${this.store} .place=${this._anchor}></hr-rules-view>`;
      case 'rooms':
        return html`<hr-rooms-view data-view .store=${this.store}></hr-rooms-view>`;
      case 'devices':
        return html`<hr-devices-view data-view .store=${this.store}></hr-devices-view>`;
      case 'home':
        return html`<hr-home-view data-view .store=${this.store} .place=${this._anchor}></hr-home-view>`;
      case 'settings':
        return html`<hr-settings-view data-view .store=${this.store} .place=${this._anchor}></hr-settings-view>`;
      case 'alarm':
        return html`<hr-alarm-view data-view .store=${this.store} .place=${this._anchor}></hr-alarm-view>`;
      case 'light':
        return html`<hr-light-plans data-view .store=${this.store} .place=${this._anchor}></hr-light-plans>`;
      case 'heat':
        // the heating area (its content belongs to the heating part)
        return this.store.on('heating') ? html`<hr-heat-plans data-view .store=${this.store}></hr-heat-plans>` : featureHint(this, 'heating');
      case 'history':
        return html`<hr-history-view data-view .store=${this.store}></hr-history-view>`;
    }
  }

  private _taskSheet() {
    const s = this.store;
    const sugg = s.suggestions.find((x) => x.id === this._task);
    const fixKinds = sugg?.task === 'fix_kinds';
    const RELEVANT = ['light', 'window', 'door', 'presence', 'motion', 'climate', 'media', 'outlet', 'zone', 'switch', 'fan', 'purifier', 'cover', 'leak'];
    // only devices that really have no room yet
    const open = fixKinds ? s.devices.filter((d) => d.kind_hint) : s.devices.filter((d) => !d.room && d.no_room !== 'set' && RELEVANT.includes(d.kind));
    const withGuess = open.filter((d) => !fixKinds && d.room_guess && !d.no_room);
    const noGuess = open.filter((d) => !fixKinds && !d.room_guess && !d.no_room);
    const likely = open.filter((d) => !fixKinds && d.no_room === 'likely');
    const choice = (d: Device) => this._choices[d.entity_id] ?? (fixKinds ? d.kind : d.room_guess ?? '');
    const pick = (d: Device, v: string) => (this._choices = { ...this._choices, [d.entity_id]: v });
    const done = async () => {
      const changes = open
        .map((d) => ({ d, v: choice(d) }))
        .filter(({ v }) => v)
        .map(({ d, v }) => (fixKinds ? { entity_id: d.entity_id, kind: v } : v === '-' ? { entity_id: d.entity_id, no_room: true } : { entity_id: d.entity_id, room: v }));
      await s.setDevices(changes);
      if (sugg && fixKinds) await s.dismissSuggestion(sugg.id);
      this._task = null;
      this._choices = {};
      this._say(tn('panel.sorted', changes.length));
    };
    const row = (d: Device) => html`<div class="row">
      <span class="grow"><div class="title">${d.name}</div><div class="sub">${KINDS[d.kind]?.label}${fixKinds ? ` · ${t('panel.ha_says', { kind: KINDS[d.kind_hint!]?.label ?? '' })}` : ''}</div></span>
      <div class="seg">
        ${fixKinds
          ? [d.kind, d.kind_hint!].map((k) => html`<button aria-pressed=${choice(d) === k ? 'true' : 'false'} @click=${() => pick(d, k)}>${KINDS[k]?.label}</button>`)
          : html`${s.rooms.map((r) => html`<button aria-pressed=${choice(d) === r.id ? 'true' : 'false'} @click=${() => pick(d, choice(d) === r.id ? '' : r.id)}>${r.name}</button>`)}
              <button aria-pressed=${choice(d) === '-' ? 'true' : 'false'} @click=${() => pick(d, choice(d) === '-' ? '' : '-')}>${t('panel.no_room')}</button>`}
      </div>
    </div>`;
    const block = (title: string, list: Device[], collapsed = false) =>
      list.length
        ? html`<details class="blk" ?open=${!collapsed}>
            <summary><span>${title}</span><span class="muted">${list.length}</span></summary>
            <div class="group">${list.map(row)}</div>
          </details>`
        : nothing;
    return html`<hr-pop
      wide
      heading=${fixKinds ? sugg?.title ?? t('panel.sort') : tn('panel.without_room', open.length)}
      .sub=${fixKinds ? t('panel.sort_kinds_lead') : t('panel.sort_rooms_lead')}
      @close=${() => (this._task = null)}
    >
      ${fixKinds
        ? html`<div class="group">${open.map(row)}</div>`
        : html`${block(t('panel.with_guess'), withGuess)} ${block(t('panel.without_guess'), noGuess)} ${block(t('panel.likely_no_room'), likely, true)}`}
      <button slot="foot" class="btn" @click=${() => (this._task = null)}>${t('common.later')}</button>
      <button slot="foot" class="btn primary" @click=${done}>${icon(mdiCheckboxMarkedCircleOutline, 18)}${t('common.apply')}</button>
    </hr-pop>`;
  }

  /** house mode from the head: switch by hand, link to the automatic switching (Zuhause → Hausmodus automatisch) */
  private _modeSheet() {
    const s = this.store;
    const close = () => (this._modePop = false);
    return html`<hr-pop narrow heading=${t('page.mode')} .sub=${t('page.mode_now', { mode: MODES[s.mode].label })} @close=${close}>
      <div class="rl-list mode-list" role="radiogroup" aria-label=${t('page.mode')}>
        ${(Object.keys(MODES) as HouseMode[]).map(
          (m) => html`<button class="rl-item" role="radio" aria-checked=${s.mode === m ? 'true' : 'false'} @click=${() => s.setMode(m)}>
            <span class="ico">${icon(MODE_ICONS[m], 20)}</span>
            <span class="grow"><b>${MODES[m].label}</b><small>${t(`home.mode_text_${m}` as I18nKey)}</small></span>
            ${s.mode === m ? html`<span class="ic chk">${icon(mdiCheck, 22)}</span>` : nothing}
          </button>`,
        )}
      </div>
      <div class="rl-box">
        <div class="line">
          <span class="grow"><b>${t('page.mode_auto')}</b><small>${t('page.mode_auto_sub')}</small></span>
          <button class="btn small" @click=${() => (close(), this._setTab('home', 'mode-auto'))}>${t('page.mode_set')}${icon(mdiChevronRight, 18)}</button>
        </div>
      </div>
      <button slot="foot" class="btn primary" @click=${close}>${t('common.done')}</button>
    </hr-pop>`;
  }

  private _assistantSheet(f: AssistantId) {
    const s = this.store;
    const close = () => (this._assistant = null);
    const el = {
      light: html`<hr-assistant-light .store=${s} @close=${close}></hr-assistant-light>`,
      alarm: html`<hr-assistant-alarm .store=${s} @close=${close}></hr-assistant-alarm>`,
      window_warning: html`<hr-assistant-window .store=${s} @close=${close}></hr-assistant-window>`,
      vacation: html`<hr-assistant-vacation .store=${s} @close=${close}></hr-assistant-vacation>`,
      vacuum: html`<hr-assistant-vacuum .store=${s} @close=${close}></hr-assistant-vacuum>`,
      mode_auto: html`<hr-assistant-mode .store=${s} @close=${close}></hr-assistant-mode>`,
    }[f];
    return html`<hr-sheet width="720" label="Assistent" @close=${close}>${el}</hr-sheet>`;
  }

  override render() {
    const s = this.store;
    this._drawn = false;
    if ((this.route?.path ?? '').startsWith('/alarm') || (!this.route && location.hash === '#alarm'))
      return html`<hr-alarm-center .store=${s}></hr-alarm-center>`;
    const active = s.rules.filter((r) => isActive(s, r)).length;
    const paused = s.rules.filter((r) => !r.enabled || (r.paused_until && new Date(r.paused_until).getTime() > Date.now())).length;
    const ed = this._editor;
    const cur = this._current();
    const page = PAGES[cur];
    if (!this._planAsked) queueMicrotask(() => this._findPlan());
    // fresh install: the setup wizard opens by itself (Home Assistant admins only: it switches features; once, until finished or put off)
    if (!this._autoWizard && s instanceof LiveStore && s.ready && s.setup && !s.setup.done && !s.setup.answers?.dismissed && s.haAdmin) {
      this._autoWizard = true;
      this._wizard = true;
    }
    return html`
      <div class="page">
        ${s.demo ? html`<div class="demo"><span class="dot warm"></span>${t('panel.demo')}</div>` : nothing}
        ${s.windowWarning?.active && s.windowWarning.phase === 'alarm'
          ? html`<div class="ww" role="alert">
              <span class="grow"><b>${t('panel.windows_open')}</b> · ${s.windowWarning.names.join(', ')}</span>
              <button class="btn small" @click=${() => s.windowWarningAck()}>${t('panel.acknowledge')}</button>
            </div>`
          : nothing}
        <div class="head">
          ${this.narrow && this._hass ? html`<ha-menu-button class="menu" .hass=${this._hass} .narrow=${this.narrow}></ha-menu-button>` : nothing}
          <div class="title">
            <h1>${t(`tab.${cur}` as I18nKey)}</h1>
            <p>
              ${page?.sub ? page.sub(s) : html`<b>${tn('panel.rules_count', s.rules.length)}</b> · ${tn('panel.active_count', active)}${paused ? ` · ${t('panel.paused_count', { n: paused })}` : ''}`}
              ${page?.plan && this._plan ? html` · <button class="plan" @click=${() => openPath(this._plan!)}>${t('page.to_plan')}</button>` : nothing}
              ${s.alarm?.config.enabled && s.alarm.state !== 'disarmed'
                ? html`<button class="pill ${s.alarm.state === 'triggered' || s.alarm.state === 'pending' ? 'alarm' : 'accent'}" @click=${() => this._setTab('alarm')}>${t('panel.alarm_state', { state: s.alarm.label })}</button>`
                : nothing}
            </p>
          </div>
          <div class="side">
            <button class="mode-pill" title=${t('panel.mode_title', { mode: MODES[s.mode].label, text: t(`home.mode_text_${s.mode}` as I18nKey) })} @click=${() => (this._modePop = true)}>
              ${icon(MODE_ICONS[s.mode], 20)}<span>${t('page.mode')}</span>${MODES[s.mode].label}
            </button>
            ${page?.gear
              ? html`<button class="page-gear" aria-label=${t('page.gear')} title=${t('page.gear')} @click=${() => (this.renderRoot.querySelector('[data-view]') as unknown as GearView | null)?.openGear()}>${icon(mdiCogOutline, 22)}</button>`
              : nothing}
          </div>
        </div>
        <nav aria-label=${t('panel.areas')}>
          ${TABS.filter(([tab, f]) => this._tabOn(tab, f)).map(
            ([tab], i, list) => html`${i > 0 && list[i - 1][1] && !list[i][1] ? html`<span class="sep" aria-hidden="true"></span>` : list[i][0] === 'home' && i > 0 ? html`<span class="sep" aria-hidden="true"></span>` : nothing}<button aria-current=${cur === tab ? 'page' : 'false'} @click=${() => this._setTab(tab)}>${t(`tab.${tab}` as I18nKey)}</button>`,
          )}
          <span class="spacer"></span>
          <button class="gear" aria-label=${t('tab.settings')} title=${t('tab.settings')} aria-current=${cur === 'settings' ? 'page' : 'false'} @click=${() => this._setTab('settings')}>${icon(mdiCogOutline, 20)}<span class="gl">${t('tab.settings')}</span></button>
        </nav>
        ${s instanceof LiveStore && s.error
          ? html`<div class="card state-msg">
              <h2>${s.error === 'not_installed' ? t('panel.not_installed') : t('panel.no_connection')}</h2>
              <p>${s.error === 'not_installed' ? t('panel.not_installed_text') : s.error === 'connection_failed' ? t('panel.connection_failed') : s.error}</p>
            </div>`
          : s instanceof LiveStore && !s.ready
            ? html`<div class="state-msg muted">${t('common.loading')}</div>`
            : this._view()}
      </div>

      ${this._room ? html`<hr-room-detail .store=${s} .roomId=${this._room} @close=${() => (this._room = null)}></hr-room-detail>` : nothing}
      <!-- the setup wizard (an hr-pop) before what it opens: room settings, assistants, devices lie on top -->
      ${this._wizard ? html`<hr-setup-wizard .store=${s} @close=${() => (this._wizard = false)}></hr-setup-wizard>` : nothing}
      ${this._roomSettings
        ? html`<hr-room-settings .store=${s} .roomId=${this._roomSettings} @close=${() => (this._roomSettings = null)}></hr-room-settings>`
        : nothing}
      ${ed
        ? html`<hr-sheet width="820" label=${t('panel.rule')} @close=${() => (this._editor = null)}>
            <house-rules-editor
              .store=${s}
              .rule=${ed.rule}
              ?isNew=${!!ed.isNew}
              .unsure=${ed.unsure}
              .fromText=${ed.fromText}
              .source=${ed.source}
              @closed=${() => (this._editor = null)}
              @rule-saved=${(e: CustomEvent<{ rule: Rule }>) => {
                if (ed.suggestion) s.dismissSuggestion(ed.suggestion);
                this._editor = null;
                this._say(t('panel.rule_saved', { name: quote(e.detail.rule.name) }));
              }}
            ></house-rules-editor>
          </hr-sheet>`
        : nothing}
      ${this._task ? this._taskSheet() : nothing}
      ${this._assistant ? this._assistantSheet(this._assistant) : nothing}
      ${this._group ? html`<hr-group-editor .store=${s} .group=${this._group.group} @close=${() => (this._group = null)}></hr-group-editor>` : nothing}
      <!-- last: "Erkannt als … ändern" opens it from any list, also inside the wizard -->
      ${this._device
        ? html`<hr-sheet width="720" label=${t('panel.device')} @close=${() => (this._device = null)}>
            <house-rules-device .store=${s} .entityId=${this._device} closable @close=${() => (this._device = null)}></house-rules-device>
          </hr-sheet>`
        : nothing}
      ${this._modePop ? this._modeSheet() : nothing}
      ${this._toast
        ? html`<div class="toast" role="status">
            <span>${this._toast}</span>
            ${this._toastAction
              ? html`<button
                  class="toast-act"
                  @click=${() => {
                    const a = this._toastAction!;
                    this._toast = '';
                    this._toastAction = undefined;
                    a.run();
                  }}
                >
                  ${this._toastAction.label}
                </button>`
              : nothing}
          </div>`
        : nothing}
    `;
  }
}
customElements.define('house-rules-panel', HouseRulesPanel);
