/**
 * Example data for the UI preview. Names follow the real home (rooms, devices, people),
 * states and rules are made up. Nothing here talks to Home Assistant.
 */
import type { HeatingView, PlacesView } from '../model';
import type { DeviceChange, ObjectAlarm, UnusedDevice, SetupView, SetupSuggest, WindowWarningConfig, WindowWarningView, SimConfig, SimSegment, SimView, HeatPlan, LightPlan, PlansView, AutoMode, ModeAutoView, WakeupView, AiPublic, AlarmConfig, AlarmMode, AlarmView, Behaviour, BehaviourId, Device, Group, HaAutomation, HistoryEntry, HouseMode, Person, Room, Rule, Suggestion, TrashItem, Zone } from '../model';
import { Store, newRule, type TestResult, type TextDraft } from '../store';
import { clauseText } from '../describe';
import { mdiAutoFix, mdiDoorClosed, mdiFloorPlan, mdiHomeAccount, mdiLightbulbGroup, mdiRadiator, mdiTelevision } from '@mdi/js';

const ago = (min: number) => new Date(Date.now() - min * 60000).toISOString();
const tomorrowAt = (h: number) => {
  const d = new Date(Date.now() + 86400000);
  d.setHours(h, 0, 0, 0);
  return d.toISOString();
};

const D = (entity_id: string, name: string, kind: string, room: string | undefined, state: string, extra: Partial<Device> = {}): Device => ({
  entity_id,
  name,
  kind,
  room,
  state,
  ...extra,
});

const FP_K = 'binary_sensor.praesenz_kuche_zone_';
const FP_W = 'binary_sensor.praesenz_wohnzimmer_zone_';
const FP_S = 'binary_sensor.praesenz_schlafzimmer_zone_';
const KETTLE = 'switch.wasserkocher';
const TV = 'binary_sensor.fernseher_an';

const devices: Device[] = [
  // Flur
  D('light.flurlicht', 'Flurlicht', 'light', 'flur', 'off'),
  D('light.flur_tuer', 'Flurtür', 'light', 'flur', 'off'),
  D('light.flur_fenster', 'Flurfenster', 'light', 'flur', 'off'),
  D('binary_sensor.haustuer', 'Haustür', 'door', 'flur', 'off'),
  D('binary_sensor.praesenzmelder_flur', 'Anwesenheit Flur', 'presence', 'flur', 'off'),
  D('sensor.praesenzmelder_flur_helligkeit', 'Helligkeit Flur', 'illuminance', 'flur', '758', { detail: '758 lx' }),
  D('switch.wandtablet_display', 'Wandtablet-Bildschirm', 'switch', 'flur', 'off'),
  D('switch.ladegeraet_flur', 'Ladegerät Flur', 'outlet', 'flur', 'off'),
  // Küche
  D('light.kueche_decke', 'Küchenlicht', 'light', 'kuche', 'off'),
  D('light.kueche_arbeitsplatte', 'Arbeitsfläche', 'light', 'kuche', 'off'),
  D('light.kuechentisch', 'Küchentisch', 'light', 'kuche', 'off'),
  D('light.kueche_hintergrund', 'Hintergrundbeleuchtung', 'light', 'kuche', 'off'),
  D('binary_sensor.fenster_kueche', 'Fenster Küche', 'window', 'kuche', 'on', { kind_hint: 'door' }),
  D('binary_sensor.tuer_kueche', 'Küchentür', 'door', 'kuche', 'unavailable'),
  D(`${FP_K}1`, 'Küche (ganzer Raum)', 'presence', 'kuche', 'off'),
  D(`${FP_K}4`, 'Kochfeld', 'zone', 'kuche', 'off'),
  D(`${FP_K}2`, 'Essbereich', 'zone', 'kuche', 'off'),
  D(`${FP_K}3`, 'Kücheneingang', 'zone', 'kuche', 'off'),
  D('sensor.helligkeit_kuche', 'Helligkeit Küche', 'illuminance', 'kuche', '48', { detail: '48 lx' }),
  D('climate.heizung_kuche', 'Heizung Küche', 'climate', 'kuche', 'off', { detail: '20,5 °C' }),
  D(KETTLE, 'Wasserkocher', 'outlet', 'kuche', 'off'),
  D('binary_sensor.wasserleck_kueche', 'Wassermelder Küche', 'leak', 'kuche', 'off'),
  D('vacuum.saugroboter', 'Saugroboter', 'vacuum', 'kuche', 'docked'),
  D('media_player.kueche_lautsprecher', 'Lautsprecher Küche', 'media', 'kuche', 'idle'),
  // Wohnzimmer
  D('light.wohnzimmer_decke', 'Wohnzimmerlicht', 'light', 'wohnzimmer', 'off'),
  D('light.sofalicht', 'Sofalicht', 'light', 'wohnzimmer', 'on', { detail: '60 %' }),
  D('light.deckenleuchte_wohnzimmer', 'Deckenleuchte', 'light', 'wohnzimmer', 'off'),
  D('light.fernsehbeleuchtung', 'Fernsehbeleuchtung', 'light', 'wohnzimmer', 'off'),
  D('light.stehlampe', 'Stehlampe', 'light', 'wohnzimmer', 'off'),
  D('binary_sensor.fenster_wohnzimmer_1', 'Fenster Wohnzimmer links', 'window', 'wohnzimmer', 'off', { kind_hint: 'door' }),
  D('binary_sensor.fenster_wohnzimmer_2', 'Fenster Wohnzimmer rechts', 'window', 'wohnzimmer', 'off', { kind_hint: 'door' }),
  D('binary_sensor.tuer_wohnzimmer', 'Wohnzimmertür', 'door', 'wohnzimmer', 'on'),
  D(`${FP_W}1`, 'Wohnzimmer (ganzer Raum)', 'presence', 'wohnzimmer', 'on'),
  D(`${FP_W}3`, 'Sofa', 'zone', 'wohnzimmer', 'on'),
  D(`${FP_W}2`, 'Schreibtisch', 'zone', 'wohnzimmer', 'off'),
  D(`${FP_W}4`, 'Wohnzimmereingang', 'zone', 'wohnzimmer', 'off'),
  D('sensor.helligkeit_wohnzimmer', 'Helligkeit Wohnzimmer', 'illuminance', 'wohnzimmer', '279', { detail: '279 lx' }),
  D('climate.heizung_wohnzimmer', 'Heizung Wohnzimmer', 'climate', 'wohnzimmer', 'heat', { detail: '21 °C' }),
  D('media_player.wohnzimmer_tv', 'Streaming-Box', 'media', 'wohnzimmer', 'off'),
  D(TV, 'Fernseher', 'media', 'wohnzimmer', 'off'),
  D('media_player.wohnzimmer_smartspeaker', 'Smart Speaker Wohnzimmer', 'media', 'wohnzimmer', 'idle'),
  D('media_player.wohnzimmer_lautsprecher', 'Lautsprecher', 'media', 'wohnzimmer', 'idle'),
  D('script.lautsprecher_eingang_wechseln', 'Lautsprecher: Eingang wechseln', 'script', 'wohnzimmer', 'off'),
  D('fan.luftreiniger_wohnzimmer', 'Luftreiniger Wohnzimmer', 'purifier', 'wohnzimmer', 'off'),
  // Schlafzimmer
  D('light.schlafzimmer', 'Schlafzimmerlicht', 'light', 'schlafzimmer', 'off'),
  D('light.schlafzimmerlampe', 'Schlafzimmerlampe', 'light', 'schlafzimmer', 'off'),
  D('light.kleines_licht', 'Kleines Licht', 'light', 'schlafzimmer', 'off'),
  D('light.nachttischlampe', 'Nachttischlampe', 'light', 'schlafzimmer', 'off'),
  D('light.schlafzimmer_nachttisch', 'Bett', 'light', 'schlafzimmer', 'off'),
  D('binary_sensor.fenster_schlafzimmer', 'Fenster Schlafzimmer', 'window', 'schlafzimmer', 'off', { kind_hint: 'door' }),
  D('binary_sensor.tuer_schlafzimmer', 'Schlafzimmertür', 'door', 'schlafzimmer', 'on'),
  D(`${FP_S}1`, 'Schlafzimmer (ganzer Raum)', 'presence', 'schlafzimmer', 'off'),
  D(`${FP_S}2`, 'Bett', 'zone', 'schlafzimmer', 'off'),
  D(`${FP_S}6`, 'Bettfuß', 'zone', 'schlafzimmer', 'off'),
  D(`${FP_S}4`, 'Teppich', 'zone', 'schlafzimmer', 'off'),
  D('binary_sensor.bewegung_schlafzimmer', 'Bewegung Schlafzimmer', 'motion', 'schlafzimmer', 'off'),
  D('sensor.helligkeit_schlafzimmer', 'Helligkeit Schlafzimmer', 'illuminance', 'schlafzimmer', '369', { detail: '369 lx' }),
  D('climate.heizung_schlafzimmer', 'Heizung Schlafzimmer', 'climate', 'schlafzimmer', 'off', { detail: '19 °C' }),
  D('fan.luftreiniger_schlafzimmer', 'Luftreiniger Schlafzimmer', 'purifier', 'schlafzimmer', 'on'),
  D('switch.steckdose_schlafzimmer', 'Steckdose Schlafzimmer', 'outlet', 'schlafzimmer', 'off'),
  // Bad
  D('binary_sensor.fenster_bad', 'Fenster Bad', 'window', 'bad', 'off', { kind_hint: 'door' }),
  D('binary_sensor.tuer_bad', 'Badtür', 'door', 'bad', 'off'),
  D('climate.heizung_bad', 'Heizung Bad', 'climate', 'bad', 'off', { detail: '22 °C' }),
];

const rooms: Room[] = [
  {
    id: 'flur',
    name: 'Flur',
    in: 'im Flur',
    icon: mdiDoorClosed,
    presence: ['binary_sensor.praesenzmelder_flur'],
    motion: [],
    doors: ['binary_sensor.haustuer'],
    zones: [],
    lux: 'sensor.praesenzmelder_flur_helligkeit',
    dark_below: 50,
    empty_after: 2,
    door_logic: false,
    behaviours: {},
  },
  {
    id: 'kuche',
    name: 'Küche',
    in: 'in der Küche',
    icon: 'M19 4V2H5V4H19M19 5H5C3.9 5 3 5.9 3 7V20C3 21.1 3.9 22 5 22H19C20.1 22 21 21.1 21 20V7C21 5.9 20.1 5 19 5M8 8H10V11H8V8M19 20H5V13H19V20Z',
    presence: [`${FP_K}1`],
    motion: [],
    doors: ['binary_sensor.tuer_kueche'],
    zones: [`${FP_K}4`, `${FP_K}2`, `${FP_K}3`],
    lux: 'sensor.helligkeit_kuche',
    dark_below: 80,
    empty_after: 5,
    door_logic: false,
    behaviours: { heat_eco_empty: true },
  },
  {
    id: 'wohnzimmer',
    name: 'Wohnzimmer',
    in: 'im Wohnzimmer',
    icon: 'M21 9V7C21 5.35 19.65 4 18 4H14C13.23 4 12.53 4.3 12 4.78C11.47 4.3 10.77 4 10 4H6C4.35 4 3 5.35 3 7V9C1.35 9 0 10.35 0 12V17C0 18.65 1.35 20 3 20V22H5V20H19V22H21V20C22.65 20 24 18.65 24 17V12C24 10.35 22.65 9 21 9M14 6H18C18.55 6 19 6.45 19 7V9.78C18.39 10.33 18 11.12 18 12V14H13V7C13 6.45 13.45 6 14 6M5 7C5 6.45 5.45 6 6 6H10C10.55 6 11 6.45 11 7V14H6V12C6 11.12 5.61 10.33 5 9.78V7M22 17C22 17.55 21.55 18 21 18H3C2.45 18 2 17.55 2 17V12C2 11.45 2.45 11 3 11S4 11.45 4 12V16H20V12C20 11.45 20.45 11 21 11S22 11.45 22 12V17Z',
    presence: [`${FP_W}1`],
    motion: [],
    doors: ['binary_sensor.tuer_wohnzimmer'],
    zones: [`${FP_W}3`, `${FP_W}2`, `${FP_W}4`],
    lux: 'sensor.helligkeit_wohnzimmer',
    dark_below: 120,
    empty_after: 10,
    door_logic: false,
    behaviours: { media_pause_empty: true },
  },
  {
    id: 'schlafzimmer',
    name: 'Schlafzimmer',
    in: 'im Schlafzimmer',
    icon: 'M19,7H11V14H3V5H1V20H3V17H21V20H23V11A4,4 0 0,0 19,7M7,13A3,3 0 0,0 10,10A3,3 0 0,0 7,7A3,3 0 0,0 4,10A3,3 0 0,0 7,13Z',
    presence: [`${FP_S}1`],
    motion: ['binary_sensor.bewegung_schlafzimmer'],
    doors: ['binary_sensor.tuer_schlafzimmer'],
    zones: [`${FP_S}2`, `${FP_S}6`, `${FP_S}4`],
    lux: 'sensor.helligkeit_schlafzimmer',
    dark_below: 60,
    empty_after: 5,
    door_logic: false,
    behaviours: { light_on_enter: false },
  },
  {
    id: 'bad',
    name: 'Bad',
    in: 'im Bad',
    icon: 'M21,14V15C21,16.91 19.93,18.57 18.35,19.41L19,22H17L16.5,20C16.33,20 16.17,20 16,20H8C7.83,20 7.67,20 7.5,20L7,22H5L5.65,19.41C4.07,18.57 3,16.91 3,15V14H2V12H20V5A1,1 0 0,0 19,4C18.5,4 18.12,4.34 18,4.79C18.63,5.33 19,6.13 19,7H13A3,3 0 0,1 16,4C16.06,4 16.11,4 16.16,4C16.57,2.84 17.69,2 19,2A3,3 0 0,1 22,5V14H21Z',
    presence: [],
    motion: [],
    doors: ['binary_sensor.tuer_bad'],
    zones: [],
    empty_after: 3,
    door_logic: true,
    behaviours: {},
  },
];

const behaviours: Behaviour[] = [
  { id: 'light_on_enter', title: 'Licht an beim Reinkommen', detail: 'Nur wenn es im Raum dunkel ist', icon: mdiLightbulbGroup, all: true },
  { id: 'light_off_empty', title: 'Licht aus, wenn der Raum leer ist', detail: 'Nach der Wartezeit des Raums', icon: mdiLightbulbGroup, all: true },
  { id: 'night_dim', title: 'Nachts nur sanftes Licht', detail: '22–6 Uhr höchstens 10 %, warmweiß', icon: mdiLightbulbGroup, all: true },
  { id: 'heat_eco_empty', title: 'Heizung sparen, wenn länger leer', detail: 'Nach 1 Std. auf Sparen, beim Reinkommen zurück', icon: mdiRadiator, all: false },
  { id: 'media_pause_empty', title: 'Musik pausieren, wenn keiner mehr da ist', detail: 'Läuft weiter, sobald jemand zurückkommt', icon: mdiTelevision, all: false },
];

const persons: Person[] = [
  { id: 'alex', name: 'Alex', home: true, where: 'Zuhause', phone: 'iPhone 14 Pro', entity_id: 'person.alex', zone: 'home' },
  { id: 'sam', name: 'Sam', home: false, where: 'Sam Arbeit', phone: 'iPhone', entity_id: 'person.sam', zone: 'Sam Arbeit' },
];

const R = (p: Partial<Rule> & Pick<Rule, 'id' | 'name'>): Rule => newRule({ ...p, options: { manual_pause: '1h', ...p.options } });

const rules: Rule[] = [
  R({
    id: 'r_heim',
    group: 'g_kommen',
    name: 'Licht beim Heimkommen',
    when: [{ subject: 'binary_sensor.haustuer', verb: 'opens' }],
    then: [{ subject: 'light.flurlicht', verb: 'turn_on', brightness: 70, for: '5m' }],
    only: [
      { subject: 'sun', verb: 'is_down' },
      { subject: 'mode', verb: 'is_not', mode: 'vacation' },
    ],
    tags: ['light'],
    meta: { last_run: ago(60 * 19 + 12), runs_week: 6 },
  }),
  R({
    id: 'r_tablet',
    group: 'g_kommen',
    name: 'Wandtablet an, wenn jemand im Flur ist',
    type: 'while',
    when: [{ subject: 'room:flur', verb: 'is_occupied' }],
    then: [{ subject: 'switch.wandtablet_display', verb: 'turn_on' }],
    tags: ['presence'],
    meta: {
      last_run: ago(8),
      runs_week: 41,
      origin: 'suggestion',
      replaces: ['automation.beispiel_display_an', 'automation.beispiel_display_aus'],
    },
  }),
  R({
    id: 'r_fenster_heizung',
    group: 'g_sicher',
    name: 'Heizung aus bei offenem Fenster',
    type: 'while',
    when: [{ subject: 'any:window', verb: 'is_open', for: '2m' }],
    then: [{ subject: 'all:climate@same', verb: 'turn_off' }],
    tags: ['heating'],
    meta: { last_run: ago(35), runs_week: 9 },
  }),
  R({
    id: 'r_fenster_weg',
    group: 'g_kommen',
    name: 'Fenster offen beim Gehen',
    when: [{ subject: 'person:everyone', verb: 'leaves' }],
    and: [{ subject: 'any:window', verb: 'is_open' }],
    then: [{ subject: 'notify:everyone', verb: 'send', message: 'Es ist noch ein Fenster offen.' }],
    tags: ['safety'],
    meta: { last_run: ago(60 * 30), runs_week: 1 },
  }),
  R({
    id: 'r_wasserkocher',
    group: 'g_sicher',
    name: 'Steckdose nach 30 Minuten aus',
    when: [{ subject: KETTLE, verb: 'on_for', for: '10m' }],
    and: [{ subject: 'room:kuche', verb: 'is_empty' }],
    then: [
      { subject: KETTLE, verb: 'turn_off' },
      { subject: 'notify:alex', verb: 'send', message: 'Wasserkocher ausgeschaltet, es war niemand in der Küche.' },
    ],
    tags: ['energy', 'safety'],
    meta: { last_run: ago(60 * 26), runs_week: 2, replaces: ['automation.beispiel_steckdose_aus'] },
  }),
  R({
    id: 'r_leck',
    group: 'g_sicher',
    name: 'Wasser in der Küche',
    when: [{ subject: 'any:leak', verb: 'wet' }],
    then: [
      { subject: 'notify:everyone', verb: 'alarm', message: 'Wasser in der Küche!' },
      { subject: 'all:light@kuche', verb: 'blink' },
    ],
    tags: ['safety'],
    meta: { runs_week: 0 },
  }),
  R({
    id: 'r_tv',
    group: 'g_abend',
    name: 'Fernsehabend',
    when: [{ subject: TV, verb: 'turns_on' }],
    then: [
      { subject: 'script.lautsprecher_eingang_wechseln', verb: 'run' },
      { subject: 'light.sofalicht', verb: 'dim', brightness: 30 },
      { subject: 'light.fernsehbeleuchtung', verb: 'turn_on' },
      { subject: 'light.wohnzimmer_decke', verb: 'turn_off' },
    ],
    only: [{ subject: 'time', verb: 'evening' }],
    tags: ['media', 'light'],
    meta: { last_run: ago(60 * 20), runs_week: 4 },
  }),
  R({
    id: 'r_schlafmodus',
    group: 'g_abend',
    name: 'Schlafenszeit erkennen',
    when: [{ subject: `zone:${FP_S}2`, verb: 'occupied', for: '10m' }],
    and: [{ subject: 'room:wohnzimmer', verb: 'is_empty' }],
    then: [{ subject: 'mode', verb: 'set', mode: 'sleep' }],
    only: [{ subject: 'time', verb: 'night' }],
    tags: ['presence'],
    meta: { last_run: ago(60 * 15 + 23), runs_week: 6 },
  }),
  R({
    id: 'r_nacht',
    group: 'g_abend',
    name: 'Gute Nacht',
    when: [{ subject: 'mode', verb: 'changes_to', mode: 'sleep' }],
    then: [
      { subject: 'all:light', verb: 'turn_off' },
      { subject: 'all:media', verb: 'pause' },
      { subject: 'all:climate', verb: 'set_temp', temperature: 18 },
    ],
    tags: ['light', 'heating'],
    meta: { last_run: ago(60 * 15 + 23), runs_week: 6 },
  }),
  R({
    id: 'r_saugen',
    group: 'g_kommen',
    name: 'Saugen, wenn alle weg sind',
    when: [{ subject: 'person:everyone', verb: 'leaves', for: '15m' }],
    and: [{ subject: 'vacuum.saugroboter', verb: 'not_cleaned_today' }],
    then: [{ subject: 'vacuum.saugroboter', verb: 'start' }],
    only: [{ subject: 'time', verb: 'workdays' }],
    paused_until: tomorrowAt(6),
    tags: ['cleaning'],
    meta: { last_run: ago(60 * 24 * 2), runs_week: 3 },
  }),
];

const automations: HaAutomation[] = [
  {
    entity_id: 'automation.beispiel_display_an',
    name: 'Display an, wenn jemand im Flur ist',
    enabled: false,
    summary: 'Wenn jemand im Flur, Wohnzimmer oder in der Küche erkannt wird, Wandtablet-Bildschirm an.',
    uses: [
      { entity_id: 'binary_sensor.praesenzmelder_flur', as: 'trigger' },
      { entity_id: `${FP_W}1`, as: 'trigger' },
      { entity_id: `${FP_K}1`, as: 'trigger' },
      { entity_id: 'switch.wandtablet_display', as: 'action' },
    ],
  },
  {
    entity_id: 'automation.beispiel_display_aus',
    name: 'Display aus, wenn der Flur leer ist',
    enabled: false,
    summary: 'Wenn in Flur, Wohnzimmer und Küche niemand mehr ist, Wandtablet-Bildschirm aus.',
    uses: [
      { entity_id: 'binary_sensor.praesenzmelder_flur', as: 'trigger' },
      { entity_id: 'switch.wandtablet_display', as: 'action' },
    ],
  },
  {
    entity_id: 'automation.beispiel_steckdose_aus',
    name: 'Steckdose nach 30 Minuten aus',
    enabled: false,
    summary: 'Wenn der Wasserkocher angeht, warten bis die Küche 5 Min. leer ist, dann Wasserkocher aus.',
    uses: [
      { entity_id: KETTLE, as: 'trigger' },
      { entity_id: `${FP_K}1`, as: 'condition' },
      { entity_id: KETTLE, as: 'action' },
    ],
  },
  {
    entity_id: 'automation.beispiel_alle_weg',
    name: 'Alle weg',
    enabled: true,
    last: ago(60 * 24 * 6),
    summary: 'Wenn die Haustür aufgeht und Alex und Sam nicht zuhause sind: Nachricht „Haustür geöffnet“ an Alex, alle Lampen an.',
    uses: [
      { entity_id: 'binary_sensor.haustuer', as: 'trigger' },
      { entity_id: 'light.flurlicht', as: 'action' },
    ],
  },
  {
    entity_id: 'automation.fernseher_an_lautsprecher',
    name: 'Fernseher an: Lautsprecher einstellen',
    enabled: true,
    last: ago(60 * 20),
    summary: 'Wenn der Fernseher angeht: Lautsprecher auf TV-Eingang, Lautstärke herunter und wieder auf 20 Stufen.',
    uses: [
      { entity_id: TV, as: 'trigger' },
      { entity_id: 'script.lautsprecher_eingang_wechseln', as: 'action' },
    ],
  },
  {
    entity_id: 'automation.fernseher_aus_lautsprecher',
    name: 'Fernseher aus: Lautsprecher zurückstellen',
    enabled: true,
    last: ago(60 * 17),
    summary: 'Wenn der Fernseher ausgeht: Lautsprecher zurück auf den alten Eingang, Lautstärke zurücksetzen.',
    uses: [
      { entity_id: TV, as: 'trigger' },
      { entity_id: 'script.lautsprecher_eingang_wechseln', as: 'action' },
    ],
  },
  {
    entity_id: 'automation.beispiel_heizung_bad',
    name: 'Heizung Bad',
    enabled: true,
    last: ago(60 * 9),
    summary: 'Werktags um 5:00 Uhr, wenn Alex zuhause ist: Heizung Bad auf 19 °C.',
    uses: [{ entity_id: 'climate.heizung_bad', as: 'action' }],
  },
  {
    entity_id: 'automation.beispiel_heizung_aus',
    name: 'Heizung ausschalten',
    enabled: true,
    summary: 'Wenn irgendeine Heizung zu heizen beginnt: alle vier Heizungen ausschalten.',
    uses: [
      { entity_id: 'climate.heizung_wohnzimmer', as: 'trigger' },
      { entity_id: 'climate.heizung_kuche', as: 'trigger' },
      { entity_id: 'climate.heizung_bad', as: 'trigger' },
      { entity_id: 'climate.heizung_wohnzimmer', as: 'action' },
      { entity_id: 'climate.heizung_kuche', as: 'action' },
      { entity_id: 'climate.heizung_bad', as: 'action' },
    ],
  },
  {
    entity_id: 'automation.beispiel_automation',
    name: 'Beispiel-Automation',
    enabled: true,
    summary: 'Wenn der Wassermelder Küche Wasser meldet: Nachricht „Wasser in der Küche!“ an Alex.',
    uses: [{ entity_id: 'binary_sensor.wasserleck_kueche', as: 'trigger' }],
  },
  {
    entity_id: 'automation.auto_laden',
    name: 'Auto laden',
    enabled: true,
    last: ago(60 * 8 + 30),
    summary: 'Täglich um 5:40 Uhr: Auto auf 100 % laden, Schlafzimmerlampe an.',
    uses: [{ entity_id: 'light.schlafzimmerlampe', as: 'action' }],
  },
];

const history: HistoryEntry[] = [
  { at: ago(8), rule: 'r_tablet', entity_id: 'switch.wandtablet_display', what: 'Wandtablet-Bildschirm an', why: 'Jemand kam in den Flur.', kind: 'rule' },
  { at: ago(14), rule: 'r_tablet', entity_id: 'switch.wandtablet_display', what: 'Wandtablet-Bildschirm aus', why: 'Der Flur war 2 Min. leer. Die Regel gilt nicht mehr, der alte Zustand ist wiederhergestellt.', kind: 'rule' },
  { at: ago(25), entity_id: 'light.sofalicht', what: 'Sofalicht an (60 %)', why: 'Von Hand in der App (Alex). Regeln lassen das Licht 1 Std. in Ruhe.', kind: 'manual' },
  { at: ago(35), rule: 'r_fenster_heizung', entity_id: 'climate.heizung_kuche', what: 'Heizung Küche aus', why: 'Das Fenster in der Küche ist seit 2 Min. offen.', kind: 'rule' },
  { at: ago(60 * 5 + 50), rule: 'r_saugen', entity_id: 'vacuum.saugroboter', what: 'Saugroboter nicht gestartet', why: 'Alle waren weg, aber die Regel ist bis morgen 6:00 Uhr pausiert.', kind: 'skipped' },
  { at: ago(60 * 9), automation: 'automation.beispiel_heizung_bad', entity_id: 'climate.heizung_bad', what: 'Heizung Bad auf 19 °C', why: 'Werktags 5:00 Uhr (HA-Automation „Heizung Bad“).', kind: 'automation' },
  { at: ago(60 * 15 + 23), rule: 'r_schlafmodus', what: 'Hausmodus: Schlafen', why: 'Bett seit 10 Min. belegt, Wohnzimmer leer, nachts.', kind: 'rule' },
  { at: ago(60 * 15 + 23), rule: 'r_nacht', entity_id: 'light.sofalicht', what: '7 Lichter aus, 2 Lautsprecher pausiert, Heizungen auf 18 °C', why: 'Der Hausmodus wechselte auf Schlafen, ausgelöst durch „Schlafenszeit erkennen“.', kind: 'rule' },
  { at: ago(60 * 19 + 12), rule: 'r_heim', entity_id: 'light.flurlicht', what: 'Flurlicht an (70 %) für 5 Min.', why: 'Die Haustür ging auf, draußen war es dunkel.', kind: 'rule' },
  { at: ago(60 * 20), rule: 'r_tv', entity_id: 'light.sofalicht', what: 'Sofalicht 30 %, Fernsehbeleuchtung an', why: 'Der Fernseher ging an, abends.', kind: 'rule' },
];

const suggestions: Suggestion[] = [
  {
    id: 's_tv',
    title: 'Fernseher: aus 2 Automationen wird 1 Regel',
    why: '„Fernseher eingeschaltet …“ und „Fernseher aus …“ machen dasselbe hin und zurück. Eine Solange-Regel stellt den Eingang selbst zurück.',
    icon: mdiAutoFix,
    badge: 'Aufräumen',
    rule: newRule({
      id: 's_tv_rule',
      name: 'Lautsprecher für den Fernseher',
      type: 'while',
      when: [{ subject: TV, verb: 'is_on' }],
      then: [
        { subject: 'script.lautsprecher_eingang_wechseln', verb: 'run' },
        { subject: 'media_player.wohnzimmer_lautsprecher', verb: 'volume', volume: 20 },
      ],
      meta: { origin: 'suggestion', replaces: ['automation.fernseher_an_lautsprecher', 'automation.fernseher_aus_lautsprecher'] },
    }),
  },
  {
    id: 's_kinds',
    title: '6 Fensterkontakte sind als „Tür“ eingetragen',
    why: 'Ihr Name sagt Fenster, Home Assistant hält sie für Türen. Richtig eingeordnet funktionieren „irgendein Fenster“ und „alle Türen“ zuverlässig.',
    icon: mdiAutoFix,
    task: 'fix_kinds',
    badge: 'Einordnen',
  },
  {
    id: 's_bettfuss',
    title: 'Nachts aufstehen: sanftes Licht',
    why: 'Dein Sensor im Schlafzimmer kennt die Zone „Bettfuß“. Steht jemand nachts auf, geht das Kleine Licht auf 5 %.',
    icon: mdiLightbulbGroup,
    rule: newRule({
      id: 's_bettfuss_rule',
      name: 'Nachts aufstehen',
      type: 'while',
      when: [{ subject: `zone:${FP_S}6`, verb: 'is_occupied' }],
      then: [{ subject: 'light.kleines_licht', verb: 'dim', brightness: 5 }],
      only: [{ subject: 'time', verb: 'night' }],
      meta: { origin: 'suggestion' },
    }),
  },
  {
    id: 's_heimweg',
    title: 'Warm, wenn Sam heimkommt',
    why: 'Sams Handy meldet den Heimweg. Das Wohnzimmer kann vorheizen, wenn niemand zuhause ist.',
    icon: mdiHomeAccount,
    rule: newRule({
      id: 's_heimweg_rule',
      name: 'Vorheizen auf dem Heimweg',
      when: [{ subject: 'person:sam', verb: 'coming_home' }],
      and: [{ subject: 'person:alex', verb: 'is_away' }],
      then: [{ subject: 'climate.heizung_wohnzimmer', verb: 'set_temp', temperature: 21.5 }],
      meta: { origin: 'suggestion' },
    }),
  },
  {
    id: 's_rooms',
    title: '17 Geräte haben keinen Raum',
    why: 'Zum Beispiel Flurlicht, Küchenlicht und Schlafzimmerlicht. Mit Raum funktionieren „alle Lichter im Flur“ und die Raumverhalten.',
    icon: mdiFloorPlan,
    task: 'assign_rooms',
    badge: 'Einordnen',
  },
];

const groups: Group[] = [
  { id: 'g_heizung', name: 'Heizung', icon: 'heating', match: 'any', members: devices.filter((d) => d.kind === 'climate').map((d) => d.entity_id) },
  { id: 'g_fernseher', name: 'Fernseher', icon: 'tv', match: 'any', members: [TV, 'light.fernsehbeleuchtung', 'media_player.wohnzimmer_lautsprecher'] },
];

const zones: Zone[] = [
  { id: 'home', entity_id: 'zone.home', name: 'Zuhause', icon: 'mdi:home', radius: 100, persons: ['person.alex'] },
  { id: 'alex_arbeit', entity_id: 'zone.alex_arbeit', name: 'Alex Arbeit', icon: 'mdi:briefcase', radius: 150, persons: [] },
  { id: 'sam_arbeit', entity_id: 'zone.sam_arbeit', name: 'Sam Arbeit', icon: 'mdi:briefcase', radius: 150, persons: ['person.sam'] },
  { id: 'fitnessstudio', entity_id: 'zone.fitnessstudio', name: 'Fitnessstudio', icon: 'mdi:dumbbell', radius: 80, persons: [] },
];

const doorIds = devices.filter((d) => d.kind === 'door').map((d) => d.entity_id);
const windowIds = devices.filter((d) => d.kind === 'window').map((d) => d.entity_id);
const motionIds = devices.filter((d) => d.kind === 'presence' || d.kind === 'motion').map((d) => d.entity_id);
const modeCfg = (sensors: string[], exit: number, loud: boolean, lights: 'on' | 'flash' | 'red' | 'none', inside: boolean, armOn: string[], disarmOn: string[]): AlarmConfig['modes']['away'] => ({
  sensors,
  entry_delay: 30,
  exit_delay: exit,
  loud,
  lights: { mode: lights, entities: [] },
  activate: [],
  smart: { inside: { on: inside, seconds: 90 }, arrival: { on: true, minutes: 10, disarm: false } },
  auto: { arm_on: armOn, disarm_on: disarmOn, arm_at: '', disarm_at: '', only_auto: true, arm_away: false, away_for: 5, disarm_home: false },
});
const alarmConfig: AlarmConfig = {
  version: 2,
  enabled: true,
  has_code: false,
  confirm: 'none',
  modes: {
    away: modeCfg([...doorIds, ...windowIds, ...motionIds], 60, true, 'flash', false, ['away', 'vacation'], ['home']),
    night: { ...modeCfg([...doorIds, ...windowIds], 0, true, 'red', true, ['sleep'], ['home']), auto: { arm_on: ['sleep'], disarm_on: ['home'], arm_at: '', disarm_at: '06:30', only_auto: true } },
    home: modeCfg(['binary_sensor.haustuer'], 0, false, 'none', true, [], []),
  },
  notify: {
    persons: 'everyone',
    pending_persons: 'same',
    armed_persons: ['alex'],
    disarmed_persons: 'same',
    test_persons: ['alex'],
    critical: true,
    pre_alarm: true,
    armed: false,
    disarmed: false,
    repeat: { on: true, every: 60, max: 10, channels: false },
  },
  channels: {
    email: { on: false, host: '', port: 587, security: 'starttls', user: '', sender: '', to: [], events: ['triggered', 'test'], has_password: false },
    telegram: { on: true, users: ['@alex'], call: true, text: true, events: ['triggered', 'test'] },
    signal: { on: false, numbers: [], events: ['triggered', 'test'] },
    services: { on: false, list: [], events: ['triggered', 'test'] },
  },
  presence: { persons: 'everyone' },
  announce: { players: ['media_player.wohnzimmer_lautsprecher', 'media_player.kueche_lautsprecher'], pending_text: 'Bitte die Alarmanlage ausschalten.', triggered_text: 'Achtung, Alarm! Die Polizei ist informiert.' },
  sirens: [],
  sound: { players: ['media_player.wohnzimmer_lautsprecher'], tone: 'sirene', url: '', volume: 80, pre_tone: 'piepen' },
  cameras: ['camera.flur'],
  buttons: ['disarm', 'silence', 'camera'],
  phone: '',
  duration: 180,
  devices: [],
};

const OBJECT_ICONS: Record<ObjectAlarm['kind'], string> = { bike: 'mdi:bicycle', car: 'mdi:car', garage: 'mdi:garage', shed: 'mdi:greenhouse', building: 'mdi:home-city-outline', other: 'mdi:shield-outline' };

function demoObject(kind: ObjectAlarm['kind'], name: string, extra: Partial<ObjectAlarm> = {}): ObjectAlarm {
  return {
    id: `o_${kind}`,
    name,
    kind,
    icon: OBJECT_ICONS[kind],
    sensors: [],
    delay: 0,
    confirm: true,
    auto: { with_alarm: false, arm_on: [], disarm_on: [] },
    notify: { persons: 'everyone', critical: true },
    sirens: [],
    lights: [],
    camera: '',
    duration: 120,
    state: 'disarmed',
    label: 'Unscharf',
    by_auto: false,
    open: [],
    ...extra,
  };
}
/** Wo ist wer (example data, fictional) */
const pnow = Date.now();
const pago = (min: number) => new Date(pnow - min * 60000).toISOString();
const placesDemo: PlacesView = {
  persons: [
    { id: 'alex', entity_id: 'person.alex', name: 'Alex', state: 'zone', place: 'home', place_name: 'Zuhause', since: pago(95), line: `Zuhause · seit ${new Date(pnow - 95 * 60000).toLocaleTimeString('de-DE', { hour: 'numeric', minute: '2-digit' })}` },
    {
      id: 'sam',
      entity_id: 'person.sam',
      name: 'Sam',
      state: 'moving',
      since: pago(9),
      line: 'Unterwegs · wahrscheinlich nach Hause · ca. 12 Min.',
      trend: 'closer',
      distance_home_km: 6.2,
      prediction: { destination: 'home', name: 'Zuhause', probability: 0.86, eta_min: 12, basis: 'learned' },
    },
  ],
  learned: [
    { id: 'lp_demo1', name: 'Sportverein', label: 'Sportverein', lat: 52.55, lon: 13.3, radius: 90, visits: 14, typical: { days: 'workdays', arrive: '18:00', stay_min: 85 } },
    { id: 'lp_demo2', name: '', label: 'Supermarkt Beispielweg', auto: 'Supermarkt Beispielweg', lat: 52.5, lon: 13.45, radius: 70, visits: 4, street: null, typical: { days: 'weekend', arrive: '10:00', stay_min: 50 } },
  ],
  settings: { learn: true, nominatim: false },
  stats: { trips: 212, warming: false },
};

/** room temperatures of the example heating */
const DEMO_ROOM_TEMP: Record<string, number> = { kuche: 19.2, wohnzimmer: 20.8, schlafzimmer: 18.1, bad: 20.4, flur: 19.5 };

export class DemoStore extends Store {
  readonly demo = true;
  rooms = rooms;
  devices = devices;
  override devicesUnused: UnusedDevice[] = [
    { entity_id: 'binary_sensor.auto_tur_vorne_links', name: 'Auto Tür vorne links', kind: 'door', reason: 'vehicle', vehicle: 'Familienauto' },
    { entity_id: 'lock.auto_verriegelung', name: 'Auto Verriegelung', kind: 'lock', reason: 'vehicle', vehicle: 'Familienauto' },
  ];
  override objects: ObjectAlarm[] = [
    demoObject('bike', 'Fahrrad', { sensors: ['binary_sensor.fahrrad_erschutterung'], auto: { with_alarm: true, arm_on: [], disarm_on: [] }, state: 'armed', label: 'Scharf', by_auto: true }),
    demoObject('shed', 'Gartenhaus', { sensors: ['binary_sensor.gartenhaus_tur'] }),
  ];
  persons = persons;
  rules = rules;
  automations = automations;
  history = history;
  suggestions = suggestions;
  behaviours = behaviours;
  mode: HouseMode = 'home';
  groups = groups;
  zones = zones;
  override places: PlacesView | null = placesDemo;
  // own rule groups of the rules page (shown when the grouping is set to "by hand")
  override ui: Store['ui'] = {
    grouping: 'auto',
    groups: [
      { id: 'g_abend', name: 'Abendroutine', hidden: false },
      { id: 'g_kommen', name: 'Kommen und Gehen', hidden: false },
      { id: 'g_sicher', name: 'Sicherheit und Wasser', hidden: false },
    ],
    room_order: [],
    room_hidden: {},
  };
  override modeAuto: ModeAutoView | null = {
    enabled: true,
    target: 'home',
    why: 'jemand ist zuhause',
    held: false,
    modes: {
      away: { on: true, when: [{ subject: 'person:everyone', verb: 'is_away' }], for: '' },
      sleep: {
        on: true,
        when: [
          { subject: 'time', verb: 'night' },
          { subject: 'person:someone', verb: 'is_home' },
          { subject: 'room:wohnzimmer', verb: 'is_empty', for: '15m' },
          { subject: `zone:${FP_S}2`, verb: 'is_occupied' },
        ],
        for: '10m',
        end: { on: true, when: [{ subject: `zone:${FP_S}2`, verb: 'is_free', for: '15m' }, { subject: 'time', verb: 'morning' }], for: '' },
      },
      guests: { on: false, when: [], for: '' },
      vacation: { on: true, when: [{ subject: 'person:everyone', verb: 'is_away', for: '1d' }], for: '' },
    },
    wakeup: {
      on: true,
      action: 'direct',
      feedback: true,
      beds: [],
      rooms: [],
      found_beds: [{ entity_id: `${FP_S}2`, name: 'Bett' }],
      found_rooms: ['Küche', 'Wohnzimmer', 'Bad', 'Flur'],
      learned: {
        work: { from: '06:50', to: '07:20', n: 9, need: 12, room: 'Küche' },
        free: { from: '08:15', to: '09:05', n: 4, need: 14, room: 'Wohnzimmer' },
      },
      detections: 13,
      trips: 21,
      status: '',
      last: { at: Date.now() / 1000 - 3600 * 9, up: 7 * 60 + 4, answer: 'yes', conf: 0.86 },
    },
  };
  override async wakeupSet(config: Partial<Pick<WakeupView, 'on' | 'action' | 'feedback' | 'beds' | 'rooms'>>) {
    const m = this.modeAuto!;
    this.modeAuto = { ...m, wakeup: { ...m.wakeup!, ...config } };
    this.changed();
  }
  override async wakeupReset() {
    const m = this.modeAuto!;
    const fresh = { from: '06:30', to: '07:30', n: 0, need: 10, room: null };
    this.modeAuto = { ...m, wakeup: { ...m.wakeup!, detections: 0, trips: 0, last: null, learned: { work: fresh, free: { ...fresh, from: '08:00', to: '09:00' } } } };
    this.changed();
  }
  private _simCfg: SimConfig = { smart: true, people: 0, morning: true, night: true, dark: { sun: true, sun_below: 3, lux: true, lux_below: 0, habits: true, never: false, never_from: '09:00', never_to: '16:00' } };
  override async sim(cmd: 'view' | 'set' | 'learn', arg?: Partial<SimConfig> | string): Promise<SimView> {
    if (cmd === 'set') {
      const a = arg as Partial<SimConfig>;
      this._simCfg = { ...this._simCfg, ...a, dark: { ...this._simCfg.dark, ...(a.dark ?? {}) } };
    }
    const hm = (m: number) => {
      const t = Math.round(m + 240) % 1440;
      return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    };
    const seq: [string, number, SimSegment['kind']][] = [
      ['schlafzimmer', 4, 'wake'], ['flur', 0.5, 'pass'], ['bad', 14, 'stay'], ['flur', 0.4, 'pass'], ['kuche', 28, 'stay'], ['flur', 1, 'pass'],
    ];
    const tl: SimSegment[] = [];
    const push = (walker: number, start: number, list: [string, number, SimSegment['kind']][]) => {
      let t = start;
      for (const [room, len, kind] of list) {
        tl.push({ room, from: t, to: t + len, start: hm(t), end: hm(t + len), kind, walker });
        t += len;
      }
    };
    push(0, 6.6 * 60 - 240, seq);
    push(0, 17.5 * 60 - 240, [['flur', 1, 'pass'], ['kuche', 35, 'stay'], ['flur', 0.4, 'pass'], ['wohnzimmer', 95, 'stay'], ['flur', 0.4, 'pass'], ['bad', 8, 'stay'], ['flur', 0.4, 'pass'], ['wohnzimmer', 70, 'stay'], ['flur', 0.5, 'pass'], ['bad', 9, 'stay'], ['flur', 0.4, 'pass'], ['schlafzimmer', 14, 'bed']]);
    if (this._simCfg.night) push(0, 3.2 * 60 + 1440 - 240, [['flur', 0.4, 'pass'], ['bad', 4, 'night'], ['flur', 0.4, 'pass']]);
    if (this.residents.filter((r) => r.counts).length > 1 || this._simCfg.people >= 2)
      push(1, 18.3 * 60 - 240, [['flur', 0.5, 'pass'], ['wohnzimmer', 140, 'stay'], ['flur', 0.4, 'pass'], ['kuche', 12, 'stay'], ['flur', 0.4, 'pass'], ['schlafzimmer', 18, 'bed']]);
    if (!this._simCfg.morning) tl.splice(0, 1);
    return {
      config: this._simCfg,
      enabled: this.mode === 'vacation',
      learning: false,
      days: 12,
      first: '2026-10-05',
      last: '2026-10-16',
      bedroom: 'schlafzimmer',
      night_room: 'bad',
      entrance: 'flur',
      floorplan: true,
      neighbours: {
        flur: ['bad', 'kuche', 'schlafzimmer', 'wohnzimmer'].map((room) => ({ room, source: 'Karte' })),
        bad: [{ room: 'flur', source: 'Karte' }],
        kuche: [{ room: 'flur', source: 'Karte' }, { room: 'wohnzimmer', source: 'gelernt' }],
        schlafzimmer: [{ room: 'flur', source: 'Karte' }],
        wohnzimmer: [{ room: 'flur', source: 'Karte' }, { room: 'kuche', source: 'gelernt' }],
      },
      times: { workday: { wake: '06:38', bed: '23:05', night_p: 0.3, days: 8 }, weekend: { wake: '08:50', bed: '23:40', night_p: 0.25, days: 4 } },
      rooms: ['flur', 'kuche', 'wohnzimmer', 'schlafzimmer', 'bad'],
      lux: {
        wohnzimmer: { limit: this._simCfg.dark.lux_below || 28, source: this._simCfg.dark.lux_below ? 'eingestellt' : 'gelernt', now: 12 },
        kuche: { limit: this._simCfg.dark.lux_below || 45, source: this._simCfg.dark.lux_below ? 'eingestellt' : 'gelernt', now: 140 },
        flur: { limit: this._simCfg.dark.lux_below || 80, source: this._simCfg.dark.lux_below ? 'eingestellt' : 'Raum', now: 30 },
      },
      now: {
        wohnzimmer: { dark: false, why: 'Sonne noch 24° hoch' },
        kuche: { dark: false, why: 'Sonne noch 24° hoch' },
        flur: { dark: false, why: 'Sonne noch 24° hoch' },
        bad: { dark: true, why: 'dunkel' },
        schlafzimmer: { dark: false, why: 'um diese Zeit macht ihr hier sonst kein Licht an' },
      },
      habits: { wohnzimmer: ['evening', 'night'], kuche: ['evening', 'morning'], bad: ['day', 'evening', 'morning', 'night'], schlafzimmer: ['night'], flur: ['evening', 'morning', 'night'] },
      sun: 24,
      people: this._simCfg.people || Math.max(1, Math.min(2, this.residents.filter((r) => r.counts).length)),
      day: typeof arg === 'string' ? arg : new Date().toISOString().slice(0, 10),
      timeline: tl.sort((a, b) => a.from - b.from),
    };
  }
  override async modeAutoSet(mode: AutoMode | '_enabled', config: Record<string, unknown>) {
    const m = this.modeAuto!;
    this.modeAuto = mode === '_enabled' ? { ...m, enabled: !!config.enabled } : { ...m, modes: { ...m.modes, [mode]: { ...m.modes[mode], ...config } } };
    this.changed();
  }
  alarm: AlarmView | null = {
    state: 'disarmed',
    label: 'Unscharf',
    mode: null,
    since: Date.now() / 1000 - 3600 * 5,
    until: null,
    cause: null,
    cause_name: null,
    bypassed: [],
    config: alarmConfig,
    suggested: { away: [...doorIds, ...windowIds, ...motionIds], night: [...doorIds, ...windowIds], home: doorIds },
    silenced: false,
    last_exception: { at: Date.now() / 1000 - 3600 * 9, sensor: 'Haustür', reason: 'Anwesenheit Flur hat kurz vorher jemanden im Flur erkannt: von innen geöffnet' },
    tones: { sirene: 'Sirene (Warnsignal)', martinshorn: 'Martinshorn', evakuierung: 'Evakuierungsalarm', alarm: 'Alarm (hoch)', piepen: 'Pieptöne', gong: 'Gong' },
    sounds_url: '',
  };
  ai: AiPublic | null = {
    provider: 'none',
    url: '',
    model: '',
    has_key: false,
    key_hint: '',
    providers: {
      ollama: { label: 'Ollama', needs_url: true, needs_key: false, url: 'http://', hint: 'Eigener Server, z. B. dein VPS: http://adresse:11434' },
      gemini: { label: 'Google Gemini', needs_url: false, needs_key: true, hint: 'Schlüssel aus Google AI Studio' },
      openai: { label: 'OpenAI (ChatGPT)', needs_url: false, needs_key: true, hint: 'Schlüssel von platform.openai.com' },
      anthropic: { label: 'Anthropic (Claude)', needs_url: false, needs_key: true, hint: 'Schlüssel aus der Claude Console' },
      mistral: { label: 'Mistral', needs_url: false, needs_key: true, hint: 'Schlüssel von console.mistral.ai' },
      openai_compatible: { label: 'OpenAI-kompatibel', needs_url: true, needs_key: true, url: 'https://', hint: 'Z. B. OpenRouter, Groq, LM Studio' },
    },
  };
  override cleaning = { on: true, vacuums: ['vacuum.saugroboter'], sensors: 'all' as const, after: 2, active: false, since: null, until: null };
  override setup: SetupView | null = { done: true, step: 'welcome', answers: {}, floorplan: true };
  override windowWarning: WindowWarningView | null = {
    on: true,
    active: false,
    phase: null,
    door: null,
    windows: [],
    names: [],
    since: null,
    deadline: null,
    spoken: false,
    doors: [],
    suggested_doors: [],
    config: {
      doors: [],
      windows: 'all',
      only_last: true,
      delay: 0,
      timeout: 30,
      blink: true,
      lights: { mode: 'red', entities: [] },
      ack_entity: '',
      announce: { mode: 'all', players: [], tts: '', language: '', texts: { general: 'Achtung, es sind noch Fenster offen.', all: 'Noch offen: {fenster}.', single: '{fenster} ist noch offen.' } },
      notify: { on: false, persons: 'everyone' },
      users: [],
      imported: null,
    },
  };
  override async windowWarningSet(config: Partial<WindowWarningConfig>) {
    if (this.windowWarning) this.windowWarning = { ...this.windowWarning, config: { ...this.windowWarning.config, ...config } };
    this.changed();
  }
  override async setupSuggest(): Promise<SetupSuggest> {
    const dev = (d: Device) => ({ entity_id: d.entity_id, name: d.name, kind: d.kind, room: d.room ?? null });
    const of = (kinds: string[]) => this.devices.filter((d) => kinds.includes(d.kind));
    const doors = of(['door']);
    if (this.windowWarning && !this.windowWarning.doors.length) this.windowWarning = { ...this.windowWarning, doors: doors.slice(0, 1).map((d) => d.entity_id), suggested_doors: doors.slice(0, 1).map((d) => d.entity_id) };
    const ex = this.suggestions.filter((x) => x.rule).slice(0, 3);
    return {
      residents: this.residents,
      persons: this.persons,
      rooms: this.rooms.map((r) => ({
        id: r.id,
        name: r.name,
        icon: r.icon,
        presence: r.presence,
        motion: r.motion,
        candidates: this.devices.filter((d) => d.room === r.id && (d.kind === 'presence' || d.kind === 'motion')).map(dev),
        lights: this.devices.filter((d) => d.room === r.id && d.kind === 'light').map((d) => d.entity_id),
        climate: this.devices.filter((d) => d.room === r.id && d.kind === 'climate').map((d) => d.entity_id),
        doors: r.doors,
        door_logic: r.door_logic,
      })),
      alarm: { away: of(['door', 'window', 'motion', 'presence']).filter((d) => d.room).map(dev), night: of(['door', 'window']).map((d) => d.entity_id), home: doors.map((d) => d.entity_id), sirens: [], players: [], cameras: [] },
      vacuums: of(['vacuum']).map(dev),
      window_warning: { doors: doors.slice(0, 1).map(dev), windows: of(['window']).map(dev), lights: of(['light']).map(dev) },
      examples: ex.map((x) => ({ id: x.id, title: x.title, why: x.why, rule: x.rule!, sentence: x.rule!.name })),
      floorplan: true,
      features: this.features,
    };
  }
  override residents = [
    { entity_id: 'person.alex', name: 'Alex', counts: true, tracked: true, state: 'home' },
    { entity_id: 'person.sam', name: 'Sam', counts: true, tracked: true, state: 'not_home' },
    { entity_id: 'person.tablet', name: 'Tablet', counts: false, tracked: true, state: 'unknown' },
  ];
  override async cleaningSet(config: Record<string, unknown>) {
    this.cleaning = { ...this.cleaning, ...config } as typeof this.cleaning;
    this.changed();
  }
  override async residentsSet(excluded: string[]) {
    this.residents = this.residents.map((p) => ({ ...p, counts: !excluded.includes(p.entity_id) }));
    this.changed();
  }
  override plans: PlansView | null = (() => {
    const light = (on = false): LightPlan => ({
      on,
      rules: on
        ? [
            {
              id: 'r1', name: 'Reinkommen', enabled: true, kind: 'when',
              trigger: [{ subject: 'room:wohnzimmer', verb: 'is_occupied' }, { subject: 'room:wohnzimmer', verb: 'is_dark' }],
              when: [{ subject: 'room:wohnzimmer', verb: 'is_occupied' }, { subject: 'room:wohnzimmer', verb: 'is_dark' }],
              lights: [], action: { mode: 'on', brightness: 80, color: 'neutral' },
              variants: [
                { id: 'v1', when: [{ subject: 'time', verb: 'evening' }], mode: 'on', brightness: 50, color: 'warm' },
                { id: 'v2', when: [{ subject: 'time', verb: 'night' }], mode: 'on', brightness: 5, color: 'kerze' },
              ],
              after: 'others', empty_after: 'off',
            },
            {
              id: 'r2', name: 'Fernsehen', enabled: true, kind: 'while',
              trigger: [], when: [{ subject: 'media_player.wohnzimmer_tv', verb: 'is_on' }],
              lights: ['light.fernsehbeleuchtung', 'light.sofalicht'], action: { mode: 'on', brightness: 20, color: 'warm' },
              variants: [], after: 'others', empty_after: 'off',
            },
            {
              id: 'r3', name: 'Deckenleuchte nicht beim Fernsehen', enabled: true, kind: 'never_on',
              trigger: [], when: [{ subject: 'media_player.wohnzimmer_tv', verb: 'is_on' }],
              lights: ['light.deckenleuchte_wohnzimmer'], action: { mode: 'on', brightness: 50, color: 'warm' }, variants: [], after: 'others', empty_after: 'off',
            },
            {
              id: 'r4', name: 'Sofalicht bleibt beim Fernsehen', enabled: true, kind: 'keep_on',
              trigger: [], when: [{ subject: 'media_player.wohnzimmer_tv', verb: 'is_on' }],
              lights: ['light.sofalicht'], action: { mode: 'on', brightness: 50, color: 'warm' }, variants: [], after: 'others', empty_after: 'dim',
            },
          ]
        : [],
      empty: { mode: 'dim', delay: 2, dim: 10, dim_for: 5 },
      manual: 'room_empty',
      guests_keep: true,
      vacation: { on: false, lights: [], start: 'sunset', offset: 15, time: '19:00', end: '23:00', brightness: 70, color: 'warm', random: true },
    });
    const heat = (on = false): HeatPlan => ({
      v: 2,
      on,
      thermostats: [],
      sensor: null,
      calibrate: 'auto',
      temps: { comfort: 21, base: 18, eco: 17, night: 17, frost: 12 },
      blocks: [
        { from: '06:00', to: '08:00', days: 'workdays', level: 'comfort', temp: 21 },
        { from: '17:00', to: '22:00', days: 'all', level: 'comfort', temp: 21 },
      ],
      presence: { away: true, away_after: 15, empty: false, empty_after: 30, home_soon: true },
      sleep: true,
      guests: true,
      manual: 'smart',
      manual_hours: 2,
      manual_max: 4,
      window: { on: true, contacts: [], extra: [], delay: 2, resume: 5, action: 'off', drop: false, drop_k: 1 },
      preheat: { on: true, max: 90, learn: true, rate: 1.5 },
      vent: { on: false, times: [], humidity_on: true, humidity: 65, humidity_sensor: null, co2_on: true, co2: 1000, co2_sensor: null, mould: true, close: true, close_after: 0, wait: 5 },
      valves: { stuck: true },
    });
    const L: Record<string, LightPlan> = {};
    const H: Record<string, HeatPlan> = {};
    const N: PlansView['now'] = {};
    for (const r of rooms) {
      L[r.id] = light(r.id === 'wohnzimmer');
      H[r.id] = heat(r.id === 'bad');
      N[r.id] = { light: { occupied: true, empty: false, lux: 12, active: ['Fernsehen', 'Deckenleuchte nicht beim Fernsehen'], lights: {}, held: [] }, heat: { temp: 21, why: 'Komfort 17:00–22:00', mode: 'heat', level: 'comfort', until: '22:00', current: DEMO_ROOM_TEMP[r.id] ?? 20.4, valve: 35, heating: true, line: `${r.name}: 21 °C Komfort bis 22:00 · jetzt 20,4 °C · Ventil 35 % · heizt` } };
    }
    // the heating house-wide (Heizung → Standard für alle Räume / Ganzes Haus)
    const heating: HeatingView = {
      enabled: true,
      outside: { entity: 'weather.home', name: 'Wetter', value: 6.5, auto: true },
      summer: false,
      demand: { on: true, why: 'Ventil Bad 35 %', wait: null },
      exercise_until: null,
      last_exercise: '2026-11-09T11:00:00',
      rooms: {},
      config: {
        outside: null,
        summer: { on: true, above: 18, hold: 120 },
        demand: { on: false, entity: null, above: 20, min_on: 5, min_off: 5 },
        exercise: { on: true, weekday: 0, time: '11:00', minutes: 3 },
        notify: [],
        quiet: { on: true, from: '22:00', to: '07:00' },
        gap: 5,
        smart: { guard: { max: 24, min: 15, occupied_min: 18, max_setback: 4, never: { on: false, from: '00:00', to: '05:00' } }, energy: { kind: 'auto', meter: null, price: null, gas_kwh_m3: 10.3, cop: 3.2, efficiency: 0.92 }, airing: { morning: null, minutes: 10, rooms: [] }, setup_done: true },
        defaults: {
          comfort: { comfort: 21 },
          temps: { base: 18, eco: 17, night: 17, frost: 12 },
          presence: { away: true, away_after: 15, empty: false, empty_after: 30, home_soon: true },
          modes: { sleep: true, guests: true },
          manual: { manual: 'smart', manual_hours: 2, manual_max: 4 },
          window: { on: true, delay: 2, resume: 5, action: 'off', drop: false, drop_k: 1 },
          vent: { on: false, humidity_on: true, humidity: 65, co2_on: true, co2: 1000, mould: true, close: true, close_after: 0, wait: 5 },
          preheat: { on: true, max: 90, learn: true, rate: 1.5 },
          style: { style: 'comfort', ramp: { step: null, minutes: null } },
          valve: { valve: { on: false } },
          building: { building: 'unknown' },
          shadow: { shadow_days: 7 },
        },
      },
    };
    return { light: L, heat: H, now: N, heating };
  })();
  override async planSet(kind: 'light' | 'heat', room: string, plan: LightPlan | HeatPlan) {
    if (kind === 'light') {
      // as the integration: the Reinschau-Licht stands for two rules of the plan, rules it replaces go
      const { glow_replace: drop = [], ...rest } = plan as LightPlan;
      const own = rest.rules.filter((r) => !['glowauto', 'glowautok'].includes(r.id) && !drop.includes(r.id));
      plan = { ...rest, rules: rest.glow?.on && rest.glow.sources.length && rest.glow.lights.length ? [...own, { id: 'glowauto', name: `Reinschau-Licht (${rooms.find((r) => r.id === room)?.name ?? room})`, enabled: true, kind: 'while', when: [], lights: rest.glow.lights, action: { mode: 'on', brightness: rest.glow.brightness }, trigger: [], variants: [], after: 'others', empty_after: 'off' } as unknown as LightPlan['rules'][number]] : own };
    }
    this.plans = { ...this.plans!, [kind]: { ...this.plans![kind], [room]: plan } } as PlansView;
    this.changed();
  }
  /** a floor plan card on the dashboard (for the Reinschau-Licht's map): outlines of the example rooms */
  override async callHA<T>(msg: Record<string, unknown>): Promise<T | null> {
    if (msg.type === 'lovelace/dashboards/list') return [] as T;
    if (msg.type === 'lovelace/config' && !msg.url_path) {
      const room = (name: string, points: [number, number][]) => ({ id: `room_${name}`, name, points });
      return {
        views: [
          {
            cards: [
              {
                type: 'custom:floorplan-card',
                floors: [
                  {
                    id: 'eg',
                    name: 'Wohnung',
                    rooms: [
                      room('Schlafzimmer', [[0, 0], [400, 0], [400, 300], [0, 300]]),
                      room('Flur', [[400, 0], [560, 0], [560, 420], [400, 420]]),
                      room('Bad', [[560, 0], [800, 0], [800, 220], [560, 220]]),
                      room('Küche', [[560, 220], [800, 220], [800, 420], [560, 420]]),
                      room('Wohnzimmer', [[0, 300], [400, 300], [400, 420], [560, 420], [560, 680], [0, 680]]),
                    ],
                    openings: [
                      { id: 'd1', type: 'door', a: [400, 120], b: [400, 200], entity: 'binary_sensor.tuer_schlafzimmer', name: 'Schlafzimmertür' },
                      { id: 'd2', type: 'door', a: [560, 80], b: [560, 160], entity: 'binary_sensor.tuer_bad', name: 'Badtür' },
                      { id: 'd3', type: 'door', a: [560, 300], b: [560, 380], entity: 'binary_sensor.tuer_kueche', name: 'Küchentür' },
                      { id: 'd4', type: 'door', a: [440, 420], b: [520, 420], entity: 'binary_sensor.tuer_wohnzimmer', name: 'Wohnzimmertür' },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      } as T;
    }
    return null;
  }
  override allEntities() {
    return [
      ...super.allEntities(),
      { entity_id: 'sensor.strompreis', name: 'Strompreis', state: '0.31' },
      { entity_id: 'sensor.wetter_zustand', name: 'Wetter', state: 'sonnig' },
      { entity_id: 'input_select.waschmaschine', name: 'Waschmaschine Programm', state: 'Eco' },
      { entity_id: 'button.klingel', name: 'Klingel', state: 'unknown' },
      { entity_id: 'scene.alles_hell', name: 'Alles hell', state: 'unknown' },
      { entity_id: 'input_boolean.besuch', name: 'Besuch da', state: 'off' },
      { entity_id: 'binary_sensor.waschmaschine_fertig', name: 'Waschmaschine fertig', state: 'off' },
    ];
  }
  override extraEntities(domain: string) {
    const ex: Record<string, { entity_id: string; name: string }[]> = {
      camera: [
        { entity_id: 'camera.flur', name: 'Kamera Flur' },
        { entity_id: 'camera.einfahrt', name: 'Kamera Einfahrt' },
      ],
      switch: [
        { entity_id: 'switch.einfahrt_aufnahme', name: 'Einfahrt Aufnahme' },
        { entity_id: 'switch.flur_aufnahme', name: 'Flur Aufnahme' },
      ],
      scene: [{ entity_id: 'scene.alles_hell', name: 'Alles hell' }],
      script: [],
      media_player: this.devices.filter((d) => d.kind === 'media').map((d) => ({ entity_id: d.entity_id, name: d.name })),
      siren: [],
      light: this.devices.filter((d) => d.kind === 'light').map((d) => ({ entity_id: d.entity_id, name: d.name })),
    };
    return ex[domain] ?? [];
  }
  async saveGroup(group: Group) {
    const g = { ...group, id: group.id || `g_${Math.random().toString(36).slice(2, 8)}` };
    const i = this.groups.findIndex((x) => x.id === g.id);
    this.groups = i < 0 ? [...this.groups, g] : this.groups.map((x) => (x.id === g.id ? g : x));
    this.changed();
    return g;
  }
  async deleteGroup(id: string) {
    this.groups = this.groups.filter((g) => g.id !== id);
    this.changed();
  }
  private _alarm(state: AlarmView['state'], mode: AlarmMode | null, until: number | null = null) {
    const labels: Record<string, string> = { disarmed: 'Unscharf', arming: 'Wird scharf geschaltet', armed_away: 'Scharf (abwesend)', armed_night: 'Scharf (Nacht)', armed_home: 'Scharf (zuhause)', pending: 'Eingangsverzögerung', triggered: 'Alarm!' };
    this.alarm = { ...this.alarm!, state, mode, until, label: labels[state], since: Date.now() / 1000 };
    this.changed();
  }
  async alarmArm(mode: AlarmMode, force = false) {
    const open = this.alarm!.config.modes[mode].sensors.filter((e) => this.device(e)?.state === 'on' && ['door', 'window'].includes(this.device(e)!.kind));
    if (open.length && !force) return { ok: false, error: 'open', open: open.map((e) => ({ entity_id: e, name: this.device(e)!.name })) };
    const delay = this.alarm!.config.modes[mode].exit_delay;
    this.alarm = { ...this.alarm!, bypassed: open };
    if (delay) {
      this._alarm('arming', mode, Date.now() / 1000 + delay);
      setTimeout(() => this.alarm?.state === 'arming' && this._alarm(`armed_${mode}` as AlarmView['state'], mode), delay * 1000);
    } else this._alarm(`armed_${mode}` as AlarmView['state'], mode);
    return { ok: true };
  }
  async alarmDisarm() {
    this._alarm('disarmed', null);
    return { ok: true };
  }
  async alarmSilence() {}
  async alarmResetPin() {
    if (this.alarm) this.alarm.config.pin_locked = 0;
    this.changed();
  }
  async alarmTest() {
    this.history = [{ at: new Date().toISOString(), what: 'Probealarm', why: 'Nachricht und Durchsage zum Testen (Vorschau, nichts wurde gesendet).', kind: 'alarm' }, ...this.history];
    this.changed();
  }
  async alarmConfig(config: Partial<AlarmConfig> & { code?: string | null }) {
    const { code, ...rest } = config;
    this.alarm = { ...this.alarm!, config: { ...this.alarm!.config, ...rest, has_code: code === undefined ? this.alarm!.config.has_code : !!code } };
    this.changed();
  }
  async aiSet(ai: Partial<AiPublic> & { key?: string | null }) {
    const { key, ...rest } = ai;
    this.ai = { ...this.ai!, ...rest, has_key: key ? true : this.ai!.has_key, key_hint: key ? `…${key.slice(-4)}` : this.ai!.key_hint };
    this.changed();
  }
  async aiTest() {
    return { ok: false, error: 'In der Vorschau gibt es keine Verbindung.', models: [] };
  }
  occupancy: Record<string, { occupied: boolean; since: string; by?: string }> = {
    flur: { occupied: false, since: ago(14) },
    kuche: { occupied: false, since: ago(12) },
    wohnzimmer: { occupied: true, since: ago(26), by: 'Sofa' },
    schlafzimmer: { occupied: false, since: ago(60 * 3 + 5) },
    bad: { occupied: false, since: ago(58) },
  };

  async saveRule(rule: Rule) {
    const i = this.rules.findIndex((r) => r.id === rule.id);
    this.rules = i < 0 ? [rule, ...this.rules] : this.rules.map((r) => (r.id === rule.id ? rule : r));
    this.changed();
  }
  /** preview: deleted rules stay in memory, so "Rückgängig" and the trash can be tried out */
  private _trash: TrashItem[] = [];
  async deleteRule(id: string) {
    const rule = this.rule(id);
    if (rule) this._trash.unshift({ id, name: rule.name, deleted: new Date().toISOString(), deleted_by: null, deleted_by_name: '', until: new Date(Date.now() + 30 * 86400000).toISOString(), sentence: rule.sentence ?? '', rule });
    this.rules = this.rules.filter((r) => r.id !== id);
    this.changed();
  }
  override async trashList() {
    return [...this._trash];
  }
  override async trashRestore(id: string) {
    const i = this._trash.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [t] = this._trash.splice(i, 1);
    this.rules = [t.rule, ...this.rules];
    this.changed();
    return t.rule;
  }
  override async trashPurge(id?: string) {
    this._trash = id ? this._trash.filter((t) => t.id !== id) : [];
  }
  override async exportRule(rule: Rule) {
    return { id: `hausregeln_${rule.id}`, automation: {}, yaml: `# Vorschau: Die Automation entsteht erst mit Home Assistant.\nalias: ${rule.name}\n`, notes: ['In der Vorschau wird nichts übertragen.'], complete: false };
  }
  async setEnabled(id: string, enabled: boolean) {
    this.rules = this.rules.map((r) => (r.id === id ? { ...r, enabled } : r));
    this.changed();
  }
  async pause(id: string, until: string | null) {
    this.rules = this.rules.map((r) => (r.id === id ? { ...r, paused_until: until ?? undefined } : r));
    this.changed();
  }
  async runNow(id: string) {
    const rule = this.rule(id);
    if (!rule) return;
    this.history = [
      { at: new Date().toISOString(), rule: id, what: rule.then.map((c) => clauseText(this, c, 'then')).join(', '), why: 'Von Hand gestartet (Vorschau, nichts wurde geschaltet).', kind: 'rule' },
      ...this.history,
    ];
    this.changed();
  }
  async setMode(mode: HouseMode) {
    this.mode = mode;
    this.changed();
  }
  async saveRoom(room: Room) {
    this.rooms = this.rooms.map((r) => (r.id === room.id ? room : r));
    this.changed();
  }
  async setBehaviourDefault(id: BehaviourId, on: boolean) {
    this.behaviours = this.behaviours.map((b) => (b.id === id ? { ...b, all: on } : b));
    this.changed();
  }
  isActive(rule: Rule): boolean {
    // example: a while-rule holds if its room is occupied or it ran in the last 40 minutes
    const room = rule.when.find((c) => c.subject.startsWith('room:'))?.subject.slice(5);
    if (room) return !!this.occupancy[room]?.occupied;
    return !!rule.meta?.last_run && Date.now() - new Date(rule.meta.last_run).getTime() < 40 * 60000;
  }
  today(roomId: string): [number, number][] {
    const room = this.room(roomId);
    return room ? exampleToday(this, room) : [];
  }
  async setDevices(changes: DeviceChange[]) {
    for (const c of changes) {
      const d = this.devices.find((x) => x.entity_id === c.entity_id);
      const u = this.devicesUnused.find((x) => x.entity_id === c.entity_id);
      if (c.hidden && d) {
        this.devices = this.devices.filter((x) => x !== d);
        this.devicesUnused = [...this.devicesUnused, { entity_id: d.entity_id, name: d.name, kind: d.kind, room: d.room, reason: 'user' }];
        continue;
      }
      if (u && (c.hidden === false || c.kind || c.reset)) {
        this.devicesUnused = this.devicesUnused.filter((x) => x !== u);
        this.devices = [...this.devices, { entity_id: u.entity_id, name: u.name, kind: c.kind ?? u.kind, room: c.room ?? u.room ?? undefined, state: 'off' }];
        continue;
      }
      if (c.manual && !d && c.kind) {
        const e = this.entity(c.entity_id);
        this.devices = [...this.devices, { entity_id: c.entity_id, name: c.name || e?.name || c.entity_id, kind: c.kind, room: c.room ?? undefined, state: e?.state ?? 'off', manual: true, icon: c.icon }];
        continue;
      }
      if (!d) continue;
      if (c.reset) {
        this.devices = d.manual ? this.devices.filter((x) => x !== d) : this.devices.map((x) => (x === d ? { ...x, kind: x.auto_kind ?? x.kind, room: x.auto_room ?? x.room, name: x.auto_name ?? x.name, icon: undefined, auto_kind: undefined, auto_room: undefined, auto_name: undefined } : x));
        continue;
      }
      this.devices = this.devices.map((x) =>
        x === d
          ? {
              ...x,
              kind: c.kind ?? x.kind,
              room: c.room === undefined ? x.room : c.room ?? undefined,
              name: c.name || x.name,
              icon: c.icon === undefined ? x.icon : c.icon || undefined,
              kind_hint: c.kind ? undefined : x.kind_hint,
              auto_kind: c.kind && c.kind !== (x.auto_kind ?? x.kind) ? x.auto_kind ?? x.kind : x.auto_kind,
              auto_room: c.room !== undefined && c.room !== (x.auto_room ?? x.room) ? x.auto_room ?? x.room ?? null : x.auto_room,
              auto_name: c.name && c.name !== x.name ? x.auto_name ?? x.name : x.auto_name,
            }
          : x,
      );
    }
    this.changed();
  }
  override async objectSave(obj: Partial<ObjectAlarm>) {
    const id = obj.id || `o_${Math.random().toString(36).slice(2, 8)}`;
    const cur = this.objects.find((o) => o.id === id);
    const base: ObjectAlarm = cur ?? { ...demoObject('other', 'Objekt'), id };
    const next = { ...base, ...obj, id } as ObjectAlarm;
    this.objects = cur ? this.objects.map((o) => (o.id === id ? next : o)) : [...this.objects, next];
    this.changed();
    return id;
  }
  override async objectDelete(id: string) {
    this.objects = this.objects.filter((o) => o.id !== id);
    this.changed();
  }
  override async objectArm(id: string) {
    this.objects = this.objects.map((o) => (o.id === id ? { ...o, state: 'armed', label: 'Scharf', since: Date.now() / 1000 } : o));
    this.changed();
    return { ok: true };
  }
  override async objectDisarm(id: string, opts: { onlyAlarm?: boolean } = {}) {
    this.objects = this.objects.map((o) => (o.id === id ? { ...o, state: opts.onlyAlarm ? 'armed' : 'disarmed', label: opts.onlyAlarm ? 'Scharf' : 'Unscharf', cause: null, cause_name: null } : o));
    this.changed();
    return { ok: true };
  }
  async setAutomation(entity_id: string, enabled: boolean) {
    this.automations = this.automations.map((a) => (a.entity_id === entity_id ? { ...a, enabled } : a));
    this.changed();
  }
  async saveSettings() {}
  async dismissSuggestion(id: string) {
    this.suggestions = this.suggestions.filter((s) => s.id !== id);
    this.changed();
  }

  /** Looks at the example states. The real one asks Home Assistant. */
  async test(rule: Rule): Promise<TestResult> {
    const hour = new Date().getHours();
    const check = (subject: string, verb: string): [boolean, string] => {
      const dev = this.device(subject);
      const m = subject.match(/^(any|all):([a-z_]+)(?:@([a-z_]+))?$/);
      if (m) {
        const list = this.devices.filter((d) => d.kind === m[2] && (!m[3] || m[3] === 'same' || d.room === m[3]));
        const on = list.filter((d) => d.state === 'on');
        if (verb.includes('open') || verb === 'is_on') return [m[1] === 'any' ? on.length > 0 : on.length === list.length, on.length ? `offen: ${on.map((d) => d.name).join(', ')}` : 'alle zu'];
        return [true, `${list.length} Geräte`];
      }
      if (subject.startsWith('room:')) {
        const o = this.occupancy[subject.slice(5)];
        const occupied = !!o?.occupied;
        return [verb === 'is_empty' ? !occupied : verb === 'is_dark' ? true : occupied, occupied ? `belegt${o?.by ? ' (' + o.by + ')' : ''}` : 'leer'];
      }
      if (subject.startsWith('person:')) {
        const id = subject.slice(7);
        const home = id === 'everyone' ? this.persons.every((p) => p.home) : id === 'someone' ? this.persons.some((p) => p.home) : !!this.person(id)?.home;
        const away = id === 'everyone' ? this.persons.every((p) => !p.home) : !home;
        const now = this.persons.map((p) => `${p.name}: ${p.where}`).join(', ');
        return [verb.includes('away') || verb === 'leaves' ? away : home, now];
      }
      if (subject === 'time') {
        const night = hour >= 22 || hour < 6;
        const map: Record<string, boolean> = { night, morning: hour >= 6 && hour < 10, evening: hour >= 18 && hour < 22, workdays: new Date().getDay() % 6 !== 0, weekend: new Date().getDay() % 6 === 0 };
        return [map[verb] ?? true, `jetzt ${new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr`];
      }
      if (subject === 'sun') return [verb === 'is_down' ? hour >= 18 || hour < 7 : hour >= 7 && hour < 18, hour >= 18 || hour < 7 ? 'draußen dunkel' : 'draußen hell'];
      if (subject === 'mode') return [verb === 'is_not' ? this.mode !== 'vacation' : true, `Modus: ${this.mode === 'home' ? 'Zuhause' : this.mode}`];
      if (dev) {
        const on = dev.state === 'on' || dev.state === 'heat';
        if (verb === 'not_cleaned_today') return [true, 'heute noch nicht gesaugt'];
        if (verb.startsWith('is_')) return [verb.includes('off') || verb.includes('closed') || verb.includes('free') ? !on : on, dev.detail ?? (on ? 'an / offen' : 'aus / zu')];
        return [true, dev.detail ?? (on ? 'an / offen' : 'aus / zu')];
      }
      return [true, 'nicht prüfbar'];
    };
    const checks: TestResult['checks'] = [];
    for (const section of ['when', 'and', 'only'] as const)
      rule[section].forEach((c, index) => {
        const [ok, now] = check(c.subject, c.verb);
        checks.push({ section, index, ok, now });
      });
    const conds = checks.filter((c) => c.section !== 'when' || rule.type === 'while');
    const blocked = conds.find((c) => !c.ok);
    const would = rule.then.map((c) => clauseText(this, c, 'then'));
    const verdict = blocked
      ? `Würde jetzt nichts tun: „${clauseText(this, rule[blocked.section][blocked.index], blocked.section)}“ stimmt gerade nicht.`
      : rule.type === 'while'
        ? 'Gilt gerade. Die Regel würde jetzt laufen.'
        : 'Alle Bedingungen stimmen. Die Regel läuft, sobald der Auslöser kommt.';
    return { checks, would, verdict };
  }

  /** Stand-in for the local language model: recognises rooms, devices and a few phrases. */
  async fromText(text: string): Promise<TextDraft> {
    await new Promise((r) => setTimeout(r, 900));
    const t = text.toLowerCase();
    const rule = newRule({ name: text.length > 48 ? text.slice(0, 46) + '…' : text, meta: { origin: 'text' } });
    const unsure: string[] = [];
    const room = this.rooms.find((r) => t.includes(r.name.toLowerCase()));
    const named = this.devices.filter((d) => d.name.length > 3 && t.includes(d.name.toLowerCase()));

    if (/solange/.test(t)) rule.type = 'while';
    // when …
    if (/heimkomm|nach hause komm|heim komm/.test(t)) rule.when.push({ subject: /\bich\b/.test(t) ? 'person:alex' : 'person:someone', verb: 'arrives' });
    else if (/(alle|keiner|niemand).*(weg|aus dem haus|gehen)/.test(t)) rule.when.push({ subject: 'person:everyone', verb: 'leaves' });
    else if (/haustür/.test(t)) rule.when.push({ subject: 'binary_sensor.haustuer', verb: /zu/.test(t) ? 'closes' : 'opens' });
    else if (/fenster/.test(t)) rule.when.push({ subject: room ? `any:window@${room.id}` : 'any:window', verb: rule.type === 'while' ? 'is_open' : 'opens' });
    else if (room && /(rein|betret|komm)/.test(t)) rule.when.push({ subject: `room:${room.id}`, verb: rule.type === 'while' ? 'is_occupied' : 'entered' });
    else if (named[0]) rule.when.push({ subject: named[0].entity_id, verb: named[0].kind === 'door' || named[0].kind === 'window' ? 'opens' : 'turns_on' });
    else unsure.push('Wann soll es passieren?');

    // and …
    if (/(keiner|niemand) (zuhause|daheim|da)/.test(t)) rule.and.push({ subject: 'person:everyone', verb: 'is_away' });

    // then …
    const off = /\baus\b|ausschalten|ausmachen/.test(t);
    if (/heizung/.test(t)) rule.then.push({ subject: room ? `all:climate@${room.id}` : 'all:climate@same', verb: off ? 'turn_off' : 'set_temp', temperature: 21 });
    if (/licht|lampe/.test(t)) rule.then.push({ subject: room ? `all:light@${room.id}` : 'all:light@same', verb: off ? 'turn_off' : 'turn_on' });
    if (/nachricht|bescheid|schick|benachrichtig/.test(t)) rule.then.push({ subject: /\bmir\b|\bich\b/.test(t) ? 'notify:alex' : 'notify:everyone', verb: 'send', message: 'Haustür geöffnet' });
    if (/saug/.test(t)) rule.then.push({ subject: 'vacuum.saugroboter', verb: 'start' });
    if (!rule.then.length) unsure.push('Was soll dann passieren?');

    // only …
    if (/abends/.test(t)) rule.only.push({ subject: 'time', verb: 'evening' });
    if (/nachts/.test(t)) rule.only.push({ subject: 'time', verb: 'night' });
    if (/dunkel/.test(t)) rule.only.push({ subject: 'sun', verb: 'is_down' });
    if (/werktags|unter der woche/.test(t)) rule.only.push({ subject: 'time', verb: 'workdays' });
    return { rule, unsure };
  }
}

/** Example occupancy of today (hour ranges); the integration will deliver real ones. */
function exampleToday(store: Store, room: Room): [number, number][] {
  const seed = [...room.id].reduce((a, c) => a + c.charCodeAt(0), 0);
  const now = new Date().getHours() + new Date().getMinutes() / 60;
  const out: [number, number][] = [];
  let t = 6 + (seed % 3) * 0.5;
  let i = 0;
  while (t < now - 0.3 && i < 9) {
    const len = 0.2 + ((seed * (i + 3)) % 17) / 10;
    out.push([t, Math.min(t + len, now)]);
    t += len + 0.6 + ((seed * (i + 7)) % 23) / 8;
    i++;
  }
  const o = store.occupancy[room.id];
  if (o?.occupied) out.push([Math.max(0, now - (Date.now() - new Date(o.since).getTime()) / 3600000), now]);
  return out;
}

