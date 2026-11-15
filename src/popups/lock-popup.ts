import { css, html } from 'lit';
import { PopupBase } from './popup-base';
import { callOptimistic } from '../actions';
import { isUnavailable } from '../ha';
import { t } from '../i18n';
import { describe } from '../access';
import { actionRow, actionRowStyles, sinceText } from './action-row';

// LockEntityFeature bits
const F = { OPEN: 1 };

/** Lock (front door, gate, a car): locking acts at once; unlocking and opening the latch need the slide (access.ts) */
export class FpLockPopup extends PopupBase {
  private async svc(service: 'lock' | 'unlock' | 'open') {
    if (service !== 'lock' && !(await this.ctx.host.confirmOpen(describe(this.hass, this.entityId, service === 'open' ? 'open' : 'unlock')))) return;
    const override = service === 'lock' ? { state: 'locking' } : service === 'unlock' ? { state: 'unlocking' } : {};
    await this.safe(() => callOptimistic(this.ctx.host, this.entityId, override, 'lock', service));
  }

  override render() {
    const s = this.stateObj;
    if (!s) return this.renderHeader();
    const unavailable = isUnavailable(s);
    const locked = s.state === 'locked' || s.state === 'locking';
    const jammed = s.state === 'jammed';
    const since = sinceText(s);
    const canOpen = ((s.attributes.supported_features ?? 0) & F.OPEN) !== 0;
    const sub = unavailable ? t('card.unavailable') : jammed ? t('lock.jammed') : locked ? t('car.locked') : t('car.unlocked');
    return html`
      ${this.renderHeader({ subtitle: sub })}
      <div class="big ${locked ? 'locked' : 'open'} ${jammed ? 'jammed' : ''}" aria-hidden="true">
        <ha-icon .icon=${jammed ? 'mdi:lock-alert' : locked ? 'mdi:lock' : 'mdi:lock-open-variant'}></ha-icon>
      </div>
      ${actionRow([
        { key: 'lock', icon: 'mdi:lock', label: t('car.lock'), on: () => void this.svc('lock'), disabled: unavailable || s.state === 'locked', primary: !locked },
        { key: 'unlock', icon: 'mdi:lock-open-variant', label: t('car.unlock'), on: () => void this.svc('unlock'), disabled: unavailable || (s.state === 'unlocked' && !jammed) },
        ...(canOpen ? [{ key: 'open', icon: 'mdi:door-open', label: t('lock.open'), on: () => void this.svc('open'), disabled: unavailable }] : []),
      ])}
      <div class="note">
        <ha-icon icon="mdi:shield-check-outline"></ha-icon>
        <span>${since && !unavailable ? t(locked ? 'lock.locked_since' : 'lock.unlocked_since', { t: since }) + ' · ' : ''}${t('access.asks_twice')}</span>
      </div>
    `;
  }

  static override styles = [
    ...PopupBase.styles,
    actionRowStyles,
    css`
      .big {
        width: 96px;
        height: 96px;
        margin: 0 auto var(--fp-space-4);
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--fp-fill);
        color: var(--fp-label-2);
        --mdc-icon-size: 44px;
      }
      .big.open {
        background: rgba(255, 149, 0, 0.16);
        color: var(--fp-state-alert);
      }
      .big.jammed {
        background: rgba(255, 59, 48, 0.16);
        color: var(--fp-red);
      }
    `,
  ];
}

if (!customElements.get('fp-lock-popup')) customElements.define('fp-lock-popup', FpLockPopup);
