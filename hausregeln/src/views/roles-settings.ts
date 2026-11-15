/**
 * <hr-roles-settings>: who may do what in Hausregeln (Einstellungen → Rollen). Admin: everything. Bewohner:
 * rules and plans, the alarm with its confirmation, the house mode. Gast: see and use, change nothing.
 * Home Assistant admins are always admins. The server checks every command (house_rules/roles/get, roles/set).
 */
import { css, html, nothing } from 'lit';
import { mdiAccountOutline, mdiRobotOutline, mdiShieldAccountOutline } from '@mdi/js';
import { StoreElement } from '../base';
import { fire, icon, shared } from '../design/shared';
import type { AutomationUser, Role, RoleUser } from '../model';
import { t, type I18nKey } from '../i18n';
// i18n: complete

const ROLES: Role[] = ['admin', 'resident', 'guest'];
const label = (r: Role) => t(`rel.r_${r}` as I18nKey);

export class HrRolesSettings extends StoreElement {
  static override properties = { ...StoreElement.properties, _users: { state: true }, _auto: { state: true }, _error: { state: true } };
  declare _users: RoleUser[] | null;
  /** users that may be other automation systems (Node-RED …): what they switch is no person's change */
  declare _auto: AutomationUser[];
  declare _error: string;

  constructor() {
    super();
    this._users = null;
    this._auto = [];
    this._error = '';
  }

  static override styles = [
    shared,
    css`
      :host {
        display: block;
      }
      .row.wrap {
        flex-wrap: wrap;
      }
      .fixed {
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
      }
      dl {
        margin: var(--hr-space-3) 4px 0;
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
        line-height: 1.5;
      }
      dt {
        font-weight: 600;
        color: var(--hr-label);
      }
      dd {
        margin: 0 0 var(--hr-space-2);
      }
      .err {
        color: var(--hr-red);
      }
    `,
  ];

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.store.admin) this._load();
  }

  private async _load() {
    try {
      this._users = await this.store.rolesGet();
      this._auto = await this.store.automationUsersGet();
    } catch (e) {
      this._error = (e as Error).message;
    }
  }

  private async _set(u: RoleUser, role: Role) {
    try {
      await this.store.rolesSet(u.id, role);
      fire(this, 'hr-toast', t('rel.r_set', { name: u.name, role: label(role) }));
      await this._load();
    } catch (e) {
      this._error = (e as Error).message;
    }
  }

  /** only the choices that differ from the suggestion are stored: new users keep following it */
  private async _setAuto(u: AutomationUser, on: boolean) {
    const next = this._auto.map((x) => (x.id === u.id ? { ...x, automation: on } : x));
    try {
      await this.store.automationUsersSet(Object.fromEntries(next.filter((x) => x.automation !== x.suggested).map((x) => [x.id, x.automation])));
      this._auto = next;
      fire(this, 'hr-toast', t(on ? 'rel.au_on' : 'rel.au_off', { name: u.name || t('rel.r_no_name') }));
    } catch (e) {
      this._error = (e as Error).message;
    }
  }

  private _autoUsers() {
    if (!this._auto.length) return nothing;
    return html`<h3>${t('rel.au_title')}</h3>
      <p class="lead">${t('rel.au_lead')}</p>
      <div class="group">
        ${this._auto.map(
          (u) => html`<div class="row">
            ${icon(u.automation ? mdiRobotOutline : mdiAccountOutline, 22)}
            <span class="grow"
              ><div class="title">${u.name || t('rel.r_no_name')}</div>
              <div class="sub">${t(u.system ? 'rel.au_system' : u.suggested ? 'rel.au_suggested' : 'rel.au_person')}</div></span
            >
            <button class="switch" role="switch" aria-label=${t('rel.au_of', { name: u.name })} aria-checked=${u.automation ? 'true' : 'false'} @click=${() => this._setAuto(u, !u.automation)}></button>
          </div>`,
        )}
      </div>`;
  }

  override render() {
    const s = this.store;
    if (!s.admin) return html`<p class="lead">${t('rel.r_mine', { role: label(s.role) })}</p>`;
    // an admin here who is no Home Assistant admin sees the roles but cannot assign them (house_rules/roles/set)
    const canSet = s.haAdmin;
    return html`
      ${canSet ? nothing : html`<p class="muted">${t('rel.r_ha_only')}</p>`}
      ${this._error ? html`<p class="err">${this._error}</p>` : nothing}
      ${this._users === null
        ? html`<p class="muted">${t('rel.r_loading')}</p>`
        : html`<div class="group">
            ${this._users.map(
              (u) => html`<div class="row wrap">
                ${icon(u.ha_admin ? mdiShieldAccountOutline : mdiAccountOutline, 22)}
                <span class="grow"><div class="title">${u.name || t('rel.r_no_name')}</div>${u.fixed ? html`<div class="sub">${t('rel.r_fixed')}</div>` : nothing}</span>
                ${u.fixed
                  ? html`<span class="fixed">${label('admin')}</span>`
                  : html`<div class="seg" role="group" aria-label=${t('rel.r_of', { name: u.name })}>
                      ${ROLES.map((r) => html`<button aria-pressed=${u.role === r ? 'true' : 'false'} ?disabled=${!canSet} @click=${() => u.role !== r && this._set(u, r)}>${label(r)}</button>`)}
                    </div>`}
              </div>`,
            )}
          </div>`}
      <dl>
        ${ROLES.map((r) => html`<dt>${label(r)}</dt><dd>${t(`rel.r_${r}_text` as I18nKey)}</dd>`)}
      </dl>
      ${this._autoUsers()}
    `;
  }
}
customElements.define('hr-roles-settings', HrRolesSettings);
