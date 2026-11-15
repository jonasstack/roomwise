import type { HassEntity, HomeAssistant } from './types';
import { entityName } from './ha';
import { t } from './i18n';
import { entityKey, isVehicleEntity } from './vehicles';

/**
 * Remote actions that open access to the house or a car: a garage door or gate going up, a lock unlocking or
 * opening its latch, a car's sunroof, windows, tailgate, frunk or charge flap opening. They never run from a single
 * tap — every path (popups, a direct tap action on the plan, a configured perform-action) first shows the sheet that
 * names exactly what opens and has to be slid to the end (`ActionHost.confirmOpen`). A garage door or gate closing needs the same slide; locking acts at once.
 */
export interface OpenRequest {
  /** "Garagentor öffnen?" */
  title: string;
  /** what exactly opens, as one sentence */
  text: string;
  icon: string;
  /** the label on the slider: open / unlock / close (a garage door or gate moving down where nobody may see it) */
  verb: 'open' | 'unlock' | 'close';
}

/** Cover device classes that close off access (house) */
const ACCESS_COVERS = new Set(['garage', 'gate', 'door']);
/** Buttons / switches whose job is to open something */
const OPENS = /(^|_)(open|oeffnen|oeffne|auf|unlock|entriegeln|entsperren|release|vent)($|_)|door_opener|tueroeffner|summer|buzzer|trunk|tailgate|heckklappe|kofferraum|frunk|sunroof|schiebedach|charge_port|charging_port|ladeklappe|charge_flap|garage|gate|einfahrtstor|hoftor|(^|_)tor($|_)/;
/** …unless they close it */
const CLOSES = /(^|_)(close|schliessen|zu|lock|verriegeln|sperren|stop)($|_)/;
/** …or only sit next to it (the garage light, the gate's camera) */
const BESIDE = /light|licht|lamp|leuchte|socket|steckdose|plug|heiz|heat|fan|luefter|ventil|camera|kamera|motion|bewegung|alarm|notif|siren|sirene|klingel|bell|charging$|laden$/;

function opener(hass: HomeAssistant, id: string): boolean {
  const key = entityKey(hass, id);
  return OPENS.test(key) && !CLOSES.test(key.replace(/unlock/g, '')) && !BESIDE.test(key);
}

/** Does this entity close off access (so that opening it needs the slide)? */
export function isAccessEntity(hass: HomeAssistant, id: string | undefined): boolean {
  if (!id) return false;
  const d = id.split('.')[0];
  const s = hass.states[id];
  if (d === 'lock') return true;
  if (d === 'cover') return ACCESS_COVERS.has(s?.attributes.device_class) || isVehicleEntity(hass, id);
  if (d === 'button' || d === 'input_button' || d === 'switch') return opener(hass, id) && (isVehicleEntity(hass, id) || d !== 'switch' || /garage|gate|tor|door|tuer|summer|buzzer/.test(entityKey(hass, id)));
  return false;
}

/** The request to show before `service` runs on `id`, or undefined when it does not open anything */
export function openRequest(hass: HomeAssistant, id: string, service: string, data: Record<string, unknown> = {}, cur?: HassEntity): OpenRequest | undefined {
  if (!isAccessEntity(hass, id)) return undefined;
  const d = id.split('.')[0];
  const s = cur ?? hass.states[id];
  const state = s?.state ?? '';
  let opens = false;
  let verb: OpenRequest['verb'] = 'open';
  if (d === 'cover') {
    opens =
      service === 'open_cover' ||
      service === 'open_cover_tilt' ||
      (service === 'set_cover_position' && Number(data.position ?? 0) > Number(s?.attributes.current_position ?? 0)) ||
      (service === 'toggle' && !['open', 'opening'].includes(state));
  } else if (d === 'lock') {
    opens = service === 'unlock' || service === 'open' || (service === 'toggle' && state === 'locked');
    verb = service === 'open' ? 'open' : 'unlock';
  } else if (d === 'button' || d === 'input_button') opens = service === 'press';
  else if (d === 'switch') opens = service === 'turn_on' || (service === 'toggle' && state !== 'on');
  if (!opens) return undefined;
  return describe(hass, id, verb);
}

/** The sheet's texts for opening `id` (also used by the car popup with its own label) */
export function describe(hass: HomeAssistant, id: string, verb: OpenRequest['verb'] = 'open', label?: string, owner?: string): OpenRequest {
  const s = hass.states[id];
  const name = label ?? entityName(hass, id, s);
  const dc = s?.attributes.device_class;
  const icon =
    id.startsWith('lock.') ? 'mdi:lock-open-variant' : dc === 'gate' ? 'mdi:gate-open' : dc === 'garage' ? 'mdi:garage-open-variant' : dc === 'door' ? 'mdi:door-open' : isVehicleEntity(hass, id) ? 'mdi:car-door' : 'mdi:lock-open-variant';
  const title = verb === 'unlock' ? t('access.title_unlock', { name }) : t('access.title_open', { name });
  const text = owner
    ? t(verb === 'unlock' ? 'access.text_unlock_of' : 'access.text_open_of', { name, owner })
    : t(verb === 'unlock' ? 'access.text_unlock' : 'access.text_open', { name });
  return { title, text, icon, verb };
}

/** The sheet for closing a garage door or gate from afar: someone (a child, an animal, the car half inside) may be under it */
export function describeClose(hass: HomeAssistant, id: string, gate = false): OpenRequest {
  const name = entityName(hass, id, hass.states[id]);
  return { title: t(gate ? 'garage.confirm_close_gate' : 'garage.confirm_close', { name }), text: t('access.text_close', { name }), icon: gate ? 'mdi:gate' : 'mdi:garage-variant', verb: 'close' };
}

/** A perform-action / call-service from the plan: does it open access? (domain services like `*.unlock`, `*.open*` too) */
export function serviceOpens(hass: HomeAssistant, service: string, data: Record<string, unknown>, targets: string[]): OpenRequest | undefined {
  const [domain, svc] = service.split('.', 2);
  for (const id of targets) {
    const sd = id.split('.')[0];
    const effective = domain === 'homeassistant' ? (svc === 'turn_on' ? (sd === 'cover' ? 'open_cover' : sd === 'lock' ? 'unlock' : 'turn_on') : svc) : svc;
    if (domain === sd || domain === 'homeassistant') {
      const r = openRequest(hass, id, effective, data);
      if (r) return r;
    }
  }
  // an integration's own service (e.g. sunroof_open, doors_unlock, open_trunk)
  if (domain !== 'homeassistant' && /(^|_)(open|unlock)/.test(svc) && !/close|lock$/.test(svc.replace(/unlock/g, ''))) {
    const name = targets[0] ? entityName(hass, targets[0], hass.states[targets[0]]) : service;
    return { title: t('access.title_open', { name }), text: t('access.text_service', { service }), icon: 'mdi:lock-open-variant', verb: svc.includes('unlock') ? 'unlock' : 'open' };
  }
  return undefined;
}

/** entity ids of an action's target / entity */
export function targetIds(target: Record<string, unknown> | undefined, entity?: string): string[] {
  const raw = target?.entity_id ?? entity;
  return (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((x): x is string => typeof x === 'string');
}
