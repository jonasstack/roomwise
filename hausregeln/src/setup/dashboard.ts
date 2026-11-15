/**
 * The floor plan dashboard of the setup wizard (wall tablet or phone/PC). Uses Home Assistant's own
 * lovelace websocket API, only after the user confirmed in the wizard: it creates a NEW dashboard with a free
 * url_path and never changes an existing one (existing dashboards are only read, to reuse a drawn floor plan).
 */
import type { Store } from '../store';

export type DashKind = 'tablet' | 'view';

interface DashInfo {
  url_path: string;
  title?: string;
  mode?: string;
}

/** Is the floor plan card (roomwise) there? Its integration loads the card on every page; the backend reports the integration. */
export function floorplanAvailable(store: Store): boolean {
  return !!customElements.get('floorplan-card') || !!store.setup?.floorplan;
}

/** A floor plan card that is already drawn in one of the dashboards (read only), so the new view shows the same plan. */
export async function findFloorplanCard(store: Store): Promise<{ card: Record<string, unknown>; dashboard: string } | null> {
  const dashes = (await store.callHA<DashInfo[]>({ type: 'lovelace/dashboards/list' }).catch(() => null)) ?? [];
  const paths: (string | null)[] = [null, ...dashes.filter((d) => d.mode !== 'yaml').map((d) => d.url_path)];
  for (const url_path of paths) {
    const cfg = await store.callHA<{ views?: unknown[] }>({ type: 'lovelace/config', url_path }).catch(() => null);
    const card = cfg ? findCard(cfg) : null;
    if (card && Array.isArray((card as { floors?: unknown[] }).floors) && (card as { floors: unknown[] }).floors.length)
      return { card, dashboard: url_path ? dashes.find((d) => d.url_path === url_path)?.title ?? url_path : 'Übersicht' };
  }
  return null;
}

function findCard(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const x of node) {
      const f = findCard(x);
      if (f) return f;
    }
    return null;
  }
  const o = node as Record<string, unknown>;
  if (o.type === 'custom:floorplan-card') return o;
  for (const k of ['views', 'cards', 'sections', 'card']) {
    const f = findCard(o[k]);
    if (f) return f;
  }
  return null;
}

/** Every dashboard view that shows the floor plan card (read only), for the way back from Hausregeln to the plan. */
export async function findFloorplanViews(store: Store): Promise<{ title: string; path: string }[]> {
  const dashes = (await store.callHA<DashInfo[]>({ type: 'lovelace/dashboards/list' }).catch(() => null)) ?? [];
  const paths: (string | null)[] = [null, ...dashes.filter((d) => d.mode !== 'yaml').map((d) => d.url_path)];
  const out: { title: string; path: string }[] = [];
  for (const url_path of paths) {
    const cfg = await store.callHA<{ title?: string; views?: { title?: string; path?: string }[] }>({ type: 'lovelace/config', url_path }).catch(() => null);
    const dash = url_path ? (dashes.find((d) => d.url_path === url_path)?.title ?? url_path) : 'Übersicht';
    (cfg?.views ?? []).forEach((v, i) => {
      if (findCard(v)) out.push({ title: v.title && v.title !== dash ? `${dash} · ${v.title}` : dash, path: `/${url_path ?? 'lovelace'}/${v.path ?? i}` });
    });
  }
  return out;
}

/** go to a page of Home Assistant without reloading (as its own links do) */
export function openPath(path: string): void {
  history.pushState(null, '', path);
  window.dispatchEvent(new CustomEvent('location-changed', { detail: { replace: false } }));
}

/** a url_path that is not taken by a dashboard or a sidebar panel (Home Assistant wants a "-" in it) */
export async function freePath(store: Store, base: string): Promise<string> {
  const dashes = (await store.callHA<DashInfo[]>({ type: 'lovelace/dashboards/list' }).catch(() => null)) ?? [];
  const panels = Object.keys(((store as unknown as { hass?: { panels?: Record<string, unknown> } }).hass?.panels) ?? {});
  const taken = new Set([...dashes.map((d) => d.url_path), ...panels]);
  let path = base;
  for (let i = 2; taken.has(path); i++) path = `${base}-${i}`;
  return path;
}

/** The view: one panel view (the card fills the screen), the floor plan card in it. */
export function dashboardConfig(kind: DashKind, card: Record<string, unknown>): Record<string, unknown> {
  const c = { ...card, type: 'custom:floorplan-card' } as Record<string, unknown>;
  // wall tablet: full height under the header; in a kiosk browser without header use 100vh
  if (kind === 'tablet') c.height = 'calc(100vh - var(--header-height, 56px))';
  return {
    title: kind === 'tablet' ? 'Wandtablet' : 'Grundriss',
    views: [{ title: 'Grundriss', path: 'grundriss', icon: 'mdi:floor-plan', type: 'panel', cards: [c] }],
  };
}

/** Creates the dashboard. Returns its url_path, or null in the preview. */
export async function createDashboard(store: Store, kind: DashKind, card: Record<string, unknown>): Promise<string | null> {
  const url_path = await freePath(store, kind === 'tablet' ? 'grundriss-tablet' : 'grundriss-ansicht');
  const made = await store.callHA({
    type: 'lovelace/dashboards/create',
    url_path,
    title: kind === 'tablet' ? 'Wandtablet' : 'Grundriss',
    icon: kind === 'tablet' ? 'mdi:tablet-dashboard' : 'mdi:floor-plan',
    show_in_sidebar: true,
    require_admin: false,
  });
  if (made === null) return null;
  await store.callHA({ type: 'lovelace/config/save', url_path, config: dashboardConfig(kind, card) });
  return url_path;
}

/** A first plan when none is drawn yet: the card's own template (one rectangle per HA area). */
export function stubCard(store: Store): Record<string, unknown> {
  const el = customElements.get('floorplan-card') as unknown as { getStubConfig?: (hass: unknown) => Record<string, unknown> } | undefined;
  const hass = (store as unknown as { hass?: unknown }).hass;
  try {
    if (el?.getStubConfig) return el.getStubConfig(hass);
  } catch {
    /* fall through */
  }
  return { type: 'custom:floorplan-card' };
}

/** The floor plan card's own front door warning ("entry_alert"), read from the dashboards (read only), for a one-time import. */
export async function findEntryAlert(store: Store): Promise<{ entry: Record<string, unknown>; openings: Record<string, unknown>[]; dashboard: string } | null> {
  const dashes = (await store.callHA<DashInfo[]>({ type: 'lovelace/dashboards/list' }).catch(() => null)) ?? [];
  const paths: (string | null)[] = [null, ...dashes.filter((d) => d.mode !== 'yaml').map((d) => d.url_path)];
  for (const url_path of paths) {
    const cfg = await store.callHA<{ views?: unknown[] }>({ type: 'lovelace/config', url_path }).catch(() => null);
    for (const card of cfg ? allCards(cfg) : []) {
      const entry = card.entry_alert as Record<string, unknown> | undefined;
      if (!entry?.door) continue;
      const floors = (card.floors as { openings?: Record<string, unknown>[] }[] | undefined) ?? [];
      const openings = floors.flatMap((f) => f.openings ?? []).map((o) => ({ id: o.id, type: o.type, entity: o.entity, name: o.name }));
      return { entry, openings, dashboard: url_path ? dashes.find((d) => d.url_path === url_path)?.title ?? url_path : 'Übersicht' };
    }
  }
  return null;
}

function allCards(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const x of node) allCards(x, out);
    return out;
  }
  const o = node as Record<string, unknown>;
  if (o.type === 'custom:floorplan-card') out.push(o);
  for (const k of ['views', 'cards', 'sections', 'card']) allCards(o[k], out);
  return out;
}
