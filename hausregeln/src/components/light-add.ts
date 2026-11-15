/**
 * <hr-light-add>: "Licht hinzufügen" – find any lamp or light switch of the house (light.*, switch.*, input_boolean.*)
 * and either give it to this room for good (the central device store, like "Raum einstellen": it then counts as this
 * room's light everywhere) or – in a light rule – use it only in that rule. Fires "pick" {entity_id, assign} and "close".
 */
import { css, html, nothing } from 'lit';
import { mdiMagnify } from '@mdi/js';
import { StoreElement } from '../base';
import { fire, icon, shared } from '../design/shared';
import { kit } from '../design/kit';
import type { Device, Room } from '../model';
import { t } from '../i18n';
import './pop';
// i18n: complete

const DOMAINS = ['light.', 'switch.', 'input_boolean.'];

export class HrLightAdd extends StoreElement {
  static override properties = { ...StoreElement.properties, room: { attribute: false }, forRule: { type: Boolean }, _q: { state: true }, _busy: { state: true } };
  declare room: Room;
  /** opened from a light rule: offers "Nur in dieser Regel" too */
  declare forRule: boolean;
  declare _q: string;
  declare _busy: string;

  constructor() {
    super();
    this.forRule = false;
    this._q = '';
    this._busy = '';
  }

  static override styles = [
    shared,
    kit,
    css`
      .search {
        display: flex;
        align-items: center;
        gap: var(--hr-space-2);
        padding: 8px 12px;
        border-radius: var(--hr-radius-m, 12px);
        background: var(--hr-fill);
      }
      .search input {
        flex: 1;
        border: 0;
        background: transparent;
        font: inherit;
        color: var(--hr-label);
        outline: none;
      }
      .list {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-top: var(--hr-space-3);
      }
      .item {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        padding: 10px 12px;
        border-radius: var(--hr-radius-m, 12px);
        background: var(--hr-surface-2, var(--hr-fill));
      }
      .item .grow {
        flex: 1 1 180px;
        min-width: 0;
      }
      .item b {
        display: block;
      }
      .item small {
        color: var(--hr-label-2);
        overflow-wrap: anywhere;
      }
      .acts {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
    `,
  ];

  /** every lamp-like entity Hausregeln knows, this room's own last */
  private _candidates(): Device[] {
    const q = this._q.trim().toLowerCase();
    return this.store.devices
      .filter((d) => DOMAINS.some((p) => d.entity_id.startsWith(p)) && d.kind !== 'vehicle')
      .filter((d) => !q || d.name.toLowerCase().includes(q) || d.entity_id.includes(q))
      .sort((a, b) => Number(a.room === this.room.id) - Number(b.room === this.room.id) || Number(b.kind === 'light') - Number(a.kind === 'light') || a.name.localeCompare(b.name, 'de'))
      .slice(0, 60);
  }

  private _where(d: Device): string {
    if (d.room === this.room.id) return t('light.add_here');
    const r = this.store.rooms.find((x) => x.id === d.room);
    const kind = d.kind === 'light' ? (d.entity_id.startsWith('light.') ? t('light.add_lamp') : t('light.add_switch_light')) : t('light.add_switch');
    return `${kind} · ${r ? r.name : t('light.add_no_room')}`;
  }

  private async _assign(d: Device) {
    this._busy = d.entity_id;
    try {
      // the central device store: a lamp of this room from now on (a switch becomes a light)
      await this.store.setDevices([{ entity_id: d.entity_id, kind: 'light', room: this.room.id }]);
      fire(this, 'pick', { entity_id: d.entity_id, assign: true });
    } finally {
      this._busy = '';
    }
  }

  override render() {
    const list = this._candidates();
    return html`<hr-pop heading=${t('light.add_title')} .sub=${t('light.add_sub', { room: this.room.name })} @close=${() => fire(this, 'close')}>
      <label class="search">${icon(mdiMagnify, 18)}<input type="search" placeholder=${t('light.add_search')} .value=${this._q} @input=${(e: Event) => (this._q = (e.target as HTMLInputElement).value)} /></label>
      <div class="list">
        ${list.length
          ? list.map(
              (d) => html`<div class="item" data-entity=${d.entity_id}>
                <span class="grow"><b>${d.name}</b><small>${this._where(d)} · ${d.entity_id}</small></span>
                <span class="acts">
                  ${d.room === this.room.id && d.kind === 'light'
                    ? nothing
                    : html`<button class="btn small primary" data-assign ?disabled=${!!this._busy} @click=${() => this._assign(d)}>${t('light.add_assign')}</button>`}
                  ${this.forRule ? html`<button class="btn small" data-rule-only @click=${() => fire(this, 'pick', { entity_id: d.entity_id, assign: false })}>${t('light.add_rule_only')}</button>` : nothing}
                </span>
              </div>`,
            )
          : html`<p class="rl-note">${t('light.add_none')}</p>`}
      </div>
    </hr-pop>`;
  }
}
customElements.define('hr-light-add', HrLightAdd);
