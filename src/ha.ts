import type { HassEntity, HomeAssistant } from './types';
import { t } from './i18n';
import { isVehicleEntity } from './vehicles';

export const domainOf = (entityId: string) => entityId.split('.')[0];

export function fireEvent(node: EventTarget, type: string, detail?: unknown) {
  node.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
}

export function navigate(path: string, replace = false) {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  window.dispatchEvent(new CustomEvent('location-changed', { detail: { replace } }));
}

export const UNAVAILABLE = new Set(['unavailable', 'unknown']);
export const isUnavailable = (s?: HassEntity) => !s || UNAVAILABLE.has(s.state);

export function entityName(hass: HomeAssistant, entityId: string, stateObj?: HassEntity): string {
  const s = stateObj ?? hass.states[entityId];
  return s?.attributes.friendly_name ?? hass.entities?.[entityId]?.name ?? entityId;
}

export function formatState(hass: HomeAssistant, s: HassEntity | undefined): string {
  if (!s) return t('card.unavailable');
  try {
    if (hass.formatEntityState) return hass.formatEntityState(s);
  } catch {
    /* fall through */
  }
  const unit = s.attributes.unit_of_measurement;
  return unit ? `${s.state} ${unit}` : s.state;
}

/** Whether an entity is in an "active" state that should be highlighted. */
export function isActive(s: HassEntity | undefined): boolean {
  if (!s || isUnavailable(s)) return false;
  const d = domainOf(s.entity_id);
  switch (d) {
    case 'climate':
      return s.state !== 'off' && ['heating', 'cooling', 'drying', 'fan'].includes(s.attributes.hvac_action ?? (s.state === 'heat' ? 'heating' : ''));
    case 'media_player':
      return ['playing', 'on', 'buffering'].includes(s.state);
    case 'vacuum':
      return ['cleaning', 'returning'].includes(s.state);
    case 'cover':
      return ['open', 'opening', 'closing'].includes(s.state);
    case 'lock':
      return ['unlocked', 'open', 'opening'].includes(s.state);
    case 'todo':
      return false;
    case 'sensor':
      return false;
    default:
      return s.state === 'on' || s.state === 'home';
  }
}

export interface StateStyle {
  color: string;
  ink: string;
}

const WARM_WHITE: [number, number, number] = [255, 204, 102];

function luminance([r, g, b]: number[]) {
  const c = [r, g, b].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function kelvinToRgb(k: number): [number, number, number] {
  const temp = k / 100;
  let r: number, g: number, b: number;
  if (temp <= 66) {
    r = 255;
    g = 99.47 * Math.log(temp) - 161.12;
    b = temp <= 19 ? 0 : 138.52 * Math.log(temp - 10) - 305.04;
  } else {
    r = 329.7 * (temp - 60) ** -0.1332;
    g = 288.12 * (temp - 60) ** -0.0755;
    b = 255;
  }
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return [c(r), c(g), c(b)];
}

/** The visible color of a light: rgb for color modes, a warm tone for white/temperature. */
export function lightRgb(s: HassEntity): [number, number, number] {
  const a = s.attributes;
  if (a.color_mode && !['color_temp', 'white', 'brightness', 'onoff'].includes(a.color_mode) && a.rgb_color)
    return a.rgb_color as [number, number, number];
  if (a.color_temp_kelvin) {
    // Map to a pleasant UI tone (pure kelvin colors look washed out on screens).
    const k = a.color_temp_kelvin as number;
    const warm = WARM_WHITE;
    const cool: [number, number, number] = [222, 236, 255];
    const tt = Math.max(0, Math.min(1, (k - 2200) / (6500 - 2200)));
    return warm.map((w, i) => Math.round(w + (cool[i] - w) * tt)) as [number, number, number];
  }
  return WARM_WHITE;
}

export function rgbCss(rgb: number[]) {
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

export function inkFor(rgb: number[]) {
  return luminance(rgb) > 0.4 ? 'rgba(0,0,0,0.82)' : '#ffffff';
}

/** Color + icon ink for an active entity tile. Uses token variables where possible. */
export function stateStyle(s: HassEntity | undefined): StateStyle | undefined {
  if (!s || !isActive(s)) return undefined;
  const d = domainOf(s.entity_id);
  if (d === 'light') {
    const rgb = lightRgb(s);
    return { color: rgbCss(rgb), ink: inkFor(rgb) };
  }
  if (d === 'climate') {
    const cooling = s.attributes.hvac_action === 'cooling';
    return { color: cooling ? 'var(--fp-state-cool)' : 'var(--fp-state-heat)', ink: '#fff' };
  }
  if (d === 'binary_sensor') {
    const dc = s.attributes.device_class;
    if (['door', 'window', 'opening', 'garage_door', 'moisture', 'smoke', 'gas', 'problem', 'safety'].includes(dc))
      return { color: 'var(--fp-state-alert)', ink: '#fff' };
    return { color: 'var(--fp-state-active)', ink: '#fff' };
  }
  if (d === 'lock') return { color: 'var(--fp-state-alert)', ink: '#fff' };
  if (d === 'switch' || d === 'input_boolean' || d === 'fan') return { color: 'var(--fp-state-light)', ink: 'var(--fp-state-on-light)' };
  return { color: 'var(--fp-state-active)', ink: '#fff' };
}

// ---------- Area helpers ----------

/** Entities per area, indexed once per entity registry (HA hands out a new registry object only when it
 *  changes): looking up a room's lights on every state change must not walk thousands of entities */
const areaIndex = new WeakMap<object, { devices: unknown; byArea: Map<string, string[]> }>();

export function entitiesInArea(hass: HomeAssistant, areaId: string): string[] {
  const ents = hass.entities;
  if (!ents) return [];
  let idx = areaIndex.get(ents);
  if (!idx || idx.devices !== hass.devices) {
    const byArea = new Map<string, string[]>();
    for (const [id, e] of Object.entries(ents)) {
      if (e.hidden || e.entity_category) continue;
      const area = e.area_id ?? (e.device_id ? hass.devices?.[e.device_id]?.area_id : undefined);
      if (!area) continue;
      const list = byArea.get(area);
      if (list) list.push(id);
      else byArea.set(area, [id]);
    }
    idx = { devices: hass.devices, byArea };
    areaIndex.set(ents, idx);
  }
  return (idx.byArea.get(areaId) ?? []).filter((id) => hass.states[id]);
}

const OUTDOOR = /(au(ss|ß)en|outdoor|outside|device_temp|batter|cpu|chip)/i;

export interface AreaSuggestion {
  lights: string[];
  temperature?: string;
  humidity?: string;
  climate?: string;
  sensors: string[];
}

/** Lights and values of an area for a room. A car parked in the area (its device placed there) is never part of the
 * room: its doors, windows and sensors stay out. `exclude`: entities the owner took out of the suggestions. */
export function suggestForArea(hass: HomeAssistant, areaId: string, exclude: string[] = []): AreaSuggestion {
  const skip = new Set(exclude);
  const ids = entitiesInArea(hass, areaId).filter((id) => !skip.has(id) && !isVehicleEntity(hass, id));
  const st = (id: string) => hass.states[id];
  const lamps = lampsOf(hass, ids);
  const climates = ids.filter((id) => domainOf(id) === 'climate');
  const climateDevices = new Set(climates.map((id) => hass.entities[id]?.device_id).filter(Boolean));
  const numeric = (id: string) => !isNaN(parseFloat(st(id)?.state ?? ''));
  const pick = (dc: string) => {
    const cands = ids.filter(
      (id) => domainOf(id) === 'sensor' && st(id)?.attributes.device_class === dc && !OUTDOOR.test(id + (st(id)?.attributes.friendly_name ?? '')),
    );
    const standalone = cands.filter((id) => !climateDevices.has(hass.entities[id]?.device_id));
    return [...standalone.filter(numeric), ...standalone, ...cands][0];
  };
  const sensors = ids.filter(
    (id) => domainOf(id) === 'binary_sensor' && ['window', 'door', 'opening'].includes(st(id)?.attributes.device_class),
  );
  return { lights: lamps, temperature: pick('temperature'), humidity: pick('humidity'), climate: climates[0], sensors };
}

/** The lights among these entities; real lamps rather than light groups when both exist */
function lampsOf(hass: HomeAssistant, ids: string[]): string[] {
  const lights = ids.filter((id) => domainOf(id) === 'light');
  const members = new Set(lights.flatMap((id) => (hass.states[id]?.attributes.entity_id as string[] | undefined) ?? []));
  return lights.filter((id) => !hass.states[id]?.attributes.entity_id || !lights.some((l) => members.has(l)));
}

/** Lights of an area (rooms without their own list, minus the ones the owner excluded); runs on every state change,
 * so only the lights are looked at (lights are never a vehicle's) */
export function areaLights(hass: HomeAssistant, areaId?: string, exclude?: string[]): string[] {
  if (!areaId) return [];
  const ids = entitiesInArea(hass, areaId);
  return lampsOf(hass, exclude?.length ? ids.filter((id) => !exclude.includes(id)) : ids);
}

/** Default icon for a domain if HA does not provide one. */
export function domainIcon(entityId: string): string {
  const map: Record<string, string> = {
    light: 'mdi:lightbulb',
    switch: 'mdi:toggle-switch-variant',
    climate: 'mdi:thermostat',
    vacuum: 'mdi:robot-vacuum',
    cover: 'mdi:window-shutter',
    media_player: 'mdi:speaker',
    todo: 'mdi:clipboard-list',
    sensor: 'mdi:eye',
    binary_sensor: 'mdi:checkbox-blank-circle-outline',
    fan: 'mdi:fan',
    lock: 'mdi:lock',
    camera: 'mdi:cctv',
    person: 'mdi:account',
    scene: 'mdi:palette',
    script: 'mdi:script-text',
  };
  return map[domainOf(entityId)] ?? 'mdi:circle-medium';
}

/**
 * Icon for domains where HA's ha-state-icon resolves icons asynchronously (shows a placeholder first).
 * Returns undefined to let ha-state-icon handle it.
 */
export function stateIcon(hass: HomeAssistant, s: HassEntity | undefined): string | undefined {
  if (!s) return undefined;
  const explicit = s.attributes.icon ?? hass.entities?.[s.entity_id]?.icon;
  if (explicit) return explicit;
  const d = domainOf(s.entity_id);
  const dc = s.attributes.device_class;
  const open = ['open', 'opening'].includes(s.state);
  switch (d) {
    case 'media_player':
      if (dc === 'tv') return s.state === 'off' ? 'mdi:television-off' : 'mdi:television';
      if (dc === 'receiver') return 'mdi:audio-video';
      return ['off', 'standby', 'unavailable'].includes(s.state) ? 'mdi:speaker-off' : 'mdi:speaker';
    case 'cover':
      if (dc === 'garage') return open ? 'mdi:garage-open' : 'mdi:garage';
      if (dc === 'door') return open ? 'mdi:door-open' : 'mdi:door-closed';
      if (dc === 'blind' || dc === 'curtain') return open ? 'mdi:blinds-horizontal' : 'mdi:blinds-horizontal-closed';
      if (dc === 'window') return open ? 'mdi:window-open' : 'mdi:window-closed';
      return open ? 'mdi:window-shutter-open' : 'mdi:window-shutter';
    case 'vacuum':
      return 'mdi:robot-vacuum';
    case 'todo':
      return 'mdi:clipboard-list-outline';
    case 'climate':
      return 'mdi:thermostat';
    case 'fan':
      return s.state === 'on' ? 'mdi:fan' : 'mdi:fan-off';
    case 'switch':
      return s.state === 'on' ? 'mdi:toggle-switch-variant' : 'mdi:toggle-switch-variant-off';
    case 'binary_sensor': {
      const on = s.state === 'on';
      const map: Record<string, [string, string]> = {
        door: ['mdi:door-open', 'mdi:door-closed'],
        window: ['mdi:window-open-variant', 'mdi:window-closed-variant'],
        opening: ['mdi:square-rounded-outline', 'mdi:square-rounded'],
        garage_door: ['mdi:garage-open', 'mdi:garage'],
        motion: ['mdi:motion-sensor', 'mdi:motion-sensor-off'],
        occupancy: ['mdi:home-account', 'mdi:home-outline'],
        presence: ['mdi:home-account', 'mdi:home-outline'],
        moisture: ['mdi:water-alert', 'mdi:water-off'],
        smoke: ['mdi:smoke-detector-alert', 'mdi:smoke-detector'],
        battery: ['mdi:battery-alert', 'mdi:battery'],
        connectivity: ['mdi:lan-connect', 'mdi:lan-disconnect'],
        plug: ['mdi:power-plug', 'mdi:power-plug-off'],
      };
      const pair = map[dc];
      return pair ? pair[on ? 0 : 1] : on ? 'mdi:checkbox-marked-circle' : 'mdi:checkbox-blank-circle-outline';
    }
    default:
      return undefined;
  }
}
