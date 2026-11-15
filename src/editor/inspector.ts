import { html, nothing, svg, type TemplateResult } from 'lit';
import type { ActionConfig, DeviceConfig, EntryAlertConfig, EntryAlertMode, FurnitureConfig, FurnitureContentConfig, OpeningConfig, RoomConfig } from '../types';
import { ENTRY_DEFAULTS, defaultTexts, ttsLanguages, windowsOf } from '../entry-alert';
import type { FloorplanEditorUI } from './editor-ui';
import type { EntityFilter } from './entity-list';
import { entityName, formatState, navigate, stateIcon, suggestForArea } from '../ha';
import { formatNumber, getLanguage, t } from '../i18n';
import { FURNITURE_BY_KIND, FURNITURE_PALETTES, drawFurniture, furnitureLabel, resolveFurniture, variantLabel, type FurnitureKind } from '../furniture';
import { FLOOR_TYPES, FLOOR_TYPE, PALETTES, WALL_PAINTS, colorName, floorPattern, floorTypeLabel } from '../floors';
import type { FloorMaterial, FloorType, LabelSpot, Point, WalkReminder } from '../types';
import { pointInPolygon, round } from '../geometry';
import { areasOnFloor, floorLevel, floorShort, orderedFloors, stairsTarget } from '../levels';
import type { FloorConfig } from '../types';
import { normalizeTime, petLook } from '../pets';
import { dogPicture } from '../gl/dog-studio';
import { until } from 'lit/directives/until.js';
import { defaultAction, furnitureAction, type Gesture } from '../actions';
import { CAR_GROUPS, CAR_ROLE, CAR_ROLE_KEYS, LEGACY_MAIN, carInfo, type CarGroup } from '../car-info';
import type { I18nKey } from '../i18n';
import type { ManualEntityConfig, MediaCommand, MediaControlsConfig } from '../types';
import { MEDIA_SLOTS, commandSet, type MediaSlot } from '../media-controls';
import { DEFAULT_INTERVAL, browserId, defaultBrowserName } from '../song';
import type { SongRecognizeConfig } from '../types';

type Ed = FloorplanEditorUI;
import { companionInfo, serverKey, vacuumReset } from '../entry-server';
import { houseRules, hrRoomDevices } from '../house-rules';
import { defaultText, defaultTitle, phoneOf, sendTest } from '../walk-notify';
import { shareSection } from './plan-share';
import { hasWifiContent, isWifiContent, isWifiPiece } from '../furniture';
import type { WifiNetwork, WifiSecurity } from '../wifi-qr';

/** Domains whose state is only a timestamp (last press, last use): not worth showing next to the name */
const STATELESS = new Set(['button', 'input_button', 'event', 'tts', 'scene', 'script', 'notify', 'stt', 'conversation']);

function entityRow(ed: Ed, label: string, value: string | undefined, filter: EntityFilter, set: (v: string | undefined) => void) {
  const s = value ? ed.hass.states[value] : undefined;
  const showState = !!value && !STATELESS.has(value.split('.')[0]);
  return html`<div class="row">
    <button
      class="grow pick"
      @click=${() => ed.openPicker({ title: label, filter, selected: value ? [value] : [], onPick: (ids) => set(ids[0]) })}
    >
      <div class="subtitle">${label}</div>
      <div class="title ${value ? '' : 'placeholder'}">${value ? entityName(ed.hass, value, s) : t('editor.choose_entity')}</div>
    </button>
    ${showState ? html`<span class="trailing num state">${formatState(ed.hass, s)}</span>` : nothing}
    ${value
      ? html`<button class="icon-btn plain pressable" aria-label=${t('common.delete')} @click=${() => set(undefined)}>
          <ha-icon icon="mdi:close-circle" style="color:var(--fp-label-3)"></ha-icon>
        </button>`
      : html`<ha-icon icon="mdi:chevron-right" style="color:var(--fp-label-3)"></ha-icon>`}
  </div>`;
}

function stepper(label: string, value: number, step: number, set: (v: number) => void, unit = '') {
  return html`<div class="row">
    <div class="grow"><div class="title">${label}</div></div>
    <button class="icon-btn pressable" aria-label="−" @click=${() => set(value - step)}><ha-icon icon="mdi:minus"></ha-icon></button>
    <span class="num step-val">${round(value, 1)}${unit}</span>
    <button class="icon-btn pressable" aria-label="+" @click=${() => set(value + step)}><ha-icon icon="mdi:plus"></ha-icon></button>
  </div>`;
}

function actions(
  ed: Ed,
  item: { entity?: string; tap_action?: ActionConfig; double_tap_action?: ActionConfig; hold_action?: ActionConfig },
  kind: 'room' | 'device' | 'opening' | 'furniture',
  patch: (k: string, v: ActionConfig | undefined) => void,
) {
  const n = (['tap', 'double_tap', 'hold'] as const).filter((g) => item[`${g}_action`]).length;
  // what "Standard" does for this gesture, shown in the picker
  const fallback = (g: Gesture) =>
    (kind === 'furniture' ? furnitureAction({ entity: item.entity ?? '' }, g) : defaultAction(kind, g)).action;
  return fold(t('editor.fold_actions'), html`<div class="group">
      ${(['tap', 'double_tap', 'hold'] as const).map(
        (g) => html`<fp-action-editor
          .hass=${ed.hass}
          .kind=${kind === 'furniture' ? 'device' : kind}
          .fallback=${fallback(g)}
          .label=${t(g === 'tap' ? 'editor.tap' : g === 'double_tap' ? 'editor.double_tap' : 'editor.hold')}
          .value=${item[`${g}_action`]}
          @value-change=${(e: CustomEvent) => patch(`${g}_action`, e.detail.value)}
        ></fp-action-editor>`,
      )}
    </div>`, { icon: 'mdi:gesture-tap', sub: n ? t('editor.n_set', { n }) : undefined });
}

/** Hausregeln: the rules of a device — counts, a tap opens everything about it (rules, quick starts, why) */
function hrRow(ed: Ed, entity: string | undefined) {
  if (!ed._hrOn || !entity) return nothing;
  const c = ed.hrCounts.get(entity);
  const n = c ? c.starts.length + c.checks.length + c.switches.length : 0;
  return html`<div class="group" style="margin-top:var(--fp-space-3)">
    <button class="row pressable" data-hr-rules @click=${() => ed.layer.openHouseRules({ kind: 'device', entity })}>
      <ha-icon icon="mdi:script-text-outline" style="color:var(--fp-accent)"></ha-icon>
      <div class="grow">
        <div class="title accent">${t('hr.rules')}</div>
        <div class="subtitle">${n ? t('hr.rules_sub', { s: c!.starts.length, c: c!.checks.length, w: c!.switches.length }) : t('hr.rules_none')}</div>
      </div>
      <ha-icon icon="mdi:chevron-right" style="color:var(--fp-label-3)"></ha-icon>
    </button>
  </div>`;
}

/** Collapsible group for settings that are rarely needed */
function fold(title: string, body: unknown, opts: { icon?: string; sub?: string } = {}) {
  return html`<details class="fold">
    <summary>
      ${opts.icon ? html`<ha-icon .icon=${opts.icon} style="color:var(--fp-accent)"></ha-icon>` : nothing}
      <span class="grow">${title}</span>
      ${opts.sub ? html`<span class="sub">${opts.sub}</span>` : nothing}
      <ha-icon class="chev" icon="mdi:chevron-right"></ha-icon>
    </summary>
    <div class="fold-body">${body}</div>
  </details>`;
}

function textField(label: string, value: string | undefined, set: (v: string) => void, placeholder = '') {
  return html`<label class="row field-row">
    <span class="subtitle">${label}</span>
    <input class="field inline" .value=${value ?? ''} placeholder=${placeholder} @change=${(e: any) => set(e.target.value)} />
  </label>`;
}

function patchItem<T>(ed: Ed, kind: 'rooms' | 'devices' | 'openings' | 'furniture', id: string, fn: (x: T) => void) {
  ed.mutate((_d, f) => {
    const list = (f as any)[kind] as any[];
    const it = list?.find((x) => x.id === id);
    if (it) fn(it);
  });
}

/** Label style "wall": where the engraved value goes — per view direction a wall of the room, the floor,
 * hidden, or automatic */
function labelSpotSection(ed: Ed, r: RoomConfig, set: (fn: (x: RoomConfig) => void) => void) {
  const pts = r.points;
  const views: [string, string][] = [
    ['0', t('editor.view_from_bottom')],
    ['90', t('editor.view_from_right')],
    ['180', t('editor.view_from_top')],
    ['270', t('editor.view_from_left')],
  ];
  const home = ed._draft.users?.[ed.hass.user?.id ?? '']?.orientation ?? ed._draft.orientation ?? 0;
  const homeKey = String((((Math.round(home / 90) * 90) % 360) + 360) % 360);
  const sideName = (n: Point) =>
    Math.abs(n[1]) > Math.abs(n[0]) ? (n[1] > 0 ? t('editor.wall_top') : t('editor.wall_bottom')) : n[0] > 0 ? t('editor.wall_left') : t('editor.wall_right');
  const setSpot = (key: string, v: LabelSpot | undefined) =>
    set((x) => {
      const m = { ...(x.label_spots ?? {}) };
      if (v === undefined) delete m[key];
      else m[key] = v;
      x.label_spots = Object.keys(m).length ? m : undefined;
    });
  return html`
    <div class="section-title">${t('editor.label_spot')}</div>
    <div class="group">
      ${views.map(([key, label]) => {
        const sp = (Number(key) * Math.PI) / 180;
        // walls whose inner face looks at the viewer from this side
        const walls: { i: number; name: string }[] = [];
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i];
          const b = pts[(i + 1) % pts.length];
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (len < 40) continue;
          let n: Point = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
          const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          if (!pointInPolygon([mid[0] + n[0] * 8, mid[1] + n[1] * 8], pts)) n = [-n[0], -n[1]];
          if (n[0] * Math.sin(sp) + n[1] * Math.cos(sp) < 0.2) continue;
          walls.push({ i, name: `${sideName(n)} · ${formatNumber(len / 100, 1)} m` });
        }
        const cur = r.label_spots?.[key];
        const val = cur === undefined ? 'auto' : typeof cur === 'string' ? cur : `w${cur.wall}`;
        return html`<label class="row field-row">
            <span class="subtitle">${label}${key === homeKey ? html` <span style="color:var(--fp-accent)">· ${t('editor.label_spot_home')}</span>` : nothing}</span>
            <select
              class="field inline"
              @change=${(e: Event) => {
                const v = (e.target as HTMLSelectElement).value;
                setSpot(key, v === 'auto' ? undefined : v === 'floor' || v === 'hide' ? v : { wall: Number(v.slice(1)), t: 0.5 });
              }}
            >
              <option value="auto" ?selected=${val === 'auto'}>${t('editor.label_spot_auto')}</option>
              ${walls.map((w) => html`<option value=${`w${w.i}`} ?selected=${val === `w${w.i}`}>${w.name}</option>`)}
              <option value="floor" ?selected=${val === 'floor'}>${t('editor.label_spot_floor')}</option>
              <option value="hide" ?selected=${val === 'hide'}>${t('editor.label_spot_hide')}</option>
            </select>
          </label>
          ${cur && typeof cur === 'object'
            ? html`<label class="row field-row">
                <span class="subtitle">${t('editor.label_spot_pos')}</span>
                <input
                  class="grow"
                  type="range"
                  min="0"
                  max="100"
                  .value=${String(Math.round((cur.t ?? 0.5) * 100))}
                  @change=${(e: Event) => setSpot(key, { wall: cur.wall, t: Number((e.target as HTMLInputElement).value) / 100 })}
                />
              </label>`
            : nothing}`;
      })}
    </div>
    <div class="hint-s">${t('editor.label_spot_hint')}</div>
  `;
}

function roomInspector(ed: Ed, r: RoomConfig): TemplateResult {
  const set = (fn: (x: RoomConfig) => void) => patchItem<RoomConfig>(ed, 'rooms', r.id, fn);
  const areas = Object.values(ed.hass.areas ?? {}).sort((a, b) => a.name.localeCompare(b.name));
  const applySuggestions = (areaId: string, onlyEmpty: boolean) => {
    const s = suggestForArea(ed.hass, areaId, r.exclude);
    set((x) => {
      if (!onlyEmpty || !x.lights?.length) x.lights = s.lights;
      if (!onlyEmpty || !x.temperature) x.temperature = s.temperature;
      if (!onlyEmpty || !x.humidity) x.humidity = s.humidity;
      if (!onlyEmpty || !x.climate) x.climate = s.climate;
      if (!onlyEmpty || !x.sensors?.length) x.sensors = s.sensors.map((entity) => ({ entity }));
    });
  };
  const lights = r.lights ?? [];
  // with Hausregeln its room assignment is the one source for lights and thermostat (changed there, shown here)
  const hr = hrRoomDevices(r, ed.hass);
  const devRow = (id: string) => {
    const s = ed.hass.states[id];
    return html`<div class="row">
      <span class="ic">${stateIcon(ed.hass, s) ? html`<ha-icon .icon=${stateIcon(ed.hass, s)}></ha-icon>` : html`<ha-state-icon .hass=${ed.hass} .stateObj=${s}></ha-state-icon>`}</span>
      <div class="grow"><div class="title">${entityName(ed.hass, id, s)}</div></div>
    </div>`;
  };
  // what the area suggests: removing one of these remembers it, so "suggest" does not bring it back
  const sug = r.area ? suggestForArea(ed.hass, r.area) : undefined;
  const suggested = new Set(sug ? [...sug.lights, ...sug.sensors, sug.temperature, sug.humidity, sug.climate].filter((x): x is string => !!x) : []);
  const excludeIn = (x: RoomConfig, id: string) => {
    x.exclude = [...new Set([...(x.exclude ?? []), id])];
  };
  const clearRole = (x: RoomConfig, id: string) => {
    x.lights = x.lights?.filter((l) => l !== id);
    if (x.temperature === id) x.temperature = undefined;
    if (x.humidity === id) x.humidity = undefined;
    if (x.climate === id) x.climate = undefined;
    x.sensors = x.sensors?.filter((v) => v.entity !== id);
  };
  const ROOM_ROLES = [
    { value: 'value', label: t('editor.room_role_value') },
    { value: 'temperature', label: t('editor.temperature') },
    { value: 'humidity', label: t('editor.humidity') },
  ];
  /** Manual value / re-categorise: own name and icon, or move it to temperature / humidity */
  const editValue = (v: { entity: string; name?: string; icon?: string }, role: string, isNew = false) =>
    ed.openEntityEdit({
      title: isNew ? t('editor.add_value') : t('editor.ent_edit'),
      value: { ...v, role },
      roles: ROOM_ROLES,
      filter: { domains: ['sensor', 'binary_sensor', 'climate', 'switch', 'input_boolean', 'input_number', 'number', 'cover', 'lock', 'fan'] },
      removeLabel: suggested.has(v.entity) ? t('editor.exclude') : t('common.delete'),
      onRemove: isNew
        ? undefined
        : () =>
            set((x) => {
              clearRole(x, v.entity);
              if (suggested.has(v.entity)) excludeIn(x, v.entity);
            }),
      onSave: (m) =>
        set((x) => {
          clearRole(x, v.entity);
          clearRole(x, m.entity);
          if (m.role === 'temperature') x.temperature = m.entity;
          else if (m.role === 'humidity') x.humidity = m.entity;
          else x.sensors = [...(x.sensors ?? []), { entity: m.entity, ...(m.name ? { name: m.name } : {}), ...(m.icon ? { icon: m.icon } : {}) }];
          if (x.exclude) x.exclude = x.exclude.filter((e) => e !== m.entity);
          if (!x.exclude?.length) delete x.exclude;
        }),
    });
  // the floor is linked to a HA floor: its areas come first, the unused ones as one-tap suggestions
  const here = areasOnFloor(ed.hass, ed.floor.floor);
  const hereIds = new Set(here.map((a) => a.area_id));
  const used = new Set(ed._draft.floors.flatMap((f) => f.rooms.map((x) => x.area)).filter(Boolean));
  const pickArea = (areaId: string) => {
    set((x) => {
      x.area = areaId;
      if (!x.name || x.name.startsWith(t('editor.room'))) x.name = ed.hass.areas[areaId]?.name;
    });
    applySuggestions(areaId, true);
  };
  const free = !r.area ? here.filter((a) => !used.has(a.area_id)) : [];
  const opt = (a: { area_id: string; name: string }) => html`<option value=${a.area_id} ?selected=${a.area_id === r.area}>${a.name}</option>`;
  return html`
    ${free.length
      ? html`<div class="section-title">${t('editor.areas_suggest')}</div>
          <div class="chips area-chips">
            ${free.map((a) => html`<button class="chip pressable" data-area-suggest=${a.area_id} @click=${() => pickArea(a.area_id)}><ha-icon .icon=${a.icon || 'mdi:texture-box'}></ha-icon>${a.name}</button>`)}
          </div>`
      : nothing}
    <div class="group">
      ${textField(t('editor.name'), r.name, (v) => set((x) => (x.name = v || undefined)))}
      <label class="row field-row">
        <span class="subtitle">${t('editor.area')}</span>
        <select
          class="field inline"
          .value=${r.area ?? ''}
          @change=${(e: any) => {
            const areaId = e.target.value || undefined;
            set((x) => {
              x.area = areaId;
              if (areaId && (!x.name || x.name.startsWith(t('editor.room')))) x.name = ed.hass.areas[areaId]?.name;
            });
            if (areaId) applySuggestions(areaId, true);
          }}
        >
          <option value="">${t('editor.no_area')}</option>
          ${here.length
            ? html`<optgroup label=${t('editor.areas_here')}>${here.map(opt)}</optgroup>
                <optgroup label=${t('editor.areas_other')}>${areas.filter((a) => !hereIds.has(a.area_id)).map(opt)}</optgroup>`
            : areas.map(opt)}
        </select>
      </label>
    </div>
    ${r.area
      ? html`<button class="btn tinted block pressable suggest" @click=${() => applySuggestions(r.area!, false)}>
          <ha-icon icon="mdi:auto-fix"></ha-icon>${t('editor.suggest')}
        </button>`
      : nothing}

    ${hr
      ? html`<div class="section-title">${t('editor.from_hr')}</div>
          <div class="group" data-hr-room>
            ${hr.lights.map(devRow)} ${hr.climates.slice(0, 1).map(devRow)} ${hr.sensor ? devRow(hr.sensor) : nothing}
          </div>
          <div class="hint-s">${t('editor.from_hr_hint')}</div>
          <button class="btn tinted block pressable" ?disabled=${ed.dirty} @click=${() => { ed.close(); navigate('/hausregeln/devices'); }}>${t('editor.from_hr_open')}</button>
          ${ed.dirty ? html`<div class="hint-s">${t('editor.ea_hr_save_first')}</div>` : nothing}`
      : nothing}
    ${hr?.lights.length
      ? nothing
      : html`<div class="section-title">${t('editor.lights')}</div>
    <div class="group">
      ${lights.map((id) => {
        const s = ed.hass.states[id];
        return html`<div class="row">
          <span class="ic">${stateIcon(ed.hass, s) ? html`<ha-icon .icon=${stateIcon(ed.hass, s)}></ha-icon>` : html`<ha-state-icon .hass=${ed.hass} .stateObj=${s}></ha-state-icon>`}</span>
          <div class="grow"><div class="title">${entityName(ed.hass, id, s)}</div></div>
          <button class="icon-btn plain pressable" aria-label=${t('common.delete')} @click=${() => set((x) => {
            x.lights = (x.lights ?? []).filter((l) => l !== id);
            if (suggested.has(id)) excludeIn(x, id);
          })}>
            <ha-icon icon="mdi:close-circle" style="color:var(--fp-label-3)"></ha-icon>
          </button>
        </div>`;
      })}
      <button
        class="row add"
        @click=${() =>
          ed.openPicker({
            title: t('editor.lights'),
            filter: { domains: ['light'] },
            multi: true,
            selected: lights,
            onPick: (ids) => set((x) => (x.lights = ids)),
          })}
      >
        <ha-icon icon="mdi:plus-circle" style="color:var(--fp-accent)"></ha-icon><span class="title accent">${t('editor.add_light')}</span>
      </button>
    </div>`}

    <div class="section-title">${t('editor.room_values')}</div>
    <div class="group">
      ${(['temperature', 'humidity', 'climate'] as const)
        // with Hausregeln its heating plan's thermometer and thermostat are shown above instead
        .filter((k) => !(k === 'temperature' && hr?.sensor) && !(k === 'climate' && hr?.climates.length))
        .map((k) =>
        entityRow(ed, t(`editor.${k}`), r[k], k === 'climate' ? { domains: ['climate'] } : { domains: ['sensor'], deviceClasses: [k] }, (v) =>
          set((x) => {
            // removing what the area suggested: keep it out of later suggestions
            if (!v && x[k] && suggested.has(x[k]!)) excludeIn(x, x[k]!);
            x[k] = v;
          }),
        ),
      )}
      ${(r.sensors ?? []).map((v) => {
        const s = ed.hass.states[v.entity];
        const icon = v.icon ?? stateIcon(ed.hass, s);
        return html`<div class="row" data-room-value=${v.entity}>
          <span class="ic">${icon ? html`<ha-icon .icon=${icon}></ha-icon>` : html`<ha-state-icon .hass=${ed.hass} .stateObj=${s}></ha-state-icon>`}</span>
          <button class="grow pick" @click=${() => editValue(v, 'value')}>
            <div class="subtitle">${t('editor.value_n')}</div>
            <div class="title">${v.name ?? entityName(ed.hass, v.entity, s)}</div>
          </button>
          <span class="trailing num state">${formatState(ed.hass, s)}</span>
          <button class="icon-btn plain pressable" aria-label=${t('editor.ent_edit')} title=${t('editor.ent_edit')} @click=${() => editValue(v, 'value')}>
            <ha-icon icon="mdi:pencil-outline" style="color:var(--fp-label-3)"></ha-icon>
          </button>
        </div>`;
      })}
      <button class="row add" data-add-value @click=${() => editValue({ entity: '' }, 'value', true)}>
        <ha-icon icon="mdi:plus-circle" style="color:var(--fp-accent)"></ha-icon><span class="title accent">${t('editor.add_value')}</span>
      </button>
    </div>
    ${r.exclude?.length
      ? fold(
          t('editor.excluded'),
          html`<div class="group">
            ${r.exclude.map(
              (id) => html`<div class="row" data-excluded=${id}>
                <div class="grow"><div class="title">${entityName(ed.hass, id, ed.hass.states[id])}</div></div>
                <button class="btn tinted small pressable" @click=${() => set((x) => {
                  x.exclude = (x.exclude ?? []).filter((e) => e !== id);
                  if (!x.exclude.length) delete x.exclude;
                })}>${t('editor.include_again')}</button>
              </div>`,
            )}
          </div>
          <div class="hint-s">${t('editor.excluded_hint')}</div>`,
          { icon: 'mdi:eye-off-outline', sub: String(r.exclude.length) },
        )
      : nothing}
    ${fold(t('editor.fold_label'), html`<div class="group">
      ${switchRow(t('editor.label_hide'), !!r.hide_label, () => set((x) => (x.hide_label = !x.hide_label || undefined)))}
      ${r.hide_label
        ? nothing
        : html`<div class="row">
            <ha-icon icon=${r.label ? 'mdi:pin' : 'mdi:auto-fix'} style="color:var(--fp-label-2)"></ha-icon>
            <div class="grow">
              <div class="title">${r.label ? t('editor.label_pinned') : t('editor.label_auto')}</div>
              <div class="subtitle wrap">${t('editor.label_hint')}</div>
            </div>
            ${r.label
              ? html`<button class="btn tinted small pressable" @click=${() => set((x) => (x.label = undefined))}>${t('editor.label_reset')}</button>`
              : nothing}
          </div>`}
    </div>
    ${ed._draft.label_style === 'wall' && !r.hide_label ? labelSpotSection(ed, r, set) : nothing}`, { icon: 'mdi:label-outline', sub: r.hide_label ? t('editor.hidden') : r.label ? t('editor.label_pinned') : undefined })}
    ${fold(t('editor.fold_view'), html`<div class="side-picker">
      ${[
        { a: 180, cls: 'top', icon: 'mdi:arrow-down-bold', label: t('editor.view_from_top') },
        { a: 270, cls: 'left', icon: 'mdi:arrow-right-bold', label: t('editor.view_from_left') },
        { a: null, cls: 'center', icon: 'mdi:autorenew', label: t('editor.view_auto') },
        { a: 90, cls: 'right', icon: 'mdi:arrow-left-bold', label: t('editor.view_from_right') },
        { a: 0, cls: 'bottom', icon: 'mdi:arrow-up-bold', label: t('editor.view_from_bottom') },
      ].map(
        (o) => html`<button
          class="side ${o.cls} pressable ${(r.view_angle ?? null) === o.a ? 'sel' : ''}"
          title=${o.label}
          aria-label=${o.label}
          @click=${() => set((x) => (x.view_angle = o.a ?? undefined))}
        >
          <ha-icon .icon=${o.icon}></ha-icon>
        </button>`,
      )}
      <div class="side-room" aria-hidden="true"></div>
    </div>
    <div class="hint-s">${t('editor.view_side_hint')}</div>`, { icon: 'mdi:rotate-3d-variant' })}
    ${fold(
      t('editor.fold_surfaces'),
      html`<fp-segmented
      class="room-kind"
      .options=${[
        { value: 'room', label: t('editor.kind_room'), icon: 'mdi:sofa-outline' },
        { value: 'garage', label: t('editor.kind_garage'), icon: 'mdi:garage' },
        { value: 'outdoor', label: t('editor.kind_outdoor'), icon: 'mdi:flower-outline' },
        { value: 'plot', label: t('editor.kind_plot'), icon: 'mdi:vector-square' },
      ]}
      .value=${r.kind ?? (r.outdoor ? 'outdoor' : 'room')}
      @value-change=${(e: CustomEvent) =>
        set((x) => {
          const v = e.detail.value as 'room' | 'garage' | 'outdoor' | 'plot';
          const wasOutdoor = !!x.outdoor;
          x.outdoor = v === 'outdoor' || v === 'plot' ? true : undefined;
          x.kind = v === 'garage' || v === 'plot' ? v : undefined;
          // a sensible ground for the new kind, unless one was chosen by hand for this kind already
          if (v === 'garage' && (!x.floor || wasOutdoor)) x.floor = { type: 'concrete' };
          if (v === 'outdoor' && (!x.floor || !wasOutdoor)) x.floor = { type: 'grass' };
          if (v === 'plot') x.floor = undefined;
          if (v === 'room' && wasOutdoor) x.floor = undefined;
          if (v === 'plot') x.hide_label = true;
        })}
    ></fp-segmented>
    <div class="hint-s">${t(r.kind === 'garage' ? 'editor.kind_garage_sub' : r.kind === 'plot' ? 'editor.kind_plot_sub' : r.outdoor ? 'editor.outdoor_sub' : 'editor.kind_room_sub')}</div>
    ${floorSection(ed, r, set)} ${wallColorSection(ed, r, set)} ${wallsSection(ed, r)}
        <div class="hint-s">${t('editor.points_hint')}</div>`,
      { icon: 'mdi:texture-box' },
    )}
    ${actions(ed, r, 'room', (k, v) => set((x) => ((x as any)[k] = v)))}
    ${ed._vertex != null
      ? html`<button class="btn block pressable gap" ?disabled=${r.points.length <= 3} @click=${() => ed.deleteVertex()}>
          <ha-icon icon="mdi:vector-point-minus"></ha-icon>${t('editor.delete_point')}
        </button>`
      : nothing}
    <button class="btn danger block pressable gap" @click=${ed.deleteSelection}><ha-icon icon="mdi:trash-can-outline"></ha-icon>${t('editor.delete_room')}</button>
  `;
}

/** Real length formatting (plan units = cm). */
export function formatLength(cm: number): string {
  if (cm < 100) return `${Math.round(cm)} cm`;
  return `${(cm / 100).toLocaleString(document.documentElement.lang || 'de', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} m`;
}

function floorSection(ed: Ed, r: RoomConfig, set: (fn: (x: RoomConfig) => void) => void) {
  const cur: FloorMaterial = r.floor ?? { type: 'none' };
  const info = FLOOR_TYPE.get(cur.type);
  const setFloor = (patch: Partial<FloorMaterial>) =>
    set((x) => {
      const next = { ...(x.floor ?? { type: 'none' }), ...patch } as FloorMaterial;
      x.floor = next.type === 'none' ? undefined : next;
    });
  const preview = (type: FloorType, color?: string) => {
    const id = `fp-pv-${type}`;
    const pat = floorPattern(id, { type, color: color ?? FLOOR_TYPE.get(type)?.color });
    return html`<svg viewBox="0 0 120 120" class="pv" aria-hidden="true">
      ${pat ? svg`<defs>${pat}</defs><rect width="120" height="120" fill=${`url(#${id})`}></rect>` : svg`<rect width="120" height="120" class="pv-none"></rect>`}
    </svg>`;
  };
  const palette = info ? PALETTES[info.palette] : [];
  const color = cur.color ?? info?.color;
  return html`<div class="section-title">${t('editor.floor_material')}</div>
    <div class="materials">
      <button class="mat pressable ${cur.type === 'none' ? 'sel' : ''}" @click=${() => setFloor({ type: 'none' })}>
        ${preview('none')}<span>${t('common.none')}</span>
      </button>
      ${[...FLOOR_TYPES].sort((a, b) => Number(!!b.outdoor === !!r.outdoor) - Number(!!a.outdoor === !!r.outdoor)).map(
        (f) => html`<button
          class="mat pressable ${cur.type === f.type ? 'sel' : ''}"
          data-floor=${f.type}
          @click=${() => setFloor({ type: f.type, color: cur.type !== 'none' && FLOOR_TYPE.get(cur.type)?.palette === f.palette ? cur.color : undefined, size: undefined })}
        >
          ${preview(f.type, cur.type !== 'none' && FLOOR_TYPE.get(cur.type)?.palette === f.palette ? cur.color : undefined)}<span>${floorTypeLabel(f)}</span>
        </button>`,
      )}
    </div>
    ${info
      ? html`<div class="swatches">
            ${palette.map(
              (p) => html`<button
                class="swatch pressable ${color?.toLowerCase() === p.color ? 'sel' : ''}"
                style=${`background:${p.color}`}
                title=${colorName(p)}
                aria-label=${colorName(p)}
                @click=${() => setFloor({ color: p.color })}
              ></button>`,
            )}
            <label class="swatch custom" title=${t('editor.custom_color')}>
              <input type="color" .value=${color ?? '#cccccc'} @change=${(e: any) => setFloor({ color: e.target.value })} />
              <ha-icon icon="mdi:eyedropper-variant"></ha-icon>
            </label>
          </div>
          <div class="group">
            ${info.size ? stepper(t('editor.tile_size'), cur.size ?? info.size, 5, (v) => setFloor({ size: Math.max(10, Math.min(cur.type === 'concrete' ? 600 : 150, v)) }), ' cm') : nothing}
            ${cur.type !== 'color' && cur.type !== 'carpet'
              ? stepper(t('editor.rotation'), cur.angle ?? 0, 15, (v) => setFloor({ angle: (((v % 180) + 180) % 180) || undefined }), '°')
              : nothing}
          </div>
          <button
            class="btn block pressable"
            @click=${() =>
              ed.mutate((_d, f) => {
                for (const room of f.rooms) room.floor = { ...cur };
              })}
          >
            <ha-icon icon="mdi:content-duplicate"></ha-icon>${t('editor.floor_all')}
          </button>`
      : nothing}`;
}

/** Paint swatches + custom color + reset. */
function paintPicker(value: string | undefined, set: (c: string | undefined) => void) {
  return html`<div class="swatches">
    <button class="swatch none pressable ${!value ? 'sel' : ''}" title=${t('editor.paint_default')} aria-label=${t('editor.paint_default')} @click=${() => set(undefined)}>
      <ha-icon icon="mdi:format-color-marker-cancel"></ha-icon>
    </button>
    ${WALL_PAINTS.map(
      (p) => html`<button
        class="swatch pressable ${value?.toLowerCase() === p.color ? 'sel' : ''}"
        style=${`background:${p.color}`}
        title=${colorName(p)}
        aria-label=${colorName(p)}
        data-paint=${p.color}
        @click=${() => set(p.color)}
      ></button>`,
    )}
    <label class="swatch custom" title=${t('editor.custom_color')}>
      <input type="color" .value=${value ?? '#dcdcd8'} @change=${(e: any) => set(e.target.value)} />
      <ha-icon icon="mdi:eyedropper-variant"></ha-icon>
    </label>
  </div>`;
}

function wallColorSection(ed: Ed, r: RoomConfig, set: (fn: (x: RoomConfig) => void) => void) {
  return html`<div class="section-title">${t('editor.wall_color')}</div>
    ${paintPicker(r.wall_color, (c) => set((x) => (x.wall_color = c)))}
    <button
      class="btn block pressable"
      @click=${() =>
        ed.mutate((_d, f) => {
          for (const room of f.rooms) room.wall_color = r.wall_color;
        })}
    >
      <ha-icon icon="mdi:content-duplicate"></ha-icon>${t('editor.floor_all')}
    </button>`;
}

function wallsSection(ed: Ed, r: RoomConfig) {
  const n = r.points.length;
  const setLength = (i: number, meters: number) => {
    if (!(meters > 0)) return;
    ed.mutate((_d, f) => {
      const room = f.rooms.find((x) => x.id === r.id)!;
      const a = room.points[i];
      const j = (i + 1) % room.points.length;
      const b = room.points[j];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const L = meters * 100;
      const nb: Point = [round(a[0] + ((b[0] - a[0]) / len) * L, 1), round(a[1] + ((b[1] - a[1]) / len) * L, 1)];
      const delta: Point = [nb[0] - b[0], nb[1] - b[1]];
      room.points[j] = nb;
      // Keep right angles: a perpendicular next wall moves along in parallel.
      const k = (j + 1) % room.points.length;
      if (k !== i) {
        const c = room.points[k];
        const ux = (b[0] - a[0]) / len;
        const uy = (b[1] - a[1]) / len;
        const nx = c[0] - b[0];
        const ny = c[1] - b[1];
        const nl = Math.hypot(nx, ny) || 1;
        if (Math.abs((ux * nx + uy * ny) / nl) < 0.02) room.points[k] = [round(c[0] + delta[0], 1), round(c[1] + delta[1], 1)];
      }
    });
  };
  return html`<div class="section-title">${t('editor.walls')}</div>
    <div class="group">
      ${r.points.map((a, i) => {
        const b = r.points[(i + 1) % n];
        const cm = Math.hypot(b[0] - a[0], b[1] - a[1]);
        return html`<label class="row wall-row ${ed._vertex === i || ed._vertex === (i + 1) % n ? 'hl' : ''}">
          <span class="grow title">${t('editor.wall_n', { n: i + 1 })}</span>
          <input
            class="field len"
            type="number"
            inputmode="decimal"
            step="0.01"
            min="0.05"
            .value=${(cm / 100).toFixed(2)}
            @change=${(e: any) => setLength(i, parseFloat(String(e.target.value).replace(',', '.')))}
          />
          <span class="unit">m</span>
        </label>`;
      })}
    </div>
    <div class="hint-s">${t('editor.walls_hint')}</div>`;
}

/** Labels of the fixed media slots (the same words the popup uses) */
const SLOT_LABEL: Record<MediaSlot, I18nKey> = {
  power: 'media.power',
  power_on: 'media.power_on',
  power_off: 'media.power_off',
  volume_up: 'media.volume_up',
  volume_down: 'media.volume_down',
  mute: 'media.mute',
  play_pause: 'media.play_pause',
  previous: 'media.previous',
  next: 'media.next',
};

/** One command: a script (plus optional variables) or, without a script, any other action */
function commandEditor(ed: Ed, label: string, cmd: MediaCommand | undefined, set: (c: MediaCommand | undefined) => void) {
  const put = (p: Partial<MediaCommand>) => {
    const c: MediaCommand = { ...(cmd ?? {}), ...p };
    for (const k of Object.keys(c) as (keyof MediaCommand)[]) if (c[k] === undefined) delete c[k];
    set(Object.keys(c).length ? c : undefined);
  };
  return html`${entityRow(ed, label, cmd?.script, { domains: ['script'] }, (v) => put({ script: v, variables: v ? cmd?.variables : undefined, action: v ? undefined : cmd?.action }))}
    ${cmd?.script
      ? html`<label class="row field-row">
          <span class="subtitle">${t('editor.media_variables')}</span>
          <input
            class="field inline mono"
            data-media-vars
            placeholder='{"input": "hdmi1"}'
            .value=${cmd.variables ? JSON.stringify(cmd.variables) : ''}
            @change=${(e: any) => {
              const txt = e.target.value.trim();
              e.target.classList.remove('err');
              if (!txt) return put({ variables: undefined });
              try {
                const v = JSON.parse(txt);
                if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
                put({ variables: v });
              } catch {
                e.target.classList.add('err');
              }
            }}
          />
        </label>`
      : html`<details class="cmd-other" ?open=${!!cmd?.action}>
          <summary class="subtitle">${t('editor.media_other')}</summary>
          <fp-action-editor .hass=${ed.hass} .kind=${'opening'} .fallback=${'none'} .label=${label} .value=${cmd?.action} @value-change=${(e: CustomEvent) => put({ action: e.detail.value })}></fp-action-editor>
        </details>`}`;
}

/** Up / down / delete for an entry of a list */
function listTools(list: unknown[], i: number, move: (from: number, to: number) => void, remove: () => void) {
  return html`<div class="row list-tools">
    <span class="grow"></span>
    <button class="icon-btn plain pressable" aria-label=${t('editor.media_move_up')} ?disabled=${i === 0} @click=${() => move(i, i - 1)}><ha-icon icon="mdi:arrow-up"></ha-icon></button>
    <button class="icon-btn plain pressable" aria-label=${t('editor.media_move_down')} ?disabled=${i === list.length - 1} @click=${() => move(i, i + 1)}><ha-icon icon="mdi:arrow-down"></ha-icon></button>
    <button class="icon-btn plain pressable" data-media-remove aria-label=${t('editor.media_remove')} @click=${remove}><ha-icon icon="mdi:trash-can-outline" style="color:var(--fp-red)"></ha-icon></button>
  </div>`;
}

/**
 * Own media buttons of a device / piece: fixed slots (power, volume, playback), inputs and further buttons,
 * each a script or another action. Mostly for devices only reachable by infrared.
 */
function mediaSection(ed: Ed, media: MediaControlsConfig | undefined, setItem: (fn: (m: { media?: MediaControlsConfig }) => void) => void, irOnly: boolean, entity?: string) {
  const m = media ?? {};
  const set = (fn: (m: MediaControlsConfig) => void) =>
    setItem((x) => {
      const n: MediaControlsConfig = JSON.parse(JSON.stringify(x.media ?? {}));
      fn(n);
      for (const k of MEDIA_SLOTS) if (!n[k]) delete n[k];
      if (!n.sources?.length) delete n.sources;
      if (!n.buttons?.length) delete n.buttons;
      if (n.recognize && !n.recognize.enabled && !n.recognize.listeners?.length && !n.recognize.entity && !n.recognize.interval) delete n.recognize;
      x.media = Object.keys(n).length ? n : undefined;
    });
  const move = (key: 'sources' | 'buttons') => (from: number, to: number) =>
    set((n) => {
      const list = n[key]!;
      if (to < 0 || to >= list.length) return;
      const [it] = list.splice(from, 1);
      list.splice(to, 0, it as any);
    });
  const sources = m.sources ?? [];
  const buttons = m.buttons ?? [];
  const n = MEDIA_SLOTS.filter((k) => commandSet(m[k])).length + sources.filter(commandSet).length + buttons.filter(commandSet).length;
  return fold(
    t('editor.media_title'),
    html`<div class="hint-s">${t('editor.media_hint')}</div>
      ${irOnly ? html`<div class="hint-s">${t('editor.media_ir_hint')}</div>` : nothing}
      <div class="section-title">${t('editor.media_slots')}</div>
      <div class="group" data-media-slots>
        ${MEDIA_SLOTS.map((k) => commandEditor(ed, t(SLOT_LABEL[k]), m[k], (c) => set((x) => (x[k] = c))))}
      </div>
      <div class="section-title">${t('editor.media_inputs')}</div>
      ${sources.map(
        (src, i) => html`<div class="group" data-media-input=${i}>
          ${textField(t('editor.name'), src.name, (v) => set((x) => (x.sources![i].name = v || t('editor.media_new_input', { n: i + 1 }))))}
          ${commandEditor(ed, t('editor.media_script'), src, (c) => set((x) => (x.sources![i] = { ...(c ?? {}), name: x.sources![i].name })))}
          ${listTools(sources, i, move('sources'), () => set((x) => x.sources!.splice(i, 1)))}
        </div>`,
      )}
      <button class="btn tinted block pressable" data-media-add-input @click=${() => set((x) => (x.sources = [...(x.sources ?? []), { name: t('editor.media_new_input', { n: (x.sources?.length ?? 0) + 1 }) }]))}>
        <ha-icon icon="mdi:plus"></ha-icon>${t('editor.media_add_input')}
      </button>
      <div class="section-title">${t('editor.media_buttons')}</div>
      ${buttons.map(
        (b, i) => html`<div class="group" data-media-button=${i}>
          ${textField(t('editor.name'), b.name, (v) => set((x) => (x.buttons![i].name = v || t('editor.media_new_button', { n: i + 1 }))))}
          <fp-icon-picker .hass=${ed.hass} .value=${b.icon} .placeholder=${'mdi:gesture-tap-button'} @value-change=${(e: CustomEvent) => set((x) => (x.buttons![i].icon = e.detail.value || undefined))}></fp-icon-picker>
          ${commandEditor(ed, t('editor.media_script'), b, (c) => set((x) => (x.buttons![i] = { ...(c ?? {}), name: x.buttons![i].name, icon: x.buttons![i].icon })))}
          ${listTools(buttons, i, move('buttons'), () => set((x) => x.buttons!.splice(i, 1)))}
        </div>`,
      )}
      <button class="btn tinted block pressable" data-media-add-button @click=${() => set((x) => (x.buttons = [...(x.buttons ?? []), { name: t('editor.media_new_button', { n: (x.buttons?.length ?? 0) + 1 }) }]))}>
        <ha-icon icon="mdi:plus"></ha-icon>${t('editor.media_add_button')}
      </button>
      ${songSection(ed, m.recognize, (fn) => set((x) => fn((x.recognize ??= {}))), entity)}`,
    { icon: 'mdi:remote-tv', sub: n ? t('editor.media_n', { n }) : undefined },
  );
}

/** Result of "allow microphone" on this browser (editor session) */
let micAnswer: string | undefined;

/**
 * Song recognition of a media device: on / off, which browsers may listen (by their own id, song.ts), the entity
 * that tells whether the device is on, the interval. Needs the companion with an AcoustID key and HTTPS.
 */
function songSection(ed: Ed, r: SongRecognizeConfig | undefined, set: (fn: (r: SongRecognizeConfig) => void) => void, entity: string | undefined) {
  const on = !!r?.enabled;
  const me = browserId();
  const listeners = r?.listeners ?? [];
  const info = companionInfo();
  const server = !!info?.features?.includes('songs');
  const ask = async () => {
    const { askMicrophone } = await import('../song-capture');
    const res = await askMicrophone();
    micAnswer = res === 'ok' ? t('editor.song_mic_ok') : t(res === 'denied' ? 'song.denied' : res === 'no_mic' ? 'song.no_mic' : 'song.unsupported');
    ed.requestUpdate();
  };
  return html`<div class="section-title">${t('editor.song_title')}</div>
    <div class="group" data-song>
      ${switchRow(t('editor.song_enable'), on, () => set((x) => (x.enabled = !x.enabled || undefined)), t('editor.song_enable_sub'))}
    </div>
    <div class="hint-s">${t('editor.song_hint')}</div>
    ${on
      ? html`${!window.isSecureContext ? html`<div class="hint-s" data-song-https style="color:var(--fp-red)">${t('editor.song_https')}</div>` : nothing}
          ${!server ? html`<div class="hint-s" data-song-server style="color:var(--fp-red)">${t('editor.song_no_server')}</div>` : info?.song_key === false ? html`<div class="hint-s" data-song-key style="color:var(--fp-red)">${t('editor.song_no_key')}</div>` : nothing}
          <div class="section-title">${t('editor.song_listeners')}</div>
          ${listeners.map(
            (l, i) => html`<div class="group" data-song-listener=${l.id}>
              ${textField(l.id === me ? t('editor.song_this_browser') : t('editor.name'), l.name, (v) => set((x) => (x.listeners![i].name = v.trim() || l.name)))}
              <div class="row list-tools">
                <span class="grow subtitle mono">${l.id}</span>
                <button class="icon-btn plain pressable" data-song-remove aria-label=${t('editor.media_remove')} @click=${() => set((x) => x.listeners!.splice(i, 1))}><ha-icon icon="mdi:trash-can-outline" style="color:var(--fp-red)"></ha-icon></button>
              </div>
            </div>`,
          )}
          ${listeners.length ? nothing : html`<div class="hint-s">${t('editor.song_nobody')}</div>`}
          ${listeners.some((l) => l.id === me)
            ? nothing
            : html`<button class="btn tinted block pressable" data-song-add @click=${() => set((x) => (x.listeners = [...(x.listeners ?? []), { id: me, name: defaultBrowserName() }]))}>
                <ha-icon icon="mdi:tablet"></ha-icon>${t('editor.song_add_this')}
              </button>`}
          <div class="hint-s">${t('editor.song_listeners_hint')}</div>
          <button class="btn block pressable" data-song-ask @click=${ask}><ha-icon icon="mdi:microphone"></ha-icon>${t('editor.song_ask')}</button>
          ${micAnswer ? html`<div class="hint-s" data-song-answer>${micAnswer}</div>` : nothing}
          <div class="group">
            ${entityRow(ed, t('editor.song_entity'), r?.entity, {}, (v) => set((x) => (x.entity = v || undefined)))}
            <label class="row field-row">
              <span class="subtitle">${t('editor.song_interval')}</span>
              <input
                class="field len"
                type="number"
                inputmode="numeric"
                min="1"
                max="60"
                data-song-interval
                placeholder=${String(DEFAULT_INTERVAL)}
                .value=${r?.interval ? String(r.interval) : ''}
                @change=${(e: any) => {
                  const v = Math.round(Number(e.target.value));
                  set((x) => (x.interval = v >= 1 && v <= 60 && v !== DEFAULT_INTERVAL ? v : undefined));
                }}
              />
              <span class="unit">min</span>
            </label>
          </div>
          <div class="hint-s" ?data-song-no-state=${!r?.entity && !entity} style=${!r?.entity && !entity ? 'color:var(--fp-red)' : ''}>
            ${t(!r?.entity && !entity ? 'editor.song_entity_needed' : 'editor.song_entity_hint')}
          </div>`
      : nothing}`;
}

function deviceInspector(ed: Ed, d: DeviceConfig): TemplateResult {
  const set = (fn: (x: DeviceConfig) => void) => patchItem<DeviceConfig>(ed, 'devices', d.id, fn);
  const s = ed.hass.states[d.entity];
  return html`
    <div class="group">
      ${entityRow(ed, t('editor.entity'), d.entity, {}, (v) => v && set((x) => (x.entity = v)))}
      ${textField(t('editor.name'), d.name, (v) => set((x) => (x.name = v || undefined)), s?.attributes.friendly_name ?? '')}
    </div>
    ${hrRow(ed, d.entity)}
    <div class="section-title">${t('editor.display')}</div>
    <fp-segmented
      .options=${[
        { value: 'marker', label: t('editor.display_marker') },
        { value: 'value', label: t('editor.display_value') },
      ]}
      .value=${d.display ?? 'marker'}
      @value-change=${(e: CustomEvent) => set((x) => (x.display = e.detail.value === 'marker' ? undefined : e.detail.value))}
    ></fp-segmented>
    <div class="hint-s">${t(d.display === 'value' ? 'editor.display_value_hint' : 'editor.display_marker_hint')}</div>
    ${d.display === 'value'
      ? nothing
      : html`<div class="section-title">${t('editor.icon')}</div>
          <fp-icon-picker data-device-icon .hass=${ed.hass} .value=${d.icon} .placeholder=${stateIcon(ed.hass, s) ?? ''} @value-change=${(e: CustomEvent) => set((x) => (x.icon = e.detail.value))}></fp-icon-picker>`}
    <div class="group">
      ${switchRow(t('editor.show_name'), !!d.show_name, () => set((x) => (x.show_name = !x.show_name || undefined)))}
      ${d.display === 'value' ? nothing : switchRow(t('editor.show_state'), !!d.show_state, () => set((x) => (x.show_state = !x.show_state || undefined)))}
    </div>
    ${actions(ed, d, 'device', (k, v) => set((x) => ((x as any)[k] = v)))}
    ${d.display === 'value' ? nothing : mediaSection(ed, d.media, set, false, d.entity)}
    <button class="btn danger block pressable gap" @click=${ed.deleteSelection}><ha-icon icon="mdi:trash-can-outline"></ha-icon>${t('editor.delete_device')}</button>
  `;
}

function openingInspector(ed: Ed, o: OpeningConfig): TemplateResult {
  const set = (fn: (x: OpeningConfig) => void) => patchItem<OpeningConfig>(ed, 'openings', o.id, fn);
  const width = Math.hypot(o.b[0] - o.a[0], o.b[1] - o.a[1]);
  const setWidth = (w: number) =>
    set((x) => {
      const cx = (x.a[0] + x.b[0]) / 2;
      const cy = (x.a[1] + x.b[1]) / 2;
      const len = Math.hypot(x.b[0] - x.a[0], x.b[1] - x.a[1]) || 1;
      const dx = (x.b[0] - x.a[0]) / len;
      const dy = (x.b[1] - x.a[1]) / len;
      const nw = Math.max(30, Math.min(x.type === 'garage' ? 700 : 400, w));
      x.a = [round(cx - (dx * nw) / 2), round(cy - (dy * nw) / 2)];
      x.b = [round(cx + (dx * nw) / 2), round(cy + (dy * nw) / 2)];
    });
  return html`
    <fp-segmented
      .options=${[
        { value: 'door', label: t('editor.door'), icon: 'mdi:door' },
        { value: 'window', label: t('editor.window'), icon: 'mdi:window-closed-variant' },
        { value: 'garage', label: t('editor.garage_door'), icon: 'mdi:garage' },
      ]}
      .value=${o.type}
      @value-change=${(e: CustomEvent) =>
        set((x) => {
          x.type = e.detail.value;
          if (x.type !== 'garage') delete x.variant;
        })}
    ></fp-segmented>
    ${o.type === 'garage'
      ? html`<fp-segmented
          style="margin-top:var(--fp-space-3)"
          .options=${[
            { value: 'sectional', label: t('editor.garage_sectional') },
            { value: 'up_over', label: t('editor.garage_up_over') },
            { value: 'roller', label: t('editor.garage_roller') },
          ]}
          .value=${o.variant ?? 'sectional'}
          @value-change=${(e: CustomEvent) => set((x) => (x.variant = e.detail.value === 'sectional' ? undefined : e.detail.value))}
        ></fp-segmented>`
      : nothing}
    <div class="group" style="margin-top:var(--fp-space-3)">
      ${textField(t('editor.name'), o.name, (v) => set((x) => (x.name = v || undefined)), o.entity ? entityName(ed.hass, o.entity, ed.hass.states[o.entity]) : t(o.type === 'door' ? 'editor.door' : o.type === 'garage' ? 'editor.garage_door' : 'editor.window'))}
      ${o.type === 'garage'
        ? entityRow(ed, t('editor.garage_entity'), o.entity, { domains: ['cover', 'binary_sensor'], noVehicles: true }, (v) => set((x) => (x.entity = v)))
        : entityRow(ed, t('editor.contact_sensor'), o.entity, { domains: ['binary_sensor'], noVehicles: true }, (v) => set((x) => (x.entity = v)))}
      ${o.type === 'door'
        ? switchRow(t('editor.ea_is_door'), ed._draft.entry_alert?.door === o.id, () =>
            ed.mutate((x) => {
              const isDoor = x.entry_alert?.door === o.id;
              x.entry_alert = { ...(x.entry_alert ?? {}), door: isDoor ? undefined : o.id };
              if (isDoor) delete x.entry_alert.door;
            }),
          o.entity ? t('editor.ea_is_door_sub') : t('editor.ea_needs_sensor'),
        )
        : nothing}
    </div>
    ${o.type === 'garage' ? html`<div class="hint-s">${t('editor.garage_hint')}</div>` : nothing}
    ${hrRow(ed, o.entity)}
    <div class="section-title">${t('editor.geometry')}</div>
    <div class="group">
      ${stepper(t('editor.width'), width, 5, setWidth, ' cm')}
      ${(o.type === 'window' && width > 90) || o.type === 'garage'
        ? nothing
        : html`<button class="row" @click=${() => set((x) => (x.hinge_b = !x.hinge_b || undefined))}>
        <ha-icon icon="mdi:swap-horizontal" style="color:var(--fp-accent)"></ha-icon><span class="title accent">${t('editor.flip_hinge')}</span>
      </button>`}
      <button class="row" @click=${() => set((x) => (x.flip = !x.flip || undefined))}>
        <ha-icon icon="mdi:swap-vertical" style="color:var(--fp-accent)"></ha-icon><span class="title accent">${t('editor.flip_side')}</span>
      </button>
    </div>
    ${actions(ed, o, 'opening', (k, v) => set((x) => ((x as any)[k] = v)))}
    <button class="btn danger block pressable gap" @click=${ed.deleteSelection}><ha-icon icon="mdi:trash-can-outline"></ha-icon>${t('common.delete')}</button>
  `;
}

function colorRow(label: string, value: string | undefined, palette: string[], fallback: string, set: (c: string | undefined) => void) {
  return html`<div class="label-row">${label}</div>
    <div class="swatches">
      <button class="swatch none pressable ${!value ? 'sel' : ''}" title=${t('editor.paint_default')} aria-label=${t('editor.paint_default')} @click=${() => set(undefined)}>
        <ha-icon icon="mdi:format-color-marker-cancel"></ha-icon>
      </button>
      ${palette.map(
        (c) => html`<button class="swatch pressable ${value?.toLowerCase() === c ? 'sel' : ''}" style=${`background:${c}`} aria-label=${c} @click=${() => set(c)}></button>`,
      )}
      <label class="swatch custom" title=${t('editor.custom_color')}>
        <input type="color" .value=${value ?? fallback} @change=${(e: any) => set(e.target.value)} />
        <ha-icon icon="mdi:eyedropper-variant"></ha-icon>
      </label>
    </div>`;
}

/** Entities that fit a piece's role */
const LINK_FILTER: Record<string, EntityFilter> = {
  light: { domains: ['light', 'switch', 'input_boolean'] },
  heat: { domains: ['climate', 'switch', 'input_boolean', 'water_heater'] },
  fan: { domains: ['fan', 'switch', 'climate', 'input_boolean'] },
  air: { domains: ['fan', 'humidifier', 'switch', 'input_boolean'] },
  ac: { domains: ['climate', 'fan', 'switch'] },
  media: { domains: ['media_player', 'switch'] },
  pet: { domains: ['device_tracker', 'person', 'binary_sensor', 'input_boolean', 'sensor'] },
  mower: { domains: ['lawn_mower', 'vacuum', 'switch'] },
  water: { domains: ['valve', 'switch', 'input_boolean'] },
  energy: { domains: ['sensor', 'binary_sensor', 'switch', 'climate', 'input_boolean'] },
  car: { domains: ['sensor'] },
  battery: { domains: ['sensor', 'binary_sensor', 'switch', 'device_tracker'] },
  network: { domains: ['binary_sensor', 'device_tracker', 'sensor', 'switch', 'button'] },
  sensor: { domains: ['binary_sensor', 'sensor', 'event', 'input_boolean'] },
  alarm: { domains: ['alarm_control_panel', 'binary_sensor', 'siren', 'sensor', 'switch'] },
  lock: { domains: ['lock', 'binary_sensor'] },
  cover: { domains: ['cover', 'binary_sensor', 'switch', 'button'] },
  camera: { domains: ['camera', 'binary_sensor', 'event', 'image'] },
  meter: { domains: ['sensor'] },
};

/** Extra links of energy / vehicle pieces: [key, label key, filter] */
const EXTRA_LINKS: Record<string, [string, Parameters<typeof t>[0], EntityFilter][]> = {
  car: [
    ['range', 'editor.car_range', { domains: ['sensor'] }],
    ['charging', 'editor.car_charging', { domains: ['binary_sensor', 'sensor', 'switch'] }],
    ['power', 'editor.car_power', { domains: ['sensor'] }],
    ['location', 'editor.car_location', { domains: ['device_tracker', 'person', 'binary_sensor', 'sensor'] }],
    ['address', 'editor.car_address', { domains: ['sensor'] }],
  ],
  home_battery: [['power', 'editor.battery_power', { domains: ['sensor'] }]],
};

/** Main link label per kind */
const MAIN_LINK: Record<string, Parameters<typeof t>[0]> = {
  car: 'editor.car_soc',
  home_battery: 'editor.battery_soc',
  solar_panels: 'editor.solar_power',
  inverter: 'editor.solar_power',
  wallbox: 'editor.wallbox_state',
  lawn_mower: 'editor.mower_entity',
  sprinkler: 'editor.sprinkler_entity',
  dog: 'editor.pet_presence',
  cat: 'editor.pet_presence',
  ebike: 'editor.car_soc',
  scooter: 'editor.car_soc',
  ebike_battery: 'editor.car_soc',
  ups: 'editor.car_soc',
  meter: 'editor.solar_power',
  camera: 'editor.link_camera',
  doorbell: 'editor.link_camera',
  smart_lock: 'editor.link_lock',
  garage_door: 'editor.link_cover',
  gate: 'editor.link_cover',
  alarm_panel: 'editor.link_alarm',
  siren: 'editor.link_alarm',
  router: 'editor.link_network',
  network: 'editor.link_network',
  access_point: 'editor.link_network',
  server_rack: 'editor.link_network',
  mini_pc: 'editor.link_network',
  mailbox: 'editor.link_mail',
  irrigation: 'editor.sprinkler_entity',
};

/** Car: link the values the plan's chip shows (range, charging, power, location, address) from the detection
 * on the car's device (car-info.ts); excluded entities stay out */
function autoLinkCar(ed: Ed, f: FurnitureConfig): Record<string, string> {
  const info = carInfo(ed.hass, { ...f, entities: undefined });
  const out: Record<string, string> = {};
  for (const k of CAR_LINK_KEYS) if (info.roles[k]) out[k] = info.roles[k];
  return out;
}

/** Former link keys the plan's value chip reads (`entities.range` …) */
const CAR_LINK_KEYS = new Set(['range', 'charging', 'power', 'location', 'address']);

/** Take an entity out of every place of the car's config (links, own entries, exclusions) */
function carStrip(x: FurnitureConfig, id: string) {
  if (x.entities) {
    for (const [k, v] of Object.entries(x.entities)) if (v === id) delete x.entities[k];
    if (!Object.keys(x.entities).length) delete x.entities;
  }
  if (x.extra) {
    x.extra = x.extra.filter((e) => e.entity !== id);
    if (!x.extra.length) delete x.extra;
  }
  if (x.exclude) {
    x.exclude = x.exclude.filter((e) => e !== id);
    if (!x.exclude.length) delete x.exclude;
  }
}

/** Car: everything found on its device, grouped like the overview — each entry can be excluded or put into another
 * role / group; any entity can be added by hand with its own name and icon */
function carSection(ed: Ed, f: FurnitureConfig, set: (fn: (x: FurnitureConfig) => void) => void) {
  const info = carInfo(ed.hass, f);
  const name = (id: string) => entityName(ed.hass, id, ed.hass.states[id]);
  const roleOpts = [
    ...CAR_GROUPS.map((g) => ({ value: g, label: t('editor.car_own', { group: t(`car.group_${g}`) }), group: t('editor.car_own_group') })),
    ...CAR_ROLE_KEYS.filter((k) => k !== 'warnings').map((k) => ({ value: k, label: t(`car.role.${k}` as I18nKey), group: t(`car.group_${CAR_ROLE[k].group}`) })),
  ];
  const assign = (id: string, m: ManualEntityConfig) =>
    set((x) => {
      carStrip(x, id);
      carStrip(x, m.entity);
      const role = m.role ?? 'status';
      if (role === LEGACY_MAIN && !m.name && !m.icon) x.entity = m.entity;
      else if (CAR_LINK_KEYS.has(role) && !m.name && !m.icon) x.entities = { ...(x.entities ?? {}), [role]: m.entity };
      else x.extra = [...(x.extra ?? []), { ...m, role }];
    });
  const exclude = (id: string) =>
    set((x) => {
      carStrip(x, id);
      x.exclude = [...(x.exclude ?? []), id];
    });
  const edit = (id: string, role: string, extra?: ManualEntityConfig, isNew = false) =>
    ed.openEntityEdit({
      title: isNew ? t('editor.car_add') : t('editor.ent_edit'),
      value: { entity: id, role, name: extra?.name, icon: extra?.icon },
      roles: roleOpts,
      removeLabel: t('editor.exclude'),
      onRemove: isNew || !id || id === f.entity ? undefined : () => exclude(id),
      onSave: (m) => assign(id, m),
    });
  const explicitIds = new Set([f.entity, ...Object.values(f.entities ?? {}), ...(f.extra ?? []).map((x) => x.entity)]);
  const row = (role: string, id: string, label: string, icon: string, extra?: ManualEntityConfig) => {
    const auto = !explicitIds.has(id);
    return html`<div class="row" data-car-role=${role} data-entity=${id}>
      <span class="ic"><ha-icon .icon=${extra?.icon ?? icon}></ha-icon></span>
      <button class="grow pick" @click=${() => edit(id, role, extra)}>
        <div class="subtitle">${label}${auto ? html` · <span class="auto">${t('editor.detected')}</span>` : nothing}</div>
        <div class="title">${extra?.name ?? name(id)}</div>
      </button>
      ${id === f.entity
        ? nothing
        : html`<button class="icon-btn plain pressable" data-car-exclude aria-label=${t('editor.exclude')} title=${t('editor.exclude')} @click=${() => exclude(id)}>
            <ha-icon icon="mdi:eye-off-outline" style="color:var(--fp-label-3)"></ha-icon>
          </button>`}
    </div>`;
  };
  const byGroup = (g: CarGroup) => [
    ...Object.entries(info.roles)
      .filter(([k]) => CAR_ROLE[k]?.group === g && k !== LEGACY_MAIN)
      .map(([k, id]) => row(k, id, t(`car.role.${k}` as I18nKey), CAR_ROLE[k].icon, f.extra?.find((x) => x.entity === id))),
    ...(g === 'climate' ? info.seats.map((id) => row('seat', id, t('car.role.seat'), CAR_ROLE.seat.icon)) : []),
    ...(g === 'status' ? info.warnings.map((id) => row('warnings', id, t('car.role.warnings'), CAR_ROLE.warnings.icon)) : []),
    ...info.extras.filter((x) => x.group === g).map((x) => row(g, x.entity, t('editor.car_own', { group: t(`car.group_${g}`) }), x.icon ?? 'mdi:car-info', x)),
  ];
  return html`
    <div class="section-title">${t('editor.car_functions')}</div>
    ${CAR_GROUPS.map((g) => {
      const rows = byGroup(g);
      return rows.length ? html`<div class="label-row">${t(`car.group_${g}`)}</div><div class="group" data-car-group=${g}>${rows}</div>` : nothing;
    })}
    <button class="btn tinted block pressable" data-car-add @click=${() => edit('', 'status', undefined, true)}>
      <ha-icon icon="mdi:plus-circle"></ha-icon>${t('editor.car_add')}
    </button>
    ${info.rest.length
      ? fold(
          t('editor.car_unassigned'),
          html`<div class="group">
            ${info.rest.map(
              (id) => html`<div class="row" data-car-rest=${id}>
                <div class="grow"><div class="title">${name(id)}</div><div class="subtitle">${formatState(ed.hass, ed.hass.states[id])}</div></div>
                <button class="btn tinted small pressable" @click=${() => edit(id, 'status')}>${t('editor.assign')}</button>
                <button class="icon-btn plain pressable" aria-label=${t('editor.exclude')} title=${t('editor.exclude')} @click=${() => exclude(id)}><ha-icon icon="mdi:eye-off-outline" style="color:var(--fp-label-3)"></ha-icon></button>
              </div>`,
            )}
          </div>`,
          { icon: 'mdi:help-circle-outline', sub: String(info.rest.length) },
        )
      : nothing}
    ${f.exclude?.length
      ? fold(
          t('editor.excluded'),
          html`<div class="group">
            ${f.exclude.map(
              (id) => html`<div class="row" data-car-excluded=${id}>
                <div class="grow"><div class="title">${name(id)}</div></div>
                <button class="btn tinted small pressable" @click=${() => set((x) => carStrip(x, id))}>${t('editor.include_again')}</button>
              </div>`,
            )}
          </div>`,
          { icon: 'mdi:eye-off-outline', sub: String(f.exclude.length) },
        )
      : nothing}
    <div class="hint-s">${t('editor.car_functions_hint')}</div>
  `;
}

/** Energy / vehicle pieces: further links, empty threshold, value chip */
function linkSection(ed: Ed, f: FurnitureConfig, set: (fn: (x: FurnitureConfig) => void) => void) {
  const kind = resolveFurniture(f).k?.kind ?? '';
  const extra = EXTRA_LINKS[kind] ?? [];
  const setLink = (k: string, v: string | undefined) =>
    set((x) => {
      const e = { ...(x.entities ?? {}) };
      if (v) e[k] = v;
      else delete e[k];
      x.entities = Object.keys(e).length ? e : undefined;
    });
  return html`
    ${extra.length ? html`<div class="group">${extra.map(([k, label, filter]) => entityRow(ed, t(label), f.entities?.[k], filter, (v) => setLink(k, v)))}</div>` : nothing}
    ${kind === 'car' && f.entity
      ? html`<button class="btn tinted block pressable" @click=${() => set((x) => (x.entities = { ...(x.entities ?? {}), ...autoLinkCar(ed, x) }))}>
          <ha-icon icon="mdi:auto-fix"></ha-icon>${t('editor.car_autolink')}
        </button>`
      : nothing}
    ${kind === 'car' && (f.entity || f.entities || f.extra) ? carSection(ed, f, set) : nothing}
    <div class="group">
      ${kind === 'car' ? stepper(t('editor.car_low'), f.low ?? 15, 5, (v) => set((x) => (x.low = Math.max(0, Math.min(50, v)) === 15 ? undefined : Math.max(0, Math.min(50, v)))), ' %') : nothing}
      ${kind === 'home_battery' ? switchRow(t('editor.invert_power'), !!f.invert_power, () => set((x) => (x.invert_power = x.invert_power ? undefined : true)), t('editor.invert_power_sub')) : nothing}
      ${['car', 'home_battery', 'solar_panels', 'lawn_mower'].includes(kind)
        ? switchRow(t('editor.show_value'), f.show_value ?? true, () => set((x) => (x.show_value = (x.show_value ?? true) ? false : undefined)))
        : nothing}
    </div>
    <div class="hint-s">${t(kind === 'car' ? 'editor.car_hint' : 'editor.energy_hint')}</div>
  `;
}

/** Chips to pick one value */
function choiceChips<T extends string>(label: string, options: [T, string][], value: T, set: (v: T) => void) {
  return html`<div class="label-row">${label}</div>
    <div class="chips">
      ${options.map(([v, l]) => html`<button class="chip pressable" aria-pressed=${value === v ? 'true' : 'false'} @click=${() => set(v)}>${l}</button>`)}
    </div>`;
}

const COLLARS = ['#d8483a', '#e8892c', '#e8c547', '#4f9d5d', '#3f8ed8', '#5a8fd8', '#8a5cc8', '#e46aa0', '#2c2c2e', '#8b5a3c'];

/** Dog / cat: name, presence, walk times, look */
/** Robot vacuum driving live through the plan: mode, and laying its map onto the plan */
function vacuumSection(ed: Ed, f: FurnitureConfig, set: (fn: (x: FurnitureConfig) => void) => void) {
  const c = companionInfo();
  const v = f.vacuum ?? {};
  const tf = v.transform;
  const ent = f.entity?.startsWith('vacuum.') ? f.entity : undefined;
  if (ent && c) ed.loadVacLearned(ent, false, v.map_entity);
  const l = ent ? ed.vacLearned.get(ent) : undefined;
  const vm = ent ? ed.vacMaps.get(ent) : undefined;
  const info = ent ? ed.vacInfo.get(ent) : undefined;
  const setV = (fn: (x: NonNullable<FurnitureConfig['vacuum']>) => void) =>
    set((x) => {
      const n = { ...(x.vacuum ?? {}) };
      fn(n);
      for (const k of Object.keys(n)) if ((n as any)[k] === undefined) delete (n as any)[k];
      x.vacuum = Object.keys(n).length ? n : undefined;
    });
  /** another map entity (undefined: found automatically) — its map and position are fetched again */
  const pickMap = (m: string | undefined) => {
    setV((x) => (x.map_entity = m));
    if (ent) ed.loadVacLearned(ent, true, m);
  };
  const floor = ed._draft.floors.find((fl) => fl.furniture?.some((p) => p.id === f.id));
  const area = l ? (l.cells.length * (l.res / 1000) ** 2).toFixed(1).replace('.', ',') : '0';
  const mapName = (id: string) => entityName(ed.hass, id) || id;
  const source = !info
    ? t('editor.vac_loading')
    : info.adapter === 'roborock'
      ? t('editor.vac_src_roborock')
      : info.adapter === 'map_camera'
        ? t('editor.vac_src_map_camera', { entity: mapName(info.source ?? '') })
        : info.adapter === 'valetudo'
          ? t('editor.vac_src_valetudo', { entity: mapName(info.source ?? '') })
          : t('editor.vac_src_none');
  // map entities to choose from: what the companion suggests, plus the one picked before
  const maps = info ? [...new Set([...(v.map_entity ? [v.map_entity] : []), ...info.candidates])] : [];
  return html`
    <div class="section-title">${t('editor.vac_live')}</div>
    ${!ent
      ? html`<div class="hint-s">${t('editor.vac_need_entity')}</div>`
      : !c
        ? html`<div class="hint-s">${t('editor.vac_need_companion')}</div>`
        : html`
            <div class="group">
              <div class="row" data-vac-source=${info?.adapter ?? ''}>
                <ha-icon icon=${info && !info.adapter ? 'mdi:map-marker-off-outline' : 'mdi:map-marker-radius-outline'} style="color:var(--fp-label-2)"></ha-icon>
                <div class="grow">
                  <div class="title">${source}</div>
                  ${info?.segments.length
                    ? html`<div class="subtitle">${t(info.clean ? 'editor.vac_segments' : 'editor.vac_segments_ro', { n: String(info.segments.length) })}</div>`
                    : nothing}
                </div>
              </div>
            </div>
            ${info && !info.adapter ? html`<div class="hint-s">${t('editor.vac_src_none_hint')}</div>` : nothing}
            ${maps.length > 1 || v.map_entity
              ? html`<div class="hint-s">${t('editor.vac_src_pick')}</div>
                  <div class="chips">
                    <button class="chip pressable" aria-pressed=${!v.map_entity ? 'true' : 'false'} @click=${() => pickMap(undefined)}>${t('editor.vac_src_auto')}</button>
                    ${maps.map((m) => html`<button class="chip pressable" aria-pressed=${v.map_entity === m ? 'true' : 'false'} @click=${() => pickMap(m)}>${mapName(m)}</button>`)}
                  </div>`
              : nothing}
            <div class="chips">
              ${(['delayed', 'live'] as const).map(
                (m) => html`<button class="chip pressable" aria-pressed=${(v.mode ?? 'delayed') === m ? 'true' : 'false'} @click=${() => setV((x) => (x.mode = m === 'delayed' ? undefined : m))}>${t(m === 'delayed' ? 'editor.vac_delayed' : 'editor.vac_realtime')}</button>`,
              )}
            </div>
            <div class="hint-s">${t((v.mode ?? 'delayed') === 'delayed' ? 'editor.vac_delayed_hint' : 'editor.vac_realtime_hint')}</div>
            ${(v.mode ?? 'delayed') === 'delayed'
              ? html`<div class="group">${stepper(t('editor.vac_delay'), v.delay ?? 2.5, 0.5, (n) => setV((x) => (x.delay = Math.max(1, Math.min(6, n)) === 2.5 ? undefined : Math.max(1, Math.min(6, n)))), ' s')}</div>`
              : nothing}
            <div class="section-title">${t('editor.vac_map')}</div>
            <div class="group">
              <div class="row"><ha-icon icon="mdi:map-marker-path" style="color:var(--fp-label-2)"></ha-icon><div class="grow subtitle">${l === null ? t('editor.vac_loading') : t('editor.vac_learned', { m2: area, runs: String(l?.runs ?? 0) })}${l?.dock ? ` · ${t('editor.vac_dock_known')}` : ''}${vm ? ` · ${t('editor.vac_map_known', { n: String(vm.rooms.length) })}` : ''}</div></div>
              <button class="row" ?disabled=${!floor || (!vm && (!l || l.cells.length < 30))} @click=${() => ed.startAlign(f.id)}>
                <ha-icon icon="mdi:map-marker-path" style="color:var(--fp-accent)"></ha-icon>
                <div class="grow"><div class="title accent">${t('editor.va_open')}</div><div class="subtitle">${t('editor.va_open_sub')}</div></div>
                ${tf ? html`<span class="trailing">${(tf.rot ?? 0).toFixed(0)}° · ${Math.round((tf.scale ?? 0.1) * 1000)} %</span>` : nothing}
                <ha-icon icon="mdi:chevron-right" style="color:var(--fp-label-3)"></ha-icon>
              </button>
              ${tf
                ? html`<button class="row" @click=${() => setV((x) => ((x.transform = undefined), (x.rooms = undefined)))}>
                    <ha-icon icon="mdi:map-marker-remove-outline" style="color:var(--fp-label-3)"></ha-icon><span class="title">${t('editor.vac_unalign')}</span>
                  </button>`
                : nothing}
            </div>
            <div class="hint-s">${t('editor.vac_map_hint')}</div>
            <button
              class="row"
              style="margin-top:var(--fp-space-3)"
              ?disabled=${!l?.cells.length}
              @click=${async () => {
                if (!(await ed.layer.confirm(t('editor.vac_reset_confirm')))) return;
                await vacuumReset(ed.hass, ent).catch(() => {});
                ed.loadVacLearned(ent, true, v.map_entity);
              }}
            >
              <ha-icon icon="mdi:eraser" style="color:var(--fp-label-3)"></ha-icon><span class="title">${t('editor.vac_reset')}</span>
            </button>
          `}
  `;
}

/** Wi-Fi QR codes (a tap on the router): the home's networks live in the companion integration, not in the dashboard,
 *  so they are saved here on their own ("Save Wi-Fi"), apart from the plan */
async function loadWifi(ed: Ed) {
  try {
    const r = await ed.hass.callWS<{ networks: WifiNetwork[] }>({ type: 'floorplan_card/wifi/get' });
    ed._wifi = { nets: r?.networks ?? [], dirty: false };
  } catch {
    ed._wifi = { nets: [], dirty: false, missing: true };
  }
}

function wifiSection(ed: Ed) {
  const w = ed._wifi;
  if (!w) {
    ed._wifi = { nets: [], dirty: false, busy: true };
    void loadWifi(ed);
  }
  if (!w || w.busy) return html`<div class="section-title">${t('wifi.editor_title')}</div><div class="hint-s">${t('wifi.loading')}</div>`;
  if (w.missing) return html`<div class="section-title">${t('wifi.editor_title')}</div><div class="hint-s">${t('wifi.empty_companion')}</div>`;
  const change = (fn: (nets: WifiNetwork[]) => void) => {
    const nets = w.nets.map((n) => ({ ...n }));
    fn(nets);
    ed._wifi = { ...w, nets, dirty: true };
  };
  const add = (n: Partial<WifiNetwork> = {}) => change((nets) => nets.push({ id: '', name: '', ssid: '', password: '', security: 'wpa2', hidden: false, ...n }));
  const scan = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const { scanWifiImage } = await import('./wifi-scan');
      const r = await scanWifiImage(file);
      if (r.net) {
        add({ ...r.net, name: r.net.ssid });
        ed.layer.toast(t('wifi.scan_ok', { ssid: r.net.ssid }));
      } else ed.layer.toast(t(r.error === 'not_wifi' ? 'wifi.scan_not_wifi' : 'wifi.scan_none'));
    } catch (err) {
      ed.layer.toast(t((err as Error)?.name === 'bad_image' ? 'wifi.scan_bad_image' : 'wifi.scan_none'));
    }
  };
  const save = async () => {
    ed._wifi = { ...w, busy: true };
    try {
      await ed.hass.callWS({ type: 'floorplan_card/wifi/set', networks: w.nets.map((n) => ({ ...n, id: n.id || undefined })) });
      await loadWifi(ed);
      ed.layer.toast(t('wifi.saved'));
    } catch (err) {
      ed._wifi = { ...w, busy: false };
      ed.layer.toast(t((err as { code?: string })?.code === 'invalid_password' ? 'wifi.err_password' : 'wifi.err_save'));
    }
  };
  const sec: [WifiSecurity, string][] = [
    ['wpa2', 'WPA/WPA2'],
    ['wpa3', 'WPA3'],
    ['nopass', t('wifi.open')],
  ];
  return html`<div class="section-title">${t('wifi.editor_title')}</div>
    <div class="hint-s">${t('wifi.editor_hint')}</div>
    ${w.nets.map(
      (n, i) => html`<div class="group wifi-net" style="margin-bottom:var(--fp-space-3)">
        ${textField(t('editor.name'), n.name, (v) => change((x) => (x[i].name = v)), n.ssid)}
        ${textField(t('wifi.ssid'), n.ssid, (v) => change((x) => (x[i].ssid = v)))}
        ${n.security === 'nopass'
          ? nothing
          : html`<label class="row field-row">
              <span class="subtitle">${t('wifi.password')}</span>
              <input class="field inline wifi-pw" type=${w.show ? 'text' : 'password'} autocomplete="off" .value=${n.password} @change=${(e: any) => change((x) => (x[i].password = e.target.value))} />
            </label>`}
        <div style="padding:0 var(--fp-space-4) var(--fp-space-3)">
          ${choiceChips(t('wifi.security'), sec, n.security === 'wpa' ? 'wpa2' : n.security, (v) => change((x) => (x[i].security = v)))}
        </div>
        ${checkRow(t('wifi.hidden'), !!n.hidden, () => change((x) => (x[i].hidden = !x[i].hidden)))}
        ${checkRow(t('wifi.admins_only'), !!n.admins_only, () => change((x) => (x[i].admins_only = !x[i].admins_only)), t('wifi.admins_only_sub'))}
        <button class="row pressable" @click=${() => change((x) => x.splice(i, 1))}>
          <ha-icon icon="mdi:delete-outline" style="color:var(--fp-red)"></ha-icon><span class="title" style="color:var(--fp-red)">${t('wifi.remove')}</span>
        </button>
      </div>`,
    )}
    <div class="group">
      <button class="row pressable wifi-add" @click=${() => add()} ?disabled=${w.nets.length >= 10}>
        <ha-icon icon="mdi:plus" style="color:var(--fp-accent)"></ha-icon><span class="title">${t('wifi.add')}</span>
      </button>
      <label class="row pressable wifi-scan">
        <ha-icon icon="mdi:qrcode-scan" style="color:var(--fp-accent)"></ha-icon>
        <div class="grow"><div class="title">${t('wifi.scan')}</div><div class="subtitle">${t('wifi.scan_sub')}</div></div>
        <input type="file" accept="image/*" style="display:none" @change=${scan} />
      </label>
      ${w.nets.some((n) => n.security !== 'nopass') ? checkRow(t('wifi.show_password'), !!w.show, () => (ed._wifi = { ...w, show: !w.show })) : nothing}
    </div>
    ${w.dirty ? html`<button class="btn accent block pressable wifi-save" style="margin-top:var(--fp-space-3)" @click=${save}>${t('wifi.save')}</button>` : nothing}`;
}

/** A tick row */
function checkRow(label: string, on: boolean, toggle: () => void, sub?: string, disabled = false) {
  return html`<button class="row pressable" role="checkbox" aria-checked=${on ? 'true' : 'false'} ?disabled=${disabled} @click=${toggle} style=${disabled ? 'opacity:.5' : ''}>
    <ha-icon icon=${on ? 'mdi:check-circle' : 'mdi:checkbox-blank-circle-outline'} style=${`color:${on ? 'var(--fp-accent)' : 'var(--fp-label-3)'}`}></ha-icon>
    <div class="grow" style="text-align:left"><div class="title">${label}</div>${sub ? html`<div class="subtitle">${sub}</div>` : nothing}</div>
  </button>`;
}

/** Walk reminders (companion integration): title + text written plainly, the rest by ticks; test button */
function remindSection(ed: Ed, f: FurnitureConfig, r: WalkReminder | undefined, set: (fn: (r: WalkReminder) => void) => void) {
  const c = companionInfo();
  const rr = r ?? {};
  const hass = ed.hass;
  const name = (id: string) => entityName(hass, id, hass.states[id]);
  const persons = Object.keys(hass.states).filter((e) => e.startsWith('person.'));
  const phones = new Map(persons.map((pp) => [pp, phoneOf(hass, pp)]));
  const used = new Set([...phones.values()].filter(Boolean));
  const others = Object.keys(hass.services?.notify ?? {})
    .map((n) => `notify.${n}`)
    .filter((sv) => !used.has(sv) && !['notify.notify', 'notify.persistent_notification', 'notify.send_message'].includes(sv));
  const targets = rr.notify?.targets ?? [];
  const zones = Object.keys(hass.states).filter((e) => e.startsWith('zone.'));
  const setNotify = (fn: (n: NonNullable<WalkReminder['notify']>) => void) =>
    set((x) => {
      const n = { targets: [...(x.notify?.targets ?? [])], zone: x.notify?.zone, fallback: x.notify?.fallback };
      fn(n);
      x.notify = n.targets.length ? n : undefined;
    });
  const toggleTarget = (service: string, person?: string) =>
    setNotify((n) => {
      const i = n.targets.findIndex((t) => t.service === service);
      if (i >= 0) n.targets.splice(i, 1);
      else n.targets.push(person ? { person, service } : { service });
    });
  const pretty = (sv: string) => sv.replace(/^notify\.(mobile_app_)?/, '').replace(/_/g, ' ');
  const who = (sv: string) => {
    const t = targets.find((x) => x.service === sv);
    return t?.person ? name(t.person) : pretty(sv);
  };
  return html`
    <div class="section-title">${t('editor.remind')}</div>
    ${c ? nothing : html`<div class="hint-s">${t('editor.remind_needs')}</div>`}
    <div class="group">
      ${textField(t('editor.remind_title'), rr.title, (v) => set((x) => (x.title = v.trim() || undefined)), defaultTitle(f))}
      ${textField(t('editor.remind_text'), rr.text, (v) => set((x) => (x.text = v.trim() || undefined)), defaultText(f))}
      ${checkRow(t('editor.remind_time'), rr.show_time !== false, () => set((x) => (x.show_time = x.show_time === false ? undefined : false)), t('editor.remind_time_sub'))}
      ${checkRow(t('editor.remind_done'), rr.done_button !== false, () => set((x) => (x.done_button = x.done_button === false ? undefined : false)), t('editor.remind_done_sub'))}
      ${checkRow(t('editor.remind_important'), !!rr.important, () => set((x) => (x.important = x.important ? undefined : true)), t('editor.remind_important_sub'))}
    </div>
    <div class="group" style="margin-top:var(--fp-space-3)">
      ${stepper(t('editor.remind_after'), rr.after ?? 0, 5, (v) => set((x) => (x.after = Math.max(0, Math.min(240, v)) || undefined)), ' min')}
      ${stepper(t('editor.remind_repeat'), rr.repeat ?? 0, 5, (v) => set((x) => (x.repeat = Math.max(0, Math.min(240, v)) || undefined)), ' min')}
      ${rr.repeat ? stepper(t('editor.remind_count'), rr.count ?? 3, 1, (v) => set((x) => (x.count = Math.max(1, Math.min(10, v))))) : nothing}
    </div>
    <div class="hint-s">${t('editor.remind_timing_hint')}</div>
    <div class="section-title">${t('editor.remind_who')}</div>
    <div class="group">
      ${persons.map((pp) => {
        const phone = phones.get(pp);
        return checkRow(name(pp), !!phone && targets.some((tg) => tg.service === phone), () => phone && toggleTarget(phone, pp), phone ? pretty(phone) : t('editor.remind_no_phone'), !phone);
      })}
      ${others.map((sv) => checkRow(pretty(sv), targets.some((tg) => tg.service === sv), () => toggleTarget(sv), t('editor.remind_other')))}
      ${!persons.length && !others.length ? html`<div class="row"><div class="grow subtitle">${t('editor.remind_none')}</div></div>` : nothing}
    </div>
    ${targets.length
      ? html`<div class="group" style="margin-top:var(--fp-space-3)">
          <label class="row field-row">
            <span class="subtitle">${t('editor.remind_where')}</span>
            <select class="field inline" @change=${(e: Event) => setNotify((n) => (n.zone = (e.target as HTMLSelectElement).value || undefined))}>
              <option value="" ?selected=${!rr.notify?.zone}>${t('editor.remind_everywhere')}</option>
              ${zones.map((z) => html`<option value=${z} ?selected=${rr.notify?.zone === z}>${t('editor.remind_in_zone', { zone: name(z) })}</option>`)}
            </select>
          </label>
          ${rr.notify?.zone
            ? checkRow(t('editor.remind_fallback'), (rr.notify?.fallback ?? 'all') === 'all', () => setNotify((n) => (n.fallback = (n.fallback ?? 'all') === 'all' ? 'none' : undefined)), t('editor.remind_fallback_sub'))
            : nothing}
        </div>`
      : nothing}
    <div class="section-title">${t('editor.remind_speak')}</div>
    <div class="group">
      ${checkRow(t('editor.remind_speak_on'), !!rr.speak, () => set((x) => (x.speak = x.speak ? undefined : {})))}
      ${rr.speak
        ? html`${entityRow(ed, t('editor.ea_tts'), rr.speak.tts_entity, { domains: ['tts'] }, (v) => set((x) => (x.speak = { ...x.speak, tts_entity: v })))}
          ${entityRow(ed, t('editor.ea_player'), rr.speak.media_player, { domains: ['media_player'] }, (v) => set((x) => (x.speak = { ...x.speak, media_player: v })))}`
        : nothing}
    </div>
    <button
      class="row add"
      style="margin-top:var(--fp-space-3);justify-content:center"
      ?disabled=${!targets.length && !(rr.speak?.tts_entity && rr.speak?.media_player)}
      @click=${async () => {
        const res = await sendTest(hass, f, rr);
        const list = res.sent.map(who).join(', ');
        ed.layer.toast(
          res.sent.length
            ? t(res.fallback ? 'editor.remind_test_fallback' : 'editor.remind_test_sent', { who: list }) + (res.spoken ? ` · ${t('editor.remind_test_spoken')}` : '')
            : res.spoken
              ? t('editor.remind_test_spoken')
              : res.fallback
                ? t('editor.remind_test_nobody')
                : t('editor.remind_test_failed'),
        );
      }}
    >
      <ha-icon icon="mdi:send-circle" style="color:var(--fp-accent)"></ha-icon><span class="title accent">${t('editor.remind_test')}</span>
    </button>
  `;
}

/** The dog as it looks on the plan (a still picture of the 3D model) and the way into the 3D editor */
function dogDesignCard(ed: Ed, f: FurnitureConfig, set: (fn: (x: FurnitureConfig) => void) => void) {
  const look = petLook(f);
  const r = resolveFurniture(f);
  const pose = look.pose === 'lying' ? 'Lie' : look.pose === 'sitting' ? 'Sit' : 'Idle';
  const open = () =>
    void ed.layer.openDogEditor(f).then((nf) => {
      if (!nf) return;
      set((x) => {
        x.variant = nf.variant;
        x.w = nf.w;
        x.h = nf.h;
        x.height = nf.height;
        x.color = nf.color;
        x.accent = nf.accent;
        x.pet = nf.pet;
      });
    });
  return html`<button class="dog-card pressable" data-dog-design @click=${open}>
      <div class="dog-pic">
        ${until(
          dogPicture(look, { length: f.w, height: r.height, width: f.h }, pose).then((src) => (src ? html`<img alt="" src=${src} />` : html`<ha-icon icon="mdi:dog"></ha-icon>`)),
          html`<ha-icon icon="mdi:dog"></ha-icon>`,
        )}
      </div>
      <div class="row">
        <ha-icon icon="mdi:rotate-3d-variant" style="color:var(--fp-accent)"></ha-icon>
        <div class="grow">
          <div class="title accent">${t('dog.design')}</div>
          <div class="subtitle">${t('dog.design_sub')}</div>
        </div>
        <ha-icon icon="mdi:chevron-right" style="color:var(--fp-label-3)"></ha-icon>
      </div>
    </button>`;
}

function petSection(ed: Ed, f: FurnitureConfig, set: (fn: (x: FurnitureConfig) => void) => void) {
  const cat = resolveFurniture(f).k?.kind === 'cat';
  const p = f.pet ?? {};
  const setPet = (fn: (x: NonNullable<FurnitureConfig['pet']>) => void) =>
    set((x) => {
      const np = { ...(x.pet ?? {}) };
      fn(np);
      for (const k of Object.keys(np)) if ((np as any)[k] === undefined) delete (np as any)[k];
      x.pet = Object.keys(np).length ? np : undefined;
    });
  const walks = [...(p.walks ?? [])].sort();
  let draft = '';
  return html`
    ${cat
      ? nothing
      : html`<div class="section-title">${t('editor.walks')}</div>
          <div class="chips">
            ${walks.map(
              (w) => html`<button class="chip pressable" aria-pressed="true" title=${t('common.delete')} @click=${() => setPet((x) => (x.walks = (x.walks ?? []).filter((y) => y !== w).length ? (x.walks ?? []).filter((y) => y !== w) : undefined))}>
                ${w}<ha-icon icon="mdi:close" style="--mdc-icon-size:14px;margin-left:4px"></ha-icon>
              </button>`,
            )}
          </div>
          <div class="group" style="margin-top:var(--fp-space-2)">
            <div class="row">
              <label class="grow time-field">
                <span class="subtitle">${t('editor.walk_add')}</span>
                <input class="field inline" type="time" @input=${(e: any) => (draft = e.target.value)} @change=${(e: any) => (draft = e.target.value)} />
              </label>
              <button class="icon-btn pressable" aria-label=${t('editor.walk_add')} @click=${() => {
                const v = normalizeTime(draft);
                if (v) setPet((x) => (x.walks = [...new Set([...(x.walks ?? []), v])].sort()));
              }}><ha-icon icon="mdi:plus"></ha-icon></button>
            </div>
          </div>
          <div class="chips">
            ${([['07:00', 'editor.walk_morning'], ['12:30', 'editor.walk_noon'], ['18:30', 'editor.walk_evening'], ['22:00', 'editor.walk_night']] as const).filter(([tm]) => !walks.includes(tm)).map(
              ([tm, l]) => html`<button class="chip pressable" @click=${() => setPet((x) => (x.walks = [...new Set([...(x.walks ?? []), tm])].sort()))}>+ ${t(l)} ${tm}</button>`,
            )}
          </div>
          <div class="hint-s">${t('editor.walks_hint')}</div>
          ${walks.length ? remindSection(ed, f, p.remind, (fn) => setPet((x) => {
            const r: WalkReminder = { ...(x.remind ?? {}) };
            fn(r);
            x.remind = Object.keys(r).some((k) => (r as any)[k] !== undefined) ? r : undefined;
          })) : nothing}`}
  `;
}

/** Cat: pose, markings, collar (inside the look fold) */
function catLook(f: FurnitureConfig, set: (fn: (x: FurnitureConfig) => void) => void) {
  const look = petLook(f);
  const p = f.pet ?? {};
  const setPet = (fn: (x: NonNullable<FurnitureConfig['pet']>) => void) =>
    set((x) => {
      const np = { ...(x.pet ?? {}) };
      fn(np);
      for (const k of Object.keys(np)) if ((np as any)[k] === undefined) delete (np as any)[k];
      x.pet = Object.keys(np).length ? np : undefined;
    });
  return html`${choiceChips(
      t('editor.pet_pose'),
      [['curled', t('editor.pose_curled')], ['lying', t('editor.pose_lying')], ['sitting', t('editor.pose_sitting')], ['standing', t('editor.pose_standing')]] as [NonNullable<typeof p.pose>, string][],
      look.pose,
      (v) => setPet((x) => (x.pose = v)),
    )}
    ${choiceChips(
      t('editor.markings'),
      [['none', t('editor.mark_none')], ['belly', t('editor.mark_belly')], ['socks', t('editor.mark_socks')], ['mask', t('editor.mark_mask')], ['patches', t('editor.mark_patches')]] as [NonNullable<typeof p.markings>, string][],
      look.markings,
      (v) => setPet((x) => (x.markings = v)),
    )}
    ${colorRow(t('editor.collar_cat'), p.collar, COLLARS, look.collar, (c) => setPet((x) => (x.collar = c)))}`;
}

/** "Sofa" or "Sofa · Ecksofa" (the variant, when it is not the kind's first) */
function kindText(k: FurnitureKind, variant: string): string {
  const v = k.variants?.find((x) => x.id === variant);
  return v && v !== k.variants?.[0] ? `${furnitureLabel(k)} · ${variantLabel(v)}` : furnitureLabel(k);
}

function furnitureInspector(ed: Ed, f: FurnitureConfig): TemplateResult {
  const set = (fn: (x: FurnitureConfig) => void) => patchItem<FurnitureConfig>(ed, 'furniture', f.id, fn);
  const r = resolveFurniture(f);
  const k = r.k;
  const pad = Math.max(f.w, f.h) * 0.1 + 6;
  return html`
    <div class="furn-head">
      <svg class="furn-big" viewBox="${-f.w / 2 - pad} ${-f.h / 2 - pad} ${f.w + pad * 2} ${f.h + pad * 2}" aria-hidden="true">${drawFurniture(f)}</svg>
      <div class="group grow">
        <button
          class="row field-row pressable kind-pick"
          @click=${() =>
            ed.openKindPicker(k?.kind, (kind, variant) =>
              set((x) => {
                const nk = FURNITURE_BY_KIND.get(kind);
                const nv = nk?.variants?.find((v) => v.id === variant) ?? nk?.variants?.[0];
                x.kind = kind;
                x.variant = variant;
                x.count = undefined;
                x.color = undefined;
                x.accent = undefined;
                x.height = undefined;
                x.elevation = undefined;
                if (nk) {
                  x.w = nv?.w ?? nk.w;
                  x.h = nv?.h ?? nk.h;
                }
              }),
            )}
        >
          <span class="subtitle">${t('editor.kind')}</span>
          <span class="grow title" style="text-align:right">${k ? kindText(k, r.variant) : f.kind}</span>
          <ha-icon icon="mdi:chevron-right" style="color:var(--fp-label-3)"></ha-icon>
        </button>
        ${textField(t('editor.name'), f.name, (v) => set((x) => (x.name = v || undefined)), k ? furnitureLabel(k) : '')}
      </div>
    </div>
    ${k?.kind === 'dog' ? dogDesignCard(ed, f, set) : nothing}
    ${k?.kind === 'stairs'
      ? stairsSection(ed, f, set)
      : html`<div class="section-title">${t('editor.link_entity')}</div>
    <div class="group">
      ${entityRow(ed, t(MAIN_LINK[k?.kind ?? ''] ?? 'editor.entity'), f.entity, LINK_FILTER[r.role ?? ''] ?? {}, (v) =>
        set((x) => {
          x.entity = v;
          if (!v) delete x.tap_action, delete x.double_tap_action, delete x.hold_action;
        }),
      )}
    </div>
    ${r.role === 'car' || r.role === 'energy' || r.role === 'mower' ? nothing : html`<div class="hint-s">${t(r.role === 'pet' ? 'editor.pet_link_hint' : r.role ? 'editor.link_hint' : 'editor.link_hint_any')}</div>`}`}
    ${r.role === 'car' || r.role === 'energy' || r.role === 'mower' ? linkSection(ed, f, set) : nothing}
    ${hrRow(ed, f.entity)}
    ${k?.kind === 'stairs' || r.role === 'pet' || r.role === 'car' || r.role === 'energy' || r.role === 'mower' ? nothing : contentsSection(ed, f, set)}
    ${r.role === 'pet' ? petSection(ed, f, set) : nothing}
    ${k?.kind === 'robot_vacuum' ? vacuumSection(ed, f, set) : nothing}
    ${isWifiPiece(f) || hasWifiContent(f) ? wifiSection(ed) : nothing}
    ${k?.kind === 'dog' ? nothing : fold(t('editor.fold_look'), html`    ${k?.variants && k.variants.length > 8
      ? html`<div class="group">
          <label class="row field-row">
            <span class="subtitle">${t('editor.variant')}</span>
            <select
              class="field inline"
              @change=${(e: Event) => {
                const v = k.variants!.find((x) => x.id === (e.target as HTMLSelectElement).value);
                if (v)
                  set((x) => {
                    x.variant = v.id;
                    if (v.w) x.w = v.w;
                    if (v.h) x.h = v.h;
                    x.height = undefined;
                  });
              }}
            >
              ${k.variants.map((v) => html`<option value=${v.id} ?selected=${r.variant === v.id}>${variantLabel(v)}</option>`)}
            </select>
          </label>
        </div>`
      : k?.variants
      ? html`<div class="section-title">${t('editor.variant')}</div>
          <div class="chips">
            ${k.variants.map(
              (v) => html`<button
                class="chip pressable"
                aria-pressed=${r.variant === v.id ? 'true' : 'false'}
                @click=${() =>
                  set((x) => {
                    x.variant = v.id;
                    if (v.w) x.w = v.w;
                    if (v.h) x.h = v.h;
                    x.height = undefined;
                  })}
              >
                ${variantLabel(v)}
              </button>`,
            )}
          </div>`
      : nothing}
    ${k?.count
      ? html`<div class="group" style="margin-top:var(--fp-space-3)">
          ${stepper(furnitureCountLabel(k), r.count, 1, (v) => set((x) => (x.count = Math.max(k.count!.min, Math.min(k.count!.max, v)))), '')}
        </div>`
      : nothing}

    <div class="section-title">${t('editor.colors')}</div>
    ${colorRow(t(k?.palette === 'fur' ? 'editor.fur' : 'editor.color_main'), f.color, FURNITURE_PALETTES[k?.palette ?? 'white'], r.color, (c) => set((x) => (x.color = c)))}
    ${k?.accent
      ? colorRow(t(k.palette === 'fur' ? 'editor.fur_marks' : 'editor.color_accent'), f.accent, FURNITURE_PALETTES[k.palette === 'fur' ? 'fur' : k.palette === 'wood' || k.palette === 'white' ? 'rug' : 'fabric'], r.accent, (c) => set((x) => (x.accent = c)))
      : nothing}
    ${k?.kind === 'cat' ? catLook(f, set) : nothing}`, { icon: 'mdi:palette-outline' })}
    ${fold(t('editor.fold_size'), html`<div class="group">
      ${stepper(t('editor.width'), f.w, 5, (v) => set((x) => (x.w = Math.max(5, v))), ' cm')}
      ${stepper(t('editor.depth'), f.h, 5, (v) => set((x) => (x.h = Math.max(5, v))), ' cm')}
      ${stepper(t('editor.height3d'), r.height, 5, (v) => set((x) => (x.height = Math.max(1, Math.min(300, v)))), ' cm')}
      ${stepper(t('editor.elevation'), r.elevation, 5, (v) => set((x) => (x.elevation = Math.max(0, Math.min(250, v)) || undefined)), ' cm')}
      ${stepper(t('editor.rotation'), f.rotation ?? 0, 15, (v) => set((x) => (x.rotation = ((v % 360) + 360) % 360 || undefined)), '°')}
    </div>
    ${k?.onTop ? html`<div class="hint-s">${t('editor.on_top_hint')}</div>` : nothing}`, { icon: 'mdi:ruler-square', sub: `${Math.round(f.w)} × ${Math.round(f.h)} cm` })}
    ${f.entity && !f.contents?.length && r.role !== 'pet' && r.role !== 'car'
      ? actions(ed, f, 'furniture', (key, v) =>
          set((x) => {
            if (v) (x as any)[key] = v;
            else delete (x as any)[key];
          }),
        )
      : nothing}
    ${r.role === 'media' ? mediaSection(ed, f.media, set, !f.entity, f.entity) : nothing}
    <div class="btn-row">
      <button class="btn pressable" @click=${() => set((x) => (x.flip = !x.flip || undefined))}><ha-icon icon="mdi:flip-horizontal"></ha-icon>${t('editor.mirror')}</button>
      <button class="btn pressable" @click=${ed.duplicateSelection}><ha-icon icon="mdi:content-copy"></ha-icon>${t('editor.duplicate')}</button>
    </div>
    <button class="btn danger block pressable gap" @click=${ed.deleteSelection}><ha-icon icon="mdi:trash-can-outline"></ha-icon>${t('common.delete')}</button>
  `;
}

/** "Geräte im Möbel": several devices inside one piece (cabinet, shelf …), each with an optional own name and icon */
function contentsSection(ed: Ed, f: FurnitureConfig, set: (fn: (x: FurnitureConfig) => void) => void): TemplateResult {
  const list = f.contents ?? [];
  const write = (x: FurnitureConfig, next: FurnitureContentConfig[]) => {
    if (next.length) x.contents = next;
    else delete x.contents;
  };
  const edit = (i: number) =>
    ed.openEntityEdit({
      title: i < 0 ? t('editor.contents_add') : t('editor.ent_edit'),
      value: i < 0 ? { entity: '' } : { entity: list[i].entity ?? '', name: list[i].name, icon: list[i].icon },
      removeLabel: t('common.delete'),
      onRemove: i < 0 ? undefined : () => set((x) => write(x, (x.contents ?? []).filter((_, j) => j !== i))),
      onSave: (m) =>
        set((x) => {
          const c: FurnitureContentConfig = { entity: m.entity, ...(m.name ? { name: m.name } : {}), ...(m.icon ? { icon: m.icon } : {}) };
          const cur = (x.contents ?? []).filter((v, j) => j !== i && v.entity !== m.entity);
          if (i < 0) cur.push(c);
          else cur.splice(Math.min(i, cur.length), 0, c);
          write(x, cur);
        }),
    });
  const move = (i: number, d: number) =>
    set((x) => {
      const cur = [...(x.contents ?? [])];
      const j = i + d;
      if (j < 0 || j >= cur.length) return;
      [cur[i], cur[j]] = [cur[j], cur[i]];
      x.contents = cur;
    });
  const arrows = (i: number) => html`<button class="icon-btn plain pressable" aria-label=${t('editor.move_up')} title=${t('editor.move_up')} ?disabled=${i === 0} @click=${() => move(i, -1)}>
      <ha-icon icon="mdi:chevron-up" style="color:var(--fp-label-3)"></ha-icon>
    </button>
    <button class="icon-btn plain pressable" aria-label=${t('editor.move_down')} title=${t('editor.move_down')} ?disabled=${i === list.length - 1} @click=${() => move(i, 1)}>
      <ha-icon icon="mdi:chevron-down" style="color:var(--fp-label-3)"></ha-icon>
    </button>`;
  // the Wi-Fi QR codes need no entity (a router Home Assistant does not know); a router / access point has them anyway
  const wifiAt = list.findIndex((c) => c && isWifiContent(c));
  const addWifi = () => set((x) => write(x, [...(x.contents ?? []), { kind: 'wifi' }]));
  return html`<div class="section-title">${t('editor.contents')}</div>
    <div class="group" data-contents>
      ${list.map((c, i) => {
        if (!c.entity)
          return isWifiContent(c)
            ? html`<div class="row" data-content="wifi">
                <span class="ic"><ha-icon .icon=${c.icon ?? 'mdi:qrcode'}></ha-icon></span>
                <div class="grow"><div class="title">${c.name || t('wifi.item')}</div><div class="subtitle">${t('wifi.item_sub_editor')}</div></div>
                ${arrows(i)}
                <button class="icon-btn plain pressable" data-remove-wifi aria-label=${t('common.delete')} title=${t('common.delete')} @click=${() => set((x) => write(x, (x.contents ?? []).filter((_, j) => j !== i)))}>
                  <ha-icon icon="mdi:close-circle" style="color:var(--fp-label-3)"></ha-icon>
                </button>
              </div>`
            : nothing;
        const s = ed.hass.states[c.entity];
        const icon = c.icon ?? stateIcon(ed.hass, s);
        return html`<div class="row" data-content=${c.entity}>
          <span class="ic">${icon ? html`<ha-icon .icon=${icon}></ha-icon>` : html`<ha-state-icon .hass=${ed.hass} .stateObj=${s}></ha-state-icon>`}</span>
          <button class="grow pick" @click=${() => edit(i)}>
            <div class="title">${c.name ?? entityName(ed.hass, c.entity, s)}</div>
            <div class="subtitle">${formatState(ed.hass, s)}</div>
          </button>
          ${arrows(i)}
        </div>`;
      })}
      <button class="row add" data-add-content @click=${() => edit(-1)}>
        <ha-icon icon="mdi:plus-circle" style="color:var(--fp-accent)"></ha-icon><span class="title accent">${t('editor.contents_add')}</span>
      </button>
      ${wifiAt < 0 && !isWifiPiece(f)
        ? html`<button class="row add" data-add-wifi @click=${addWifi}>
            <ha-icon icon="mdi:qrcode-plus" style="color:var(--fp-accent)"></ha-icon><span class="title accent">${t('editor.contents_add_wifi')}</span>
          </button>`
        : nothing}
    </div>
    <div class="hint-s">${t('editor.contents_hint')}</div>`;
}

function furnitureCountLabel(k: FurnitureKind) {
  return getLanguage() === 'en' ? k.count!.en : k.count!.de;
}

function switchRow(label: string, on: boolean, toggle: () => void, sub?: string) {
  return html`<div class="row">
    <div class="grow"><div class="title">${label}</div>${sub ? html`<div class="subtitle">${sub}</div>` : nothing}</div>
    <button class="switch" role="switch" aria-label=${label} aria-checked=${on ? 'true' : 'false'} @click=${toggle}>
      <span class="track"><span class="knob"></span></span>
    </button>
  </div>`;
}

/** TTS language: automatic (Home Assistant's language) or one the engine supports */
function ttsLanguageRow(ed: Ed, engine: string, value: string | undefined, set: (v: string) => void) {
  const langs = ed._ttsLangs?.[engine];
  if (!langs) ttsLanguages(ed.hass, engine).then((l) => (ed._ttsLangs = { ...(ed._ttsLangs ?? {}), [engine]: l }));
  const names = (() => {
    try {
      return new Intl.DisplayNames([getLanguage()], { type: 'language' });
    } catch {
      return undefined;
    }
  })();
  const label = (l: string) => {
    try {
      return `${names?.of(l.replace('_', '-')) ?? l} (${l})`;
    } catch {
      return l;
    }
  };
  const ha = ed.hass.locale?.language ?? ed.hass.language ?? 'en';
  return html`<label class="row field-row">
    <span class="subtitle">${t('editor.ea_lang')}</span>
    <select class="field inline" @change=${(e: any) => set(e.target.value)}>
      <option value="" ?selected=${!value}>${t('editor.ea_lang_auto').replace('{l}', label(ha))}</option>
      ${(langs ?? []).map((l) => html`<option value=${l} ?selected=${l === value}>${label(l)}</option>`)}
      ${value && langs && !langs.includes(value) ? html`<option value=${value} selected>${value}</option>` : nothing}
    </select>
  </label>`;
}

/** Hausregeln's window warning as it is set up there (doors that start it, windows it watches) */
interface HrWindowWarningView {
  doors: string[];
  suggested_doors?: string[];
  config?: { doors?: string[]; windows?: 'all' | string[] };
  window_entities?: string[];
  window_candidates?: string[];
}
let hrWw: HrWindowWarningView | undefined;
let hrWwLoading: Promise<void> | undefined;

function loadHrWw(ed: Ed, force = false) {
  if ((hrWw || hrWwLoading) && !force) return;
  hrWwLoading = ed.hass
    .callWS<HrWindowWarningView>({ type: 'house_rules/window_warning/get' })
    .then((v) => {
      hrWw = v;
      ed.requestUpdate();
    })
    .catch(() => undefined)
    .finally(() => (hrWwLoading = undefined));
}

async function saveHrWw(ed: Ed, config: Record<string, unknown>) {
  try {
    hrWw = await ed.hass.callWS<HrWindowWarningView>({ type: 'house_rules/window_warning/set', config });
    ed.requestUpdate();
  } catch (err) {
    ed.layer.toast(t('card.action_failed'));
    console.info('[floorplan-card] window warning not saved', err);
  }
}

/** Hausregeln runs the warning: which doors start it and which windows count, correctable right here */
function hrWarningParts(ed: Ed) {
  loadHrWw(ed);
  const v = hrWw;
  if (!v) return nothing;
  const name = (id: string) => entityName(ed.hass, id, ed.hass.states[id]);
  const suggested = !v.config?.doors?.length;
  const all = v.window_candidates ?? v.window_entities ?? [];
  const on = new Set(v.window_entities ?? []);
  return html`
    <div class="section-title">${t('editor.ea_hr_doors')}</div>
    <div class="group" data-hr-doors>
      ${v.doors.length
        ? v.doors.map(
            (id) => html`<div class="row" data-hr-door=${id}>
              <span class="ic"><ha-icon icon="mdi:door"></ha-icon></span>
              <div class="grow"><div class="title">${name(id)}</div>${suggested ? html`<div class="subtitle">${t('editor.detected')}</div>` : nothing}</div>
              ${v.doors.length > 1
                ? html`<button class="icon-btn plain pressable" aria-label=${t('editor.exclude')} title=${t('editor.exclude')} @click=${() => saveHrWw(ed, { doors: v.doors.filter((d) => d !== id) })}>
                    <ha-icon icon="mdi:eye-off-outline" style="color:var(--fp-label-3)"></ha-icon>
                  </button>`
                : nothing}
            </div>`,
          )
        : html`<div class="row"><div class="grow subtitle">${t('editor.ea_no_door')}</div></div>`}
      <button
        class="row add"
        data-hr-door-pick
        @click=${() =>
          ed.openPicker({
            title: t('editor.ea_hr_doors'),
            filter: { domains: ['binary_sensor', 'lock', 'cover'], deviceClasses: ['door', 'opening', 'garage_door', 'garage', 'gate'], noVehicles: true },
            multi: true,
            selected: suggested ? [] : v.doors,
            onPick: (ids) => saveHrWw(ed, { doors: ids }),
          })}
      >
        <ha-icon icon="mdi:pencil-circle" style="color:var(--fp-accent)"></ha-icon><span class="title accent">${t('editor.ea_hr_doors_pick')}</span>
      </button>
    </div>
    ${all.length
      ? html`<div class="section-title">${t('editor.ea_hr_windows')}</div>
          <div class="group" data-hr-windows>
            ${all.map((id) =>
              switchRow(name(id), on.has(id), () => {
                const next = on.has(id) ? all.filter((w) => on.has(w) && w !== id) : all.filter((w) => on.has(w) || w === id);
                void saveHrWw(ed, { windows: next.length === all.length ? 'all' : next });
              }),
            )}
          </div>`
      : nothing}
    <div class="hint-s">${t('editor.ea_hr_correct_hint')}</div>`;
}

/** Front door warning: blink, pop-up, remote acknowledge, announcement. With Hausregeln it is set up there only
 *  (Alarmanlage → Fenster-Warnung beim Gehen); the card keeps its own settings only for a warning it already has. */
function entryAlertSection(ed: Ed) {
  const hr = houseRules(ed.hass);
  const toHr = (label: string) =>
    html`<button class="btn tinted block pressable" ?disabled=${ed.dirty} @click=${() => { ed.close(); navigate('/hausregeln/window-warning'); }}>${label}</button>
      ${ed.dirty ? html`<div class="hint-s">${t('editor.ea_hr_save_first')}</div>` : nothing}`;
  const hrRow = (title: string, hint: string) => html`<div class="group">
    <div class="row">
      <span class="ic"><ha-icon icon="mdi:window-open-variant"></ha-icon></span>
      <div class="grow">
        <div class="title">${title}</div>
        <div class="subtitle wrap">${hint}</div>
      </div>
    </div>
  </div>`;
  // Hausregeln runs the warning (Fenster-Warnung beim Gehen): set up there, the card shows it; doors and windows can be
  // corrected right here
  if (hr.windowWarningOn) return fold(t('editor.fold_alert'), html`${hrRow(t('editor.ea_hr'), t('editor.ea_hr_hint'))} ${hrWarningParts(ed)} ${toHr(t('editor.ea_hr_open'))}`);
  const d = ed._draft;
  const ea = d.entry_alert ?? {};
  // Hausregeln is there but its warning is off: switch it on there instead of setting up a second one here
  const hrIntro = hr.available ? html`${hrRow(t('editor.ea_hr_off'), t('editor.ea_hr_off_hint'))}${toHr(t('editor.ea_hr_enable'))}` : nothing;
  if (hr.available && !ea.door) return fold(t('editor.fold_alert'), hrIntro, { icon: 'mdi:door-open', sub: t('editor.alert_off') });
  const set = (fn: (x: EntryAlertConfig) => void) =>
    ed.mutate((x) => {
      const n: EntryAlertConfig = { ...(x.entry_alert ?? {}) };
      fn(n);
      for (const k of Object.keys(n) as (keyof EntryAlertConfig)[]) if (n[k] === undefined) delete n[k];
      x.entry_alert = Object.keys(n).length ? n : undefined;
    });
  let doorName: string | undefined;
  for (const f of d.floors) for (const o of f.openings ?? []) if (o.id === ea.door) doorName = o.name ?? (o.entity ? entityName(ed.hass, o.entity, ed.hass.states[o.entity]) : t('editor.door'));
  const mode = ea.mode ?? ENTRY_DEFAULTS.mode;
  const windows = windowsOf(d);
  const allWindows = windowsOf(d, true);
  const tx = defaultTexts();
  const move = (id: string, dir: number) =>
    set((x) => {
      const ids = windowsOf({ ...d, entry_alert: x }).map((w) => w.id);
      const i = ids.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      x.order = ids;
    });
  ed.loadUsers();
  const users = ed._users ?? [];
  const MODES: [EntryAlertMode, string][] = [
    ['none', t('editor.ea_mode_none')],
    ['general', t('editor.ea_mode_general')],
    ['all', t('editor.ea_mode_all')],
    ['sequential', t('editor.ea_mode_seq')],
  ];
  return fold(
    t('editor.fold_alert'),
    html`
    ${hrIntro}
    ${hr.available ? html`<div class="section-title">${t('editor.ea_own')}</div>` : nothing}
    <div class="group">
      <div class="row">
        <div class="grow">
          <div class="subtitle">${t('editor.ea_door')}</div>
          <div class="title ${doorName ? '' : 'placeholder'}">${doorName ?? t('editor.ea_no_door')}</div>
        </div>
        ${doorName
          ? html`<button class="icon-btn plain pressable" aria-label=${t('common.delete')} @click=${() => set((x) => (x.door = undefined))}>
              <ha-icon icon="mdi:close-circle" style="color:var(--fp-label-3)"></ha-icon>
            </button>`
          : nothing}
      </div>
    </div>
    ${ea.door
      ? html`
          <div class="section-title">${t('editor.ea_windows')}</div>
          <div class="group" data-ea-windows>
            ${allWindows.length
              ? allWindows.map((w) =>
                  switchRow(w.name, !(ea.exclude ?? []).includes(w.id), () =>
                    set((x) => {
                      const ex = new Set(x.exclude ?? []);
                      if (ex.has(w.id)) ex.delete(w.id);
                      else ex.add(w.id);
                      x.exclude = ex.size ? [...ex] : undefined;
                    }),
                  ),
                )
              : html`<div class="row"><div class="grow subtitle">${t('editor.ea_no_windows')}</div></div>`}
          </div>
          <div class="hint-s">${t('editor.ea_windows_hint')}</div>
          <div class="section-title">${t('editor.ea_show')}</div>
          <div class="group">
            ${switchRow(t('editor.ea_blink'), ea.blink ?? ENTRY_DEFAULTS.blink, () => set((x) => (x.blink = !(x.blink ?? ENTRY_DEFAULTS.blink) ? undefined : false)))}
            ${(ea.flash_lights ?? []).map((id) => {
              const st = ed.hass.states[id];
              return html`<div class="row">
                <span class="ic">${stateIcon(ed.hass, st) ? html`<ha-icon .icon=${stateIcon(ed.hass, st)}></ha-icon>` : html`<ha-state-icon .hass=${ed.hass} .stateObj=${st}></ha-state-icon>`}</span>
                <div class="grow"><div class="title">${entityName(ed.hass, id, st)}</div></div>
                <button
                  class="icon-btn plain pressable"
                  aria-label=${t('common.delete')}
                  @click=${() =>
                    set((x) => {
                      const l = (x.flash_lights ?? []).filter((v) => v !== id);
                      x.flash_lights = l.length ? l : undefined;
                    })}
                >
                  <ha-icon icon="mdi:close-circle" style="color:var(--fp-label-3)"></ha-icon>
                </button>
              </div>`;
            })}
            <button
              class="row add"
              @click=${() =>
                ed.openPicker({
                  title: t('editor.ea_flash'),
                  filter: { domains: ['light'] },
                  multi: true,
                  selected: ea.flash_lights ?? [],
                  onPick: (ids) => set((x) => (x.flash_lights = ids.length ? ids : undefined)),
                })}
            >
              <ha-icon icon="mdi:plus-circle" style="color:var(--fp-accent)"></ha-icon><span class="title accent">${t('editor.ea_flash')}</span>
            </button>
            ${entityRow(ed, t('editor.ea_ack'), ea.ack_entity, { domains: ['input_button', 'button', 'event', 'binary_sensor', 'switch', 'input_boolean', 'sensor'] }, (v) => set((x) => (x.ack_entity = v)))}
          </div>
          <div class="hint-s">${t('editor.ea_flash_hint')}</div>
          <div class="section-title">${t('editor.ea_announce')}</div>
          <div class="chips">
            ${MODES.map(
              ([m, label]) => html`<button class="chip pressable" aria-pressed=${mode === m ? 'true' : 'false'} @click=${() => set((x) => (x.mode = m === ENTRY_DEFAULTS.mode ? undefined : m))}>${label}</button>`,
            )}
          </div>
          ${mode !== 'none'
            ? html`<div class="group" style="margin-top:var(--fp-space-3)">
                  ${stepper(t('editor.ea_timeout'), ea.timeout ?? ENTRY_DEFAULTS.timeout, 5, (v) => set((x) => (x.timeout = Math.max(0, Math.min(600, v)) === ENTRY_DEFAULTS.timeout ? undefined : Math.max(0, Math.min(600, v)))), ' s')}
                  ${entityRow(ed, t('editor.ea_tts'), ea.tts_entity, { domains: ['tts'] }, (v) => set((x) => (x.tts_entity = v)))}
                  ${entityRow(ed, t('editor.ea_player'), ea.media_player, { domains: ['media_player'] }, (v) => set((x) => (x.media_player = v)))}
                  ${ea.tts_entity ? ttsLanguageRow(ed, ea.tts_entity, ea.tts_language, (v) => set((x) => (x.tts_language = v || undefined))) : nothing}
                  ${mode === 'general' ? textField(t('editor.ea_text'), ea.text_general, (v) => set((x) => (x.text_general = v || undefined)), tx.general) : nothing}
                  ${mode === 'all' ? textField(t('editor.ea_text'), ea.text_all, (v) => set((x) => (x.text_all = v || undefined)), tx.all) : nothing}
                  ${mode === 'sequential' ? textField(t('editor.ea_text'), ea.text_single, (v) => set((x) => (x.text_single = v || undefined)), tx.single) : nothing}
                </div>
                <div class="hint-s">${t(mode === 'sequential' ? 'editor.ea_text_hint_seq' : 'editor.ea_text_hint')}</div>`
            : nothing}
          ${mode === 'sequential'
            ? html`<div class="section-title">${t('editor.ea_order')}</div>
                <div class="group">
                  ${windows.length
                    ? windows.map(
                        (w, i) => html`<div class="row">
                          <span class="num" style="width:22px;color:var(--fp-label-3)">${i + 1}</span>
                          <div class="grow title">${w.name}</div>
                          <button class="icon-btn pressable" aria-label="↑" ?disabled=${i === 0} @click=${() => move(w.id, -1)}><ha-icon icon="mdi:chevron-up"></ha-icon></button>
                          <button class="icon-btn pressable" aria-label="↓" ?disabled=${i === windows.length - 1} @click=${() => move(w.id, 1)}><ha-icon icon="mdi:chevron-down"></ha-icon></button>
                        </div>`,
                      )
                    : html`<div class="row"><div class="grow subtitle">${t('editor.ea_no_windows')}</div></div>`}
                </div>`
            : nothing}
          ${users.length
            ? html`<div class="section-title">${t('editor.ea_who')}</div>
                <div class="chips">
                  ${users.map((u) => {
                    const on = ea.announce_users?.includes(u.id) ?? false;
                    return html`<button
                      class="chip pressable"
                      aria-pressed=${on ? 'true' : 'false'}
                      @click=${() =>
                        set((x) => {
                          const cur = new Set(x.announce_users ?? []);
                          if (on) cur.delete(u.id);
                          else cur.add(u.id);
                          x.announce_users = cur.size ? [...cur] : undefined;
                        })}
                    >
                      ${u.name}
                    </button>`;
                  })}
                </div>
                <div class="hint-s">${t('editor.ea_who_hint')}</div>`
            : nothing}
          <div class="section-title">${t('editor.ea_server')}</div>
          <div class="group">
            ${(() => {
              const c = companionInfo();
              const running = ea.server !== false && !!c?.entry_alert.includes(serverKey(d));
              const txt = !c ? t('editor.ea_server_missing') : ea.server === false ? t('editor.ea_server_off') : running ? t('editor.ea_server_running') : t('editor.ea_server_pending');
              return html`${c ? switchRow(t('editor.ea_server_on'), ea.server !== false, () => set((x) => (x.server = x.server !== false ? false : undefined))) : nothing}
                <div class="row"><ha-icon icon=${running ? 'mdi:server-network' : 'mdi:server-off'} style=${`color:${running ? 'var(--fp-green)' : 'var(--fp-label-3)'}`}></ha-icon><div class="grow subtitle wrap">${txt}</div></div>`;
            })()}
          </div>
          <div class="hint-s">${t('editor.ea_server_hint')}</div>
        `
      : html`<div class="hint-s">${t('editor.ea_hint')}</div>`}
  `,
    { icon: 'mdi:door-open', sub: ea.door ? t('editor.alert_on') : t('editor.alert_off') },
  );
}

/** Effects level of the card or a user: full, saver (weather: sky colour only, calm 3D) or off */
type FxLevel = 'full' | 'eco' | 'off';
function fxOf(x: { effects?: string; performance?: string; weather_quality?: string; weather?: string }): FxLevel {
  if (x.effects === 'off') return 'off';
  return x.performance === 'eco' || x.weather_quality === 'saver' || x.weather === 'saver' ? 'eco' : 'full';
}

function usersSection(ed: Ed) {
  ed.loadUsers();
  const users = ed._users;
  if (!users?.length) return nothing;
  const d = ed._draft;
  const setUser = (u: { id: string; name: string }, patch: { orientation?: number | null; view_mode?: string | null; weather?: string | null; performance?: string | null; floor?: string | null }) =>
    ed.mutate((x) => {
      const all = { ...(x.users ?? {}) };
      const cur: any = { ...(all[u.id] ?? {}), name: u.name };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined || v === '') delete cur[k];
        else cur[k] = v;
      }
      if (cur.orientation === undefined && cur.view_mode === undefined && cur.weather === undefined && cur.performance === undefined && cur.floor === undefined) delete all[u.id];
      else all[u.id] = cur;
      x.users = Object.keys(all).length ? all : undefined;
    });
  const nSet = users.filter((u) => d.users?.[u.id]).length;
  return fold(
    t('editor.users'),
    html`<div class="group">
        ${users.map((u) => {
          const cfg = d.users?.[u.id];
          const fx = cfg?.weather || cfg?.performance ? fxOf({ performance: cfg.performance, weather: cfg.weather }) : '';
          return html`<div class="user-block">
            <div class="row">
              <span class="ic"><ha-icon icon="mdi:account"></ha-icon></span>
              <div class="grow"><div class="title">${u.name}</div></div>
            </div>
            <div class="user-opts">
              <label>
                <span>${t('editor.rotation')}</span>
                <select class="field mini" @change=${(e: any) => setUser(u, { orientation: e.target.value === '' ? null : Number(e.target.value) })}>
                  <option value="" ?selected=${cfg?.orientation == null}>${t('editor.standard')}</option>
                  ${[0, 45, 90, 135, 180, 225, 270, 315].map((a) => html`<option value=${a} ?selected=${cfg?.orientation === a}>${a}°</option>`)}
                </select>
              </label>
              <label>
                <span>${t('editor.view')}</span>
                <select class="field mini" @change=${(e: any) => setUser(u, { view_mode: e.target.value || null })}>
                  <option value="" ?selected=${!cfg?.view_mode || cfg.view_mode === 'auto'}>${t('editor.standard')}</option>
                  <option value="3d" ?selected=${cfg?.view_mode === '3d'}>3D</option>
                  <option value="2d" ?selected=${cfg?.view_mode === '2d'}>2D</option>
                </select>
              </label>
              <label>
                <span>${t('editor.effects')}</span>
                <select
                  class="field mini"
                  @change=${(e: any) => {
                    const v = e.target.value as FxLevel | '';
                    setUser(u, v === 'eco' ? { weather: 'saver', performance: 'eco' } : v === 'full' ? { weather: 'smooth', performance: 'high' } : { weather: null, performance: null });
                  }}
                >
                  <option value="" ?selected=${!fx}>${t('editor.standard')}</option>
                  <option value="full" ?selected=${fx === 'full'}>${t('editor.fx_full')}</option>
                  <option value="eco" ?selected=${fx === 'eco'}>${t('editor.fx_eco')}</option>
                </select>
              </label>
              ${d.floors.length > 1
                ? html`<label>
                    <span>${t('editor.floor')}</span>
                    <select class="field mini" data-user-floor=${u.id} @change=${(e: any) => setUser(u, { floor: e.target.value || null })}>
                      <option value="" ?selected=${!cfg?.floor}>${t('editor.standard')}</option>
                      ${orderedFloors(d, ed.hass).map((f) => html`<option value=${f.id} ?selected=${cfg?.floor === f.id}>${f.name}</option>`)}
                    </select>
                  </label>`
                : nothing}
            </div>
          </div>`;
        })}
      </div>
      <div class="hint-s">${t('editor.users_hint')}</div>`,
    { icon: 'mdi:account-multiple-outline', sub: nSet ? t('editor.n_set', { n: nSet }) : undefined },
  );
}

/** Stairs: which floor a tap on the card leads to (automatic: up, on the top floor down) */
function stairsSection(ed: Ed, f: FurnitureConfig, set: (fn: (x: FurnitureConfig) => void) => void) {
  const d = ed._draft;
  if (d.floors.length < 2) return nothing;
  const here = ed.floor;
  const auto = stairsTarget(d, here.id, { ...f, stairs_to: undefined }, ed.hass);
  const others = orderedFloors(d, ed.hass).filter((x) => x.id !== here.id);
  return html`<div class="section-title">${t('editor.stairs_to')}</div>
    <div class="group">
      <label class="row field-row">
        <span class="subtitle">${t('editor.stairs_to')}</span>
        <select class="field inline" data-stairs-to @change=${(e: any) => set((x) => (x.stairs_to = e.target.value || undefined))}>
          <option value="" ?selected=${!f.stairs_to}>${t('editor.first_floor_auto', { x: auto?.name ?? '' })}</option>
          ${others.map((x) => html`<option value=${x.id} ?selected=${x.id === f.stairs_to}>${x.name}</option>`)}
        </select>
      </label>
    </div>
    <div class="hint-s">${t('editor.stairs_hint')}</div>`;
}

/** A floor still carries a generated name (it may be replaced by the linked HA floor's) */
const generatedName = (f: FloorConfig) => !f.name || f.name === t('card.default_floor') || /^(Etage|Floor) \d+$/.test(f.name);

/** "Etagen": all floors (top floor first) to pick, reorder, add, delete; the shown floor's details */
function floorsSection(ed: Ed) {
  const d = ed._draft;
  const floor = ed.floor;
  const hass = ed.hass;
  const top = orderedFloors(d, hass);
  const haFloors = Object.values(hass.floors ?? {}).sort((a, b) => (b.level ?? 0) - (a.level ?? 0) || a.name.localeCompare(b.name));
  const level = floorLevel(d, floor, hass);
  const setFloor = (fn: (f: FloorConfig) => void) => ed.mutate((_x, f) => fn(f));
  const linkHa = (id: string) =>
    ed.mutate((_x, f) => {
      const ha = id ? hass.floors?.[id] : undefined;
      f.floor = id || undefined;
      if (!ha) return;
      if (generatedName(f)) f.name = ha.name;
      if (typeof ha.level === 'number') f.level = ha.level;
    });
  const multi = d.floors.length > 1;
  return fold(
    t('editor.fold_floors'),
    html`<div class="group floor-list">
        ${top.map(
          (f, i) => html`<div class="row floor-row ${f.id === floor.id ? 'cur' : ''}">
            <button class="grow pick floor-pick" data-floor-id=${f.id} @click=${() => f.id !== floor.id && ed.setFloor(f.id)}>
              <span class="floor-badge num">${floorShort(f)}</span>
              <span class="grow">
                <span class="title">${f.name}</span>
                <span class="subtitle">${t('editor.floor_rooms_n', { n: f.rooms.length })}${f.floor && hass.floors?.[f.floor] ? ` · ${hass.floors[f.floor].name}` : ''}</span>
              </span>
              ${f.id === floor.id ? html`<ha-icon class="floor-check" icon="mdi:check"></ha-icon>` : nothing}
            </button>
            ${multi
              ? html`<button class="icon-btn plain pressable" data-floor-up=${f.id} ?disabled=${i === 0} aria-label=${t('editor.floor_up')} title=${t('editor.floor_up')} @click=${() => ed.moveFloor(f.id, 1)}>
                    <ha-icon icon="mdi:chevron-up"></ha-icon>
                  </button>
                  <button class="icon-btn plain pressable" data-floor-down=${f.id} ?disabled=${i === top.length - 1} aria-label=${t('editor.floor_down')} title=${t('editor.floor_down')} @click=${() => ed.moveFloor(f.id, -1)}>
                    <ha-icon icon="mdi:chevron-down"></ha-icon>
                  </button>`
              : nothing}
          </div>`,
        )}
      </div>
      <button class="btn block pressable gap" data-add-floor @click=${ed.addFloor}><ha-icon icon="mdi:layers-plus"></ha-icon>${t('editor.add_floor')}</button>
      ${multi ? html`<div class="hint-s">${t('editor.floors_hint')}</div>` : nothing}

      <div class="section-title">${t('editor.floor_this')}: ${floor.name}</div>
      <div class="group">
        ${textField(t('editor.floor_name'), floor.name, (v) => setFloor((f) => (f.name = v || f.name)))}
        ${haFloors.length || floor.floor
          ? html`<label class="row field-row">
              <span class="subtitle">${t('editor.floor_ha')}</span>
              <select class="field inline" data-ha-floor @change=${(e: any) => linkHa(e.target.value)}>
                <option value="" ?selected=${!floor.floor}>${t('common.none')}</option>
                ${haFloors.map((h) => html`<option value=${h.floor_id} ?selected=${h.floor_id === floor.floor}>${h.name}${typeof h.level === 'number' ? ` (${h.level})` : ''}</option>`)}
                ${floor.floor && !hass.floors?.[floor.floor] ? html`<option value=${floor.floor} selected>${floor.floor}</option>` : nothing}
              </select>
            </label>`
          : nothing}
        ${stepper(t('editor.floor_level'), level, 1, (v) => setFloor((f) => (f.level = Math.max(-9, Math.min(99, Math.round(v))))))}
        ${textField(t('editor.floor_short'), floor.short, (v) => setFloor((f) => (f.short = v.trim().slice(0, 4) || undefined)), floorShort({ ...floor, short: undefined }))}
        ${stepper(t('editor.floor_height'), floor.height ?? 250, 10, (v) => setFloor((f) => (f.height = Math.max(180, Math.min(600, v)) === 250 ? undefined : Math.max(180, Math.min(600, v)))), ' cm')}
      </div>
      <div class="hint-s">${t('editor.floor_level_hint')} ${haFloors.length ? t('editor.floor_ha_hint') : ''}</div>
      ${multi
        ? html`<div class="group" style="margin-top:var(--fp-space-3)">
              ${switchRow(t('editor.floor_below'), d.floor_below !== false, () => ed.mutate((x) => (x.floor_below = x.floor_below === false ? undefined : false)), t('editor.floor_below_sub'))}
              <label class="row field-row">
                <span class="subtitle">${t('editor.default_floor')}</span>
                <select class="field inline" data-default-floor @change=${(e: any) => ed.mutate((x) => (x.default_floor = e.target.value || undefined))}>
                  <option value="" ?selected=${!d.default_floor}>${t('editor.first_floor_auto', { x: d.floors[0]?.name ?? '' })}</option>
                  ${top.map((f) => html`<option value=${f.id} ?selected=${f.id === d.default_floor}>${f.name}</option>`)}
                </select>
              </label>
            </div>
            <div class="hint-s">${t('editor.default_floor_hint')}</div>
            <button class="btn danger block pressable gap" data-delete-floor @click=${() => ed.deleteFloor(floor.id)}><ha-icon icon="mdi:layers-remove"></ha-icon>${t('editor.delete_floor')}</button>`
        : nothing}`,
    { icon: 'mdi:layers-outline', sub: multi ? t('editor.n_floors', { n: d.floors.length }) : floor.name },
  );
}

function settingsPanel(ed: Ed): TemplateResult {
  const d = ed._draft;
  const setCfg = (fn: (x: typeof d) => void) => ed.mutate((x) => fn(x));
  const weathers = Object.keys(ed.hass.states).filter((id) => id.startsWith('weather.'));
  const north = d.north ?? 0;
  const fx = fxOf(d);
  const values = d.label_style === 'wall' ? 'wall' : d.labels === 'inside' ? 'inside' : 'outside';
  return html`
    <div class="section-title">${t('editor.view')}</div>
    <fp-segmented
      .options=${[
        { value: '3d', label: t('editor.view_3d') },
        { value: '2d', label: t('editor.view_2d') },
      ]}
      .value=${d.view_mode === '2d' ? '2d' : '3d'}
      @value-change=${(e: CustomEvent) => setCfg((x) => (x.view_mode = e.detail.value === '2d' ? '2d' : undefined))}
    ></fp-segmented>
    <div class="hint-s">${t(d.view_mode === '2d' ? 'editor.view_2d_hint' : 'editor.view_3d_hint')}</div>

    <div class="section-title">${t('editor.fx_title')}</div>
    <fp-segmented
      .options=${[
        { value: 'full', label: t('editor.fx_full') },
        { value: 'eco', label: t('editor.fx_eco') },
        { value: 'off', label: t('editor.fx_off') },
      ]}
      .value=${fx}
      @value-change=${(e: CustomEvent) =>
        setCfg((x) => {
          const v = e.detail.value as FxLevel;
          x.effects = v === 'off' ? 'off' : undefined;
          x.performance = v === 'eco' ? 'eco' : undefined;
          x.weather_quality = v === 'eco' ? 'saver' : undefined;
        })}
    ></fp-segmented>
    <div class="hint-s">${t(fx === 'off' ? 'editor.fx_off_hint' : fx === 'eco' ? 'editor.fx_eco_hint' : 'editor.fx_full_hint')}</div>

    <div class="section-title">${t('editor.values_title')}</div>
    <fp-segmented
      .options=${[
        { value: 'outside', label: t('editor.values_outside') },
        { value: 'inside', label: t('editor.values_inside') },
        { value: 'wall', label: t('editor.values_wall') },
      ]}
      .value=${values}
      @value-change=${(e: CustomEvent) =>
        setCfg((x) => {
          const v = e.detail.value;
          x.label_style = v === 'wall' ? 'wall' : undefined;
          x.labels = v === 'inside' ? 'inside' : undefined;
        })}
    ></fp-segmented>
    ${values === 'wall' ? html`<div class="hint-s">${t('editor.values_wall_hint')}</div>` : nothing}
    <div class="group" style="margin-top:var(--fp-space-2)">
      ${values === 'wall'
        ? nothing
        : switchRow(t('editor.label_heating'), d.label_tap === 'heating', () => setCfg((x) => (x.label_tap = x.label_tap === 'heating' ? undefined : 'heating')), t('editor.label_heating_sub'))}
      ${switchRow(t('editor.focus_badge'), d.focus_badge !== false, () => setCfg((x) => (x.focus_badge = x.focus_badge === false ? undefined : false)), t('editor.focus_badge_sub'))}
      ${switchRow(t('editor.labels_move'), !!d.hide_labels_on_move, () => setCfg((x) => (x.hide_labels_on_move = x.hide_labels_on_move ? undefined : true)), t('editor.labels_move_sub'))}
    </div>

    <div class="section-title">${t('editor.start_view')}</div>
    <div class="group">
      <div class="row">
        <div class="compass" style=${`--rot:${north}deg`} aria-hidden="true"><span class="needle"></span><span class="n">N</span></div>
        <div class="grow"><div class="title">${t('editor.north')}</div></div>
        <button class="icon-btn pressable" aria-label="−" @click=${() => setCfg((x) => (x.north = ((((north - 5 + 180) % 360) + 360) % 360) - 180 || undefined))}><ha-icon icon="mdi:minus"></ha-icon></button>
        <span class="num step-val">${north}°</span>
        <button class="icon-btn pressable" aria-label="+" @click=${() => setCfg((x) => (x.north = ((((north + 5 + 180) % 360) + 360) % 360) - 180 || undefined))}><ha-icon icon="mdi:plus"></ha-icon></button>
      </div>
      ${stepper(t('editor.orientation_default'), d.orientation ?? 0, 15, (v) => setCfg((x) => (x.orientation = ((v % 360) + 360) % 360 || undefined)), '°')}
      ${stepper(
        t('editor.idle_reset'),
        d.idle_reset ?? 120,
        30,
        (v) => setCfg((x) => (x.idle_reset = Math.max(0, Math.min(1800, v)) === 120 ? undefined : Math.max(0, Math.min(1800, v)))),
        ' s',
      )}
    </div>
    <div class="hint-s">${t('editor.idle_hint')}</div>
    ${usersSection(ed)}

    ${fold(
      t('editor.fold_walls'),
      html`<div class="group">
          ${stepper(t('editor.wall_height'), d.wall_height ?? 90, 10, (v) => setCfg((x) => (x.wall_height = Math.max(20, Math.min(300, v)))), ' cm')}
          ${stepper(t('editor.back_wall_height'), d.back_wall_height ?? 170, 10, (v) => setCfg((x) => (x.back_wall_height = Math.max(20, Math.min(300, v)))), ' cm')}
          ${stepper(t('editor.wall_width'), d.wall_width ?? 8, 1, (v) => setCfg((x) => (x.wall_width = Math.max(2, Math.min(30, v)))), ' cm')}
        </div>
        <div class="hint-s">${t('editor.back_wall_hint')}</div>
        <div class="label-row">${t('editor.wall_color_ext')}</div>
        ${paintPicker(d.wall_color, (c) => setCfg((x) => (x.wall_color = c)))}`,
      { icon: 'mdi:wall', sub: `${d.wall_height ?? 90} cm` },
    )}
    ${floorsSection(ed)}
    ${entryAlertSection(ed)}
    ${ed._hrOn
      ? fold(
          t('hr.settings'),
          html`<div class="group">
            ${(['occupancy', 'mode', 'alarm', 'pulse'] as const).map((k) =>
              // occupancy is off by default, the others on
              switchRow(t(`hr.set_${k}` as const), k === 'occupancy' ? d.house_rules?.[k] === true : d.house_rules?.[k] !== false, () =>
                setCfg((x) => {
                  const hr = { ...(x.house_rules ?? {}) };
                  const def = k !== 'occupancy';
                  const now = hr[k] ?? def;
                  if (!now === def) delete hr[k];
                  else hr[k] = !now;
                  x.house_rules = Object.keys(hr).length ? hr : undefined;
                }),
              ),
            )}
          </div>`,
          { icon: 'mdi:home-automation' },
        )
      : nothing}
    ${shareSection(ed)}
    ${fold(
      t('plan_io.title'),
      html`<div class="group">
          <button class="row pressable" data-plan-export @click=${() => ed.exportPlan()}>
            <ha-icon icon="mdi:tray-arrow-down" style="color:var(--fp-accent)"></ha-icon>
            <div class="grow"><div class="title accent">${t('plan_io.export')}</div></div>
          </button>
          <button class="row pressable" data-plan-import @click=${() => ed.pickPlan()}>
            <ha-icon icon="mdi:tray-arrow-up" style="color:var(--fp-accent)"></ha-icon>
            <div class="grow"><div class="title accent">${t('plan_io.import')}</div></div>
          </button>
        </div>
        <div class="hint-s">${t('plan_io.hint')}</div>`,
      { icon: 'mdi:file-document-outline' },
    )}
    ${fold(
      t('editor.fold_advanced'),
      html`<div class="group">
        ${weathers.length > 1 || d.weather
          ? html`<label class="row field-row">
              <span class="subtitle">${t('editor.weather')}</span>
              <select class="field inline" @change=${(e: any) => setCfg((x) => (x.weather = e.target.value || undefined))}>
                <option value="" ?selected=${!d.weather}>${weathers[0] ? t('editor.auto_is', { x: entityName(ed.hass, weathers[0]) }) : t('editor.auto')}</option>
                ${weathers.map((w) => html`<option value=${w} ?selected=${w === d.weather}>${entityName(ed.hass, w)} (${w})</option>`)}
              </select>
            </label>`
          : nothing}
        ${stepper(t('editor.grid_size'), ed.grid, 5, (v) => setCfg((x) => (x.grid = Math.max(5, Math.min(100, v)))), ' cm')}
        ${switchRow(t('people.set'), d.people === true, () => setCfg((x) => (x.people = x.people ? undefined : true)))}
      </div>
      <div class="hint-s">${t('editor.advanced_hint')}</div>`,
      { icon: 'mdi:tune-variant' },
    )}
  `;
}

export function renderInspector(ed: Ed): TemplateResult {
  if (ed._panel === 'settings') return settingsPanel(ed);
  const sel = ed._sel;
  const it = ed.findSel(sel);
  if (!sel || !it) return html``;
  if (sel.kind === 'room') return roomInspector(ed, it as RoomConfig);
  if (sel.kind === 'device') return deviceInspector(ed, it as DeviceConfig);
  if (sel.kind === 'opening') return openingInspector(ed, it as OpeningConfig);
  return furnitureInspector(ed, it as FurnitureConfig);
}
