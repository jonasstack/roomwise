/**
 * <hr-room-detail>: the pop-up of one room (Räume → tap a room, also "hr-open-room" from anywhere): how it was
 * occupied today (times, total, empty after), its sensors, the rules about it as a short list and "Neue Regel für …".
 * The gear opens "Raum einstellen" (hr-room-settings) for sensors, empty after and when it is dark. Fires "close".
 */
import { css, html, nothing } from 'lit';
import { mdiAlertCircleOutline, mdiChevronRight, mdiCogOutline, mdiInfinity, mdiLightningBolt, mdiPlus } from '@mdi/js';
import { StoreElement } from '../base';
import { formatSeconds } from '../components/duration';
import { ruleSentence, sinceText } from '../describe';
import { fire, icon, shared } from '../design/shared';
import { kit } from '../design/kit';
import { newRule } from '../store';
import { hoursText, roomStyles, rulesOfRoom, sensorChips, timeline } from './room-common';
import '../components/pop';
import { fmtNumber, t } from '../i18n';
// i18n: complete

export class HrRoomDetail extends StoreElement {
  static override properties = { ...StoreElement.properties, roomId: {} };
  declare roomId: string;

  static override styles = [
    shared,
    kit,
    roomStyles,
    css`
      .stats {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: var(--hr-space-3);
      }
      .stat {
        background: var(--hr-surface);
        border-radius: var(--hr-radius-l);
        box-shadow: var(--hr-shadow-1);
        padding: var(--hr-space-3) var(--hr-space-4);
      }
      .stat b {
        display: block;
        font-size: var(--hr-text-title3);
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
      .stat small {
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
      }
      .today .tl {
        height: 10px;
      }
      .k {
        width: 36px;
        height: 36px;
        border-radius: var(--hr-radius-s);
        display: grid;
        place-items: center;
        flex: none;
        color: #fff;
        background: var(--hr-when);
      }
      .k.while {
        background: var(--hr-while);
      }
      .rl-item.off .main {
        opacity: 0.55;
      }
      .rl-item small {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .new {
        align-self: flex-start;
      }
      .warn {
        color: var(--hr-orange);
      }
      @media (max-width: 640px) {
        .stats {
          grid-template-columns: 1fr 1fr;
        }
      }
    `,
  ];

  private _close = () => this.dispatchEvent(new CustomEvent('close'));

  override render() {
    const s = this.store;
    const room = s.room(this.roomId);
    if (!room) return nothing;
    const o = s.occupancy[room.id];
    const segs = s.today(room.id);
    const total = segs.reduce((a, [x, y]) => a + (y - x), 0);
    const rules = rulesOfRoom(s, room);
    const sub = html`${o?.occupied ? t('rooms.occupied_since', { time: sinceText(o.since) }) : t('rooms.empty_since', { time: o ? sinceText(o.since) : '–' })}${o?.occupied && o.by
      ? html` · ${t('rooms.detected_by', { by: o.by })}`
      : nothing}`;
    return html`<hr-pop heading=${room.name} .sub=${sub} @close=${this._close}>
      <button slot="head" class="icon-btn" aria-label=${t('rooms.settings_title', { room: room.name })} title=${t('rooms.settings_title', { room: room.name })} @click=${() => fire(this, 'hr-room-settings', { id: room.id })}>
        ${icon(mdiCogOutline, 22)}
      </button>
      <div class="stats">
        <div class="stat"><b>${fmtNumber(segs.length, 0)}×</b><small>${t('rooms.stat_times')}</small></div>
        <div class="stat"><b>${hoursText(total)}</b><small>${t('rooms.stat_total')}</small></div>
        <div class="stat"><b>${formatSeconds(room.empty_after * 60)}</b><small>${t('rooms.stat_wait')}</small></div>
      </div>
      <div class="rl-sec">
        <span class="eyebrow">${t('rooms.occupancy_today')}</span>
        <div class="rl-box today">${timeline(segs, { ticks: true })}</div>
      </div>
      <div class="rl-sec">
        <span class="eyebrow">${t('rooms.sensors')}</span>
        <div class="rl-box">
          <div class="line">
            <span class="grow rl-chips">${sensorChips(room)}</span>
            <button class="btn small" @click=${() => fire(this, 'hr-room-settings', { id: room.id })}>${t('rooms.change')}${icon(mdiChevronRight, 16)}</button>
          </div>
          ${!room.presence.length && !room.motion.length
            ? html`<div class="line warn">${icon(mdiAlertCircleOutline, 18)}<span class="grow">${t(room.door_logic ? 'rooms.no_presence_sensor_doors' : 'rooms.no_presence_sensor')}</span></div>`
            : nothing}
        </div>
      </div>
      <div class="rl-sec">
        <span class="eyebrow">${t('rooms.rules_here')} · ${rules.length}</span>
        ${rules.length
          ? html`<div class="rl-list">
              ${rules.map(
                (r) => html`<div class="rl-item ${r.enabled ? '' : 'off'}">
                  <button class="main" @click=${() => fire(this, 'hr-open-rule', { rule: structuredClone(r) })}>
                    <span class="k ${r.type === 'while' ? 'while' : ''}">${icon(r.type === 'while' ? mdiInfinity : mdiLightningBolt, 18)}</span>
                    <span class="grow"><b>${r.name}</b><small>${r.sentence || ruleSentence(s, r)}</small></span>
                  </button>
                  <button class="switch" role="switch" aria-label=${t('rooms.rule_toggle', { name: r.name })} aria-checked=${r.enabled ? 'true' : 'false'} @click=${() => s.setEnabled(r.id, !r.enabled)}></button>
                </div>`,
              )}
            </div>`
          : html`<p class="rl-note rl-lbl">${t('rooms.no_rules_here')}</p>`}
        <button class="btn tinted new" @click=${() => fire(this, 'hr-open-rule', { isNew: true, rule: newRule({ when: [{ subject: `room:${room.id}`, verb: 'entered' }] }) })}>
          ${icon(mdiPlus, 18)}${t('rooms.new_rule_for', { room: room.name })}
        </button>
      </div>
      <button slot="foot" class="btn primary" @click=${this._close}>${t('common.done')}</button>
    </hr-pop>`;
  }
}
customElements.define('hr-room-detail', HrRoomDetail);
