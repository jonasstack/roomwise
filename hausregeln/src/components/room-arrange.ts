import { css, html, nothing, type TemplateResult } from 'lit';
import { mdiChevronDown, mdiChevronUp, mdiEyeOffOutline, mdiEyeOutline } from '@mdi/js';
import { StoreElement } from '../base';
import { icon, shared } from '../design/shared';
import { kit } from '../design/kit';
import type { RoomPage } from '../model';
import type { Store } from '../store';
import { t, tn } from '../i18n';
import './pop';
// i18n: complete

/**
 * <hr-room-arrange page="light">: pop-up "Räume anordnen". One order of the room tiles for all pages (Licht,
 * Heizung, Räume, Geräte), hiding per page. A hidden room keeps its rules and plans, it is only not shown as a tile.
 * Saved at once (store.saveUi). Fires "close".
 */
export class HrRoomArrange extends StoreElement {
  static override properties = { ...StoreElement.properties, page: { type: String } };
  declare page: RoomPage;

  static override styles = [
    shared,
    kit,
    css`
      .rl-item .name {
        flex: 1;
        min-width: 0;
        font-weight: 600;
      }
      .rl-item.hid .name {
        color: var(--hr-label-2);
        font-weight: 500;
      }
      .moves {
        display: flex;
        gap: 2px;
      }
    `,
  ];

  private _move(id: string, by: number) {
    const ids = this.store.orderedRooms().map((r) => r.id);
    const i = ids.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    this.store.saveUi({ room_order: ids });
  }

  private _toggle(id: string) {
    const ui = this.store.ui;
    const list = ui.room_hidden[this.page] ?? [];
    const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
    this.store.saveUi({ room_hidden: { ...ui.room_hidden, [this.page]: next } });
  }

  override render() {
    const s = this.store;
    const rooms = s.orderedRooms();
    const hidden = new Set(s.ui.room_hidden[this.page] ?? []);
    return html`<hr-pop narrow heading=${t('arrange.title')} sub=${t('arrange.sub')} @close=${() => this.dispatchEvent(new CustomEvent('close'))}>
      <div class="rl-list">
        ${rooms.map(
          (r, i) => html`<div class="rl-item ${hidden.has(r.id) ? 'hid' : ''}">
            <span class="name">${r.name}${hidden.has(r.id) ? html` <span class="rl-chip">${t('arrange.hidden')}</span>` : nothing}</span>
            <span class="moves">
              <button class="icon-btn" ?disabled=${i === 0} aria-label=${t('arrange.up', { room: r.name })} @click=${() => this._move(r.id, -1)}>${icon(mdiChevronUp, 20)}</button>
              <button class="icon-btn" ?disabled=${i === rooms.length - 1} aria-label=${t('arrange.down', { room: r.name })} @click=${() => this._move(r.id, 1)}>${icon(mdiChevronDown, 20)}</button>
              <button class="icon-btn" aria-label=${hidden.has(r.id) ? t('arrange.show', { room: r.name }) : t('arrange.hide', { room: r.name })} title=${hidden.has(r.id) ? t('arrange.show', { room: r.name }) : t('arrange.hide', { room: r.name })} @click=${() => this._toggle(r.id)}>
                ${icon(hidden.has(r.id) ? mdiEyeOffOutline : mdiEyeOutline, 20)}
              </button>
            </span>
          </div>`,
        )}
      </div>
      <p class="rl-note">${t('arrange.note')}</p>
      <button slot="foot" class="btn primary" @click=${() => this.dispatchEvent(new CustomEvent('close'))}>${t('common.done')}</button>
    </hr-pop>`;
  }
}
customElements.define('hr-room-arrange', HrRoomArrange);

/** under a grid of room tiles: "1 Raum ausgeblendet (Keller) – seine Regeln bleiben erhalten. Räume anordnen" */
export function hiddenRoomsNote(s: Store, page: RoomPage, open: () => void): TemplateResult {
  const hid = s.hiddenRooms(page);
  return html`<div class="rl-hidden">
    <span>${hid.length ? tn('arrange.n_hidden', hid.length, { rooms: hid.map((r) => r.name).join(', ') }) : t('arrange.none_hidden')}</span>
    <button @click=${open}>${t('arrange.title')}</button>
  </div>`;
}
