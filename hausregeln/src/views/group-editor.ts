/**
 * <hr-group-editor>: the pop-up of an own group ("Gruppe") like "Heizung" or "Fernseher": name, icon, when it counts
 * as on, its devices. Fires "close" when done.
 */
import { css, html, nothing } from 'lit';
import { mdiCheckboxBlankOutline, mdiCheckboxMarked, mdiMagnify } from '@mdi/js';
import { StoreElement } from '../base';
import type { Group } from '../model';
import { icon, shared } from '../design/shared';
import { kit } from '../design/kit';
import '../components/pop';
import { KINDS } from '../vocabulary';
import { t } from '../i18n';
// i18n: complete

const ICONS = ['heating', 'tv', 'light', 'media', 'outlet', 'window', 'fan', 'vacuum', 'sofa', 'bed', 'desk', 'shield', 'group'];

export class HrGroupEditor extends StoreElement {
  static override properties = { ...StoreElement.properties, group: { attribute: false }, _g: { state: true }, _q: { state: true }, _confirm: { state: true } };
  declare group: Group | undefined;
  declare _g: Group;
  declare _q: string;
  declare _confirm: boolean;

  constructor() {
    super();
    this._q = '';
    this._confirm = false;
  }

  protected override willUpdate(changed: Map<string, unknown>): void {
    super.willUpdate(changed);
    if (changed.has('group') || !this._g) this._g = this.group ? structuredClone(this.group) : { id: '', name: '', icon: 'group', members: [], match: 'any' };
  }

  static override styles = [
    shared,
    kit,
    css`
      .name {
        border: 0;
        background: var(--hr-surface);
        border-radius: var(--hr-radius-m);
        box-shadow: var(--hr-shadow-1);
        outline: none;
        font-size: var(--hr-text-title3);
        font-weight: 700;
        padding: var(--hr-space-3) var(--hr-space-4);
        width: 100%;
      }
      .icons {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .icons button {
        width: 44px;
        height: 44px;
        border-radius: 12px;
        display: grid;
        place-items: center;
        background: var(--hr-surface);
        color: var(--hr-label-2);
      }
      .icons button[aria-pressed='true'] {
        background: var(--hr-accent);
        color: var(--hr-on-accent);
      }
      .search {
        display: flex;
        align-items: center;
        gap: var(--hr-space-2);
        background: var(--hr-surface);
        box-shadow: var(--hr-shadow-1);
        border-radius: var(--hr-radius-m);
        padding: 0 var(--hr-space-3);
        color: var(--hr-label-2);
      }
      .search input {
        flex: 1;
        border: 0;
        background: none;
        outline: none;
        min-height: 44px;
        font-size: var(--hr-text-body);
        color: var(--hr-label);
      }
      .rl-item .box {
        color: var(--hr-label-3);
        display: flex;
      }
      .rl-item .box.on {
        color: var(--hr-accent);
      }
      .sp {
        flex: 1;
      }
    `,
  ];

  private _set(patch: Partial<Group>) {
    this._g = { ...this._g, ...patch };
  }

  private async _save() {
    if (!this._g.name.trim()) return;
    await this.store.saveGroup(this._g);
    this.dispatchEvent(new CustomEvent('close'));
  }

  override render() {
    const s = this.store;
    const g = this._g;
    const q = this._q.trim().toLowerCase();
    const devs = s.devices.filter((d) => d.kind !== 'zone' && (q || !g.members.includes(d.entity_id)) && (!q || `${d.name} ${KINDS[d.kind]?.label} ${s.room(d.room)?.name ?? ''}`.toLowerCase().includes(q)));
    const rooms = [...s.rooms.map((r) => ({ id: r.id as string | undefined, name: r.name })), { id: undefined, name: t('devices.no_room') }];
    const toggle = (id: string) => this._set({ members: g.members.includes(id) ? g.members.filter((x) => x !== id) : [...g.members, id] });
    const close = () => this.dispatchEvent(new CustomEvent('close'));
    const item = (id: string, on: boolean, title: string, sub: string) => html`<button class="rl-item" @click=${() => toggle(id)} aria-pressed=${on ? 'true' : 'false'}>
      <span class="box ${on ? 'on' : ''}">${icon(on ? mdiCheckboxMarked : mdiCheckboxBlankOutline, 24)}</span>
      <span class="grow"><b>${title}</b><small>${sub}</small></span>
    </button>`;
    return html`<hr-pop heading=${this.group ? t('devices.group_title', { name: this.group.name }) : t('devices.new_group')} .sub=${t('devices.group_sub')} @close=${close}>
      <input id="group-name" class="name" placeholder=${t('devices.group_name')} .value=${g.name} @input=${(e: Event) => this._set({ name: (e.target as HTMLInputElement).value })} />
      <div class="rl-sec">
        <span class="eyebrow">${t('devices.icon')}</span>
        <div class="icons" role="group" aria-label=${t('devices.icon')}>
          ${ICONS.map((ic) => html`<button aria-pressed=${g.icon === ic ? 'true' : 'false'} @click=${() => this._set({ icon: ic })}>${icon(ic, 22)}</button>`)}
        </div>
      </div>
      <div class="rl-box">
        <div class="line">
          <span class="grow"><b>${t('devices.on_when')}</b><small>${t('devices.on_when_help')}</small></span>
          <div class="seg">
            <button aria-pressed=${g.match === 'any' ? 'true' : 'false'} @click=${() => this._set({ match: 'any' })}>${t('devices.match_any')}</button>
            <button aria-pressed=${g.match === 'all' ? 'true' : 'false'} @click=${() => this._set({ match: 'all' })}>${t('devices.match_all')}</button>
          </div>
        </div>
      </div>
      ${g.members.length && !q
        ? html`<div class="rl-sec">
            <span class="eyebrow">${t('devices.in_group')} · ${g.members.length}</span>
            <div class="rl-list">
              ${g.members.map((id) => {
                const d = s.device(id);
                return item(id, true, d?.name ?? id, d ? `${KINDS[d.kind]?.label}${d.room ? ` · ${s.room(d.room)?.name}` : ''}` : t('devices.gone'));
              })}
            </div>
          </div>`
        : nothing}
      <div class="rl-sec">
        <span class="eyebrow">${t('devices.add_to_group')}</span>
        <label class="search">${icon(mdiMagnify, 18)}<input id="group-search" placeholder=${t('devices.search')} .value=${this._q} @input=${(e: Event) => (this._q = (e.target as HTMLInputElement).value)} /></label>
      </div>
      ${rooms.map((r) => {
        const list = devs.filter((d) => d.room === r.id);
        return list.length
          ? html`<div class="rl-sec">
              <h3>${r.name}</h3>
              <div class="rl-list">${list.map((d) => item(d.entity_id, g.members.includes(d.entity_id), d.name, `${KINDS[d.kind]?.label}${d.detail ? ` · ${d.detail}` : ''}`))}</div>
            </div>`
          : nothing;
      })}
      ${this.group
        ? this._confirm
          ? html`<span slot="foot" class="muted">${t('devices.really_delete')}</span>
              <button slot="foot" class="btn small" @click=${() => (this._confirm = false)}>${t('common.no')}</button>
              <button slot="foot" class="btn small danger" @click=${() => s.deleteGroup(g.id).then(close)}>${t('common.delete')}</button>`
          : html`<button slot="foot" class="btn danger" @click=${() => (this._confirm = true)}>${t('devices.delete_group')}</button>`
        : nothing}
      <span slot="foot" class="sp"></span>
      <span slot="foot" class="muted">${t('devices.n_devices', { n: g.members.length })}</span>
      <button slot="foot" class="btn" @click=${close}>${t('common.cancel')}</button>
      <button slot="foot" class="btn primary" ?disabled=${!g.name.trim() || !g.members.length} @click=${this._save}>${t('common.save')}</button>
    </hr-pop>`;
  }
}
customElements.define('hr-group-editor', HrGroupEditor);
