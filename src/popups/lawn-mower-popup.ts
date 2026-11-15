import { css, html, nothing } from 'lit';
import { PopupBase } from './popup-base';
import { callOptimistic } from '../actions';
import { formatState, isUnavailable } from '../ha';
import { t } from '../i18n';
import { actionRow, actionRowStyles, deviceBattery, deviceSiblings } from './action-row';

// LawnMowerEntityFeature bits
const F = { START_MOWING: 1, PAUSE: 2, DOCK: 4 };

/** Robotic lawn mower: what it does, battery, start / pause / back to the dock, and what its device tells besides */
export class FpLawnMowerPopup extends PopupBase {
  private supports(bit: number) {
    const f = this.stateObj?.attributes.supported_features;
    // integrations without feature flags: offer everything
    return f == null || (f & bit) !== 0;
  }

  private svc(service: string, state?: string) {
    this.safe(() => callOptimistic(this.ctx.host, this.entityId, { state }, 'lawn_mower', service));
  }

  override render() {
    const s = this.stateObj;
    if (!s) return this.renderHeader();
    const unavailable = isUnavailable(s);
    const st = s.state;
    const bat = deviceBattery(this.hass, this.entityId);
    const mowing = st === 'mowing';
    // next start, error, current activity, progress: whatever the mower's device has
    const rel = deviceSiblings(this.hass, this.entityId);
    const pick = (re: RegExp, not?: RegExp) => rel.find((r) => (r.id.startsWith('sensor.') || r.id.startsWith('binary_sensor.')) && re.test(r.key) && !(not && not.test(r.key)));
    const info = [pick(/next_start|naechst|nächst|next_schedule/), pick(/error|fehler|problem/, /count|anzahl|time/), pick(/activity|aktivit|mode/, /select/), pick(/progress|fortschritt|area|fläche|flaeche/, /total|gesamt/)]
      .filter((r): r is { id: string; key: string } => !!r && !isUnavailable(this.hass.states[r.id]))
      .slice(0, 3);
    const stateText = t(mowing ? 'mower.mowing' : st === 'returning' ? 'mower.returning' : st === 'error' ? 'mower.error' : st === 'paused' ? 'mower.paused' : 'mower.docked');
    const sub = unavailable ? t('card.unavailable') : [['mowing', 'returning', 'error', 'paused', 'docked'].includes(st) ? stateText : formatState(this.hass, s), bat != null ? t('vacuum.battery', { n: Math.round(bat) }) : ''].filter(Boolean).join(' · ');
    return html`
      ${this.renderHeader({ subtitle: sub })}
      ${bat != null
        ? html`<div class="bat ${bat <= 20 ? 'low' : ''}" role="img" aria-label=${t('vacuum.battery', { n: Math.round(bat) })}>
            <span style=${`width:${Math.max(3, Math.min(100, bat))}%`}></span>
          </div>`
        : nothing}
      ${st === 'error' ? html`<div class="note err"><ha-icon icon="mdi:alert-outline"></ha-icon><span>${t('mower.error_hint')}</span></div>` : nothing}
      ${actionRow(
        [
          mowing
            ? { key: 'pause', icon: 'mdi:pause', label: t('vacuum.pause'), on: () => this.svc('pause', 'paused'), primary: true, show: this.supports(F.PAUSE) }
            : { key: 'start', icon: 'mdi:play', label: t('mower.start'), on: () => this.svc('start_mowing', 'mowing'), primary: true, show: this.supports(F.START_MOWING) },
          { key: 'dock', icon: 'mdi:home-import-outline', label: t('vacuum.dock'), on: () => this.svc('dock', 'returning'), show: this.supports(F.DOCK) && st !== 'docked' },
        ]
          .filter((b) => b.show)
          .map((b) => ({ ...b, disabled: unavailable })),
      )}
      ${info.length
        ? html`<div class="run">
            ${info.map((r) => html`<div class="rt"><span class="rv">${formatState(this.hass, this.hass.states[r.id])}</span><span class="rk">${this.shortName(r.id)}</span></div>`)}
          </div>`
        : nothing}
    `;
  }

  /** Name without the device's name in front */
  private shortName(id: string): string {
    const s = this.hass.states[id];
    const dev = this.hass.devices?.[this.hass.entities?.[id]?.device_id ?? ''];
    const full = String(s?.attributes.friendly_name ?? id);
    const dn = dev?.name_by_user ?? dev?.name;
    return dn && full.startsWith(dn) ? full.slice(dn.length).trim() || full : full;
  }

  static override styles = [
    ...PopupBase.styles,
    actionRowStyles,
    css`
      .bat {
        height: 8px;
        border-radius: var(--fp-radius-full);
        background: var(--fp-fill);
        overflow: hidden;
        margin: calc(var(--fp-space-2) * -1) 0 var(--fp-space-5);
      }
      .bat span {
        display: block;
        height: 100%;
        border-radius: inherit;
        background: var(--fp-green);
        transition: width var(--fp-dur-slow) var(--fp-ease);
      }
      .bat.low span {
        background: var(--fp-orange);
      }
      .note.err {
        color: var(--fp-red);
        margin-bottom: var(--fp-space-4);
      }
    `,
  ];
}

if (!customElements.get('fp-lawn-mower-popup')) customElements.define('fp-lawn-mower-popup', FpLawnMowerPopup);
