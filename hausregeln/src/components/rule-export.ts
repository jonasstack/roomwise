/**
 * <hr-rule-export>: a rule as a Home Assistant automation (house_rules/rule/export). Shows what could not be
 * carried over, the YAML to copy or download, and for Home Assistant admins "In Home Assistant anlegen" (its
 * automation config API); the rule is then switched off here, not deleted. Fires "close" and "created".
 */
import { css, html, nothing } from 'lit';
import { mdiAlertOutline, mdiCheckCircleOutline, mdiContentCopy, mdiDownload, mdiHomeAutomation } from '@mdi/js';
import { StoreElement } from '../base';
import { fire, icon, shared } from '../design/shared';
import type { Rule, RuleExport } from '../model';
import { t } from '../i18n';
// i18n: complete

export class HrRuleExport extends StoreElement {
  static override properties = { ...StoreElement.properties, rule: { attribute: false }, _exp: { state: true }, _error: { state: true }, _confirm: { state: true }, _busy: { state: true } };
  declare rule: Rule;
  declare _exp: RuleExport | null;
  declare _error: string;
  declare _confirm: boolean;
  declare _busy: boolean;

  constructor() {
    super();
    this._exp = null;
    this._error = '';
    this._confirm = false;
    this._busy = false;
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
      .notes {
        padding: var(--hr-space-3) var(--hr-space-4);
        border-radius: var(--hr-radius-m);
        background: color-mix(in srgb, var(--hr-orange) 14%, transparent);
        font-size: var(--hr-text-footnote);
        line-height: 1.5;
      }
      .notes.ok {
        background: color-mix(in srgb, var(--hr-green) 14%, transparent);
      }
      .notes b {
        display: flex;
        align-items: center;
        gap: var(--hr-space-2);
        margin-bottom: 4px;
      }
      .notes ul {
        margin: 0;
        padding-left: 20px;
      }
      pre {
        margin: 0;
        max-height: 46vh;
        overflow: auto;
        padding: var(--hr-space-3);
        border-radius: var(--hr-radius-m);
        background: var(--hr-fill);
        font-size: 12px;
        line-height: 1.45;
        white-space: pre;
        user-select: text;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--hr-space-2);
      }
      .err {
        color: var(--hr-red);
      }
    `,
  ];

  override connectedCallback(): void {
    super.connectedCallback();
    this.store
      .exportRule(this.rule)
      .then((e) => (this._exp = e))
      .catch((e) => (this._error = (e as Error).message));
  }

  private async _copy() {
    try {
      await navigator.clipboard.writeText(this._exp!.yaml);
      fire(this, 'hr-toast', t('rel.x_copied'));
    } catch {
      // older browsers / no secure context: select the text so it can be copied by hand
      const sel = window.getSelection();
      const pre = this.renderRoot.querySelector('pre');
      if (sel && pre) sel.selectAllChildren(pre);
      fire(this, 'hr-toast', t('rel.x_copy_failed'));
    }
  }

  private _download() {
    const blob = new Blob([this._exp!.yaml], { type: 'text/yaml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${this._exp!.id}.yaml`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  private async _create() {
    this._busy = true;
    try {
      await this.store.createAutomation(this.rule.id, this._exp!);
      fire(this, 'hr-toast', t('rel.x_created'));
      fire(this, 'created');
    } catch (e) {
      this._error = (e as Error).message;
    }
    this._busy = false;
    this._confirm = false;
  }

  override render() {
    const exp = this._exp;
    const saved = !!this.store.rule(this.rule.id);
    return html`
      <h2>${icon(mdiHomeAutomation, 22)}${t('rel.x_title')}</h2>
      <p class="lead">${t('rel.x_lead')}</p>
      ${this._error ? html`<p class="err">${this._error}</p>` : nothing}
      ${!exp && !this._error ? html`<p class="muted">${t('rel.x_busy')}</p>` : nothing}
      ${exp
        ? html`
            <div class="notes ${exp.notes.length ? '' : 'ok'}">
              ${exp.notes.length
                ? html`<b>${icon(mdiAlertOutline, 18)}${t('rel.x_check')}</b>
                    <ul>
                      ${exp.notes.map((n) => html`<li>${n}</li>`)}
                    </ul>`
                : html`<b>${icon(mdiCheckCircleOutline, 18)}${t('rel.x_all_ok')}</b>`}
            </div>
            <pre>${exp.yaml}</pre>
            <div class="actions">
              <button class="btn tinted" @click=${this._copy}>${icon(mdiContentCopy, 18)}${t('rel.x_copy')}</button>
              <button class="btn tinted" @click=${this._download}>${icon(mdiDownload, 18)}${t('rel.x_download')}</button>
              <span style="flex:1"></span>
              <button class="btn" @click=${() => fire(this, 'close')}>${t('common.close')}</button>
            </div>
            ${saved && this.store.haAdmin && !this.store.demo
              ? this._confirm
                ? html`<div class="card" style="padding:var(--hr-space-4)">
                    <p>${exp.complete
                      ? t('rel.x_confirm_complete')
                      : t('rel.x_confirm_partial')}</p>
                    <div class="actions" style="margin-top:var(--hr-space-3)">
                      <button class="btn" @click=${() => (this._confirm = false)}>${t('common.cancel')}</button>
                      <button class="btn primary" ?disabled=${this._busy} @click=${this._create}>${this._busy ? t('rel.x_creating') : t('rel.x_confirm')}</button>
                    </div>
                  </div>`
                : html`<div><button class="btn primary" ?disabled=${!exp.automation || !(exp.automation.triggers as unknown[] | undefined)?.length} @click=${() => (this._confirm = true)}>${icon(mdiHomeAutomation, 18)}${t('rel.x_create')}</button></div>`
              : nothing}
          `
        : nothing}
    `;
  }
}
customElements.define('hr-rule-export', HrRuleExport);
