import type { FurnitureConfig, HassEntity, HomeAssistant, ManualEntityConfig } from './types';
import { entityKey, normName } from './vehicles';

/**
 * Everything a car's integration offers, found generically through the car's device (Mercedes, smart, Tesla, BMW,
 * VW, Škoda, Hyundai/Kia, Renault, Polestar … name their entities alike): by domain, device class, the
 * integration's translation key and the name (German and English). The owner corrects it in the editor:
 * `entities[role]` links an entity to a role (wins over detection), `exclude` leaves entities out, `extra` adds
 * any entity with its own name and icon to a group of the car overview.
 */
export type CarGroup = 'climate' | 'charge' | 'access' | 'status';

export const CAR_GROUPS: CarGroup[] = ['climate', 'charge', 'access', 'status'];

/** Positions of doors, windows and tyres */
export type CarPos = 'fl' | 'fr' | 'rl' | 'rr';
export const CAR_POS: CarPos[] = ['fl', 'fr', 'rl', 'rr'];

interface RoleDef {
  key: string;
  group: CarGroup;
  domains: string[];
  re?: RegExp;
  not?: RegExp;
  /** device classes that count without a name match */
  dc?: string[];
  pos?: CarPos;
  /** several entities (seat heating, warnings) */
  multi?: boolean;
  icon: string;
}

const POS_RE: Record<CarPos, RegExp> = {
  fl: /front_left|left_front|vorne_links|links_vorne|driver_front|front_driver|fahrer(seite)?_vorne|(^|_)fl($|_)|(^|_)lf($|_)|_vl($|_)/,
  fr: /front_right|right_front|vorne_rechts|rechts_vorne|passenger_front|front_passenger|beifahrer|(^|_)fr($|_)|(^|_)rf($|_)|_vr($|_)/,
  rl: /rear_left|left_rear|hinten_links|links_hinten|back_left|(^|_)rl($|_)|(^|_)lr($|_)|_hl($|_)/,
  rr: /rear_right|right_rear|hinten_rechts|rechts_hinten|back_right|(^|_)rr($|_)|_hr($|_)/,
};
const ANY_POS = /front_left|left_front|front_right|right_front|rear_left|left_rear|rear_right|right_rear|vorne_links|vorne_rechts|hinten_links|hinten_rechts|links_vorne|rechts_vorne|links_hinten|rechts_hinten|driver|passenger|beifahrer|(^|_)(fl|fr|rl|rr|lf|rf|lr)($|_)/;

const OPEN_W = /(^|_)(open|oeffnen|auf|unlock|entriegeln|vent|lueften)($|_)/;
const CLOSE_W = /(^|_)(close|schliessen|zu|lock|verriegeln)($|_)/;

const TRUNK = /trunk|tailgate|(^|_)boot($|_)|kofferraum|heckklappe|deck_lid|liftgate|rear_hatch|(^|_)hatch($|_)|heckdeckel/;
const FRUNK = /frunk|front_trunk|bonnet|(^|_)hood($|_)|motorhaube|fronthaube|engine_hood|vorderhaube/;
const SUNROOF = /sunroof|sun_roof|schiebedach|panorama(_?roof|dach)?|moonroof|roof_window|(^|_)roof($|_)|faltdach|verdeck|convertible_top|soft_top|dachfenster/;
const FLAP = /charge_port|charging_port|chargeport|charge_flap|charging_flap|ladeklappe|charge_door|ladeanschluss|charging_inlet_flap|tankklappe|fuel_door|fuel_flap/;
const WINDOWS = /(^|_)windows?($|_)|(^|_)fenster($|_)|all_windows|window_status|windows_closed|vent_windows|fensterstatus|seitenfenster/;
const DOOR = /(^|_)doors?($|_)|(^|_)tuer(en)?($|_)|door_status|doors_closed|tuerstatus/;
const LOCKWORD = /lock|verriegel|sperre/;

/** Order matters: specific roles first, every entity is used once */
const ROLES: RoleDef[] = [
  // ---- open & close ----
  { key: 'charge_flap', group: 'access', domains: ['cover', 'lock', 'switch'], re: FLAP, icon: 'mdi:ev-plug-type2' },
  { key: 'charge_flap_open', group: 'access', domains: ['button'], re: FLAP, not: CLOSE_W, icon: 'mdi:ev-plug-type2' },
  { key: 'charge_flap_close', group: 'access', domains: ['button'], re: FLAP, icon: 'mdi:ev-plug-type2' },
  { key: 'charge_flap_state', group: 'access', domains: ['binary_sensor', 'sensor'], re: FLAP, icon: 'mdi:ev-plug-type2' },
  { key: 'frunk', group: 'access', domains: ['cover', 'lock', 'switch'], re: FRUNK, icon: 'mdi:car-select' },
  { key: 'frunk_open', group: 'access', domains: ['button'], re: FRUNK, not: CLOSE_W, icon: 'mdi:car-select' },
  { key: 'frunk_close', group: 'access', domains: ['button'], re: FRUNK, icon: 'mdi:car-select' },
  { key: 'frunk_state', group: 'access', domains: ['binary_sensor', 'sensor'], re: FRUNK, not: LOCKWORD, icon: 'mdi:car-select' },
  { key: 'trunk', group: 'access', domains: ['cover', 'lock', 'switch'], re: TRUNK, not: FRUNK, icon: 'mdi:car-back' },
  { key: 'trunk_open', group: 'access', domains: ['button'], re: TRUNK, not: CLOSE_W, icon: 'mdi:car-back' },
  { key: 'trunk_close', group: 'access', domains: ['button'], re: TRUNK, icon: 'mdi:car-back' },
  { key: 'trunk_state', group: 'access', domains: ['binary_sensor', 'sensor'], re: TRUNK, not: /frunk|front_trunk|lock|verriegel/, icon: 'mdi:car-back' },
  { key: 'sunroof', group: 'access', domains: ['cover', 'switch'], re: SUNROOF, icon: 'mdi:car-convertible' },
  { key: 'sunroof_open', group: 'access', domains: ['button'], re: SUNROOF, not: CLOSE_W, icon: 'mdi:car-convertible' },
  { key: 'sunroof_close', group: 'access', domains: ['button'], re: SUNROOF, icon: 'mdi:car-convertible' },
  { key: 'sunroof_state', group: 'access', domains: ['binary_sensor', 'sensor'], re: SUNROOF, icon: 'mdi:car-convertible' },
  ...CAR_POS.map((p): RoleDef => ({ key: `window_${p}`, group: 'access', domains: ['cover', 'binary_sensor', 'sensor'], re: /window|fenster|scheibe/, not: /blind|rollo|sunshade|sonnenschutz|heat|heiz/, pos: p, icon: 'mdi:car-door' })),
  { key: 'windows', group: 'access', domains: ['cover', 'switch'], re: WINDOWS, not: ANY_POS, icon: 'mdi:car-door' },
  { key: 'windows_open', group: 'access', domains: ['button'], re: WINDOWS, not: CLOSE_W, icon: 'mdi:car-door' },
  { key: 'windows_close', group: 'access', domains: ['button'], re: WINDOWS, icon: 'mdi:car-door' },
  { key: 'windows_state', group: 'access', domains: ['binary_sensor', 'sensor'], re: WINDOWS, not: ANY_POS, icon: 'mdi:car-door' },
  ...CAR_POS.map((p): RoleDef => ({ key: `door_${p}`, group: 'access', domains: ['binary_sensor', 'sensor'], re: DOOR, not: LOCKWORD, pos: p, dc: ['door', 'opening'], icon: 'mdi:car-door' })),
  { key: 'lock', group: 'access', domains: ['lock'], re: /./, not: /charge|flap|port|trunk|frunk|kofferraum|tailgate|heckklappe|window|fenster|sunroof|klappe|tank/, icon: 'mdi:car-key' },
  { key: 'lock_state', group: 'access', domains: ['binary_sensor', 'sensor'], re: /door_lock|doors_locked|lock_status|lock_state|central_lock|zentralverriegel|verriegelung|(^|_)locked($|_)|car_lock|vehicle_lock/, not: /charge|flap|trunk|deck|window/, icon: 'mdi:car-key' },
  { key: 'doors', group: 'access', domains: ['binary_sensor', 'sensor'], re: DOOR, not: /lock|verriegel|charge|trunk|garage|window/, icon: 'mdi:car-door' },
  { key: 'horn', group: 'access', domains: ['button', 'switch'], re: /(^|_)(horn|hupe|hupen|honk|sound_horn)/, not: /lichthupe/, icon: 'mdi:bullhorn' },
  { key: 'flash', group: 'access', domains: ['button', 'switch'], re: /flash|lichthupe|signal_position|sigpos|blink|lights_flash|flash_lights|find_car|locate/, icon: 'mdi:car-light-alert' },
  // ---- climate ----
  { key: 'pre_start', group: 'climate', domains: ['button'], re: /(preclimate|precondition|climate|klima|preheat|auxheat|hvac|standheizung|vorklimat)\w*_start|start_\w*(climate|precondition|preheat|klima)/, icon: 'mdi:air-conditioner' },
  { key: 'pre_stop', group: 'climate', domains: ['button'], re: /(preclimate|precondition|climate|klima|preheat|auxheat|hvac|standheizung|vorklimat)\w*_stop|stop_\w*(climate|precondition|preheat|klima)/, icon: 'mdi:air-conditioner' },
  { key: 'seat', group: 'climate', domains: ['switch', 'select', 'number', 'climate'], re: /seat_heat|sitzheiz|heated_seat|seat_heater|seat_climate|sitz_?heizung|seat_vent|sitzbelueft|seat_cool/, multi: true, icon: 'mdi:car-seat-heater' },
  { key: 'wheel', group: 'climate', domains: ['switch', 'select'], re: /steering_wheel|lenkrad/, icon: 'mdi:steering' },
  { key: 'defrost', group: 'climate', domains: ['switch', 'button'], re: /defrost|enteis|window_heat|scheibenheiz|rear_window_heat|front_window_heat|demist|heckscheibe|frontscheibe|windshield/, icon: 'mdi:car-defrost-rear' },
  { key: 'preclimate', group: 'climate', domains: ['switch', 'climate'], re: /vorklimat|preclimat|precondition|pre_condition|climatisation|climatization|klimatis|(^|_)hvac|climate_control|aux_heat|auxheat|standheiz|preheat|remote_climate|klima/, not: /seat|sitz|wheel|lenkrad|defrost|scheibe|window/, icon: 'mdi:air-conditioner' },
  { key: 'pre_state', group: 'climate', domains: ['binary_sensor'], re: /preclimat|precondition|klimat|climat|preheat|auxheat|standheiz/, icon: 'mdi:air-conditioner' },
  { key: 'climate_temp', group: 'climate', domains: ['number'], re: /target_temp|climate_temp|(^|_)temperature($|_)|solltemp|temp_target|cabin_temp/, icon: 'mdi:thermometer' },
  { key: 'interior', group: 'climate', domains: ['sensor'], re: /interior_temp|cabin_temp|innentemp|inside_temp|innenraum|temperature_inside|indoor_temp|inside_temperature/, icon: 'mdi:thermometer' },
  { key: 'departure', group: 'climate', domains: ['time', 'datetime', 'sensor', 'input_datetime', 'select'], re: /departure|abfahrt/, not: /mode|enable|status|aktiv/, icon: 'mdi:clock-start' },
  // ---- charge ----
  { key: 'limit', group: 'charge', domains: ['number', 'select', 'sensor'], re: /max_state_of_charge|charge_limit|ladelimit|target_soc|charging_limit|max_soc|charge_target|target_charge|ladeziel|soc_limit|charge_limit_soc/, icon: 'mdi:battery-charging-80' },
  { key: 'current', group: 'charge', domains: ['number', 'select'], re: /charging_current|charge_current|ladestrom|charging_amps|charge_amps|max_current|ac_current|charge_ampere/, icon: 'mdi:current-ac' },
  { key: 'charge_start', group: 'charge', domains: ['button'], re: /charg(e|ing)_start|start_charg|laden_starten|ladung_starten/, icon: 'mdi:ev-station' },
  { key: 'charge_stop', group: 'charge', domains: ['button'], re: /charg(e|ing)_stop|stop_charg|laden_stoppen|ladung_stoppen/, icon: 'mdi:ev-station' },
  { key: 'charge_switch', group: 'charge', domains: ['switch'], re: /(^|_)charg(e|ing)($|_)|charge_switch|(^|_)laden($|_)/, not: /port|flap|limit|current|cable|schedule|timer|climate|klima|seat|break|program/, icon: 'mdi:ev-station' },
  { key: 'soc', group: 'charge', domains: ['sensor'], re: /state_of_charge|(^|_)soc($|_)|ladestand|akkustand|battery_level|batteriestand|charge_level|hv_battery|batterieladung/, not: /max|limit|target|min_|end/, dc: ['battery'], icon: 'mdi:battery' },
  { key: 'range', group: 'charge', domains: ['sensor'], re: /range_electric|electric_range|reichweite|(^|_)range($|_)|range_ev|ev_range|remaining_range|battery_range/, not: /limit|bonus|eco|max|fuel|liquid|tank|kraftstoff|combustion/, icon: 'mdi:map-marker-distance' },
  { key: 'fuel', group: 'charge', domains: ['sensor'], re: /fuel_level|tank_level|tankinhalt|tankfuellstand|kraftstoff/, not: /range|reichweite/, icon: 'mdi:gas-station' },
  { key: 'fuel_range', group: 'charge', domains: ['sensor'], re: /fuel_range|range_liquid|range_fuel|combustion_range|reichweite_kraftstoff|kraftstoff_reichweite/, icon: 'mdi:gas-station' },
  { key: 'charging', group: 'charge', domains: ['binary_sensor', 'sensor'], re: /charging_active|(^|_)charging($|_)|(^|_)laden($|_)|laedt|ladevorgang|is_charging|charging_status|charging_state|charge_state|ladestatus/, not: /cable|plug|port|flap|limit|power|current|rate|time|end|program|break/, icon: 'mdi:ev-station' },
  { key: 'power', group: 'charge', domains: ['sensor'], re: /charging_power|ladeleistung|charge_power|charge_rate|charging_rate/, not: /limit|max/, icon: 'mdi:flash' },
  { key: 'plug', group: 'charge', domains: ['sensor', 'binary_sensor'], re: /inlet_coupler|(^|_)plug|stecker|connector|charge_cable|charging_cable|(^|_)cable|plugged/, dc: ['plug'], icon: 'mdi:power-plug' },
  { key: 'end', group: 'charge', domains: ['sensor'], re: /end_of_charge|charge_end|ladeende|time_to_full|charging_end|charge_complete|charging_finish|fully_charged|time_to_charge/, icon: 'mdi:timer-outline' },
  // ---- state ----
  ...CAR_POS.map((p): RoleDef => ({ key: `tire_${p}`, group: 'status', domains: ['sensor'], re: /(tire|tyre|reifen|wheel)_?(pressure|druck)|reifendruck/, pos: p, icon: 'mdi:car-tire-alert' })),
  { key: 'tire_warn', group: 'status', domains: ['binary_sensor'], re: /tire|tyre|reifen/, icon: 'mdi:car-tire-alert' },
  { key: 'odometer', group: 'status', domains: ['sensor'], re: /odometer|kilometerstand|km_stand|mileage|gesamtkilometer/, icon: 'mdi:counter' },
  { key: 'consumption', group: 'status', domains: ['sensor'], re: /consumption_start|consumption|verbrauch/, not: /reset/, icon: 'mdi:lightning-bolt-outline' },
  { key: 'avg_speed', group: 'status', domains: ['sensor'], re: /average_speed|durchschnittsgeschwindigkeit|avg_speed/, not: /reset/, icon: 'mdi:speedometer' },
  { key: 'eco', group: 'status', domains: ['sensor'], re: /eco_score/, icon: 'mdi:leaf' },
  { key: 'location', group: 'status', domains: ['device_tracker'], re: /./, icon: 'mdi:map-marker' },
  { key: 'address', group: 'status', domains: ['sensor'], re: /address|adresse|geocod/, icon: 'mdi:map-marker-outline' },
  { key: 'alarm', group: 'status', domains: ['binary_sensor', 'alarm_control_panel'], re: /theft|alarm|diebstahl|anti_theft/, icon: 'mdi:shield-car' },
  { key: 'park_brake', group: 'status', domains: ['binary_sensor'], re: /park_brake|parkbremse|parking_brake|handbremse/, icon: 'mdi:car-brake-parking' },
  { key: 'warnings', group: 'status', domains: ['binary_sensor'], dc: ['problem'], multi: true, icon: 'mdi:alert-circle-outline' },
];

export const CAR_ROLE: Record<string, RoleDef> = Object.fromEntries(ROLES.map((r) => [r.key, r]));
/** Roles the editor offers (buttons for open / close and the state of a part are picked automatically) */
export const CAR_ROLE_KEYS = ROLES.map((r) => r.key);
/** Former link keys of the editor (`entities.range` …) map onto roles of the same name; `f.entity` is the battery */
export const LEGACY_MAIN = 'soc';

/** Something of the car that opens and closes */
export interface CarPart {
  key: string;
  icon: string;
  /** reports open / closed */
  state?: string;
  /** cover / lock / switch to act on */
  control?: string;
  /** buttons */
  open?: string;
  close?: string;
}

export const PART_KEYS = ['lock', 'trunk', 'frunk', 'sunroof', 'windows', 'charge_flap'] as const;

export interface CarInfo {
  /** role → entity (explicit links and detection) */
  roles: Record<string, string>;
  /** roles found automatically (not linked by the owner) */
  auto: Set<string>;
  seats: string[];
  warnings: string[];
  parts: CarPart[];
  /** the owner's own entities with group, name and icon */
  extras: (ManualEntityConfig & { group: CarGroup })[];
  /** all entities of the car's device (excluded ones left out) */
  ids: string[];
  /** entities nobody uses yet (shown under "all values" and offered for assignment in the editor) */
  rest: string[];
}

export function carDeviceEntities(hass: HomeAssistant, f: FurnitureConfig): string[] {
  const seeds = [f.entity, ...Object.values(f.entities ?? {}), ...(f.extra ?? []).map((x) => x.entity)].filter((x): x is string => !!x);
  const devs = new Set(seeds.map((id) => hass.entities?.[id]?.device_id).filter((x): x is string => !!x));
  if (!devs.size) return seeds.filter((id) => hass.states[id]);
  return Object.keys(hass.entities).filter((id) => devs.has(hass.entities[id]?.device_id ?? '') && hass.states[id] && !hass.entities[id]?.hidden);
}

/** Explicit role links: `entities`, the main entity (battery) and extras whose role is a role key */
export function explicitRoles(f: FurnitureConfig): Record<string, string> {
  const out: Record<string, string> = {};
  if (f.entity) out[LEGACY_MAIN] = f.entity;
  for (const [k, v] of Object.entries(f.entities ?? {})) if (v) out[k] = v;
  for (const x of f.extra ?? []) if (x.role && CAR_ROLE[x.role] && !CAR_ROLE[x.role].multi) out[x.role] = x.entity;
  return out;
}

export function carInfo(hass: HomeAssistant, f: FurnitureConfig): CarInfo {
  const excluded = new Set(f.exclude ?? []);
  const ids = carDeviceEntities(hass, f).filter((id) => !excluded.has(id));
  const explicit = explicitRoles(f);
  const used = new Set(Object.values(explicit));
  const extraIds = new Set((f.extra ?? []).map((x) => x.entity));
  const keys = new Map(ids.map((id) => [id, entityKey(hass, id)]));
  const roles: Record<string, string> = { ...explicit };
  const auto = new Set<string>();
  const multi: Record<string, string[]> = { seat: [], warnings: [] };
  const free = (id: string) => !used.has(id) && !extraIds.has(id);
  const matches = (r: RoleDef, id: string) => {
    if (!r.domains.includes(id.split('.')[0])) return false;
    const key = keys.get(id) ?? '';
    const dc = hass.states[id]?.attributes.device_class;
    const byName = r.re ? r.re.test(key) : false;
    const byClass = !!r.dc && r.dc.includes(dc);
    if (!byName && !byClass) return false;
    if (r.not && r.not.test(key)) return false;
    if (r.pos && !POS_RE[r.pos].test(key)) return false;
    // open / close buttons
    if (r.key.endsWith('_open')) return !CLOSE_W.test(key.replace(/unlock/g, '')) || OPEN_W.test(key);
    if (r.key.endsWith('_close')) return CLOSE_W.test(key.replace(/unlock/g, ''));
    return true;
  };
  for (const r of ROLES) {
    if (r.multi) {
      for (const id of ids) {
        if (!free(id) || !matches(r, id)) continue;
        (multi[r.key] ??= []).push(id);
        used.add(id);
      }
      continue;
    }
    if (roles[r.key]) continue;
    const hit = ids.find((id) => free(id) && matches(r, id));
    if (hit) {
      roles[r.key] = hit;
      auto.add(r.key);
      used.add(hit);
    }
  }
  // explicit multi roles via extras
  for (const x of f.extra ?? []) if (x.role && CAR_ROLE[x.role]?.multi) (multi[x.role] ??= []).push(x.entity);
  const parts: CarPart[] = [];
  for (const k of PART_KEYS) {
    const p: CarPart = { key: k, icon: CAR_ROLE[k]?.icon ?? 'mdi:car', control: roles[k], state: roles[`${k}_state`], open: roles[`${k}_open`], close: roles[`${k}_close`] };
    if (p.control || p.state || p.open || p.close) parts.push(p);
  }
  const extras = (f.extra ?? [])
    .filter((x) => !x.role || !CAR_ROLE[x.role])
    .map((x) => ({ ...x, group: (CAR_GROUPS.includes(x.role as CarGroup) ? x.role : 'status') as CarGroup }));
  const rest = ids.filter((id) => !used.has(id) && !extraIds.has(id) && hass.entities[id]?.entity_category !== 'config');
  return { roles, auto, seats: multi.seat ?? [], warnings: multi.warnings ?? [], parts, extras, ids, rest };
}

/** Numeric status codes of integrations that report open / closed as numbers (code → open; missing codes: unknown) */
const CODES: Record<string, [RegExp, Record<string, boolean>][]> = {
  // Mercedes-Benz (mbapi2020): windows 0 intermediate, 1 open, 2 closed; sunroof 0 closed, 1 open, 2 lifted;
  // charge flap 0 open, 1 closed
  mbapi2020: [
    [/sunroof|schiebedach/, { '0': false, '1': true, '2': true }],
    [/window|fenster/, { '0': true, '1': true, '2': false }],
    [/charge_?flap|ladeklappe/, { '0': true, '1': false }],
  ],
};

/** Device classes of binary sensors whose "on" means open */
const OPEN_DC = ['door', 'window', 'opening', 'garage_door'];

/**
 * Open / closed of a part's state or control entity (undefined: unknown). `hass` adds the entity registry: the
 * integration (for its numeric codes) and the translation key. When unsure the answer is unknown, never "open".
 */
export function isOpenState(s: HassEntity | undefined, hass?: HomeAssistant): boolean | undefined {
  if (!s || s.state === 'unknown' || s.state === 'unavailable') return undefined;
  const id = s.entity_id;
  const d = id.split('.')[0];
  const raw = s.state.trim();
  const v = normName(raw);
  const key = hass ? entityKey(hass, id) : normName(`${id.split('.')[1] ?? id} ${s.attributes.friendly_name ?? ''}`);
  if (d === 'cover') {
    if (v === 'open' || v === 'opening') return true;
    if (v === 'closed' || v === 'closing') return false;
    const pos = Number(s.attributes.current_position);
    return Number.isFinite(pos) ? pos > 0 : undefined;
  }
  if (d === 'lock') return v === 'open' || v === 'opening' ? true : v === 'locked' || v === 'unlocked' || v === 'locking' ? false : undefined;
  if (d === 'binary_sensor' || d === 'switch') {
    if (v !== 'on' && v !== 'off') return undefined;
    // an opening device class reports on = open; without one, "windows closed", "doors locked" report on = closed
    const inverted = !OPEN_DC.includes(s.attributes.device_class) && /closed|geschlossen|(^|_)locked|verriegelt|(^|_)ok($|_)/.test(key);
    return (v === 'on') !== inverted;
  }
  // numeric codes: only where the integration's convention is known, or a position in percent
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    const platform = hass?.entities?.[id]?.platform;
    const table = platform ? CODES[platform]?.find(([re]) => re.test(key)) : undefined;
    if (table) return table[1][raw];
    return s.attributes.unit_of_measurement === '%' ? parseFloat(raw) > 0 : undefined;
  }
  if (/not_?open|nicht_?(offen|geoeffnet)|(^|_)(closed|geschlossen|shut|zu|locked|verriegelt|false|off)($|_)/.test(v)) return false;
  if (/open|offen|geoeffnet|ajar|tilted|gekippt|intermediate|(^|_)vent|partial|lifted|angehoben|^true$|^on$/.test(v)) return true;
  return undefined;
}

/** Locked state of the car (lock entity, else a lock state sensor) */
export function isLocked(hass: HomeAssistant, info: CarInfo, get: (id?: string) => HassEntity | undefined): boolean | undefined {
  const l = get(info.roles.lock);
  if (l && !['unknown', 'unavailable'].includes(l.state)) return l.state === 'locked' || l.state === 'locking';
  const s = get(info.roles.lock_state);
  if (!s || ['unknown', 'unavailable'].includes(s.state)) return undefined;
  const v = s.state.toLowerCase();
  if (s.entity_id.startsWith('binary_sensor.')) {
    // binary_sensor device class lock: on = unlocked; names like "locked": on = locked
    if (s.attributes.device_class === 'lock') return v === 'off';
    return /locked|verriegelt/.test(s.entity_id) ? v === 'on' : v === 'off';
  }
  if (/unlock|entriegelt|offen|open/.test(v)) return false;
  if (/lock|verriegelt|secured|gesichert/.test(v)) return true;
  return undefined;
}

/** Readable plug state */
export function plugText(s: HassEntity | undefined, de: boolean): string | undefined {
  if (!s || s.state === 'unknown' || s.state === 'unavailable') return undefined;
  const v = s.state.toLowerCase();
  if (s.entity_id.startsWith('binary_sensor.')) return v === 'on' ? (de ? 'Eingesteckt' : 'Plugged in') : de ? 'Nicht eingesteckt' : 'Not plugged in';
  if (/not|unplug|disconn|nicht/.test(v)) return de ? 'Nicht eingesteckt' : 'Not plugged in';
  if (/plug|conn|lock|gesteckt/.test(v)) return de ? 'Eingesteckt' : 'Plugged in';
  return s.state;
}

/** What of the car is open, for the drawing on the plan (2D and 3D); undefined entries are unknown */
export interface CarOpen {
  trunk?: boolean;
  frunk?: boolean;
  sunroof?: boolean;
  flap?: boolean;
  /** fl, fr, rl, rr */
  doors: (boolean | undefined)[];
  windows: (boolean | undefined)[];
}

const roleCache = new WeakMap<object, WeakMap<FurnitureConfig, Record<string, string>>>();

/** Open parts of a car (the detection is cached per entity registry and piece; only states are read each time) */
export function carOpen(hass: HomeAssistant, f: FurnitureConfig, get: (id: string) => HassEntity | undefined): CarOpen | undefined {
  if (!hass.entities) return undefined;
  let byPiece = roleCache.get(hass.entities);
  if (!byPiece) roleCache.set(hass.entities, (byPiece = new WeakMap()));
  let roles = byPiece.get(f);
  if (!roles) byPiece.set(f, (roles = carInfo(hass, f).roles));
  const r = roles;
  const st = (id?: string) => (id ? isOpenState(get(id), hass) : undefined);
  const part = (k: string) => st(r[`${k}_state`]) ?? st(r[k]);
  const allWin = part('windows');
  const allDoors = st(r.doors);
  return {
    trunk: part('trunk'),
    frunk: part('frunk'),
    sunroof: part('sunroof'),
    flap: part('charge_flap'),
    doors: CAR_POS.map((p) => st(r[`door_${p}`]) ?? allDoors),
    windows: CAR_POS.map((p) => st(r[`window_${p}`]) ?? allWin),
  };
}

/** Short signature of what is open (rebuilds the piece when it changes) */
export function carOpenSig(c: CarOpen | undefined): string {
  if (!c) return '';
  return [c.trunk, c.frunk, c.sunroof, c.flap, ...c.doors, ...c.windows].map((v) => (v ? '1' : '0')).join('');
}
