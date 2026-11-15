/**
 * <hr-trash>: deleted rules of the last 30 days (Einstellungen → Papierkorb), "Zurückholen" for residents and
 * admins, "Endgültig löschen" for admins (house_rules/trash/list, trash/restore, trash/purge).
 */
import { css, html, nothing } from 'lit';
import { mdiDeleteForeverOutline, mdiDeleteOutline, mdiRestore } from '@mdi/js';
import { StoreElement } from '../base';
import { fire, icon, shared } from '../design/shared';
import type { TrashItem } from '../model';
import { when } from '../components/rule-history';
import { quote, t as tr } from '../i18n';
// i18n: complete

export class HrTrash extends StoreElement {
  static override properties = { ...StoreElement.properties, open: { type: Boolean }, _items: { state: true }, _error: { state: true }, _open: { state: true } };
  /** shows the list at once (inside the pop-up "Papierkorb" of the settings) instead of a button to open it */
  declare open: boolean;
  declare _items: TrashItem[] | null;
  declare _error: string;
  declare _open: boolean;

  constructor() {
    super();
    this._items = null;
    this._error = '';
    this._open = false;
    this.open = false;
  }

  protected override willUpdate(changed: Map<string, unknown>): void {
    super.willUpdate(changed);
    if (this.open && !this._open) {
      this._open = true;
      this._load();
    }
  }

  static override styles = [
    shared,
    css`
      :host {
        display: block;
      }
      .t {
        align-items: flex-start;
        padding-top: var(--hr-space-3);
        padding-bottom: var(--hr-space-3);
        flex-wrap: wrap;
      }
      .sentence {
        margin-top: 4px;
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
        font-style: italic;
      }
      .acts {
        display: flex;
        gap: var(--hr-space-2);
      }
      .err {
        color: var(--hr-red);
      }
    `,
  ];

  private async _load() {
    try {
      this._items = await this.store.trashList();
    } catch (e) {
      this._error = (e as Error).message;
    }
  }

  private async _restore(t: TrashItem) {
    try {
      await this.store.trashRestore(t.id);
      fire(this, 'hr-toast', tr('rel.back_toast', { name: quote(t.name) }));
    } catch (e) {
      this._error = (e as Error).message;
    }
    await this._load();
  }

  private async _purge(t?: TrashItem) {
    await this.store.trashPurge(t?.id);
    fire(this, 'hr-toast', t ? tr('rel.t_purged', { name: quote(t.name) }) : tr('rel.t_emptied'));
    await this._load();
  }

  override render() {
    const s = this.store;
    if (!this._open)
      return html`<div class="group">
        <button class="row" @click=${() => {
          this._open = true;
          this._load();
        }}>
          ${icon(mdiDeleteOutline, 22)}<span class="grow"><div class="title">${tr('rel.t_open')}</div><div class="sub">${tr('rel.t_open_sub')}</div></span>
        </button>
      </div>`;
    const items = this._items;
    return html`
      ${this._error ? html`<p class="err">${this._error}</p>` : nothing}
      ${items === null
        ? html`<p class="muted">${tr('rel.t_loading')}</p>`
        : !items.length
          ? html`<p class="lead">${tr('rel.t_empty')}</p>`
          : html`<div class="group">
                ${items.map(
                  (t) => html`<div class="row t">
                    <span class="grow">
                      <div class="title">${t.name}</div>
                      <div class="sub">
                        ${t.deleted_by_name
                          ? tr('rel.t_deleted_by', { at: when(t.deleted ?? ''), name: t.deleted_by_name, until: when(t.until ?? '') })
                          : tr('rel.t_deleted', { at: when(t.deleted ?? ''), until: when(t.until ?? '') })}
                      </div>
                      <div class="sentence">${t.sentence}</div>
                    </span>
                    <span class="acts">
                      ${s.canEdit ? html`<button class="btn small tinted" @click=${() => this._restore(t)}>${icon(mdiRestore, 16)}${tr('rel.t_restore')}</button>` : nothing}
                      ${s.admin ? html`<button class="btn small danger" aria-label=${tr('rel.t_purge')} title=${tr('rel.t_purge')} @click=${() => this._purge(t)}>${icon(mdiDeleteForeverOutline, 16)}</button>` : nothing}
                    </span>
                  </div>`,
                )}
              </div>
              ${s.admin ? html`<p style="margin-top:var(--hr-space-3)"><button class="btn small danger" @click=${() => this._purge()}>${tr('rel.t_empty_all')}</button></p>` : nothing}`}
    `;
  }
}
customElements.define('hr-trash', HrTrash);
