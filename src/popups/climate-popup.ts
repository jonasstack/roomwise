import { css, html, nothing } from 'lit';
import { PopupBase } from './popup-base';
import { callOptimistic } from '../actions';
import { isUnavailable } from '../ha';
import type { HassEntity } from '../types';
import { formatNumber, t, type I18nKey } from '../i18n';
import '../components/controls';

export class FpClimatePopup extends PopupBase {
  static override properties = { ...PopupBase.properties, _target: { state: true } };
  declare _target?: number;
  private debounce?: number;

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this.debounce) {
      clearTimeout(this.debounce);
      this.commit();
    }
  }

  private get step(): number {
    return this.stateObj?.attributes.target_temp_step ?? 0.5;
  }

  private nudge(dir: 1 | -1) {
    const s = this.stateObj;
    if (!s) return;
    const a = s.attributes;
    const base = this._target ?? a.temperature ?? 20;
    this._target = Math.max(a.min_temp ?? 5, Math.min(a.max_temp ?? 30, Math.round((base + dir * this.step) / this.step) * this.step));
    clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => this.commit(), 700);
  }

  private commit() {
    this.debounce = undefined;
    const v = this._target;
    if (v == null) return;
    this.safe(async () => {
      try {
        await callOptimistic(this.ctx.host, this.entityId, { attributes: { temperature: v } }, 'climate', 'set_temperature', { temperature: v });
      } finally {
        this._target = undefined;
      }
    });
  }

  private setMode(mode: string) {
    this.safe(() => callOptimistic(this.ctx.host, this.entityId, { state: mode }, 'climate', 'set_hvac_mode', { hvac_mode: mode }));
  }

  private setPreset(preset: string) {
    this.safe(() =>
      callOptimistic(this.ctx.host, this.entityId, { attributes: { preset_mode: preset } }, 'climate', 'set_preset_mode', { preset_mode: preset }),
    );
  }

  /** Our short mode names; modes we don't know: Home Assistant's translation, else the raw value */
  private modeLabel(s: HassEntity, m: string): string {
    const k = `hvac.${m}` as I18nKey;
    const own = t(k);
    if (own !== k) return own;
    try {
      if (this.hass.formatEntityState) return this.hass.formatEntityState(s, m);
    } catch {
      /* older HA */
    }
    return m.replace(/_/g, ' ');
  }

  /** Presets ('eco', 'comfort', 'away' …) translated by Home Assistant where it can */
  private presetLabel(s: HassEntity, p: string): string {
    try {
      if (this.hass.formatEntityAttributeValue) return this.hass.formatEntityAttributeValue(s, 'preset_mode', p);
    } catch {
      /* older HA */
    }
    return p.replace(/_/g, ' ');
  }

  override render() {
    const s = this.stateObj;
    if (!s) return this.renderHeader();
    const a = s.attributes;
    const unavailable = isUnavailable(s);
    const off = s.state === 'off';
    const target: number | undefined = this._target ?? a.temperature;
    const action: string | undefined = a.hvac_action;
    const actionText =
      action === 'heating' ? t('climate.heating') : action === 'cooling' ? t('climate.cooling') : off ? t('climate.off') : t('climate.idle');
    const decimals = this.step < 1 ? 1 : 0;
    const modes: string[] = a.hvac_modes ?? [];
    const presets: string[] = a.preset_modes ?? [];
    const cur = a.current_temperature;
    const color = action === 'cooling' ? 'var(--fp-state-cool)' : 'var(--fp-state-heat)';

    return html`
      ${this.renderHeader({
        icon: html`<ha-icon icon=${action === 'heating' ? 'mdi:fire' : 'mdi:thermostat'}></ha-icon>`,
        subtitle: [actionText, cur != null ? t('climate.current', { t: `${formatNumber(cur)}°` }) : ''].filter(Boolean).join(' · '),
      })}
      <div class="dial-wrap">
        <fp-dial
          .value=${target ?? 20}
          .min=${a.min_temp ?? 5}
          .max=${a.max_temp ?? 30}
          .step=${this.step}
          .current=${cur}
          .active=${!off && !unavailable}
          .color=${color}
          ?disabled=${unavailable || target == null}
          @value-input=${(e: CustomEvent) => (this._target = e.detail.value)}
          @value-change=${(e: CustomEvent) => {
            this._target = e.detail.value;
            this.commit();
          }}
        >
          <div class="mode-label ${action === 'heating' ? 'heat' : ''}">${off ? t('climate.off') : t('climate.target')}</div>
          <div class="target num ${off ? 'off' : ''}">
            ${target != null ? html`${formatNumber(target, decimals)}<span class="deg">°</span>` : '–'}
          </div>
          ${cur != null ? html`<div class="current num">${t('climate.current', { t: `${formatNumber(cur)}°` })}</div>` : nothing}
        </fp-dial>
        <div class="steppers">
          <button class="icon-btn pressable big" aria-label=${t('climate.lower')} ?disabled=${unavailable || target == null} @click=${() => this.nudge(-1)}>
            <ha-icon icon="mdi:minus"></ha-icon>
          </button>
          <button class="icon-btn pressable big" aria-label=${t('climate.raise')} ?disabled=${unavailable || target == null} @click=${() => this.nudge(1)}>
            <ha-icon icon="mdi:plus"></ha-icon>
          </button>
        </div>
      </div>
      ${modes.length > 1
        ? html`<div class="label-s">${t('climate.mode')}</div>
            <fp-segmented
              .options=${modes.map((m) => ({ value: m, label: this.modeLabel(s, m), icon: modeIcon(m) }))}
              .value=${s.state}
              @value-change=${(e: CustomEvent) => this.setMode(e.detail.value)}
            ></fp-segmented>`
        : nothing}
      ${presets.length
        ? html`<div class="label-s" style="margin-top:var(--fp-space-5)">${t('climate.preset')}</div>
            <div class="chips">
              ${presets.map(
                (p) => html`<button class="chip pressable" aria-pressed=${a.preset_mode === p ? 'true' : 'false'} @click=${() => this.setPreset(p)}>
                  ${this.presetLabel(s, p)}
                </button>`,
              )}
            </div>`
        : nothing}
    `;
  }

  static override styles = [
    ...PopupBase.styles,
    css`
      .dial-wrap {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        margin: calc(var(--fp-space-2) * -1) 0 var(--fp-space-5);
      }
      fp-dial {
        width: min(300px, 80vw);
      }
      .mode-label {
        font-size: var(--fp-text-subhead);
        font-weight: var(--fp-weight-semibold);
        color: var(--fp-label-2);
      }
      .mode-label.heat {
        color: var(--fp-state-heat);
      }
      .target {
        font-size: var(--fp-text-display);
        font-weight: var(--fp-weight-medium);
        letter-spacing: -0.03em;
        line-height: 1.05;
      }
      .target.off {
        color: var(--fp-label-3);
      }
      .deg {
        font-weight: var(--fp-weight-regular);
        color: var(--fp-label-2);
      }
      .current {
        font-size: var(--fp-text-footnote);
        color: var(--fp-label-2);
      }
      .steppers {
        position: absolute;
        bottom: 0;
        left: 50%;
        transform: translateX(-50%);
        display: flex;
        gap: var(--fp-space-6);
      }
      .icon-btn.big {
        width: 56px;
        height: 56px;
        background: var(--fp-surface);
        box-shadow: var(--fp-shadow-1);
      }
      .icon-btn.big ha-icon {
        --mdc-icon-size: 26px;
      }
    `,
  ];
}

function modeIcon(m: string) {
  return (
    { off: 'mdi:power', heat: 'mdi:fire', cool: 'mdi:snowflake', auto: 'mdi:thermostat-auto', heat_cool: 'mdi:sun-snowflake-variant', dry: 'mdi:water-percent', fan_only: 'mdi:fan' } as Record<
      string,
      string
    >
  )[m];
}

if (!customElements.get('fp-climate-popup')) customElements.define('fp-climate-popup', FpClimatePopup);
