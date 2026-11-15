import { css, html, type TemplateResult } from 'lit';
import { getLanguage } from '../i18n';
import type { HassEntity, HomeAssistant } from '../types';

/** A row of large round action buttons with a label below (garage door, mower, irrigation, robot vacuum look) */
export interface RowAction {
  key: string;
  icon: string;
  label: string;
  on: () => void;
  primary?: boolean;
  disabled?: boolean;
}

export function actionRow(actions: RowAction[]): TemplateResult {
  return html`<div class="actions">
    ${actions.map(
      (b) => html`<button class="action pressable ${b.primary ? 'primary' : ''}" ?disabled=${b.disabled} @click=${b.on} data-action=${b.key}>
        <span class="circle"><ha-icon .icon=${b.icon}></ha-icon></span>
        <span class="lbl">${b.label}</span>
      </button>`,
    )}
  </div>`;
}

/** Time of the last change as "14:32" (today) or "Mo 14:32" / "12.10." (earlier) */
export function sinceText(s: HassEntity | undefined): string | undefined {
  if (!s?.last_changed) return undefined;
  const d = new Date(s.last_changed);
  if (isNaN(d.getTime())) return undefined;
  const loc = getLanguage() === 'de' ? 'de-DE' : 'en-US';
  const now = new Date();
  const time = d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  if (now.getTime() - d.getTime() < 6 * 86400000) return `${d.toLocaleDateString(loc, { weekday: 'short' })} ${time}`;
  return d.toLocaleDateString(loc, { day: 'numeric', month: 'numeric' });
}

/** Battery level of an entity: its own attribute, else a battery sensor of the same device */
export function deviceBattery(hass: HomeAssistant, entityId: string): number | undefined {
  const s = hass.states[entityId];
  if (s?.attributes.battery_level != null) return Number(s.attributes.battery_level);
  const dev = hass.entities?.[entityId]?.device_id;
  if (!dev) return undefined;
  for (const [id, e] of Object.entries(hass.entities))
    if (e.device_id === dev && id.startsWith('sensor.') && hass.states[id]?.attributes.device_class === 'battery') {
      const v = parseFloat(hass.states[id].state);
      if (!isNaN(v)) return v;
    }
  return undefined;
}

/** Other visible entities of the same device, with a lowercase search key (translation key + entity id) */
export function deviceSiblings(hass: HomeAssistant, entityId: string): { id: string; key: string }[] {
  const dev = hass.entities?.[entityId]?.device_id;
  if (!dev) return [];
  return Object.values(hass.entities)
    .filter((e) => e.device_id === dev && e.entity_id !== entityId && !e.hidden && hass.states[e.entity_id])
    .map((e) => ({ id: e.entity_id, key: `${e.translation_key ?? ''} ${e.entity_id}`.toLowerCase() }));
}

export const actionRowStyles = css`
  .actions {
    display: flex;
    justify-content: center;
    gap: var(--fp-space-5);
    margin: var(--fp-space-2) 0 var(--fp-space-5);
  }
  .action {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--fp-space-2);
    min-width: 72px;
  }
  .action[disabled] {
    opacity: 0.35;
    pointer-events: none;
  }
  .circle {
    width: 68px;
    height: 68px;
    border-radius: 50%;
    background: var(--fp-surface);
    box-shadow: var(--fp-shadow-1);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .circle ha-icon {
    --mdc-icon-size: 28px;
  }
  .action.primary .circle {
    background: var(--fp-accent);
    color: var(--fp-on-accent);
  }
  .lbl {
    font-size: var(--fp-text-footnote);
    font-weight: var(--fp-weight-semibold);
    color: var(--fp-label-2);
  }
  .run {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
    gap: var(--fp-space-2);
    margin: 0 0 var(--fp-space-4);
  }
  .rt {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 2px;
    padding: var(--fp-space-3);
    border-radius: var(--fp-radius-m);
    background: var(--fp-surface);
    box-shadow: var(--fp-shadow-1);
  }
  .rt .rv {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: var(--fp-text-headline, 17px);
    font-weight: var(--fp-weight-semibold);
    font-variant-numeric: tabular-nums;
  }
  .rt .rk {
    font-size: var(--fp-text-caption);
    color: var(--fp-label-2);
  }
  .note {
    display: flex;
    align-items: center;
    gap: var(--fp-space-2);
    justify-content: center;
    font-size: var(--fp-text-footnote);
    color: var(--fp-label-2);
    text-align: center;
  }
  .note ha-icon {
    --mdc-icon-size: 16px;
  }
`;
