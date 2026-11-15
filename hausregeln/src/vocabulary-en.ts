/**
 * The vocabulary in English: the same kinds and verbs as vocabulary.ts, only the words.
 *
 * Event and state labels follow the subject ("the front door" + "opens", "any window" + "is open"); action labels
 * are imperatives and say with {s} where the subject goes ("turn on {s}", "set {s} to {temperature}").
 * Without {s} an action reads subject first. pl is the form after "all …".
 * Written into vocabulary.json under "en" by tools/build.mjs, so the integration speaks the same words.
 */
// i18n: complete
export interface VerbText {
  label: string;
  pl?: string;
  hint?: string;
  /** param key → label */
  params?: Record<string, string>;
}

export interface KindText {
  label: string;
  plural: string;
  any: string;
  verbs: Record<string, VerbText>;
}

const v = (label: string, pl?: string, params?: Record<string, string>, hint?: string): VerbText => ({ label, ...(pl ? { pl } : {}), ...(params ? { params } : {}), ...(hint ? { hint } : {}) });
const HOW_LONG = { for: 'How long' };

const openable = (label: string, plural: string, any: string): KindText => ({
  label,
  plural,
  any,
  verbs: {
    opens: v('opens', 'open'),
    closes: v('closes', 'close'),
    open_for: v('is open for more than {for}', 'are open for more than {for}', HOW_LONG),
    is_open: v('is open', 'are open'),
    is_closed: v('is closed', 'are closed'),
  },
});

const switchable = (label: string, plural: string, any: string, extra: Record<string, VerbText> = {}): KindText => ({
  label,
  plural,
  any,
  verbs: {
    turns_on: v('turns on', 'turn on'),
    turns_off: v('turns off', 'turn off'),
    on_for: v('is on for more than {for}', 'are on for more than {for}', HOW_LONG),
    off_for: v('is off for more than {for}', 'are off for more than {for}', HOW_LONG),
    is_on: v('is on', 'are on'),
    is_off: v('is off', 'are off'),
    turn_on: v('turn on {s}'),
    turn_off: v('turn off {s}'),
    toggle: v('toggle {s}'),
    ...extra,
  },
});

const numeric = (label: string, plural: string, actions: Record<string, VerbText> = {}): KindText => ({
  label,
  plural,
  any: `any ${label.toLowerCase()}`,
  verbs: {
    changes: v('changes', 'change'),
    above: v('rises above {value}', 'rise above {value}', { value: 'Value' }),
    below: v('falls below {value}', 'fall below {value}', { value: 'Value' }),
    becomes: v('changes to “{state}”', 'change to “{state}”', { state: 'State' }),
    is: v('is “{state}”', 'are “{state}”', { state: 'State' }),
    is_not: v('is not “{state}”', 'are not “{state}”', { state: 'State' }),
    is_above: v('is above {value}', 'are above {value}', { value: 'Value' }),
    is_below: v('is below {value}', 'are below {value}', { value: 'Value' }),
    between: v('comes between {min} and {max}', 'come between {min} and {max}', { min: 'From', max: 'To' }),
    is_between: v('is between {min} and {max}', 'are between {min} and {max}', { min: 'From', max: 'To' }),
    ...actions,
  },
});

const choice = (label: string, plural: string, extra: Record<string, VerbText> = {}, action = true): KindText => ({
  label,
  plural,
  any: `any ${label.toLowerCase()}`,
  verbs: {
    changes: v('changes'),
    becomes: v('changes to “{state}”', undefined, { state: 'Value' }),
    is: v('is “{state}”', undefined, { state: 'Value' }),
    is_not: v('is not “{state}”', undefined, { state: 'Value' }),
    ...(action ? { select: v('set {s} to “{state}”', undefined, { state: 'Value' }) } : {}),
    ...extra,
  },
});

const pressable = (label: string): KindText => ({
  label,
  plural: `${label}s`,
  any: `any ${label.toLowerCase()}`,
  verbs: { pressed: v('is pressed'), press: v('press {s}') },
});

const ZONE = { zone: 'Place' };
const BRIGHTNESS = { brightness: 'Brightness' };
const LIMIT = { value: 'Limit' };

export const EN_KINDS: Record<string, KindText> = {
  light: switchable('Light', 'Lights', 'any light', {
    dim: v('dim {s} to {brightness}', undefined, BRIGHTNESS),
    color: v('make {s} glow {color}', undefined, { color: 'Color' }),
    blink: v('flash {s}', undefined, undefined, 'Three short flashes, then as before'),
    set: v('set {s}: {light}', undefined, { light: 'Light' }, 'Colour (RGB, RGBW, white tone …), brightness, effect, fade, each lamp on its own'),
    is_between: v('is between {min} and {max} % bright', 'are between {min} and {max} % bright', { min: 'From', max: 'To' }, 'Off counts as 0 %'),
    brighter: v('gets brighter than {brightness}', 'get brighter than {brightness}', BRIGHTNESS),
    dimmer: v('gets dimmer than {brightness}', 'get dimmer than {brightness}', BRIGHTNESS, 'Off counts as 0 %'),
    is_brighter: v('is brighter than {brightness}', 'are brighter than {brightness}', BRIGHTNESS),
    is_dimmer: v('is dimmer than {brightness}', 'are dimmer than {brightness}', BRIGHTNESS, 'Off counts as 0 %'),
  }),
  window: openable('Window', 'Windows', 'any window'),
  door: openable('Door', 'Doors', 'any door'),
  motion: {
    label: 'Motion sensor',
    plural: 'Motion sensors',
    any: 'any motion sensor',
    verbs: {
      detected: v('detects motion', 'detect motion'),
      clear_for: v('has been clear for {for}', 'have been clear for {for}', HOW_LONG),
      is_active: v('sees motion', 'see motion'),
      is_clear: v('is clear', 'are clear'),
    },
  },
  zone: {
    label: 'Zone',
    plural: 'Zones',
    any: 'any zone',
    verbs: {
      occupied: v('becomes occupied', undefined, undefined, 'Someone sits or stands there'),
      free_for: v('is free for more than {for}', undefined, HOW_LONG),
      is_occupied: v('is occupied'),
      is_free: v('is free'),
    },
  },
  presence: {
    label: 'Presence sensor',
    plural: 'Presence sensors',
    any: 'any presence sensor',
    verbs: {
      occupied: v('detects someone', 'detect someone'),
      free_for: v('sees nobody for more than {for}', 'see nobody for more than {for}', HOW_LONG),
      is_occupied: v('sees someone', 'see someone'),
      is_free: v('sees nobody', 'see nobody'),
    },
  },
  room: {
    label: 'Room',
    plural: 'Rooms',
    any: 'any room',
    verbs: {
      entered: v('is entered', undefined, undefined, 'Someone comes into the room, whichever sensor notices it'),
      empty: v('becomes empty', undefined, undefined, 'Nobody there any more, after the set waiting time'),
      empty_for: v('is empty for more than {for}', undefined, HOW_LONG),
      is_occupied: v('is occupied', 'are occupied'),
      is_empty: v('is empty', 'are empty'),
      is_dark: v('is dark', 'are dark', undefined, 'By the room’s light sensor'),
      is_bright: v('is bright', 'are bright', undefined, 'By the room’s light sensor'),
    },
  },
  climate: {
    label: 'Heating',
    plural: 'Heaters',
    any: 'any heater',
    verbs: {
      starts_heating: v('starts heating', 'start heating'),
      is_heating: v('is heating', 'are heating'),
      set_temp: v('set {s} to {temperature}', undefined, { temperature: 'Temperature' }),
      eco: v('set {s} to eco', undefined, undefined, 'Setback temperature, e.g. 17 °C'),
      turn_off: v('turn off {s}'),
      boost: v('boost {s}', undefined, HOW_LONG),
    },
  },
  cover: {
    label: 'Blind',
    plural: 'Blinds',
    any: 'any blind',
    verbs: {
      opens: v('goes up', 'go up'),
      closes: v('goes down', 'go down'),
      is_open: v('is open', 'are open'),
      open: v('raise {s}'),
      close: v('lower {s}'),
      position: v('move {s} to {position}', undefined, { position: 'Position' }),
    },
  },
  media: {
    label: 'Speaker / TV',
    plural: 'Speakers',
    any: 'any speaker',
    verbs: {
      turns_on: v('is turned on'),
      starts_playing: v('starts playing', 'start playing'),
      stops: v('stops playing'),
      is_playing: v('is playing', 'are playing'),
      is_on: v('is on', 'are on'),
      pause: v('pause {s}'),
      play: v('resume {s}'),
      volume: v('set {s} to volume {volume}', undefined, { volume: 'Volume' }),
      announce: v('announce on {s}: “{message}”', undefined, { message: 'Text' }),
      turn_off: v('turn off {s}'),
    },
  },
  switch: switchable('Switch', 'Switches', 'any switch'),
  outlet: switchable('Outlet', 'Outlets', 'any outlet'),
  script: {
    label: 'Script',
    plural: 'Scripts',
    any: 'any script',
    verbs: { ran: v('has run'), run: v('run {s}') },
  },
  fan: switchable('Fan', 'Fans', 'any fan'),
  purifier: switchable('Air purifier', 'Air purifiers', 'any air purifier'),
  leak: {
    label: 'Water sensor',
    plural: 'Water sensors',
    any: 'any water sensor',
    verbs: { wet: v('detects water', 'detect water'), is_wet: v('is wet', 'are wet') },
  },
  temperature: {
    label: 'Temperature',
    plural: 'Temperatures',
    any: 'any temperature',
    verbs: { below: v('falls below {value}', undefined, LIMIT), above: v('rises above {value}', undefined, LIMIT), is_below: v('is below {value}', undefined, LIMIT), is_above: v('is above {value}', undefined, LIMIT) },
  },
  illuminance: {
    label: 'Brightness',
    plural: 'Brightness sensors',
    any: 'any brightness',
    verbs: { below: v('falls below {value}', undefined, LIMIT), above: v('rises above {value}', undefined, LIMIT), is_below: v('is below {value}', undefined, LIMIT), is_above: v('is above {value}', undefined, LIMIT) },
  },
  lock: {
    label: 'Lock',
    plural: 'Locks',
    any: 'any lock',
    verbs: { unlocked: v('is unlocked'), is_locked: v('is locked', 'are locked'), lock: v('lock {s}'), unlock: v('unlock {s}') },
  },
  vehicle: {
    label: 'Vehicle',
    plural: 'Vehicles',
    any: 'any vehicle',
    verbs: { arrives: v('arrives home', 'arrive home'), leaves: v('drives away', 'drive away'), is_home: v('is home', 'are home'), is_away: v('is away', 'are away') },
  },
  vacuum: {
    label: 'Robot vacuum',
    plural: 'Robot vacuums',
    any: 'any robot vacuum',
    verbs: {
      starts: v('starts cleaning'),
      done: v('is done'),
      is_docked: v('is docked'),
      cleaned_today: v('has already cleaned today'),
      not_cleaned_today: v('has not cleaned today yet'),
      start: v('start {s}'),
      clean_rooms: v('let {s} clean {rooms}', undefined, { rooms: 'Rooms' }),
      dock: v('send {s} to its dock'),
    },
  },
  person: {
    label: 'Person',
    plural: 'People',
    any: 'someone',
    verbs: {
      arrives: v('comes home', 'comes home'),
      leaves: v('leaves the house', 'has left'),
      coming_home: v('is getting close to home', 'is getting close to home', { distance: 'Closer than' }, 'Closer than 2 km (adjustable) and not moving away'),
      heading_home: v('is probably coming home', 'is probably coming home', { value: 'At least this sure' }, 'Learned from earlier trips: starting place, weekday, time and direction'),
      arrives_within: v('will be home in under {value}', 'will be home in under {value}', { value: 'Arrival in under' }, 'Estimated arrival from earlier trips, remaining distance and speed'),
      moving_for: v('has been on the move for {value}', 'has been on the move for {value}', { value: 'On the move for' }, 'On the move = neither in a zone nor stopped at a place'),
      enters_zone: v('arrives at {zone}', 'arrives at {zone}', ZONE),
      leaves_zone: v('leaves {zone}', 'has left {zone}', ZONE),
      in_zone: v('is at {zone}', 'is at {zone}', ZONE),
      not_in_zone: v('is not at {zone}', 'is not at {zone}', ZONE),
      far_from: v('is more than {distance} away from {zone}', 'is more than {distance} away from {zone}', { distance: 'Distance', ...ZONE }, 'E.g. for the vacation mode: everyone more than 100 km away for 1 day'),
      is_home: v('is home', 'is home'),
      is_away: v('is away', 'is away'),
      is_far: v('is more than {distance} away from {zone}', 'is more than {distance} away from {zone}', { distance: 'Distance', ...ZONE }),
      is_near: v('is on the way home', 'is on the way home', { distance: 'Closer than' }, 'Closer than 2 km (adjustable) and not moving away'),
      is_heading_home: v('is probably on the way home', 'is probably on the way home', { value: 'At least this sure' }, 'With “everyone”, only those on the move count'),
      is_arriving_within: v('will be home in under {value}', 'will be home in under {value}', { value: 'Arrival in under' }),
      is_moving_for: v('has been on the move for {value}', 'has been on the move for {value}', { value: 'On the move for' }),
    },
  },
  time: {
    label: 'Time',
    plural: 'Times',
    any: 'Time',
    verbs: {
      at: v('it is {time}', undefined, { time: 'Time' }),
      night: v('it is night', undefined, undefined, '22:00 – 6:00, can be changed'),
      morning: v('it is morning', undefined, undefined, '6:00 – 10:00'),
      evening: v('it is evening', undefined, undefined, '18:00 – 22:00'),
      workdays: v('it is a workday', undefined, undefined, 'Monday to Friday, without public holidays'),
      weekend: v('it is the weekend'),
      weekdays: v('on these days: {days}', undefined, { days: 'Days' }),
      between: v('it is between {from} and {to}', undefined, { from: 'From', to: 'To' }),
    },
  },
  sun: {
    label: 'Sun',
    plural: 'Sun',
    any: 'Sun',
    verbs: {
      sets: v('sets', undefined, { offset: 'Offset' }),
      rises: v('rises', undefined, { offset: 'Offset' }),
      is_down: v('it is dark outside'),
      is_up: v('it is light outside'),
      after_sunset: v('after sunset', undefined, { offset: 'Offset' }),
      before_sunset: v('before sunset', undefined, { offset: 'Offset' }),
      after_sunrise: v('after sunrise', undefined, { offset: 'Offset' }),
      before_sunrise: v('before sunrise', undefined, { offset: 'Offset' }),
    },
  },
  mode: {
    label: 'House mode',
    plural: 'House mode',
    any: 'House mode',
    verbs: {
      changes_to: v('changes to {mode}', undefined, { mode: 'Mode' }),
      is: v('the house mode is {mode}', undefined, { mode: 'Mode' }),
      is_not: v('the house mode is not {mode}', undefined, { mode: 'Mode' }),
      set: v('set {s} to {mode}', undefined, { mode: 'Mode' }),
    },
  },
  notify: {
    label: 'Message',
    plural: 'Messages',
    any: 'everyone',
    verbs: {
      send: v('notify {s}: “{message}”', undefined, { message: 'Message' }),
      ask: v('ask {s}: “{message}”', undefined, { message: 'Question' }, 'With yes/no buttons. The rule waits for the answer.'),
      alarm: v('warn {s} loudly: “{message}”', undefined, { message: 'Warning' }, 'Gets through even with “Do not disturb”'),
    },
  },
  wait: {
    label: 'Wait',
    plural: 'Wait',
    any: 'Wait',
    verbs: { wait: v('wait {for}', undefined, HOW_LONG), wait_until_empty: v('wait until the room is empty') },
  },
  group: switchable('Group', 'Groups', 'any group'),
  alarm: {
    label: 'Alarm system',
    plural: 'Alarm system',
    any: 'Alarm system',
    verbs: {
      triggered: v('goes off'),
      armed: v('is armed'),
      disarmed: v('is disarmed'),
      is_armed: v('is armed'),
      is_disarmed: v('is disarmed'),
      is_triggered: v('is in alarm'),
      arm_away: v('arm {s} (away)'),
      arm_night: v('arm {s} (night)'),
      arm_home: v('arm {s} (home)'),
      disarm: v('disarm {s}'),
      trigger: v('set off {s}'),
    },
  },
  rule: {
    label: 'Rule',
    plural: 'Rules',
    any: 'a rule',
    verbs: { ran: v('has run'), is_active: v('is in effect', undefined, undefined, 'For while rules'), run: v('start {s}'), pause: v('pause {s}', undefined, HOW_LONG) },
  },
  binary_sensor: {
    label: 'Sensor (on/off)',
    plural: 'Sensors',
    any: 'any sensor (on/off)',
    verbs: {
      turns_on: v('becomes active', 'become active'),
      turns_off: v('becomes inactive', 'become inactive'),
      on_for: v('is active for more than {for}', 'are active for more than {for}', HOW_LONG),
      is_on: v('is active', 'are active'),
      is_off: v('is inactive', 'are inactive'),
    },
  },
  sensor: numeric('Sensor', 'Sensors'),
  number: numeric('Number', 'Numbers', { set_value: v('set {s} to {value}', undefined, { value: 'Value' }) }),
  input_number: numeric('Number (helper)', 'Numbers', { set_value: v('set {s} to {value}', undefined, { value: 'Value' }) }),
  select: choice('Selection', 'Selections'),
  input_select: choice('Selection (helper)', 'Selections'),
  input_text: choice('Text (helper)', 'Texts', { set_text: v('set {s} to “{state}”', undefined, { state: 'Text' }) }, false),
  button: pressable('Button'),
  input_button: pressable('Button (helper)'),
  scene: { label: 'Scene', plural: 'Scenes', any: 'any scene', verbs: { activated: v('is activated'), activate: v('activate {s}') } },
  input_boolean: switchable('Helper (on/off)', 'Helpers', 'any helper'),
  siren: switchable('Siren', 'Sirens', 'any siren'),
  humidifier: switchable('Humidifier', 'Humidifiers', 'any humidifier'),
  water_heater: switchable('Water heater', 'Water heaters', 'any water heater'),
  automation: switchable('HA automation', 'HA automations', 'any HA automation', { trigger: v('trigger {s}') }),
  camera: switchable('Camera', 'Cameras', 'any camera'),
  device_tracker: {
    label: 'Tracker',
    plural: 'Trackers',
    any: 'any tracker',
    verbs: { arrives: v('arrives home'), leaves: v('leaves'), is_home: v('is home'), is_away: v('is away') },
  },
  event: { label: 'Event', plural: 'Events', any: 'any event', verbs: { changes: v('happens'), fired: v('happens as “{event_type}”', undefined, { event_type: 'Type' }, 'E.g. a button: press, double_press, long_press') } },
  ha_event: {
    label: 'HA event',
    plural: 'HA events',
    any: 'an HA event',
    verbs: {
      fired: v('the event “{event_type}” comes', undefined, { event_type: 'Event', event_data: 'Data (key=value, …)' }, 'An event on the Home Assistant bus, e.g. zha_event, deconz_event; data like “command=on, device_id=…” narrows it down'),
    },
  },
  entity: choice('Entity', 'Entities', { turn_on: v('turn on {s}'), turn_off: v('turn off {s}') }, false),
};
EN_KINDS.media_player = EN_KINDS.media;

export const EN_MODES: Record<string, { label: string; short: string }> = {
  home: { label: 'Home', short: 'Home' },
  away: { label: 'Away', short: 'Away' },
  sleep: { label: 'Sleep', short: 'Sleep' },
  vacation: { label: 'Vacation', short: 'Vacation' },
  guests: { label: 'Guests', short: 'Guests' },
};
