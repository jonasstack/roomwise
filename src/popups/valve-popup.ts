import { css, html, nothing } from 'lit';
import { PopupBase } from './popup-base';
import { callOptimistic } from '../actions';
import { isUnavailable } from '../ha';
import { t } from '../i18n';
import { actionRow, actionRowStyles, sinceText } from './action-row';
import '../components/controls';

// ValveEntityFeature bits
const F = { OPEN: 1, CLOSE: 2, SET_POSITION: 4, STOP: 8 };

/** Valve (irrigation zone, water tap): water on / off, how far open when it reports a position, since when it runs */
export class FpValvePopup extends PopupBase {
  static override properties = { ...PopupBase.properties, _pos: { state: true } };
  declare _pos?: number;

  private supports(bit: number) {
    const f = this.stateObj?.attributes.supported_features;
    return f == null || (f & bit) !== 0;
  }

  private svc(service: string, override: { state?: string; attributes?: Record<string, unknown> } = {}, data: Record<string, unknown> = {}) {
    this.safe(() => callOptimistic(this.ctx.host, this.entityId, override, 'valve', service, data));
  }

  override render() {
    const s = this.stateObj;
    if (!s) return this.renderHeader();
    const unavailable = isUnavailable(s);
    const open = s.state === 'open' || s.state === 'opening';
    const hasPos = this.supports(F.SET_POSITION) && s.attributes.current_position != null;
    const pos: number = this._pos ?? s.attributes.current_position ?? (open ? 100 : 0);
    const since = sinceText(s);
    return html`
      ${this.renderHeader({ subtitle: unavailable ? t('card.unavailable') : open ? t('valve.watering') : t('valve.off') })}
      <div class="drops ${open ? 'on' : ''}" aria-hidden="true">
        <ha-icon icon=${open ? 'mdi:sprinkler-variant' : 'mdi:sprinkler'}></ha-icon>
        ${open ? [0, 1, 2].map((i) => html`<i style=${`animation-delay:-${i * 0.6}s`}></i>`) : nothing}
      </div>
      ${actionRow([
        open
          ? { key: 'close', icon: 'mdi:water-off-outline', label: t('valve.stop_water'), on: () => this.svc('close_valve', { state: 'closing' }), primary: true, disabled: unavailable || !this.supports(F.CLOSE) }
          : { key: 'open', icon: 'mdi:water-outline', label: t('valve.start_water'), on: () => this.svc('open_valve', { state: 'opening' }), primary: true, disabled: unavailable || !this.supports(F.OPEN) },
        ...((s.state === 'opening' || s.state === 'closing') && (s.attributes.supported_features ?? 0) & F.STOP
          ? [{ key: 'stop', icon: 'mdi:stop', label: t('cover.stop'), on: () => this.svc('stop_valve') }]
          : []),
      ])}
      ${hasPos
        ? html`<fp-slider
            horizontal
            .value=${pos}
            .fill=${'var(--fp-blue)'}
            icon="mdi:valve"
            .label=${t('cover.position')}
            ?disabled=${unavailable}
            @value-input=${(e: CustomEvent) => (this._pos = e.detail.value)}
            @value-change=${(e: CustomEvent) => {
              this._pos = undefined;
              this.svc('set_valve_position', { attributes: { current_position: e.detail.value } }, { position: e.detail.value });
            }}
          ></fp-slider>`
        : nothing}
      ${open && since ? html`<div class="note"><ha-icon icon="mdi:clock-outline"></ha-icon><span>${t('valve.since', { t: since })}</span></div>` : nothing}
    `;
  }

  static override styles = [
    ...PopupBase.styles,
    actionRowStyles,
    css`
      .drops {
        position: relative;
        width: 96px;
        height: 96px;
        margin: 0 auto var(--fp-space-4);
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--fp-fill);
        color: var(--fp-label-2);
      }
      .drops ha-icon {
        --mdc-icon-size: 44px;
      }
      .drops.on {
        background: color-mix(in srgb, var(--fp-blue) 16%, transparent);
        color: var(--fp-blue);
      }
      .drops i {
        position: absolute;
        inset: 0;
        border-radius: 50%;
        border: 2px solid var(--fp-blue);
        opacity: 0;
        animation: fp-ripple 1.8s ease-out infinite;
      }
      @keyframes fp-ripple {
        from {
          transform: scale(0.7);
          opacity: 0.6;
        }
        to {
          transform: scale(1.35);
          opacity: 0;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .drops i {
          animation: none;
        }
      }
      fp-slider {
        height: 56px;
        margin-bottom: var(--fp-space-4);
      }
    `,
  ];
}

if (!customElements.get('fp-valve-popup')) customElements.define('fp-valve-popup', FpValvePopup);
