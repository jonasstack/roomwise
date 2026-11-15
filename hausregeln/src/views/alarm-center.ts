/**
 * <hr-alarm-center>: the alarm screen that opens from the message on the phone (/hausregeln/alarm).
 * Big status with countdown; arm (three modes, with the open-windows question) or switch off (own confirmation
 * popup: PIN or Face ID), silence the siren. Below, tiles in the style of the alarm area, each with a pop-up:
 * countdown and cause, more alarms (object alarms), live cameras, last events.
 */
import { css, html, nothing } from 'lit';
import { mdiAlertOctagon, mdiArrowLeft, mdiCctv, mdiChevronRight, mdiHistory, mdiShieldAccount, mdiShieldCheck, mdiShieldHomeOutline, mdiShieldMoon, mdiShieldOffOutline, mdiTimerOutline, mdiVolumeOff } from '@mdi/js';
import { StoreElement } from '../base';
import { icon, shared } from '../design/shared';
import { kit } from '../design/kit';
import { relTime } from '../describe';
import { LiveStore } from '../live';
import type { AlarmMode } from '../model';
import { t, tn, type I18nKey } from '../i18n';
import '../components/disarm';
import '../components/sheet';
import '../components/pop';
import './object-alarms';
// i18n: complete

type CenterPop = 'countdown' | 'more' | 'cameras' | 'log';
const ARM_ICON: Record<AlarmMode, string> = { away: mdiShieldCheck, night: mdiShieldMoon, home: mdiShieldHomeOutline };

export class HrAlarmCenter extends StoreElement {
  static override properties = {
    ...StoreElement.properties,
    _confirm: { state: true },
    _now: { state: true },
    _tick: { state: true },
    _pop: { state: true },
    _open: { state: true },
    _busy: { state: true },
    _msg: { state: true },
  };
  declare _confirm: boolean;
  declare _now: number;
  declare _tick: number;
  declare _pop: CenterPop | null;
  /** arming was refused because of open doors / windows: ask "arm anyway?" */
  declare _open: { mode: AlarmMode; list: { entity_id: string; name: string }[] } | null;
  declare _busy: boolean;
  declare _msg: string;
  private _timer = 0;

  constructor() {
    super();
    this._confirm = false;
    this._now = Date.now() / 1000;
    this._tick = 0;
    this._pop = null;
    this._open = null;
    this._busy = false;
    this._msg = '';
  }

  private async _arm(mode: AlarmMode, force = false) {
    this._busy = true;
    this._msg = '';
    try {
      const res = await this.store.alarmArm(mode, force);
      this._open = !res.ok && res.error === 'open' ? { mode, list: res.open ?? [] } : null;
      if (!res.ok && res.error !== 'open') this._msg = res.error === 'not_set_up' ? t('alarm.not_set_up') : String(res.error);
    } finally {
      this._busy = false;
    }
  }

  override connectedCallback(): void {
    super.connectedCallback();
    // countdown every half second, camera pictures every 2 seconds where there is no live stream
    this._timer = window.setInterval(() => {
      this._now = Date.now() / 1000;
      if (Math.round(this._now * 2) % 4 === 0) this._tick++;
    }, 500);
  }
  override disconnectedCallback(): void {
    super.disconnectedCallback();
    clearInterval(this._timer);
  }

  static override styles = [
    shared,
    kit,
    css`
      /* pop-up bodies are flex columns: their parts keep their height and scroll instead of shrinking */
      hr-pop > * {
        flex-shrink: 0;
      }
      .rl-tile .rl-chip {
        white-space: normal;
      }
      .top .sub {
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
      }
      .arm {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: var(--hr-space-2);
        width: 100%;
        max-width: 760px;
        margin-top: var(--hr-space-2);
      }
      .arm button {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 4px;
        padding: var(--hr-space-3) var(--hr-space-4);
        border-radius: var(--hr-radius-l);
        background: var(--hr-fill);
        text-align: left;
      }
      .arm button .ic {
        color: var(--hr-accent);
      }
      .arm button span {
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
      }
      .warn {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-2);
        padding: var(--hr-space-3) var(--hr-space-4);
        border-radius: var(--hr-radius-m);
        background: color-mix(in srgb, var(--hr-orange) 12%, var(--hr-surface));
      }
      .msg {
        color: var(--hr-red);
        font-size: var(--hr-text-footnote);
      }
      .big {
        font-size: 56px;
        font-weight: 800;
        font-variant-numeric: tabular-nums;
        text-align: center;
        line-height: 1;
      }
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-5);
        min-height: 100vh;
        background: var(--hr-bg);
        padding-block: var(--hr-space-5) var(--hr-space-8);
        padding-left: max(var(--hr-space-4), env(safe-area-inset-left, 0px));
        padding-right: max(var(--hr-space-4), env(safe-area-inset-right, 0px));
        max-width: 1100px;
        margin: 0 auto;
      }
      .top {
        display: flex;
        align-items: center;
        gap: var(--hr-space-2);
      }
      .top h1 {
        font-size: var(--hr-text-title2);
        flex: 1;
      }
      .hero {
        --state: var(--hr-green);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--hr-space-3);
        padding: var(--hr-space-7) var(--hr-space-5);
        text-align: center;
      }
      .hero.armed {
        --state: var(--hr-accent);
      }
      .hero.pending,
      .hero.arming {
        --state: var(--hr-orange);
      }
      .hero.triggered {
        --state: var(--hr-red);
        background: color-mix(in srgb, var(--hr-red) 14%, var(--hr-surface));
        animation: pulse 1.1s ease-in-out infinite alternate;
      }
      @keyframes pulse {
        to {
          background: color-mix(in srgb, var(--hr-red) 28%, var(--hr-surface));
        }
      }
      .hero .shield {
        width: 96px;
        height: 96px;
        border-radius: 30px;
        display: grid;
        place-items: center;
        background: color-mix(in srgb, var(--state) var(--hr-tint), transparent);
        color: var(--state);
      }
      .hero h2 {
        font-size: var(--hr-text-large);
        color: var(--state);
        letter-spacing: -0.02em;
      }
      .hero p {
        color: var(--hr-label-2);
        font-size: var(--hr-text-body);
      }
      .count {
        font-size: 64px;
        font-weight: 800;
        color: var(--state);
        font-variant-numeric: tabular-nums;
        line-height: 1;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--hr-space-2);
        justify-content: center;
        margin-top: var(--hr-space-2);
      }
      .actions .btn {
        min-height: 56px;
        padding: 0 var(--hr-space-6);
        font-size: var(--hr-text-body);
      }
      .cams {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr));
        gap: var(--hr-space-3);
      }
      .cam {
        overflow: hidden;
        padding: 0;
      }
      .cam .name {
        padding: var(--hr-space-2) var(--hr-space-3);
        font-weight: 600;
        font-size: var(--hr-text-subhead);
      }
      .cam img,
      .cam ha-camera-stream {
        display: block;
        width: 100%;
        aspect-ratio: 16 / 9;
        object-fit: cover;
        background: #000;
      }
      h3 {
        font-size: var(--hr-text-subhead);
        color: var(--hr-label-2);
        margin: 0 0 var(--hr-space-2) var(--hr-space-1);
      }
      .row time {
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
        min-width: 84px;
      }
    `,
  ];

  private _back() {
    history.pushState(null, '', '/hausregeln');
    window.dispatchEvent(new CustomEvent('location-changed', { detail: { replace: false } }));
  }

  private _camera(id: string) {
    const live = this.store instanceof LiveStore ? this.store : undefined;
    const st = live?.hass.states[id];
    const name = String(st?.attributes.friendly_name ?? id);
    if (live && customElements.get('ha-camera-stream') && st)
      return html`<div class="card cam"><div class="name">${name}</div><ha-camera-stream .hass=${live.hass} .stateObj=${st} muted controls allow-exoplayer></ha-camera-stream></div>`;
    const token = st?.attributes.access_token;
    const src = token ? `/api/camera_proxy/${id}?token=${token}&t=${this._tick}` : '';
    return html`<div class="card cam"><div class="name">${name}</div>${src ? html`<img alt=${name} src=${src} />` : html`<img alt="" />`}</div>`;
  }

  private _tile(p: CenterPop, ic: string, title: string, sub: string, text: unknown, chip?: string) {
    return html`<div class="rl-tile small">
      <button class="rl-open" aria-label=${title} @click=${() => (this._pop = p)}></button>
      <div class="top">
        <span class="rl-ic">${icon(ic, 26)}</span>
        <span class="grow"><h2>${title}</h2><div class="state">${sub}</div></span>
        <span class="go">${icon(mdiChevronRight, 22)}</span>
      </div>
      <div class="text">${text}</div>
      ${chip ? html`<div class="foot"><span class="rl-chip">${chip}</span></div>` : nothing}
    </div>`;
  }

  private _popView(p: CenterPop) {
    const s = this.store;
    const a = s.alarm!;
    const close = () => (this._pop = null);
    const done = html`<button slot="foot" class="btn primary" @click=${close}>${t('common.done')}</button>`;
    const left = a.until ? Math.max(0, Math.ceil(a.until - this._now)) : null;
    const log = s.history.filter((h) => h.kind === 'alarm').slice(0, 12);
    switch (p) {
      case 'countdown':
        return html`<hr-pop narrow heading=${t('alarm.cc_countdown')} .sub=${a.label} @close=${close}>
          <div class="rl-box">
            <div class="big">${left != null && (a.state === 'pending' || a.state === 'arming') ? left : '–:––'}</div>
            <small>${left != null && (a.state === 'pending' || a.state === 'arming') ? (a.state === 'pending' ? t('alarm.cc_count_pending') : t('alarm.cc_count_arming')) : t('alarm.cc_no_countdown_sub')}</small>
          </div>
          <div class="rl-box">
            <div class="line"><span class="grow"><b>${t('alarm.cc_cause')}</b><small>${a.cause_name ?? t('alarm.cc_no_cause')}</small></span></div>
            ${a.last_exception
              ? html`<div class="line"><span class="grow"><b>${t('alarm.cc_last_exception')}</b><small>${t('alarm.last_exception', { time: relTime(new Date(a.last_exception.at * 1000).toISOString()), sensor: a.last_exception.sensor, reason: a.last_exception.reason })}</small></span></div>`
              : nothing}
          </div>
          <p class="rl-note">${t('alarm.cc_count_note')}</p>
          ${done}
        </hr-pop>`;
      case 'more':
        return html`<hr-pop narrow heading=${t('alarm.objects_title')} .sub=${t('alarm.objects_without')} @close=${close}><hr-object-alarms .store=${s} compact></hr-object-alarms>${done}</hr-pop>`;
      case 'cameras':
        return html`<hr-pop wide heading=${t('alarm.cameras')} .sub=${tn('alarm.cc_n_cameras', a.config.cameras.length)} @close=${close}>
          ${a.config.cameras.length ? html`<div class="cams">${a.config.cameras.map((c) => this._camera(c))}</div>` : html`<p class="rl-note">${t('alarm.center_no_camera')}</p>`}
          ${done}
        </hr-pop>`;
      case 'log':
        return html`<hr-pop narrow heading=${t('alarm.recent')} @close=${close}>
          <div class="rl-list">
            ${log.length
              ? log.map((h) => html`<div class="rl-item"><time>${relTime(h.at)}</time><span class="grow"><b>${h.what}</b><small>${h.why}</small></span></div>`)
              : html`<div class="rl-item"><span class="grow"><small>${t('alarm.nothing_yet')}</small></span></div>`}
          </div>
          <button
            slot="foot"
            class="btn"
            @click=${() => {
              history.pushState(null, '', '/hausregeln/history');
              window.dispatchEvent(new CustomEvent('location-changed', { detail: { replace: false } }));
            }}
          >
            ${t('alarm.all_history')}
          </button>
          ${done}
        </hr-pop>`;
    }
  }

  override render() {
    const s = this.store;
    const a = s.alarm;
    if (!a) return html`<p>${t('alarm.unavailable')}</p>`;
    const armed = a.state.startsWith('armed_');
    const cls = a.state === 'disarmed' ? '' : armed ? 'armed' : a.state;
    const left = a.until ? Math.max(0, Math.ceil(a.until - this._now)) : null;
    const counting = left != null && (a.state === 'pending' || a.state === 'arming');
    const cams = a.config.cameras;
    const log = s.history.filter((h) => h.kind === 'alarm');
    const name = (id: string) => String((s instanceof LiveStore ? s.hass.states[id]?.attributes.friendly_name : undefined) ?? s.entity(id)?.name ?? id.replace(/^camera\./, ''));
    const sub = [a.label, s.objects.length ? tn('alarm.n_objects', s.objects.length) : '', cams.length ? tn('alarm.cc_n_cameras', cams.length) : ''].filter(Boolean).join(' · ');
    return html`
      <div class="top">
        <button class="icon-btn" aria-label=${t('alarm.to_overview')} @click=${this._back}>${icon(mdiArrowLeft, 22)}</button>
        <span style="flex:1;min-width:0"><h1>${t('alarm.center')}</h1><div class="sub">${sub}</div></span>
      </div>
      <section class="card hero ${cls}">
        <span class="shield">${icon(a.state === 'triggered' ? mdiAlertOctagon : a.state === 'disarmed' ? mdiShieldOffOutline : mdiShieldCheck, 52)}</span>
        <h2>${a.label}</h2>
        ${counting ? html`<span class="count">${left}</span>` : nothing}
        <p>
          ${a.state === 'triggered' || a.state === 'pending'
            ? t('alarm.tripped', { cause: a.cause_name ?? t('alarm.a_sensor') })
            : a.state === 'disarmed'
              ? `${t('alarm.all_quiet').replace(/\.$/, '')} · ${t('alarm.since', { time: relTime(new Date(a.since * 1000).toISOString()) })}`
              : t('alarm.since', { time: relTime(new Date(a.since * 1000).toISOString()) })}
        </p>
        ${a.state === 'disarmed'
          ? html`<div class="arm">
              ${(['away', 'night', 'home'] as AlarmMode[]).map(
                (m) => html`<button ?disabled=${this._busy} @click=${() => this._arm(m)}>${icon(ARM_ICON[m], 24)}<b>${t('alarm.arm_mode', { mode: t(`alarm.mode_${m}` as I18nKey) })}</b><span>${t(`alarm.mode_hint_${m}` as I18nKey)}</span></button>`,
              )}
            </div>`
          : html`<div class="actions">
              <button class="btn primary" @click=${() => (this._confirm = true)}>${icon(mdiShieldOffOutline, 22)}${a.config.confirm === 'none' ? t('alarm.disarm') : t('alarm.cc_disarm_confirm')}</button>
              ${a.state === 'triggered' && !a.silenced ? html`<button class="btn danger" @click=${() => s.alarmSilence()}>${icon(mdiVolumeOff, 22)}${t('alarm.silence')}</button>` : nothing}
            </div>`}
        ${this._open
          ? html`<div class="warn">
              <b>${t('alarm.still_open', { names: this._open.list.map((o) => o.name).join(', ') })}</b>
              <span class="muted">${t('alarm.arm_anyway_q')}</span>
              <div class="actions">
                <button class="btn small" @click=${() => (this._open = null)}>${t('common.cancel')}</button>
                <button class="btn small primary" @click=${() => this._arm(this._open!.mode, true)}>${t('alarm.arm_anyway')}</button>
              </div>
            </div>`
          : nothing}
        ${this._msg ? html`<span class="msg">${this._msg}</span>` : nothing}
      </section>
      <div class="rl-grid">
        ${this._tile(
          'countdown',
          mdiTimerOutline,
          t('alarm.cc_countdown'),
          t('alarm.cc_countdown_sub'),
          counting ? t('alarm.cc_count_left', { s: left ?? 0 }) : t('alarm.cc_no_countdown'),
          a.cause_name ? t('alarm.cc_cause_chip', { cause: a.cause_name }) : a.last_exception ? t('alarm.cc_last_chip', { sensor: a.last_exception.sensor, time: relTime(new Date(a.last_exception.at * 1000).toISOString()) }) : undefined,
        )}
        ${s.objects.length
          ? this._tile('more', mdiShieldAccount, t('alarm.objects_title'), t('alarm.objects_without'), s.objects.map((o) => `${o.name} ${o.label.toLowerCase()}`).join(' · '), tn('alarm.n_objects', s.objects.length))
          : nothing}
        ${this._tile('cameras', mdiCctv, t('alarm.cameras'), t('alarm.cc_cameras_sub'), cams.length ? cams.map(name).join(' · ') : t('alarm.center_no_camera'), cams.length ? tn('alarm.cc_n_cameras', cams.length) : undefined)}
        ${this._tile('log', mdiHistory, t('alarm.recent'), t('alarm.tile_log_sub'), log.length ? log[0].what : t('alarm.nothing_yet'), log.length ? relTime(log[0].at) : undefined)}
      </div>
      ${this._pop ? this._popView(this._pop) : nothing}
      ${this._confirm
        ? html`<hr-sheet width="440" label=${t('alarm.disarm_sheet')} @close=${() => (this._confirm = false)}>
            <hr-disarm .store=${s} @done=${() => (this._confirm = false)} @close=${() => (this._confirm = false)}></hr-disarm>
          </hr-sheet>`
        : nothing}
    `;
  }
}
customElements.define('hr-alarm-center', HrAlarmCenter);
