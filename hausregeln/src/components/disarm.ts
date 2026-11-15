/**
 * <hr-disarm>: the own confirmation popup for switching the alarm off.
 * Depending on the setup: just "Ja, ausschalten", a PIN pad, or Face ID / Touch ID (passkey) with PIN as fallback.
 * With .objectId it switches off an object alarm ("Weitere Alarme") with the same confirmation; .onlyAlarm
 * then ends only the running alarm and the object stays armed.
 * Fires "done" after the alarm is off and "close" when cancelled.
 */
import { css, html, nothing } from 'lit';
import { mdiBackspaceOutline, mdiFaceRecognition, mdiShieldOffOutline } from '@mdi/js';
import { StoreElement } from '../base';
import { icon, shared } from '../design/shared';
import { confirmPasskey, passkeyAvailable } from '../passkey';
import { t } from '../i18n';
// i18n: complete

export class HrDisarm extends StoreElement {
  static override properties = {
    ...StoreElement.properties,
    objectId: { attribute: 'object-id' },
    onlyAlarm: { type: Boolean },
    _pin: { state: true },
    _msg: { state: true },
    _busy: { state: true },
    _usePin: { state: true },
  };
  declare objectId: string;
  declare onlyAlarm: boolean;
  declare _pin: string;
  declare _msg: string;
  declare _busy: boolean;
  declare _usePin: boolean;
  private _tried = false;

  constructor() {
    super();
    this._pin = '';
    this._msg = '';
    this._busy = false;
    this._usePin = false;
    this.objectId = '';
    this.onlyAlarm = false;
  }

  private get _object() {
    return this.objectId ? this.store.objects.find((o) => o.id === this.objectId) : undefined;
  }

  static override styles = [
    shared,
    css`
      :host {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--hr-space-4);
        padding: var(--hr-space-6) var(--hr-space-5) var(--hr-space-6);
        text-align: center;
      }
      .shield {
        width: 72px;
        height: 72px;
        border-radius: 22px;
        display: grid;
        place-items: center;
        background: color-mix(in srgb, var(--hr-accent) var(--hr-tint), transparent);
        color: var(--hr-accent);
      }
      h2 {
        font-size: var(--hr-text-title2);
      }
      p {
        color: var(--hr-label-2);
        max-width: 36ch;
        line-height: 1.45;
      }
      .dots {
        display: flex;
        gap: 12px;
        min-height: 18px;
      }
      .dots span {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: var(--hr-label);
      }
      .pad {
        display: grid;
        grid-template-columns: repeat(3, 72px);
        gap: 12px;
      }
      .pad button {
        width: 72px;
        height: 72px;
        border-radius: 50%;
        background: var(--hr-surface);
        font-size: 28px;
        font-weight: 500;
        box-shadow: var(--hr-shadow-1);
      }
      .pad button.fn {
        background: none;
        box-shadow: none;
        font-size: var(--hr-text-subhead);
        display: grid;
        place-items: center;
      }
      .big {
        min-width: 260px;
        min-height: 54px;
        font-size: var(--hr-text-body);
      }
      .msg {
        color: var(--hr-red);
        font-weight: 600;
      }
      .link {
        color: var(--hr-accent);
        font-weight: 600;
      }
    `,
  ];

  override firstUpdated(): void {
    // Face ID right away, like in banking apps
    if (this._mode === 'device' && !this._tried) this._device();
  }

  private get _mode(): 'none' | 'pin' | 'device' {
    const cfg = this.store.alarm?.config;
    if (!cfg) return 'none';
    if (this.objectId && this._object?.confirm === false) return 'none';
    if (cfg.confirm === 'device' && cfg.devices.length && passkeyAvailable() && !this._usePin) return 'device';
    if (cfg.confirm === 'none') return 'none';
    return cfg.has_code ? 'pin' : 'none';
  }

  private async _send(code?: string, webauthn?: Record<string, string>) {
    this._busy = true;
    this._msg = '';
    try {
      const res = this.objectId
        ? await this.store.objectDisarm(this.objectId, { code, webauthn, rpId: location.hostname, onlyAlarm: this.onlyAlarm })
        : await this.store.alarmDisarm(code, webauthn, location.hostname);
      if (res.ok) {
        this.dispatchEvent(new CustomEvent('done'));
        return;
      }
      const r = res as { error?: string | null; retry_in?: number };
      this._msg =
        r.error === 'wrong_code'
          ? r.retry_in
            ? t('alarm.wrong_pin_locked', { s: r.retry_in })
            : t('alarm.wrong_pin')
          : r.error === 'locked'
            ? t('alarm.pin_locked', { s: r.retry_in ?? 30 })
            : r.error === 'no_pin'
              ? t('alarm.no_pin_set')
              : r.error === 'needs_device'
                ? t('alarm.confirm_device')
                : String(r.error);
      this._pin = '';
    } catch (e) {
      this._msg = (e as Error).message;
    } finally {
      this._busy = false;
    }
  }

  private async _device() {
    this._tried = true;
    try {
      await this._send(undefined, await confirmPasskey(this.store));
    } catch (e) {
      this._msg = (e as Error).name === 'NotAllowedError' ? t('alarm.cancelled_dot') : (e as Error).message;
    }
  }

  private _title() {
    const o = this._object;
    if (o)
      return html`<h2>${this.onlyAlarm ? t('alarm.obj_stop_q', { name: o.name }) : t('alarm.obj_disarm_q', { name: o.name })}</h2>
        <p>${this.onlyAlarm ? t('alarm.obj_stays_armed', { name: o.name }) : `${t('alarm.now_state', { state: o.label })}${o.cause_name ? ` · ${t('alarm.caused_by', { cause: o.cause_name })}` : ''}`}</p>`;
    const a = this.store.alarm;
    return html`<h2>${t('alarm.disarm_q')}</h2>
      <p>${a ? `${t('alarm.now_state', { state: a.label })}${a.cause_name ? ` · ${t('alarm.caused_by', { cause: a.cause_name })}` : ''}` : ''}</p>`;
  }

  private _key(k: string) {
    if (k === 'del') this._pin = this._pin.slice(0, -1);
    else if (this._pin.length < 8) this._pin += k;
  }

  override render() {
    const mode = this._mode;
    return html`
      <span class="shield">${icon(mode === 'device' ? mdiFaceRecognition : mdiShieldOffOutline, 36)}</span>
      ${this._title()}
      ${mode === 'none'
        ? html`<button class="btn primary big" ?disabled=${this._busy} @click=${() => this._send()}>${icon(mdiShieldOffOutline, 20)}${t('alarm.yes_disarm')}</button>`
        : mode === 'device'
          ? html`<button class="btn primary big" ?disabled=${this._busy} @click=${this._device}>${icon(mdiFaceRecognition, 20)}${t('alarm.with_device')}</button>
              ${this.store.alarm?.config.has_code ? html`<button class="btn plain link" @click=${() => (this._usePin = true)}>${t('alarm.use_pin')}</button>` : nothing}`
          : html`<div class="dots" aria-label="PIN">${[...this._pin].map(() => html`<span></span>`)}</div>
              <div class="pad">
                ${['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => html`<button @click=${() => this._key(k)}>${k}</button>`)}
                <button class="fn" aria-label=${t('common.delete')} @click=${() => this._key('del')}>${icon(mdiBackspaceOutline, 24)}</button>
                <button @click=${() => this._key('0')}>0</button>
                <button class="fn link" ?disabled=${!this._pin || this._busy} @click=${() => this._send(this._pin)}>OK</button>
              </div>`}
      ${this._msg ? html`<span class="msg" role="alert">${this._msg}</span>` : nothing}
      <button class="btn plain" @click=${() => this.dispatchEvent(new CustomEvent('close'))}>${t('common.cancel')}</button>
    `;
  }
}
customElements.define('hr-disarm', HrDisarm);
