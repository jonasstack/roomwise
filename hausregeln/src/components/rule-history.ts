/**
 * <hr-rule-history>: the saved versions of one rule (who, when, what changed, the rule as a sentence) with
 * "Wiederherstellen" for earlier ones (house_rules/rule/versions, rule/restore_version). Fires "close".
 */
import { css, html, nothing } from 'lit';
import { mdiHistory, mdiRestore } from '@mdi/js';
import { StoreElement } from '../base';
import { fire, icon, shared } from '../design/shared';
import type { RuleVersion } from '../model';
import { fmtDate, t } from '../i18n';
// i18n: complete

export const when = (iso: string) => (iso ? fmtDate(iso, { dateStyle: 'medium', timeStyle: 'short' }) : '');

export class HrRuleHistory extends StoreElement {
  static override properties = { ...StoreElement.properties, ruleId: {}, _list: { state: true }, _busy: { state: true }, _error: { state: true } };
  declare ruleId: string;
  declare _list: RuleVersion[] | null;
  declare _busy: string;
  declare _error: string;

  constructor() {
    super();
    this._list = null;
    this._busy = '';
    this._error = '';
  }

  static override styles = [

    shared,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-4);
        padding: var(--hr-space-5);
      }
      h2 {
        display: flex;
        align-items: center;
        gap: var(--hr-space-2);
        font-size: var(--hr-text-title3);
      }
      .v {
        align-items: flex-start;
        padding-top: var(--hr-space-3);
        padding-bottom: var(--hr-space-3);
      }
      .v .when {
        font-weight: 600;
      }
      .v .sentence {
        margin-top: 4px;
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
        font-style: italic;
      }
      .now {
        font-size: var(--hr-text-caption);
        color: var(--hr-accent);
        font-weight: 600;
        white-space: nowrap;
      }
      .err {
        color: var(--hr-red);
      }
    `,
  ];

  override connectedCallback(): void {
    super.connectedCallback();
    this._load();
  }

  private async _load() {
    try {
      this._list = await this.store.ruleVersions(this.ruleId);
    } catch (e) {
      this._error = (e as Error).message;
      this._list = [];
    }
  }

  private async _restore(v: RuleVersion) {
    this._busy = v.id;
    try {
      await this.store.restoreVersion(this.ruleId, v.id);
      fire(this, 'hr-toast', t('rel.h_restored'));
      fire(this, 'restored');
      await this._load();
    } catch (e) {
      this._error = (e as Error).message;
    }
    this._busy = '';
  }

  override render() {
    const list = this._list;
    return html`
      <h2>${icon(mdiHistory, 22)}${t('rel.h_title')}</h2>
      <p class="lead">${t('rel.h_lead')}</p>
      ${this._error ? html`<p class="err">${this._error}</p>` : nothing}
      ${list === null
        ? html`<p class="muted">${t('rel.h_loading')}</p>`
        : !list.length
          ? html`<p class="muted">${t('rel.h_empty')}</p>`
          : html`<div class="group">
              ${list.map(
                (v) => html`<div class="row v">
                  <span class="grow">
                    <div class="when">${when(v.at) || t('rel.h_unknown_time')}${v.by_name ? html` · ${v.by_name}` : nothing}</div>
                    <div class="sub">${v.summary}</div>
                    <div class="sentence">${v.sentence}</div>
                  </span>
                  ${v.current
                    ? html`<span class="now">${t('rel.h_current')}</span>`
                    : this.store.canEdit
                      ? html`<button class="btn small tinted" ?disabled=${!!this._busy} @click=${() => this._restore(v)}>${icon(mdiRestore, 16)}${this._busy === v.id ? t('rel.h_restoring') : t('rel.h_restore')}</button>`
                      : nothing}
                </div>`,
              )}
            </div>`}
      <div><button class="btn" @click=${() => fire(this, 'close')}>${t('common.close')}</button></div>
    `;
  }
}
customElements.define('hr-rule-history', HrRuleHistory);
