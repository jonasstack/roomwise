import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { components } from '../design/components';
import type { FloorplanCardConfig, HassEntity, HomeAssistant, PopupTarget } from '../types';
import type { ActionHost } from '../actions';
import { entityName, formatState, isUnavailable, stateIcon, stateStyle } from '../ha';
import { t } from '../i18n';

export interface PopupContext {
  hass: HomeAssistant;
  getState: (id: string) => HassEntity | undefined;
  host: ActionHost;
  close: () => void;
  back?: () => void;
  push: (target: PopupTarget) => void;
  config?: FloorplanCardConfig;
  /** Hausregeln installed: open everything about this device's rules */
  openRules?: (entity: string) => void;
}

export abstract class PopupBase extends LitElement {
  static override properties = {
    ctx: { attribute: false },
    entityId: { type: String },
  };

  declare ctx: PopupContext;
  declare entityId: string;

  get stateObj(): HassEntity | undefined {
    return this.ctx?.getState(this.entityId);
  }

  get hass() {
    return this.ctx.hass;
  }

  /** Run a service and show a toast if it fails (the optimistic state is reverted by the caller). */
  protected async safe(fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (err) {
      console.info('[floorplan-card] action failed', err);
      this.ctx.host.toast(t('card.action_failed'));
    }
  }

  protected renderHeader(opts: { icon?: TemplateResult; title?: string; subtitle?: string; trailing?: TemplateResult } = {}) {
    const s = this.stateObj;
    const style = stateStyle(s);
    return html`<header class="head">
      ${this.ctx.back
        ? html`<button class="icon-btn plain pressable back" aria-label=${t('common.back')} @click=${this.ctx.back}>
            <ha-icon icon="mdi:chevron-left"></ha-icon>
          </button>`
        : nothing}
      <div class="tile ${style ? 'on' : ''}" style=${style ? `--tile-color:${style.color};--tile-ink:${style.ink}` : ''}>
        ${opts.icon ??
        (s
          ? stateIcon(this.hass, s)
            ? html`<ha-icon .icon=${stateIcon(this.hass, s)}></ha-icon>`
            : html`<ha-state-icon .hass=${this.hass} .stateObj=${s}></ha-state-icon>`
          : nothing)}
      </div>
      <div class="head-text">
        <div class="head-title">${opts.title ?? entityName(this.hass, this.entityId, s)}</div>
        <div class="head-sub">${opts.subtitle ?? (isUnavailable(s) ? t('card.unavailable') : formatState(this.hass, s))}</div>
      </div>
      ${opts.trailing ?? nothing}
      ${this.ctx.openRules && this.entityId
        ? html`<button class="icon-btn pressable rules" aria-label=${t('hr.rules')} title=${t('hr.rules')} @click=${() => this.ctx.openRules!(this.entityId)}>
            <ha-icon icon="mdi:script-text-outline"></ha-icon>
          </button>`
        : nothing}
      <button class="icon-btn pressable close" aria-label=${t('common.close')} @click=${this.ctx.close}>
        <ha-icon icon="mdi:close"></ha-icon>
      </button>
    </header>`;
  }

  // Tokens are inherited from the top-level host (card / layer), so dark mode cascades.
  static override styles = [
    components,
    css`
      :host {
        display: block;
        padding: var(--fp-space-5) var(--fp-space-6) var(--fp-space-6);
      }
      .head {
        display: flex;
        align-items: center;
        gap: var(--fp-space-3);
        margin-bottom: var(--fp-space-5);
      }
      .head .back {
        margin-left: calc(var(--fp-space-3) * -1);
        margin-right: calc(var(--fp-space-2) * -1);
      }
      .head .tile {
        width: 48px;
        height: 48px;
      }
      .head-text {
        flex: 1;
        min-width: 0;
      }
      .head-title {
        font-size: var(--fp-text-title3);
        font-weight: var(--fp-weight-semibold);
        letter-spacing: -0.01em;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .head-sub {
        font-size: var(--fp-text-subhead);
        color: var(--fp-label-2);
        margin-top: 1px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-variant-numeric: tabular-nums;
      }
      .close {
        width: 36px;
        height: 36px;
        position: relative;
      }
      .close::after {
        /* keep a 44px hit area around the smaller visual */
        content: '';
        position: absolute;
        inset: -4px;
      }
      .close ha-icon {
        --mdc-icon-size: 20px;
        color: var(--fp-label-2);
      }
      .card {
        background: var(--fp-surface);
        border-radius: var(--fp-radius-l);
        padding: var(--fp-space-4);
      }
      .stack {
        display: flex;
        flex-direction: column;
        gap: var(--fp-space-4);
      }
      .label-s {
        font-size: var(--fp-text-footnote);
        font-weight: var(--fp-weight-semibold);
        color: var(--fp-label-2);
        margin: 0 0 var(--fp-space-2) var(--fp-space-1);
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: var(--fp-space-2);
      }
    `,
  ];
}
