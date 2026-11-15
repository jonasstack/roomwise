import { css, html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { PopupBase } from './popup-base';
import type { RoomConfig } from '../types';
import { callOptimistic, toggleLights } from '../actions';
import { entityName, formatState, isUnavailable, lightRgb, rgbCss, stateStyle } from '../ha';
import { formatNumber, t } from '../i18n';
import '../components/controls';

/** Room overview: all lights with brightness, climate summary, configured values. */
export class FpRoomPopup extends PopupBase {
  static override properties = { ...PopupBase.properties, room: { attribute: false } };
  declare room: RoomConfig;

  private get lights() {
    return this.ctx.host.roomLights(this.room);
  }

  private toggle(id: string) {
    const s = this.ctx.getState(id);
    if (!s) return;
    const on = s.state === 'on';
    this.safe(() => callOptimistic(this.ctx.host, id, { state: on ? 'off' : 'on' }, 'light', on ? 'turn_off' : 'turn_on'));
  }

  private setBri(id: string, pct: number) {
    if (pct <= 0) return this.safe(() => callOptimistic(this.ctx.host, id, { state: 'off' }, 'light', 'turn_off'));
    this.safe(() =>
      callOptimistic(this.ctx.host, id, { state: 'on', attributes: { brightness: Math.round((pct / 100) * 255) } }, 'light', 'turn_on', {
        brightness_pct: pct,
      }),
    );
  }

  override render() {
    const room = this.room;
    const lights = this.lights.filter((id) => this.ctx.getState(id));
    const onCount = lights.filter((id) => this.ctx.getState(id)?.state === 'on').length;
    const temp = room.temperature ? this.ctx.getState(room.temperature) : undefined;
    const climate = room.climate ? this.ctx.getState(room.climate) : undefined;
    const tv = temp && !isUnavailable(temp) ? parseFloat(temp.state) : climate?.attributes.current_temperature;
    const name = room.name ?? this.hass.areas?.[room.area ?? '']?.name ?? '';
    const sub = [tv != null && !isNaN(tv) ? `${formatNumber(tv)}°` : '', lights.length ? t('light.lights_on', { n: onCount }) : '']
      .filter(Boolean)
      .join(' · ');
    const values = [room.humidity, ...(room.sensors ?? []).map((s) => s.entity)].filter(Boolean) as string[];

    return html`
      ${this.renderHeader({
        icon: html`<ha-icon icon=${this.hass.areas?.[room.area ?? '']?.icon ?? 'mdi:floor-plan'}></ha-icon>`,
        title: name,
        subtitle: sub,
      })}
      ${lights.length
        ? html`<div class="section-head">
              <span class="label-s">${t('room.lights')}</span>
              <button class="btn tinted pressable small" @click=${() => this.safe(() => toggleLights(this.ctx.host, lights, onCount === 0))}>
                ${onCount ? t('room.all_off') : t('room.all_on')}
              </button>
            </div>
            <div class="lights">
              ${repeat(lights, (id) => id, (id) => this.renderLight(id))}
            </div>`
        : nothing}
      ${climate
        ? html`<div class="label-s top">${t('room.climate')}</div>
            <div class="group">
              <button class="row pressable-row" @click=${() => this.ctx.push({ entity: room.climate })}>
                <div class="tile ${stateStyle(climate) ? 'on' : ''}" style=${stateStyle(climate) ? `--tile-color:${stateStyle(climate)!.color};--tile-ink:#fff` : ''}>
                  <ha-icon icon=${climate.attributes.hvac_action === 'heating' ? 'mdi:fire' : 'mdi:thermostat'}></ha-icon>
                </div>
                <div class="grow">
                  <div class="title">${entityName(this.hass, room.climate!, climate)}</div>
                  <div class="subtitle">${formatState(this.hass, climate)}</div>
                </div>
                <div class="trailing num">
                  ${climate.state !== 'off' && climate.attributes.temperature != null ? `${formatNumber(climate.attributes.temperature)}°` : ''}
                </div>
                <ha-icon class="chev" icon="mdi:chevron-right"></ha-icon>
              </button>
            </div>`
        : nothing}
      ${values.length
        ? html`<div class="label-s top">${t('room.sensors')}</div>
            <div class="group">
              ${values.map((id) => {
                const s = this.ctx.getState(id);
                return html`<div class="row">
                  <div class="grow"><div class="title">${entityName(this.hass, id, s)}</div></div>
                  <div class="trailing num">${formatState(this.hass, s)}</div>
                </div>`;
              })}
            </div>`
        : nothing}
    `;
  }

  private renderLight(id: string) {
    const s = this.ctx.getState(id)!;
    const on = s.state === 'on';
    const unavailable = isUnavailable(s);
    const bri = on ? Math.round(((s.attributes.brightness ?? 255) / 255) * 100) : 0;
    const dimmable = (s.attributes.supported_color_modes ?? []).some((m: string) => m !== 'onoff');
    const style = stateStyle(s);
    return html`<div class="light">
      <button class="tile-btn pressable" aria-label=${entityName(this.hass, id, s)} ?disabled=${unavailable} @click=${() => this.toggle(id)}>
        <div class="tile ${style ? 'on' : ''}" style=${style ? `--tile-color:${style.color};--tile-ink:${style.ink}` : ''}>
          <ha-state-icon .hass=${this.hass} .stateObj=${s}></ha-state-icon>
        </div>
      </button>
      <div class="light-main">
        <div class="light-name">${entityName(this.hass, id, s)}</div>
        ${dimmable
          ? html`<fp-slider
              horizontal
              .value=${bri}
              .fill=${on ? rgbCss(lightRgb(s)) : 'transparent'}
              ?disabled=${unavailable}
              @value-change=${(e: CustomEvent) => this.setBri(id, e.detail.value)}
            >
              <span class="pct num">${unavailable ? t('card.unavailable') : on ? `${bri} %` : t('common.off')}</span>
            </fp-slider>`
          : html`<div class="light-state">${formatState(this.hass, s)}</div>`}
      </div>
      <button class="icon-btn plain pressable more" aria-label=${t('common.details')} @click=${() => this.ctx.push({ entity: id })}>
        <ha-icon icon="mdi:tune-variant"></ha-icon>
      </button>
    </div>`;
  }

  static override styles = [
    ...PopupBase.styles,
    css`
      .section-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: var(--fp-space-2);
      }
      .section-head .label-s {
        margin: 0 0 0 var(--fp-space-1);
      }
      .btn.small {
        min-height: 36px;
        padding: 0 var(--fp-space-4);
        font-size: var(--fp-text-footnote);
        position: relative;
      }
      .btn.small::after {
        content: '';
        position: absolute;
        inset: -4px 0;
      }
      .label-s.top {
        margin-top: var(--fp-space-5);
      }
      .lights {
        display: flex;
        flex-direction: column;
        gap: var(--fp-space-2);
      }
      .light {
        display: flex;
        align-items: center;
        gap: var(--fp-space-3);
        background: var(--fp-surface);
        border-radius: var(--fp-radius-l);
        padding: var(--fp-space-2) var(--fp-space-2) var(--fp-space-2) var(--fp-space-3);
      }
      .tile-btn {
        flex: none;
      }
      .light-main {
        flex: 1;
        min-width: 0;
      }
      .light-name {
        font-size: var(--fp-text-subhead);
        font-weight: var(--fp-weight-semibold);
        margin: 0 0 var(--fp-space-1) var(--fp-space-1);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .light-state {
        font-size: var(--fp-text-footnote);
        color: var(--fp-label-2);
        margin-left: var(--fp-space-1);
      }
      .light fp-slider {
        height: 40px;
        --radius: var(--fp-radius-s);
      }
      .pct {
        position: absolute;
        right: var(--fp-space-3);
        top: 50%;
        transform: translateY(-50%);
        font-size: var(--fp-text-footnote);
        font-weight: var(--fp-weight-semibold);
        color: var(--fp-label-2);
        pointer-events: none;
      }
      .more {
        color: var(--fp-label-2);
      }
      .pressable-row {
        cursor: pointer;
      }
      .chev {
        color: var(--fp-label-3);
        --mdc-icon-size: 20px;
      }
    `,
  ];
}

if (!customElements.get('fp-room-popup')) customElements.define('fp-room-popup', FpRoomPopup);
