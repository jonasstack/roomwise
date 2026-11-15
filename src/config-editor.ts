import { LitElement, css, html } from 'lit';
import { tokens } from './design/tokens';
import { components } from './design/components';
import type { FloorplanCardConfig, HomeAssistant } from './types';
import { fireEvent } from './ha';
import { setLanguage, t } from './i18n';

/**
 * Small form for HA's card editor dialog. Drawing happens in the in-card editor (pencil button),
 * which is touch-friendly and full screen; this form covers the card-level options.
 */
export class FloorplanCardConfigEditor extends LitElement {
  static override properties = { hass: { attribute: false }, _config: { state: true } };
  declare hass: HomeAssistant;
  declare _config?: FloorplanCardConfig;

  setConfig(config: FloorplanCardConfig) {
    this._config = config;
  }

  private set(key: keyof FloorplanCardConfig, value: unknown) {
    if (!this._config) return;
    const cfg: any = { ...this._config };
    if (value === '' || value === undefined) delete cfg[key];
    else cfg[key] = value;
    this._config = cfg;
    fireEvent(this, 'config-changed', { config: cfg });
  }

  override willUpdate() {
    if (this.hass) setLanguage(this.hass.locale?.language ?? this.hass.language);
  }

  override render() {
    if (!this._config) return html``;
    const c = this._config;
    const rooms = c.floors?.reduce((n, f) => n + (f.rooms?.length ?? 0), 0) ?? 0;
    const devices = c.floors?.reduce((n, f) => n + (f.devices?.length ?? 0) + (f.furniture?.filter((x) => x.entity).length ?? 0), 0) ?? 0;
    return html`
      <div class="note">
        <ha-icon icon="mdi:floor-plan"></ha-icon>
        <div>
          <b>${t('editor.cfg_summary', { f: c.floors?.length ?? 0, r: rooms, d: devices })}</b><br />
          ${t('editor.cfg_note')}
        </div>
      </div>
      <label>${t('editor.cfg_title')}<input class="field" .value=${c.title ?? ''} @change=${(e: any) => this.set('title', e.target.value.trim())} /></label>
      <label
        >${t('editor.cfg_height')}<input
          class="field"
          placeholder="calc(100vh - 56px)"
          .value=${c.height ?? ''}
          @change=${(e: any) => this.set('height', e.target.value.trim())}
        />
        <span class="hint">${t('editor.cfg_height_hint')}</span></label
      >
      <label
        >${t('editor.cfg_theme')}
        <select class="field" @change=${(e: any) => this.set('theme', e.target.value === 'auto' ? undefined : e.target.value)}>
          <option value="auto" ?selected=${!c.theme || c.theme === 'auto'}>${t('editor.cfg_theme_auto')}</option>
          <option value="light" ?selected=${c.theme === 'light'}>${t('editor.cfg_theme_light')}</option>
          <option value="dark" ?selected=${c.theme === 'dark'}>${t('editor.cfg_theme_dark')}</option>
        </select>
      </label>
      <label class="row-l"
        ><input type="checkbox" .checked=${c.editable !== false} @change=${(e: any) => this.set('editable', e.target.checked ? undefined : false)} />
        ${t('editor.cfg_editable')}</label
      >
    `;
  }

  static override styles = [
    tokens,
    components,
    css`
      :host {
        display: grid;
        gap: var(--fp-space-4);
        font-family: var(--fp-font);
        color: var(--primary-text-color, var(--fp-label));
      }
      .note {
        display: flex;
        gap: var(--fp-space-3);
        padding: var(--fp-space-4);
        border-radius: var(--fp-radius-m);
        background: var(--fp-fill);
        font-size: var(--fp-text-subhead);
        line-height: 1.4;
      }
      label {
        display: grid;
        gap: var(--fp-space-2);
        font-size: var(--fp-text-footnote);
        font-weight: var(--fp-weight-semibold);
        color: var(--secondary-text-color, var(--fp-label-2));
      }
      .hint {
        font-weight: normal;
        color: var(--secondary-text-color, var(--fp-label-2));
      }
      .row-l input {
        width: 22px;
        height: 22px;
        margin: 0 var(--fp-space-3) 0 0;
      }
      .row-l {
        display: flex;
        align-items: center;
        min-height: var(--fp-hit);
      }
      .field {
        color: var(--primary-text-color, var(--fp-label));
      }
    `,
  ];
}

if (!customElements.get('floorplan-card-editor')) customElements.define('floorplan-card-editor', FloorplanCardConfigEditor);
