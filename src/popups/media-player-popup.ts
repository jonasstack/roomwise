import { css, html, nothing } from 'lit';
import { PopupBase } from './popup-base';
import { callOptimistic } from '../actions';
import { isUnavailable } from '../ha';
import { t } from '../i18n';
import { commandSet, runMediaCommand, type MediaSlot } from '../media-controls';
import type { MediaCommand, MediaControlsConfig } from '../types';
import '../components/controls';

// MediaPlayerEntityFeature bits
const F = { PAUSE: 1, SEEK: 2, VOLUME_SET: 4, VOLUME_MUTE: 8, PREV: 16, NEXT: 32, TURN_ON: 128, TURN_OFF: 256, VOLUME_STEP: 1024, SELECT_SOURCE: 2048, PLAY: 16384 };

const fmtTime = (s: number) => {
  s = Math.max(0, Math.floor(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export class FpMediaPlayerPopup extends PopupBase {
  static override properties = {
    ...PopupBase.properties,
    media: { attribute: false },
    deviceName: { attribute: false },
    deviceIcon: { attribute: false },
    _vol: { state: true },
    _now: { state: true },
    _imgFailed: { state: true },
  };
  /** Own buttons of the device (scripts for infrared …); with them the popup also works without an entity */
  declare media?: MediaControlsConfig;
  declare deviceName?: string;
  declare deviceIcon?: string;
  declare _vol?: number;
  declare _imgFailed?: boolean;
  private lastPic?: string;
  declare _now: number;
  private timer?: number;

  constructor() {
    super();
    this._now = Date.now();
  }

  override connectedCallback() {
    super.connectedCallback();
    this.timer = window.setInterval(() => {
      if (this.stateObj?.state === 'playing') this._now = Date.now();
    }, 1000);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    clearInterval(this.timer);
  }

  private get isPlayer() {
    return this.entityId?.startsWith('media_player.') ?? false;
  }

  private supports(bit: number) {
    return this.isPlayer && ((this.stateObj?.attributes.supported_features ?? 0) & bit) !== 0;
  }

  private svc(service: string, override: { state?: string; attributes?: Record<string, unknown> } = {}, data: Record<string, unknown> = {}) {
    this.safe(() => callOptimistic(this.ctx.host, this.entityId, override, 'media_player', service, data));
  }

  /** The own command of a slot (a script set there wins over the entity) */
  private cmd(slot: MediaSlot): MediaCommand | undefined {
    const c = this.media?.[slot];
    return commandSet(c) ? c : undefined;
  }

  private run(c: MediaCommand | undefined) {
    void runMediaCommand(this.ctx.host, c, this.entityId || undefined);
  }

  /** A slot: its own command when set, otherwise the entity's service */
  private act(slot: MediaSlot, native: () => void) {
    const c = this.cmd(slot);
    return c ? () => this.run(c) : native;
  }

  private renderPower(unavailable: boolean) {
    const s = this.stateObj;
    const off = s?.state === 'off' || s?.state === 'standby';
    const d = this.entityId ? this.entityId.split('.')[0] : '';
    // a TV switched by a plain switch (smart plug, IR blaster switch …) still reports on / off
    const nativePower = this.isPlayer ? this.supports(F.TURN_ON) || this.supports(F.TURN_OFF) : ['switch', 'input_boolean', 'remote'].includes(d) && !!s;
    const nativeCall = (on: boolean) =>
      this.isPlayer
        ? this.svc(on ? 'turn_on' : 'turn_off', { state: on ? 'on' : 'off' })
        : this.safe(() => callOptimistic(this.ctx.host, this.entityId, { state: on ? 'on' : 'off' }, 'homeassistant', on ? 'turn_on' : 'turn_off'));
    const on = this.cmd('power_on');
    const offCmd = this.cmd('power_off');
    const toggle = this.cmd('power');
    // the state is known: one button that does the right thing
    if (s && !unavailable && (nativePower || toggle || (on && offCmd))) {
      const press = off ? on ?? toggle : offCmd ?? toggle;
      return {
        trailing: html`<button
          class="icon-btn pressable ${off ? '' : 'accent'}"
          aria-label=${off ? t('media.power_on') : t('media.power_off')}
          ?disabled=${!press && !nativePower}
          @click=${() => (press ? this.run(press) : nativeCall(off))}
        >
          <ha-icon icon="mdi:power"></ha-icon>
        </button>`,
        chips: nothing,
      };
    }
    // no state to go by: the toggle in the head, separate on / off below — never a guessed state
    return {
      trailing: toggle
        ? html`<button class="icon-btn pressable" aria-label=${t('media.power')} @click=${() => this.run(toggle)}><ha-icon icon="mdi:power"></ha-icon></button>`
        : !on && !offCmd && nativePower
        ? html`<button class="icon-btn pressable" aria-label=${t('media.power')} disabled><ha-icon icon="mdi:power"></ha-icon></button>`
        : undefined,
      chips:
        on || offCmd
          ? html`<div class="chips power">
              ${on ? html`<button class="chip pressable" @click=${() => this.run(on)}><ha-icon icon="mdi:power-on"></ha-icon>${t('media.power_on')}</button>` : nothing}
              ${offCmd ? html`<button class="chip pressable" @click=${() => this.run(offCmd)}><ha-icon icon="mdi:power-off"></ha-icon>${t('media.power_off')}</button>` : nothing}
            </div>`
          : nothing,
    };
  }

  override render() {
    const s = this.stateObj;
    const m = this.media;
    if (!s && !m) return this.renderHeader();
    const a = s?.attributes ?? {};
    const unavailable = !!s && isUnavailable(s);
    const player = this.isPlayer && !!s;
    const playing = s?.state === 'playing';
    const title = a.media_title as string | undefined;
    const artist = (a.media_artist ?? a.media_album_name ?? a.app_name) as string | undefined;
    const pic = a.entity_picture_local ?? a.entity_picture;
    if (pic !== this.lastPic) {
      this.lastPic = pic;
      this._imgFailed = false;
    }
    const vol = this._vol ?? Math.round((a.volume_level ?? 0) * 100);
    const dur = a.media_duration as number | undefined;
    let pos = a.media_position as number | undefined;
    if (pos != null && playing && a.media_position_updated_at) pos += (this._now - Date.parse(a.media_position_updated_at)) / 1000;
    const power = this.renderPower(unavailable);
    // native features only count while the entity is reachable; own commands always work
    const native = (bit: number) => !unavailable && this.supports(bit);
    const can = (slot: MediaSlot, bit: number) => !!this.cmd(slot) || native(bit);
    const ownPlay = !!this.cmd('play_pause') || !player;
    const hasTransport = player || !!(this.cmd('previous') || this.cmd('play_pause') || this.cmd('next'));
    const steps = !!(this.cmd('volume_up') || this.cmd('volume_down')) || (!this.supports(F.VOLUME_SET) && this.supports(F.VOLUME_STEP));
    const muteOk = can('mute', F.VOLUME_MUTE);
    const muted = !!a.is_volume_muted;
    const ownMute = !!this.cmd('mute');
    const mute = this.act('mute', () => this.svc('volume_mute', { attributes: { is_volume_muted: !muted } }, { is_volume_muted: !muted }));
    const muteBtn = muteOk
      ? html`<button class="icon-btn plain pressable" aria-label=${t('media.mute')} aria-pressed=${!ownMute && player ? String(muted) : nothing} @click=${mute}>
          <ha-icon icon=${muted && !ownMute ? 'mdi:volume-off' : 'mdi:volume-mute'}></ha-icon>
        </button>`
      : nothing;
    const ownSources = (m?.sources ?? []).filter(commandSet);
    const sources: string[] = ownSources.length ? [] : a.source_list ?? [];
    const buttons = (m?.buttons ?? []).filter(commandSet);

    return html`
      ${this.renderHeader(
        s
          ? { trailing: power.trailing }
          : { icon: html`<ha-icon .icon=${this.deviceIcon || 'mdi:remote-tv'}></ha-icon>`, title: this.deviceName || t('media.device'), subtitle: t('media.remote'), trailing: power.trailing },
      )}
      ${power.chips}
      ${player
        ? html`<div class="now">
            <div class="art ${pic && !this._imgFailed ? '' : 'empty'}">
              ${pic && !this._imgFailed
                ? html`<img src=${this.hass.hassUrl(pic)} alt="" @error=${() => (this._imgFailed = true)} />`
                : html`<ha-icon icon="mdi:music-note"></ha-icon>`}
            </div>
            <div class="meta">
              <div class="track">${title ?? t('media.nothing')}</div>
              ${artist ? html`<div class="artist">${artist}</div>` : nothing}
            </div>
          </div>`
        : nothing}
      ${player && dur && pos != null
        ? html`<div class="progress">
            <div class="bar"><div class="bar-fill" style=${`transform:translateX(${Math.min(100, (pos / dur) * 100) - 100}%)`}></div></div>
            <div class="times num"><span>${fmtTime(pos)}</span><span>-${fmtTime(dur - pos)}</span></div>
          </div>`
        : nothing}
      ${hasTransport
        ? html`<div class="transport">
            <button class="icon-btn plain pressable t" aria-label=${t('media.previous')} ?disabled=${!can('previous', F.PREV)} @click=${this.act('previous', () => this.svc('media_previous_track'))}>
              <ha-icon icon="mdi:skip-previous"></ha-icon>
            </button>
            <button
              class="icon-btn pressable play"
              aria-label=${ownPlay ? t('media.play_pause') : playing ? t('media.pause') : t('media.play')}
              ?disabled=${!(this.cmd('play_pause') || native(F.PAUSE) || native(F.PLAY))}
              @click=${this.act('play_pause', () => this.svc('media_play_pause', { state: playing ? 'paused' : 'playing' }))}
            >
              <ha-icon icon=${ownPlay ? 'mdi:play-pause' : playing ? 'mdi:pause' : 'mdi:play'}></ha-icon>
            </button>
            <button class="icon-btn plain pressable t" aria-label=${t('media.next')} ?disabled=${!can('next', F.NEXT)} @click=${this.act('next', () => this.svc('media_next_track'))}>
              <ha-icon icon="mdi:skip-next"></ha-icon>
            </button>
          </div>`
        : nothing}
      ${steps
        ? html`<div class="steps" role="group" aria-label=${t('media.volume')}>
            <button class="icon-btn pressable" aria-label=${t('media.volume_down')} ?disabled=${!can('volume_down', F.VOLUME_STEP | F.VOLUME_SET)} @click=${this.act('volume_down', () => this.svc('volume_down'))}>
              <ha-icon icon="mdi:volume-minus"></ha-icon>
            </button>
            ${muteBtn}
            <button class="icon-btn pressable" aria-label=${t('media.volume_up')} ?disabled=${!can('volume_up', F.VOLUME_STEP | F.VOLUME_SET)} @click=${this.act('volume_up', () => this.svc('volume_up'))}>
              <ha-icon icon="mdi:volume-plus"></ha-icon>
            </button>
          </div>`
        : this.supports(F.VOLUME_SET)
        ? html`<div class="vol">
            <fp-slider
              horizontal
              .value=${vol}
              .fill=${'var(--fp-slider-fill)'}
              .label=${t('media.volume')}
              icon=${muted ? 'mdi:volume-off' : 'mdi:volume-high'}
              ?disabled=${unavailable}
              @value-input=${(e: CustomEvent) => (this._vol = e.detail.value)}
              @value-change=${(e: CustomEvent) => {
                this._vol = undefined;
                this.svc('volume_set', { attributes: { volume_level: e.detail.value / 100 } }, { volume_level: e.detail.value / 100 });
              }}
            ></fp-slider>
            ${muteBtn}
          </div>`
        : muteOk
        ? html`<div class="steps">${muteBtn}</div>`
        : nothing}
      ${ownSources.length
        ? html`<div class="label-s" style="margin-top:var(--fp-space-5)">${t('media.source')}</div>
            <div class="chips">
              ${ownSources.map(
                (src) => html`<button class="chip pressable" aria-pressed=${s && a.source ? String(a.source === src.name) : nothing} @click=${() => this.run(src)}>${src.name}</button>`,
              )}
            </div>`
        : sources.length && native(F.SELECT_SOURCE)
        ? html`<div class="label-s" style="margin-top:var(--fp-space-5)">${t('media.source')}</div>
            <div class="chips">
              ${sources.slice(0, 12).map(
                (src) => html`<button
                  class="chip pressable"
                  aria-pressed=${a.source === src ? 'true' : 'false'}
                  @click=${() => this.svc('select_source', { attributes: { source: src } }, { source: src })}
                >
                  ${src}
                </button>`,
              )}
            </div>`
        : nothing}
      ${buttons.length
        ? html`<div class="label-s" style="margin-top:var(--fp-space-5)">${t('media.buttons')}</div>
            <div class="own">
              ${buttons.map(
                (b) => html`<button class="own-btn pressable" aria-label=${b.name} @click=${() => this.run(b)}>
                  <ha-icon .icon=${b.icon || 'mdi:gesture-tap-button'}></ha-icon>
                  <span aria-hidden="true">${b.name}</span>
                </button>`,
              )}
            </div>`
        : nothing}
    `;
  }

  static override styles = [
    ...PopupBase.styles,
    css`
      .now {
        display: flex;
        align-items: center;
        gap: var(--fp-space-4);
      }
      .art {
        width: 120px;
        height: 120px;
        border-radius: var(--fp-radius-m);
        overflow: hidden;
        flex: none;
        background: var(--fp-fill-strong);
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: var(--fp-shadow-2);
      }
      .art img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      .art.empty {
        box-shadow: none;
      }
      .art ha-icon {
        --mdc-icon-size: 40px;
        color: var(--fp-label-3);
      }
      .meta {
        min-width: 0;
      }
      .track {
        font-size: var(--fp-text-title3);
        font-weight: var(--fp-weight-semibold);
        overflow: hidden;
        text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }
      .artist {
        font-size: var(--fp-text-body);
        color: var(--fp-label-2);
        margin-top: 2px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .progress {
        margin-top: var(--fp-space-5);
      }
      .bar {
        height: 6px;
        border-radius: var(--fp-radius-full);
        background: var(--fp-fill-strong);
        overflow: hidden;
      }
      .bar-fill {
        height: 100%;
        background: var(--fp-label-2);
        border-radius: inherit;
        transition: transform 1s linear;
      }
      .times {
        display: flex;
        justify-content: space-between;
        font-size: var(--fp-text-caption);
        color: var(--fp-label-2);
        margin-top: var(--fp-space-1);
      }
      .transport {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: var(--fp-space-7);
        margin: var(--fp-space-5) 0;
      }
      .t {
        width: 56px;
        height: 56px;
      }
      .t ha-icon {
        --mdc-icon-size: 34px;
      }
      .play {
        width: 72px;
        height: 72px;
        background: var(--fp-label);
        color: var(--fp-surface);
      }
      .play ha-icon {
        --mdc-icon-size: 36px;
      }
      .vol {
        display: flex;
        align-items: center;
        gap: var(--fp-space-3);
      }
      .vol fp-slider {
        flex: 1;
        min-width: 0;
      }
      .steps {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: var(--fp-space-5);
      }
      .steps .icon-btn ha-icon {
        --mdc-icon-size: 26px;
      }
      .chips.power {
        margin-bottom: var(--fp-space-4);
      }
      .chips.power ha-icon {
        --mdc-icon-size: 18px;
        margin-right: var(--fp-space-1);
      }
      .own {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
        gap: var(--fp-space-2);
      }
      .own-btn {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: var(--fp-space-1);
        min-height: 72px;
        padding: var(--fp-space-2);
        border: none;
        border-radius: var(--fp-radius-m);
        background: var(--fp-fill);
        color: var(--fp-label);
        font: inherit;
        font-size: var(--fp-text-footnote);
        cursor: pointer;
      }
      .own-btn ha-icon {
        --mdc-icon-size: 24px;
        color: var(--fp-label-2);
      }
      .own-btn span {
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    `,
  ];
}

if (!customElements.get('fp-media-player-popup')) customElements.define('fp-media-player-popup', FpMediaPlayerPopup);
