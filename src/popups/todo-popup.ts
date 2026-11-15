import { css, html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { PopupBase } from './popup-base';
import { t } from '../i18n';

interface TodoItem {
  uid: string;
  summary: string;
  status: 'needs_action' | 'completed';
  due?: string;
  description?: string;
}

// TodoListEntityFeature bits
const F = { CREATE: 1, DELETE: 2, UPDATE: 4 };

/** Shopping list / to-do popup with live updates (todo/item/subscribe). */
export class FpTodoPopup extends PopupBase {
  static override properties = { ...PopupBase.properties, _items: { state: true }, _showDone: { state: true }, _text: { state: true } };
  declare _items?: TodoItem[];
  declare _showDone: boolean;
  declare _text: string;
  private unsub?: Promise<() => void>;
  private subscribedTo?: string;

  constructor() {
    super();
    this._showDone = false;
    this._text = '';
  }

  override updated() {
    if (this.ctx && this.entityId && this.subscribedTo !== this.entityId) this.subscribe();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubscribe();
  }

  private subscribe() {
    this.unsubscribe();
    this.subscribedTo = this.entityId;
    this.unsub = this.hass.connection.subscribeMessage<{ items: TodoItem[] }>((msg) => (this._items = msg.items), {
      type: 'todo/item/subscribe',
      entity_id: this.entityId,
    });
    this.unsub.catch((err) => {
      console.warn('[floorplan-card] todo subscribe failed', err);
      this._items = [];
    });
  }

  private unsubscribe() {
    this.unsub?.then((fn) => fn()).catch(() => undefined);
    this.unsub = undefined;
    this.subscribedTo = undefined;
  }

  private supports(bit: number) {
    return ((this.stateObj?.attributes.supported_features ?? 0) & bit) !== 0;
  }

  private add(e?: Event) {
    e?.preventDefault();
    const text = this._text.trim();
    if (!text) return;
    this._text = '';
    const tmp: TodoItem = { uid: `tmp_${Date.now()}`, summary: text, status: 'needs_action' };
    this._items = [...(this._items ?? []), tmp];
    this.safe(async () => {
      try {
        await this.hass.callService('todo', 'add_item', { item: text }, { entity_id: this.entityId });
      } catch (err) {
        this._items = this._items?.filter((i) => i !== tmp);
        throw err;
      }
    });
  }

  private setStatus(item: TodoItem, done: boolean) {
    const prev = this._items;
    const status = done ? 'completed' : 'needs_action';
    this._items = prev?.map((i) => (i.uid === item.uid ? { ...i, status } : i));
    this.safe(async () => {
      try {
        await this.hass.callService('todo', 'update_item', { item: item.uid, status }, { entity_id: this.entityId });
      } catch (err) {
        this._items = prev;
        throw err;
      }
    });
  }

  private removeItem(item: TodoItem) {
    const prev = this._items;
    this._items = prev?.filter((i) => i.uid !== item.uid);
    this.safe(async () => {
      try {
        await this.hass.callService('todo', 'remove_item', { item: item.uid }, { entity_id: this.entityId });
      } catch (err) {
        this._items = prev;
        throw err;
      }
    });
  }

  private clearDone() {
    const prev = this._items;
    this._items = prev?.filter((i) => i.status !== 'completed');
    this.safe(async () => {
      try {
        await this.hass.callService('todo', 'remove_completed_items', {}, { entity_id: this.entityId });
      } catch (err) {
        this._items = prev;
        throw err;
      }
    });
  }

  override render() {
    const items = this._items;
    const open = items?.filter((i) => i.status === 'needs_action') ?? [];
    const done = items?.filter((i) => i.status === 'completed') ?? [];
    const canEdit = this.supports(F.UPDATE);
    return html`
      ${this.renderHeader({
        icon: html`<ha-icon icon="mdi:cart-outline"></ha-icon>`,
        subtitle: items ? t('todo.open', { n: open.length }) : '…',
      })}
      ${this.supports(F.CREATE)
        ? html`<form class="add" @submit=${this.add}>
            <input
              class="field"
              .value=${this._text}
              placeholder=${t('todo.add_placeholder')}
              enterkeyhint="done"
              @input=${(e: InputEvent) => (this._text = (e.target as HTMLInputElement).value)}
            />
            <button class="icon-btn accent pressable" type="submit" aria-label=${t('common.add')} ?disabled=${!this._text.trim()}>
              <ha-icon icon="mdi:plus"></ha-icon>
            </button>
          </form>`
        : nothing}
      <div class="group list">
        ${items && !open.length ? html`<div class="row empty">${t('todo.empty')}</div>` : nothing}
        ${repeat(open, (i) => i.uid, (i) => this.renderItem(i, canEdit))}
      </div>
      ${done.length
        ? html`<div class="done-head">
              <button class="btn plain pressable" @click=${() => (this._showDone = !this._showDone)}>
                <ha-icon icon=${this._showDone ? 'mdi:chevron-down' : 'mdi:chevron-right'}></ha-icon>
                ${t('todo.completed')} (${done.length})
              </button>
              ${this.supports(F.DELETE)
                ? html`<button class="btn plain pressable danger-text" @click=${this.clearDone}>${t('todo.clear_completed')}</button>`
                : nothing}
            </div>
            ${this._showDone ? html`<div class="group list">${repeat(done, (i) => i.uid, (i) => this.renderItem(i, canEdit))}</div>` : nothing}`
        : nothing}
    `;
  }

  private renderItem(i: TodoItem, canEdit: boolean) {
    const done = i.status === 'completed';
    return html`<div class="row item ${done ? 'done' : ''}">
      <button
        class="check pressable"
        role="checkbox"
        aria-checked=${done ? 'true' : 'false'}
        aria-label=${i.summary}
        ?disabled=${!canEdit}
        @click=${() => this.setStatus(i, !done)}
      >
        <span class="ring"><ha-icon icon="mdi:check"></ha-icon></span>
      </button>
      <div class="grow">
        <div class="title">${i.summary}</div>
        ${i.description ? html`<div class="subtitle">${i.description}</div>` : nothing}
      </div>
      ${this.supports(F.DELETE)
        ? html`<button class="icon-btn plain pressable del" aria-label=${t('common.delete')} @click=${() => this.removeItem(i)}>
            <ha-icon icon="mdi:close"></ha-icon>
          </button>`
        : nothing}
    </div>`;
  }

  static override styles = [
    ...PopupBase.styles,
    css`
      .add {
        display: flex;
        gap: var(--fp-space-2);
        margin-bottom: var(--fp-space-4);
      }
      .add .field {
        background: var(--fp-surface);
      }
      .list {
        max-height: 46vh;
        overflow: auto;
      }
      .row.item {
        padding-left: var(--fp-space-1);
        min-height: 56px;
      }
      .row.item + .row.item::before {
        left: 56px;
      }
      .row.empty {
        justify-content: center;
        color: var(--fp-label-2);
        min-height: 72px;
      }
      .check {
        width: var(--fp-hit);
        height: var(--fp-hit);
        display: flex;
        align-items: center;
        justify-content: center;
        flex: none;
      }
      .ring {
        width: 26px;
        height: 26px;
        border-radius: 50%;
        box-shadow: inset 0 0 0 2px var(--fp-label-3);
        display: flex;
        align-items: center;
        justify-content: center;
        position: relative;
        overflow: hidden;
      }
      .ring::before {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: 50%;
        background: var(--fp-accent);
        transform: scale(0);
        transition: transform var(--fp-dur) var(--fp-ease);
      }
      .ring ha-icon {
        position: relative;
        --mdc-icon-size: 18px;
        color: var(--fp-on-accent);
        opacity: 0;
        transition: opacity var(--fp-dur) var(--fp-ease);
      }
      .done .ring::before {
        transform: scale(1);
      }
      .done .ring ha-icon {
        opacity: 1;
      }
      .done .title {
        color: var(--fp-label-2);
        text-decoration: line-through;
        text-decoration-color: var(--fp-label-3);
      }
      .del {
        color: var(--fp-label-3);
      }
      .del ha-icon {
        --mdc-icon-size: 18px;
      }
      .done-head {
        display: flex;
        justify-content: space-between;
        margin: var(--fp-space-3) calc(var(--fp-space-3) * -1) var(--fp-space-2);
      }
      .danger-text {
        color: var(--fp-red);
      }
    `,
  ];
}

if (!customElements.get('fp-todo-popup')) customElements.define('fp-todo-popup', FpTodoPopup);
