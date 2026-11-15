import { css, html, nothing, svg, type TemplateResult } from 'lit';
import { PopupBase } from './popup-base';
import type { FurnitureConfig, HassEntity } from '../types';
import { CAR_POS, CAR_ROLE, carInfo, isLocked, isOpenState, plugText, type CarGroup, type CarInfo, type CarPart, type CarPos } from '../car-info';
import { CARS, PROFILES, type CarShape } from '../cars';
import { carImage } from '../gl/car-image';
import { resolveFurniture } from '../furniture';
import { carAway, chargingState, numOf } from '../models';
import { entityName, formatState, isUnavailable } from '../ha';
import { formatNumber, getLanguage, t, type I18nKey } from '../i18n';
import { describe, openRequest, type OpenRequest } from '../access';

type Op = () => Promise<unknown>;

/**
 * Car overview: side view in the car's paint, battery & range, the quick actions, and everything the car's
 * integration offers grouped into Klima (climate), Laden (charging), Öffnen & Schließen (open & close: locks,
 * tailgate, frunk, sunroof, windows, charge flap, horn and lights) and Zustand (state: a drawing of the car with
 * what is open, tyre pressures, trip values, warnings) — plus the owner's own entities and every further value.
 * Anything that opens (unlocking too) asks with the slide sheet (access.ts); closing and locking act at once.
 */
export class FpCarPopup extends PopupBase {
  static override properties = { ...PopupBase.properties, car: { attribute: false }, _all: { state: true }, _busy: { state: true }, _img: { state: true }, _limit: { state: true } };
  declare car: FurnitureConfig;
  declare _all: boolean;
  declare _busy?: string;
  /** still image rendered from the 3D model */
  declare _img?: string;
  /** charge limit just chosen (until the car reports it) */
  declare _limit?: number;
  private imgKey = '';

  private loadImage(shape: CarShape, f: FurnitureConfig, paint: string, roof: string | undefined) {
    const key = `${f.variant}|${paint}|${roof ?? ''}|${f.w}|${f.h}`;
    if (key === this.imgKey) return;
    this.imgKey = key;
    void carImage(shape, f.w, f.h, resolveFurniture(f).height, paint, roof).then((url) => {
      if (this.imgKey === key) this._img = url;
    });
  }

  private get carTitle(): string {
    const shape = CARS[resolveFurniture(this.car).variant] ?? CARS.compact;
    return this.car.name || (getLanguage() === 'en' ? shape.en : shape.de);
  }

  private vin(e: CarInfo): string | undefined {
    for (const id of [e.roles.limit, e.roles.soc, e.roles.range, ...e.ids]) {
      const v = this.s(id)?.attributes.vin;
      if (typeof v === 'string') return v;
    }
    return undefined;
  }

  private services(): Record<string, Record<string, unknown>> {
    return (this.hass as unknown as { services?: Record<string, Record<string, unknown>> }).services ?? {};
  }

  /** Charge limit: a number / select entity, or the Mercedes me service with the car's VIN */
  private limitControl(e: CarInfo): { set: (v: number) => Promise<unknown>; options: number[] } | undefined {
    const id = e.roles.limit;
    if (id?.startsWith('number.')) {
      const st = this.s(id);
      const min = Number(st?.attributes.min ?? 50);
      const max = Number(st?.attributes.max ?? 100);
      const step = Math.max(5, Number(st?.attributes.step ?? 10));
      const options: number[] = [];
      for (let v = Math.ceil(min / step) * step; v <= max; v += step) options.push(v);
      return { options, set: (v) => this.hass.callService('number', 'set_value', { value: v }, { entity_id: id }) };
    }
    if (id?.startsWith('select.')) {
      const opts = ((this.s(id)?.attributes.options as string[] | undefined) ?? []).filter((o) => !isNaN(parseFloat(o)));
      if (opts.length) return { options: opts.map((o) => parseFloat(o)), set: (v) => this.hass.callService('select', 'select_option', { option: opts.find((o) => parseFloat(o) === v) }, { entity_id: id }) };
    }
    const vin = this.vin(e);
    if (vin && this.services().mbapi2020?.battery_max_soc_configure)
      return { options: [50, 60, 70, 80, 90, 100], set: (v) => this.hass.callService('mbapi2020', 'battery_max_soc_configure', { vin, max_soc: String(v) }) };
    return undefined;
  }

  private s(id?: string): HassEntity | undefined {
    return id ? this.ctx.getState(id) : undefined;
  }

  private on(id?: string) {
    const st = this.s(id);
    return !!st && ['on', 'true', 'running', 'heat', 'cool', 'heat_cool', 'auto', 'heat_only', 'fan_only', 'dry'].includes(st.state.toLowerCase());
  }

  private label(key: string): string {
    return t(`car.role.${key}` as I18nKey);
  }

  /** Run a call; `open` first asks with the slide sheet (and only then sends exactly one call) */
  private async run(key: string, fn: Op, open?: OpenRequest) {
    if (open && !(await this.ctx.host.confirmOpen(open))) return;
    this._busy = key;
    await this.safe(fn);
    window.setTimeout(() => (this._busy = undefined), 1500);
  }

  private call(domain: string, service: string, id: string, data: Record<string, unknown> = {}): Op {
    return () => this.hass.callService(domain, service, data, { entity_id: id });
  }

  private openReq(id: string, label: string, verb: OpenRequest['verb'] = 'open'): OpenRequest {
    return describe(this.hass, id, verb, label, this.carTitle);
  }

  private preclimate(e: CarInfo, active: boolean) {
    const id = e.roles.preclimate;
    if (id) {
      const d = id.split('.')[0];
      return this.run('pre', this.call(d === 'climate' ? 'climate' : 'switch', active ? 'turn_off' : 'turn_on', id));
    }
    const btn = active ? e.roles.pre_stop : e.roles.pre_start;
    if (btn) return this.run('pre', this.call('button', 'press', btn));
  }

  /** Open / close of a part: its cover, lock or switch, its buttons, or the Mercedes me services */
  private partOps(e: CarInfo, p: CarPart): { open?: Op; close?: Op; openId?: string; verb: OpenRequest['verb'] } {
    const c = p.control;
    const d = c?.split('.')[0];
    if (c && d === 'cover') return { open: this.call('cover', 'open_cover', c), close: this.call('cover', 'close_cover', c), openId: c, verb: 'open' };
    if (c && d === 'switch') return { open: this.call('switch', 'turn_on', c), close: this.call('switch', 'turn_off', c), openId: c, verb: 'open' };
    if (c && d === 'lock') {
      const canOpen = ((this.s(c)?.attributes.supported_features ?? 0) & 1) !== 0;
      const latch = p.key !== 'lock' && canOpen;
      return { open: this.call('lock', latch ? 'open' : 'unlock', c), close: this.call('lock', 'lock', c), openId: c, verb: p.key === 'lock' ? 'unlock' : 'open' };
    }
    const out: ReturnType<FpCarPopup['partOps']> = { verb: 'open' };
    if (p.open) Object.assign(out, { open: this.call('button', 'press', p.open), openId: p.open });
    if (p.close) out.close = this.call('button', 'press', p.close);
    // Mercedes me: sunroof and windows through the integration's services (with the car's VIN)
    const mb = this.services().mbapi2020;
    const vin = mb ? this.vin(e) : undefined;
    if (vin && (p.key === 'sunroof' || p.key === 'windows')) {
      if (!out.open && mb![`${p.key}_open`]) Object.assign(out, { open: () => this.hass.callService('mbapi2020', `${p.key}_open`, { vin }), openId: p.state });
      if (!out.close && mb![`${p.key}_close`]) out.close = () => this.hass.callService('mbapi2020', `${p.key}_close`, { vin });
    }
    return out;
  }

  /** open (true) / closed (false) / unknown of a part */
  private partOpen(p: CarPart): boolean | undefined {
    const st = isOpenState(this.s(p.state), this.hass);
    if (st != null) return st;
    if (p.key === 'lock') return undefined;
    return isOpenState(this.s(p.control), this.hass);
  }

  private openText(v: boolean | undefined): string {
    return v == null ? '–' : v ? t('car.open') : t('car.closed');
  }

  /** One row of the "open & close" group */
  private partRow(e: CarInfo, p: CarPart): TemplateResult {
    const ops = this.partOps(e, p);
    const label = this.label(p.key);
    const lockS = p.key === 'lock' ? isLocked(this.hass, e, (id) => this.s(id)) : undefined;
    const open = p.key === 'lock' ? (lockS == null ? undefined : !lockS) : this.partOpen(p);
    const state = p.key === 'lock' ? (lockS == null ? '–' : lockS ? t('car.locked') : t('car.unlocked')) : this.openText(open);
    const openReq = ops.openId ? this.openReq(ops.openId, label, ops.verb) : { ...this.openReq(p.state ?? e.ids[0], label, ops.verb), icon: p.icon };
    return html`<div class="prow ${open ? 'is-open' : ''}" data-part=${p.key}>
      <ha-icon .icon=${p.icon}></ha-icon>
      <div class="grow"><div class="pl">${label}</div><div class="pv">${state}</div></div>
      ${ops.open
        ? html`<button class="btn small pressable ${this._busy === `${p.key}:open` ? 'busy' : ''}" data-op="open" @click=${() => this.run(`${p.key}:open`, ops.open!, openReq)}>
            ${p.key === 'lock' ? t('car.unlock') : t('car.open_btn')}
          </button>`
        : nothing}
      ${ops.close
        ? html`<button class="btn small pressable ${this._busy === `${p.key}:close` ? 'busy' : ''}" data-op="close" @click=${() => this.run(`${p.key}:close`, ops.close!)}>
            ${p.key === 'lock' ? t('car.lock') : t('car.close_btn')}
          </button>`
        : nothing}
    </div>`;
  }

  /** A control or value of the car by its domain (switch, button, number, select, climate, cover, lock, sensor …) */
  private ctrl(id: string, label: string, icon: string, key = id): TemplateResult {
    const st = this.s(id);
    const d = id.split('.')[0];
    // buttons report "unknown" until first pressed: only "unavailable" counts there
    const na = !st || (['button', 'input_button', 'script', 'scene'].includes(d) ? st.state === 'unavailable' : isUnavailable(st));
    const valueRow = (v: string) =>
      html`<button class="prow value pressable" data-entity=${id} @click=${() => this.ctx.push({ entity: id })}>
        <ha-icon .icon=${icon}></ha-icon><div class="grow"><div class="pl">${label}</div></div><span class="pv">${v}</span>
      </button>`;
    const opens = (service: string) => openRequest(this.hass, id, service, {}, st) && this.openReq(id, label);
    if (d === 'switch' || d === 'input_boolean' || d === 'climate') {
      const on = this.on(id);
      const svc = on ? 'turn_off' : 'turn_on';
      return html`<div class="prow" data-entity=${id}>
        <ha-icon .icon=${icon}></ha-icon><div class="grow"><div class="pl">${label}</div><div class="pv">${na ? t('card.unavailable') : on ? t('common.on') : t('common.off')}</div></div>
        <button class="toggle pressable ${on ? 'on' : ''}" role="switch" aria-checked=${on ? 'true' : 'false'} aria-label=${label} ?disabled=${na} @click=${() => this.run(key, this.call(d === 'climate' ? 'climate' : d === 'input_boolean' ? 'input_boolean' : 'switch', svc, id), on ? undefined : opens('turn_on') || undefined)}><span></span></button>
      </div>`;
    }
    if (d === 'button' || d === 'input_button' || d === 'script' || d === 'scene') {
      const svc = d === 'script' || d === 'scene' ? 'turn_on' : 'press';
      return html`<div class="prow" data-entity=${id}>
        <ha-icon .icon=${icon}></ha-icon><div class="grow"><div class="pl">${label}</div></div>
        <button class="btn small pressable ${this._busy === key ? 'busy' : ''}" ?disabled=${na} @click=${() => this.run(key, this.call(d, svc, id), opens('press') || undefined)}>${t('car.press')}</button>
      </div>`;
    }
    if (d === 'number' || d === 'input_number') {
      const v = numOf(st);
      const step = Number(st?.attributes.step ?? 1);
      const min = Number(st?.attributes.min ?? 0);
      const max = Number(st?.attributes.max ?? 100);
      const set = (n: number) => this.run(key, this.call(d, 'set_value', id, { value: Math.max(min, Math.min(max, Math.round(n / step) * step)) }));
      return html`<div class="prow" data-entity=${id}>
        <ha-icon .icon=${icon}></ha-icon><div class="grow"><div class="pl">${label}</div></div>
        <button class="icon-btn pressable" aria-label="−" ?disabled=${na || v == null} @click=${() => set((v ?? min) - step)}><ha-icon icon="mdi:minus"></ha-icon></button>
        <span class="pv num">${v == null ? '–' : `${formatNumber(v, step < 1 ? 1 : 0)} ${st?.attributes.unit_of_measurement ?? ''}`}</span>
        <button class="icon-btn pressable" aria-label="+" ?disabled=${na || v == null} @click=${() => set((v ?? min) + step)}><ha-icon icon="mdi:plus"></ha-icon></button>
      </div>`;
    }
    if (d === 'select' || d === 'input_select') {
      const opts = (st?.attributes.options as string[] | undefined) ?? [];
      return html`<div class="prow col" data-entity=${id}>
        <div class="prow-top"><ha-icon .icon=${icon}></ha-icon><div class="grow"><div class="pl">${label}</div></div></div>
        <div class="chips">
          ${opts.map((o) => html`<button class="chip pressable" aria-pressed=${st?.state === o ? 'true' : 'false'} ?disabled=${na} @click=${() => this.run(key, this.call(d, 'select_option', id, { option: o }))}>${this.hass.formatEntityState?.(st!, o) ?? o}</button>`)}
        </div>
      </div>`;
    }
    if (d === 'cover' || d === 'lock') {
      const p: CarPart = { key, icon, control: id };
      const ops = this.partOps({ roles: {}, ids: [id] } as unknown as CarInfo, p);
      const open = isOpenState(st, this.hass);
      return html`<div class="prow" data-entity=${id}>
        <ha-icon .icon=${icon}></ha-icon><div class="grow"><div class="pl">${label}</div><div class="pv">${d === 'lock' ? (st?.state === 'locked' ? t('car.locked') : t('car.unlocked')) : this.openText(open)}</div></div>
        <button class="btn small pressable" data-op="open" ?disabled=${na} @click=${() => this.run(`${key}:open`, ops.open!, this.openReq(id, label, d === 'lock' ? 'unlock' : 'open'))}>${d === 'lock' ? t('car.unlock') : t('car.open_btn')}</button>
        <button class="btn small pressable" data-op="close" ?disabled=${na} @click=${() => this.run(`${key}:close`, ops.close!)}>${d === 'lock' ? t('car.lock') : t('car.close_btn')}</button>
      </div>`;
    }
    return valueRow(na ? '–' : formatState(this.hass, st));
  }

  /** The owner's own entities of a group */
  private extras(e: CarInfo, g: CarGroup): TemplateResult[] {
    return e.extras.filter((x) => x.group === g && this.s(x.entity)).map((x) => this.ctrl(x.entity, x.name || entityName(this.hass, x.entity, this.s(x.entity)), x.icon || 'mdi:car-info', `extra:${x.entity}`));
  }

  /** Group "open & close" */
  private accessGroup(e: CarInfo): TemplateResult | typeof nothing {
    const rows = [
      ...e.parts.map((p) => this.partRow(e, p)),
      ...(['horn', 'flash'] as const).filter((k) => e.roles[k]).map((k) => this.ctrl(e.roles[k], this.label(k), CAR_ROLE[k].icon, k)),
      ...this.extras(e, 'access'),
    ];
    return this.group('access', 'mdi:car-door-lock', rows);
  }

  private climateGroup(e: CarInfo, preActive: boolean): TemplateResult | typeof nothing {
    const r = e.roles;
    const rows = [
      r.preclimate ? this.ctrl(r.preclimate, this.label('preclimate'), 'mdi:air-conditioner', 'pre') : r.pre_start || r.pre_stop
        ? html`<div class="prow"><ha-icon icon="mdi:air-conditioner"></ha-icon><div class="grow"><div class="pl">${this.label('preclimate')}</div><div class="pv">${preActive ? t('car.pre_on') : t('common.off')}</div></div>
            <button class="btn small pressable" @click=${() => this.preclimate(e, preActive)}>${preActive ? t('car.stop') : t('car.start')}</button></div>`
        : nothing,
      r.climate_temp ? this.ctrl(r.climate_temp, this.label('climate_temp'), 'mdi:thermometer') : nothing,
      ...e.seats.map((id) => this.ctrl(id, entityName(this.hass, id, this.s(id)).replace(this.devPrefix(id), '') || this.label('seat'), 'mdi:car-seat-heater')),
      r.wheel ? this.ctrl(r.wheel, this.label('wheel'), 'mdi:steering') : nothing,
      r.defrost ? this.ctrl(r.defrost, this.label('defrost'), 'mdi:car-defrost-rear') : nothing,
      r.departure ? this.ctrl(r.departure, this.label('departure'), 'mdi:clock-start') : nothing,
      r.interior ? this.ctrl(r.interior, this.label('interior'), 'mdi:thermometer') : nothing,
      ...this.extras(e, 'climate'),
    ].filter((x) => x !== nothing) as TemplateResult[];
    return this.group('climate', 'mdi:air-conditioner', rows);
  }

  private chargeGroup(e: CarInfo): TemplateResult | typeof nothing {
    const r = e.roles;
    const rows = [
      r.charge_switch ? this.ctrl(r.charge_switch, this.label('charge_switch'), 'mdi:ev-station') : nothing,
      r.charge_start ? this.ctrl(r.charge_start, this.label('charge_start'), 'mdi:play') : nothing,
      r.charge_stop ? this.ctrl(r.charge_stop, this.label('charge_stop'), 'mdi:stop') : nothing,
      r.current ? this.ctrl(r.current, this.label('current'), 'mdi:current-ac') : nothing,
      r.power ? this.ctrl(r.power, this.label('power'), 'mdi:flash') : nothing,
      r.end ? this.ctrl(r.end, this.label('end'), 'mdi:timer-outline') : nothing,
      r.fuel ? this.ctrl(r.fuel, this.label('fuel'), 'mdi:gas-station') : nothing,
      r.fuel_range ? this.ctrl(r.fuel_range, this.label('fuel_range'), 'mdi:gas-station') : nothing,
      ...this.extras(e, 'charge'),
    ].filter((x) => x !== nothing) as TemplateResult[];
    return this.group('charge', 'mdi:ev-station', rows);
  }

  private group(g: CarGroup, icon: string, rows: TemplateResult[], top?: TemplateResult | typeof nothing): TemplateResult | typeof nothing {
    if (!rows.length && (!top || top === nothing)) return nothing;
    return html`<section class="grp" data-group=${g}>
      <div class="label-s grp-t"><ha-icon .icon=${icon}></ha-icon>${t(`car.group_${g}` as I18nKey)}</div>
      ${top ?? nothing}
      ${rows.length ? html`<div class="card rows">${rows}</div>` : nothing}
    </section>`;
  }

  private devPrefix(id: string): RegExp {
    const n = this.hass.devices?.[this.hass.entities[id]?.device_id ?? '']?.name ?? '';
    return new RegExp(`^${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i');
  }

  /** Drawing of the car from above: doors, windows, sunroof, tailgate, frunk and charge flap as far as known (red = open),
   * the four tyre pressures around it */
  private stateView(e: CarInfo): TemplateResult | typeof nothing {
    const r = e.roles;
    const part = (k: string) => e.parts.find((p) => p.key === k);
    const po = (k: string) => {
      const p = part(k);
      return p ? this.partOpen(p) : undefined;
    };
    const allWin = po('windows');
    const allDoors = isOpenState(this.s(r.doors), this.hass);
    const win = (p: CarPos) => isOpenState(this.s(r[`window_${p}`]), this.hass) ?? allWin;
    const door = (p: CarPos) => isOpenState(this.s(r[`door_${p}`]), this.hass) ?? allDoors;
    const tires = CAR_POS.map((p) => r[`tire_${p}`]);
    const known = [po('trunk'), po('frunk'), po('sunroof'), po('charge_flap'), ...CAR_POS.map(win), ...CAR_POS.map(door)].some((v) => v != null);
    if (!known && !tires.some(Boolean)) return nothing;
    const cls = (v: boolean | undefined) => (v == null ? 'unk' : v ? 'open' : 'shut');
    const warn = this.on(r.tire_warn);
    const val = (id?: string) => {
      const st = this.s(id);
      const v = numOf(st);
      if (v == null) return '–';
      const unit = String(st?.attributes.unit_of_measurement ?? '');
      return unit.toLowerCase() === 'kpa' ? `${formatNumber(v / 100, 1)} bar` : `${formatNumber(v, 1)} ${unit}`;
    };
    // doors swing out about their front hinge; front of the car is at the top
    const doorEl = (p: CarPos) => {
      const left = p === 'fl' || p === 'rl';
      const y = p === 'fl' || p === 'fr' ? 62 : 98;
      const x = left ? 12 : 104;
      const o = door(p);
      const rot = o ? (left ? 38 : -38) : 0;
      return svg`<rect class="door ${cls(o)}" data-door=${p} x=${x} y=${y} width="4" height="34" rx="2" style=${`transform-origin:${x + 2}px ${y}px;transform:rotate(${rot}deg)`}></rect>`;
    };
    const winEl = (p: CarPos) => {
      const left = p === 'fl' || p === 'rl';
      const y = p === 'fl' || p === 'fr' ? 66 : 101;
      return svg`<rect class="win ${cls(win(p))}" data-window=${p} x=${left ? 20 : 95} y=${y} width="5" height="27" rx="2"></rect>`;
    };
    const sun = po('sunroof');
    return html`<div class="card stateview ${warn ? 'warn' : ''}">
      ${tires.some(Boolean) ? html`<div class="label-s">${t('car.tires')}${warn ? html` · <span class="bad">${t('car.check')}</span>` : nothing}</div>` : nothing}
      <div class="tire-grid">
        <div class="tv fl">${r.tire_fl ? val(r.tire_fl) : ''}</div>
        <svg viewBox="0 0 120 200" class="topview" aria-hidden="true">
          <rect x="16" y="6" width="88" height="188" rx="30" class="tv-body"></rect>
          ${[[10, 36], [104, 36], [10, 140], [104, 140]].map(([x, y]) => svg`<rect x=${x} y=${y} width="6" height="26" rx="3" class="tv-tyre"></rect>`)}
          <path class="lid frunk ${cls(po('frunk'))}" data-lid="frunk" d="M 24 52 L 24 30 Q 24 12 46 12 L 74 12 Q 96 12 96 30 L 96 52 Z"></path>
          <rect class="tv-glass" x="26" y="56" width="68" height="18" rx="6"></rect>
          <rect class="tv-glass" x="28" y="130" width="64" height="14" rx="6"></rect>
          <rect class="roof" x="30" y="78" width="60" height="48" rx="8"></rect>
          <rect class="sunroof ${cls(sun)}" data-lid="sunroof" x="38" y=${sun ? 104 : 84} width="44" height="22" rx="4"></rect>
          <path class="lid trunk ${cls(po('trunk'))}" data-lid="trunk" d="M 24 148 L 96 148 L 96 168 Q 96 188 74 188 L 46 188 Q 24 188 24 168 Z"></path>
          ${part('charge_flap') ? svg`<circle class="flap ${cls(po('charge_flap'))}" data-lid="charge_flap" cx="100" cy="160" r="4.5"></circle>` : nothing}
          ${CAR_POS.map(winEl)}${CAR_POS.map(doorEl)}
        </svg>
        <div class="tv fr">${r.tire_fr ? val(r.tire_fr) : ''}</div>
        <div class="tv rl">${r.tire_rl ? val(r.tire_rl) : ''}</div>
        <div class="tv rr">${r.tire_rr ? val(r.tire_rr) : ''}</div>
      </div>
    </div>`;
  }

  private tile(icon: string, label: string, value: string, bad = false, id?: string) {
    return html`<div class="st ${bad ? 'bad' : ''}" data-entity=${id ?? ''}><ha-icon .icon=${icon}></ha-icon><div><div class="st-l">${label}</div><div class="st-v">${value}</div></div></div>`;
  }

  /** Side view of the car in its paint (from the same profile as the 3D model) */
  private side(shape: CarShape, paint: string, roof: string | undefined): TemplateResult {
    const P = PROFILES[shape.body];
    const L = 100;
    const H = (shape.H / shape.L) * 100;
    const X = (f: number) => L * f;
    const z = (v: number) => H - v;
    const clear = H * 0.095;
    const r = Math.min(H * 0.24, (H * (shape.body === 'micro' ? 0.38 : 0.45)) / 2);
    const xf = L * (1 - P.overF);
    const xr = L * P.overR;
    const belt = H * P.belt;
    const hood = H * P.hood;
    const trunk = H * P.trunk;
    const notch = shape.body === 'sedan' || shape.body === 'coupe';
    const body = [
      `M ${2} ${z(clear)}`,
      `L ${xr - r * 1.12} ${z(clear)} A ${r * 1.12} ${r * 1.12} 0 0 1 ${xr + r * 1.12} ${z(clear)}`,
      `L ${xf - r * 1.12} ${z(clear)} A ${r * 1.12} ${r * 1.12} 0 0 1 ${xf + r * 1.12} ${z(clear)}`,
      `L ${L - 3} ${z(clear)} Q ${L} ${z(clear)} ${L} ${z(clear + (hood - clear) * 0.45)} Q ${L - 0.5} ${z(hood - 1)} ${L - 5} ${z(hood)}`,
      `Q ${X((P.cowl + 1) / 2)} ${z(hood + (belt - hood) * 0.65)} ${X(P.cowl)} ${z(belt)}`,
      notch ? `L ${X(P.deck)} ${z(belt)} Q ${X(0.04)} ${z(trunk + 0.5)} ${1} ${z(trunk - 1)}` : `L ${2} ${z(belt)}`,
      `Q ${-0.3} ${z(belt - (belt - clear) * 0.25)} ${0} ${z(clear + (belt - clear) * 0.4)} Q ${0} ${z(clear)} ${2} ${z(clear)} Z`,
    ].join(' ');
    const rearBase = notch ? X(P.deck) : 2.5;
    const roofZ = H - 0.8;
    const cabin = `M ${X(P.cowl) - 1} ${z(belt)} Q ${X((P.cowl + P.roofF) / 2) + 1.2} ${z(belt + (roofZ - belt) * 0.62)} ${X(P.roofF)} ${z(roofZ)} Q ${X((P.roofF + P.roofR) / 2)} ${z(roofZ + 0.8)} ${X(P.roofR)} ${z(roofZ)} Q ${X(P.roofR) - 1.2} ${z(roofZ - (roofZ - belt) * 0.35)} ${rearBase} ${z(belt)} Z`;
    const roofLine = `M ${X(P.roofF) - 1} ${z(roofZ) + 0.2} Q ${X((P.roofF + P.roofR) / 2)} ${z(roofZ + 0.8) - 0.4} ${X(P.roofR) + 0.8} ${z(roofZ) + 0.2}`;
    const bx = X((P.roofF + P.roofR) / 2 + 0.02);
    return html`<svg class="side" viewBox="-4 -4 108 ${H + 8}" aria-hidden="true">
      <defs>
        <linearGradient id="fp-car-paint" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color=${paint} stop-opacity="1"></stop>
          <stop offset="0.55" stop-color=${paint}></stop>
          <stop offset="1" stop-color="#000" stop-opacity="0.35"></stop>
        </linearGradient>
        <linearGradient id="fp-car-glass" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#4a5c6e"></stop>
          <stop offset="1" stop-color="#1c2731"></stop>
        </linearGradient>
      </defs>
      <ellipse cx="50" cy=${H + 1.2} rx="52" ry="2.4" fill="rgba(0,0,0,0.18)"></ellipse>
      ${svg`<path d=${cabin} fill="url(#fp-car-glass)" stroke=${roof ?? paint} stroke-width="1.2" stroke-linejoin="round"></path>`}
      ${shape.body !== 'micro' && shape.body !== 'coupe' ? svg`<line x1=${bx} y1=${z(belt)} x2=${bx + 0.4} y2=${z(roofZ)} stroke=${roof ?? paint} stroke-width="1.4"></line>` : nothing}
      ${svg`<path d=${roofLine} fill="none" stroke=${roof ?? paint} stroke-width="1.6" stroke-linecap="round"></path>`}
      <path d=${body} fill=${paint}></path>
      <path d=${body} fill="url(#fp-car-paint)" opacity="0.55"></path>
      <line x1=${X(P.cowl) - 2} y1=${z(belt) + 0.8} x2=${rearBase + 1} y2=${z(belt) + 0.8} stroke="rgba(255,255,255,0.35)" stroke-width="0.5"></line>
      ${[xr, xf].map((x) => svg`<circle cx=${x} cy=${z(r)} r=${r} fill="#17181a"></circle><circle cx=${x} cy=${z(r)} r=${r * 0.64} fill="#c4c8cd"></circle><circle cx=${x} cy=${z(r)} r=${r * 0.2} fill="#7d838a"></circle>`)}
      <rect x=${L - 3.5} y=${z(hood) + 1.2} width="3" height="1.6" rx="0.8" fill="#f3f7ff"></rect>
      <rect x="0" y=${z(notch ? trunk : belt) + 1.4} width="1.4" height="2.2" rx="0.6" fill="#d42520"></rect>
      ${shape.star ? svg`<circle cx=${L - 0.6} cy=${z(clear + (hood - clear) * 0.47)} r="1.1" fill="#e6e9ec" stroke="#8d9297" stroke-width="0.2"></circle>` : nothing}
    </svg>`;
  }

  override render() {
    const f = this.car;
    if (!f || !this.ctx) return nothing;
    const de = getLanguage() !== 'en';
    const r = resolveFurniture(f);
    const shape = CARS[r.variant] ?? CARS.compact;
    const e = carInfo(this.hass, f);
    const ro = e.roles;
    const soc = numOf(this.s(ro.soc));
    const range = numOf(this.s(ro.range));
    const chS = this.s(ro.charging);
    const charging = chS ? chargingState(chS) : (numOf(this.s(ro.power)) ?? 0) > 50;
    const power = numOf(this.s(ro.power));
    const limit = numOf(this.s(ro.limit));
    const loc = this.s(ro.location);
    const away = carAway(loc);
    const addr = this.s(ro.address);
    const where = addr && !isUnavailable(addr) && addr.state !== 'unknown' ? addr.state : loc ? (loc.state === 'home' ? t('car.home') : loc.state === 'not_home' ? t('car.away') : loc.state) : undefined;
    const locked = isLocked(this.hass, e, (id) => this.s(id));
    const preActive = this.on(ro.pre_state) || this.on(ro.preclimate);
    const end = this.s(ro.end);
    const endT = end && end.state !== 'unknown' && !isNaN(Date.parse(end.state)) ? new Date(end.state).toLocaleTimeString(de ? 'de-DE' : 'en-GB', { hour: '2-digit', minute: '2-digit' }) : undefined;
    const low = soc != null && soc <= (f.low ?? 15);
    const col = soc == null ? 'var(--fp-label-3)' : low ? '#e5483a' : soc <= 35 ? '#e8a92c' : '#2fbf63';
    const title = this.carTitle;
    this.loadImage(shape, f, r.color, f.accent ? r.accent : undefined);
    const lim = this.limitControl(e);
    const limitNow = this._limit ?? (limit != null ? Math.round(limit) : undefined);
    const warnings = e.warnings.filter((id) => this.on(id) && id !== ro.tire_warn);
    const lockPart = e.parts.find((p) => p.key === 'lock');
    const lockOps = lockPart ? this.partOps(e, lockPart) : undefined;
    const actions = [
      ro.preclimate || ro.pre_start
        ? { key: 'pre', icon: preActive ? 'mdi:fan' : 'mdi:air-conditioner', label: preActive ? t('car.pre_on') : t('car.pre'), on: () => this.preclimate(e, preActive), active: preActive }
        : undefined,
      lockOps?.open && lockOps.close && ro.lock
        ? {
            key: 'lock',
            icon: locked ? 'mdi:lock' : 'mdi:lock-open-variant',
            label: locked ? t('car.unlock') : t('car.lock'),
            active: locked === false,
            // unlocking opens the car: slide sheet; locking acts at once
            on: () => (locked ? this.run('lock', lockOps.open!, this.openReq(ro.lock, this.label('lock'), 'unlock')) : this.run('lock', lockOps.close!)),
          }
        : undefined,
      ro.flash ? { key: 'signal', icon: 'mdi:car-light-alert', label: t('car.signal'), active: false, on: () => this.run('signal', this.call(ro.flash.split('.')[0] === 'switch' ? 'switch' : 'button', ro.flash.startsWith('switch.') ? 'turn_on' : 'press', ro.flash)) } : undefined,
      ro.location ? { key: 'map', icon: 'mdi:map-marker-outline', label: t('car.map'), active: false, on: () => this.ctx.push({ entity: ro.location }) } : undefined,
    ].filter((a): a is NonNullable<typeof a> => !!a);
    const fmt = (id?: string) => (id ? formatState(this.hass, this.s(id)) : '–');
    const on = (id?: string) => this.on(id);
    const trip = [
      ro.odometer ? this.tile('mdi:counter', t('car.odometer'), fmt(ro.odometer), false, ro.odometer) : nothing,
      ro.consumption ? this.tile('mdi:lightning-bolt-outline', t('car.consumption'), fmt(ro.consumption), false, ro.consumption) : nothing,
      ro.avg_speed ? this.tile('mdi:speedometer', t('car.avg_speed'), fmt(ro.avg_speed), false, ro.avg_speed) : nothing,
      ro.eco ? this.tile('mdi:leaf', t('car.eco'), fmt(ro.eco), false, ro.eco) : nothing,
    ];
    const winPart = e.parts.find((p) => p.key === 'windows');
    const windowsOpen = winPart ? this.partOpen(winPart) : undefined;
    const trunkPart = e.parts.find((p) => p.key === 'trunk');
    const trunkOpen = trunkPart ? this.partOpen(trunkPart) : undefined;
    const doorsOpen = isOpenState(this.s(ro.doors), this.hass) ?? (CAR_POS.some((p) => isOpenState(this.s(ro[`door_${p}`]), this.hass)) ? true : CAR_POS.some((p) => ro[`door_${p}`]) ? false : undefined);
    const status = [
      locked != null ? this.tile(locked ? 'mdi:lock' : 'mdi:lock-open-variant', t('car.lock_state'), locked ? t('car.locked') : t('car.unlocked'), !locked) : nothing,
      doorsOpen != null ? this.tile('mdi:car-door', t('car.role.doors'), this.openText(doorsOpen), doorsOpen) : nothing,
      windowsOpen != null ? this.tile('mdi:car-door', t('car.windows'), this.openText(windowsOpen), windowsOpen) : nothing,
      trunkOpen != null ? this.tile('mdi:car-back', t('car.deck'), this.openText(trunkOpen), trunkOpen) : nothing,
      ro.alarm ? this.tile('mdi:shield-car', t('car.alarm'), on(ro.alarm) || this.s(ro.alarm)?.state.startsWith('armed') ? t('car.armed') : t('car.disarmed'), false, ro.alarm) : nothing,
      ro.park_brake ? this.tile('mdi:car-brake-parking', t('car.park_brake'), on(ro.park_brake) ? t('car.engaged') : t('car.released'), false, ro.park_brake) : nothing,
    ];
    const extraStatus = this.extras(e, 'status');
    const stateView = this.stateView(e);
    return html`
      <header class="head">
        <div class="head-text">
          <div class="head-title">${title}</div>
          <div class="head-sub">${[where, locked == null ? '' : locked ? t('car.locked') : t('car.unlocked')].filter(Boolean).join(' · ')}</div>
        </div>
        <button class="icon-btn pressable close" aria-label=${t('common.close')} @click=${this.ctx.close}><ha-icon icon="mdi:close"></ha-icon></button>
      </header>
      <div class="hero ${away ? 'away' : ''}">
        ${this._img ? html`<img class="shot" src=${this._img} alt="" />` : this.side(shape, r.color, f.accent ? r.accent : undefined)}
      </div>

      ${soc != null || range != null || ro.charging || ro.plug
        ? html`<div class="card battery">
        <div class="bat-top">
          <div class="soc" style=${`color:${col}`}>${soc == null ? '–' : Math.round(soc)}<span>%</span></div>
          <div class="bat-side">
            ${range != null ? html`<div class="range">${Math.round(range)} km</div>` : nothing}
            <div class="bat-state ${charging ? 'charge' : ''}">
              <ha-icon .icon=${charging ? 'mdi:lightning-bolt' : 'mdi:power-plug-outline'}></ha-icon>
              ${charging
                ? [t('car.charging_cap'), power ? `${formatNumber(power / 1000, 1)} kW` : '', endT ? t('car.full_at', { t: endT }) : ''].filter(Boolean).join(' · ')
                : (plugText(this.s(ro.plug), de) ?? t('car.not_charging'))}
            </div>
          </div>
        </div>
        <div class="bar">
          <div class="fill ${charging ? 'charge' : ''}" style=${`width:${Math.max(0, Math.min(100, soc ?? 0))}%;background:${col}`}></div>
          ${limitNow != null && limitNow < 100 ? html`<div class="limit" style=${`left:${limitNow}%`} title=${t('car.limit', { n: limitNow })}></div>` : nothing}
        </div>
        ${lim
          ? html`<div class="limit-row">
              <span class="limit-t">${t('car.limit_set')}</span>
              <div class="chips">
                ${lim.options.map(
                  (v) => html`<button class="chip pressable" aria-pressed=${limitNow === v ? 'true' : 'false'} data-limit=${v} @click=${() => {
                    this._limit = v;
                    void this.run('limit', () => lim.set(v));
                  }}>${v} %</button>`,
                )}
              </div>
            </div>`
          : limit != null && limit < 100
            ? html`<div class="limit-l">${t('car.limit', { n: Math.round(limit) })}</div>`
            : nothing}
      </div>`
        : nothing}

      ${actions.length
        ? html`<div class="actions">
            ${actions.map(
              (a) => html`<button class="action pressable ${a.active ? 'active' : ''} ${this._busy === a.key ? 'busy' : ''}" data-action=${a.key} @click=${a.on}>
                <span class="circle"><ha-icon .icon=${a.icon}></ha-icon></span><span class="lbl">${a.label}</span>
              </button>`,
            )}
          </div>`
        : nothing}

      ${warnings.length
        ? html`<div class="card warn-card">
            ${warnings.map((id) => html`<div class="warn-row"><ha-icon icon="mdi:alert-circle-outline"></ha-icon>${entityName(this.hass, id, this.s(id))}</div>`)}
          </div>`
        : nothing}

      ${this.accessGroup(e)}
      ${this.climateGroup(e, preActive)}
      ${this.chargeGroup(e)}
      ${status.some((x) => x !== nothing) || stateView !== nothing || trip.some((x) => x !== nothing) || extraStatus.length
        ? html`<section class="grp" data-group="status">
            <div class="label-s grp-t"><ha-icon icon="mdi:car-info"></ha-icon>${t('car.group_status')}</div>
            ${stateView}
            <div class="grid">${status}</div>
            ${trip.some((x) => x !== nothing) ? html`<div class="label-s">${t('car.trip')}</div><div class="grid">${trip}</div>` : nothing}
            ${extraStatus.length ? html`<div class="card rows">${extraStatus}</div>` : nothing}
          </section>`
        : nothing}

      ${e.rest.length
        ? html`<button class="btn plain block pressable more" @click=${() => (this._all = !this._all)}>
              <ha-icon .icon=${this._all ? 'mdi:chevron-up' : 'mdi:chevron-down'}></ha-icon>${t('car.all_values', { n: e.rest.length })}
            </button>
            ${this._all
              ? html`<div class="card all">
                  ${e.rest.map(
                    (id) => html`<button class="row pressable" @click=${() => this.ctx.push({ entity: id })}>
                      <span class="grow">${entityName(this.hass, id, this.s(id)).replace(this.devPrefix(id), '')}</span>
                      <span class="val">${formatState(this.hass, this.s(id))}</span>
                    </button>`,
                  )}
                </div>`
              : nothing}`
        : nothing}
    `;
  }

  static override styles = [
    ...PopupBase.styles,
    css`
      .grp {
        margin-bottom: var(--fp-space-4);
      }
      .grp-t {
        display: flex;
        align-items: center;
        gap: 6px;
        --mdc-icon-size: 16px;
      }
      .grp-t ha-icon {
        color: var(--fp-accent);
      }
      .rows {
        padding: var(--fp-space-1) var(--fp-space-4);
      }
      .prow {
        display: flex;
        align-items: center;
        gap: var(--fp-space-3);
        min-height: 48px;
        padding: var(--fp-space-2) 0;
        border-bottom: 0.5px solid var(--fp-separator, rgba(0, 0, 0, 0.08));
        --mdc-icon-size: 22px;
        color: var(--fp-label-2);
        width: 100%;
        box-sizing: border-box;
      }
      .prow:last-child {
        border-bottom: 0;
      }
      .prow.col {
        flex-direction: column;
        align-items: stretch;
      }
      .prow-top {
        display: flex;
        align-items: center;
        gap: var(--fp-space-3);
      }
      .prow.value {
        border: 0;
        border-bottom: 0.5px solid var(--fp-separator, rgba(0, 0, 0, 0.08));
        background: none;
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
      .prow.is-open > ha-icon,
      .prow.is-open .pv {
        color: #e5483a;
      }
      .prow .grow {
        flex: 1;
        min-width: 0;
      }
      .pl {
        font-size: var(--fp-text-subhead);
        color: var(--fp-label);
      }
      .pv {
        font-size: var(--fp-text-caption);
        color: var(--fp-label-3);
        font-variant-numeric: tabular-nums;
      }
      .pv.num {
        min-width: 56px;
        text-align: center;
        font-size: var(--fp-text-subhead);
        color: var(--fp-label);
      }
      .btn.small {
        padding: 6px 12px;
        font-size: var(--fp-text-footnote);
        min-height: 32px;
      }
      .btn.busy {
        opacity: 0.6;
      }
      .toggle {
        width: 51px;
        height: 31px;
        border-radius: 16px;
        border: 0;
        padding: 2px;
        background: var(--fp-fill-2, rgba(120, 120, 128, 0.24));
        transition: background var(--fp-dur) var(--fp-ease);
        flex: none;
      }
      .toggle span {
        display: block;
        width: 27px;
        height: 27px;
        border-radius: 50%;
        background: #fff;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
        transition: transform var(--fp-dur) var(--fp-ease);
      }
      .toggle.on {
        background: var(--fp-green, #34c759);
      }
      .toggle.on span {
        transform: translateX(20px);
      }
      .stateview {
        margin-bottom: var(--fp-space-3);
      }
      .stateview .topview {
        width: 92px;
      }
      .stateview .tire-grid {
        grid-template-columns: 1fr 104px 1fr;
      }
      .roof {
        fill: var(--fp-label-3);
        opacity: 0.25;
      }
      .lid,
      .sunroof,
      .flap,
      .win,
      .door {
        transition: transform var(--fp-dur) var(--fp-ease), y var(--fp-dur) var(--fp-ease);
      }
      .lid.unk,
      .lid.shut {
        fill: var(--fp-label-3);
        opacity: 0.18;
      }
      .sunroof.unk {
        display: none;
      }
      .sunroof.shut,
      .win.shut,
      .win.unk {
        fill: var(--fp-label-3);
        opacity: 0.45;
      }
      .door.shut,
      .door.unk,
      .flap.shut,
      .flap.unk {
        fill: var(--fp-label-2);
        opacity: 0.55;
      }
      .open {
        fill: #e5483a;
        opacity: 0.9;
      }
      @media (prefers-reduced-motion: reduce) {
        .lid,
        .sunroof,
        .flap,
        .win,
        .door {
          transition: none;
        }
      }
      .hero {
        margin: calc(var(--fp-space-3) * -1) 0 var(--fp-space-3);
        display: flex;
        justify-content: center;
      }
      .hero.away {
        opacity: 0.55;
      }
      .shot {
        width: min(100%, 380px);
        height: auto;
        display: block;
        filter: drop-shadow(0 10px 14px rgba(0, 0, 0, 0.12));
      }
      .limit-row {
        margin-top: var(--fp-space-3);
      }
      .limit-t {
        display: block;
        font-size: var(--fp-text-caption);
        color: var(--fp-label-3);
        margin-bottom: var(--fp-space-2);
      }
      .limit-row .chip {
        min-width: 0;
        padding: 4px 10px;
        font-size: var(--fp-text-footnote);
      }
      .side {
        width: min(100%, 360px);
        height: auto;
        overflow: visible;
      }
      .battery {
        margin-bottom: var(--fp-space-4);
      }
      .bat-top {
        display: flex;
        align-items: flex-end;
        gap: var(--fp-space-4);
        margin-bottom: var(--fp-space-3);
      }
      .soc {
        font-size: 44px;
        line-height: 1;
        font-weight: var(--fp-weight-semibold);
        letter-spacing: -0.02em;
        font-variant-numeric: tabular-nums;
      }
      .soc span {
        font-size: 20px;
        margin-left: 2px;
        opacity: 0.8;
      }
      .bat-side {
        flex: 1;
        min-width: 0;
        padding-bottom: 3px;
      }
      .range {
        font-size: var(--fp-text-title3);
        font-weight: var(--fp-weight-semibold);
        color: var(--fp-label);
      }
      .bat-state {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: var(--fp-text-footnote);
        color: var(--fp-label-2);
        --mdc-icon-size: 16px;
      }
      .bat-state.charge {
        color: #2fbf63;
        font-weight: var(--fp-weight-semibold);
      }
      .bar {
        position: relative;
        height: 12px;
        border-radius: 6px;
        background: var(--fp-fill-2, rgba(120, 120, 128, 0.16));
        overflow: hidden;
      }
      .fill {
        height: 100%;
        border-radius: 6px;
        transition: width var(--fp-dur-slow) var(--fp-ease);
      }
      .fill.charge {
        background-image: linear-gradient(90deg, transparent 0, rgba(255, 255, 255, 0.45) 50%, transparent 100%) !important;
        background-size: 60px 100%;
        background-repeat: no-repeat;
        animation: fp-charge 1.6s linear infinite;
      }
      @keyframes fp-charge {
        from {
          background-position: -60px 0;
        }
        to {
          background-position: 400px 0;
        }
      }
      .limit {
        position: absolute;
        top: -2px;
        bottom: -2px;
        width: 2px;
        background: var(--fp-label);
        opacity: 0.6;
      }
      .limit-l {
        margin-top: 4px;
        font-size: var(--fp-text-caption);
        color: var(--fp-label-3);
      }
      .actions {
        display: flex;
        justify-content: center;
        gap: var(--fp-space-4);
        margin: var(--fp-space-2) 0 var(--fp-space-5);
        flex-wrap: wrap;
      }
      .action {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--fp-space-2);
        min-width: 72px;
      }
      .action .circle {
        width: 56px;
        height: 56px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--fp-surface);
        box-shadow: var(--fp-shadow-1);
        --mdc-icon-size: 26px;
        color: var(--fp-label);
        transition: background var(--fp-dur) var(--fp-ease), color var(--fp-dur) var(--fp-ease);
      }
      .action.active .circle {
        background: var(--fp-accent);
        color: #fff;
      }
      .action[data-action='pre'].active .circle ha-icon {
        animation: fp-spin 2.4s linear infinite;
      }
      .action.busy .circle {
        opacity: 0.6;
      }
      @keyframes fp-spin {
        to {
          transform: rotate(360deg);
        }
      }
      .action .lbl {
        font-size: var(--fp-text-caption);
        color: var(--fp-label-2);
        text-align: center;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
        gap: var(--fp-space-2);
        margin-bottom: var(--fp-space-4);
      }
      .st {
        display: flex;
        align-items: center;
        gap: var(--fp-space-3);
        padding: var(--fp-space-3);
        border-radius: var(--fp-radius-m);
        background: var(--fp-surface);
        --mdc-icon-size: 22px;
        color: var(--fp-label-2);
      }
      .st.bad {
        color: #e5483a;
      }
      .st-l {
        font-size: var(--fp-text-caption);
        color: var(--fp-label-3);
      }
      .st-v {
        font-size: var(--fp-text-subhead);
        font-weight: var(--fp-weight-semibold);
        color: var(--fp-label);
        font-variant-numeric: tabular-nums;
      }
      .st.bad .st-v {
        color: #e5483a;
      }
      .tires {
        margin-bottom: var(--fp-space-4);
      }
      .tires .bad,
      .warn-row {
        color: #e5483a;
      }
      .tire-grid {
        display: grid;
        grid-template-columns: 1fr 70px 1fr;
        grid-template-rows: 1fr 1fr;
        align-items: center;
        gap: 0 var(--fp-space-3);
      }
      .topview {
        grid-row: 1 / span 2;
        grid-column: 2;
        width: 60px;
        justify-self: center;
      }
      .tv {
        font-size: var(--fp-text-subhead);
        font-weight: var(--fp-weight-semibold);
        font-variant-numeric: tabular-nums;
      }
      .tv.fl,
      .tv.rl {
        text-align: right;
      }
      .tv.fl {
        grid-column: 1;
        grid-row: 1;
      }
      .tv.fr {
        grid-column: 3;
        grid-row: 1;
      }
      .tv.rl {
        grid-column: 1;
        grid-row: 2;
      }
      .tv.rr {
        grid-column: 3;
        grid-row: 2;
      }
      .tv-body {
        fill: var(--fp-fill-2, rgba(120, 120, 128, 0.2));
      }
      .tv-glass {
        fill: var(--fp-label-3);
        opacity: 0.35;
      }
      .tv-tyre {
        fill: var(--fp-label);
      }
      .warn-card {
        margin-bottom: var(--fp-space-4);
      }
      .warn-row {
        display: flex;
        align-items: center;
        gap: var(--fp-space-2);
        font-weight: var(--fp-weight-semibold);
        --mdc-icon-size: 20px;
      }
      .more {
        margin-top: var(--fp-space-2);
        color: var(--fp-label-2);
      }
      .all {
        margin-top: var(--fp-space-2);
        padding: var(--fp-space-2) var(--fp-space-3);
      }
      .all .row {
        display: flex;
        width: 100%;
        gap: var(--fp-space-3);
        padding: var(--fp-space-2) 0;
        border: 0;
        background: none;
        font: inherit;
        color: var(--fp-label);
        text-align: left;
        border-bottom: 0.5px solid var(--fp-separator, rgba(0, 0, 0, 0.08));
      }
      .all .row:last-child {
        border-bottom: 0;
      }
      .all .val {
        color: var(--fp-label-2);
        font-variant-numeric: tabular-nums;
      }
    `,
  ];
}

if (!customElements.get('fp-car-popup')) customElements.define('fp-car-popup', FpCarPopup);
