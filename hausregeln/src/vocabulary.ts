/**
 * The vocabulary: which kinds of things exist and what one can do with them, in plain German
 * (English words: vocabulary-en.ts, switched in place by localizeVocabulary).
 *
 * Verbs come in three flavours, matching the parts of a sentence:
 *   event  – something happens        (WENN die Haustür aufgeht)
 *   state  – something is true        (UND irgendein Fenster offen ist / SOLANGE … / NUR …)
 *   action – something should happen  (DANN Flurlicht einschalten)
 *
 * Labels are the subordinate-clause form German uses after "wenn" ("aufgeht", "offen ist"),
 * with a plural form for "alle …". {param} placeholders are filled in by describe.ts.
 */
import {
  mdiAccount,
  mdiAccountGroup,
  mdiAirFilter,
  mdiBellRing,
  mdiBroom,
  mdiCalendarClock,
  mdiCar,
  mdiCellphoneMessage,
  mdiDoorOpen,
  mdiFan,
  mdiHomeSwitch,
  mdiLightbulb,
  mdiLock,
  mdiMotionSensor,
  mdiPauseCircleOutline,
  mdiPowerSocketEu,
  mdiRadiator,
  mdiRobotVacuum,
  mdiSofa,
  mdiSpeaker,
  mdiThermometer,
  mdiTimerSandComplete,
  mdiWaterAlert,
  mdiWeatherSunset,
  mdiWindowClosedVariant,
  mdiWindowShutter,
  mdiBrightness6,
  mdiLinkVariant,
  mdiHumanGreetingProximity,
  mdiRadar,
  mdiToggleSwitch,
  mdiScriptTextPlay,
  mdiShapeOutline,
  mdiShieldHomeOutline,
  mdiCheckboxMarkedCircleOutline,
  mdiGauge,
  mdiGestureTapButton,
  mdiPalette,
  mdiFormatListBulleted,
  mdiNumeric,
  mdiFormTextbox,
  mdiAlarmLight,
  mdiRobot,
  mdiCamera,
  mdiMapMarker,
  mdiCube,
  mdiAirHumidifier,
  mdiWaterBoiler,
  mdiLightningBoltCircle,
} from '@mdi/js';
import { getLanguage, onLanguageChange, t, type I18nKey } from './i18n';
import { EN_KINDS, EN_MODES } from './vocabulary-en';
export { EN_KINDS, EN_MODES };

// i18n: data (the German base; English words in vocabulary-en.ts)
export type VerbFlavour = 'event' | 'state' | 'action';

export type ParamType = 'duration' | 'percent' | 'temperature' | 'time' | 'text' | 'offset' | 'mode' | 'number' | 'color' | 'zone' | 'days' | 'light';

export interface ParamSpec {
  key: string;
  type: ParamType;
  label: string;
  default?: unknown;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
}

export interface Verb {
  id: string;
  flavour: VerbFlavour;
  label: string;
  /** plural form for "alle …" subjects */
  pl?: string;
  params?: ParamSpec[];
  /** short help shown in the picker */
  hint?: string;
  /** needs the "allow sensitive" option */
  sensitive?: boolean;
}

export interface Kind {
  id: string;
  label: string;
  plural: string;
  /** "irgendein Fenster", "irgendeine Tür" */
  any: string;
  icon: string;
  verbs: Verb[];
  /** the subject is not shown in these sections, the verb reads on its own ("Nur nachts") */
  hide_subject?: Array<'when' | 'and' | 'only' | 'then'>;
  /** can be used with any:/all: */
  placeholder?: boolean;
}

const dur = (label = 'Dauer', d = '5m'): ParamSpec => ({ key: 'for', type: 'duration', label, default: d });

const openable = (id: string, label: string, plural: string, any: string, icon: string): Kind => ({
  id,
  label,
  plural,
  any,
  icon,
  placeholder: true,
  verbs: [
    { id: 'opens', flavour: 'event', label: 'aufgeht', pl: 'aufgehen' },
    { id: 'closes', flavour: 'event', label: 'zugeht', pl: 'zugehen' },
    { id: 'open_for', flavour: 'event', label: 'länger als {for} offen ist', pl: 'länger als {for} offen sind', params: [dur('Wie lange', '10m')] },
    { id: 'is_open', flavour: 'state', label: 'offen ist', pl: 'offen sind' },
    { id: 'is_closed', flavour: 'state', label: 'zu ist', pl: 'zu sind' },
  ],
});

const switchable = (id: string, label: string, plural: string, any: string, icon: string, extra: Verb[] = []): Kind => ({
  id,
  label,
  plural,
  any,
  icon,
  placeholder: true,
  verbs: [
    { id: 'turns_on', flavour: 'event', label: 'angeht', pl: 'angehen' },
    { id: 'turns_off', flavour: 'event', label: 'ausgeht', pl: 'ausgehen' },
    { id: 'on_for', flavour: 'event', label: 'länger als {for} an ist', pl: 'länger als {for} an sind', params: [dur('Wie lange', '10m')] },
    { id: 'off_for', flavour: 'event', label: 'länger als {for} aus ist', pl: 'länger als {for} aus sind', params: [dur('Wie lange', '3m')] },
    { id: 'is_on', flavour: 'state', label: 'an ist', pl: 'an sind' },
    { id: 'is_off', flavour: 'state', label: 'aus ist', pl: 'aus sind' },
    { id: 'turn_on', flavour: 'action', label: 'einschalten' },
    { id: 'turn_off', flavour: 'action', label: 'ausschalten' },
    { id: 'toggle', flavour: 'action', label: 'umschalten' },
    ...extra,
  ],
});

/** any entity of Home Assistant that has no own kind: by its domain (sensor, select, button …) */
const value = (key = 'value', label = 'Wert', d: unknown = 0): ParamSpec => ({ key, type: 'number', label, default: d, step: 1 });
const text = (key: string, label: string, d = ''): ParamSpec => ({ key, type: 'text', label, default: d });
const numeric = (id: string, label: string, plural: string, icon: string, actions: Verb[] = []): Kind => ({
  id,
  label,
  plural,
  any: `irgendein ${label}`,
  icon,
  verbs: [
    { id: 'changes', flavour: 'event', label: 'sich ändert', pl: 'sich ändern' },
    { id: 'above', flavour: 'event', label: 'über {value} steigt', pl: 'über {value} steigen', params: [value()] },
    { id: 'below', flavour: 'event', label: 'unter {value} fällt', pl: 'unter {value} fallen', params: [value()] },
    { id: 'becomes', flavour: 'event', label: 'auf „{state}“ wechselt', pl: 'auf „{state}“ wechseln', params: [text('state', 'Zustand')] },
    { id: 'is', flavour: 'state', label: '„{state}“ ist', pl: '„{state}“ sind', params: [text('state', 'Zustand')] },
    { id: 'is_not', flavour: 'state', label: 'nicht „{state}“ ist', pl: 'nicht „{state}“ sind', params: [text('state', 'Zustand')] },
    { id: 'is_above', flavour: 'state', label: 'über {value} ist', pl: 'über {value} sind', params: [value()] },
    { id: 'is_below', flavour: 'state', label: 'unter {value} ist', pl: 'unter {value} sind', params: [value()] },
    { id: 'between', flavour: 'event', label: 'zwischen {min} und {max} kommt', pl: 'zwischen {min} und {max} kommen', params: [value('min', 'Von', 0), value('max', 'Bis', 100)] },
    { id: 'is_between', flavour: 'state', label: 'zwischen {min} und {max} ist', pl: 'zwischen {min} und {max} sind', params: [value('min', 'Von', 0), value('max', 'Bis', 100)] },
    ...actions,
  ],
});
const choice = (id: string, label: string, plural: string, icon: string, action = true): Kind => ({
  id,
  label,
  plural,
  any: `irgendein ${label}`,
  icon,
  verbs: [
    { id: 'changes', flavour: 'event', label: 'sich ändert' },
    { id: 'becomes', flavour: 'event', label: 'auf „{state}“ wechselt', params: [text('state', 'Wert')] },
    { id: 'is', flavour: 'state', label: '„{state}“ ist', params: [text('state', 'Wert')] },
    { id: 'is_not', flavour: 'state', label: 'nicht „{state}“ ist', params: [text('state', 'Wert')] },
    ...(action ? [{ id: 'select', flavour: 'action' as const, label: 'auf „{state}“ stellen', params: [text('state', 'Wert')] }] : []),
  ],
});
const pressable = (id: string, label: string, icon: string): Kind => ({
  id,
  label,
  plural: `${label}s`,
  any: `irgendein ${label}`,
  icon,
  verbs: [
    { id: 'pressed', flavour: 'event', label: 'gedrückt wird' },
    { id: 'press', flavour: 'action', label: 'drücken' },
  ],
});
const binary = (id: string, label: string, plural: string, icon: string): Kind => ({
  id,
  label,
  plural,
  any: `irgendein ${label}`,
  icon,
  verbs: [
    { id: 'turns_on', flavour: 'event', label: 'aktiv wird', pl: 'aktiv werden' },
    { id: 'turns_off', flavour: 'event', label: 'inaktiv wird', pl: 'inaktiv werden' },
    { id: 'on_for', flavour: 'event', label: 'länger als {for} aktiv ist', pl: 'länger als {for} aktiv sind', params: [dur('Wie lange', '10m')] },
    { id: 'is_on', flavour: 'state', label: 'aktiv ist', pl: 'aktiv sind' },
    { id: 'is_off', flavour: 'state', label: 'inaktiv ist', pl: 'inaktiv sind' },
  ],
});

/** kinds named after a Home Assistant domain, for entities Hausregeln does not sort into a kind of its own */
export const DOMAIN_KINDS = [
  'binary_sensor', 'sensor', 'number', 'input_number', 'select', 'input_select', 'input_text', 'button', 'input_button', 'scene',
  'input_boolean', 'siren', 'humidifier', 'water_heater', 'automation', 'camera', 'device_tracker', 'event', 'media_player', 'entity',
];

export const KINDS: Record<string, Kind> = {
  light: switchable('light', 'Licht', 'Lichter', 'irgendein Licht', mdiLightbulb, [
    {
      id: 'dim',
      flavour: 'action',
      label: 'auf {brightness} dimmen',
      params: [{ key: 'brightness', type: 'percent', label: 'Helligkeit', default: 50, min: 1, max: 100, step: 1, unit: '%' }],
    },
    { id: 'color', flavour: 'action', label: 'in {color} leuchten', params: [{ key: 'color', type: 'color', label: 'Farbe', default: 'warmweiß' }] },
    { id: 'blink', flavour: 'action', label: 'blinken lassen', hint: 'Dreimal kurz, dann wie vorher' },
    {
      id: 'set',
      flavour: 'action',
      label: 'einstellen: {light}',
      hint: 'Farbe (RGB, RGBW, Weißton …), Helligkeit, Effekt, Übergang, jede Lampe einzeln',
      params: [{ key: 'light', type: 'light', label: 'Licht', default: { mode: 'on', brightness: 80, color: 'warm' } }],
    },
    {
      id: 'is_between',
      flavour: 'state',
      label: 'zwischen {min} und {max} % hell ist',
      pl: 'zwischen {min} und {max} % hell sind',
      hint: 'Aus zählt als 0 %',
      params: [
        { key: 'min', type: 'number', label: 'Von', default: 20, min: 0, max: 100, step: 5, unit: '%' },
        { key: 'max', type: 'number', label: 'Bis', default: 60, min: 0, max: 100, step: 5, unit: '%' },
      ],
    },
    { id: 'brighter', flavour: 'event', label: 'heller als {brightness} wird', pl: 'heller als {brightness} werden', params: [{ key: 'brightness', type: 'percent', label: 'Helligkeit', default: 50, min: 1, max: 100, step: 1, unit: '%' }] },
    { id: 'dimmer', flavour: 'event', label: 'dunkler als {brightness} wird', pl: 'dunkler als {brightness} werden', hint: 'Aus zählt als 0 %', params: [{ key: 'brightness', type: 'percent', label: 'Helligkeit', default: 50, min: 1, max: 100, step: 1, unit: '%' }] },
    { id: 'is_brighter', flavour: 'state', label: 'heller als {brightness} ist', pl: 'heller als {brightness} sind', params: [{ key: 'brightness', type: 'percent', label: 'Helligkeit', default: 50, min: 1, max: 100, step: 1, unit: '%' }] },
    { id: 'is_dimmer', flavour: 'state', label: 'dunkler als {brightness} ist', pl: 'dunkler als {brightness} sind', hint: 'Aus zählt als 0 %', params: [{ key: 'brightness', type: 'percent', label: 'Helligkeit', default: 50, min: 1, max: 100, step: 1, unit: '%' }] },
  ]),
  window: openable('window', 'Fenster', 'Fenster', 'irgendein Fenster', mdiWindowClosedVariant),
  door: openable('door', 'Tür', 'Türen', 'irgendeine Tür', mdiDoorOpen),
  motion: {
    id: 'motion',
    label: 'Bewegungsmelder',
    plural: 'Bewegungsmelder',
    any: 'irgendein Bewegungsmelder',
    icon: mdiMotionSensor,
    placeholder: true,
    verbs: [
      { id: 'detected', flavour: 'event', label: 'Bewegung meldet', pl: 'Bewegung melden' },
      { id: 'clear_for', flavour: 'event', label: 'seit {for} ruhig ist', pl: 'seit {for} ruhig sind', params: [dur('Wie lange', '5m')] },
      { id: 'is_active', flavour: 'state', label: 'Bewegung sieht', pl: 'Bewegung sehen' },
      { id: 'is_clear', flavour: 'state', label: 'ruhig ist', pl: 'ruhig sind' },
    ],
  },
  zone: {
    id: 'zone',
    label: 'Zone',
    plural: 'Zonen',
    any: 'irgendeine Zone',
    icon: mdiSofa,
    verbs: [
      { id: 'occupied', flavour: 'event', label: 'belegt wird', hint: 'Jemand setzt oder stellt sich dorthin' },
      { id: 'free_for', flavour: 'event', label: 'länger als {for} frei ist', params: [dur('Wie lange', '2m')] },
      { id: 'is_occupied', flavour: 'state', label: 'belegt ist' },
      { id: 'is_free', flavour: 'state', label: 'frei ist' },
    ],
  },
  presence: {
    id: 'presence',
    label: 'Anwesenheitssensor',
    plural: 'Anwesenheitssensoren',
    any: 'irgendein Anwesenheitssensor',
    icon: mdiRadar,
    placeholder: true,
    verbs: [
      { id: 'occupied', flavour: 'event', label: 'jemanden erkennt', pl: 'jemanden erkennen' },
      { id: 'free_for', flavour: 'event', label: 'länger als {for} niemanden sieht', pl: 'länger als {for} niemanden sehen', params: [dur('Wie lange', '2m')] },
      { id: 'is_occupied', flavour: 'state', label: 'jemanden sieht', pl: 'jemanden sehen' },
      { id: 'is_free', flavour: 'state', label: 'niemanden sieht', pl: 'niemanden sehen' },
    ],
  },
  room: {
    id: 'room',
    label: 'Raum',
    plural: 'Räume',
    any: 'irgendein Raum',
    icon: mdiHumanGreetingProximity,
    verbs: [
      { id: 'entered', flavour: 'event', label: 'betreten wird', hint: 'Jemand kommt in den Raum, egal welcher Sensor es merkt' },
      { id: 'empty', flavour: 'event', label: 'leer wird', hint: 'Niemand mehr da, nach der eingestellten Wartezeit' },
      { id: 'empty_for', flavour: 'event', label: 'länger als {for} leer ist', params: [dur('Wie lange', '30m')] },
      { id: 'is_occupied', flavour: 'state', label: 'belegt ist', pl: 'belegt sind' },
      { id: 'is_empty', flavour: 'state', label: 'leer ist', pl: 'leer sind' },
      { id: 'is_dark', flavour: 'state', label: 'dunkel ist', pl: 'dunkel sind', hint: 'Laut Helligkeitssensor des Raums' },
      { id: 'is_bright', flavour: 'state', label: 'hell ist', pl: 'hell sind', hint: 'Laut Helligkeitssensor des Raums' },
    ],
  },
  climate: {
    id: 'climate',
    label: 'Heizung',
    plural: 'Heizungen',
    any: 'irgendeine Heizung',
    icon: mdiRadiator,
    placeholder: true,
    verbs: [
      { id: 'starts_heating', flavour: 'event', label: 'zu heizen beginnt', pl: 'zu heizen beginnen' },
      { id: 'is_heating', flavour: 'state', label: 'heizt', pl: 'heizen' },
      {
        id: 'set_temp',
        flavour: 'action',
        label: 'auf {temperature} stellen',
        params: [{ key: 'temperature', type: 'temperature', label: 'Temperatur', default: 21, min: 5, max: 28, step: 0.5, unit: '°C' }],
      },
      { id: 'eco', flavour: 'action', label: 'auf Sparen stellen', hint: 'Absenktemperatur, z. B. 17 °C' },
      { id: 'turn_off', flavour: 'action', label: 'ausschalten' },
      { id: 'boost', flavour: 'action', label: 'kurz hochheizen', params: [dur('Wie lange', '30m')] },
    ],
  },
  cover: {
    id: 'cover',
    label: 'Rollladen',
    plural: 'Rollläden',
    any: 'irgendein Rollladen',
    icon: mdiWindowShutter,
    placeholder: true,
    verbs: [
      { id: 'opens', flavour: 'event', label: 'hochfährt', pl: 'hochfahren' },
      { id: 'closes', flavour: 'event', label: 'runterfährt', pl: 'runterfahren' },
      { id: 'is_open', flavour: 'state', label: 'offen ist', pl: 'offen sind' },
      { id: 'open', flavour: 'action', label: 'hochfahren' },
      { id: 'close', flavour: 'action', label: 'runterfahren' },
      {
        id: 'position',
        flavour: 'action',
        label: 'auf {position} fahren',
        params: [{ key: 'position', type: 'percent', label: 'Position', default: 30, min: 0, max: 100, step: 5, unit: '%' }],
      },
    ],
  },
  media: {
    id: 'media',
    label: 'Lautsprecher / TV',
    plural: 'Lautsprecher',
    any: 'irgendein Lautsprecher',
    icon: mdiSpeaker,
    placeholder: true,
    verbs: [
      { id: 'turns_on', flavour: 'event', label: 'eingeschaltet wird' },
      { id: 'starts_playing', flavour: 'event', label: 'zu spielen beginnt', pl: 'zu spielen beginnen' },
      { id: 'stops', flavour: 'event', label: 'aufhört zu spielen' },
      { id: 'is_playing', flavour: 'state', label: 'spielt', pl: 'spielen' },
      { id: 'is_on', flavour: 'state', label: 'an ist', pl: 'an sind' },
      { id: 'pause', flavour: 'action', label: 'pausieren' },
      { id: 'play', flavour: 'action', label: 'weiterspielen' },
      {
        id: 'volume',
        flavour: 'action',
        label: 'auf Lautstärke {volume} stellen',
        params: [{ key: 'volume', type: 'percent', label: 'Lautstärke', default: 20, min: 0, max: 100, step: 5, unit: '%' }],
      },
      { id: 'announce', flavour: 'action', label: 'ansagen: „{message}“', params: [{ key: 'message', type: 'text', label: 'Text', default: '' }] },
      { id: 'turn_off', flavour: 'action', label: 'ausschalten' },
    ],
  },
  switch: switchable('switch', 'Schalter', 'Schalter', 'irgendein Schalter', mdiToggleSwitch),
  outlet: switchable('outlet', 'Steckdose', 'Steckdosen', 'irgendeine Steckdose', mdiPowerSocketEu),
  script: {
    id: 'script',
    label: 'Skript',
    plural: 'Skripte',
    any: 'irgendein Skript',
    icon: mdiScriptTextPlay,
    verbs: [
      { id: 'ran', flavour: 'event', label: 'gelaufen ist' },
      { id: 'run', flavour: 'action', label: 'ausführen' },
    ],
  },
  fan: switchable('fan', 'Lüfter', 'Lüfter', 'irgendein Lüfter', mdiFan),
  purifier: switchable('purifier', 'Luftreiniger', 'Luftreiniger', 'irgendein Luftreiniger', mdiAirFilter),
  leak: {
    id: 'leak',
    label: 'Wassermelder',
    plural: 'Wassermelder',
    any: 'irgendein Wassermelder',
    icon: mdiWaterAlert,
    placeholder: true,
    verbs: [
      { id: 'wet', flavour: 'event', label: 'Wasser meldet', pl: 'Wasser melden' },
      { id: 'is_wet', flavour: 'state', label: 'nass ist', pl: 'nass sind' },
    ],
  },
  temperature: {
    id: 'temperature',
    label: 'Temperatur',
    plural: 'Temperaturen',
    any: 'irgendeine Temperatur',
    icon: mdiThermometer,
    verbs: [
      {
        id: 'below',
        flavour: 'event',
        label: 'unter {value} fällt',
        params: [{ key: 'value', type: 'temperature', label: 'Grenze', default: 19, min: -20, max: 40, step: 0.5, unit: '°C' }],
      },
      {
        id: 'above',
        flavour: 'event',
        label: 'über {value} steigt',
        params: [{ key: 'value', type: 'temperature', label: 'Grenze', default: 24, min: -20, max: 40, step: 0.5, unit: '°C' }],
      },
      {
        id: 'is_below',
        flavour: 'state',
        label: 'unter {value} liegt',
        params: [{ key: 'value', type: 'temperature', label: 'Grenze', default: 19, min: -20, max: 40, step: 0.5, unit: '°C' }],
      },
      {
        id: 'is_above',
        flavour: 'state',
        label: 'über {value} liegt',
        params: [{ key: 'value', type: 'temperature', label: 'Grenze', default: 24, min: -20, max: 40, step: 0.5, unit: '°C' }],
      },
    ],
  },
  illuminance: {
    id: 'illuminance',
    label: 'Helligkeit',
    plural: 'Helligkeiten',
    any: 'irgendeine Helligkeit',
    icon: mdiBrightness6,
    verbs: [
      {
        id: 'below',
        flavour: 'event',
        label: 'unter {value} fällt',
        params: [{ key: 'value', type: 'number', label: 'Grenze', default: 80, min: 0, max: 2000, step: 10, unit: 'lx' }],
      },
      {
        id: 'above',
        flavour: 'event',
        label: 'über {value} steigt',
        params: [{ key: 'value', type: 'number', label: 'Grenze', default: 300, min: 0, max: 2000, step: 10, unit: 'lx' }],
      },
      {
        id: 'is_below',
        flavour: 'state',
        label: 'unter {value} liegt',
        params: [{ key: 'value', type: 'number', label: 'Grenze', default: 80, min: 0, max: 2000, step: 10, unit: 'lx' }],
      },
      {
        id: 'is_above',
        flavour: 'state',
        label: 'über {value} liegt',
        params: [{ key: 'value', type: 'number', label: 'Grenze', default: 300, min: 0, max: 2000, step: 10, unit: 'lx' }],
      },
    ],
  },
  lock: {
    id: 'lock',
    label: 'Schloss',
    plural: 'Schlösser',
    any: 'irgendein Schloss',
    icon: mdiLock,
    verbs: [
      { id: 'unlocked', flavour: 'event', label: 'aufgeschlossen wird' },
      { id: 'is_locked', flavour: 'state', label: 'abgeschlossen ist', pl: 'abgeschlossen sind' },
      { id: 'lock', flavour: 'action', label: 'abschließen' },
      { id: 'unlock', flavour: 'action', label: 'aufschließen', sensitive: true },
    ],
  },
  // cars, e-bikes, GPS trackers (inventory.py): the tracker of the vehicle; its doors never count as doors of the house
  vehicle: {
    id: 'vehicle',
    label: 'Fahrzeug',
    plural: 'Fahrzeuge',
    any: 'irgendein Fahrzeug',
    icon: mdiCar,
    verbs: [
      { id: 'arrives', flavour: 'event', label: 'zuhause ankommt', pl: 'zuhause ankommen' },
      { id: 'leaves', flavour: 'event', label: 'wegfährt', pl: 'wegfahren' },
      { id: 'is_home', flavour: 'state', label: 'zuhause ist', pl: 'zuhause sind' },
      { id: 'is_away', flavour: 'state', label: 'weg ist', pl: 'weg sind' },
    ],
  },
  vacuum: {
    id: 'vacuum',
    label: 'Saugroboter',
    plural: 'Saugroboter',
    any: 'irgendein Saugroboter',
    icon: mdiRobotVacuum,
    verbs: [
      { id: 'starts', flavour: 'event', label: 'losfährt' },
      { id: 'done', flavour: 'event', label: 'fertig ist' },
      { id: 'is_docked', flavour: 'state', label: 'in der Station steht' },
      { id: 'cleaned_today', flavour: 'state', label: 'heute schon gesaugt hat' },
      { id: 'not_cleaned_today', flavour: 'state', label: 'heute noch nicht gesaugt hat' },
      { id: 'start', flavour: 'action', label: 'saugen lassen' },
      { id: 'clean_rooms', flavour: 'action', label: '{rooms} saugen lassen', params: [{ key: 'rooms', type: 'text', label: 'Räume', default: 'Küche' }] },
      { id: 'dock', flavour: 'action', label: 'zur Station schicken' },
    ],
  },
  person: {
    id: 'person',
    label: 'Person',
    plural: 'Personen',
    any: 'jemand',
    icon: mdiAccount,
    verbs: [
      { id: 'arrives', flavour: 'event', label: 'heimkommt', pl: 'heimkommen' },
      { id: 'leaves', flavour: 'event', label: 'das Haus verlässt', pl: 'weg sind' },
      {
        id: 'coming_home',
        flavour: 'event',
        label: 'sich dem Zuhause nähert',
        pl: 'sich dem Zuhause nähern',
        hint: 'Näher als 2 km (einstellbar) und entfernt sich nicht',
        params: [{ key: 'distance', type: 'number', label: 'Näher als', default: 2, unit: 'km', min: 0.5, max: 50, step: 0.5 }],
      },
      {
        id: 'heading_home',
        flavour: 'event',
        label: 'wahrscheinlich nach Hause kommt',
        pl: 'wahrscheinlich nach Hause kommen',
        hint: 'Gelernt aus den bisherigen Wegen: Startort, Wochentag, Uhrzeit und Richtung',
        params: [{ key: 'value', type: 'percent', label: 'Mindestens so sicher', default: 60, min: 30, max: 95, step: 5 }],
      },
      {
        id: 'arrives_within',
        flavour: 'event',
        label: 'in unter {value} zuhause ist',
        pl: 'in unter {value} zuhause sind',
        hint: 'Geschätzte Ankunft aus früheren Wegen, Restweg und Tempo',
        params: [{ key: 'value', type: 'number', label: 'Ankunft in unter', default: 10, unit: 'Min.', min: 1, max: 120, step: 1 }],
      },
      {
        id: 'moving_for',
        flavour: 'event',
        label: 'seit {value} unterwegs ist',
        pl: 'seit {value} unterwegs sind',
        hint: 'Unterwegs = weder in einer Zone noch an einem Ort stehen geblieben',
        params: [{ key: 'value', type: 'number', label: 'Unterwegs seit', default: 30, unit: 'Min.', min: 5, max: 600, step: 5 }],
      },
      { id: 'enters_zone', flavour: 'event', label: 'bei {zone} ankommt', pl: 'bei {zone} ankommen', params: [{ key: 'zone', type: 'zone', label: 'Ort', default: 'home' }] },
      { id: 'leaves_zone', flavour: 'event', label: '{zone} verlässt', pl: '{zone} verlassen', params: [{ key: 'zone', type: 'zone', label: 'Ort', default: 'home' }] },
      { id: 'in_zone', flavour: 'state', label: 'bei {zone} ist', pl: 'bei {zone} sind', params: [{ key: 'zone', type: 'zone', label: 'Ort', default: 'home' }] },
      { id: 'not_in_zone', flavour: 'state', label: 'nicht bei {zone} ist', pl: 'nicht bei {zone} sind', params: [{ key: 'zone', type: 'zone', label: 'Ort', default: 'home' }] },
      {
        id: 'far_from',
        flavour: 'event',
        label: 'mehr als {distance} von {zone} weg ist',
        pl: 'mehr als {distance} von {zone} weg sind',
        hint: 'Z. B. für den Urlaubsmodus: alle mehr als 100 km weg, seit 1 Tag',
        params: [
          { key: 'distance', type: 'number', label: 'Entfernung', default: 100, unit: 'km', min: 1, max: 20000, step: 10 },
          { key: 'zone', type: 'zone', label: 'Ort', default: 'home' },
        ],
      },
      { id: 'is_home', flavour: 'state', label: 'zuhause ist', pl: 'zuhause sind' },
      { id: 'is_away', flavour: 'state', label: 'weg ist', pl: 'weg sind' },
      {
        id: 'is_far',
        flavour: 'state',
        label: 'mehr als {distance} von {zone} weg ist',
        pl: 'mehr als {distance} von {zone} weg sind',
        params: [
          { key: 'distance', type: 'number', label: 'Entfernung', default: 100, unit: 'km', min: 1, max: 20000, step: 10 },
          { key: 'zone', type: 'zone', label: 'Ort', default: 'home' },
        ],
      },
      {
        id: 'is_near',
        flavour: 'state',
        label: 'auf dem Heimweg ist',
        pl: 'auf dem Heimweg sind',
        hint: 'Näher als 2 km (einstellbar) und entfernt sich nicht',
        params: [{ key: 'distance', type: 'number', label: 'Näher als', default: 2, unit: 'km', min: 0.5, max: 50, step: 0.5 }],
      },
      {
        id: 'is_heading_home',
        flavour: 'state',
        label: 'wahrscheinlich auf dem Heimweg ist',
        pl: 'wahrscheinlich auf dem Heimweg sind',
        hint: 'Bei „alle“ zählt nur, wer unterwegs ist',
        params: [{ key: 'value', type: 'percent', label: 'Mindestens so sicher', default: 60, min: 30, max: 95, step: 5 }],
      },
      {
        id: 'is_arriving_within',
        flavour: 'state',
        label: 'in unter {value} zuhause ist',
        pl: 'in unter {value} zuhause sind',
        params: [{ key: 'value', type: 'number', label: 'Ankunft in unter', default: 10, unit: 'Min.', min: 1, max: 120, step: 1 }],
      },
      {
        id: 'is_moving_for',
        flavour: 'state',
        label: 'seit {value} unterwegs ist',
        pl: 'seit {value} unterwegs sind',
        params: [{ key: 'value', type: 'number', label: 'Unterwegs seit', default: 30, unit: 'Min.', min: 5, max: 600, step: 5 }],
      },
    ],
  },
  time: {
    id: 'time',
    label: 'Zeit',
    plural: 'Zeiten',
    any: 'Zeit',
    icon: mdiCalendarClock,
    hide_subject: ['when', 'and', 'only'],
    verbs: [
      { id: 'at', flavour: 'event', label: 'es {time} Uhr ist', params: [{ key: 'time', type: 'time', label: 'Uhrzeit', default: '07:00' }] },
      { id: 'night', flavour: 'state', label: 'nachts', hint: '22:00 – 6:00 Uhr, änderbar' },
      { id: 'morning', flavour: 'state', label: 'morgens', hint: '6:00 – 10:00 Uhr' },
      { id: 'evening', flavour: 'state', label: 'abends', hint: '18:00 – 22:00 Uhr' },
      { id: 'workdays', flavour: 'state', label: 'werktags', hint: 'Montag bis Freitag, ohne Feiertage' },
      { id: 'weekend', flavour: 'state', label: 'am Wochenende' },
      { id: 'weekdays', flavour: 'state', label: 'an diesen Tagen: {days}', params: [{ key: 'days', type: 'days', label: 'Tage', default: 'mon,tue,wed,thu,fri' }] },
      {
        id: 'between',
        flavour: 'state',
        label: 'zwischen {from} und {to} Uhr',
        params: [
          { key: 'from', type: 'time', label: 'Von', default: '08:00' },
          { key: 'to', type: 'time', label: 'Bis', default: '20:00' },
        ],
      },
    ],
  },
  sun: {
    id: 'sun',
    label: 'Sonne',
    plural: 'Sonne',
    any: 'Sonne',
    icon: mdiWeatherSunset,
    hide_subject: ['and', 'only'],
    verbs: [
      { id: 'sets', flavour: 'event', label: 'untergeht', params: [{ key: 'offset', type: 'offset', label: 'Versatz', default: '0m' }] },
      { id: 'rises', flavour: 'event', label: 'aufgeht', params: [{ key: 'offset', type: 'offset', label: 'Versatz', default: '0m' }] },
      { id: 'is_down', flavour: 'state', label: 'wenn es draußen dunkel ist' },
      { id: 'is_up', flavour: 'state', label: 'wenn es draußen hell ist' },
      { id: 'after_sunset', flavour: 'state', label: 'nach Sonnenuntergang', params: [{ key: 'offset', type: 'offset', label: 'Versatz', default: '0m' }] },
      { id: 'before_sunset', flavour: 'state', label: 'vor Sonnenuntergang', params: [{ key: 'offset', type: 'offset', label: 'Versatz', default: '0m' }] },
      { id: 'after_sunrise', flavour: 'state', label: 'nach Sonnenaufgang', params: [{ key: 'offset', type: 'offset', label: 'Versatz', default: '0m' }] },
      { id: 'before_sunrise', flavour: 'state', label: 'vor Sonnenaufgang', params: [{ key: 'offset', type: 'offset', label: 'Versatz', default: '0m' }] },
    ],
  },
  mode: {
    id: 'mode',
    label: 'Hausmodus',
    plural: 'Hausmodus',
    any: 'Hausmodus',
    icon: mdiHomeSwitch,
    hide_subject: ['and', 'only'],
    verbs: [
      { id: 'changes_to', flavour: 'event', label: 'auf {mode} wechselt', params: [{ key: 'mode', type: 'mode', label: 'Modus', default: 'sleep' }] },
      { id: 'is', flavour: 'state', label: 'im Modus {mode}', params: [{ key: 'mode', type: 'mode', label: 'Modus', default: 'home' }] },
      { id: 'is_not', flavour: 'state', label: 'nicht im Modus {mode}', params: [{ key: 'mode', type: 'mode', label: 'Modus', default: 'vacation' }] },
      { id: 'set', flavour: 'action', label: 'auf {mode} stellen', params: [{ key: 'mode', type: 'mode', label: 'Modus', default: 'away' }] },
    ],
  },
  notify: {
    id: 'notify',
    label: 'Nachricht',
    plural: 'Nachrichten',
    any: 'alle',
    icon: mdiCellphoneMessage,
    verbs: [
      { id: 'send', flavour: 'action', label: 'Bescheid geben: „{message}“', params: [{ key: 'message', type: 'text', label: 'Nachricht', default: '' }] },
      {
        id: 'ask',
        flavour: 'action',
        label: 'fragen: „{message}“',
        hint: 'Mit Ja/Nein-Knöpfen. Die Regel wartet auf die Antwort.',
        params: [{ key: 'message', type: 'text', label: 'Frage', default: '' }],
      },
      { id: 'alarm', flavour: 'action', label: 'laut warnen: „{message}“', hint: 'Kommt auch bei „Nicht stören“ durch', params: [{ key: 'message', type: 'text', label: 'Warnung', default: '' }] },
    ],
  },
  wait: {
    id: 'wait',
    label: 'Warten',
    plural: 'Warten',
    any: 'Warten',
    icon: mdiTimerSandComplete,
    hide_subject: ['then'],
    verbs: [
      { id: 'wait', flavour: 'action', label: '{for} warten', params: [dur('Wie lange', '5m')] },
      { id: 'wait_until_empty', flavour: 'action', label: 'warten, bis der Raum leer ist' },
    ],
  },
  group: {
    ...switchable('group', 'Gruppe', 'Gruppen', 'irgendeine Gruppe', mdiShapeOutline),
    placeholder: false,
  },
  alarm: {
    id: 'alarm',
    label: 'Alarmanlage',
    plural: 'Alarmanlage',
    any: 'Alarmanlage',
    icon: mdiShieldHomeOutline,
    verbs: [
      { id: 'triggered', flavour: 'event', label: 'Alarm auslöst' },
      { id: 'armed', flavour: 'event', label: 'scharf geschaltet wird' },
      { id: 'disarmed', flavour: 'event', label: 'ausgeschaltet wird' },
      { id: 'is_armed', flavour: 'state', label: 'scharf ist' },
      { id: 'is_disarmed', flavour: 'state', label: 'unscharf ist' },
      { id: 'is_triggered', flavour: 'state', label: 'Alarm hat' },
      { id: 'arm_away', flavour: 'action', label: 'scharf schalten (abwesend)' },
      { id: 'arm_night', flavour: 'action', label: 'scharf schalten (Nacht)' },
      { id: 'arm_home', flavour: 'action', label: 'scharf schalten (zuhause)' },
      { id: 'disarm', flavour: 'action', label: 'ausschalten', sensitive: true },
      { id: 'trigger', flavour: 'action', label: 'Alarm auslösen' },
    ],
  },
  rule: {
    id: 'rule',
    label: 'Regel',
    plural: 'Regeln',
    any: 'eine Regel',
    icon: mdiLinkVariant,
    verbs: [
      { id: 'ran', flavour: 'event', label: 'gelaufen ist' },
      { id: 'is_active', flavour: 'state', label: 'gerade gilt', hint: 'Für Solange-Regeln' },
      { id: 'run', flavour: 'action', label: 'starten' },
      { id: 'pause', flavour: 'action', label: 'pausieren', params: [dur('Wie lange', '1h')] },
    ],
  },
  // ---- any other entity, by domain
  binary_sensor: binary('binary_sensor', 'Sensor (an/aus)', 'Sensoren', mdiCheckboxMarkedCircleOutline),
  sensor: numeric('sensor', 'Sensor', 'Sensoren', mdiGauge),
  number: numeric('number', 'Zahl', 'Zahlen', mdiNumeric, [{ id: 'set_value', flavour: 'action', label: 'auf {value} stellen', params: [value()] }]),
  input_number: numeric('input_number', 'Zahl (Helfer)', 'Zahlen', mdiNumeric, [{ id: 'set_value', flavour: 'action', label: 'auf {value} stellen', params: [value()] }]),
  select: choice('select', 'Auswahl', 'Auswahlen', mdiFormatListBulleted),
  input_select: choice('input_select', 'Auswahl (Helfer)', 'Auswahlen', mdiFormatListBulleted),
  input_text: {
    ...choice('input_text', 'Text (Helfer)', 'Texte', mdiFormTextbox, false),
    verbs: [...choice('input_text', '', '', '', false).verbs, { id: 'set_text', flavour: 'action', label: 'auf „{state}“ setzen', params: [text('state', 'Text')] }],
  },
  button: pressable('button', 'Knopf', mdiGestureTapButton),
  input_button: pressable('input_button', 'Knopf (Helfer)', mdiGestureTapButton),
  scene: {
    id: 'scene',
    label: 'Szene',
    plural: 'Szenen',
    any: 'irgendeine Szene',
    icon: mdiPalette,
    verbs: [
      { id: 'activated', flavour: 'event', label: 'aktiviert wird' },
      { id: 'activate', flavour: 'action', label: 'aktivieren' },
    ],
  },
  input_boolean: switchable('input_boolean', 'Helfer (an/aus)', 'Helfer', 'irgendein Helfer', mdiToggleSwitch),
  siren: switchable('siren', 'Sirene', 'Sirenen', 'irgendeine Sirene', mdiAlarmLight),
  humidifier: switchable('humidifier', 'Luftbefeuchter', 'Luftbefeuchter', 'irgendein Luftbefeuchter', mdiAirHumidifier),
  water_heater: switchable('water_heater', 'Warmwasser', 'Warmwasser', 'irgendein Warmwasser', mdiWaterBoiler),
  automation: switchable('automation', 'HA-Automation', 'HA-Automationen', 'irgendeine HA-Automation', mdiRobot, [{ id: 'trigger', flavour: 'action', label: 'auslösen' }]),
  camera: switchable('camera', 'Kamera', 'Kameras', 'irgendeine Kamera', mdiCamera),
  device_tracker: {
    id: 'device_tracker',
    label: 'Ortung',
    plural: 'Ortungen',
    any: 'irgendeine Ortung',
    icon: mdiMapMarker,
    verbs: [
      { id: 'arrives', flavour: 'event', label: 'zuhause ankommt' },
      { id: 'leaves', flavour: 'event', label: 'weggeht' },
      { id: 'is_home', flavour: 'state', label: 'zuhause ist' },
      { id: 'is_away', flavour: 'state', label: 'weg ist' },
    ],
  },
  event: {
    id: 'event',
    label: 'Ereignis',
    plural: 'Ereignisse',
    any: 'irgendein Ereignis',
    icon: mdiLightningBoltCircle,
    verbs: [
      { id: 'changes', flavour: 'event', label: 'eintritt' },
      { id: 'fired', flavour: 'event', label: 'mit „{event_type}“ eintritt', hint: 'Z. B. ein Knopf: press, double_press, long_press', params: [text('event_type', 'Art', 'press')] },
    ],
  },
  ha_event: {
    id: 'ha_event',
    label: 'HA-Ereignis',
    plural: 'HA-Ereignisse',
    any: 'ein HA-Ereignis',
    icon: mdiLightningBoltCircle,
    hide_subject: ['when'],
    verbs: [
      {
        id: 'fired',
        flavour: 'event',
        label: 'das Ereignis „{event_type}“ kommt',
        hint: 'Ein Ereignis auf dem Bus von Home Assistant, z. B. zha_event, deconz_event; Daten wie „command=on, device_id=…“ grenzen es ein',
        params: [text('event_type', 'Ereignis', 'zha_event'), text('event_data', 'Daten (Schlüssel=Wert, …)')],
      },
    ],
  },
  entity: {
    ...choice('entity', 'Entität', 'Entitäten', mdiCube, false),
    verbs: [
      ...choice('entity', '', '', '', false).verbs,
      { id: 'turn_on', flavour: 'action', label: 'einschalten' },
      { id: 'turn_off', flavour: 'action', label: 'ausschalten' },
    ],
  },
};
// media players outside the inventory (hidden ones) behave like the media kind
KINDS.media_player = { ...KINDS.media, id: 'media_player', placeholder: false };

/**
 * Sentence phrases for the text parser (parse.py), per language, so another language only adds entries.
 * Matched in order against the folded text (lower case, ä→a, ö→o, ü→u, ß→s) of a condition about a person:
 * `re` is a regular expression; `event`/`state` the verb for a trigger / a condition; `params` fixed values;
 * `number` takes the first number of the match into that parameter; `place` = the phrase names a zone or
 * learned place (then the parser looks for its name).
 */
export interface Phrase {
  re: string;
  event: string;
  state: string;
  params?: Record<string, unknown>;
  number?: string;
  place?: boolean;
}

export const PHRASES: Record<string, Phrase[]> = {
  de: [
    { re: '(in|binnen) (unter |weniger als |spatestens )?(\\d+) ?(min|minuten)\\w* (zuhause|daheim|zu hause|da)', event: 'arrives_within', state: 'is_arriving_within', number: 'value' },
    { re: '(unter|weniger als) (\\d+) ?(min|minuten)\\w* (von zuhause|von daheim|vor der tur|weg)', event: 'arrives_within', state: 'is_arriving_within', number: 'value' },
    { re: '(seit|langer als|mehr als|uber) (\\d+) ?(min|minuten|std|stunden?)\\w* unterwegs', event: 'moving_for', state: 'is_moving_for', number: 'value' },
    { re: 'wahrscheinlich (nach hause|heim)|vermutlich (nach hause|heim)|(nach hause|heim)(kommen|fahren|fahrt)? wird', event: 'heading_home', state: 'is_heading_home' },
    { re: '(auf dem )?heimweg|auf dem weg nach hause|unterwegs nach hause|(sich )?(dem zuhause |dem haus |uns )?(nahert|nahern|naher kommt|naher kommen)', event: 'coming_home', state: 'is_near' },
  ],
  // English (parse_en.py matches them against the lower-cased sentence)
  en: [
    { re: "(in|within) (under |less than |at most )?(\\d+) ?(min|mins|minutes?)\\w* (home|here|back)|(home|here|back) (in|within) (under |less than |at most )?(\\d+) ?(min|mins|minutes?)", event: 'arrives_within', state: 'is_arriving_within', number: 'value' },
    { re: "(under|less than) (\\d+) ?(min|mins|minutes?)\\w* (from home|away)", event: 'arrives_within', state: 'is_arriving_within', number: 'value' },
    { re: "(for|more than|over|longer than) (\\d+) ?(min|mins|minutes?|hours?|hrs?)\\w* (on the move|on the road|underway|travell?ing)|(on the move|on the road|underway|travell?ing) for (more than |over |longer than )?(\\d+) ?(min|mins|minutes?|hours?|hrs?)", event: 'moving_for', state: 'is_moving_for', number: 'value' },
    { re: "(probably|likely) (coming|going|heading|driving) home|(probably|likely) on (the|their|his|her|my|our) way home", event: 'heading_home', state: 'is_heading_home' },
    { re: "(gets?|getting) (close|closer|near) to home|approach(es|ing)? (home|the house)", event: 'coming_home', state: 'is_near' },
  ],
};

/** The kind of an entity Hausregeln has not sorted: its domain, or "entity". */
export function domainKind(entityId: string): string {
  const d = entityId.split('.')[0];
  return KINDS[d] ? d : 'entity';
}

/** Persons as a group: "jemand", "alle". */
export const PEOPLE_GROUP_ICON = mdiAccountGroup;
export const PAUSE_ICON = mdiPauseCircleOutline;
export const ALARM_ICON = mdiBellRing;
export const CLEAN_ICON = mdiBroom;

export const MODES: Record<string, { label: string; short: string }> = {
  home: { label: 'Zuhause', short: 'Zuhause' },
  away: { label: 'Weg', short: 'Weg' },
  sleep: { label: 'Schlafen', short: 'Schlafen' },
  vacation: { label: 'Urlaub', short: 'Urlaub' },
  guests: { label: 'Gäste', short: 'Gäste' },
};

export function verbsFor(kind: string, flavour: VerbFlavour): Verb[] {
  return (KINDS[kind]?.verbs ?? []).filter((v) => v.flavour === flavour);
}

export function findVerb(kind: string, id: string): Verb | undefined {
  return KINDS[kind]?.verbs.find((v) => v.id === id);
}

export function formatDuration(d: unknown): string {
  const m = String(d ?? '').match(/^(\d+(?:[.,]\d+)?)\s*([smhd])$/);
  if (!m) return String(d ?? '');
  if (m[2] === 's' && Number(m[1]) >= 60) {
    const s = Math.round(Number(m[1]));
    return s % 60 ? t('dur.min_sec', { m: Math.floor(s / 60), s: s % 60 }) : t('dur.m', { n: s / 60 });
  }
  const n = m[1].replace(/[.,]/, getLanguage() === 'de' ? ',' : '.');
  const unit = m[2] === 'd' ? (Number(m[1].replace(',', '.')) === 1 ? 'd_one' : 'd_other') : m[2];
  return t(`dur.${unit}` as I18nKey, { n });
}

export function formatOffset(d: unknown): string {
  const s = String(d ?? '0m');
  if (/^[-+]?0[smh]?$/.test(s)) return '';
  return t(s.startsWith('-') ? 'dur.before' : 'dur.after', { d: formatDuration(s.replace(/^[-+]/, '')) });
}

// ---------------------------------------------------------------------------------------------- languages
type Texts = { label: string; plural: string; any: string; verbs: Record<string, { label: string; pl?: string; hint?: string; params: Record<string, string> }> };
const snapshot = (): Record<string, Texts> =>
  Object.fromEntries(
    Object.entries(KINDS).map(([id, k]) => [
      id,
      {
        label: k.label,
        plural: k.plural,
        any: k.any,
        verbs: Object.fromEntries(k.verbs.map((v) => [v.id, { label: v.label, pl: v.pl, hint: v.hint, params: Object.fromEntries((v.params ?? []).map((p) => [p.key, p.label])) }])),
      },
    ]),
  );
const GERMAN = snapshot();
const GERMAN_MODES = structuredClone(MODES);

/**
 * Switches the words of KINDS and MODES to a language in place (everything that reads them follows).
 * English labels come from vocabulary-en.ts; anything without an English text keeps its German one.
 */
export function localizeVocabulary(lang: 'de' | 'en'): void {
  for (const [id, k] of Object.entries(KINDS)) {
    const de = GERMAN[id];
    const en = lang === 'en' ? EN_KINDS[id] : undefined;
    if (!de) continue;
    k.label = en?.label ?? de.label;
    k.plural = en?.plural ?? de.plural;
    k.any = en?.any ?? de.any;
    for (const v of k.verbs) {
      const dv = de.verbs[v.id];
      const ev = en?.verbs[v.id];
      if (!dv) continue;
      v.label = ev?.label ?? dv.label;
      const pl = ev ? ev.pl : dv.pl;
      if (pl) v.pl = pl;
      else delete v.pl;
      const hint = ev ? ev.hint : dv.hint;
      if (hint) v.hint = hint;
      else delete v.hint;
      for (const p of v.params ?? []) p.label = ev?.params?.[p.key] ?? dv.params[p.key] ?? p.label;
    }
  }
  for (const [id, m] of Object.entries(MODES)) Object.assign(m, (lang === 'en' ? EN_MODES[id] : undefined) ?? GERMAN_MODES[id]);
}
onLanguageChange(localizeVocabulary);
