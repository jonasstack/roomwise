/**
 * <hr-home-extras>: settings of the robot vacuum pause (which vacuums, which sensors, how long after), shown in the
 * pop-up behind the gear of the area Räume.
 */
import { css, html, nothing } from 'lit';
import { mdiCheckboxBlankOutline, mdiCheckboxMarked, mdiRobotVacuum } from '@mdi/js';
import { StoreElement } from '../base';
import { icon, shared } from '../design/shared';
import { kit } from '../design/kit';
import { LiveStore } from '../live';
import { t } from '../i18n';
// i18n: complete
import { assistantButton, autoAssistant } from '../assistant/base';

export class HrHomeExtras extends StoreElement {
  static override styles = [
    shared,
    kit,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-4);
      }
      .rl-item .box {
        color: var(--hr-label-3);
        display: flex;
      }
      .rl-item .box.on {
        color: var(--hr-accent);
      }
      .stepper {
        display: inline-flex;
        align-items: center;
        gap: var(--hr-space-2);
      }
      .stepper output {
        min-width: 56px;
        text-align: center;
        font-weight: 600;
      }
      .stepper button {
        width: 36px;
        height: 36px;
        border-radius: 50%;
        background: var(--hr-fill);
        font-size: 18px;
      }
      .on {
        color: var(--hr-green);
        font-weight: 600;
      }
    `,
  ];

  private _check(on: boolean, title: string, sub: string, toggle: () => void) {
    return html`<button class="rl-item" aria-pressed=${on ? 'true' : 'false'} @click=${toggle}>
      <span class="box ${on ? 'on' : ''}">${icon(on ? mdiCheckboxMarked : mdiCheckboxBlankOutline, 24)}</span>
      <span class="grow"><b>${title}</b><small>${sub}</small></span>
    </button>`;
  }

  private _cleaning() {
    const s = this.store;
    const c = s.cleaning;
    if (!c) return nothing;
    const vacs = s.devices.filter((d) => d.kind === 'vacuum');
    const live = s instanceof LiveStore ? s : undefined;
    const allVacs = [...vacs.map((d) => ({ entity_id: d.entity_id, name: d.name })), ...(live ? live.extraEntities('vacuum').filter((v) => !vacs.some((d) => d.entity_id === v.entity_id)) : [])];
    const sensors = s.devices.filter((d) => ['motion', 'presence', 'zone'].includes(d.kind));
    const sel = c.sensors;
    const set = (patch: Partial<typeof c>) => s.cleaningSet(patch);
    const toggleIn = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
    return html`<div class="rl-now">
        ${icon(mdiRobotVacuum, 26)}
        <span class="grow"
          ><b>${c.on && c.vacuums.length ? (c.active ? html`<span class="on">${t('home.vac_cleaning')}</span>` : t('home.vac_paused_while')) : t('home.vac_not_linked')}</b
          >${c.active ? html`<small>${t('home.vac_sensors_ignored')}</small>` : nothing}</span
        >
      </div>
      <p class="rl-note">${t('home.vac_lead')}</p>
      ${c.on
        ? html`<div class="rl-sec">
              <h3>${t('rooms.vac_which')}</h3>
              <div class="rl-list">
                ${allVacs.length
                  ? allVacs.map((v) => this._check(c.vacuums.includes(v.entity_id), v.name, v.entity_id, () => set({ vacuums: toggleIn(c.vacuums, v.entity_id) })))
                  : html`<div class="rl-item"><small>${t('home.vac_none')}</small></div>`}
              </div>
            </div>
            <div class="rl-box">
              <div class="line">
                <span class="grow"><b>${t('home.vac_after')}</b><small>${t('home.vac_after_help')}</small></span>
                <span class="stepper"
                  ><button aria-label=${t('home.less')} @click=${() => set({ after: Math.max(0, c.after - 1) })}>−</button><output>${t('common.min', { n: c.after })}</output
                  ><button aria-label=${t('home.more')} @click=${() => set({ after: Math.min(60, c.after + 1) })}>+</button></span
                >
              </div>
            </div>
            <div class="rl-sec">
              <h3>${t('rooms.vac_sensors')}</h3>
              <div class="rl-tg">
                <button aria-pressed=${sel === 'all' ? 'true' : 'false'} @click=${() => set({ sensors: 'all' })}>${t('home.vac_all_sensors')}</button>
                <button aria-pressed=${sel !== 'all' ? 'true' : 'false'} @click=${() => set({ sensors: sel === 'all' ? sensors.map((d) => d.entity_id) : sel })}>${t('home.vac_some_sensors')}</button>
              </div>
              ${sel !== 'all'
                ? html`<div class="rl-list">${sensors.map((d) => this._check(sel.includes(d.entity_id), d.name, s.room(d.room)?.name ?? t('home.no_room'), () => set({ sensors: toggleIn(sel, d.entity_id) })))}</div>`
                : nothing}
            </div>`
        : nothing}
      <div>${assistantButton(this, s, 'vacuum')}</div>`;
  }

  override updated(): void {
    autoAssistant(this, this.store, 'vacuum');
  }

  override render() {
    // "Wer wohnt hier" moved to the area Zuhause; on/off of the vacuum pause is in Einstellungen → Funktionen
    return this._cleaning();
  }
}
customElements.define('hr-home-extras', HrHomeExtras);
