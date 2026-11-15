import { LitElement, css, html, nothing } from 'lit';
import { components } from '../design/components';
import type { ActionConfig, ActionType, HomeAssistant } from '../types';
import { t, type I18nKey } from '../i18n';

const TYPES: Record<string, ActionType[]> = {
  room: ['default', 'toggle-lights', 'zoom', 'popup', 'more-info', 'perform-action', 'navigate', 'url', 'none'],
  device: ['default', 'popup', 'toggle', 'zoom', 'more-info', 'perform-action', 'navigate', 'url', 'none'],
  opening: ['default', 'more-info', 'perform-action', 'navigate', 'url', 'none'],
};

/** Compact editor for one action (tap / double tap / hold). */
export class FpActionEditor extends LitElement {
  static override properties = {
    hass: { attribute: false },
    value: { attribute: false },
    kind: { type: String },
    label: { type: String },
    fallback: { attribute: false },
    _dataError: { state: true },
  };
  declare hass: HomeAssistant;
  declare value?: ActionConfig;
  declare kind: 'room' | 'device' | 'opening';
  declare label: string;
  /** What "Standard" does here (shown in the option) */
  declare fallback?: ActionType;
  declare _dataError?: boolean;

  private emit(v: ActionConfig | undefined) {
    this.dispatchEvent(new CustomEvent('value-change', { detail: { value: v }, bubbles: true, composed: true }));
  }

  private patch(p: Partial<ActionConfig>) {
    const cur: ActionConfig = { ...(this.value ?? { action: 'default' }), ...p };
    for (const k of Object.keys(cur) as (keyof ActionConfig)[]) if (cur[k] === '' || cur[k] === undefined) delete cur[k];
    this.emit(cur.action === 'default' && Object.keys(cur).length === 1 ? undefined : cur);
  }

  override render() {
    const v = this.value ?? { action: 'default' as ActionType };
    const types = TYPES[this.kind] ?? TYPES.device;
    const services = Object.entries((this.hass as any).services ?? {}).flatMap(([d, s]: [string, any]) => Object.keys(s).map((x) => `${d}.${x}`));
    return html`
      <div class="row-main">
        <span class="lbl">${this.label}</span>
        <select class="field sel" .value=${v.action} @change=${(e: any) => this.emit(e.target.value === 'default' ? undefined : { action: e.target.value })}>
          ${types.map(
            (ty) =>
              html`<option value=${ty} ?selected=${ty === v.action}>
                ${ty === 'default' && this.fallback && this.fallback !== 'default' ? t('action.default_is', { a: t(`action.${this.fallback}` as I18nKey) }) : t(`action.${ty}` as I18nKey)}
              </option>`,
          )}
        </select>
      </div>
      ${v.action === 'perform-action' || v.action === 'call-service'
        ? html`<input
              class="field"
              list="fp-services"
              placeholder=${t('action.service')}
              .value=${v.perform_action ?? v.service ?? ''}
              @change=${(e: any) => this.patch({ perform_action: e.target.value, service: undefined })}
            />
            <datalist id="fp-services">${services.slice(0, 2000).map((s) => html`<option value=${s}></option>`)}</datalist>
            <textarea
              class="field area ${this._dataError ? 'err' : ''}"
              placeholder=${t('action.data') + ' {"brightness_pct": 50}'}
              .value=${v.data ? JSON.stringify(v.data) : ''}
              @change=${(e: any) => {
                const txt = e.target.value.trim();
                if (!txt) return this.patch({ data: undefined });
                try {
                  this._dataError = false;
                  this.patch({ data: JSON.parse(txt) });
                } catch {
                  this._dataError = true;
                }
              }}
            ></textarea>`
        : nothing}
      ${['popup', 'toggle', 'more-info', 'perform-action', 'toggle-lights'].includes(v.action)
        ? html`<input
            class="field"
            list="fp-entities"
            placeholder=${t('action.entity')}
            .value=${v.entity ?? ''}
            @change=${(e: any) => this.patch({ entity: e.target.value })}
          />
          <datalist id="fp-entities">${Object.keys(this.hass.states).map((id) => html`<option value=${id}></option>`)}</datalist>`
        : nothing}
      ${v.action === 'navigate'
        ? html`<input class="field" placeholder=${t('action.path')} .value=${v.navigation_path ?? ''} @change=${(e: any) => this.patch({ navigation_path: e.target.value })} />`
        : nothing}
      ${v.action === 'url'
        ? html`<input class="field" placeholder=${t('action.url_label')} .value=${v.url_path ?? ''} @change=${(e: any) => this.patch({ url_path: e.target.value })} />`
        : nothing}
      ${!['default', 'none', 'popup', 'more-info'].includes(v.action)
        ? html`<label class="confirm">
            <input type="checkbox" .checked=${!!v.confirmation} @change=${(e: any) => this.patch({ confirmation: e.target.checked || undefined })} />
            ${t('action.confirm')}
          </label>`
        : nothing}
    `;
  }

  static override styles = [
    components,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--fp-space-2);
        padding: var(--fp-space-3) var(--fp-space-4);
      }
      :host(:not(:first-child)) {
        border-top: 1px solid var(--fp-separator);
      }
      .row-main {
        display: flex;
        align-items: center;
        gap: var(--fp-space-3);
      }
      .lbl {
        flex: none;
        white-space: nowrap;
        font-size: var(--fp-text-body);
      }
      .sel {
        flex: 1;
        min-width: 0;
        width: auto;
        text-overflow: ellipsis;
        background: transparent;
        color: var(--fp-accent);
        text-align: right;
        padding-right: 0;
        appearance: none;
        -webkit-appearance: none;
        font-size: var(--fp-text-subhead);
        cursor: pointer;
      }
      .field {
        background: var(--fp-fill);
        font-size: var(--fp-text-subhead);
      }
      .area {
        min-height: 64px;
        padding-top: var(--fp-space-3);
        font-family: ui-monospace, Menlo, monospace;
        font-size: var(--fp-text-footnote);
        resize: vertical;
      }
      .err {
        box-shadow: inset 0 0 0 2px var(--fp-red);
      }
      .confirm {
        display: flex;
        align-items: center;
        gap: var(--fp-space-2);
        min-height: var(--fp-hit);
        font-size: var(--fp-text-subhead);
      }
    `,
  ];
}

if (!customElements.get('fp-action-editor')) customElements.define('fp-action-editor', FpActionEditor);
