/**
 * Where the UI gets its data from. Today: DemoStore (example data, nothing is switched).
 * Later: a store that talks to the integration over the websocket API (docs/API.md).
 */
import type { GlowGlobal, SensorCandidate, LightCalEntry, LightCalView, RoomPage, UiLayout, DeviceChange, ObjectAlarm, UnusedDevice, Me, Role, RoleUser, AutomationUser, RuleExport, RuleVersion, TrashItem, PlacesView, PlaceDetail, WindowWarningConfig, WindowWarningView, Features, FeatureId, SetupView, SetupSuggest, CleaningView, HeatPlan, HeatWindow, HeatExplain, HeatAssistant, LightPlan, PlansView, Resident, AiReview, AutoMode, ModeAutoView, WakeupView, AiPublic, AlarmConfig, AlarmMode, AlarmView, Behaviour, BehaviourId, Clause, Device, Group, HaAutomation, HistoryEntry, HouseMode, Person, Room, Rule, Suggestion, Zone, SimConfig, SimView, AssistantId, AssistantState, SmartLearned, HeatPlanView } from './model';
import { t } from './i18n';
import type { LampState } from './lightlive';
// i18n: complete

export interface TestResult {
  /** per clause of "when"/"and"/"only": does it hold right now? */
  checks: { section: 'when' | 'and' | 'only'; index: number; ok: boolean; now: string }[];
  /** what would happen if it ran now */
  would: string[];
  verdict: string;
}

export interface TextDraft {
  rule: Rule;
  /** parts of the text the model could not place */
  unsure: string[];
  /** ollama | ollama+basic | basic */
  source?: string;
  model?: string;
}

/** the default when the Reinschau-Licht may glow (as glow.py default_global) */
export const GLOW_GLOBAL: GlowGlobal = { dark: 'night', from: '20:00', to: '06:00', not_sleep: true, not_guests: false };

/** reference colours and whites of "Lampen abgleichen" (as lightcal.py) */
export const LIGHTCAL_COLORS: Record<string, [number, number]> = { rot: [0, 100], orange: [30, 100], gelb: [55, 100], gruen: [120, 100], tuerkis: [175, 100], blau: [225, 100], lila: [275, 100], pink: [320, 100] };
export const LIGHTCAL_WHITES: Record<string, number> = { warmweiss: 2700, neutralweiss: 4000, kaltweiss: 5500 };

export type HeatAction = 'exercise' | 'clear_manual' | 'takeover' | 'shadow' | 'accept_proposal' | 'reset_learning';

export abstract class Store extends EventTarget {
  abstract readonly demo: boolean;
  abstract rooms: Room[];
  abstract devices: Device[];
  abstract persons: Person[];
  abstract rules: Rule[];
  abstract automations: HaAutomation[];
  abstract history: HistoryEntry[];
  abstract suggestions: Suggestion[];
  abstract behaviours: Behaviour[];
  abstract mode: HouseMode;
  /** room id → occupied since / empty since (ISO) */
  abstract occupancy: Record<string, { occupied: boolean; since: string; by?: string; empty_at?: number; dark?: boolean; dark_why?: ('lux' | 'sun' | 'time')[]; bright_since?: number }>;
  abstract groups: Group[];
  abstract zones: Zone[];
  abstract alarm: AlarmView | null;
  abstract ai: AiPublic | null;
  modeAuto: ModeAutoView | null = null;
  /** page layout: rule groups, order and hidden room tiles (settings "ui") */
  ui: UiLayout = { grouping: 'auto', groups: [], room_order: [], room_hidden: {} };
  /** change the page layout (merged into what is there) */
  async saveUi(patch: Partial<UiLayout>): Promise<void> {
    this.ui = { ...this.ui, ...patch };
    this.dispatchEvent(new Event('change'));
  }
  /** rooms in the shared tile order; `page` given: without the rooms that page hides */
  orderedRooms(page?: RoomPage): Room[] {
    const order = this.ui.room_order;
    const pos = (id: string) => {
      const i = order.indexOf(id);
      return i < 0 ? order.length + this.rooms.findIndex((r) => r.id === id) : i;
    };
    const hidden = new Set(page ? (this.ui.room_hidden[page] ?? []) : []);
    return [...this.rooms].sort((a, b) => pos(a.id) - pos(b.id)).filter((r) => !hidden.has(r.id));
  }
  /** rooms a page hides */
  hiddenRooms(page: RoomPage): Room[] {
    const hidden = new Set(this.ui.room_hidden[page] ?? []);
    return this.rooms.filter((r) => hidden.has(r.id));
  }
  cleaning: CleaningView | null = null;
  plans: PlansView | null = null;
  async planSet(_kind: 'light' | 'heat', _room: string, _plan: LightPlan | HeatPlan): Promise<void> {}
  /** Raum einstellen → "Sensor suchen": every sensor a room can take as presence / motion, also ones without a fitting
   * device class; `ids`: exactly these (sensors already chosen that are not in the device list). Example data: the
   * presence / motion devices plus the extra sensors of the demo. */
  async sensorSearch(query: string, ids: string[] = []): Promise<SensorCandidate[]> {
    const all: SensorCandidate[] = [
      ...this.devices
        .filter((d) => d.kind === 'presence' || d.kind === 'motion')
        .map((d) => ({ entity_id: d.entity_id, name: d.name, state: d.state, room: d.room ?? null, room_name: this.room(d.room ?? '')?.name ?? null, kind: d.kind as 'presence' | 'motion' })),
      ...this.extraSensors,
    ];
    if (ids.length) return all.filter((c) => ids.includes(c.entity_id));
    const q = query.trim().toLowerCase();
    return all.filter((c) => !q || `${c.name} ${c.entity_id}`.toLowerCase().includes(q));
  }
  /** sensors Home Assistant has that are not in the device list (example data) */
  protected extraSensors: SensorCandidate[] = [];
  /** Lampen abgleichen (lightcal.py): the corrections per lamp; the example data keeps them in memory */
  protected calData: Record<string, LightCalEntry> = {};
  async lightcalGet(): Promise<LightCalView> {
    return { lights: this.calData, colors: LIGHTCAL_COLORS, whites: LIGHTCAL_WHITES };
  }
  /** merged: {entity_id: entry} or null to forget a lamp */
  async lightcalSet(lights: Record<string, LightCalEntry | null>): Promise<LightCalView> {
    const next = { ...this.calData };
    for (const [e, v] of Object.entries(lights)) {
      if (v === null) delete next[e];
      else next[e] = v;
    }
    this.calData = next;
    return this.lightcalGet();
  }
  /** Reinschau-Licht: when it may glow at all (one setting for every room) */
  async glowSet(glow: Partial<GlowGlobal>): Promise<void> {
    if (this.plans) this.plans = { ...this.plans, glow: { ...(this.plans.glow ?? GLOW_GLOBAL), ...glow } };
    this.dispatchEvent(new Event('change'));
  }
  async planHabits(_room: string): Promise<{ windows: HeatWindow[]; note: string }> {
    return { windows: [{ from: '05:45', to: '07:30', days: 'workdays', temp: 21 }, { from: '07:30', to: '10:00', days: 'weekend', temp: 21 }], note: t('panel.demo_habits') };
  }
  /** heating, house-wide (outside thermometer, summer, heat demand, valve exercise, reminders) */
  async heatingSet(_config: Record<string, unknown>): Promise<void> {}
  /** heating: 'exercise' = valve exercise now; 'clear_manual' = room back to its plan; smart heating: 'takeover'
   * (end shadow mode), 'shadow' (shadow mode again), 'accept_proposal', 'reset_learning' */
  async heatingDo(_action: HeatAction, _room?: string, _proposal?: string): Promise<void> {}
  /** "So denkt deine Heizung" of a room (`_house`: house-wide cost) */
  async heatingExplain(_room: string): Promise<HeatExplain | null> {
    return null;
  }
  /** what the heating assistant needs (rooms, valves, areas, energy) */
  /** the learned plan of a room (today, tomorrow, learned comfort and airing windows) */
  async heatingPlan(_room: string): Promise<HeatPlanView | null> {
    return null;
  }
  async heatingAssistant(): Promise<HeatAssistant | null> {
    return null;
  }
  residents: Resident[] = [];
  /** which parts are switched on (Einstellungen → Funktionen) */
  features: Features = { alarm: true, light: true, heating: true, vacation: true, mode_auto: true, vacuum: true, ai: true, behaviours: true, window_warning: true };
  /** Fenster-Warnung beim Gehen */
  windowWarning: WindowWarningView | null = null;
  async windowWarningSet(_config: Partial<WindowWarningConfig>): Promise<void> {}
  async windowWarningAck(): Promise<void> {}
  async windowWarningImport(_entry: Record<string, unknown>, _openings: Record<string, unknown>[], _source: string): Promise<void> {}
  /** excluded devices and vehicle parts (to use them again or assign them) */
  devicesUnused: UnusedDevice[] = [];
  /** object alarms ("Weitere Alarme": bike, car, garage …) */
  objects: ObjectAlarm[] = [];
  async objectSave(_obj: Partial<ObjectAlarm>): Promise<string> {
    return '';
  }
  async objectDelete(_id: string): Promise<void> {}
  async objectArm(_id: string): Promise<{ ok: boolean; error?: string }> {
    return { ok: true };
  }
  /** onlyAlarm: end the running alarm, the object stays armed; confirmed like the house alarm */
  async objectDisarm(_id: string, _opts: { code?: string; webauthn?: Record<string, string>; rpId?: string; onlyAlarm?: boolean } = {}): Promise<{ ok: boolean; error?: string | null; retry_in?: number }> {
    return { ok: true };
  }
  async objectTest(_id: string): Promise<void> {}
  /** Wo ist wer: persons, learned places (null = not known / older integration) */
  places: PlacesView | null = null;
  async placesPerson(_personId: string): Promise<PlaceDetail | null> {
    return null;
  }
  async placesName(_placeId: string, _name: string): Promise<void> {}
  async placesDelete(_placeId: string): Promise<void> {}
  async placesToZone(_placeId: string, _name: string): Promise<void> {}
  async placesSettings(_settings: Partial<PlacesView['settings']>): Promise<void> {}
  async placesRelearn(): Promise<void> {}
  async placesForget(): Promise<void> {}
  /** zones and learned places that rules can name ("Ort") */
  placeChoices(): { id: string; name: string; learned?: boolean }[] {
    return [...this.zones.map((z) => ({ id: z.id, name: z.name })), ...(this.places?.learned ?? []).map((p) => ({ id: p.id, name: p.label, learned: true }))];
  }
  placeName(id: string): string {
    return id === 'home' ? t('common.home_zone') : (this.placeChoices().find((p) => p.id === id)?.name ?? id);
  }
  /** setup wizard progress; null = not known (yet) */
  setup: SetupView | null = null;
  /** who uses the panel and their role (sent with every snapshot); null = not known (preview: admin) */
  me: Me | null = null;
  get role(): Role {
    return this.me?.role ?? 'admin';
  }
  /** the person using the panel may change settings (role admin) */
  get admin(): boolean {
    return this.role === 'admin';
  }
  /** may create and change rules and plans (admin or resident; guests only look and use) */
  get canEdit(): boolean {
    return this.role !== 'guest';
  }
  /** Home Assistant admin (may create automations in Home Assistant) */
  get haAdmin(): boolean {
    return this.me ? this.me.ha_admin : this.admin;
  }
  async ruleVersions(_id: string): Promise<RuleVersion[]> {
    return [];
  }
  async restoreVersion(_id: string, _version: string): Promise<void> {}
  async trashList(): Promise<TrashItem[]> {
    return [];
  }
  async trashRestore(_id: string): Promise<Rule | void> {}
  async trashPurge(_id?: string): Promise<void> {}
  async exportRule(_rule: Rule): Promise<RuleExport | null> {
    return null;
  }
  /** create the automation in Home Assistant (its config API, admins only), then switch the rule off here */
  async createAutomation(_ruleId: string, _exp: RuleExport): Promise<void> {}
  async rolesGet(): Promise<RoleUser[]> {
    return [];
  }
  async rolesSet(_userId: string, _role: Role): Promise<void> {}
  /** users that are other automation systems (Einstellungen → Rollen) */
  async automationUsersGet(): Promise<AutomationUser[]> {
    return [];
  }
  async automationUsersSet(_choice: Record<string, boolean>): Promise<void> {}
  on(f: FeatureId): boolean {
    return this.features[f] !== false;
  }
  async featuresSet(changes: Partial<Features>): Promise<void> {
    this.features = { ...this.features, ...changes } as Features;
    this.changed();
  }
  async setupSave(patch: { step?: string; answers?: Record<string, unknown>; done?: boolean; restart?: boolean }): Promise<void> {
    if (this.setup) this.setup = { ...this.setup, ...(patch.step ? { step: patch.step as SetupView['step'] } : {}), answers: { ...this.setup.answers, ...(patch.answers ?? {}) }, done: patch.restart ? false : patch.done ?? this.setup.done };
    this.changed();
  }
  async setupSuggest(): Promise<SetupSuggest | null> {
    return null;
  }
  async setupApply(_step: 'rooms' | 'light' | 'vacation' | 'modes', _data: Record<string, unknown>): Promise<unknown> {
    return { ok: true };
  }
  /** feature assistants: only the flag (done = finished or skipped, dismissed = "später") */
  async assistantMark(feature: AssistantId, flags: { done?: boolean; dismissed?: boolean }): Promise<void> {
    if (this.setup) this.setup = { ...this.setup, assistants: { ...this.setup.assistants, [feature]: { ...(this.setup.assistants?.[feature] ?? { done: false, dismissed: false, configured: false, at: null }), ...flags } as AssistantState } };
    this.changed();
  }
  /** what the assistant of a feature proposes from the real home; null in the preview */
  async assistantSuggest(_feature: AssistantId): Promise<Record<string, any> | null> {
    return null;
  }
  /** set the feature up from the answers (switches it on) and mark it done */
  async assistantApply(feature: AssistantId, _answers: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.assistantMark(feature, { done: true, dismissed: false });
    return { ok: true };
  }
  /** intelligent light: what was learned in a room */
  async lightLearned(_room: string): Promise<SmartLearned | null> {
    return null;
  }
  async lightForget(_room: string): Promise<void> {}
  /** any Home Assistant websocket command (e.g. lovelace/dashboards/list); null in the preview */
  async callHA<T>(_msg: Record<string, unknown>): Promise<T | null> {
    return null;
  }
  async cleaningSet(_config: Partial<CleaningView>): Promise<void> {}
  async residentsSet(_excluded: string[]): Promise<void> {}
  /** found phones that get no messages (notify service names) */
  async phonesSet(_excluded: string[]): Promise<void> {}
  async modeAutoSet(_mode: AutoMode | '_enabled', _config: Record<string, unknown>): Promise<void> {}
  /** "Aufstehen erkennen": settings, or forget what was learned */
  async wakeupSet(_config: Partial<Pick<WakeupView, 'on' | 'action' | 'feedback' | 'beds' | 'rooms'>>): Promise<void> {}
  async wakeupReset(): Promise<void> {}
  /** vacation simulation: 'view' (optionally a day), 'set' a config, 'learn' again now */
  async sim(_cmd: 'view' | 'set' | 'learn', _arg?: Partial<SimConfig> | string): Promise<SimView | null> {
    return null;
  }
  /** extra entities the alarm can use (cameras, sirens, speakers) that are not devices of a rule kind */
  extraEntities(_domain: string): { entity_id: string; name: string }[] {
    return [];
  }
  /** every entity of Home Assistant (for the "Alle Entitäten" tab) */
  allEntities(): { entity_id: string; name: string; state?: string }[] {
    return this.devices.map((d) => ({ entity_id: d.entity_id, name: d.name, state: d.state }));
  }
  entity(id: string): { entity_id: string; name: string; state?: string } | undefined {
    return this.allEntities().find((e) => e.entity_id === id);
  }
  /** example lamps for the preview: what light.turn_on did to them (nothing real is switched) */
  private readonly _lamps = new Map<string, LampState>();
  /** a lamp's state and attributes right now (live preview "Live an der Lampe", lightlive.ts) */
  lightState(id: string): LampState | undefined {
    const d = this.device(id);
    if (!d || !id.startsWith('light.')) return undefined;
    const on = d.state === 'on';
    return this._lamps.get(id) ?? { state: d.state, attributes: { supported_color_modes: ['color_temp', 'hs'], min_color_temp_kelvin: 2200, max_color_temp_kelvin: 6500, ...(on ? { color_mode: 'color_temp', brightness: 153, color_temp_kelvin: 2700 } : {}) } };
  }
  /** the integration's live preview (house_rules/light/preview); the example data has none: the panel sends itself */
  async lightPreview(_msg: Record<string, unknown>): Promise<unknown> {
    throw Object.assign(new Error('unknown_command'), { code: 'unknown_command' });
  }
  /** light.turn_on / turn_off for one lamp (live preview); with the example data it is only remembered */
  async lightCall(service: 'turn_on' | 'turn_off', id: string, data: Record<string, unknown>): Promise<void> {
    const st = this.lightState(id);
    if (!st) return;
    const a: Record<string, any> = { ...st.attributes };
    if (service === 'turn_off') {
      for (const k of ['color_mode', 'brightness', 'color_temp_kelvin', 'hs_color', 'rgb_color', 'xy_color', 'rgbw_color', 'rgbww_color', 'effect']) delete a[k];
      this._lamps.set(id, { state: 'off', attributes: a });
    } else {
      const bri = typeof data.brightness === 'number' ? data.brightness : typeof data.brightness_pct === 'number' ? Math.round(data.brightness_pct * 2.55) : typeof data.white === 'number' ? data.white : (a.brightness ?? 255);
      a.brightness = bri;
      const col = ['color_temp_kelvin', 'hs_color', 'rgb_color', 'xy_color', 'rgbw_color', 'rgbww_color'].find((k) => k in data);
      if (col) {
        for (const k of ['color_temp_kelvin', 'hs_color', 'rgb_color', 'xy_color', 'rgbw_color', 'rgbww_color']) delete a[k];
        a[col] = data[col];
        a.color_mode = col === 'color_temp_kelvin' ? 'color_temp' : col.replace('_color', '');
      } else if ('white' in data) a.color_mode = 'white';
      else a.color_mode ??= 'color_temp';
      if (typeof data.effect === 'string') a.effect = data.effect;
      this._lamps.set(id, { state: 'on', attributes: a });
    }
    this.changed();
  }

  abstract saveRule(rule: Rule): Promise<Rule | void>;
  abstract deleteRule(id: string): Promise<void>;
  abstract setEnabled(id: string, enabled: boolean): Promise<void>;
  abstract pause(id: string, until: string | null): Promise<void>;
  abstract runNow(id: string): Promise<void>;
  /** run the steps of a rule or draft for real, without trigger; index = only this step */
  async runActions(_rule: Rule, _index?: number): Promise<{ done: string[] }> {
    return { done: [t('panel.demo_nothing_switched')] };
  }
  abstract setMode(mode: HouseMode): Promise<void>;
  abstract saveRoom(room: Room): Promise<void>;
  abstract setBehaviourDefault(id: BehaviourId, on: boolean): Promise<void>;
  abstract dismissSuggestion(id: string): Promise<void>;
  /** show hidden suggestions again */
  async restoreSuggestions(): Promise<void> {}
  abstract test(rule: Rule): Promise<TestResult>;
  abstract fromText(text: string): Promise<TextDraft>;
  /** while-rule holds right now */
  abstract isActive(rule: Rule): boolean;
  /** occupied ranges of today in hours (0–24) */
  abstract today(roomId: string): [number, number][];
  /** correct kind or room of devices (kept by Hausregeln, not written into HA) */
  abstract setDevices(changes: DeviceChange[]): Promise<void>;
  /** switch an existing HA automation on/off */
  abstract setAutomation(entity_id: string, enabled: boolean): Promise<void>;
  abstract saveSettings(settings: Record<string, unknown>): Promise<void>;
  abstract saveGroup(group: Group): Promise<Group | void>;
  abstract deleteGroup(id: string): Promise<void>;
  abstract alarmArm(mode: AlarmMode, force?: boolean): Promise<{ ok: boolean; error?: string; open?: { entity_id: string; name: string }[] }>;
  abstract alarmDisarm(code?: string, webauthn?: Record<string, string>, rpId?: string): Promise<{ ok: boolean; error?: string | null }>;
  async alarmChallenge(): Promise<{ challenge: string; credentials: string[]; user: string }> {
    return { challenge: '', credentials: [], user: '' };
  }
  async alarmRegisterDevice(_payload: Record<string, string>, _name: string, _rpId: string, _code?: string): Promise<void> {}
  async alarmPreviewTone(_tone: string, _player: string): Promise<void> {}
  async alarmChannelTest(_channel: string): Promise<{ ok: boolean; errors: string[] }> {
    return { ok: true, errors: [t('panel.demo_nothing_sent')] };
  }
  async aiImprove(_text: string, _rule: Rule): Promise<{ changed: boolean; rule?: Rule; sentence?: string; note?: string; model?: string }> {
    return { changed: false, note: t('panel.demo_no_ai') };
  }
  async aiReview(_rule: Rule): Promise<AiReview> {
    return { verdict: 'hinweis', summary: t('panel.demo_no_ai'), notes: [] };
  }
  abstract alarmSilence(): Promise<void>;
  abstract alarmTest(): Promise<void>;
  abstract alarmConfig(config: Partial<AlarmConfig> & { code?: string | null }): Promise<void>;
  abstract alarmResetPin(): Promise<void>;
  abstract aiSet(ai: Partial<AiPublic> & { key?: string | null }): Promise<void>;
  abstract aiTest(ai: Partial<AiPublic> & { key?: string }): Promise<{ ok: boolean; error?: string | null; models: string[] }>;
  group(id: string): Group | undefined {
    return this.groups.find((g) => g.id === id);
  }
  zone(id: string): Zone | undefined {
    return this.zones.find((z) => z.id === id);
  }
  /** Ollama is set up (text assistant uses the language model) */
  get ollama(): boolean {
    return true;
  }

  device(id: string): Device | undefined {
    return this.devices.find((d) => d.entity_id === id);
  }
  room(id: string | undefined): Room | undefined {
    return this.rooms.find((r) => r.id === id);
  }
  rule(id: string): Rule | undefined {
    return this.rules.find((r) => r.id === id);
  }
  person(id: string): Person | undefined {
    return this.persons.find((p) => p.id === id);
  }

  /** Rules that mention a subject (device, room, person …) and how. */
  usage(subject: string): { rule: Rule; as: 'when' | 'and' | 'then' | 'only' }[] {
    const out: { rule: Rule; as: 'when' | 'and' | 'then' | 'only' }[] = [];
    const dev = this.device(subject);
    const hits = (c: Clause) => {
      if (c.subject === subject || c.subject === `zone:${subject}`) return true;
      if (!dev) return false;
      if (c.subject.startsWith('group:')) return !!this.group(c.subject.slice(6))?.members.includes(dev.entity_id);
      // placeholders: any:window@kuche covers every window in the kitchen
      const m = c.subject.match(/^(any|all):([a-z_]+)(?:@([a-z_*]+))?$/);
      return !!m && m[2] === dev.kind && (!m[3] || m[3] === 'same' || m[3] === dev.room);
    };
    for (const rule of this.rules)
      for (const as of ['when', 'and', 'then', 'only'] as const) if (rule[as].some(hits) || (as === 'then' && (rule.else ?? []).some(hits))) out.push({ rule, as });
    return out;
  }

  protected changed(): void {
    this.dispatchEvent(new Event('change'));
  }
}

export function newRule(partial: Partial<Rule> = {}): Rule {
  return {
    id: `r_${Math.random().toString(36).slice(2, 8)}`,
    name: '',
    type: 'when',
    when: [],
    and: [],
    then: [],
    only: [],
    enabled: true,
    options: { manual_pause: '' },
    meta: { origin: 'user', created: new Date().toISOString() },
    ...partial,
  };
}
