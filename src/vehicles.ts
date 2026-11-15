import type { HomeAssistant } from './types';

/**
 * Which devices are vehicles. Their doors, windows, locks and contacts belong to the car, never to the house:
 * room suggestions, door / window pickers and the front door warning leave them out.
 *
 * A device is a vehicle when it comes from a known car integration, or when it has a location tracker together
 * with typical car values (odometer, range, fuel level, tyre pressure, state of charge), or at least two of those
 * values without a tracker. Phones (mobile_app) never count.
 */
export const CAR_PLATFORMS = new Set([
  'mbapi2020', 'mercedes_me', 'smart', 'hello_smart', 'tesla_fleet', 'teslemetry', 'tessie', 'tesla_custom', 'tesla',
  'bmw_connected_drive', 'bmw_cardata', 'mini_connected', 'volkswagencarnet', 'volkswagen_we_connect_id', 'skodaconnect',
  'myskoda', 'audiconnect', 'seatconnect', 'cupra_we_connect', 'kia_uvo', 'hyundai_kia_connect', 'renault', 'polestar_api',
  'polestar', 'ford', 'fordpass', 'mazda', 'subaru', 'toyota', 'lexus', 'nissan_leaf', 'volvo', 'volvooncall', 'volvo_cars',
  'mg_saic', 'porscheconnect', 'jlrincontrol', 'stellantis_vehicles', 'psa_car_controller', 'opel', 'peugeot', 'citroen',
  'byd', 'zeekr', 'lynk_co', 'fiat', 'honda', 'rivian', 'lucid', 'nio', 'xpeng', 'weconnect', 'cardata',
]);

const NOT_VEHICLE_PLATFORMS = new Set(['mobile_app', 'companion', 'ios', 'android', 'gpslogger', 'owntracks', 'life360', 'icloud']);

/** Values only a vehicle reports (on the normalised name: lowercase, `_` between words, umlauts spelled out) */
const CAR_VALUE =
  /odometer|mileage|kilometerstand|km_stand|fuel_level|fuel_range|tank_level|tankinhalt|kraftstoff|range_electric|electric_range|reichweite|(^|_)range($|_)|state_of_charge|tire_pressure|tyre_pressure|reifendruck|charging_port|charge_port|ladeklappe|sunroof|schiebedach|tailgate|heckklappe|kofferraum|(^|_)trunk($|_)|frunk|park_brake|parkbremse|ignition|zuendung/;

/** lowercase, umlauts spelled out, every non-alphanumeric run as one `_` */
export function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/** Search key of an entity: translation key, entity id (without domain) and friendly name, normalised */
export function entityKey(hass: HomeAssistant, id: string): string {
  const e = hass.entities?.[id];
  const name = hass.states[id]?.attributes.friendly_name ?? e?.name ?? '';
  return normName(`${e?.translation_key ?? ''} ${id.split('.')[1] ?? id} ${name}`);
}

const cache = new WeakMap<object, Set<string>>();

/** Device ids of all vehicles (cached per entity registry) */
export function vehicleDevices(hass: HomeAssistant | undefined): Set<string> {
  const reg = hass?.entities;
  if (!hass || !reg) return new Set();
  const hit = cache.get(reg);
  if (hit) return hit;
  const info = new Map<string, { tracker: boolean; values: number; known: boolean; phone: boolean }>();
  for (const [id, e] of Object.entries(reg)) {
    if (!e.device_id) continue;
    let d = info.get(e.device_id);
    if (!d) info.set(e.device_id, (d = { tracker: false, values: 0, known: false, phone: false }));
    if (e.platform && CAR_PLATFORMS.has(e.platform)) d.known = true;
    if (e.platform && NOT_VEHICLE_PLATFORMS.has(e.platform)) d.phone = true;
    const domain = id.split('.')[0];
    if (domain === 'device_tracker') d.tracker = true;
    else if (CAR_VALUE.test(entityKey(hass, id))) d.values++;
  }
  const out = new Set<string>();
  for (const [dev, d] of info) if (!d.phone && (d.known || (d.tracker && d.values >= 1) || d.values >= 2)) out.add(dev);
  cache.set(reg, out);
  return out;
}

/** The entity belongs to a vehicle (car, van, motorbike …) */
export function isVehicleEntity(hass: HomeAssistant | undefined, id: string | undefined): boolean {
  if (!hass || !id) return false;
  const dev = hass.entities?.[id]?.device_id;
  return !!dev && vehicleDevices(hass).has(dev);
}
