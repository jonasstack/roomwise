import { css, html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { PopupBase } from './popup-base';
import type { FurnitureConfig, FurnitureContentConfig } from '../types';
import { runAction } from '../actions';
import { isAccessEntity } from '../access';
import { domainOf, entityName, formatState, isUnavailable, stateIcon, stateStyle } from '../ha';
import { furnitureContents, furnitureLabel, isWifiContent, resolveFurniture, wifiContentTarget } from '../furniture';
import { t } from '../i18n';

/** Domains that may be switched right from the list: plain on / off, nothing that opens, moves or locks */
const QUICK = new Set(['light', 'switch', 'fan', 'input_boolean', 'humidifier']);

/**
 * A piece of furniture holding several devices (cabinet, shelf, sideboard …): every device inside with icon, name
 * and state; a row opens that device's own popup, a small switch toggles the plain on / off ones directly.
 */
export class FpFurniturePopup extends PopupBase {
  static override properties = { ...PopupBase.properties, piece: { attribute: false } };
  declare piece: FurnitureConfig;

  /** Quick toggle goes through runAction: the same confirmations as a tap on the plan (access.ts slide included) */
  private toggle(id: string) {
    void runAction(this.ctx.host, { action: 'toggle', entity: id }, {});
  }

  private canToggle(id: string): boolean {
    const s = this.ctx.getState(id);
    return !!s && !isUnavailable(s) && QUICK.has(domainOf(id)) && ['on', 'off'].includes(s.state) && !isAccessEntity(this.hass, id);
  }

  override render() {
    const f = this.piece;
    const k = resolveFurniture(f).k;
    const items = furnitureContents(f);
    const on = items.filter((c) => c.entity && this.ctx.getState(c.entity)?.state === 'on').length;
    return html`
      ${this.renderHeader({
        icon: html`<ha-icon .icon=${k?.icon ?? 'mdi:cupboard-outline'}></ha-icon>`,
        title: f.name || (k ? furnitureLabel(k) : t('editor.furniture_item')),
        subtitle: on ? t('furniture.inside_on', { n: items.length, on }) : t('furniture.inside_n', { n: items.length }),
      })}
      <div class="group" data-contents>${repeat(items, (c) => c.entity ?? c.kind ?? '', (c) => (c.entity ? this.renderItem(c, c.entity) : this.renderWifi(c)))}</div>
    `;
  }

  /** The Wi-Fi QR codes (no entity): opens the Wi-Fi popup with the networks stored in Home Assistant */
  private renderWifi(c: FurnitureContentConfig) {
    if (!isWifiContent(c)) return nothing;
    return html`<div class="row item" data-content="wifi">
      <button class="open pressable-row" @click=${() => this.ctx.push({ wifi: wifiContentTarget(this.piece) })}>
        <div class="tile"><ha-icon .icon=${c.icon ?? 'mdi:qrcode'}></ha-icon></div>
        <div class="grow">
          <div class="title">${c.name || t('wifi.item')}</div>
          <div class="subtitle">${t('wifi.item_sub')}</div>
        </div>
      </button>
      <ha-icon class="chev" icon="mdi:chevron-right"></ha-icon>
    </div>`;
  }

  private renderItem(c: FurnitureContentConfig, entity: string) {
    const s = this.ctx.getState(entity);
    const style = stateStyle(s);
    const icon = c.icon ?? (s ? stateIcon(this.hass, s) : 'mdi:help-circle-outline');
    const name = c.name ?? entityName(this.hass, entity, s);
    const quick = this.canToggle(entity);
    return html`<div class="row item" data-content=${entity}>
      <button class="open pressable-row" @click=${() => this.ctx.push({ entity })}>
        <div class="tile ${style ? 'on' : ''}" style=${style ? `--tile-color:${style.color};--tile-ink:${style.ink}` : ''}>
          ${icon ? html`<ha-icon .icon=${icon}></ha-icon>` : html`<ha-state-icon .hass=${this.hass} .stateObj=${s}></ha-state-icon>`}
        </div>
        <div class="grow">
          <div class="title">${name}</div>
          <div class="subtitle">${s ? (isUnavailable(s) ? t('card.unavailable') : formatState(this.hass, s)) : t('card.unavailable')}</div>
        </div>
      </button>
      ${quick
        ? html`<button
            class="switch"
            role="switch"
            aria-checked=${s!.state === 'on' ? 'true' : 'false'}
            aria-label=${name}
            @click=${() => this.toggle(entity)}
          >
            <span class="track"><span class="knob"></span></span>
          </button>`
        : html`<ha-icon class="chev" icon="mdi:chevron-right"></ha-icon>`}
    </div>`;
  }

  static override styles = [
    ...PopupBase.styles,
    css`
      .item {
        gap: var(--fp-space-2);
      }
      .open {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: var(--fp-space-3);
        background: none;
        border: 0;
        padding: 0;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
      .open .grow {
        min-width: 0;
      }
      .open .title {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .chev {
        color: var(--fp-label-3);
        --mdc-icon-size: 20px;
      }
    `,
  ];
}

if (!customElements.get('fp-furniture-popup')) customElements.define('fp-furniture-popup', FpFurniturePopup);
