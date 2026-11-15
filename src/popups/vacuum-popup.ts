import { css, html, nothing, type PropertyValues } from 'lit';
import { PopupBase } from './popup-base';
import { callOptimistic } from '../actions';
import { formatState, isUnavailable } from '../ha';
import { getLanguage, t } from '../i18n';
import type { HassEntity } from '../types';
import { companionInfo, vacuumClean, vacuumInfo } from '../entry-server';

// VacuumEntityFeature bits
const F = { PAUSE: 4, STOP: 8, RETURN_HOME: 16, FAN_SPEED: 32, LOCATE: 512, START: 8192, CLEAN_AREA: 16384 };

export class FpVacuumPopup extends PopupBase {
  static override properties = { ...PopupBase.properties, _areas: { state: true }, _sel: { state: true }, _segs: { state: true } };
  declare _areas?: string[];
  declare _sel: Set<string>;
  /** rooms of the robot's own map (companion: Dreame, Xiaomi, Valetudo …) when Home Assistant's area cleaning is
   * not set up for it */
  declare _segs?: { id: string; name: string | null }[];

  constructor() {
    super();
    this._sel = new Set();
  }

  private supports(bit: number) {
    return ((this.stateObj?.attributes.supported_features ?? 0) & bit) !== 0;
  }

  override willUpdate(changed: PropertyValues) {
    if (changed.has('entityId') || (!this._areas && this.ctx)) this.loadAreas();
  }

  /** Areas the robot knows: from the entity's area mapping (HA 2026+), else all areas. Without area cleaning
   * (or without a mapping), the rooms of the robot's own map if the companion can have them cleaned. */
  private async loadAreas() {
    if (this._areas) return;
    this._areas = [];
    let ids: string[] = [];
    if (this.supports(F.CLEAN_AREA))
      try {
        const entry = await this.hass.callWS<any>({ type: 'config/entity_registry/get', entity_id: this.entityId });
        ids = Object.keys(entry?.options?.vacuum?.area_mapping ?? {});
      } catch {
        /* non-admin or older HA */
      }
    if (!ids.length && companionInfo()) {
      const info = await vacuumInfo(this.hass, this.entityId);
      if (info?.clean && info.segments.length) {
        this._segs = info.segments;
        return;
      }
    }
    if (!this.supports(F.CLEAN_AREA)) return;
    if (!ids.length) ids = Object.keys(this.hass.areas ?? {});
    this._areas = ids.filter((id) => this.hass.areas?.[id]);
  }

  private battery(): number | undefined {
    const s = this.stateObj;
    if (!s) return undefined;
    if (s.attributes.battery_level != null) return s.attributes.battery_level;
    const dev = this.hass.entities?.[this.entityId]?.device_id;
    if (!dev) return undefined;
    for (const [id, e] of Object.entries(this.hass.entities))
      if (e.device_id === dev && id.startsWith('sensor.') && this.hass.states[id]?.attributes.device_class === 'battery') {
        const v = parseFloat(this.hass.states[id].state);
        if (!isNaN(v)) return v;
      }
    return undefined;
  }

  /** Other entities of the vacuum's device (mop settings, water tank, current room …) */
  private related(): { id: string; key: string }[] {
    const dev = this.hass.entities?.[this.entityId]?.device_id;
    if (!dev) return [];
    return Object.values(this.hass.entities)
      .filter((e) => e.device_id === dev && e.entity_id !== this.entityId && !e.hidden && this.hass.states[e.entity_id])
      .map((e) => ({ id: e.entity_id, key: `${e.translation_key ?? ''} ${e.entity_id}`.toLowerCase() }));
  }

  /** Name without the device's name in front ("Robo Wisch-Intensität" → "Wisch-Intensität") */
  private shortName(id: string): string {
    const s = this.hass.states[id];
    const dev = this.hass.devices?.[this.hass.entities?.[id]?.device_id ?? ''];
    const full = String(s?.attributes.friendly_name ?? id);
    const dn = dev?.name_by_user ?? dev?.name;
    return dn && full.startsWith(dn) ? full.slice(dn.length).trim() || full : full;
  }

  private option(id: string, o: string): string {
    const s = this.hass.states[id];
    try {
      if (s && this.hass.formatEntityState) return this.hass.formatEntityState(s, o);
    } catch {
      /* fall through */
    }
    return o.replace(/_/g, ' ');
  }

  /** Suction level: Home Assistant's translation when the integration has one, else ours */
  private fanLabel(s: HassEntity, f: string): string {
    try {
      const ha = this.hass.formatEntityAttributeValue?.(s, 'fan_speed', f);
      if (ha && ha !== f) return ha;
    } catch {
      /* older HA */
    }
    return fanLabel(f);
  }

  private svc(service: string, state?: string, data: Record<string, unknown> = {}) {
    this.safe(() => callOptimistic(this.ctx.host, this.entityId, { state }, 'vacuum', service, data));
  }

  private toggleArea(id: string) {
    const next = new Set(this._sel);
    next.has(id) ? next.delete(id) : next.add(id);
    this._sel = next;
  }

  private cleanAreas() {
    const ids = [...this._sel];
    if (!ids.length) return;
    if (this._segs) {
      // the robot's own rooms: the companion calls its integration (Dreame / Xiaomi service, Valetudo MQTT)
      vacuumClean(this.hass, this.entityId, ids).catch((err) => {
        console.info('[floorplan-card] room cleaning failed', err);
        this.ctx.host.toast(t('vacuum.clean_failed'));
      });
    } else this.svc('clean_area', 'cleaning', { cleaning_area_id: ids });
    this._sel = new Set();
  }

  /** Chips to pick rooms: Home Assistant areas, or the rooms of the robot's own map */
  private roomChoices(): { id: string; name: string; icon?: string }[] {
    if (this._segs) return this._segs.map((s) => ({ id: s.id, name: s.name ?? t('vacuum.segment', { id: s.id }) }));
    return (this._areas ?? []).map((id) => ({ id, name: this.hass.areas[id]?.name ?? id, icon: this.hass.areas[id]?.icon ?? undefined }));
  }

  override render() {
    const s = this.stateObj;
    if (!s) return this.renderHeader();
    const unavailable = isUnavailable(s);
    const cleaning = s.state === 'cleaning';
    const bat = this.battery();
    const fanList: string[] = s.attributes.fan_speed_list ?? [];
    const buttons = [
      cleaning
        ? { key: 'pause', icon: 'mdi:pause', label: t('vacuum.pause'), on: () => this.svc('pause', 'paused'), show: this.supports(F.PAUSE) }
        : { key: 'start', icon: 'mdi:play', label: t('vacuum.start'), on: () => this.svc('start', 'cleaning'), show: this.supports(F.START) },
      { key: 'stop', icon: 'mdi:stop', label: t('vacuum.stop'), on: () => this.svc('stop', 'idle'), show: this.supports(F.STOP) && cleaning },
      { key: 'dock', icon: 'mdi:home-import-outline', label: t('vacuum.dock'), on: () => this.svc('return_to_base', 'returning'), show: this.supports(F.RETURN_HOME) },
      { key: 'locate', icon: 'mdi:map-marker-radius-outline', label: t('vacuum.locate'), on: () => this.svc('locate'), show: this.supports(F.LOCATE) },
    ].filter((b) => b.show);

    // mopping (if the robot has it): its settings and what is attached; while it runs: room, progress, area, time
    const rel = this.related();
    const mopSelects = rel.filter((r) => r.id.startsWith('select.') && /mop|wisch|water|wasser|scrub/.test(r.key) && !/map|karte/.test(r.key));
    const mopState = rel.filter((r) => r.id.startsWith('binary_sensor.') && /mop|wasser|water/.test(r.key));
    const inRun = ['cleaning', 'paused', 'returning'].includes(s.state);
    const pick = (re: RegExp, not?: RegExp) => rel.find((r) => r.id.startsWith('sensor.') && re.test(r.key) && !(not && not.test(r.key)));
    const runInfo = inRun
      ? [pick(/current_room|aktueller_raum|current_area/), pick(/progress|fortschritt/), pick(/cleaning_area|reinigungsbereich|clean_area/, /total|gesamt/), pick(/cleaning_time|reinigungszeit|clean_time/, /total|gesamt|haupt|seiten|main_brush|side_brush|filter|verbleib|remaining/)].filter(
          (r): r is { id: string; key: string } => !!r && !isUnavailable(this.hass.states[r.id]),
        )
      : [];
    return html`
      ${this.renderHeader({
        subtitle: [formatState(this.hass, s), bat != null ? t('vacuum.battery', { n: Math.round(bat) }) : ''].filter(Boolean).join(' · '),
      })}
      <div class="actions">
        ${buttons.map(
          (b) => html`<button class="action pressable ${b.key === 'start' || b.key === 'pause' ? 'primary' : ''}" ?disabled=${unavailable} @click=${b.on} data-action=${b.key}>
            <span class="circle"><ha-icon .icon=${b.icon}></ha-icon></span>
            <span class="lbl">${b.label}</span>
          </button>`,
        )}
      </div>
      ${runInfo.length
        ? html`<div class="run">
            ${runInfo.map((r) => html`<div class="rt"><span class="rv">${formatState(this.hass, this.hass.states[r.id])}</span><span class="rk">${this.shortName(r.id)}</span></div>`)}
          </div>`
        : nothing}
      ${fanList.length && this.supports(F.FAN_SPEED)
        ? html`<div class="label-s">${t('vacuum.fan_speed')}</div>
            <div class="chips">
              ${fanList.map(
                (f) => html`<button
                  class="chip pressable"
                  aria-pressed=${s.attributes.fan_speed === f ? 'true' : 'false'}
                  @click=${() => this.safe(() => callOptimistic(this.ctx.host, this.entityId, { attributes: { fan_speed: f } }, 'vacuum', 'set_fan_speed', { fan_speed: f }))}
                >
                  ${this.fanLabel(s, f)}
                </button>`,
              )}
            </div>`
        : nothing}
      ${mopSelects.length || mopState.length
        ? html`<div class="label-s" style="margin-top:var(--fp-space-5)">${t('vacuum.mop')}</div>
            ${mopState.length
              ? html`<div class="status">
                  ${mopState.map((r) => {
                    const st = this.hass.states[r.id];
                    // water running low is a warning; mop / tank attached or not is just how it is
                    const shortage = /shortage|knapp|low|leer|empty/.test(r.key);
                    const warn = shortage && st.state === 'on';
                    const icon = warn ? 'mdi:alert-circle-outline' : shortage || st.state === 'on' ? 'mdi:check-circle-outline' : 'mdi:minus-circle-outline';
                    return html`<span class="pill ${warn ? 'warn' : shortage || st.state === 'on' ? 'ok' : ''}"><ha-icon .icon=${icon}></ha-icon>${this.shortName(r.id)}: ${formatState(this.hass, st)}</span>`;
                  })}
                </div>`
              : nothing}
            ${mopSelects.map((r) => {
              const st = this.hass.states[r.id];
              const opts: string[] = st.attributes.options ?? [];
              return html`<div class="sub">${this.shortName(r.id)}</div>
                <div class="chips">
                  ${opts.map(
                    (o) => html`<button
                      class="chip pressable"
                      aria-pressed=${st.state === o ? 'true' : 'false'}
                      ?disabled=${unavailable || isUnavailable(st)}
                      @click=${() => this.safe(() => callOptimistic(this.ctx.host, r.id, { state: o }, 'select', 'select_option', { option: o }))}
                    >
                      ${this.option(r.id, o)}
                    </button>`,
                  )}
                </div>`;
            })}`
        : nothing}
      ${this.roomChoices().length
        ? html`<div class="label-s" style="margin-top:var(--fp-space-5)">${t('vacuum.rooms')}</div>
            <div class="chips">
              ${this.roomChoices().map(
                (r) => html`<button class="chip pressable" data-room=${r.id} aria-pressed=${this._sel.has(r.id) ? 'true' : 'false'} @click=${() => this.toggleArea(r.id)}>
                  ${r.icon ? html`<ha-icon .icon=${r.icon}></ha-icon>` : nothing} ${r.name}
                </button>`,
              )}
            </div>
            <button class="btn accent block pressable clean" ?disabled=${!this._sel.size || unavailable} @click=${this.cleanAreas}>
              <ha-icon icon="mdi:broom"></ha-icon>
              ${!this._sel.size ? t('vacuum.select_rooms') : this._sel.size === 1 ? t('vacuum.clean_room') : t('vacuum.clean_rooms', { n: this._sel.size })}
            </button>`
        : nothing}
    `;
  }

  static override styles = [
    ...PopupBase.styles,
    css`
      .actions {
        display: flex;
        justify-content: center;
        gap: var(--fp-space-5);
        margin: var(--fp-space-2) 0 var(--fp-space-6);
      }
      .action {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--fp-space-2);
        min-width: 72px;
      }
      .action[disabled] {
        opacity: 0.35;
        pointer-events: none;
      }
      .circle {
        width: 68px;
        height: 68px;
        border-radius: 50%;
        background: var(--fp-surface);
        box-shadow: var(--fp-shadow-1);
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .circle ha-icon {
        --mdc-icon-size: 28px;
      }
      .action.primary .circle {
        background: var(--fp-accent);
        color: var(--fp-on-accent);
      }
      .lbl {
        font-size: var(--fp-text-footnote);
        font-weight: var(--fp-weight-semibold);
        color: var(--fp-label-2);
      }
      .clean {
        margin-top: var(--fp-space-4);
      }
      /* the running clean: room, progress, area, time */
      .run {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
        gap: var(--fp-space-2);
        margin: 0 0 var(--fp-space-5);
      }
      .rt {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 2px;
        padding: var(--fp-space-3);
        border-radius: var(--fp-radius-m);
        background: var(--fp-surface);
        box-shadow: var(--fp-shadow-1);
      }
      .rt .rv {
        white-space: nowrap;
        font-size: var(--fp-text-headline, 17px);
        font-weight: var(--fp-weight-semibold);
        font-variant-numeric: tabular-nums;
      }
      .rt .rk {
        font-size: var(--fp-text-caption);
        color: var(--fp-label-2);
      }
      .sub {
        font-size: var(--fp-text-footnote);
        color: var(--fp-label-2);
        margin: var(--fp-space-3) 0 var(--fp-space-2);
      }
      .status {
        display: flex;
        flex-wrap: wrap;
        gap: var(--fp-space-2);
      }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 4px 10px;
        border-radius: var(--fp-radius-full);
        font-size: var(--fp-text-footnote);
        background: var(--fp-fill);
      }
      .pill ha-icon {
        --mdc-icon-size: 16px;
      }
      .pill.ok ha-icon {
        color: #2fbf63;
      }
      .pill.warn {
        background: color-mix(in srgb, #ff9f0a 18%, transparent);
      }
      .pill.warn ha-icon {
        color: #ff9f0a;
      }
    `,
  ];
}

function fanLabel(f: string) {
  const map: Record<string, string> = {
    quiet: 'Leise',
    balanced: 'Ausgewogen',
    turbo: 'Turbo',
    max: 'Max',
    max_plus: 'Max+',
    gentle: 'Sanft',
    off: 'Aus',
    standard: 'Standard',
    strong: 'Stark',
  };
  return getLanguage() === 'en' ? f.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : map[f] ?? f;
}

if (!customElements.get('fp-vacuum-popup')) customElements.define('fp-vacuum-popup', FpVacuumPopup);
