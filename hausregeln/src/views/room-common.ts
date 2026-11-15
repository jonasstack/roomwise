/** Pieces shared by the room views (Räume, room pop-up, Raum einstellen). */
import { css, html, nothing, svg } from 'lit';
import { mdiDoorOpen, mdiMotionSensor, mdiRadar, mdiSofa } from '@mdi/js';
import type { Room, Rule } from '../model';
import type { Store } from '../store';
import { icon } from '../design/shared';
import { t } from '../i18n';
// i18n: complete

export function timeline(segs: [number, number][], opts: { ticks?: boolean } = {}) {
  const now = new Date().getHours() + new Date().getMinutes() / 60;
  const bar = html`<svg class="tl" viewBox="0 0 240 8" preserveAspectRatio="none" aria-label=${t('rooms.occupancy_today')}>
    ${svg`<rect x="0" y="0" width="240" height="8" rx="4" class="tl-bg"></rect>
    ${segs.map(([a, b]) => svg`<rect x=${a * 10} y="0" width=${Math.max(1.5, (b - a) * 10)} height="8" rx="2" class="tl-on"></rect>`)}
    <rect x=${now * 10 - 0.75} y="-1" width="1.5" height="10" class="tl-now"></rect>`}
  </svg>`;
  return opts.ticks
    ? html`${bar}<div class="tl-ticks">${['0', '6', '12', '18', t('rooms.tick_end')].map((h) => html`<span>${h}</span>`)}</div>`
    : bar;
}

export const roomStyles = css`
  .tl {
    width: 100%;
    height: 8px;
    display: block;
    overflow: visible;
  }
  .tl-bg {
    fill: var(--hr-fill);
  }
  .tl-on {
    fill: var(--hr-orange);
    opacity: 0.85;
  }
  .tl-now {
    fill: var(--hr-label-2);
  }
  .tl-ticks {
    display: flex;
    justify-content: space-between;
    margin-top: 6px;
    font-size: var(--hr-text-caption);
    color: var(--hr-label-2);
    font-variant-numeric: tabular-nums;
  }
`;

/** rules that mention the room or one of its devices */
export function rulesOfRoom(s: Store, room: Room): Rule[] {
  const ids = new Set(s.devices.filter((d) => d.room === room.id).map((d) => d.entity_id));
  const touches = (subject: string) => subject === `room:${room.id}` || subject.endsWith(`@${room.id}`) || ids.has(subject) || ids.has(subject.replace(/^zone:/, ''));
  return s.rules.filter((r) => [...r.when, ...r.and, ...r.then, ...r.only].some((c) => touches(c.subject)));
}

/** "1 Std. 12 Min." for hours of a day */
export function hoursText(h: number): string {
  const m = Math.round(h * 60);
  if (m < 60) return t('dur.m', { n: m });
  return m % 60 ? `${t('dur.h', { n: Math.floor(m / 60) })} ${t('dur.m', { n: m % 60 })}` : t('dur.h', { n: m / 60 });
}

/** sensor chips of a room ("1 Anwesenheit", "3 Zonen", "1 Tür") */
export function sensorChips(room: Room) {
  return html`${room.presence.length ? html`<span class="rl-chip">${icon(mdiRadar, 14)}${t('rooms.n_presence', { n: room.presence.length })}</span>` : nothing}
  ${room.motion.length ? html`<span class="rl-chip">${icon(mdiMotionSensor, 14)}${t('rooms.n_motion', { n: room.motion.length })}</span>` : nothing}
  ${room.zones.length ? html`<span class="rl-chip">${icon(mdiSofa, 14)}${t('rooms.n_zones', { n: room.zones.length })}</span>` : nothing}
  ${room.doors.length ? html`<span class="rl-chip">${icon(mdiDoorOpen, 14)}${t('rooms.n_doors', { n: room.doors.length })}</span>` : nothing}`;
}

