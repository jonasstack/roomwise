/**
 * <hr-alarm-view>: the area "Alarmanlage" – the alarm system, the object alarms and the window warning when leaving.
 * Top: status and arm / switch off. Below, equal tiles that each open a pop-up: Sensoren je Modus, Reaktion,
 * Benachrichtigung, Sicherheit, Weitere Alarme (object alarms), Fenster-Warnung (its own feature switch) and the last
 * events. The page gear opens "Grundlagen" (how it works, who counts, automatic arming, times, exceptions per mode,
 * test alarm, assistant). Pop-ups opened from a pop-up lie on top of it (a stack, drawn as siblings).
 * Every change is saved right away.
 */
import { css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import {
  mdiAlertOctagon,
  mdiBellRing,
  mdiBellOutline,
  mdiBookOpenVariant,
  mdiCctv,
  mdiChevronRight,
  mdiClockOutline,
  mdiAccountGroup,
  mdiHistory,
  mdiLightningBolt,
  mdiLockOutline,
  mdiMotionSensor,
  mdiShieldAccount,
  mdiWindowOpenVariant,
  mdiCheckboxBlankOutline,
  mdiCheckboxMarked,
  mdiChevronDown,
  mdiOpenInNew,
  mdiPlay,
  mdiShieldCheck,
  mdiShieldHomeOutline,
  mdiShieldMoon,
  mdiShieldOffOutline,
  mdiSpeaker,
  mdiStop,
} from '@mdi/js';
import { StoreElement } from '../base';
import type { AlarmConfig, AlarmMode, AlarmModeConfig } from '../model';
import { fire, fixButton, icon, shared } from '../design/shared';
import { relTime } from '../describe';
import { passkeyAvailable, registerPasskey } from '../passkey';
import { featureHint } from '../components/feature';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { t, tn, type I18nKey } from '../i18n';
import { kit } from '../design/kit';
import { registerPage } from '../components/page';
import type { Store } from '../store';
import '../components/disarm';
import '../components/sheet';
import '../components/pop';
import './object-alarms';
import './window-warning';
// i18n: complete
import { assistantButton, autoAssistant } from '../assistant/base';

const MODE_LABEL = (m: AlarmMode) => t(`alarm.mode_${m}` as I18nKey);
const MODE_HINT = (m: AlarmMode) => t(`alarm.mode_hint_${m}` as I18nKey);
const MODE_ICON: Record<AlarmMode, string> = { away: mdiShieldCheck, night: mdiShieldMoon, home: mdiShieldHomeOutline };
const HOUSE = ['home', 'away', 'sleep', 'vacation', 'guests'];
const HOUSE_LABEL = (id: string) => t(`mode.${id}` as I18nKey);
const BUTTONS = ['disarm', 'silence', 'camera', 'lights', 'open', 'call'];
const ACTIVATE_DOMAINS = ['camera', 'switch', 'siren', 'scene', 'script', 'input_boolean'];

/** the pop-ups of the page (and of the gear "Grundlagen") */
type Pop = 'basics' | 'explain' | 'presence' | 'auto' | 'times' | 'smart' | 'sensors' | 'reaction' | 'activate' | 'sound' | 'announce' | 'notify' | 'channels' | 'security' | 'more' | 'window' | 'log';

/** the line under the page title: "Unscharf · 2 Weitere Alarme" */
function alarmSub(s: Store): string {
  const a = s.alarm;
  const parts = [a && a.config.enabled && s.on('alarm') ? a.label : t('alarm.page_off')];
  if (s.objects.length) parts.push(tn('alarm.n_objects', s.objects.length));
  return parts.join(' · ');
}
registerPage('alarm', { sub: alarmSub, gear: true, plan: true });

export class HrAlarmView extends StoreElement {
  static override properties = {
    ...StoreElement.properties,
    _mode: { state: true },
    _open: { state: true },
    _now: { state: true },
    _busy: { state: true },
    _msg: { state: true },
    _confirm: { state: true },
    _playing: { state: true },
    _q: { state: true },
    _pops: { state: true },
  };
  declare _mode: AlarmMode;
  declare _open: { mode: AlarmMode; list: { entity_id: string; name: string }[] } | null;
  declare _now: number;
  declare _busy: boolean;
  declare _msg: string;
  declare _confirm: boolean;
  declare _playing: string;
  declare _q: string;
  /** open pop-ups, the last one on top */
  declare _pops: Pop[];
  private _tick = 0;
  /** the message line belongs to a channel test (shown in the channels block) */
  private _testing = false;
  private _audio?: HTMLAudioElement;

  constructor() {
    super();
    this._mode = 'away';
    this._open = null;
    this._now = Date.now() / 1000;
    this._busy = false;
    this._msg = '';
    this._confirm = false;
    this._playing = '';
    this._q = '';
    this._pops = [];
  }

  /** the page gear: "Grundlagen" */
  openGear(): void {
    if (this.store.alarm) this._pops = ['basics'];
  }

  private _push(p: Pop) {
    this._pops = [...this._pops.filter((x) => x !== p), p];
  }

  /** links to a place: the window warning (also from the card) and who counts as present (from Zuhause) */
  protected override reveal(anchor: string): void {
    if (anchor === 'window-warning') this._pops = ['window'];
    else if (anchor === 'alarm-presence' && this.store.alarm) this._pops = ['basics', 'presence'];
    else super.reveal(anchor);
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this._tick = window.setInterval(() => {
      if (this.store?.alarm?.until) this._now = Date.now() / 1000;
    }, 500);
  }
  override updated(changed: PropertyValues): void {
    super.updated(changed);
    autoAssistant(this, this.store, 'alarm');
  }
  override disconnectedCallback(): void {
    super.disconnectedCallback();
    clearInterval(this._tick);
    this._audio?.pause();
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
      .blkb .group {
        background: var(--hr-surface-2);
      }
      .blkb > p {
        color: var(--hr-label-2);
        font-size: var(--hr-text-footnote);
        line-height: 1.5;
      }
      .rl-sec {
        scroll-margin-top: 72px;
      }
      .rl-tile .foot b {
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .rl-tile .text.muted {
        color: var(--hr-label-2);
      }
      .rl-list .rl-item .go {
        margin-left: auto;
      }
      .test-row {
        display: flex;
        flex-wrap: wrap;
        gap: var(--hr-space-2);
        align-items: center;
      }
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-5);
      }
      h2.part {
        margin: var(--hr-space-4) 0 0 var(--hr-space-1);
        font-size: var(--hr-text-title2);
      }
      .lead {
        color: var(--hr-label-2);
        font-size: var(--hr-text-subhead);
        line-height: 1.5;
        margin: 0 var(--hr-space-1);
      }

      /* status */
      .hero {
        --state: var(--hr-green);
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-4);
        padding: var(--hr-space-5);
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
        background: color-mix(in srgb, var(--hr-red) 12%, var(--hr-surface));
      }
      .status {
        display: flex;
        align-items: center;
        gap: var(--hr-space-4);
      }
      .shield {
        width: 60px;
        height: 60px;
        border-radius: 18px;
        display: grid;
        place-items: center;
        flex: none;
        background: color-mix(in srgb, var(--state) var(--hr-tint), transparent);
        color: var(--state);
      }
      .status h2 {
        font-size: var(--hr-text-title1);
        color: var(--state);
      }
      .status p {
        color: var(--hr-label-2);
      }
      .count {
        font-size: 44px;
        font-weight: 800;
        color: var(--state);
        margin-left: auto;
        font-variant-numeric: tabular-nums;
      }
      .arm {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr));
        gap: var(--hr-space-2);
      }
      .arm button {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 4px;
        padding: var(--hr-space-3) var(--hr-space-4);
        border-radius: var(--hr-radius-m);
        background: var(--hr-surface-2);
        text-align: left;
      }
      .arm button .ic {
        color: var(--hr-accent);
      }
      .arm button b {
        font-size: var(--hr-text-body);
      }
      .arm button span {
        font-size: var(--hr-text-caption);
        color: var(--hr-label-2);
        line-height: 1.35;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--hr-space-2);
        align-items: center;
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
      .exception {
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
      }

      /* foldable blocks */
      details.blk {
        scroll-margin-top: 72px;
        background: var(--hr-surface);
        border-radius: var(--hr-radius-l);
        box-shadow: var(--hr-shadow-1);
      }
      details.blk > summary {
        display: flex;
        align-items: center;
        gap: var(--hr-space-3);
        padding: var(--hr-space-4);
        cursor: pointer;
        list-style: none;
      }
      details.blk > summary::-webkit-details-marker {
        display: none;
      }
      details.blk > summary .grow {
        flex: 1;
        min-width: 0;
      }
      details.blk > summary .grow b {
        display: block;
        font-size: var(--hr-text-body);
      }
      details.blk > summary .grow span {
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
      }
      details.blk > summary > .ic:last-child {
        transition: transform var(--hr-dur) var(--hr-ease);
        color: var(--hr-label-3);
      }
      details.blk[open] > summary > .ic:last-child {
        transform: rotate(180deg);
      }
      .inner {
        padding: 0 var(--hr-space-4) var(--hr-space-4);
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-3);
      }
      .inner > p {
        color: var(--hr-label-2);
        font-size: var(--hr-text-footnote);
        line-height: 1.5;
      }
      .inner .group {
        background: var(--hr-surface-2);
      }
      details.sub > summary {
        display: flex;
        align-items: center;
        gap: var(--hr-space-2);
        padding: var(--hr-space-2) var(--hr-space-1);
        cursor: pointer;
        list-style: none;
        font-size: var(--hr-text-footnote);
        font-weight: 600;
        color: var(--hr-label-2);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      details.opt {
        background: var(--hr-surface);
        border-radius: var(--hr-radius-m, 12px);
      }
      details.opt > summary {
        display: flex;
        align-items: center;
        gap: var(--hr-space-2);
        padding: var(--hr-space-3);
        cursor: pointer;
        list-style: none;
      }
      details.opt > summary::-webkit-details-marker {
        display: none;
      }
      details.opt > summary .t {
        font-weight: 600;
        flex: 1;
      }
      details.opt > summary .muted {
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
        text-align: right;
      }
      details.opt[open] > summary svg {
        transform: rotate(180deg);
      }
      details.opt > :not(summary) {
        margin: 0 var(--hr-space-3) var(--hr-space-3);
      }
      details.opt p {
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
      }
      details.sub > summary::-webkit-details-marker {
        display: none;
      }
      details.sub > summary .spacer {
        flex: 1;
      }
      details.sub > summary button {
        text-transform: none;
        letter-spacing: 0;
        color: var(--hr-accent);
        font-weight: 600;
        padding: 2px 6px;
      }
      .row .box {
        color: var(--hr-label-3);
      }
      .row .box.on {
        color: var(--hr-accent);
      }
      .row.wrap {
        flex-wrap: wrap;
      }
      .row.wrap .grow {
        min-width: 200px;
      }
      .stepper {
        display: inline-flex;
        align-items: center;
        gap: var(--hr-space-2);
      }
      .stepper output {
        min-width: 64px;
        text-align: center;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .stepper button {
        width: 34px;
        height: 34px;
        border-radius: 50%;
        background: var(--hr-fill);
        font-size: 18px;
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .chips button {
        min-height: 34px;
        padding: 0 12px;
        border-radius: var(--hr-radius-full);
        background: var(--hr-fill);
        font-size: var(--hr-text-footnote);
        font-weight: 600;
      }
      .chips button[aria-pressed='true'] {
        background: var(--hr-accent);
        color: var(--hr-on-accent);
      }
      textarea,
      input.text,
      input[type='time'] {
        border: 0;
        border-radius: var(--hr-radius-s);
        background: var(--hr-surface-2);
        padding: 10px 12px;
        font-size: var(--hr-text-subhead);
        color: var(--hr-label);
      }
      textarea,
      input.text {
        width: 100%;
      }
      textarea {
        min-height: 56px;
        resize: vertical;
      }
      .tone .play {
        width: 36px;
        height: 36px;
        border-radius: 50%;
        display: grid;
        place-items: center;
        background: color-mix(in srgb, var(--hr-accent) var(--hr-tint), transparent);
        color: var(--hr-accent);
      }
      .form {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-2);
      }
      .form label,
      label.form {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
        font-weight: 600;
      }
      .form .btn {
        align-self: flex-start;
      }
      .label {
        font-size: var(--hr-text-footnote);
        font-weight: 600;
        color: var(--hr-label-2);
        margin: var(--hr-space-2) var(--hr-space-1) 0;
      }
      .empty {
        padding: var(--hr-space-3);
        color: var(--hr-label-2);
        font-size: var(--hr-text-subhead);
      }
      .explain ol {
        margin: 0;
        padding-left: 1.2em;
        display: flex;
        flex-direction: column;
        gap: 6px;
        line-height: 1.5;
        font-size: var(--hr-text-subhead);
      }
      .explain b {
        color: var(--hr-label);
      }
      .setup {
        padding: var(--hr-space-6);
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-3);
        align-items: flex-start;
      }
      .setup p {
        color: var(--hr-label-2);
        line-height: 1.5;
        max-width: 60ch;
      }
      .log .row {
        align-items: flex-start;
      }
      .log time {
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
        min-width: 84px;
        padding-top: 2px;
      }
      .search {
        width: 100%;
        border: 0;
        border-radius: var(--hr-radius-s);
        background: var(--hr-surface-2);
        padding: 0 12px;
        min-height: 40px;
        font-size: var(--hr-text-subhead);
        color: var(--hr-label);
      }
      /* read-only settings for everyone but a Home Assistant admin */
      .ro {
        opacity: 0.6;
      }
      .ro-note {
        margin: var(--hr-space-3) 0 0;
      }
      .devpin p {
        margin: 0 0 var(--hr-space-2);
      }
      .row-pin {
        display: flex;
        flex-wrap: wrap;
        gap: var(--hr-space-2);
      }
      .row-pin input {
        flex: 1 1 140px;
        border: 0;
        border-radius: var(--hr-radius-s);
        background: var(--hr-surface-2);
        padding: 0 12px;
        min-height: 40px;
        font-size: var(--hr-text-subhead);
        color: var(--hr-label);
      }
    `,
  ];

  // ------------------------------------------------------------------ helpers
  private get cfg(): AlarmConfig {
    return this.store.alarm!.config;
  }

  private _save(patch: Partial<AlarmConfig> & { code?: string | null; remove_device?: string }) {
    // the server refuses e.g. "PIN" without a PIN: say why
    this.store.alarmConfig(patch as Partial<AlarmConfig>).catch((e: Error) => fire(this, 'hr-toast', e.message.replace(/^invalid: /, '')));
  }

  private _saveMode(m: AlarmMode, patch: Partial<AlarmModeConfig>) {
    this._save({ modes: { ...this.cfg.modes, [m]: { ...this.cfg.modes[m], ...patch } } });
  }

  private _toggleIn(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  }

  private _check(on: boolean, label: string, sub: string | undefined, toggle: () => void): TemplateResult {
    return html`<button class="row" @click=${toggle} aria-pressed=${on ? 'true' : 'false'}>
      <span class="box ${on ? 'on' : ''}">${icon(on ? mdiCheckboxMarked : mdiCheckboxBlankOutline, 24)}</span>
      <span class="grow"><div class="title">${label}</div>${sub ? html`<div class="sub">${sub}</div>` : nothing}</span>
    </button>`;
  }

  /** a found device: tick it, or change what it was detected as / exclude it (counts everywhere) */
  private _checkFix(on: boolean, i: { entity_id: string; name: string; sub?: string }, toggle: () => void): TemplateResult {
    return html`<div class="row fixrow">
      <button class="pick" @click=${toggle} aria-pressed=${on ? 'true' : 'false'}>
        <span class="box ${on ? 'on' : ''}">${icon(on ? mdiCheckboxMarked : mdiCheckboxBlankOutline, 24)}</span>
        <span class="grow"><div class="title">${i.name}</div>${i.sub ? html`<div class="sub">${i.sub}</div>` : nothing}</span>
      </button>
      ${this.store.admin ? fixButton(this, i.entity_id) : nothing}
    </div>`;
  }

  private _stepper(value: number, unit: string, set: (v: number) => void, step = 5, min = 0, max = 600) {
    return html`<span class="stepper">
      <button aria-label=${t('alarm.less')} @click=${() => set(Math.max(min, value - step))}>−</button>
      <output>${value} ${unit}</output>
      <button aria-label=${t('alarm.more')} @click=${() => set(Math.min(max, value + step))}>+</button>
    </span>`;
  }

  private _switch(on: boolean, label: string, toggle: () => void) {
    return html`<button class="switch" role="switch" aria-label=${label} aria-checked=${on ? 'true' : 'false'} @click=${toggle}></button>`;
  }

  /** a block in a pop-up: title over a box (the summary goes to the tile or the row that opens it) */
  private _block(title: string, _summary: string, body: TemplateResult, _open = false, id?: string) {
    return html`<section class="rl-sec" id=${id ?? nothing}>
      <h3>${title}</h3>
      <div class="rl-box blkb">${body}</div>
    </section>`;
  }

  /** a foldable list of devices with "all / none" */
  private _list(title: string, items: { entity_id: string; name: string; sub?: string }[], selected: string[], set: (next: string[]) => void, open = false) {
    if (!items.length) return nothing;
    const n = items.filter((i) => selected.includes(i.entity_id)).length;
    return html`<details class="sub" ?open=${open}>
      <summary>
        <span>${title}</span><span class="muted">${t('alarm.n_of', { n, total: items.length })}</span><span class="spacer"></span>
        <button @click=${(e: Event) => (e.preventDefault(), set([...new Set([...selected, ...items.map((i) => i.entity_id)])]))}>${t('alarm.select_all')}</button>
        <button @click=${(e: Event) => (e.preventDefault(), set(selected.filter((x) => !items.some((i) => i.entity_id === x))))}>${t('alarm.select_none')}</button>
      </summary>
      <div class="group">${items.map((i) => this._checkFix(selected.includes(i.entity_id), i, () => set(this._toggleIn(selected, i.entity_id))))}</div>
    </details>`;
  }

  private _devs(kind: string) {
    return this.store.devices.filter((d) => d.kind === kind).map((d) => ({ entity_id: d.entity_id, name: d.name, sub: [this.store.room(d.room)?.name, d.detail].filter(Boolean).join(' · ') }));
  }

  private async _arm(mode: AlarmMode, force = false) {
    this._busy = true;
    this._msg = '';
    this._testing = false;
    try {
      const res = await this.store.alarmArm(mode, force);
      this._open = !res.ok && res.error === 'open' ? { mode, list: res.open ?? [] } : null;
      if (!res.ok && res.error !== 'open') this._msg = res.error === 'not_set_up' ? t('alarm.not_set_up') : String(res.error);
    } finally {
      this._busy = false;
    }
  }

  private _preview(tone: string) {
    const url = `${this.store.alarm?.sounds_url ?? '/house_rules_sounds'}/${tone}.mp3`;
    if (this._playing === tone) {
      this._audio?.pause();
      this._playing = '';
      return;
    }
    this._audio?.pause();
    this._audio = new Audio(url);
    this._audio.volume = 0.5;
    this._audio.onended = () => (this._playing = '');
    this._audio.play().catch(() => (this._playing = ''));
    this._playing = tone;
  }

  // ------------------------------------------------------------------ top
  private _hero() {
    const a = this.store.alarm!;
    const armed = a.state.startsWith('armed_');
    const cls = a.state === 'disarmed' ? '' : armed ? 'armed' : a.state;
    const left = a.until ? Math.max(0, Math.ceil(a.until - this._now)) : null;
    const ic = a.state === 'triggered' ? mdiAlertOctagon : a.state === 'disarmed' ? mdiShieldOffOutline : MODE_ICON[a.mode ?? 'away'];
    const sub =
      a.state === 'triggered'
        ? `${t('alarm.triggered_by', { cause: a.cause_name ?? t('alarm.by_hand') })}${a.silenced ? ` · ${t('alarm.siren_off')}` : ''}`
        : a.state === 'pending'
          ? t('alarm.pending_now', { cause: a.cause_name ?? t('alarm.a_sensor') })
          : a.state === 'arming'
            ? t('alarm.arming_now')
            : `${t('alarm.since', { time: relTime(new Date(a.since * 1000).toISOString()) })}${a.bypassed.length ? ` · ${t('alarm.bypassed', { n: a.bypassed.length })}` : ''}${a.state === 'disarmed' && this._names(this.cfg.presence?.persons ?? 'everyone') ? ` · ${t('alarm.hero_counted', { who: this._names(this.cfg.presence?.persons ?? 'everyone') })}` : ''}`;
    return html`<div class="card hero ${cls}">
      <div class="status">
        <span class="shield">${icon(ic, 32)}</span>
        <div><h2>${a.label}</h2><p>${sub}</p></div>
        ${left != null && (a.state === 'arming' || a.state === 'pending') ? html`<span class="count">${left}</span>` : nothing}
      </div>
      ${a.state === 'disarmed'
        ? html`<div class="arm">
            ${(['away', 'night', 'home'] as AlarmMode[]).map(
              (m) => html`<button ?disabled=${this._busy} @click=${() => this._arm(m)}>${icon(MODE_ICON[m], 24)}<b>${t('alarm.arm_mode', { mode: MODE_LABEL(m) })}</b><span>${MODE_HINT(m)}</span></button>`,
            )}
          </div>`
        : html`<div class="actions">
            <button class="btn primary" @click=${() => (this._confirm = true)}>${icon(mdiShieldOffOutline, 18)}${t('alarm.disarm')}</button>
            ${a.state === 'triggered' && !a.silenced ? html`<button class="btn danger" @click=${() => this.store.alarmSilence()}>${t('alarm.silence')}</button>` : nothing}
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
      ${a.settling && a.state !== 'disarmed'
        ? html`<span class="exception">${t('alarm.settling')}</span>`
        : nothing}
      ${a.last_exception && Date.now() / 1000 - a.last_exception.at < 86400
        ? html`<span class="exception">${t('alarm.last_exception', { time: relTime(new Date(a.last_exception.at * 1000).toISOString()), sensor: a.last_exception.sensor, reason: a.last_exception.reason })}</span>`
        : nothing}
      <div class="actions">
        <a class="btn small" href="/hausregeln/alarm" @click=${this._toCenter}>${icon(mdiOpenInNew, 16)}${t('alarm.open_center')}</a>
      </div>
    </div>`;
  }

  private _toCenter = (e: Event) => {
    e.preventDefault();
    history.pushState(null, '', '/hausregeln/alarm');
    window.dispatchEvent(new CustomEvent('location-changed', { detail: { replace: false } }));
  };

  private _explain() {
    return html`<div class="rl-box explain">
      <ol>
        ${(['explain_arm_html', 'explain_trip_html', 'explain_alarm_html', 'explain_smart_html', 'explain_disarm_html'] as const).map((k) => html`<li>${unsafeHTML(t(`alarm.${k}`))}</li>`)}
      </ol>
    </div>`;
  }

  /** check list of persons, 'everyone' when all are ticked */
  private _persons(sel: 'everyone' | string[], set: (next: 'everyone' | string[]) => void, sub: (p: { phone?: string; where: string }) => string) {
    const all = this.store.persons.map((p) => p.id);
    const isOn = (id: string) => sel === 'everyone' || sel.includes(id);
    const toggle = (id: string) => {
      const next = this._toggleIn(sel === 'everyone' ? all : sel, id);
      set(next.length === all.length ? 'everyone' : next);
    };
    return html`<div class="group">
      ${this.store.persons.length ? this.store.persons.map((p) => this._check(isOn(p.id), p.name, sub(p), () => toggle(p.id))) : html`<div class="empty">${t('alarm.no_persons')}</div>`}
    </div>`;
  }

  /** one kind of message: on/off and who gets it ("like the alarm" or own choice) */
  private _recipients(kind: 'pending' | 'armed' | 'disarmed' | 'test', title: string, sub: string, flag?: 'pre_alarm' | 'armed' | 'disarmed') {
    const n = this.cfg.notify;
    const key = `${kind}_persons` as const;
    const sel = (n[key] ?? 'same') as 'same' | 'everyone' | string[];
    const on = flag ? !!n[flag] : true;
    const names = sel === 'same' ? t('alarm.like_alarm_lc') : sel === 'everyone' ? t('common.everyone') : this.store.persons.filter((p) => sel.includes(p.id)).map((p) => p.name).join(', ') || t('alarm.nobody');
    return html`<details class="opt">
      <summary><span class="t">${title}</span><span class="muted">${on ? names : t('alarm.off_lc')}</span>${icon(mdiChevronDown, 18)}</summary>
      ${flag
        ? html`<div class="group"><div class="row"><span class="grow"><div class="title">${t('alarm.report_x', { what: title })}</div><div class="sub">${sub}</div></span>${this._switch(on, title, () => this._save({ notify: { ...n, [flag]: !on } }))}</div></div>`
        : html`<p>${sub}</p>`}
      ${on
        ? html`<div class="seg">
              <button aria-pressed=${sel === 'same' ? 'true' : 'false'} @click=${() => this._save({ notify: { ...n, [key]: 'same' } })}>${t('alarm.like_alarm')}</button>
              <button aria-pressed=${sel !== 'same' ? 'true' : 'false'} @click=${() => this._save({ notify: { ...n, [key]: sel === 'same' ? (n.persons === 'everyone' ? 'everyone' : [...n.persons]) : sel } })}>${t('alarm.own_choice')}</button>
            </div>
            ${sel !== 'same' ? this._persons(sel, (next) => this._save({ notify: { ...n, [key]: next } }), (p) => (p.phone ? t('alarm.phone', { phone: p.phone }) : t('alarm.no_phone'))) : nothing}`
        : nothing}
    </details>`;
  }

  private _events(events: string[], set: (next: string[]) => void) {
    const all = ['triggered', 'pending', 'armed', 'disarmed', 'test'];
    return html`<span class="label">${t('alarm.on_events')}</span>
      <div class="chips">${all.map((id) => html`<button aria-pressed=${events.includes(id) ? 'true' : 'false'} @click=${() => set(this._toggleIn(events, id))}>${t(`alarm.event_${id}` as I18nKey)}</button>`)}</div>`;
  }

  private async _testChannel(name: string) {
    this._msg = t('alarm.test_sending');
    this._testing = true;
    const r = await this.store.alarmChannelTest(name).catch((e) => ({ ok: false, errors: [(e as Error).message] }));
    this._msg = r.ok ? (r.errors.length ? t('alarm.test_sent_errors', { errors: r.errors.join('; ') }) : t('alarm.test_sent_dot')) : t('common.error', { error: r.errors.join('; ') });
    fire(this, 'hr-toast', r.ok ? t('alarm.test_sent') : t('alarm.test_failed'));
  }

  /** mail, Telegram, Signal, other notify services */
  private _channels() {
    const ch = this.cfg.channels;
    if (!ch) return nothing;
    const save = (key: keyof typeof ch, patch: Record<string, unknown>) => this._save({ channels: { ...ch, [key]: { ...ch[key], ...patch } } });
    const on = (['email', 'telegram', 'signal', 'services'] as const).filter((k) => ch[k].on);
    const label = { email: t('alarm.ch_mail'), telegram: 'Telegram', signal: 'Signal', services: t('alarm.ch_services') };
    const services = this.store.alarm?.notify_services ?? [];
    const list = (v: string) => v.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
    return this._block(
      t('alarm.channels_title'),
      on.length ? on.map((k) => label[k]).join(', ') : t('alarm.channels_only_app'),
      html`<p>${t('alarm.channels_lead')}</p>
        ${this._msg && this._testing ? html`<p class="muted">${this._msg}</p>` : nothing}

        <details class="opt">
          <summary><span class="t">${t('alarm.ch_mail')}</span><span class="muted">${ch.email.on ? ch.email.to.join(', ') || t('alarm.no_recipient') : t('alarm.off_lc')}</span>${icon(mdiChevronDown, 18)}</summary>
          <div class="group"><div class="row"><span class="grow"><div class="title">${t('alarm.mail_send')}</div><div class="sub">${t('alarm.mail_send_sub')}</div></span>${this._switch(ch.email.on, t('alarm.ch_mail'), () => save('email', { on: !ch.email.on }))}</div></div>
          ${ch.email.on
            ? html`<div class="form">
                  <label>${t('alarm.mail_to')}<input class="text" id="mail-to" .value=${ch.email.to.join(', ')} placeholder=${t('alarm.mail_to_ph')} @change=${(e: Event) => save('email', { to: list((e.target as HTMLInputElement).value) })} /></label>
                  <label>${t('alarm.mail_host')}<input class="text" id="mail-host" .value=${ch.email.host} placeholder=${t('alarm.mail_host_ph')} @change=${(e: Event) => save('email', { host: (e.target as HTMLInputElement).value })} /></label>
                  <div class="seg">
                    ${(['starttls', 'ssl', 'none'] as const).map(
                      (s) => html`<button aria-pressed=${ch.email.security === s ? 'true' : 'false'} @click=${() => save('email', { security: s, port: s === 'ssl' ? 465 : s === 'starttls' ? 587 : 25 })}>${{ starttls: 'STARTTLS (587)', ssl: 'SSL (465)', none: t('alarm.mail_plain') }[s]}</button>`,
                    )}
                  </div>
                  <label>Port<input class="text" id="mail-port" type="number" .value=${String(ch.email.port)} @change=${(e: Event) => save('email', { port: Number((e.target as HTMLInputElement).value) })} /></label>
                  <label>${t('alarm.mail_user')}<input class="text" id="mail-user" autocomplete="off" .value=${ch.email.user} @change=${(e: Event) => save('email', { user: (e.target as HTMLInputElement).value })} /></label>
                  <label>${t('alarm.mail_pass')}<input class="text" id="mail-pass" type="password" autocomplete="new-password" placeholder=${ch.email.has_password ? t('alarm.saved_lc') : ''} @change=${(e: Event) => {
                    const el = e.target as HTMLInputElement;
                    if (el.value) save('email', { password: el.value });
                    el.value = '';
                  }} /></label>
                  <label>${t('alarm.mail_from')}<input class="text" id="mail-from" .value=${ch.email.sender} @change=${(e: Event) => save('email', { sender: (e.target as HTMLInputElement).value })} /></label>
                </div>
                ${this._events(ch.email.events, (next) => save('email', { events: next }))}
                <button class="btn small tinted" @click=${() => this._testChannel('email')}>${t('alarm.mail_test')}</button>`
            : nothing}
        </details>

        <details class="opt">
          <summary><span class="t">${t('alarm.tg_title')}</span><span class="muted">${ch.telegram.on ? ch.telegram.users.join(', ') || t('alarm.no_name') : t('alarm.off_lc')}</span>${icon(mdiChevronDown, 18)}</summary>
          <div class="group"><div class="row"><span class="grow"><div class="title">${t('alarm.tg_report')}</div><div class="sub">${t('alarm.tg_report_sub')}</div></span>${this._switch(ch.telegram.on, 'Telegram', () => save('telegram', { on: !ch.telegram.on }))}</div></div>
          ${ch.telegram.on
            ? html`<p>${unsafeHTML(t('alarm.tg_setup_html'))}</p>
                <label class="form">${t('alarm.tg_users')}<input class="text" id="tg-users" .value=${ch.telegram.users.join(', ')} placeholder="@name" @change=${(e: Event) => save('telegram', { users: list((e.target as HTMLInputElement).value) })} /></label>
                <div class="group">
                  <div class="row"><span class="grow"><div class="title">${t('alarm.tg_call')}</div></span>${this._switch(ch.telegram.call, t('alarm.tg_call'), () => save('telegram', { call: !ch.telegram.call }))}</div>
                  <div class="row"><span class="grow"><div class="title">${t('alarm.tg_text')}</div></span>${this._switch(ch.telegram.text, t('alarm.tg_text_short'), () => save('telegram', { text: !ch.telegram.text }))}</div>
                </div>
                ${this._events(ch.telegram.events, (next) => save('telegram', { events: next }))}
                <button class="btn small tinted" @click=${() => this._testChannel('telegram')}>${t('alarm.test_send')}</button>`
            : nothing}
        </details>

        <details class="opt">
          <summary><span class="t">Signal</span><span class="muted">${ch.signal.on ? ch.signal.numbers.map((n) => n.phone).join(', ') || t('alarm.no_number') : t('alarm.off_lc')}</span>${icon(mdiChevronDown, 18)}</summary>
          <div class="group"><div class="row"><span class="grow"><div class="title">${t('alarm.sig_title')}</div><div class="sub">${t('alarm.sig_sub')}</div></span>${this._switch(ch.signal.on, 'Signal', () => save('signal', { on: !ch.signal.on }))}</div></div>
          ${ch.signal.on
            ? html`<p>${unsafeHTML(t('alarm.sig_key_html'))}</p>
                <div class="group">
                  ${ch.signal.numbers.map(
                    (n, i) => html`<div class="row wrap">
                      <span class="grow"><div class="title">${n.phone}</div><div class="sub">${n.has_key ? t('alarm.sig_key_saved') : t('alarm.sig_no_key')}</div></span>
                      <button class="btn small" @click=${() => save('signal', { numbers: ch.signal.numbers.filter((_x, j) => j !== i) })}>${t('common.remove')}</button>
                    </div>`,
                  )}
                </div>
                <div class="form">
                  <label>${t('alarm.sig_number')}<input class="text" id="sig-phone" placeholder=${t('alarm.sig_number_ph')} /></label>
                  <label>${t('alarm.sig_key')}<input class="text" id="sig-key" type="password" autocomplete="off" /></label>
                  <button
                    class="btn small"
                    @click=${() => {
                      const ph = this.renderRoot.querySelector<HTMLInputElement>('#sig-phone');
                      const key = this.renderRoot.querySelector<HTMLInputElement>('#sig-key');
                      if (ph?.value) save('signal', { numbers: [...ch.signal.numbers, { phone: ph.value, apikey: key?.value ?? '' }] });
                      if (ph) ph.value = '';
                      if (key) key.value = '';
                    }}
                  >
                    ${t('common.add')}
                  </button>
                </div>
                ${this._events(ch.signal.events, (next) => save('signal', { events: next }))}
                <button class="btn small tinted" @click=${() => this._testChannel('signal')}>${t('alarm.test_send')}</button>`
            : nothing}
        </details>

        <details class="opt">
          <summary><span class="t">${t('alarm.svc_title')}</span><span class="muted">${ch.services.on ? ch.services.list.join(', ') || t('alarm.svc_none') : t('alarm.off_lc')}</span>${icon(mdiChevronDown, 18)}</summary>
          <div class="group"><div class="row"><span class="grow"><div class="title">${t('alarm.svc_more')}</div><div class="sub">${t('alarm.svc_more_sub')}</div></span>${this._switch(ch.services.on, t('alarm.svc_short'), () => save('services', { on: !ch.services.on }))}</div></div>
          ${ch.services.on
            ? html`<div class="group">
                  ${services.length
                    ? services.map((s) => this._check(ch.services.list.includes(s), s, undefined, () => save('services', { list: this._toggleIn(ch.services.list, s) })))
                    : html`<div class="empty">${t('alarm.svc_empty')}</div>`}
                </div>
                ${this._events(ch.services.events, (next) => save('services', { events: next }))}
                <button class="btn small tinted" @click=${() => this._testChannel('services')}>${t('alarm.test_send')}</button>`
            : nothing}
        </details>`,
    );
  }

  private get _presenceLabel(): string {
    const sel = this.cfg.presence?.persons ?? 'everyone';
    if (sel === 'everyone') return t('alarm.all_persons');
    const names = this.store.persons.filter((p) => sel.includes(p.id)).map((p) => p.name);
    return names.length ? names.join(', ') : t('alarm.nobody');
  }

  // ------------------------------------------------------------------ per mode
  /** which mode the per-mode groups show (shared by "Sensoren je Modus", "Reaktion" and the automatic) */
  private _modeSeg() {
    const m = this._mode;
    return html`<div class="seg" role="tablist" aria-label=${t('alarm.per_mode')}>
        ${(['away', 'night', 'home'] as AlarmMode[]).map((x) => html`<button role="tab" aria-pressed=${x === m ? 'true' : 'false'} @click=${() => (this._mode = x)}>${icon(MODE_ICON[x], 16)}${MODE_LABEL(x)}</button>`)}
      </div>
      <p class="lead">${MODE_HINT(m)}</p>`;
  }

  /** the settings of one mode: sensors (what triggers, times, exceptions), reaction, automatic arming */
  private _modePart(part: 'sensors' | 'times' | 'smart' | 'reaction' | 'activate' | 'auto') {
    const m = this._mode;
    const mc = this.cfg.modes[m];
    const lightItems = this._devs('light');
    const extra = ACTIVATE_DOMAINS.map((d) => ({ d, label: t(`alarm.activate_${d}` as I18nKey), items: this.store.extraEntities(d) })).filter((x) => x.items.length);
    const q = this._q.trim().toLowerCase();
    const filt = <T extends { name: string }>(list: T[]) => (q ? list.filter((i) => i.name.toLowerCase().includes(q)) : list);
    const house = (key: 'arm_on' | 'disarm_on') => html`<div class="chips">
      ${HOUSE.map((id) => html`<button aria-pressed=${mc.auto[key].includes(id) ? 'true' : 'false'} @click=${() => this._saveMode(m, { auto: { ...mc.auto, [key]: this._toggleIn(mc.auto[key], id) } })}>${HOUSE_LABEL(id)}</button>`)}
    </div>`;
    const sensorCount = mc.sensors.length;
    const reaction = mc.reaction ?? (mc.loud ? 'loud' : 'silent');
    const sensors = this._block(
        t('alarm.what_triggers'),
        t('alarm.n_sensors', { n: sensorCount }),
        html`<p>${t('alarm.what_triggers_lead', { mode: MODE_LABEL(m) })}</p>
          ${this._list(t('alarm.list_doors'), this._devs('door'), mc.sensors, (next) => this._saveMode(m, { sensors: next }), true)}
          ${this._list(t('alarm.list_windows'), this._devs('window'), mc.sensors, (next) => this._saveMode(m, { sensors: next }))}
          ${this._list(t('alarm.list_motion'), this._devs('motion'), mc.sensors, (next) => this._saveMode(m, { sensors: next }))}
          ${this._list(t('alarm.list_presence'), this._devs('presence'), mc.sensors, (next) => this._saveMode(m, { sensors: next }))}`,
        true,
      );
    const times = this._block(
        t('alarm.times'),
        t('alarm.times_sub', { exit: mc.exit_delay, entry: mc.entry_delay }),
        html`<div class="group">
          <div class="row wrap">
            <span class="grow"><div class="title">${t('alarm.exit_delay')}</div><div class="sub">${t('alarm.exit_delay_sub')}</div></span>
            ${this._stepper(mc.exit_delay, 's', (v) => this._saveMode(m, { exit_delay: v }), 15)}
          </div>
          <div class="row wrap">
            <span class="grow"><div class="title">${t('alarm.entry_delay')}</div><div class="sub">${t('alarm.entry_delay_sub')}</div></span>
            ${this._stepper(mc.entry_delay, 's', (v) => this._saveMode(m, { entry_delay: v }), 5)}
          </div>
        </div>`,
      );
    const loudness = this._block(
        t('alarm.reaction_title'),
        t(`alarm.reaction_sum_${reaction}` as I18nKey),
        html`<div class="seg">
            <button aria-pressed=${reaction === 'loud' ? 'true' : 'false'} @click=${() => this._saveMode(m, { reaction: 'loud', loud: true })}>${t('alarm.reaction_loud')}</button>
            <button aria-pressed=${reaction === 'silent' ? 'true' : 'false'} @click=${() => this._saveMode(m, { reaction: 'silent', loud: false })}>${t('alarm.reaction_silent')}</button>
            <button aria-pressed=${reaction === 'notify' ? 'true' : 'false'} @click=${() => this._saveMode(m, { reaction: 'notify', loud: false })}>${t('alarm.reaction_notify')}</button>
          </div>
          <p>
            ${t(`alarm.reaction_text_${reaction}` as I18nKey)}
          </p>`,
      );
    const lights = this._block(
        t('alarm.lights_title'),
        mc.lights.mode === 'none' ? t('alarm.lights_sum_none') : `${t(`alarm.lights_sum_${mc.lights.mode}` as I18nKey)} · ${mc.lights.entities.length ? t('alarm.n_lights', { n: mc.lights.entities.length }) : t('alarm.all_lights_lc')}`,
        html`<div class="seg">
            ${(['none', 'on', 'flash', 'red'] as const).map((v) => html`<button aria-pressed=${mc.lights.mode === v ? 'true' : 'false'} @click=${() => this._saveMode(m, { lights: { ...mc.lights, mode: v } })}>${t(`alarm.lights_${v}` as I18nKey)}</button>`)}
          </div>
          ${mc.lights.mode !== 'none'
            ? html`<div class="seg">
                  <button aria-pressed=${!mc.lights.entities.length ? 'true' : 'false'} @click=${() => this._saveMode(m, { lights: { ...mc.lights, entities: [] } })}>${t('alarm.all_lights')}</button>
                  <button aria-pressed=${mc.lights.entities.length ? 'true' : 'false'} @click=${() => this._saveMode(m, { lights: { ...mc.lights, entities: mc.lights.entities.length ? mc.lights.entities : lightItems.slice(0, 1).map((l) => l.entity_id) } })}>${t('alarm.only_some')}</button>
                </div>
                ${mc.lights.entities.length
                  ? html`${this.store.rooms.map((r) =>
                      this._list(
                        r.name,
                        lightItems.filter((l) => this.store.device(l.entity_id)?.room === r.id),
                        mc.lights.entities,
                        (next) => this._saveMode(m, { lights: { ...mc.lights, entities: next } }),
                      ),
                    )}
                    ${this._list(t('alarm.no_room'), lightItems.filter((l) => !this.store.device(l.entity_id)?.room), mc.lights.entities, (next) => this._saveMode(m, { lights: { ...mc.lights, entities: next } }))}`
                  : nothing}`
            : nothing}`,
      );
    const activate = this._block(
        t('alarm.activate_title'),
        mc.activate.length ? t('alarm.n_devices', { n: mc.activate.length }) : t('alarm.activate_eg'),
        html`<p>${t('alarm.activate_lead')}</p>
          <input class="search" id="alarm-activate-search" placeholder=${t('common.search')} .value=${this._q} @input=${(e: Event) => (this._q = (e.target as HTMLInputElement).value)} />
          ${extra.length
            ? extra.map(({ label, items }) => this._list(label, filt(items), mc.activate, (next) => this._saveMode(m, { activate: next }), !!q))
            : html`<div class="empty">${t('alarm.activate_empty')}</div>`}`,
      );
    const smart = this._block(
        t('alarm.smart_title'),
        [mc.smart.inside.on ? t('alarm.smart_inside_lc') : '', mc.smart.arrival.on ? t('alarm.smart_arrival_lc') : ''].filter(Boolean).join(' · ') || t('alarm.off_lc'),
        html`<div class="group">
            <div class="row wrap">
              <span class="grow">
                <div class="title">${t('alarm.smart_inside')}</div>
                <div class="sub">${t('alarm.smart_inside_sub')}</div>
              </span>
              ${this._switch(mc.smart.inside.on, t('alarm.smart_inside_short'), () => this._saveMode(m, { smart: { ...mc.smart, inside: { ...mc.smart.inside, on: !mc.smart.inside.on } } }))}
            </div>
            ${mc.smart.inside.on
              ? html`<div class="row wrap"><span class="grow"><div class="sub">${t('alarm.smart_inside_window')}</div></span>${this._stepper(mc.smart.inside.seconds, 's', (v) => this._saveMode(m, { smart: { ...mc.smart, inside: { ...mc.smart.inside, seconds: v } } }), 15, 0, 600)}</div>`
              : nothing}
            <div class="row wrap">
              <span class="grow">
                <div class="title">${t('alarm.smart_arrival')}</div>
                <div class="sub">${t('alarm.smart_arrival_sub', { who: this._presenceLabel })}</div>
              </span>
              ${this._switch(mc.smart.arrival.on, t('alarm.smart_arrival_short'), () => this._saveMode(m, { smart: { ...mc.smart, arrival: { ...mc.smart.arrival, on: !mc.smart.arrival.on } } }))}
            </div>
            ${mc.smart.arrival.on
              ? html`<div class="row wrap"><span class="grow"><div class="sub">${t('alarm.smart_arrival_window')}</div></span>${this._stepper(mc.smart.arrival.minutes, t('alarm.unit_min'), (v) => this._saveMode(m, { smart: { ...mc.smart, arrival: { ...mc.smart.arrival, minutes: v } } }), 1, 0, 60)}</div>
                  <div class="row wrap">
                    <span class="grow"><div class="title">${t('alarm.smart_disarm')}</div><div class="sub">${t('alarm.smart_disarm_sub')}</div></span>
                    ${this._switch(!!mc.smart.arrival.disarm, t('alarm.smart_disarm_short'), () => this._saveMode(m, { smart: { ...mc.smart, arrival: { ...mc.smart.arrival, disarm: !mc.smart.arrival.disarm } } }))}
                  </div>`
              : nothing}
          </div>`,
      );
    const auto = this._block(
        t('alarm.auto_title'),
        [
          mc.auto.arm_away ? t('alarm.auto_sum_away') : '',
          mc.auto.arm_on.length ? t('alarm.auto_sum_modes', { modes: mc.auto.arm_on.map((x) => (HOUSE.includes(x) ? HOUSE_LABEL(x) : undefined)).join(', ') }) : '',
          mc.auto.arm_at ? t('alarm.auto_sum_at', { time: mc.auto.arm_at }) : '',
          mc.auto.disarm_home || mc.auto.disarm_on.length || mc.auto.disarm_at ? t('alarm.auto_sum_off') : '',
        ]
          .filter(Boolean)
          .join(' · ') || t('alarm.auto_sum_manual'),
        html`<div class="group">
            <div class="row wrap">
              <span class="grow"><div class="title">${t('alarm.auto_away')}</div><div class="sub">${t('alarm.auto_away_sub', { who: this._presenceLabel })}</div></span>
              ${this._switch(!!mc.auto.arm_away, t('alarm.auto_away_short'), () => this._saveMode(m, { auto: { ...mc.auto, arm_away: !mc.auto.arm_away } }))}
            </div>
            ${mc.auto.arm_away
              ? html`<div class="row wrap"><span class="grow"><div class="sub">${t('alarm.auto_away_for')}</div></span>${this._stepper(mc.auto.away_for ?? 5, t('alarm.unit_min'), (v) => this._saveMode(m, { auto: { ...mc.auto, away_for: v } }), 1, 0, 120)}</div>`
              : nothing}
            <div class="row wrap">
              <span class="grow"><div class="title">${t('alarm.auto_home')}</div><div class="sub">${t('alarm.auto_home_sub')}</div></span>
              ${this._switch(!!mc.auto.disarm_home, t('alarm.auto_home_short'), () => this._saveMode(m, { auto: { ...mc.auto, disarm_home: !mc.auto.disarm_home } }))}
            </div>
          </div>
          <span class="label">${t('alarm.auto_arm_on')}</span>
          ${house('arm_on')}
          <div class="row wrap">
            <span class="grow"><div class="title">${t('alarm.auto_arm_at')}</div></span>
            <input type="time" id="alarm-arm-at-${m}" .value=${mc.auto.arm_at || ''} @change=${(e: Event) => this._saveMode(m, { auto: { ...mc.auto, arm_at: (e.target as HTMLInputElement).value } })} />
          </div>
          <span class="label">${t('alarm.auto_disarm_on')}</span>
          ${house('disarm_on')}
          <div class="row wrap">
            <span class="grow"><div class="title">${t('alarm.auto_disarm_at')}</div></span>
            <input type="time" id="alarm-disarm-at-${m}" .value=${mc.auto.disarm_at || ''} @change=${(e: Event) => this._saveMode(m, { auto: { ...mc.auto, disarm_at: (e.target as HTMLInputElement).value } })} />
          </div>
          <div class="group">
            <div class="row">
              <span class="grow"><div class="title">${t('alarm.auto_only_auto')}</div><div class="sub">${t('alarm.auto_only_auto_sub')}</div></span>
              ${this._switch(mc.auto.only_auto, t('alarm.auto_only_auto_short'), () => this._saveMode(m, { auto: { ...mc.auto, only_auto: !mc.auto.only_auto } }))}
            </div>
          </div>
          <p>${t('alarm.auto_mode_hint_a')} <button class="btn plain small" @click=${() => fire(this, 'hr-tab', 'home')}>${t('alarm.auto_mode_link')}</button>${t('alarm.auto_mode_hint_b')}</p>`,
      );
    const body = { sensors, times, smart, reaction: html`${loudness} ${lights}`, activate, auto }[part];
    return html`${this._modeSeg()} ${body}`;
  }

  // ------------------------------------------------------------------ for all modes
  /** who counts for "alle weg", "jemand kommt heim" and "gerade heimgekommen": the residents, or a deviation */
  private _presence() {
    const s = this.store;
    const presence = this.cfg.presence?.persons ?? 'everyone';
    const follow = presence === 'everyone';
    const residents = s.persons.map((p) => p.name);
    return this._block(
      t('alarm.presence_title'),
      follow ? t('alarm.presence_follow_sum') : t('alarm.presence_own_sum', { who: this._presenceLabel }),
      html`<p>${t('alarm.presence_lead')}</p>
        <div class="seg">
          <button aria-pressed=${follow ? 'true' : 'false'} @click=${() => this._save({ presence: { persons: 'everyone' } })}>${t('alarm.presence_follow')}</button>
          <button aria-pressed=${follow ? 'false' : 'true'} ?disabled=${!s.persons.length} @click=${() => follow && this._save({ presence: { persons: s.persons.map((p) => p.id) } })}>${t('alarm.presence_own')}</button>
        </div>
        ${follow
          ? html`<p>${t('alarm.presence_counting', { who: residents.length ? residents.join(', ') : t('alarm.presence_nobody_tracked') })} <button class="btn plain small" @click=${() => fire(this, 'hr-tab', 'home#residents')}>${t('alarm.presence_link')}</button></p>`
          : this._persons(presence, (next) => this._save({ presence: { persons: next } }), (p) => `${p.where} · ${p.phone ? t('alarm.phone', { phone: p.phone }) : t('alarm.no_phone_lc')}`)}`,
      false,
      'alarm-presence',
    );
  }

  /** settings for every mode: messages (notify), sound and announcement (sound), switching off (security) */
  private _globalPart(part: 'notify' | 'cameras' | 'sound' | 'announce' | 'security') {
    const cfg = this.cfg;
    const sel = cfg.notify.persons;
    const rep = cfg.notify.repeat ?? { on: false, every: 60, max: 10, channels: false };
    const players = this.store.extraEntities('media_player');
    const cams = this.store.extraEntities('camera');
    const sirens = [
      ...this.store.extraEntities('siren'),
      ...this.store.devices.filter((d) => /sirene|siren|alarm/i.test(d.name) && d.kind === 'switch').map((d) => ({ entity_id: d.entity_id, name: d.name })),
    ];
    const tones = this.store.alarm?.tones ?? {};
    const devices = cfg.devices ?? [];
    const messages = this._block(
        t('alarm.notify_title'),
        `${sel === 'everyone' ? t('alarm.notify_sum_all') : t('alarm.notify_sum_n', { n: sel.length })}${cfg.notify.critical ? ` · ${t('alarm.notify_sum_dnd')}` : ''}${cfg.notify.pre_alarm ? ` · ${t('alarm.notify_sum_pre')}` : ''}${cfg.notify.repeat?.on ? ` · ${t('alarm.notify_sum_repeat')}` : ''}`,
        html`<span class="label">${t('alarm.notify_to')}</span>
          ${this._persons(sel, (next) => this._save({ notify: { ...cfg.notify, persons: next } }), (p) => (p.phone ? t('alarm.phone', { phone: p.phone }) : t('alarm.no_phone')))}
          <div class="group">
            <div class="row"><span class="grow"><div class="title">${t('alarm.notify_dnd')}</div><div class="sub">${t('alarm.notify_dnd_sub')}</div></span>${this._switch(cfg.notify.critical, t('alarm.notify_dnd_short'), () => this._save({ notify: { ...cfg.notify, critical: !cfg.notify.critical } }))}</div>
            <div class="row wrap">
              <span class="grow"><div class="title">${t('alarm.repeat')}</div><div class="sub">${t('alarm.repeat_sub')}</div></span>
              ${this._switch(!!rep.on, t('alarm.repeat_short'), () => this._save({ notify: { ...cfg.notify, repeat: { ...rep, on: !rep.on } } }))}
            </div>
            ${rep.on
              ? html`<div class="row wrap"><span class="grow"><div class="sub">${t('alarm.repeat_every')}</div></span>${this._stepper(rep.every, 's', (v) => this._save({ notify: { ...cfg.notify, repeat: { ...rep, every: v } } }), 30, 30, 1800)}</div>
                  <div class="row wrap"><span class="grow"><div class="sub">${t('alarm.repeat_max')}</div></span>${this._stepper(rep.max, t('alarm.unit_times'), (v) => this._save({ notify: { ...cfg.notify, repeat: { ...rep, max: v } } }), 1, 1, 60)}</div>
                  <div class="row wrap"><span class="grow"><div class="sub">${t('alarm.repeat_channels')}</div></span>${this._switch(!!rep.channels, t('alarm.repeat_channels_short'), () => this._save({ notify: { ...cfg.notify, repeat: { ...rep, channels: !rep.channels } } }))}</div>`
              : nothing}
          </div>
          <span class="label">${t('alarm.more_msgs')}</span>
          ${this._recipients('pending', t('alarm.event_pending'), t('alarm.msg_pending_sub'), 'pre_alarm')}
          ${this._recipients('armed', t('alarm.msg_armed'), t('alarm.msg_armed_sub'), 'armed')}
          ${this._recipients('disarmed', t('alarm.msg_disarmed'), t('alarm.msg_disarmed_sub'), 'disarmed')}
          ${this._recipients('test', t('alarm.event_test'), t('alarm.msg_test_sub'))}
          <p>${t('alarm.buttons_lead')}</p>
          <div class="chips">
            ${BUTTONS.map((id) => html`<button aria-pressed=${cfg.buttons.includes(id) ? 'true' : 'false'} @click=${() => this._save({ buttons: this._toggleIn(cfg.buttons, id) })}>${t(`alarm.button_${id}` as I18nKey)}</button>`)}
          </div>
          ${cfg.buttons.includes('call')
            ? html`<input class="text" id="alarm-phone" placeholder=${t('alarm.call_ph')} .value=${cfg.phone} @change=${(e: Event) => this._save({ phone: (e.target as HTMLInputElement).value })} />`
            : nothing}`,
      );
    const cameras = this._block(
        t('alarm.cameras'),
        cfg.cameras.length ? t('alarm.n_cameras', { n: cfg.cameras.length }) : t('alarm.none_chosen'),
        html`<p>${t('alarm.cameras_lead')}</p>
          <div class="group">
            ${cams.length
              ? cams.map((c) => this._check(cfg.cameras.includes(c.entity_id), c.name, undefined, () => this._save({ cameras: this._toggleIn(cfg.cameras, c.entity_id) })))
              : html`<div class="empty">${t('alarm.no_camera')}</div>`}
          </div>`,
      );
    const announce = this._block(
        t('alarm.announce'),
        cfg.announce.players.length ? t('alarm.n_speakers', { n: cfg.announce.players.length }) : t('alarm.no_speakers_lc'),
        html`<details class="sub" open>
            <summary><span>${t('alarm.speakers')}</span><span class="muted">${t('alarm.n_of', { n: cfg.announce.players.length, total: players.length })}</span></summary>
            <div class="group">
              ${players.length
                ? players.map((p) => this._check(cfg.announce.players.includes(p.entity_id), p.name, undefined, () => this._save({ announce: { ...cfg.announce, players: this._toggleIn(cfg.announce.players, p.entity_id) } })))
                : html`<div class="empty">${t('alarm.no_speakers')}</div>`}
            </div>
          </details>
          <span class="label">${t('alarm.announce_pending')}</span>
          <textarea id="alarm-pending" .value=${cfg.announce.pending_text} @change=${(e: Event) => this._save({ announce: { ...cfg.announce, pending_text: (e.target as HTMLTextAreaElement).value } })}></textarea>
          <span class="label">${t('alarm.announce_triggered')}</span>
          <textarea id="alarm-triggered" .value=${cfg.announce.triggered_text} @change=${(e: Event) => this._save({ announce: { ...cfg.announce, triggered_text: (e.target as HTMLTextAreaElement).value } })}></textarea>`,
      );
    const sound = this._block(
        t('alarm.sound_title'),
        t('alarm.sound_sum', { tone: tones[cfg.sound.tone] ?? (cfg.sound.tone === 'custom' ? t('alarm.own_tone_lc') : t('alarm.no_tone')), speakers: cfg.sound.players.length, sirens: sirens.filter((s) => cfg.sirens.includes(s.entity_id)).length }),
        html`<span class="label">${t('alarm.tone_label_a')}${icon(mdiSpeaker, 14)}${t('alarm.tone_label_b')}</span>
          <div class="group">
            ${Object.entries(tones).map(
              ([id, label]) => html`<div class="row tone">
                <button class="play" aria-label=${t('alarm.preview')} @click=${() => this._preview(id)}>${icon(this._playing === id ? mdiStop : mdiPlay, 18)}</button>
                <span class="grow"><div class="title">${label}</div></span>
                ${cfg.sound.players.length ? html`<button class="icon-btn" aria-label=${t('alarm.preview_speaker')} @click=${() => this.store.alarmPreviewTone(id, cfg.sound.players[0])}>${icon(mdiSpeaker, 18)}</button>` : nothing}
                <div class="seg">
                  <button aria-pressed=${cfg.sound.tone === id ? 'true' : 'false'} @click=${() => this._save({ sound: { ...cfg.sound, tone: id } })}>${t('alarm.event_triggered')}</button>
                  <button aria-pressed=${cfg.sound.pre_tone === id ? 'true' : 'false'} @click=${() => this._save({ sound: { ...cfg.sound, pre_tone: cfg.sound.pre_tone === id ? '' : id } })}>${t('alarm.event_pending')}</button>
                </div>
              </div>`,
            )}
            <div class="row tone">
              <span class="grow"><div class="title">${t('alarm.own_tone')}</div><div class="sub">${t('alarm.own_tone_sub')}</div></span>
              <div class="seg"><button aria-pressed=${cfg.sound.tone === 'custom' ? 'true' : 'false'} @click=${() => this._save({ sound: { ...cfg.sound, tone: 'custom' } })}>${t('alarm.event_triggered')}</button></div>
            </div>
          </div>
          ${cfg.sound.tone === 'custom'
            ? html`<input class="text" id="alarm-sound-url" placeholder="/local/alarm.mp3" .value=${cfg.sound.url} @change=${(e: Event) => this._save({ sound: { ...cfg.sound, url: (e.target as HTMLInputElement).value } })} />`
            : nothing}
          <details class="sub">
            <summary><span>${t('alarm.tone_speakers')}</span><span class="muted">${t('alarm.n_of', { n: cfg.sound.players.length, total: players.length })}</span></summary>
            <div class="group">${players.map((p) => this._check(cfg.sound.players.includes(p.entity_id), p.name, undefined, () => this._save({ sound: { ...cfg.sound, players: this._toggleIn(cfg.sound.players, p.entity_id) } })))}</div>
          </details>
          <div class="group">
            <div class="row wrap"><span class="grow"><div class="title">${t('alarm.volume')}</div></span>${this._stepper(cfg.sound.volume, '%', (v) => this._save({ sound: { ...cfg.sound, volume: v } }), 10, 0, 100)}</div>
            <div class="row wrap">
              <span class="grow"><div class="title">${t('alarm.duration')}</div><div class="sub">${t('alarm.duration_sub')}</div></span>
              ${this._stepper(Math.round(cfg.duration / 60), t('alarm.unit_min'), (v) => this._save({ duration: Math.max(1, v) * 60 }), 1, 1, 30)}
            </div>
          </div>
          <details class="sub">
            <summary><span>${t('alarm.sirens')}</span><span class="muted">${t('alarm.n_of', { n: cfg.sirens.length, total: sirens.length })}</span></summary>
            <div class="group">
              ${sirens.length
                ? sirens.map((s) => this._check(cfg.sirens.includes(s.entity_id), s.name, undefined, () => this._save({ sirens: this._toggleIn(cfg.sirens, s.entity_id) })))
                : html`<div class="empty">${t('alarm.no_siren')}</div>`}
            </div>
          </details>
          <p>${t('alarm.tones_credit')}</p>`,
      );
    const security = this._block(
        t('alarm.security_title'),
        cfg.confirm === 'none' ? t('alarm.confirm_none') : cfg.confirm === 'pin' ? (cfg.has_code ? t('alarm.sum_with_pin') : t('alarm.sum_without_pin')) : t('alarm.sum_with_device'),
        html`<p>${t('alarm.security_lead')}</p>
          ${cfg.pin_locked
            ? html`<div class="group">
                <div class="row wrap">
                  <span class="grow"><div class="title">${tn('alarm.users_locked', cfg.pin_locked)}</div><div class="sub">${t('alarm.users_locked_sub')}</div></span>
                  <button class="btn small tinted" @click=${() => this.store.alarmResetPin().catch((e: Error) => fire(this, 'hr-toast', e.message))}>${t('alarm.unlock')}</button>
                </div>
              </div>`
            : nothing}
          <div class="seg">
            <button aria-pressed=${cfg.confirm === 'none' ? 'true' : 'false'} @click=${() => this._save({ confirm: 'none' })}>${t('alarm.confirm_none')}</button>
            <button aria-pressed=${cfg.confirm === 'pin' ? 'true' : 'false'} ?disabled=${!cfg.has_code} title=${cfg.has_code ? '' : t('alarm.set_pin_first')} @click=${() => this._save({ confirm: 'pin' })}>PIN</button>
            <button aria-pressed=${cfg.confirm === 'device' ? 'true' : 'false'} ?disabled=${!cfg.has_code} title=${cfg.has_code ? '' : t('alarm.set_pin_first')} @click=${() => this._save({ confirm: 'device' })}>Face ID / Touch ID</button>
          </div>
          ${cfg.has_code ? nothing : html`<p class="muted">${t('alarm.pin_needed')}</p>`}
          <div class="group">
            <div class="row wrap">
              <span class="grow"><div class="title">${cfg.has_code ? t('alarm.pin_set') : t('alarm.no_pin')}</div><div class="sub">${t('alarm.pin_sub')}</div></span>
              <input class="text" style="width:9em" id="alarm-new-pin" type="password" inputmode="numeric" autocomplete="new-password" placeholder=${t('alarm.new_pin')} />
              <button
                class="btn small tinted"
                @click=${() => {
                  const el = this.renderRoot.querySelector<HTMLInputElement>('#alarm-new-pin');
                  // the first PIN also switches to "PIN" (a PIN without asking for it would be pointless)
                  if (el?.value) this._save({ code: el.value, ...(cfg.confirm === 'none' ? { confirm: 'pin' as const } : {}) });
                  if (el) el.value = '';
                }}
              >
                ${t('alarm.set')}
              </button>
              ${cfg.has_code ? html`<button class="btn small" @click=${() => this._save({ code: null, confirm: 'none' })}>${t('common.remove')}</button>` : nothing}
            </div>
            <div class="row">
              <span class="grow"><div class="title">${t('alarm.notify_disarm')}</div><div class="sub">${t('alarm.notify_disarm_sub')}</div></span>
              ${this._switch(cfg.notify_disarm !== false, t('alarm.notify_disarm'), () => this._save({ notify_disarm: cfg.notify_disarm === false }))}
            </div>
          </div>
          <details class="sub">
            <summary><span>${t('alarm.pin_forgot')}</span></summary>
            <p>${unsafeHTML(t('alarm.pin_forgot_1_html'))}</p>
            <p>${unsafeHTML(t('alarm.pin_forgot_2_html'))}</p>
            <p>${unsafeHTML(t('alarm.pin_forgot_3_html'))}</p>
          </details>
          ${cfg.confirm === 'device'
            ? html`<span class="label">${t('alarm.devices_label')}</span>
                <div class="group">
                  ${devices.length
                    ? devices.map(
                        (d) => html`<div class="row"><span class="grow"><div class="title">${d.name || t('alarm.device')}</div><div class="sub">${d.created ? t('alarm.device_created', { time: relTime(new Date(d.created * 1000).toISOString()) }) : ''}</div></span>
                          <button class="btn small" @click=${() => this._save({ remove_device: d.id })}>${t('common.remove')}</button></div>`,
                      )
                    : html`<div class="empty">${t('alarm.no_device')}</div>`}
                </div>
                ${passkeyAvailable()
                  ? html`<button
                      class="btn tinted"
                      style="align-self:flex-start"
                      @click=${async () => {
                        try {
                          await registerPasskey(this.store, navigator.userAgent.includes('iPhone') ? 'iPhone' : navigator.userAgent.includes('iPad') ? 'iPad' : navigator.userAgent.includes('Android') ? 'Android' : t('alarm.this_device'));
                          fire(this, 'hr-toast', t('alarm.device_added'));
                        } catch (e) {
                          this._msg = (e as Error).message;
                        }
                      }}
                    >
                      ${t('alarm.add_device')}
                    </button>`
                  : html`<p>${t('alarm.needs_https')}</p>`}`
            : nothing}`,
      );
    return { notify: messages, cameras, sound, announce, security }[part];
  }

  /** Settings are changed only by a Home Assistant admin (house_rules/alarm/config), whatever the role in Hausregeln:
   * everyone else sees them read-only and may set up their own device with the PIN. */
  private _ro(body: unknown) {
    if (this.store.haAdmin) return body;
    return html`<p class="muted ro-note">${t('alarm.ha_admin_only')}</p>
      ${this.cfg.confirm === 'device' && passkeyAvailable() ? this._deviceWithPin() : nothing}
      <div class="ro" inert>${body}</div>`;
  }

  private _devPin = '';
  private _deviceWithPin() {
    const name = navigator.userAgent.includes('iPhone') ? 'iPhone' : navigator.userAgent.includes('iPad') ? 'iPad' : navigator.userAgent.includes('Android') ? 'Android' : t('alarm.this_device');
    return html`<section class="devpin">
      <p>${t('alarm.device_with_pin')}</p>
      <div class="row-pin">
        <input type="password" inputmode="numeric" autocomplete="off" aria-label=${t('alarm.pin_placeholder')} placeholder=${t('alarm.pin_placeholder')} @input=${(e: Event) => (this._devPin = (e.target as HTMLInputElement).value)} />
        <button
          class="btn tinted"
          @click=${async () => {
            try {
              await registerPasskey(this.store, name, this._devPin);
              fire(this, 'hr-toast', t('alarm.device_added'));
            } catch (e) {
              fire(this, 'hr-toast', (e as Error).message.replace(/^unauthorized: /, ''));
            }
          }}
        >
          ${t('alarm.add_device')}
        </button>
      </div>
    </section>`;
  }

  // ------------------------------------------------------------------ tiles
  /** a tile of the page: the whole tile opens its pop-up */
  private _tile(p: Pop, ic: string, title: string, sub: string, text: unknown, chips: (string | false | null | undefined)[], cls = '') {
    const list = chips.filter(Boolean) as string[];
    return html`<div class="rl-tile ${cls}">
      <button class="rl-open" aria-label=${title} @click=${() => this._push(p)}></button>
      <div class="top">
        <span class="rl-ic">${icon(ic, 26)}</span>
        <span class="grow"><h2>${title}</h2><div class="state">${sub}</div></span>
        <span class="go">${icon(mdiChevronRight, 22)}</span>
      </div>
      ${text ? html`<div class="text">${text}</div>` : nothing}
      ${list.length ? html`<div class="foot"><span class="rl-chips">${list.map((c) => html`<span class="rl-chip">${c}</span>`)}</span></div>` : nothing}
    </div>`;
  }

  private _names(sel: 'everyone' | string[]): string {
    if (sel === 'everyone') return this.store.persons.map((p) => p.name).join(', ');
    return this.store.persons.filter((p) => sel.includes(p.id)).map((p) => p.name).join(', ');
  }

  private _tiles(on: boolean) {
    const s = this.store;
    const tiles: TemplateResult[] = [];
    if (on) {
      const cfg = this.cfg;
      const modes = ['away', 'night', 'home'] as AlarmMode[];
      const count = (m: AlarmMode) => cfg.modes[m].sensors.length;
      const reaction = (m: AlarmMode) => t(`alarm.grp_reaction_${cfg.modes[m].reaction ?? (cfg.modes[m].loud ? 'loud' : 'silent')}` as I18nKey);
      const chosen = new Set(modes.flatMap((m) => cfg.modes[m].sensors));
      const kinds = (['door', 'window', 'motion', 'presence'] as const).filter((k) => s.devices.some((d) => d.kind === k && chosen.has(d.entity_id)));
      tiles.push(
        this._tile(
          'sensors',
          mdiMotionSensor,
          t('alarm.grp_sensors'),
          t('alarm.what_triggers'),
          t('alarm.mode_line', { away: MODE_LABEL('away'), a: count('away'), night: MODE_LABEL('night'), n: count('night'), home: MODE_LABEL('home'), h: count('home') }),
          kinds.map((k) => t(`alarm.chip_${k}` as I18nKey)),
        ),
      );
      const sirens = cfg.sirens.length;
      tiles.push(
        this._tile(
          'reaction',
          mdiLightningBolt,
          t('alarm.grp_reaction'),
          t('alarm.tile_reaction_sub'),
          t('alarm.mode_line', { away: MODE_LABEL('away'), a: reaction('away'), night: MODE_LABEL('night'), n: reaction('night'), home: MODE_LABEL('home'), h: reaction('home') }),
          [
            modes.some((m) => cfg.modes[m].lights.mode !== 'none') && t('alarm.chip_light'),
            cfg.sound.players.length > 0 && t('alarm.chip_tone'),
            sirens > 0 && t('alarm.chip_siren'),
            cfg.announce.players.length > 0 && t('alarm.chip_announce'),
          ],
        ),
      );
      const sel = cfg.notify.persons;
      const who = this._names(sel);
      tiles.push(
        this._tile(
          'notify',
          mdiBellOutline,
          t('alarm.grp_notify'),
          t('alarm.tile_notify_sub'),
          who ? t('alarm.notify_line', { who }) : t('alarm.notify_line_none'),
          [cfg.notify.critical && t('alarm.notify_sum_dnd'), cfg.cameras.length > 0 && tn('alarm.cc_n_cameras', cfg.cameras.length)],
        ),
      );
      tiles.push(
        this._tile(
          'security',
          mdiLockOutline,
          t('alarm.grp_security'),
          t('alarm.tile_security_sub'),
          cfg.confirm === 'none' ? t('alarm.confirm_none_line') : cfg.confirm === 'pin' ? (cfg.has_code ? t('alarm.sum_with_pin') : t('alarm.sum_without_pin')) : t('alarm.sum_with_device'),
          [cfg.has_code ? t('alarm.chip_pin') : t('alarm.chip_no_pin'), cfg.notify_disarm !== false && t('alarm.chip_from_msg')],
        ),
      );
    }
    tiles.push(
      this._tile(
        'more',
        mdiShieldAccount,
        t('alarm.objects_title'),
        t('alarm.tile_more_sub'),
        s.objects.length ? s.objects.map((o) => `${o.name} ${o.label.toLowerCase()}`).join(' · ') : t('alarm.objects_none'),
        [t('alarm.objects_without'), s.objects.length > 0 && tn('alarm.n_objects', s.objects.length)],
      ),
    );
    const w = s.windowWarning;
    if (s.on('window_warning') && w)
      tiles.push(
        this._tile(
          'window',
          mdiWindowOpenVariant,
          t('warning.tile'),
          t('warning.tile_sub'),
          w.doors.length ? t('warning.tile_text', { doors: w.doors.map((e) => s.device(e)?.name ?? e).join(', ') }) : t('warning.tile_text_none'),
          [w.config.only_last && t('warning.only_last_short'), w.active ? t('warning.warning_now') : t('alarm.chip_on')],
          w.active ? 'warn' : '',
        ),
      );
    const log = s.history.filter((h) => h.kind === 'alarm');
    if (log.length) tiles.push(this._tile('log', mdiHistory, t('alarm.recent'), t('alarm.tile_log_sub'), log[0].what, [relTime(log[0].at)]));
    return html`<div class="rl-grid">${tiles}</div>`;
  }

  // ------------------------------------------------------------------ pop-ups
  /** a row in a pop-up that opens the next pop-up */
  private _row(p: Pop, ic: string, title: string, sub: string) {
    return html`<button class="rl-item" @click=${() => this._push(p)}>
      <span class="ico">${icon(ic, 20)}</span>
      <span class="grow"><b>${title}</b><small>${sub}</small></span>
      <span class="go">${icon(mdiChevronRight, 20)}</span>
    </button>`;
  }

  private _autoSum(): string {
    const parts = (['away', 'night', 'home'] as AlarmMode[])
      .filter((m) => {
        const a = this.cfg.modes[m].auto;
        return a.arm_away || a.arm_on.length || a.arm_at;
      })
      .map((m) => MODE_LABEL(m));
    return parts.length ? t('alarm.auto_row_on', { modes: parts.join(', ') }) : t('alarm.auto_sum_manual');
  }

  private _channelsSum(): string {
    const ch = this.cfg.channels;
    if (!ch) return t('alarm.channels_only_app');
    const label = { email: t('alarm.ch_mail'), telegram: 'Telegram', signal: 'Signal', services: t('alarm.ch_services') };
    const on = (['email', 'telegram', 'signal', 'services'] as const).filter((k) => ch[k].on);
    return on.length ? on.map((k) => label[k]).join(', ') : t('alarm.channels_only_app');
  }

  private _popView(p: Pop, on: boolean) {
    const s = this.store;
    const close = () => (this._pops = this._pops.filter((x) => x !== p));
    const done = html`<button slot="foot" class="btn primary" @click=${close}>${t('common.done')}</button>`;
    const pop = (heading: string, sub: string, body: unknown, narrow = false) =>
      html`<hr-pop heading=${heading} .sub=${sub} ?narrow=${narrow} @close=${close}>${body}${done}</hr-pop>`;
    if (p === 'more') return pop(t('alarm.objects_title'), t('alarm.grp_more_sum'), html`<hr-object-alarms .store=${s}></hr-object-alarms>`);
    if (p === 'window')
      return pop(
        t('warning.title'),
        s.windowWarning?.config ? (s.on('window_warning') ? t('alarm.chip_on') : t('alarm.off_lc')) : '',
        s.on('window_warning') ? html`<hr-window-warning .store=${s}></hr-window-warning>` : featureHint(this, 'window_warning'),
      );
    if (p === 'log') {
      const log = s.history.filter((h) => h.kind === 'alarm').slice(0, 12);
      return html`<hr-pop narrow heading=${t('alarm.recent')} @close=${close}>
        <div class="rl-list log">
          ${log.length
            ? log.map((h) => html`<div class="rl-item"><time>${relTime(h.at)}</time><span class="grow"><b>${h.what}</b><small>${h.why}</small></span></div>`)
            : html`<div class="rl-item"><span class="grow"><small>${t('alarm.nothing_yet')}</small></span></div>`}
        </div>
        <button slot="foot" class="btn" @click=${() => (close(), fire(this, 'hr-tab', 'history'))}>${t('alarm.all_history')}</button>
        ${done}
      </hr-pop>`;
    }
    if (!s.alarm) return nothing;
    const cfg = this.cfg;
    switch (p) {
      case 'basics':
        return html`<hr-pop narrow heading=${t('alarm.grp_basics')} .sub=${t('alarm.basics_sub')} @close=${close}>
          <div class="rl-list">
            ${this._row('explain', mdiBookOpenVariant, t('alarm.explain_title'), t('alarm.explain_sub'))}
            ${this._row('presence', mdiAccountGroup, t('alarm.presence_title'), (cfg.presence?.persons ?? 'everyone') === 'everyone' ? t('alarm.presence_follow_sum') : t('alarm.presence_own_sum', { who: this._presenceLabel }))}
            ${this._row('auto', mdiShieldCheck, t('alarm.auto_title'), this._autoSum())}
            ${this._row('times', mdiClockOutline, t('alarm.times'), t('alarm.times_row_sub'))}
            ${this._row('smart', mdiShieldHomeOutline, t('alarm.smart_title'), t('alarm.smart_row_sub'))}
          </div>
          ${on
            ? html`<div class="rl-box">
                <div class="line">
                  <span class="grow"><b>${t('alarm.test_alarm')}</b><small>${t('alarm.test_alarm_sub')}</small></span>
                  <button class="btn small" @click=${() => this.store.alarmTest().then(() => fire(this, 'hr-toast', t('alarm.test_alarm_sent')))}>${icon(mdiBellRing, 18)}${t('alarm.test_send_short')}</button>
                </div>
                <div class="line"><span class="grow"><b>${t('alarm.assistant_title')}</b><small>${t('alarm.assistant_sub')}</small></span>${assistantButton(this, s, 'alarm')}</div>
              </div>`
            : nothing}
          ${done}
        </hr-pop>`;
      case 'explain':
        return html`<hr-pop narrow heading=${t('alarm.explain_title')} .sub=${t('alarm.explain_pop_sub')} @close=${close}>
          ${this._explain()}
          <button slot="foot" class="btn primary" @click=${close}>${t('alarm.understood')}</button>
        </hr-pop>`;
      case 'presence':
        return pop(t('alarm.presence_title'), t('alarm.presence_pop_sub'), this._ro(this._presence()), true);
      case 'auto':
        return pop(t('alarm.auto_title'), t('alarm.per_mode'), this._ro(this._modePart('auto')));
      case 'times':
        return pop(t('alarm.times'), t('alarm.times_pop_sub'), this._ro(this._modePart('times')), true);
      case 'smart':
        return pop(t('alarm.smart_title'), t('alarm.smart_pop_sub'), this._ro(this._modePart('smart')));
      case 'sensors':
        return pop(t('alarm.grp_sensors'), t('alarm.sensors_pop_sub'), this._ro(this._modePart('sensors')));
      case 'activate':
        return pop(t('alarm.activate_title'), t('alarm.activate_pop_sub'), this._ro(this._modePart('activate')));
      case 'reaction': {
        const mc = cfg.modes[this._mode];
        const tones = this.store.alarm?.tones ?? {};
        return pop(
          t('alarm.grp_reaction'),
          t('alarm.reaction_pop_sub'),
          this._ro(html`${this._modePart('reaction')}
            <div class="rl-list">${this._row('activate', mdiCctv, t('alarm.activate_title'), `${MODE_LABEL(this._mode)}: ${mc.activate.length ? t('alarm.n_devices', { n: mc.activate.length }) : t('alarm.activate_eg')}`)}</div>
            <section class="rl-sec">
              <h3>${t('alarm.all_modes')}</h3>
              <div class="rl-list">
                ${this._row('sound', mdiBellRing, t('alarm.sound_title'), t('alarm.sound_row', { tone: tones[cfg.sound.tone] ?? (cfg.sound.tone === 'custom' ? t('alarm.own_tone_lc') : t('alarm.no_tone')), volume: cfg.sound.volume, min: Math.round(cfg.duration / 60) }))}
                ${this._row('announce', mdiSpeaker, t('alarm.announce'), cfg.announce.players.length ? t('alarm.n_speakers', { n: cfg.announce.players.length }) : t('alarm.no_speakers_lc'))}
              </div>
            </section>`),
        );
      }
      case 'sound':
        return pop(t('alarm.sound_title'), t('alarm.all_modes'), this._ro(this._globalPart('sound')));
      case 'announce':
        return pop(t('alarm.announce'), t('alarm.all_modes'), this._ro(this._globalPart('announce')), true);
      case 'notify':
        return pop(
          t('alarm.grp_notify'),
          t('alarm.tile_notify_sub'),
          this._ro(html`${this._globalPart('notify')} ${this._globalPart('cameras')}
            <div class="rl-list">${this._row('channels', mdiBellOutline, t('alarm.channels_pop'), this._channelsSum())}</div>`),
        );
      case 'channels':
        return pop(t('alarm.channels_pop'), t('alarm.channels_pop_sub'), this._ro(this._channels()));
      case 'security':
        return pop(t('alarm.grp_security'), t('alarm.security_pop_sub'), this._ro(this._globalPart('security')));
    }
    return nothing;
  }

  override render() {
    const s = this.store;
    const a = s.alarm;
    // on/off is the feature "alarm" (settings → features, also switch.alarmanlage_aktiv); the object alarms and the
    // window warning work without it
    const on = !!a && a.config.enabled && s.on('alarm');
    return html`
      ${!a ? html`<div class="empty">${t('alarm.unavailable')}</div>` : on ? this._hero() : featureHint(this, 'alarm')}
      ${this._tiles(on)}
      ${this._pops.map((p) => this._popView(p, on))}
      ${this._confirm
        ? html`<hr-sheet width="440" label=${t('alarm.disarm_sheet')} @close=${() => (this._confirm = false)}>
            <hr-disarm .store=${this.store} @done=${() => (this._confirm = false)} @close=${() => (this._confirm = false)}></hr-disarm>
          </hr-sheet>`
        : nothing}
    `;
  }
}
customElements.define('hr-alarm-view', HrAlarmView);
