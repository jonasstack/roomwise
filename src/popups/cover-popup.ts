import { css, html, nothing, svg } from 'lit';
import { PopupBase } from './popup-base';
import { callOptimistic } from '../actions';
import { entityName, formatState, isUnavailable } from '../ha';
import { t } from '../i18n';
import { coverLive, isGarageCover } from '../openings';
import { resolveFurniture } from '../furniture';
import { actionRow, actionRowStyles, sinceText } from './action-row';
import { describe, describeClose, openRequest } from '../access';
import '../components/controls';

// CoverEntityFeature bits
const F = { OPEN: 1, CLOSE: 2, SET_POSITION: 4, STOP: 8, OPEN_TILT: 16, CLOSE_TILT: 32, SET_TILT: 128 };

export class FpCoverPopup extends PopupBase {
  static override properties = { ...PopupBase.properties, _pos: { state: true } };
  declare _pos?: number;

  private supports(bit: number) {
    return ((this.stateObj?.attributes.supported_features ?? 0) & bit) !== 0;
  }

  private async svc(service: string, override: { state?: string; attributes?: Record<string, unknown> } = {}, data: Record<string, unknown> = {}) {
    // a door, gate or a car's cover: opening needs the slide (access.ts)
    const open = openRequest(this.hass, this.entityId, service, data, this.stateObj);
    if (open && !(await this.ctx.host.confirmOpen(open))) return;
    await this.safe(() => callOptimistic(this.ctx.host, this.entityId, override, 'cover', service, data));
  }

  /** Garage door or gate: from its device class, or because the plan shows it as one (opening / piece) */
  private garageKind(): { kind: 'garage' | 'gate'; variant?: string } | undefined {
    const s = this.stateObj;
    for (const f of this.ctx.config?.floors ?? []) {
      const op = f.openings?.find((o) => o.type === 'garage' && o.entity === this.entityId);
      if (op) return { kind: 'garage', variant: op.variant };
      for (const p of f.furniture ?? []) {
        if (p.entity !== this.entityId) continue;
        const r = resolveFurniture(p);
        if (r.k?.kind === 'garage_door') return { kind: 'garage' };
        if (r.k?.kind === 'gate') return { kind: 'gate', variant: r.variant };
      }
    }
    if (isGarageCover(s)) return { kind: s!.attributes.device_class === 'gate' ? 'gate' : 'garage' };
    return undefined;
  }

  /** Opening or closing a garage door or gate: the button, then the sheet that has to be slid (access.ts); stopping acts at once */
  private async garageSvc(service: 'open_cover' | 'close_cover' | 'stop_cover', kind: 'garage' | 'gate') {
    if (service === 'open_cover') {
      const name = entityName(this.hass, this.entityId, this.stateObj);
      const req = describe(this.hass, this.entityId, 'open');
      if (!(await this.ctx.host.confirmOpen({ ...req, icon: kind === 'gate' ? 'mdi:gate-open' : 'mdi:garage-open-variant', title: t(kind === 'gate' ? 'garage.confirm_open_gate' : 'garage.confirm_open', { name }) }))) return;
      return this.safe(() => callOptimistic(this.ctx.host, this.entityId, { state: 'opening' }, 'cover', service));
    }
    if (service === 'close_cover') {
      if (!(await this.ctx.host.confirmOpen(describeClose(this.hass, this.entityId, kind === 'gate')))) return;
      return this.safe(() => callOptimistic(this.ctx.host, this.entityId, { state: 'closing' }, 'cover', service));
    }
    return this.svc(service);
  }

  /** Front view of the door or gate, drawn as far open as it is (moves with a CSS transition) */
  private picture(kind: 'garage' | 'gate', variant: string | undefined, k: number, cls: string) {
    if (kind === 'gate') {
      const bars = (x0: number, w: number) => Array.from({ length: 7 }, (_, i) => svg`<rect x=${x0 + 4 + (i * (w - 10)) / 6} y="44" width="2.5" height="46" rx="1"></rect>`);
      const leaves =
        variant === 'sliding'
          ? svg`<g class="leaf" style=${`transform:translateX(${Math.round(k * 128)}px)`}><rect class="rail" x="26" y="42" width="128" height="4" rx="2"></rect><rect class="rail" x="26" y="88" width="128" height="4" rx="2"></rect>${bars(26, 128)}</g>`
          : svg`<g class="leaf" style=${`transform-origin:26px 0;transform:scaleX(${(1 - k * 0.82).toFixed(3)})`}><rect class="rail" x="26" y="42" width="64" height="4" rx="2"></rect><rect class="rail" x="26" y="88" width="64" height="4" rx="2"></rect>${bars(26, 64)}</g>
            <g class="leaf" style=${`transform-origin:154px 0;transform:scaleX(${(1 - k * 0.82).toFixed(3)})`}><rect class="rail" x="90" y="42" width="64" height="4" rx="2"></rect><rect class="rail" x="90" y="88" width="64" height="4" rx="2"></rect>${bars(90, 64)}</g>`;
      return html`<svg class="pic gate ${cls}" viewBox="0 0 180 104" aria-hidden="true">
        <rect class="ground" x="0" y="96" width="180" height="4" rx="2"></rect>
        <rect class="post" x="14" y="30" width="12" height="68" rx="2"></rect>
        <rect class="post" x="154" y="30" width="12" height="68" rx="2"></rect>
        ${leaves}
      </svg>`;
    }
    const n = variant === 'roller' ? 9 : 4;
    return html`<svg class="pic garage ${cls}" viewBox="0 0 180 120" aria-hidden="true">
      <path class="house" d="M 10 52 L 90 12 L 170 52 L 170 114 L 10 114 Z"></path>
      <rect class="inside" x="34" y="54" width="112" height="60" rx="2"></rect>
      <g class="panel" style=${`transform-origin:0 54px;transform:scaleY(${Math.max(0.03, 1 - k).toFixed(3)})`}>
        <rect x="34" y="54" width="112" height="60" rx="2"></rect>
        ${Array.from({ length: n - 1 }, (_, i) => svg`<line x1="36" x2="144" y1=${54 + ((i + 1) * 60) / n} y2=${54 + ((i + 1) * 60) / n}></line>`)}
      </g>
      ${variant === 'roller' ? svg`<rect class="box" x="30" y="48" width="120" height="8" rx="3"></rect>` : nothing}
    </svg>`;
  }

  private renderGarage(g: { kind: 'garage' | 'gate'; variant?: string }) {
    const s = this.stateObj!;
    const unavailable = isUnavailable(s);
    const live = coverLive(s);
    const hasPos = this.supports(F.SET_POSITION) && s.attributes.current_position != null;
    const since = sinceText(s);
    const state = formatState(this.hass, s);
    const sub = unavailable ? t('card.unavailable') : hasPos && live.open > 0 && live.open < 1 && !live.moving ? t('cover.open_pct', { n: Math.round(live.open * 100) }) : state;
    const cls = `${live.state} ${live.moving ?? ''}`;
    const canOpen = this.supports(F.OPEN) || !s.attributes.supported_features;
    const canClose = this.supports(F.CLOSE) || !s.attributes.supported_features;
    return html`
      ${this.renderHeader({ subtitle: sub })}
      ${this.picture(g.kind, g.variant, live.open, cls)}
      ${actionRow([
        { key: 'open', icon: g.kind === 'gate' ? 'mdi:gate-open' : 'mdi:garage-open-variant', label: t('cover.open'), on: () => this.garageSvc('open_cover', g.kind), disabled: unavailable || !canOpen || (s.state === 'open' && !live.moving) },
        ...(this.supports(F.STOP) ? [{ key: 'stop', icon: 'mdi:stop', label: t('cover.stop'), on: () => this.garageSvc('stop_cover', g.kind), disabled: unavailable, primary: !!live.moving }] : []),
        { key: 'close', icon: g.kind === 'gate' ? 'mdi:gate' : 'mdi:garage-variant', label: t('cover.close'), on: () => this.garageSvc('close_cover', g.kind), disabled: unavailable || !canClose || s.state === 'closed' },
      ])}
      <div class="note">
        <ha-icon icon="mdi:shield-check-outline"></ha-icon>
        <span>${since && !unavailable ? t(live.state === 'open' ? 'garage.open_since' : 'garage.closed_since', { t: since }) + ' · ' : ''}${t('garage.asks_first')}</span>
      </div>
    `;
  }

  override render() {
    const s = this.stateObj;
    if (!s) return this.renderHeader();
    const garage = this.garageKind();
    if (garage) return this.renderGarage(garage);
    const unavailable = isUnavailable(s);
    const hasPos = this.supports(F.SET_POSITION);
    const pos: number = this._pos ?? s.attributes.current_position ?? (s.state === 'open' ? 100 : 0);
    const tilt: number | undefined = s.attributes.current_tilt_position;
    return html`
      ${this.renderHeader({ subtitle: hasPos && !unavailable ? t('cover.open_pct', { n: pos }) : undefined })}
      <div class="body">
        ${hasPos
          ? html`<fp-slider
              class="shade"
              .value=${pos}
              .fill=${'var(--fp-accent)'}
              .label=${t('cover.position')}
              ?disabled=${unavailable}
              @value-input=${(e: CustomEvent) => (this._pos = e.detail.value)}
              @value-change=${(e: CustomEvent) => {
                this._pos = undefined;
                this.svc('set_cover_position', { attributes: { current_position: e.detail.value } }, { position: e.detail.value });
              }}
            >
              <div class="slats" aria-hidden="true">${Array.from({ length: 9 }, () => html`<i></i>`)}</div>
            </fp-slider>`
          : nothing}
        <div class="buttons">
          ${this.supports(F.OPEN)
            ? html`<button class="btn pressable" ?disabled=${unavailable} @click=${() => this.svc('open_cover', { state: 'opening' })}>
                <ha-icon icon="mdi:arrow-up"></ha-icon>${t('cover.open')}
              </button>`
            : nothing}
          ${this.supports(F.STOP)
            ? html`<button class="btn pressable" ?disabled=${unavailable} @click=${() => this.svc('stop_cover')}>
                <ha-icon icon="mdi:stop"></ha-icon>${t('cover.stop')}
              </button>`
            : nothing}
          ${this.supports(F.CLOSE)
            ? html`<button class="btn pressable" ?disabled=${unavailable} @click=${() => this.svc('close_cover', { state: 'closing' })}>
                <ha-icon icon="mdi:arrow-down"></ha-icon>${t('cover.close')}
              </button>`
            : nothing}
        </div>
      </div>
      ${this.supports(F.SET_TILT) && tilt != null
        ? html`<div class="label-s" style="margin-top:var(--fp-space-5)">${t('cover.tilt')}</div>
            <fp-slider
              horizontal
              .value=${tilt}
              .fill=${'var(--fp-accent)'}
              icon="mdi:angle-acute"
              ?disabled=${unavailable}
              @value-change=${(e: CustomEvent) =>
                this.svc('set_cover_tilt_position', { attributes: { current_tilt_position: e.detail.value } }, { tilt_position: e.detail.value })}
            ></fp-slider>`
        : nothing}
    `;
  }

  static override styles = [
    ...PopupBase.styles,
    actionRowStyles,
    css`
      .pic {
        display: block;
        width: min(240px, 70%);
        margin: 0 auto var(--fp-space-4);
        overflow: visible;
      }
      .pic .house {
        fill: var(--fp-surface);
        stroke: var(--fp-separator);
        stroke-width: 2;
        stroke-linejoin: round;
      }
      .pic .inside {
        fill: var(--fp-fill-strong);
      }
      .pic .panel {
        transition: transform 1.6s var(--fp-ease);
      }
      .pic .panel rect,
      .pic .box {
        fill: var(--fp-surface-2, var(--fp-surface));
        stroke: var(--fp-label-3);
        stroke-width: 1.5;
      }
      .pic .panel line {
        stroke: var(--fp-label-3);
        stroke-width: 1;
      }
      .pic.open .panel rect,
      .pic.open .inside {
        stroke: var(--fp-state-alert);
      }
      .pic.open .inside {
        fill: color-mix(in srgb, var(--fp-state-alert) 16%, var(--fp-fill-strong));
        stroke-width: 1.5;
      }
      .pic.opening .panel,
      .pic.closing .panel,
      .pic.opening .leaf,
      .pic.closing .leaf {
        transition-duration: 8s;
        transition-timing-function: linear;
      }
      .pic .ground {
        fill: var(--fp-separator);
      }
      .pic .post {
        fill: var(--fp-label-2);
      }
      .pic .leaf {
        transition: transform 1.6s var(--fp-ease);
      }
      .pic .leaf rect {
        fill: var(--fp-label-2);
      }
      .pic.open .leaf rect {
        fill: var(--fp-state-alert);
      }
      .body {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: var(--fp-space-7);
        flex-wrap: wrap;
      }
      fp-slider.shade {
        width: 140px;
        height: 300px;
      }
      .slats {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        justify-content: space-evenly;
        pointer-events: none;
      }
      .slats i {
        display: block;
        height: 1px;
        background: var(--fp-separator);
        opacity: 0.8;
      }
      .buttons {
        display: flex;
        flex-direction: column;
        gap: var(--fp-space-3);
        min-width: 180px;
      }
      .buttons .btn {
        justify-content: flex-start;
        min-height: 52px;
        background: var(--fp-surface);
      }
    `,
  ];
}

if (!customElements.get('fp-cover-popup')) customElements.define('fp-cover-popup', FpCoverPopup);
