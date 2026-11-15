/**
 * <hr-vacation>: everything about "Urlaub" and guests in one place, shown in the pop-up "Urlaubsmodus" of the settings
 * (Einstellungen → Urlaubsmodus; this element is only the content, the settings put it into an <hr-pop>): the house
 * mode "Urlaub" now and when it comes by itself (the only place for "Urlaub automatisch"), guests by hand, which rooms
 * look lived-in (the vacation part of each room's light plan, set up in detail in the light area), and what the
 * heating and the alarm system do meanwhile.
 */
import { css, html, nothing } from 'lit';
import { mdiAccountGroup, mdiAirplane, mdiChevronRight, mdiRadiator, mdiShieldHomeOutline } from '@mdi/js';
import { StoreElement } from '../base';
import { fire, icon, shared } from '../design/shared';
import { kit } from '../design/kit';
import { featureHint } from '../components/feature';
import type { LightPlan } from '../model';
import { fmtNumber, t } from '../i18n';
// i18n: complete
import './mode-auto';

export class HrVacation extends StoreElement {
  static override styles = [
    shared,
    kit,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-4);
      }
      .rl-item > .ic,
      .line > .ic {
        color: var(--hr-label-2);
      }
      .rl-item.on > .ic,
      .line.on > .ic {
        color: var(--hr-accent);
      }
      .open {
        display: inline-flex;
        align-items: center;
        color: var(--hr-accent);
        font-size: var(--hr-text-footnote);
        font-weight: 600;
        white-space: nowrap;
      }
    `,
  ];

  private _lightRooms() {
    const s = this.store;
    const plans = s.plans?.light ?? {};
    return s.orderedRooms().filter((r) => plans[r.id]).map((r) => ({ room: r, plan: plans[r.id] as LightPlan }));
  }

  private _livedIn() {
    const s = this.store;
    if (!s.on('light') || !s.on('vacation')) return featureHint(this, 'vacation', t('home.vac_sim_hint'));
    const rooms = this._lightRooms();
    if (!rooms.length) return html`<p class="rl-note">${t('home.vac_no_rooms')}</p>`;
    return html`<div class="rl-list">
      ${rooms.map(({ room: r, plan: p }) => {
        const v = p.vacation;
        const lights = v.lights.length ? v.lights.map((e) => s.device(e)?.name ?? e).join(', ') : t('home.vac_all_lights', { room: r.in });
        return html`<div class="rl-item ${v.on && p.on ? 'on' : ''}">
          <span class="grow"><b>${r.name}</b><small>${!p.on ? t('home.vac_plan_off') : v.on ? lights : t('home.vac_not_in')}</small></span>
          <button class="open" @click=${() => fire(this, 'hr-tab', `light#vacation:${r.id}`)}>${t('home.vac_setup')}${icon(mdiChevronRight, 18)}</button>
          <button class="switch" role="switch" aria-label=${t('home.vac_room_label', { room: r.name })} aria-checked=${v.on && p.on ? 'true' : 'false'} ?disabled=${!s.admin || !p.on} @click=${() => s.planSet('light', r.id, { ...p, vacation: { ...v, on: !v.on } })}></button>
        </div>`;
      })}
    </div>`;
  }

  private _heating() {
    const s = this.store;
    if (!s.on('heating')) return nothing;
    const heat = Object.entries(s.plans?.heat ?? {}).filter(([, p]) => p.on);
    const frost = [...new Set(heat.map(([, p]) => p.temps.frost))].sort((a, b) => a - b);
    const deg = (x: number) => `${fmtNumber(x)} °C`;
    const text = !heat.length
      ? t('home.vac_heat_none')
      : frost.length === 1
        ? t('home.vac_heat_frost', { t: deg(frost[0]) })
        : t('home.vac_heat_frost_range', { from: deg(frost[0]), to: deg(frost[frost.length - 1]) });
    return html`<div class="line">
      <span class="ic">${icon(mdiRadiator, 22)}</span>
      <span class="grow"><b>${t('home.vac_heating')}</b><small>${text}</small></span>
      <button class="open" @click=${() => fire(this, 'hr-tab', 'heat')}>${t('home.vac_heating')}${icon(mdiChevronRight, 18)}</button>
    </div>`;
  }

  private _alarm() {
    const s = this.store;
    const a = s.alarm;
    if (!s.on('alarm') || !a?.config.enabled) return nothing;
    const away = a.config.modes.away;
    const on = away.auto.arm_on.includes('vacation');
    const toggle = () =>
      s.alarmConfig({ modes: { ...a.config.modes, away: { ...away, auto: { ...away.auto, arm_on: on ? away.auto.arm_on.filter((x) => x !== 'vacation') : [...away.auto.arm_on, 'vacation'] } } } });
    return html`<div class="line ${on ? 'on' : ''}">
      <span class="ic">${icon(mdiShieldHomeOutline, 22)}</span>
      <span class="grow"><b>${t('home.vac_alarm')}</b><small>${t('home.vac_alarm_sub')}</small></span>
      <button class="switch" role="switch" aria-label=${t('home.vac_alarm')} aria-checked=${on ? 'true' : 'false'} ?disabled=${!s.admin} @click=${toggle}></button>
    </div>`;
  }

  override render() {
    const s = this.store;
    const now = s.mode === 'vacation';
    const guests = s.mode === 'guests';
    const heating = this._heating();
    const alarm = this._alarm();
    return html`
      <div class="rl-now">
        <span class="ic">${icon(mdiAirplane, 24)}</span>
        <span class="grow"><b>${t(now ? 'home.vac_now' : guests ? 'home.guests_now' : 'home.vac_not_now')}</b><small>${t('home.vac_sub')}</small></span>
        <button class="btn small ${now ? '' : 'primary'}" @click=${() => s.setMode(now ? 'home' : 'vacation')}>${t(now ? 'home.vac_end' : 'home.vac_start')}</button>
      </div>

      <div class="rl-sec">
        <span class="eyebrow">${t('home.vac_when')}</span>
        ${s.on('mode_auto') ? html`<hr-mode-auto .store=${s} only="vacation"></hr-mode-auto>` : featureHint(this, 'mode_auto', t('home.vac_manual_hint'))}
      </div>

      <div class="rl-sec">
        <span class="eyebrow">${t('home.vac_rooms')}</span>
        ${this._livedIn()}
      </div>

      ${heating !== nothing || alarm !== nothing
        ? html`<div class="rl-sec"><span class="eyebrow">${t('home.vac_heat_alarm')}</span><div class="rl-box">${heating}${alarm}</div></div>`
        : nothing}

      <div class="rl-sec">
        <span class="eyebrow">${t('home.guests')}</span>
        <div class="rl-box">
          <div class="line ${guests ? 'on' : ''}">
            <span class="ic">${icon(mdiAccountGroup, 22)}</span>
            <span class="grow"><b>${t('home.guests_here')}</b><small>${t('home.guests_sub')}</small></span>
            <button class="switch" role="switch" aria-label=${t('home.guests_here')} aria-checked=${guests ? 'true' : 'false'} @click=${() => s.setMode(guests ? 'home' : 'guests')}></button>
          </div>
        </div>
        <span class="rl-note">${t('home.guests_auto_note')}</span>
      </div>
    `;
  }
}
customElements.define('hr-vacation', HrVacation);
