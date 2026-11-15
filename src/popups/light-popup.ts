import { css, html, nothing } from 'lit';
import { PopupBase } from './popup-base';
import { callOptimistic } from '../actions';
import { isUnavailable, kelvinToRgb, lightRgb, rgbCss } from '../ha';
import { t } from '../i18n';
import '../components/controls';

const COLOR_MODES = ['hs', 'rgb', 'rgbw', 'rgbww', 'xy'];

function hsToRgb(h: number, s: number): [number, number, number] {
  s /= 100;
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (1 - s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [f(5), f(3), f(1)];
}

const PRESET_HUES: [number, number][] = [
  [30, 70],
  [0, 85],
  [330, 70],
  [270, 70],
  [215, 80],
  [170, 70],
  [120, 70],
];

export class FpLightPopup extends PopupBase {
  static override properties = { ...PopupBase.properties, _tab: { state: true }, _bri: { state: true } };
  declare _tab?: 'white' | 'color';
  declare _bri?: number;

  private get modes(): string[] {
    return this.stateObj?.attributes.supported_color_modes ?? [];
  }
  private get supportsColor() {
    return this.modes.some((m) => COLOR_MODES.includes(m));
  }
  private get supportsTemp() {
    return this.modes.includes('color_temp');
  }
  private get supportsBrightness() {
    return this.modes.some((m) => m !== 'onoff');
  }

  private toggle() {
    const s = this.stateObj;
    if (!s) return;
    const on = s.state === 'on';
    this.safe(() => callOptimistic(this.ctx.host, this.entityId, { state: on ? 'off' : 'on' }, 'light', on ? 'turn_off' : 'turn_on'));
  }

  private setBrightness(pct: number) {
    this._bri = undefined;
    if (pct <= 0)
      return this.safe(() => callOptimistic(this.ctx.host, this.entityId, { state: 'off' }, 'light', 'turn_off'));
    this.safe(() =>
      callOptimistic(this.ctx.host, this.entityId, { state: 'on', attributes: { brightness: Math.round((pct / 100) * 255) } }, 'light', 'turn_on', {
        brightness_pct: pct,
      }),
    );
  }

  private setKelvin(k: number) {
    this.safe(() =>
      callOptimistic(
        this.ctx.host,
        this.entityId,
        { state: 'on', attributes: { color_mode: 'color_temp', color_temp_kelvin: k } },
        'light',
        'turn_on',
        { color_temp_kelvin: k },
      ),
    );
  }

  private setHs(h: number, s: number) {
    const rgb = hsToRgb(h, s);
    this.safe(() =>
      callOptimistic(
        this.ctx.host,
        this.entityId,
        { state: 'on', attributes: { color_mode: 'hs', hs_color: [h, s], rgb_color: rgb } },
        'light',
        'turn_on',
        { hs_color: [h, s] },
      ),
    );
  }

  override render() {
    const s = this.stateObj;
    if (!s) return this.renderHeader();
    const on = s.state === 'on';
    const unavailable = isUnavailable(s);
    const bri = this._bri ?? (on ? Math.round(((s.attributes.brightness ?? 255) / 255) * 100) : 0);
    const color = on ? rgbCss(lightRgb(s)) : 'var(--fp-fill-strong)';
    const tab = this._tab ?? (s.attributes.color_mode && COLOR_MODES.includes(s.attributes.color_mode) ? 'color' : this.supportsTemp ? 'white' : 'color');
    const minK = s.attributes.min_color_temp_kelvin ?? 2200;
    const maxK = s.attributes.max_color_temp_kelvin ?? 6500;
    const kelvin = s.attributes.color_temp_kelvin ?? Math.round((minK + maxK) / 2);
    const hs = (s.attributes.hs_color as [number, number] | undefined) ?? [30, 60];
    const showSide = this.supportsColor || this.supportsTemp;
    const subtitle = unavailable ? t('card.unavailable') : on ? (this.supportsBrightness ? `${bri} %` : t('common.on')) : t('common.off');

    return html`
      ${this.renderHeader({
        subtitle,
        trailing: html`<button
          class="switch"
          role="switch"
          aria-label=${t('common.toggle')}
          aria-checked=${on ? 'true' : 'false'}
          ?disabled=${unavailable}
          @click=${this.toggle}
        >
          <span class="track"><span class="knob"></span></span>
        </button>`,
      })}
      <div class="body ${showSide ? '' : 'single'}">
        ${this.supportsBrightness
          ? html`<div class="col">
              <fp-slider
                .value=${bri}
                .min=${0}
                .max=${100}
                .fill=${color}
                .label=${t('light.brightness')}
                icon="mdi:brightness-6"
                ?disabled=${unavailable}
                @value-input=${(e: CustomEvent) => (this._bri = e.detail.value)}
                @value-change=${(e: CustomEvent) => this.setBrightness(e.detail.value)}
              ></fp-slider>
              <div class="caption num">${bri} %</div>
            </div>`
          : html`<button class="big-toggle pressable ${on ? 'on' : ''}" style=${`--c:${color}`} aria-label=${t('common.toggle')} ?disabled=${unavailable} @click=${this.toggle}>
              <ha-icon icon="mdi:power"></ha-icon>
            </button>`}
        ${showSide
          ? html`<div class="side">
              ${this.supportsColor && this.supportsTemp
                ? html`<fp-segmented
                    .options=${[
                      { value: 'white', label: t('light.white') },
                      { value: 'color', label: t('light.color') },
                    ]}
                    .value=${tab}
                    @value-change=${(e: CustomEvent) => (this._tab = e.detail.value)}
                  ></fp-segmented>`
                : nothing}
              ${tab === 'white' && this.supportsTemp
                ? html`<div class="temp-wrap">
                      <fp-slider
                        class="temp"
                        .value=${kelvin}
                        .min=${minK}
                        .max=${maxK}
                        .step=${50}
                        .track=${`linear-gradient(to top, ${rgbCss(kelvinToRgb(minK))}, #fff 55%, ${rgbCss(kelvinToRgb(maxK))})`}
                        .label=${t('light.white')}
                        ?disabled=${unavailable}
                        @value-change=${(e: CustomEvent) => this.setKelvin(e.detail.value)}
                      ></fp-slider>
                      <div class="caption num">${kelvin} K</div>
                    </div>
                    <div class="swatches">
                      ${[2200, 2700, 3000, 4000, 5000, 6500]
                        .filter((k) => k >= minK - 1 && k <= maxK + 1)
                        .map(
                          (k) => html`<button
                            class="swatch pressable ${Math.abs(kelvin - k) < 100 && s.attributes.color_mode === 'color_temp' ? 'sel' : ''}"
                            style=${`background:${rgbCss(kelvinToRgb(k))}`}
                            aria-label="${k} K"
                            @click=${() => this.setKelvin(k)}
                          ></button>`,
                        )}
                    </div>`
                : nothing}
              ${tab === 'color' && this.supportsColor
                ? html`<fp-color-wheel
                      .value=${hs}
                      @value-change=${(e: CustomEvent) => this.setHs(e.detail.value[0], e.detail.value[1])}
                    ></fp-color-wheel>
                    <div class="swatches">
                      ${PRESET_HUES.map(
                        ([h, sat]) => html`<button
                          class="swatch pressable ${Math.abs(hs[0] - h) < 6 && Math.abs(hs[1] - sat) < 6 ? 'sel' : ''}"
                          style=${`background:${rgbCss(hsToRgb(h, sat))}`}
                          aria-label="${h}°"
                          @click=${() => this.setHs(h, sat)}
                        ></button>`,
                      )}
                    </div>`
                : nothing}
            </div>`
          : nothing}
      </div>
    `;
  }

  static override styles = [
    ...PopupBase.styles,
    css`
      .body {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: var(--fp-space-6);
        align-items: start;
      }
      .body.single {
        grid-template-columns: 1fr;
        justify-items: center;
      }
      .col,
      .temp-wrap {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--fp-space-3);
      }
      .caption {
        font-size: var(--fp-text-subhead);
        font-weight: var(--fp-weight-semibold);
        color: var(--fp-label-2);
      }
      .side {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--fp-space-5);
        min-width: 0;
      }
      .side fp-segmented {
        align-self: stretch;
      }
      fp-slider.temp {
        width: 96px;
        height: 232px;
      }
      fp-color-wheel {
        width: 232px;
        margin-top: var(--fp-space-2);
      }
      .swatches {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: var(--fp-space-2);
      }
      .swatch {
        width: var(--fp-hit);
        height: var(--fp-hit);
        border-radius: 50%;
        box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.08);
        position: relative;
      }
      .swatch.sel::after {
        content: '';
        position: absolute;
        inset: -4px;
        border-radius: 50%;
        box-shadow: 0 0 0 2.5px var(--fp-accent);
      }
      .big-toggle {
        width: 160px;
        height: 160px;
        border-radius: 50%;
        background: var(--fp-fill-strong);
        display: flex;
        align-items: center;
        justify-content: center;
        position: relative;
        overflow: hidden;
      }
      .big-toggle::before {
        content: '';
        position: absolute;
        inset: 0;
        background: var(--c);
        opacity: 0;
        transition: opacity var(--fp-dur) var(--fp-ease);
      }
      .big-toggle.on::before {
        opacity: 1;
      }
      .big-toggle ha-icon {
        position: relative;
        --mdc-icon-size: 48px;
      }
      @media (max-width: 560px) {
        .body {
          grid-template-columns: 1fr;
          justify-items: center;
        }
      }
    `,
  ];
}

if (!customElements.get('fp-light-popup')) customElements.define('fp-light-popup', FpLightPopup);
