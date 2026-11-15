import type { FloorplanCardConfig, HomeAssistant } from './types';
import { companionInfo } from './entry-server';

/**
 * Shared floor plans and trace images, kept by the card part of roomwise (custom_components/roomwise/card,
 * plans.py). A card references a shared plan by id (`plan: <id>`); the plan's content replaces the matching keys of
 * the card config, everything else (title, height, view, users …) stays per card. Editing from any dashboard saves
 * a new revision, and every open card follows it live.
 */

/** The parts of a card config that belong to the plan (the same list as PLAN_KEYS in plans.py) */
export const SHARED_PLAN_KEYS = ['floors', 'north', 'wall_width', 'wall_height', 'back_wall_height', 'wall_color', 'grid', 'entry_alert'] as const;
type PlanKey = (typeof SHARED_PLAN_KEYS)[number];
export type PlanContent = Partial<Pick<FloorplanCardConfig, PlanKey>>;

export interface SharedPlanSummary {
  id: string;
  name: string;
  rev: number;
  updated: string;
  floors: number;
  rooms: number;
}

export interface SharedPlan {
  id: string;
  name: string;
  rev: number;
  updated: string;
  plan: PlanContent;
  /** pushed by the subscription when the plan was deleted */
  deleted?: boolean;
}

/** The companion is there and keeps shared plans */
export function sharesPlans(): boolean {
  return !!companionInfo()?.features?.includes('plans');
}

/** The companion keeps trace images */
export function keepsImages(): boolean {
  return !!companionInfo()?.features?.includes('images');
}

/** The plan's part of a config */
export function planPart(cfg: FloorplanCardConfig): PlanContent {
  const out: Record<string, unknown> = {};
  for (const k of SHARED_PLAN_KEYS) if (cfg[k] !== undefined) out[k] = structuredClone(cfg[k]);
  return out as PlanContent;
}

/** The card's own part of a config (with the reference, without the plan's keys) */
export function cardPart(cfg: FloorplanCardConfig): FloorplanCardConfig {
  const out: Record<string, unknown> = { ...cfg };
  for (const k of SHARED_PLAN_KEYS) delete out[k];
  return out as unknown as FloorplanCardConfig;
}

/** A card config showing a shared plan: the card's own settings plus the plan's content */
export function mergePlan(card: FloorplanCardConfig, plan: PlanContent): FloorplanCardConfig {
  return { ...cardPart(card), ...structuredClone(plan) } as FloorplanCardConfig;
}

// ---------- websocket ----------

export function listPlans(hass: HomeAssistant): Promise<SharedPlanSummary[]> {
  return hass.callWS<{ plans: SharedPlanSummary[] }>({ type: 'floorplan_card/plans/list' }).then((r) => r.plans ?? []);
}

export function getPlan(hass: HomeAssistant, id: string): Promise<SharedPlan> {
  return hass.callWS<SharedPlan>({ type: 'floorplan_card/plans/get', plan_id: id });
}

/** Saves a new plan (no id) or a new revision. `rev`: the revision the editor started from; a save from elsewhere in
 *  between fails with code "conflict" unless `force`. */
export function savePlan(
  hass: HomeAssistant,
  p: { id?: string; name: string; plan: PlanContent; rev?: number; force?: boolean },
): Promise<SharedPlanSummary> {
  const msg: Record<string, unknown> = { type: 'floorplan_card/plans/save', name: p.name, plan: p.plan };
  if (p.id) msg.plan_id = p.id;
  if (p.rev != null) msg.rev = p.rev;
  if (p.force) msg.force = true;
  return hass.callWS<SharedPlanSummary>(msg);
}

export function deletePlan(hass: HomeAssistant, id: string): Promise<unknown> {
  return hass.callWS({ type: 'floorplan_card/plans/delete', plan_id: id });
}

// one live subscription per plan and connection, shared by every card on the page
interface Watch {
  conn: unknown;
  last?: SharedPlan;
  listeners: Set<(p: SharedPlan) => void>;
  unsub?: Promise<() => void>;
}
const watches = new Map<string, Watch>();

/** Follow a shared plan: `cb` gets it now (when known) and after every save. Returns the unsubscribe. */
export function watchPlan(hass: HomeAssistant, id: string, cb: (p: SharedPlan) => void, onError?: (e: unknown) => void): () => void {
  let w = watches.get(id);
  if (w && w.conn !== hass.connection) {
    void w.unsub?.then((u) => u()).catch(() => {});
    watches.delete(id);
    w = undefined;
  }
  if (!w) {
    const nw: Watch = { conn: hass.connection, listeners: new Set() };
    nw.unsub = hass.connection.subscribeMessage<SharedPlan>(
      (p) => {
        nw.last = p;
        for (const l of nw.listeners) l(p);
      },
      { type: 'floorplan_card/plans/subscribe', plan_id: id },
    );
    nw.unsub.catch((e) => {
      if (watches.get(id) === nw) watches.delete(id);
      onError?.(e);
    });
    watches.set(id, nw);
    w = nw;
  }
  const watch = w;
  watch.listeners.add(cb);
  if (watch.last) cb(watch.last);
  return () => {
    watch.listeners.delete(cb);
    if (watch.listeners.size) return;
    // the last card left: keep nothing open
    if (watches.get(id) === watch) watches.delete(id);
    void watch.unsub?.then((u) => u()).catch(() => {});
  };
}

/** The last revision any card on this page has seen (the editor's starting point) */
export function knownPlan(id: string): SharedPlan | undefined {
  return watches.get(id)?.last;
}

// ---------- trace images ----------

const images = new Map<string, Promise<string | undefined>>();

/** A stored trace image as data URL (cached for the page); undefined when it is gone */
export function loadImage(hass: HomeAssistant, id: string): Promise<string | undefined> {
  let p = images.get(id);
  if (!p) {
    p = hass
      .callWS<{ data: string }>({ type: 'floorplan_card/images/get', image_id: id })
      .then((r) => r?.data)
      .catch(() => {
        images.delete(id);
        return undefined;
      });
    images.set(id, p);
  }
  return p;
}

export async function uploadImage(hass: HomeAssistant, data: string, width: number, height: number): Promise<string> {
  const r = await hass.callWS<{ id: string }>({ type: 'floorplan_card/images/save', data, width, height });
  images.set(r.id, Promise.resolve(data));
  return r.id;
}

export function deleteImage(hass: HomeAssistant, id: string): Promise<unknown> {
  images.delete(id);
  return hass.callWS({ type: 'floorplan_card/images/delete', image_id: id }).catch(() => undefined);
}

/** Every trace image a config references */
export function imageIds(cfg: Pick<FloorplanCardConfig, 'floors'> | undefined): Set<string> {
  return new Set((cfg?.floors ?? []).map((f) => f.trace?.image).filter((x): x is string => !!x));
}
