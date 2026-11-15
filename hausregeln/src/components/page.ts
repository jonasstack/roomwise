import type { TemplateResult } from 'lit';
import type { Store } from '../store';

/**
 * What the panel's head shows for an area since the redesign: the area's name as title, a line below it (`sub`,
 * e.g. "6 Räume · 18 Lichtregeln · 3 gelten gerade"), the house mode and – when the page has one – a gear that opens
 * the page's own settings (`gear`: the panel calls openGear() on the area's view element), and a link to the floor
 * plan (`plan`). Each view registers itself when its module loads.
 */
export interface PageInfo {
  sub?: (s: Store) => TemplateResult | string;
  /** the view has openGear() (page settings: arrange rooms, house-wide values …) */
  gear?: boolean;
  /** show "Zum Grundriss" when the floor plan card is on a dashboard */
  plan?: boolean;
}

/** a view with page settings behind the gear in the head */
export interface GearView {
  openGear(): void;
}

export const PAGES: Record<string, PageInfo> = {};

export function registerPage(tab: 'rules' | 'light' | 'heat' | 'alarm' | 'home' | 'rooms' | 'devices' | 'history' | 'settings', info: PageInfo): void {
  PAGES[tab] = info;
}
