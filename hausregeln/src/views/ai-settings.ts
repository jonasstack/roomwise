/**
 * <hr-ai-settings>: connect a language model (Ollama on an own server, or a cloud API with a key), shown in the pop-up
 * "KI-Anbindung" of the settings: provider, its fields (address, key), test, model, a preview of what is sent, then
 * "Verbinden" or "Ohne Sprachmodell sichern". The key is never shown again.
 */
import { css, html, nothing } from 'lit';
import { mdiCheck, mdiCheckCircle, mdiClose, mdiCloseCircle, mdiTextRecognition } from '@mdi/js';
import { StoreElement } from '../base';
import { icon, shared } from '../design/shared';
import { kit } from '../design/kit';
import { t, tn } from '../i18n';
// i18n: complete

export class HrAiSettings extends StoreElement {
  static override properties = {
    ...StoreElement.properties,
    _provider: { state: true },
    _url: { state: true },
    _key: { state: true },
    _model: { state: true },
    _models: { state: true },
    _result: { state: true },
    _busy: { state: true },
  };
  declare _provider: string;
  declare _url: string;
  declare _key: string;
  declare _model: string;
  declare _models: string[];
  declare _result: { ok: boolean; error?: string | null } | null;
  declare _busy: boolean;
  private _loaded = false;

  constructor() {
    super();
    this._provider = 'none';
    this._url = '';
    this._key = '';
    this._model = '';
    this._models = [];
    this._result = null;
    this._busy = false;
  }

  protected override willUpdate(changed: Map<string, unknown>): void {
    super.willUpdate(changed);
    const ai = this.store?.ai;
    if (ai && !this._loaded) {
      this._loaded = true;
      this._provider = ai.provider;
      this._url = ai.url;
      this._model = ai.model;
      this._models = ai.model ? [ai.model] : [];
    }
  }

  static override styles = [
    shared,
    kit,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-4);
      }
      label.f {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: var(--hr-text-footnote);
        font-weight: 600;
        color: var(--hr-label-2);
      }
      input,
      select {
        border: 0;
        border-radius: var(--hr-radius-s);
        background: var(--hr-fill);
        padding: 0 12px;
        min-height: var(--hr-hit);
        font-size: var(--hr-text-subhead);
        color: var(--hr-label);
      }
      .result {
        display: flex;
        align-items: center;
        gap: var(--hr-space-2);
        font-size: var(--hr-text-subhead);
      }
      .result.ok {
        color: color-mix(in srgb, var(--hr-green) 75%, var(--hr-label));
      }
      .result.no {
        color: var(--hr-red);
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--hr-space-2);
        justify-content: flex-end;
      }
      .send li {
        display: flex;
        gap: var(--hr-space-2);
        align-items: flex-start;
        font-size: var(--hr-text-footnote);
        line-height: 1.4;
        list-style: none;
      }
      .send ul {
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-2);
      }
      .send .yes .ic {
        color: var(--hr-green);
      }
      .send .no .ic {
        color: var(--hr-red);
      }
    `,
  ];

  private async _test() {
    this._busy = true;
    this._result = null;
    try {
      const res = await this.store.aiTest({ provider: this._provider, url: this._url, key: this._key || undefined });
      this._result = res;
      if (res.ok) {
        this._models = res.models;
        if (!res.models.includes(this._model)) this._model = res.models[0] ?? '';
      }
    } catch (e) {
      this._result = { ok: false, error: (e as Error).message };
    } finally {
      this._busy = false;
    }
  }

  private async _save() {
    await this.store.aiSet({ provider: this._provider, url: this._url, model: this._model, ...(this._key ? { key: this._key } : {}) });
    this._key = '';
    this.dispatchEvent(new CustomEvent('saved', { bubbles: true, composed: true }));
  }

  override render() {
    const ai = this.store.ai;
    if (!ai) return nothing;
    const spec = ai.providers[this._provider];
    const same = this._provider === ai.provider;
    const status = html`<div class="rl-now">
      <span class="rl-ic small">${icon(ai.provider !== 'none' ? mdiCheckCircle : mdiTextRecognition, 22)}</span>
      <span class="grow">
        ${ai.provider !== 'none'
          ? html`<b>${t('settings.ai_connected')} ${ai.providers[ai.provider]?.label}</b>
              <small>${ai.model ? html`${t('settings.ai_model_inline')} ${ai.model}` : nothing}${ai.status === 'error' ? html` · ${t('settings.ai_last_test_failed')}` : ai.status === 'ok' ? ' · ✓' : ''}</small>`
          : html`<b>${t('settings.ai_without')}</b><small>${t('settings.ai_without_sub')}</small>`}
      </span>
    </div>`;
    // the connection sends data to an address of choice with a key: only a Home Assistant admin sets it (ai/set, ai/test)
    if (!this.store.haAdmin) return html`${status}<p class="rl-note">${t('rel.ha_admin_only')}</p>`;
    const name = spec?.label ?? '';
    return html`
      ${status}
      <div class="rl-sec">
        <span class="eyebrow">${t('settings.ai_provider')}</span>
        <div class="rl-tg" role="radiogroup" aria-label=${t('settings.ai_provider')}>
          <button role="radio" aria-pressed=${this._provider === 'none' ? 'true' : 'false'} aria-checked=${this._provider === 'none' ? 'true' : 'false'} @click=${() => ((this._provider = 'none'), (this._result = null))}>${t('settings.ai_none')}</button>
          ${Object.entries(ai.providers).map(
            ([id, p]) => html`<button
              role="radio"
              aria-pressed=${this._provider === id ? 'true' : 'false'}
              aria-checked=${this._provider === id ? 'true' : 'false'}
              @click=${() => {
                this._provider = id;
                this._result = null;
                this._models = id === ai.provider && ai.model ? [ai.model] : [];
                this._model = id === ai.provider ? ai.model : '';
                this._url = id === ai.provider ? ai.url : p.url ?? '';
              }}
            >
              ${p.label}
            </button>`,
          )}
        </div>
      </div>
      ${spec
        ? html`<div class="rl-box">
              <small>${spec.hint}</small>
              ${spec.needs_url
                ? html`<label class="f">${t('settings.ai_address')}<input id="ai-url" .value=${this._url} placeholder=${spec.url ?? 'https://'} @input=${(e: Event) => (this._url = (e.target as HTMLInputElement).value)} /></label>`
                : nothing}
              ${spec.needs_key
                ? html`<label class="f"
                    >${t('settings.ai_key')}<input
                      id="ai-key"
                      type="password"
                      autocomplete="off"
                      .value=${this._key}
                      placeholder=${same && ai.has_key ? t('settings.ai_key_saved', { hint: ai.key_hint }) : t('settings.ai_key_paste')}
                      @input=${(e: Event) => (this._key = (e.target as HTMLInputElement).value)}
                  /></label>`
                : nothing}
              <div class="acts">
                <button class="btn small tinted" ?disabled=${this._busy} @click=${this._test}>${this._busy ? t('settings.ai_testing') : t('settings.ai_test')}</button>
              </div>
              ${this._result
                ? html`<div class="result ${this._result.ok ? 'ok' : 'no'}">
                    ${icon(this._result.ok ? mdiCheckCircle : mdiCloseCircle, 20)}${this._result.ok ? tn('settings.ai_models_found', this._models.length) : this._result.error}
                  </div>`
                : nothing}
              ${this._models.length
                ? html`<label class="f"
                    >${t('settings.ai_model')}<select id="ai-model" @change=${(e: Event) => (this._model = (e.target as HTMLSelectElement).value)}>
                      ${this._models.map((m) => html`<option value=${m} ?selected=${m === this._model}>${m}</option>`)}
                    </select></label
                  >`
                : nothing}
            </div>
            <div class="rl-sec send">
              <span class="eyebrow">${t('settings.ai_preview', { name })}</span>
              <div class="rl-box">
                <ul>
                  <li class="yes">${icon(mdiCheck, 18)}<span>${t('settings.ai_send_text')}</span></li>
                  <li class="yes">${icon(mdiCheck, 18)}<span>${t('settings.ai_send_review')}</span></li>
                  <li class="no">${icon(mdiClose, 18)}<span>${t('settings.ai_send_never')}</span></li>
                </ul>
              </div>
            </div>`
        : nothing}
      <p class="rl-note">${t('settings.ai_key_note')}</p>
      <div class="actions">
        ${this._provider !== 'none'
          ? html`<button
                class="btn"
                @click=${() => {
                  this._provider = 'none';
                  this._save();
                }}
              >
                ${t('settings.ai_save_none')}
              </button>
              <button class="btn primary" ?disabled=${!this._model || (this._result !== null && !this._result.ok)} @click=${this._save}>${t('settings.ai_connect')}</button>`
          : html`<button class="btn primary" @click=${this._save}>${t('settings.ai_save_none')}</button>`}
      </div>
    `;
  }
}
customElements.define('hr-ai-settings', HrAiSettings);
