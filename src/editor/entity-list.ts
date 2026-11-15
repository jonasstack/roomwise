import { LitElement, css, html, nothing } from 'lit';
import { components } from '../design/components';
import type { HomeAssistant } from '../types';
import { domainOf, entityName, formatState, stateIcon } from '../ha';
import { t, type I18nKey } from '../i18n';
import { isVehicleEntity } from '../vehicles';

export interface EntityFilter {
  domains?: string[];
  deviceClasses?: string[];
  /** leave out the entities of vehicles (a car's doors are no house doors) — they show only when searched for */
  noVehicles?: boolean;
}

const FILTER_DOMAINS = ['light', 'switch', 'climate', 'media_player', 'vacuum', 'cover', 'fan', 'sensor', 'binary_sensor', 'todo'];

/**
 * Searchable entity list grouped by area. Used for the device library (draggable rows) and the
 * entity picker. Emits `entity-select` (tap) and `entity-drag-start` (pointer drag out of the list).
 */
export class FpEntityList extends LitElement {
  static override properties = {
    hass: { attribute: false },
    filter: { attribute: false },
    selected: { attribute: false },
    draggable: { type: Boolean },
    dragAxis: { type: String },
    _q: { state: true },
    _domain: { state: true },
  };
  declare hass: HomeAssistant;
  declare filter?: EntityFilter;
  declare selected?: string[];
  declare draggable: boolean;
  /** 'x' (side panel: drag left) or 'y' (bottom sheet: drag up) */
  declare dragAxis: 'x' | 'y';
  declare _q: string;
  declare _domain: string;

  private press?: { id: string; x: number; y: number; started: boolean; pointerId: number; el: HTMLElement };

  constructor() {
    super();
    this._q = '';
    this._domain = 'all';
    this.draggable = false;
    this.dragAxis = 'x';
  }

  private accepts(id: string): boolean {
    const s = this.hass.states[id];
    if (!s) return false;
    const d = domainOf(id);
    const f = this.filter;
    if (f?.domains && !f.domains.includes(d)) return false;
    if (f?.deviceClasses && !f.deviceClasses.includes(s.attributes.device_class)) return false;
    if (!f?.domains && this._domain !== 'all' && (this._domain === 'other' ? FILTER_DOMAINS.includes(d) : d !== this._domain)) return false;
    const e = this.hass.entities?.[id];
    if (e?.hidden) return false;
    if (!f && e?.entity_category) return false;
    const q = this._q.trim().toLowerCase();
    if (f?.noVehicles && !q && isVehicleEntity(this.hass, id)) return false;
    if (!q) return true;
    return id.toLowerCase().includes(q) || entityName(this.hass, id, s).toLowerCase().includes(q);
  }

  private groups(): [string, string[]][] {
    const by = new Map<string, string[]>();
    for (const id of Object.keys(this.hass.states)) {
      if (!this.accepts(id)) continue;
      const e = this.hass.entities?.[id];
      const area = e?.area_id ?? (e?.device_id ? this.hass.devices?.[e.device_id]?.area_id : undefined) ?? '';
      if (!by.has(area)) by.set(area, []);
      by.get(area)!.push(id);
    }
    const name = (a: string) => (a ? (this.hass.areas?.[a]?.name ?? a) : '￿');
    return [...by.entries()]
      .sort((a, b) => name(a[0]).localeCompare(name(b[0])))
      .map(([a, ids]) => [a, ids.sort((x, y) => entityName(this.hass, x).localeCompare(entityName(this.hass, y)))]);
  }

  private down(e: PointerEvent, id: string) {
    if (!this.draggable) return;
    const el = e.currentTarget as HTMLElement;
    if (e.pointerType === 'mouse') el.setPointerCapture(e.pointerId);
    this.press = { id, x: e.clientX, y: e.clientY, started: false, pointerId: e.pointerId, el };
  }

  private move(e: PointerEvent) {
    const p = this.press;
    if (!p || p.started || e.pointerId !== p.pointerId) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (Math.hypot(dx, dy) < 10) return;
    // Towards the plan (left for the side panel, up for the bottom sheet); mostly-vertical moves scroll the list.
    const intent = this.dragAxis === 'x' ? dx < 0 && Math.abs(dx) > Math.abs(dy) * 0.4 : dy < 0 && Math.abs(dy) > Math.abs(dx) * 0.4;
    if (!intent) {
      this.press = undefined; // let the list scroll
      return;
    }
    p.started = true;
    try {
      p.el.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.dispatchEvent(new CustomEvent('entity-drag-start', { detail: { entity: p.id, event: e }, bubbles: true, composed: true }));
    this.press = undefined;
  }

  private up(id: string) {
    const p = this.press;
    this.press = undefined;
    if (p && p.started) return;
    this.dispatchEvent(new CustomEvent('entity-select', { detail: { entity: id }, bubbles: true, composed: true }));
  }

  override render() {
    const groups = this.groups();
    const total = groups.reduce((n, [, ids]) => n + ids.length, 0);
    return html`
      <div class="top">
        <div class="search">
          <ha-icon icon="mdi:magnify"></ha-icon>
          <input class="field" type="search" placeholder=${t('common.search')} .value=${this._q} @input=${(e: any) => (this._q = e.target.value)} />
        </div>
        ${this.filter?.domains
          ? nothing
          : html`<div class="filters">
              ${['all', 'light', 'climate', 'media_player', 'switch', 'sensor', 'binary_sensor', 'other'].map(
                (d) => html`<button class="chip pressable" aria-pressed=${this._domain === d ? 'true' : 'false'} @click=${() => (this._domain = d)}>
                  ${d === 'all' ? t('editor.all') : t(`domain.${d}` as I18nKey)}
                </button>`,
              )}
            </div>`}
      </div>
      <div class="list">
        ${groups.slice(0, 40).map(
          ([area, ids]) => html`<div class="section-title">${area ? (this.hass.areas?.[area]?.name ?? area) : '—'}</div>
            <div class="group">
              ${ids.slice(0, 80).map((id) => {
                const s = this.hass.states[id];
                const sel = this.selected?.includes(id);
                const icon = stateIcon(this.hass, s);
                return html`<button
                  class="row item ${sel ? 'sel' : ''}"
                  data-entity=${id}
                  style=${this.draggable ? `touch-action:${this.dragAxis === 'x' ? 'pan-y' : 'pan-x'}` : ''}
                  @pointerdown=${(e: PointerEvent) => this.down(e, id)}
                  @pointermove=${(e: PointerEvent) => this.move(e)}
                  @click=${() => this.up(id)}
                >
                  <span class="ic">${icon ? html`<ha-icon .icon=${icon}></ha-icon>` : html`<ha-state-icon .hass=${this.hass} .stateObj=${s}></ha-state-icon>`}</span>
                  <span class="grow">
                    <span class="title">${entityName(this.hass, id, s)}</span>
                    <span class="subtitle">${id}</span>
                  </span>
                  <span class="trailing">${sel ? html`<ha-icon icon="mdi:check" class="check"></ha-icon>` : formatState(this.hass, s)}</span>
                </button>`;
              })}
            </div>`,
        )}
        ${!total ? html`<div class="empty">—</div>` : nothing}
      </div>
    `;
  }

  static override styles = [
    components,
    css`
      :host {
        display: flex;
        flex-direction: column;
        min-height: 0;
      }
      .top {
        display: flex;
        flex-direction: column;
        gap: var(--fp-space-3);
        padding-bottom: var(--fp-space-2);
      }
      .search .field {
        background: var(--fp-surface);
      }
      .filters {
        display: flex;
        gap: var(--fp-space-2);
        overflow-x: auto;
        scrollbar-width: none;
        margin: 0 calc(var(--fp-space-4) * -1);
        padding: 0 var(--fp-space-4);
      }
      .filters::-webkit-scrollbar {
        display: none;
      }
      .filters .chip {
        min-height: 36px;
        background: var(--fp-surface);
      }
      .filters .chip[aria-pressed='true'] {
        background: var(--fp-label);
        color: var(--fp-surface);
      }
      .list {
        overflow-y: auto;
        flex: 1;
        min-height: 0;
        padding-bottom: var(--fp-space-6);
        overscroll-behavior: contain;
      }
      .section-title {
        margin-left: var(--fp-space-2);
      }
      .row.item {
        cursor: grab;
        user-select: none;
        -webkit-user-select: none;
      }
      .row .grow {
        display: flex;
        flex-direction: column;
      }
      .row .title {
        font-size: var(--fp-text-subhead);
      }
      .row .subtitle {
        font-size: var(--fp-text-caption);
      }
      .row .trailing {
        font-size: var(--fp-text-footnote);
        max-width: 90px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .ic {
        width: 32px;
        height: 32px;
        border-radius: var(--fp-radius-full);
        background: var(--fp-fill);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--fp-label-2);
        flex: none;
        --mdc-icon-size: 18px;
      }
      .check {
        color: var(--fp-accent);
      }
      .row.sel .title {
        color: var(--fp-accent);
        font-weight: var(--fp-weight-semibold);
      }
      .empty {
        text-align: center;
        color: var(--fp-label-3);
        padding: var(--fp-space-7);
      }
    `,
  ];
}

if (!customElements.get('fp-entity-list')) customElements.define('fp-entity-list', FpEntityList);
