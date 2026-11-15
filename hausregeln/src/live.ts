/**
 * The live store: talks to the Hausregeln integration over Home Assistant's websocket
 * (house_rules/subscribe + commands, see docs/API.md) and adds live device states from hass.
 */
import { lightCaps } from './lightspec';
import type { DeviceChange, ObjectAlarm, Role, RoleUser, AutomationUser, RuleExport, RuleVersion, TrashItem, PlacesView, PlaceDetail, WindowWarningConfig, WindowWarningView, Features, SetupView, SetupSuggest, CleaningView, HeatPlan, HeatWindow, HeatExplain, HeatAssistant, LightPlan, PlansView, AiReview, AutoMode, ModeAutoView, WakeupView, AiPublic, AlarmConfig, AlarmMode, AlarmView, Behaviour, BehaviourId, Device, Group, HaAutomation, HistoryEntry, HouseMode, Person, Room, Rule, Suggestion, Zone, SimConfig, SimView, AssistantId, SmartLearned, HeatPlanView } from './model';
import { Store, type HeatAction, type TestResult, type TextDraft } from './store';
import { compare, getLanguage, intlLocale, setLanguageFrom, t, type I18nKey } from './i18n';
// i18n: complete

export interface HassLike {
  states: Record<string, { state: string; attributes: Record<string, any>; last_changed: string }>;
  connection: {
    subscribeMessage<T>(cb: (msg: T) => void, msg: Record<string, unknown>, opts?: { resubscribe?: boolean }): Promise<() => Promise<void>>;
  };
  callWS<T>(msg: Record<string, unknown>): Promise<T>;
  themes?: { darkMode?: boolean };
  user?: { is_admin?: boolean; name?: string };
  callApi?<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, data?: Record<string, unknown>): Promise<T>;
  /** the user's language (profile), then the system's */
  language?: string;
  locale?: { language?: string; time_format?: string; number_format?: string };
}

interface ServerDevice {
  entity_id: string;
  name: string;
  kind: string;
  room: string | null;
  kind_hint?: string;
  room_guess?: string;
  no_room?: 'set' | 'likely';
  auto_kind?: string | null;
  auto_room?: string | null;
  auto_name?: string;
  icon?: string;
  manual?: boolean;
  vehicle?: string;
}

export interface Settings {
  auto_mode?: boolean;
  eco_temp?: number;
  times?: Record<string, [number, number]>;
  ollama?: boolean;
  ai_connected?: boolean;
  features?: Features;
  /** Einstellungen → Benachrichtigungen (notify.py), see views/notify-settings.ts */
  notifications?: import('./views/notify-settings').NotifySettings;
  /** page layout (ui_layout.py) */
  ui?: Partial<import('./model').UiLayout>;
}

/** states with a word of their own: t(`panel.state_${state}`) */
const WORDS = new Set(['on', 'off', 'playing', 'paused', 'idle', 'standby', 'docked', 'cleaning', 'returning', 'heat', 'cool', 'auto', 'open', 'closed', 'opening', 'closing', 'locked', 'unlocked', 'unavailable', 'unknown']);
const word = (state: string): string | undefined => (WORDS.has(state) ? t(`panel.state_${state}` as I18nKey) : undefined);

/** Short live state for lists: "an · 60 %", "offen", "21,5 °C" */
export function stateText(kind: string, st: { state: string; attributes: Record<string, any> } | undefined): string | undefined {
  if (!st) return undefined;
  const a = st.attributes;
  const num = (v: unknown, d = 1) => (typeof v === 'number' ? new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: d }).format(v) : String(v));
  switch (kind) {
    case 'light':
      return st.state === 'on' && typeof a.brightness === 'number' ? t('panel.light_on_pct', { pct: Math.round((a.brightness / 255) * 100) }) : word(st.state) ?? st.state;
    case 'window':
    case 'door':
      return st.state === 'on' ? t('panel.state_open') : st.state === 'off' ? t('panel.state_closed') : word(st.state);
    case 'presence':
    case 'zone':
    case 'motion':
      return st.state === 'on' ? t('panel.state_someone') : st.state === 'off' ? t('panel.state_nobody') : word(st.state);
    case 'leak':
      return st.state === 'on' ? t('panel.state_wet') : st.state === 'off' ? t('panel.state_dry') : word(st.state);
    case 'climate':
      return [a.current_temperature != null ? `${num(a.current_temperature)} °C` : '', word(st.state) ?? st.state, a.temperature != null && st.state !== 'off' ? t('panel.target', { t: `${num(a.temperature)} °C` }) : ''].filter(Boolean).join(' · ');
    case 'temperature':
    case 'illuminance':
      return `${num(Number(st.state), 1)} ${a.unit_of_measurement ?? ''}`.trim();
    default:
      return word(st.state) ?? st.state;
  }
}

let shared: LiveStore | undefined;

/** One live store per page: the panel, the floorplan card and embedded editors share it. */
export function liveStore(hass: HassLike): LiveStore {
  const relang = setLanguageFrom(hass);
  if (!shared) shared = new LiveStore(hass);
  shared.setHass(hass);
  // everything that shows the store re-renders in the new language
  if (relang) shared.dispatchEvent(new Event('change'));
  return shared;
}

export class LiveStore extends Store {
  readonly demo = false;
  rooms: Room[] = [];
  devices: Device[] = [];
  persons: Person[] = [];
  rules: Rule[] = [];
  automations: HaAutomation[] = [];
  history: HistoryEntry[] = [];
  suggestions: Suggestion[] = [];
  behaviours: Behaviour[] = [];
  mode: HouseMode = 'home';
  occupancy: Store['occupancy'] = {};
  todayMap: Record<string, [number, number][]> = {};
  activeMap: Record<string, string[]> = {};
  settings: Settings = {};
  groups: Group[] = [];
  zones: Zone[] = [];
  alarm: AlarmView | null = null;
  ai: AiPublic | null = null;
  version = '';
  ready = false;
  error = '';
  hass: HassLike;
  private _server: ServerDevice[] = [];
  private _states: unknown;
  private _timer = 0;
  private _unsub?: Promise<() => Promise<void>>;

  /** stop listening (e.g. when the last element using the store goes away) */
  async dispose() {
    const u = await this._unsub;
    await u?.();
  }

  constructor(hass: HassLike) {
    super();
    this.hass = hass;
    this._subscribe();
  }

  private _subscribe() {
    this._unsub = this.hass.connection
      .subscribeMessage<Record<string, any>>((msg) => this._apply(msg), { type: 'house_rules/subscribe' })
      .catch((e: { message?: string; code?: string }) => {
        this.error = e?.code === 'unknown_command' ? 'not_installed' : e?.message || 'connection_failed';
        this.changed();
        return async () => {};
      });
  }

  /** Every server message and state refresh announces a change; elements redraw at most once per frame
   *  (a burst of history entries or updates must not redraw the whole panel for each one) */
  private _changeQueued = false;
  protected override changed(): void {
    if (this._changeQueued) return;
    this._changeQueued = true;
    requestAnimationFrame(() => {
      this._changeQueued = false;
      super.changed();
    });
  }

  setHass(hass: HassLike) {
    this.hass = hass;
    if (hass.states === this._states) return;
    this._states = hass.states;
    // device states change often: refresh at most twice a second
    if (!this._timer)
      this._timer = window.setTimeout(() => {
        this._timer = 0;
        this._mergeStates();
        this.changed();
      }, 500);
  }

  private _apply(msg: Record<string, any>) {
    if (msg.kind === 'history_add') {
      this.history = [msg.entry, ...this.history].slice(0, 300);
      this.changed();
      return;
    }
    const m = msg;
    if (m.rules) this.rules = m.rules;
    if (m.active) this.activeMap = m.active;
    if (m.rooms) this.rooms = m.rooms;
    if (m.occupancy) this.occupancy = m.occupancy;
    if (m.today) this.todayMap = m.today;
    if (m.devices) this._server = m.devices;
    if (m.devices_unused) this.devicesUnused = m.devices_unused;
    if (m.objects) this.objects = m.objects;
    if (m.persons) this.persons = m.persons;
    if (m.automations) this.automations = m.automations;
    if (m.history) this.history = m.history;
    if (m.suggestions) this.suggestions = m.suggestions;
    if (m.behaviours) this.behaviours = m.behaviours;
    if (m.mode) this.mode = m.mode;
    if (m.settings) {
      this.settings = m.settings;
      if (m.settings.ui) this.ui = { ...this.ui, ...m.settings.ui, room_hidden: m.settings.ui.room_hidden ?? {} };
    }
    if (m.groups) this.groups = m.groups;
    if (m.zones) this.zones = m.zones;
    if (m.alarm) this.alarm = m.alarm;
    if (m.ai) this.ai = m.ai;
    if (m.mode_auto) this.modeAuto = m.mode_auto;
    if (m.cleaning) this.cleaning = m.cleaning;
    if (m.plans) this.plans = m.plans;
    if (m.residents) this.residents = m.residents;
    if (m.features) this.features = m.features;
    if (m.setup) this.setup = m.setup;
    if (m.window_warning) this.windowWarning = m.window_warning;
    if (m.places) this.places = m.places;
    if (m.version) this.version = m.version;
    if (m.me) this.me = m.me;
    if (msg.kind === 'snapshot') this.ready = true;
    this._mergeStates();
    this.changed();
  }

  private _mergeStates() {
    const states = this.hass.states;
    this.devices = this._server.map((d) => {
      const st = states[d.entity_id];
      return {
        entity_id: d.entity_id,
        name: d.name,
        kind: d.kind,
        room: d.room ?? undefined,
        kind_hint: d.kind_hint,
        room_guess: d.room_guess,
        no_room: d.no_room,
        auto_kind: d.auto_kind,
        auto_room: d.auto_room,
        auto_name: d.auto_name,
        icon: d.icon,
        manual: d.manual,
        vehicle: d.vehicle,
        state: st?.state ?? 'unavailable',
        detail: stateText(d.kind, st),
        ...(d.entity_id.startsWith('light.') && st ? { light: lightCaps(st) } : {}),
      } as Device;
    });
    this.persons = this.persons.map((p) => {
      const st = states[(p as Person & { entity_id?: string }).entity_id ?? `person.${p.id}`];
      if (!st) return p;
      const home = st.state === 'home';
      return { ...p, home, zone: st.state, where: home ? t('panel.where_home') : st.state === 'not_home' ? t('panel.where_away') : st.state };
    });
  }

  // ------------------------------------------------------------------ store API
  private ws<T = unknown>(msg: Record<string, unknown>): Promise<T> {
    return this.hass.callWS<T>(msg);
  }
  override get ollama(): boolean {
    return !!this.settings.ai_connected;
  }
  override allEntities() {
    return Object.entries(this.hass.states)
      .filter(([id]) => !/^(persistent_notification|zone|sun|update|conversation|tts|stt|wake_word|assist_satellite|ai_task|todo)\./.test(id))
      .map(([entity_id, st]) => ({ entity_id, name: String(st.attributes.friendly_name ?? entity_id), state: st.state }));
  }
  override entity(id: string) {
    const st = this.hass.states[id];
    return st ? { entity_id: id, name: String(st.attributes.friendly_name ?? id), state: st.state } : undefined;
  }
  override lightState(id: string) {
    return id.startsWith('light.') ? this.hass.states[id] : undefined;
  }
  /** run by the integration (lightpreview.py); an older one answers "unknown_command" and the panel sends itself */
  override lightPreview(msg: Record<string, unknown>) {
    return this.ws({ type: 'house_rules/light/preview', ...msg });
  }
  /** fallback: straight to Home Assistant as the signed-in user (Home Assistant checks whether they may control it) */
  override async lightCall(service: 'turn_on' | 'turn_off', id: string, data: Record<string, unknown>) {
    if (!id.startsWith('light.')) return;
    await this.ws({ type: 'call_service', domain: 'light', service, service_data: data, target: { entity_id: id } });
  }
  override extraEntities(domain: string) {
    // "nicht verwenden" counts in these lists too (sirens, speakers, cameras …)
    const excluded = new Set(this.devicesUnused.filter((u) => u.reason === 'user').map((u) => u.entity_id));
    return Object.entries(this.hass.states)
      .filter(([id]) => id.startsWith(domain + '.') && !excluded.has(id))
      .map(([entity_id, st]) => ({ entity_id, name: String(st.attributes.friendly_name ?? entity_id) }))
      .sort((a, b) => compare(a.name, b.name));
  }
  async saveGroup(group: Group) {
    const res = await this.ws<{ group: Group }>({ type: 'house_rules/group/save', group });
    return res.group;
  }
  async deleteGroup(id: string) {
    await this.ws({ type: 'house_rules/group/delete', group_id: id });
  }
  async alarmArm(mode: AlarmMode, force = false) {
    return this.ws<{ ok: boolean; error?: string; open?: { entity_id: string; name: string }[] }>({ type: 'house_rules/alarm/arm', mode, force });
  }
  async alarmDisarm(code?: string, webauthn?: Record<string, string>, rpId?: string) {
    return this.ws<{ ok: boolean; error?: string | null }>({ type: 'house_rules/alarm/disarm', ...(code ? { code } : {}), ...(webauthn ? { webauthn, rp_id: rpId } : {}) });
  }
  override async alarmChallenge() {
    return this.ws<{ challenge: string; credentials: string[]; user: string }>({ type: 'house_rules/alarm/challenge' });
  }
  override async alarmRegisterDevice(payload: Record<string, string>, name: string, rpId: string, code?: string) {
    await this.ws({ type: 'house_rules/alarm/register_device', payload, name, rp_id: rpId, ...(code ? { code } : {}) });
  }
  override async planSet(kind: 'light' | 'heat', room: string, plan: LightPlan | HeatPlan) {
    this.plans = await this.ws<PlansView>({ type: 'house_rules/plan/set', kind, room, plan });
    this.changed();
  }
  override async lightcalGet() {
    return this.ws<import('./model').LightCalView>({ type: 'house_rules/lightcal/get' });
  }
  override async lightcalSet(lights: Record<string, import('./model').LightCalEntry | null>) {
    return this.ws<import('./model').LightCalView>({ type: 'house_rules/lightcal/set', lights });
  }
  override async glowSet(glow: Partial<import('./model').GlowGlobal>) {
    await super.glowSet(glow);
    await this.ws({ type: 'house_rules/glow/set', glow });
  }
  override async sim(cmd: 'view' | 'set' | 'learn', arg?: Partial<SimConfig> | string) {
    if (cmd === 'set') return this.ws<SimView>({ type: 'house_rules/sim/set', config: arg as Partial<SimConfig> });
    if (cmd === 'learn') return this.ws<SimView>({ type: 'house_rules/sim/learn' });
    return this.ws<SimView>({ type: 'house_rules/sim/view', ...(typeof arg === 'string' ? { day: arg } : {}) });
  }
  override async planHabits(room: string) {
    return this.ws<{ windows: HeatWindow[]; note: string }>({ type: 'house_rules/plan/habits', room });
  }
  override async heatingSet(config: Record<string, unknown>) {
    this.plans = await this.ws<PlansView>({ type: 'house_rules/heating/set', config });
    this.changed();
  }
  override async heatingDo(action: HeatAction, room?: string, proposal?: string) {
    await this.ws({ type: 'house_rules/heating/do', action, ...(room ? { room } : {}), ...(proposal ? { proposal } : {}) });
    if (action === 'accept_proposal' && proposal) this.suggestions = this.suggestions.filter((s) => s.id !== proposal);
    this.changed();
  }
  override async heatingExplain(room: string) {
    return this.ws<HeatExplain>({ type: 'house_rules/heating/explain', room });
  }
  override async heatingPlan(room: string) {
    return this.ws<HeatPlanView>({ type: 'house_rules/heating/plan', room });
  }
  override async heatingAssistant() {
    return this.ws<HeatAssistant>({ type: 'house_rules/heating/assistant' });
  }
  override async cleaningSet(config: Partial<CleaningView>) {
    this.cleaning = await this.ws<CleaningView>({ type: 'house_rules/cleaning/set', config });
    this.changed();
  }
  override async phonesSet(excluded: string[]) {
    await this.ws({ type: 'house_rules/settings/set', settings: { phones_excluded: excluded } });
  }
  override async residentsSet(excluded: string[]) {
    await this.ws({ type: 'house_rules/settings/set', settings: { persons_excluded: excluded } });
  }
  override async alarmChannelTest(channel: string) {
    return this.ws<{ ok: boolean; errors: string[] }>({ type: 'house_rules/alarm/channel_test', channel });
  }
  override async alarmPreviewTone(tone: string, player: string) {
    await this.ws({ type: 'house_rules/alarm/preview_tone', tone, player });
  }
  override async aiImprove(text: string, rule: Rule) {
    return this.ws<{ changed: boolean; rule?: Rule; sentence?: string; note?: string; model?: string }>({ type: 'house_rules/ai/improve', text, rule });
  }
  override async aiReview(rule: Rule) {
    return this.ws<AiReview>({ type: 'house_rules/ai/review', rule });
  }
  async alarmSilence() {
    await this.ws({ type: 'house_rules/alarm/silence' });
  }
  async alarmTest() {
    await this.ws({ type: 'house_rules/alarm/test' });
  }
  async alarmConfig(config: Partial<AlarmConfig> & { code?: string | null }) {
    this.alarm = await this.ws<AlarmView>({ type: 'house_rules/alarm/config', config });
    this.changed();
  }
  async alarmResetPin() {
    await this.ws({ type: 'call_service', domain: 'roomwise', service: 'reset_alarm_pin', service_data: {} });
  }
  override async modeAutoSet(mode: AutoMode | '_enabled', config: Record<string, unknown>) {
    this.modeAuto = await this.ws<ModeAutoView>({ type: 'house_rules/mode_auto/set', mode, config });
    this.changed();
  }
  override async wakeupSet(config: Partial<Pick<WakeupView, 'on' | 'action' | 'feedback' | 'beds' | 'rooms'>>) {
    this.modeAuto = await this.ws<ModeAutoView>({ type: 'house_rules/wakeup/set', config });
    this.changed();
  }
  override async wakeupReset() {
    this.modeAuto = await this.ws<ModeAutoView>({ type: 'house_rules/wakeup/reset' });
    this.changed();
  }
  async aiSet(ai: Partial<AiPublic> & { key?: string | null }) {
    this.ai = await this.ws<AiPublic>({ type: 'house_rules/ai/set', ai });
    this.changed();
  }
  async aiTest(ai: Partial<AiPublic> & { key?: string }) {
    return this.ws<{ ok: boolean; error?: string | null; models: string[] }>({ type: 'house_rules/ai/test', ai });
  }
  isActive(rule: Rule): boolean {
    return !!this.activeMap[rule.id]?.length;
  }
  today(roomId: string): [number, number][] {
    return this.todayMap[roomId] ?? [];
  }
  async saveRule(rule: Rule) {
    const res = await this.ws<{ rule: Rule }>({ type: 'house_rules/rule/save', rule });
    const i = this.rules.findIndex((r) => r.id === res.rule.id);
    this.rules = i < 0 ? [res.rule, ...this.rules] : this.rules.map((r) => (r.id === res.rule.id ? res.rule : r));
    this.changed();
    return res.rule;
  }
  async deleteRule(id: string) {
    await this.ws({ type: 'house_rules/rule/delete', rule_id: id });
  }
  async setEnabled(id: string, enabled: boolean) {
    this.rules = this.rules.map((r) => (r.id === id ? { ...r, enabled } : r));
    this.changed();
    await this.ws({ type: 'house_rules/rule/enable', rule_id: id, enabled });
  }
  async pause(id: string, until: string | null) {
    await this.ws({ type: 'house_rules/rule/pause', rule_id: id, until });
  }
  override async runActions(rule: Rule, index?: number) {
    return this.ws<{ done: string[] }>({ type: 'house_rules/rule/run_actions', rule, ...(index !== undefined ? { index } : {}) });
  }
  async runNow(id: string) {
    await this.ws({ type: 'house_rules/rule/run', rule_id: id });
  }
  async setMode(mode: HouseMode) {
    this.mode = mode;
    this.changed();
    await this.ws({ type: 'house_rules/mode/set', mode });
  }
  async saveRoom(room: Room) {
    this.rooms = this.rooms.map((r) => (r.id === room.id ? room : r));
    this.changed();
    await this.ws({ type: 'house_rules/room/save', room });
  }
  async setBehaviourDefault(id: BehaviourId, on: boolean) {
    this.behaviours = this.behaviours.map((b) => (b.id === id ? { ...b, all: on } : b));
    this.changed();
    await this.ws({ type: 'house_rules/behaviour/set', behaviour: id, on });
  }
  override async restoreSuggestions() {
    await this.ws({ type: 'house_rules/suggestion/restore' });
  }
  async dismissSuggestion(id: string) {
    this.suggestions = this.suggestions.filter((s) => s.id !== id);
    this.changed();
    await this.ws({ type: 'house_rules/suggestion/dismiss', suggestion_id: id });
  }
  async test(rule: Rule): Promise<TestResult> {
    return this.ws<TestResult>({ type: 'house_rules/rule/test', rule });
  }
  async fromText(text: string): Promise<TextDraft> {
    return this.ws<TextDraft>({ type: 'house_rules/from_text', text, language: getLanguage() });
  }
  async setDevices(changes: DeviceChange[]) {
    await this.ws({ type: 'house_rules/devices/set', changes });
  }
  override async objectSave(obj: Partial<ObjectAlarm>) {
    const res = await this.ws<{ id: string; objects: ObjectAlarm[] }>({ type: 'house_rules/objects/save', object: obj });
    this.objects = res.objects;
    this.changed();
    return res.id;
  }
  override async objectDelete(id: string) {
    await this.ws({ type: 'house_rules/objects/delete', object_id: id });
  }
  override async objectArm(id: string) {
    return this.ws<{ ok: boolean; error?: string }>({ type: 'house_rules/objects/arm', object_id: id });
  }
  override async objectDisarm(id: string, opts: { code?: string; webauthn?: Record<string, string>; rpId?: string; onlyAlarm?: boolean } = {}) {
    return this.ws<{ ok: boolean; error?: string | null; retry_in?: number }>({
      type: 'house_rules/objects/disarm',
      object_id: id,
      only_alarm: !!opts.onlyAlarm,
      ...(opts.code ? { code: opts.code } : {}),
      ...(opts.webauthn ? { webauthn: opts.webauthn, rp_id: opts.rpId } : {}),
    });
  }
  override async objectTest(id: string) {
    await this.ws({ type: 'house_rules/objects/test', object_id: id });
  }
  async setAutomation(entity_id: string, enabled: boolean) {
    await this.ws({ type: 'house_rules/automation/enable', entity_id, enabled });
  }
  override get admin(): boolean {
    return this.me ? this.me.role === 'admin' : this.hass.user?.is_admin !== false;
  }
  override get haAdmin(): boolean {
    return this.me ? this.me.ha_admin : this.hass.user?.is_admin !== false;
  }
  override async ruleVersions(id: string) {
    return this.ws<RuleVersion[]>({ type: 'house_rules/rule/versions', rule_id: id });
  }
  override async restoreVersion(id: string, version: string) {
    await this.ws({ type: 'house_rules/rule/restore_version', rule_id: id, version });
  }
  override async trashList() {
    return this.ws<TrashItem[]>({ type: 'house_rules/trash/list' });
  }
  override async trashRestore(id: string) {
    const res = await this.ws<{ rule: Rule }>({ type: 'house_rules/trash/restore', rule_id: id });
    return res.rule;
  }
  override async trashPurge(id?: string) {
    await this.ws({ type: 'house_rules/trash/purge', ...(id ? { rule_id: id } : {}) });
  }
  override async exportRule(rule: Rule) {
    return this.ws<RuleExport>(this.rule(rule.id) ? { type: 'house_rules/rule/export', rule_id: rule.id } : { type: 'house_rules/rule/export', rule });
  }
  override async createAutomation(ruleId: string, exp: RuleExport) {
    if (!this.hass.callApi) throw new Error(t('rel.no_callapi'));
    // Home Assistant's own automation config API (admins only): writes automations.yaml and reloads
    await this.hass.callApi('POST', `config/automation/config/${encodeURIComponent(exp.id)}`, exp.automation);
    await this.ws({ type: 'house_rules/rule/exported', rule_id: ruleId, automation_id: exp.id });
  }
  override async rolesGet() {
    return (await this.ws<{ users: RoleUser[] }>({ type: 'house_rules/roles/get' })).users;
  }
  override async rolesSet(userId: string, role: Role) {
    await this.ws({ type: 'house_rules/roles/set', user_id: userId, role });
  }
  override async automationUsersGet() {
    return (await this.ws<{ automation_users?: AutomationUser[] }>({ type: 'house_rules/roles/get' })).automation_users ?? [];
  }
  override async automationUsersSet(choice: Record<string, boolean>) {
    await this.ws({ type: 'house_rules/settings/set', settings: { automation_users: choice } });
  }
  override async featuresSet(changes: Partial<Features>) {
    this.features = { ...this.features, ...changes } as Features;
    this.changed();
    this.features = await this.ws<Features>({ type: 'house_rules/features/set', features: changes });
    this.changed();
  }
  override async setupSave(patch: { step?: string; answers?: Record<string, unknown>; done?: boolean; restart?: boolean }) {
    this.setup = await this.ws<SetupView>({ type: 'house_rules/setup/save', ...patch });
    this.changed();
  }
  override async setupSuggest() {
    return this.ws<SetupSuggest>({ type: 'house_rules/setup/suggest' });
  }
  override async setupApply(step: 'rooms' | 'light' | 'vacation' | 'modes', data: Record<string, unknown>) {
    return this.ws({ type: 'house_rules/setup/apply', step, data });
  }
  override async windowWarningSet(config: Partial<WindowWarningConfig>) {
    this.windowWarning = await this.ws<WindowWarningView>({ type: 'house_rules/window_warning/set', config });
    this.changed();
  }
  override async windowWarningAck() {
    await this.ws({ type: 'house_rules/window_warning/ack' });
  }
  override async windowWarningImport(entry_alert: Record<string, unknown>, openings: Record<string, unknown>[], source: string) {
    this.windowWarning = await this.ws<WindowWarningView>({ type: 'house_rules/window_warning/import', entry_alert, openings, source });
    this.changed();
  }
  override async placesPerson(personId: string) {
    return this.ws<PlaceDetail>({ type: 'house_rules/places/person', person_id: personId });
  }
  private _placesSet(v: PlacesView) {
    this.places = v;
    this.changed();
  }
  override async placesName(placeId: string, name: string) {
    this._placesSet(await this.ws<PlacesView>({ type: 'house_rules/places/name', place_id: placeId, name }));
  }
  override async placesDelete(placeId: string) {
    this._placesSet(await this.ws<PlacesView>({ type: 'house_rules/places/delete', place_id: placeId }));
  }
  override async placesToZone(placeId: string, name: string) {
    await this.ws({ type: 'house_rules/places/to_zone', place_id: placeId, name });
  }
  override async placesSettings(settings: Partial<PlacesView['settings']>) {
    await this.ws({ type: 'house_rules/places/settings', ...settings });
  }
  override async placesRelearn() {
    await this.ws({ type: 'house_rules/places/relearn' });
  }
  override async placesForget() {
    this._placesSet(await this.ws<PlacesView>({ type: 'house_rules/places/forget' }));
  }
  override async assistantMark(feature: AssistantId, flags: { done?: boolean; dismissed?: boolean }) {
    const assistants = await this.ws<NonNullable<SetupView['assistants']>>({ type: 'house_rules/assistant/mark', feature, ...flags });
    if (this.setup) this.setup = { ...this.setup, assistants };
    this.changed();
  }
  override async assistantSuggest(feature: AssistantId) {
    return this.ws<Record<string, any>>({ type: 'house_rules/assistant/suggest', feature });
  }
  override async assistantApply(feature: AssistantId, answers: Record<string, unknown>) {
    return this.ws<Record<string, unknown>>({ type: 'house_rules/assistant/apply', feature, answers });
  }
  override async lightLearned(room: string) {
    return this.ws<SmartLearned>({ type: 'house_rules/light/learned', room });
  }
  override async lightForget(room: string) {
    await this.ws({ type: 'house_rules/light/forget', room });
  }
  override async callHA<T>(msg: Record<string, unknown>) {
    return this.ws<T>(msg);
  }
  override async saveUi(patch: Partial<import('./model').UiLayout>) {
    await super.saveUi(patch);
    await this.ws({ type: 'house_rules/ui/set', ui: patch });
  }

  async saveSettings(settings: Record<string, unknown>) {
    await this.ws({ type: 'house_rules/settings/set', settings });
  }
}
