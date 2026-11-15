import { css, html, nothing } from 'lit';
import { PopupBase } from './popup-base';
import type { FurnitureConfig } from '../types';
import { applianceRoles, applianceStatus, applianceWatch, type ApplianceRole } from '../appliance';
import { entityName, formatState, isUnavailable } from '../ha';
import { furnitureLabel, resolveFurniture } from '../furniture';
import { getLanguage, t } from '../i18n';

const clock = (ms: number) => new Date(ms).toLocaleTimeString(getLanguage(), { hour: '2-digit', minute: '2-digit' });

/**
 * Washer, dryer, dishwasher: state, program, progress, time left and the end time; "fertig" with "Gesehen" (clears
 * it on every screen); below, every value of the device (each opens its own popup).
 */
export class FpAppliancePopup extends PopupBase {
  static override properties = { ...PopupBase.properties, piece: { attribute: false } };
  declare piece: FurnitureConfig;
  private un?: () => void;
  private redraw = () => this.requestUpdate();

  override connectedCallback() {
    super.connectedCallback();
    this.un = applianceWatch.listen(this.redraw);
    applianceWatch.clock(this.redraw, true);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.un?.();
  }

  override render() {
    const f = this.piece;
    const k = resolveFurniture(f).k;
    const a = applianceStatus(this.hass, f, k?.kind, this.ctx.getState);
    const { ids: all, info } = applianceRoles(this.hass, f);
    const sub =
      a.phase === 'done'
        ? a.finishedAt
          ? t('appliance.done_since', { time: clock(a.finishedAt) })
          : t('appliance.done')
        : a.phase === 'paused'
          ? t('appliance.paused')
          : a.phase === 'running'
            ? a.mins != null
              ? t('appliance.left', { n: a.mins })
              : t('appliance.running')
            : t('appliance.idle');
    const val = (r: ApplianceRole) => (a.roles[r] ? this.ctx.getState(a.roles[r]!) : undefined);
    const rows: [string, string, string | undefined][] = [
      ['mdi:list-status', t('appliance.r_state'), val('state') && !isUnavailable(val('state')!) ? formatState(this.hass, val('state')!) : undefined],
      ['mdi:format-list-bulleted', t('appliance.r_program'), a.program ? (val('program') ? formatState(this.hass, val('program')!) : a.program) : undefined],
      ['mdi:progress-clock', t('appliance.r_progress'), a.progress != null ? `${Math.round(a.progress)} %` : undefined],
      ['mdi:timer-sand', t('appliance.r_left'), a.phase === 'running' || a.phase === 'paused' ? (a.mins != null ? t('appliance.min', { n: a.mins }) : undefined) : undefined],
      ['mdi:clock-check-outline', t('appliance.r_end'), a.endAt ? clock(a.endAt) : undefined],
      ['mdi:door', t('appliance.r_door'), a.door == null ? undefined : t(a.door ? 'appliance.door_open' : 'appliance.door_closed')],
      ['mdi:flash', t('appliance.r_power'), a.power != null ? `${Math.round(a.power)} W` : undefined],
    ];
    const sw = a.roles.switch;
    return html`
      ${this.renderHeader({
        icon: html`<ha-icon .icon=${a.phase === 'done' ? 'mdi:check-circle' : (k?.icon ?? 'mdi:washing-machine')}></ha-icon>`,
        title: f.name || (k ? furnitureLabel(k) : ''),
        subtitle: sub,
      })}
      ${a.progress != null && a.phase !== 'idle'
        ? html`<div class="bar" role="progressbar" aria-valuenow=${Math.round(a.progress)} aria-valuemin="0" aria-valuemax="100"><span style=${`width:${Math.max(0, Math.min(100, a.progress))}%`}></span></div>`
        : nothing}
      ${a.phase === 'done'
        ? html`<button class="btn block filled pressable seen" data-seen @click=${() => applianceWatch.ack(this.hass, f.id)}>
              <ha-icon icon="mdi:check"></ha-icon>${t('appliance.seen')}
            </button>
            <div class="hint">${t('appliance.seen_sub')}</div>`
        : nothing}
      <div class="group" data-appl-values>
        ${rows
          .filter((r) => r[2] != null)
          .map(
            ([icon, label, v]) => html`<div class="row">
              <ha-icon class="ic" .icon=${icon}></ha-icon>
              <div class="grow">${label}</div>
              <div class="num">${v}</div>
            </div>`,
          )}
        ${sw ? this.valueRow(sw, t('appliance.role.switch'), 'mdi:power') : nothing}
      </div>
      ${info.length
        ? html`<div class="label-row">${t('appliance.more')}</div>
            <div class="group" data-appl-info>${info.map((x) => this.valueRow(x.entity, x.name, x.icon))}</div>`
        : nothing}
      ${all.length
        ? html`<details class="all">
            <summary class="label-row">${t('appliance.all_values')} (${all.length})</summary>
            <div class="group">${all.map((id) => this.valueRow(id))}</div>
          </details>`
        : nothing}
    `;
  }

  /** one value of the device: opens that entity's own popup (switching happens there, with its confirmations) */
  private valueRow(id: string, name?: string, icon?: string) {
    const s = this.ctx.getState(id);
    return html`<button class="row pressable-row open" data-value=${id} @click=${() => this.ctx.push({ entity: id })}>
      ${icon ? html`<ha-icon class="ic" .icon=${icon}></ha-icon>` : nothing}
      <div class="grow">${name ?? entityName(this.hass, id, s)}</div>
      <div class="num">${s ? formatState(this.hass, s) : ''}</div>
    </button>`;
  }

  static override styles = [
    ...PopupBase.styles,
    css`
      .bar {
        height: 6px;
        border-radius: 3px;
        background: var(--fp-fill);
        overflow: hidden;
        margin: 0 var(--fp-space-1) var(--fp-space-3);
      }
      .bar span {
        display: block;
        height: 100%;
        background: var(--fp-accent);
        border-radius: 3px;
        transition: width 0.6s ease;
      }
      .seen {
        background: #2fa55a;
        color: #fff;
        margin-bottom: var(--fp-space-1);
      }
      .hint {
        font-size: var(--fp-text-caption);
        color: var(--fp-label-2);
        text-align: center;
        margin-bottom: var(--fp-space-3);
      }
      .row .ic {
        color: var(--fp-label-2);
        --mdc-icon-size: 20px;
      }
      .num {
        color: var(--fp-label-2);
        font-variant-numeric: tabular-nums;
        text-align: right;
      }
      .label-row {
        font-size: var(--fp-text-caption);
        color: var(--fp-label-2);
        margin: var(--fp-space-3) var(--fp-space-1) var(--fp-space-1);
      }
      .all summary {
        cursor: pointer;
        list-style: none;
      }
      .open {
        display: flex;
        align-items: center;
        gap: var(--fp-space-3);
        width: 100%;
        background: none;
        border: 0;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
    `,
  ];
}

if (!customElements.get('fp-appliance-popup')) customElements.define('fp-appliance-popup', FpAppliancePopup);
