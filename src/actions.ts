import type { ActionConfig, ActionSet, DeviceConfig, HomeAssistant, MediaControlsConfig, OpeningConfig, PopupTarget, RoomConfig } from './types';

export type ItemKind = 'room' | 'device' | 'opening';
import { domainOf, fireEvent, isUnavailable, navigate } from './ha';
import type { OptimisticStore } from './optimistic';
import { t } from './i18n';
import { isGarageCover } from './openings';
import { describeClose, openRequest, serviceOpens, targetIds, type OpenRequest } from './access';

export type Gesture = 'tap' | 'double_tap' | 'hold';

/** Domains with an own popup. Everything else falls back to HA's more-info dialog. */
export const POPUP_DOMAINS = new Set(['light', 'climate', 'vacuum', 'cover', 'todo', 'media_player', 'lawn_mower', 'valve', 'lock']);

/** Never toggled without confirmation, regardless of configuration. */
const SENSITIVE = new Set(['lock', 'alarm_control_panel', 'siren', 'notify']);

const TOGGLE_ON_OFF = new Set(['light', 'switch', 'fan', 'input_boolean', 'automation', 'humidifier', 'media_player']);

export interface ActionHost {
  hass: HomeAssistant;
  node: HTMLElement;
  optimistic: OptimisticStore;
  openPopup(target: PopupTarget): void;
  confirm(text: string): Promise<boolean>;
  /** Second step before anything opens access (access.ts): resolves true only after the slide */
  confirmOpen(req: OpenRequest): Promise<boolean>;
  toast(text: string): void;
  roomLights(room: RoomConfig): string[];
  /** Zoom onto a room (or the room containing a device) */
  focusRoom(room?: RoomConfig, device?: DeviceConfig): void;
}

export function defaultAction(kind: ItemKind, gesture: Gesture): ActionConfig {
  if (kind === 'opening') return gesture === 'double_tap' ? { action: 'none' } : { action: 'more-info' };
  if (kind === 'room') {
    // a tap focuses the room (zoom in, its label on top), a double tap switches its lights, holding opens its panel
    if (gesture === 'tap') return { action: 'zoom' };
    if (gesture === 'double_tap') return { action: 'toggle-lights' };
    return { action: 'popup' };
  }
  if (gesture === 'tap') return { action: 'popup' };
  if (gesture === 'hold') return { action: 'more-info' };
  return { action: 'none' };
}

/** Linked furniture: lamps, fans & co. switch on tap, everything else opens its controls. */
export function furnitureAction(item: ActionSet & { entity: string; media?: MediaControlsConfig }, gesture: Gesture): ActionConfig {
  const cfg = item[`${gesture}_action` as const];
  if (cfg && cfg.action !== 'default') return cfg;
  const d = domainOf(item.entity);
  // own media buttons: a tap opens them (also for a TV switched by a plain switch)
  if (gesture === 'tap' && item.media && d !== 'light') return { action: 'popup' };
  if (gesture === 'tap') return ['light', 'switch', 'fan', 'input_boolean', 'humidifier'].includes(d) ? { action: 'toggle' } : { action: 'popup' };
  if (gesture === 'hold') return { action: 'popup' };
  return { action: 'none' };
}

export function resolveAction(item: ActionSet, kind: ItemKind, gesture: Gesture): ActionConfig {
  const cfg = item[`${gesture}_action` as const];
  if (!cfg || cfg.action === 'default') {
    // a garage door in the wall opens its controls (open / stop / close), never more-info first
    if (kind === 'opening' && (item as OpeningConfig).type === 'garage' && (item as OpeningConfig).entity && gesture !== 'double_tap')
      return gesture === 'tap' ? { action: 'popup' } : { action: 'more-info' };
    return defaultAction(kind, gesture);
  }
  return cfg;
}

/** Garage doors and gates never move by accident: switching one directly always asks first */
function guarded(host: ActionHost, entity: string | undefined, ctx: { opening?: OpeningConfig; garage?: boolean }): boolean {
  if (!entity) return false;
  if (ctx.garage || ctx.opening?.type === 'garage') return true;
  return isGarageCover(host.hass.states[entity]);
}

/** The open request for a toggle / perform-action, or undefined when the action does not open anything */
export function opensAccess(host: ActionHost, action: ActionConfig, entity: string | undefined, ctx: { opening?: OpeningConfig; garage?: boolean }): OpenRequest | undefined {
  const { hass } = host;
  if (action.action === 'toggle' && entity) {
    const cur = host.optimistic.get(hass, entity);
    const d = domainOf(entity);
    // a garage door / gate on the plan reported by a contact sensor or switch: toggling a closed one opens it
    if ((ctx.garage || ctx.opening?.type === 'garage') && !['open', 'opening', 'on'].includes(cur?.state ?? '') && d !== 'cover' && d !== 'lock')
      return openRequest(hass, entity, 'toggle', {}, cur) ?? { ...accessFallback(hass, entity), verb: 'open' };
    return openRequest(hass, entity, d === 'button' || d === 'input_button' ? 'press' : 'toggle', {}, cur);
  }
  if (action.action === 'perform-action' || action.action === 'call-service') {
    const svc = action.perform_action ?? action.service;
    if (!svc || !svc.includes('.')) return undefined;
    return serviceOpens(hass, svc, action.data ?? action.service_data ?? {}, targetIds(action.target, action.entity));
  }
  return undefined;
}

function accessFallback(hass: HomeAssistant, entity: string): OpenRequest {
  const name = hass.states[entity]?.attributes.friendly_name ?? entity;
  return { title: t('access.title_open', { name }), text: t('access.text_open', { name }), icon: 'mdi:garage-open-variant', verb: 'open' };
}

export function hasDoubleTap(item: ActionSet | undefined, kind: ItemKind): boolean {
  if (!item) return false;
  return resolveAction(item, kind, 'double_tap').action !== 'none';
}

export async function runAction(
  host: ActionHost,
  action: ActionConfig,
  ctx: { room?: RoomConfig; device?: DeviceConfig; opening?: OpeningConfig; garage?: boolean },
): Promise<void> {
  const entity = action.entity ?? ctx.device?.entity ?? ctx.opening?.entity;
  const domain = entity ? domainOf(entity) : undefined;
  const garage = (action.action === 'toggle' || action.action === 'perform-action' || action.action === 'call-service') && guarded(host, entity, ctx);
  const needsConfirm = action.confirmation || (action.action === 'toggle' && domain && SENSITIVE.has(domain)) || garage;
  // anything that opens access (garage door, gate, lock, a car's sunroof …) needs the slide, whatever is configured
  const opens = opensAccess(host, action, entity, ctx);
  if (opens) {
    if (!(await host.confirmOpen(opens))) return;
  } else if (garage && entity) {
    const gate = host.hass.states[entity]?.attributes.device_class === 'gate';
    if (!(await host.confirmOpen(describeClose(host.hass, entity, gate)))) return;
  } else if (needsConfirm) {
    const fallback = garage ? t('garage.confirm_toggle') : t('confirm.default');
    const text = typeof action.confirmation === 'object' && action.confirmation.text ? action.confirmation.text : fallback;
    if (!(await host.confirm(text))) return;
  }
  const { hass } = host;
  try {
    switch (action.action) {
      case 'none':
        return;
      case 'toggle-lights': {
        const lights = action.entity ? [action.entity] : ctx.room ? host.roomLights(ctx.room) : entity ? [entity] : [];
        if (!lights.length) return;
        await toggleLights(host, lights);
        return;
      }
      case 'toggle': {
        if (!entity) return;
        await toggleEntity(host, entity);
        return;
      }
      case 'popup': {
        const target = action.entity ?? ctx.device?.entity ?? ctx.opening?.entity;
        // a device with own media buttons opens the media controls, whatever its domain
        const media = ctx.device?.media && target === ctx.device.entity ? ctx.device.media : undefined;
        host.openPopup({ entity: target, room: target ? undefined : ctx.room, media, name: media ? ctx.device?.name : undefined, item: media ? ctx.device?.id : undefined });
        return;
      }
      case 'more-info': {
        const id = entity ?? ctx.room?.climate ?? ctx.room?.temperature ?? (ctx.room ? host.roomLights(ctx.room)[0] : undefined);
        if (id) fireEvent(host.node, 'hass-more-info', { entityId: id });
        return;
      }
      case 'perform-action':
      case 'call-service': {
        const svc = action.perform_action ?? action.service;
        if (!svc || !svc.includes('.')) return;
        const [d, s] = svc.split('.', 2);
        const target = action.target ?? (action.entity ? { entity_id: action.entity } : undefined);
        await hass.callService(d, s, action.data ?? action.service_data ?? {}, target);
        return;
      }
      case 'navigate':
        if (action.navigation_path) navigate(action.navigation_path);
        return;
      case 'zoom':
        host.focusRoom(ctx.room, ctx.device);
        return;
      case 'url': {
        const url = safeUrl(action.url_path);
        if (url && action.new_tab === false) window.location.assign(url);
        else if (url) window.open(url, '_blank', 'noopener');
        return;
      }
    }
  } catch (err) {
    console.info('[floorplan-card] action failed', action, err);
    host.toast(t('card.action_failed'));
  }
}

export async function toggleLights(host: ActionHost, lights: string[], forceOn?: boolean) {
  const { hass, optimistic } = host;
  const anyOn = lights.some((id) => optimistic.get(hass, id)?.state === 'on');
  const turnOn = forceOn ?? !anyOn;
  const targets = lights.filter((id) => hass.states[id] && hass.states[id].state !== 'unavailable');
  if (!targets.length) return;
  for (const id of targets) optimistic.set(hass, id, turnOn ? 'on' : 'off');
  try {
    // lamps by light.*, light switches (switch.*, input_boolean.*) by their own domain – all at the same time
    const byDomain = new Map<string, string[]>();
    for (const id of targets) {
      const d = domainOf(id);
      const dom = d === 'switch' || d === 'input_boolean' ? d : 'light';
      byDomain.set(dom, [...(byDomain.get(dom) ?? []), id]);
    }
    await Promise.all([...byDomain].map(([dom, ids]) => hass.callService(dom, turnOn ? 'turn_on' : 'turn_off', {}, { entity_id: ids })));
  } catch (err) {
    optimistic.clear(targets);
    throw err;
  }
}

export async function toggleEntity(host: ActionHost, entity: string) {
  const { hass, optimistic } = host;
  const domain = domainOf(entity);
  const cur = optimistic.get(hass, entity);
  if (!cur) return;
  // an unreachable device would only answer with an error: say so instead of trying
  // (buttons, scenes and scripts report "unknown" until first used: only "unavailable" counts there)
  if (['button', 'input_button', 'scene', 'script'].includes(domain) ? cur.state === 'unavailable' : isUnavailable(cur)) return host.toast(t('card.unavailable'));
  let service = 'toggle';
  let svcDomain = domain;
  if (domain === 'cover') service = cur.state === 'open' || cur.state === 'opening' ? 'close_cover' : 'open_cover';
  else if (domain === 'lock') service = cur.state === 'locked' ? 'unlock' : 'lock';
  else if (domain === 'scene' || domain === 'script') service = 'turn_on';
  else if (domain === 'button' || domain === 'input_button') service = 'press';
  else if (domain === 'vacuum') service = cur.state === 'cleaning' ? 'pause' : 'start';
  else if (!TOGGLE_ON_OFF.has(domain)) svcDomain = 'homeassistant';
  if (TOGGLE_ON_OFF.has(domain) && ['on', 'off'].includes(cur.state)) optimistic.set(hass, entity, cur.state === 'on' ? 'off' : 'on');
  try {
    await hass.callService(svcDomain, service, {}, { entity_id: entity });
  } catch (err) {
    optimistic.clear([entity]);
    throw err;
  }
}

/** Run a service with an optimistic override; reverts and rethrows on failure. */
export async function callOptimistic(
  host: Pick<ActionHost, 'hass' | 'optimistic'>,
  entity: string,
  override: { state?: string; attributes?: Record<string, unknown> },
  domain: string,
  service: string,
  data: Record<string, unknown> = {},
) {
  host.optimistic.set(host.hass, entity, override.state, override.attributes);
  try {
    await host.hass.callService(domain, service, data, { entity_id: entity });
  } catch (err) {
    host.optimistic.clear([entity]);
    throw err;
  }
}

/** Only web addresses and paths of this Home Assistant: no javascript:/data: links from a configuration */
export function safeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url, window.location.href);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}
