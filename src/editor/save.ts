import type { FloorplanCardConfig, HomeAssistant } from '../types';
import { cleanConfig, uid } from '../config';

/** url_path of the dashboard currently shown (null for the default dashboard). */
export function currentDashboard(): string | null {
  const seg = location.pathname.split('/').filter(Boolean)[0];
  return !seg || seg === 'lovelace' ? null : seg;
}

const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

/**
 * Replaces this card inside the dashboard config and saves it. The card is found by card_id, or
 * (for configs without one) by deep equality with the config the card was created from.
 */
export async function saveCardConfig(
  hass: HomeAssistant,
  original: FloorplanCardConfig,
  next: FloorplanCardConfig,
): Promise<FloorplanCardConfig> {
  const url_path = currentDashboard();
  const dash = await hass.callWS<any>({ type: 'lovelace/config', url_path });
  if (!dash || typeof dash !== 'object' || !Array.isArray(dash.views)) throw new Error('dashboard is not in storage mode');
  const out = cleanConfig({ ...next, card_id: next.card_id ?? original.card_id ?? uid('fp') });
  const target = stable(original);
  let found = false;

  const visit = (node: any): any => {
    if (found || !node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(visit);
    if (node.type === 'custom:floorplan-card' && ((original.card_id && node.card_id === original.card_id) || stable(node) === target)) {
      found = true;
      return out;
    }
    const copy: any = {};
    for (const [k, v] of Object.entries(node)) copy[k] = v && typeof v === 'object' ? visit(v) : v;
    return copy;
  };
  const updated = visit(dash);
  if (!found) throw new Error('card not found');
  await hass.callWS({ type: 'lovelace/config/save', url_path, config: updated });
  return out;
}
