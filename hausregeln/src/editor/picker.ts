/**
 * Picker for one part of a sentence: first "what" (device, room, person, time …),
 * then "what about it" (the verb) with its values.
 */
import { css, html, nothing, type TemplateResult } from 'lit';
import { mdiArrowLeft, mdiCheck, mdiClose, mdiMagnify } from '@mdi/js';
import { StoreElement } from '../base';
import type { Clause, LightAction, Rule, RuleType } from '../model';
import './light-action';
import { subjectInfo, type Section } from '../describe';
import { icon, shared } from '../design/shared';
import { durToSec, durationStepper, secToDur } from '../components/duration';
import { KINDS, MODES, domainKind, formatDuration, formatOffset, verbsFor, type ParamSpec, type Verb, type VerbFlavour } from '../vocabulary';
import { compare, t, tn, type I18nKey } from '../i18n';
// i18n: complete

export function flavourFor(section: Section, type: RuleType): VerbFlavour {
  if (section === 'then' || section === 'else') return 'action';
  if (section === 'when') return type === 'while' ? 'state' : 'event';
  return 'state';
}

/** the picker's title per part of the sentence: t(`rules.title_${section}_${flavour}`) */
const TITLES = new Set(['else-action', 'when-event', 'when-state', 'and-state', 'only-state', 'then-action']);

interface Cand {
  subject: string;
  label: string;
  sub?: string;
  icon: string;
  group: string;
}

type Tab = 'quick' | 'rooms' | 'groups' | 'devices' | 'people' | 'time' | 'rules' | 'all';

const DURATIONS = ['30s', '1m', '3m', '5m', '10m', '15m', '30m', '1h'];
/** triggers that may also take "… und das seit …" (it fires once the new state held that long) */
const FOR_EVENT_KINDS = new Set(['light', 'switch', 'outlet', 'fan', 'purifier', 'window', 'door', 'motion', 'zone', 'presence', 'room', 'temperature', 'illuminance', 'sensor', 'number', 'input_number', 'binary_sensor', 'input_boolean', 'media', 'person', 'device_tracker', 'cover', 'climate', 'select', 'input_select', 'leak', 'vacuum']);
/** stored values (German, the integration knows them) → their label key */
const COLORS: [string, I18nKey][] = [
  ['warmweiß', 'rules.color_warm'], // i18n-ignore (stored value)
  ['neutralweiß', 'rules.color_neutral'], // i18n-ignore
  ['kaltweiß', 'rules.color_cold'], // i18n-ignore
  ['rot', 'rules.color_red'],
  ['orange', 'rules.color_orange'],
  ['grün', 'rules.color_green'], // i18n-ignore
  ['blau', 'rules.color_blue'],
  ['lila', 'rules.color_purple'],
];

export class HrPicker extends StoreElement {
  static override properties = {
    ...StoreElement.properties,
    section: {},
    rule: { attribute: false },
    clause: { attribute: false },
    step: {},
    _tab: { attribute: false },
    _q: { state: true },
    _draft: { state: true },
    heading: {},
  };
  /** own title instead of the one for the part of the rule */
  declare heading: string | undefined;
  declare section: Section;
  declare rule: Rule;
  declare clause: Clause | undefined;
  declare step: 'subject' | 'verb';
  declare _tab: Tab;
  declare _q: string;
  declare _draft: Clause;

  constructor() {
    super();
    this._tab = 'quick';
    this._q = '';
    this.step = 'subject';
  }

  protected override willUpdate(changed: Map<string, unknown>): void {
    super.willUpdate(changed);
    // also for a new part: no clause yet (undefined does not count as a change)
    if (changed.has('clause') || !this._draft) this._draft = this.clause ? { ...this.clause } : { subject: '', verb: '' };
  }

  private get flavour(): VerbFlavour {
    return flavourFor(this.section, this.rule.type);
  }

  static override styles = [
    shared,
    css`
      .body > *,
      .list > * {
        flex-shrink: 0;
      }
      :host {
        display: flex;
        flex-direction: column;
        min-height: 0;
        flex: 1;
      }
      header {
        display: flex;
        align-items: center;
        gap: var(--hr-space-2);
        padding: var(--hr-space-3) var(--hr-space-3) var(--hr-space-2) var(--hr-space-5);
      }
      header h2 {
        flex: 1;
      }
      .tools {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-3);
        padding: 0 var(--hr-space-5) var(--hr-space-3);
      }
      .search {
        display: flex;
        align-items: center;
        gap: var(--hr-space-2);
        background: var(--hr-fill);
        border-radius: var(--hr-radius-s);
        padding: 0 var(--hr-space-3);
        color: var(--hr-label-2);
      }
      .search input {
        flex: 1;
        border: 0;
        background: none;
        outline: none;
        min-height: 40px;
        font-size: var(--hr-text-body);
        color: var(--hr-label);
      }
      .list {
        overflow-y: auto;
        padding: 0 var(--hr-space-5) var(--hr-space-6);
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-4);
        min-height: 300px;
      }
      .list h3 {
        font-size: var(--hr-text-footnote);
        font-weight: 600;
        color: var(--hr-label-2);
        margin: 0 0 6px var(--hr-space-2);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .cand .ic-wrap {
        width: 34px;
        height: 34px;
        border-radius: 10px;
        display: grid;
        place-items: center;
        background: color-mix(in srgb, var(--tone) var(--hr-tint), transparent);
        color: var(--tone);
        flex: none;
      }
      .row.sel {
        background: color-mix(in srgb, var(--tone) 8%, var(--hr-surface));
      }
      .row .check {
        color: var(--tone);
      }
      .subject-head {
        display: flex;
        align-items: center;
        gap: var(--hr-space-3);
        padding: var(--hr-space-3) var(--hr-space-4);
      }
      .verb .title {
        font-family: var(--hr-font-sentence);
        font-weight: 500;
      }
      .params {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-4);
        padding: var(--hr-space-4);
      }
      .param {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-2);
      }
      .param > label {
        font-size: var(--hr-text-footnote);
        font-weight: 600;
        color: var(--hr-label-2);
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .chips button {
        min-height: 36px;
        padding: 0 14px;
        border-radius: var(--hr-radius-full);
        background: var(--hr-fill);
        font-size: var(--hr-text-footnote);
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .chips button[aria-pressed='true'] {
        background: var(--tone);
        color: #fff;
      }
      .exact {
        display: flex;
        align-items: center;
        gap: var(--hr-space-3);
        margin-top: var(--hr-space-2);
        color: var(--hr-label-2);
        font-size: var(--hr-text-footnote);
      }
      .stepper {
        display: flex;
        align-items: center;
        gap: var(--hr-space-3);
      }
      .stepper output {
        min-width: 88px;
        text-align: center;
        font-size: var(--hr-text-title3);
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .stepper button {
        width: 44px;
        height: 44px;
        border-radius: 50%;
        background: var(--hr-fill);
        font-size: 22px;
        font-weight: 500;
      }
      input[type='range'] {
        width: 100%;
        accent-color: var(--tone);
      }
      input[type='time'],
      textarea {
        border: 0;
        border-radius: var(--hr-radius-s);
        background: var(--hr-fill);
        padding: 10px 12px;
        font-size: var(--hr-text-body);
      }
      textarea {
        min-height: 72px;
        resize: vertical;
        font-family: var(--hr-font-sentence);
      }
      footer {
        padding: var(--hr-space-3) var(--hr-space-5) var(--hr-space-4);
        display: flex;
        justify-content: flex-end;
        border-top: 0.5px solid var(--hr-separator);
        background: var(--hr-bg);
      }
      .empty {
        color: var(--hr-label-2);
        padding: var(--hr-space-6);
        text-align: center;
      }
      .warn {
        color: var(--hr-red);
        font-size: var(--hr-text-footnote);
      }
    `,
  ];

  private _close() {
    this.dispatchEvent(new CustomEvent('close'));
  }

  private _hasVerbs(kind: string) {
    return verbsFor(kind, this.flavour).length > 0;
  }

  /** Everything one can pick here, grouped by tab. */
  private _candidates(): Record<Tab, Cand[]> {
    const s = this.store;
    const out: Record<Tab, Cand[]> = { quick: [], rooms: [], groups: [], devices: [], people: [], time: [], rules: [], all: [] };
    const add = (tab: Tab, subject: string, group: string, sub?: string) => {
      const info = subjectInfo(s, subject);
      if (!this._hasVerbs(info.kind)) return;
      out[tab].push({ subject, label: info.label.replace(/^./, (c) => c.toUpperCase()), sub, icon: info.icon, group });
    };
    const action = this.flavour === 'action';
    const usesPlaceholder = this.rule.when.some((c) => /^(any|all):/.test(c.subject));

    // quick
    if (action) {
      add('quick', 'notify:everyone', t('rules.grp_common'), t('rules.sub_notify'));
      add('quick', 'wait', t('rules.grp_common'), t('rules.sub_wait'));
      add('quick', 'all:light', t('rules.grp_common'));
      if (usesPlaceholder) {
        add('quick', 'all:light@same', t('rules.grp_same_room'), t('rules.sub_same_room'));
        add('quick', 'all:climate@same', t('rules.grp_same_room'), t('rules.sub_same_room'));
      }
      add('quick', 'mode', t('rules.grp_common'), t('rules.sub_mode'));
    } else {
      add('quick', 'any:window', t('rules.grp_placeholder'), t('rules.sub_any_window'));
      add('quick', 'any:door', t('rules.grp_placeholder'), t('rules.sub_any_door'));
      add('quick', 'person:someone', t('rules.grp_placeholder'), t('rules.sub_someone'));
      add('quick', 'person:everyone', t('rules.grp_placeholder'), t('rules.sub_everyone'));
      add('quick', 'any:leak', t('rules.grp_placeholder'));
      add('quick', 'time', t('rules.grp_time'));
      add('quick', 'sun', t('rules.grp_time'));
      add('quick', 'mode', t('rules.grp_time'));
    }

    // rooms
    for (const r of s.rooms) {
      if (!action) add('rooms', `room:${r.id}`, r.name, t('rules.sub_room'));
      for (const z of r.zones) add('rooms', `zone:${z}`, r.name, t('rules.sub_zone'));
      const kinds = new Set(s.devices.filter((d) => d.room === r.id).map((d) => d.kind));
      for (const k of ['window', 'door', 'light', 'climate', 'media'])
        if (kinds.has(k)) add('rooms', `${action || k === 'light' || k === 'climate' ? 'all' : 'any'}:${k}@${r.id}`, r.name);
      for (const d of s.devices.filter((d) => d.room === r.id && d.kind !== 'zone')) add('rooms', d.entity_id, r.name, d.detail);
    }

    // devices by kind
    for (const d of [...s.devices].sort((a, b) => compare(a.name, b.name)))
      if (d.kind !== 'zone') add('devices', d.entity_id, KINDS[d.kind]?.plural ?? t('rules.grp_other'), s.room(d.room)?.name);
    out.devices.sort((a, b) => compare(a.group, b.group));

    // people
    if (action) {
      add('people', 'notify:everyone', t('rules.grp_message_to'), t('rules.sub_all_phones'));
      for (const p of s.persons) add('people', `notify:${p.id}`, t('rules.grp_message_to'), p.phone);
    } else {
      add('people', 'person:someone', t('rules.grp_groups'));
      add('people', 'person:everyone', t('rules.grp_groups'));
      for (const p of s.persons) add('people', `person:${p.id}`, t('rules.grp_persons'), p.where);
    }

    // time
    for (const k of ['time', 'sun', 'mode', 'wait']) add('time', k, t('rules.grp_time_mode'));
    if (s.alarm?.config.enabled) add('time', 'alarm', t('rules.grp_security'), t('rules.sub_alarm'));

    // own groups ("Gruppen")
    for (const g of s.groups) add('groups', `group:${g.id}`, t('rules.grp_own_groups'), tn('rules.devices_count', g.members.length));

    // rules
    for (const r of s.rules) if (r.id !== this.rule.id) add('rules', `rule:${r.id}`, t('tab.rules'));

    // every other entity of Home Assistant, by domain
    const known = new Set(s.devices.map((d) => d.entity_id));
    for (const e of s.allEntities().sort((a, b) => compare(a.name, b.name))) {
      if (known.has(e.entity_id)) continue;
      const kind = domainKind(e.entity_id);
      if (!this._hasVerbs(kind)) continue;
      out.all.push({ subject: e.entity_id, label: e.name, sub: `${e.entity_id}${e.state && !/^\d{4}-/.test(e.state) ? ` · ${e.state}` : ''}`, icon: KINDS[kind].icon, group: KINDS[kind].plural });
    }
    out.all.sort((a, b) => a.group.localeCompare(b.group, 'de'));
    return out;
  }

  private _pickSubject(subject: string) {
    const info = subjectInfo(this.store, subject);
    const verbs = verbsFor(info.kind, this.flavour);
    const keep = verbs.find((v) => v.id === this._draft.verb);
    const verb = keep ?? verbs[0];
    this._draft = { subject, verb: verb?.id ?? '', ...this._defaults(verb) };
    if (verbs.length === 1 && !verb?.params?.length && this.flavour === 'event') return this._done();
    this.step = 'verb';
  }

  private _defaults(verb?: Verb): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const p of verb?.params ?? []) if (this._draft[p.key] == null) out[p.key] = p.default;
    return out;
  }

  private _pickVerb(v: Verb) {
    const keep: Clause = { subject: this._draft.subject, verb: v.id };
    if (this._draft.for && !v.params?.some((p) => p.key === 'for')) keep.for = this._draft.for;
    for (const p of v.params ?? []) keep[p.key] = this._draft[p.key] ?? p.default;
    this._draft = keep;
  }

  private _done() {
    this.dispatchEvent(new CustomEvent('pick', { detail: { ...this._draft } }));
  }

  private _set(key: string, value: unknown) {
    const d = { ...this._draft };
    if (value === undefined || value === '') delete d[key];
    else d[key] = value;
    this._draft = d;
  }

  /** quick choices plus a − / + down to seconds; `none` = label of the "no time" choice */
  private _duration(value: unknown, set: (d: string | undefined) => void, none?: string): TemplateResult {
    const sec = durToSec(value);
    return html`<div class="chips">
        ${none ? html`<button aria-pressed=${!sec ? 'true' : 'false'} @click=${() => set(undefined)}>${none}</button>` : nothing}
        ${DURATIONS.map((d) => html`<button aria-pressed=${sec && sec === durToSec(d) ? 'true' : 'false'} @click=${() => set(d)}>${formatDuration(d)}</button>`)}
      </div>
      <div class="exact"><span>${t('rules.exact')}</span>${durationStepper(sec / 60, (m) => set(secToDur(m * 60) || undefined), 0, 1440)}</div>`;
  }

  /** the lamps a step is for: one light, or all/any lights (of a room) */
  private _lightsOf(subject: string): string[] {
    if (subject.startsWith('light.')) return [subject];
    const m = /^(?:all|any):light(?:@(.+))?$/.exec(subject);
    if (!m) return [];
    return this.store.devices.filter((d) => d.kind === 'light' && (!m[1] || m[1] === 'same' || d.room === m[1])).map((d) => d.entity_id);
  }

  private _param(p: ParamSpec): TemplateResult {
    const v = this._draft[p.key] ?? p.default;
    switch (p.type) {
      case 'light':
        return html`<hr-light-action .store=${this.store} .value=${v as LightAction} .lights=${this._lightsOf(this._draft.subject)} scenes @change=${(e: CustomEvent<LightAction>) => this._set(p.key, e.detail)}></hr-light-action>`;
      case 'days': {
        const days = String(v ?? '').split(',').filter(Boolean);
        const all = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
        const toggle = (d: string) => this._set(p.key, all.filter((x) => (x === d ? !days.includes(d) : days.includes(x))).join(','));
        return html`<div class="chips">${all.map((d) => html`<button aria-pressed=${days.includes(d) ? 'true' : 'false'} @click=${() => toggle(d)}>${t(`logic.day_${d}` as I18nKey)}</button>`)}</div>`;
      }
      case 'duration':
        return this._duration(v, (d) => this._set(p.key, d ?? p.default));
      case 'percent':
        return html`<div class="stepper">
          <input
            type="range"
            min=${p.min ?? 0}
            max=${p.max ?? 100}
            step=${p.step ?? 1}
            .value=${String(v)}
            @input=${(e: Event) => this._set(p.key, Number((e.target as HTMLInputElement).value))}
            aria-label=${p.label}
          />
          <output>${v} %</output>
        </div>`;
      case 'temperature':
      case 'number': {
        const step = p.step ?? 1;
        const n = Number(v);
        const clamp = (x: number) => Math.min(p.max ?? 1e9, Math.max(p.min ?? -1e9, Math.round(x / step) * step));
        return html`<div class="stepper">
          <button aria-label=${t('rules.less')} @click=${() => this._set(p.key, clamp(n - step))}>−</button>
          <output>${String(n).replace('.', ',')} ${p.unit ?? ''}</output>
          <button aria-label=${t('rules.more')} @click=${() => this._set(p.key, clamp(n + step))}>+</button>
        </div>`;
      }
      case 'time':
        return html`<input type="time" .value=${String(v)} @change=${(e: Event) => this._set(p.key, (e.target as HTMLInputElement).value)} aria-label=${p.label} />`;
      case 'text':
        return html`<textarea
          .value=${String(v ?? '')}
          placeholder=${t('rules.message_placeholder')}
          @input=${(e: Event) => this._set(p.key, (e.target as HTMLTextAreaElement).value)}
          aria-label=${p.label}
        ></textarea>`;
      case 'offset':
        return html`<div class="chips">
          ${['-30m', '-15m', '0m', '15m', '30m'].map(
            (d) => html`<button aria-pressed=${v === d ? 'true' : 'false'} @click=${() => this._set(p.key, d)}>
              ${d === '0m' ? t('rules.offset_exact') : formatOffset(d)}
            </button>`,
          )}
        </div>`;
      case 'mode':
        return html`<div class="chips">
          ${Object.entries(MODES).map(([id, m]) => html`<button aria-pressed=${v === id ? 'true' : 'false'} @click=${() => this._set(p.key, id)}>${m.label}</button>`)}
        </div>`;
      case 'zone':
        return html`<div class="chips">
          ${this.store.placeChoices().map((z) => html`<button aria-pressed=${v === z.id ? 'true' : 'false'} title=${z.learned ? 'Gelernter Ort' : ''} @click=${() => this._set(p.key, z.id)}>${z.name}</button>`)}
        </div>`;
      case 'color':
        return html`<div class="chips">
          ${COLORS.map(([c, key]) => html`<button aria-pressed=${v === c ? 'true' : 'false'} @click=${() => this._set(p.key, c)}>${t(key)}</button>`)}
        </div>`;
    }
  }

  private _renderSubject() {
    const all = this._candidates();
    const q = this._q.trim().toLowerCase();
    const tabs: [Tab, string][] = (
      [
        ['quick', t('rules.tab_quick')],
        ['rooms', t('tab.rooms')],
        ['devices', t('tab.devices')],
        ['people', this.flavour === 'action' ? t('rules.tab_message') : t('rules.grp_persons')],
        ['time', t('rules.grp_time')],
        ['groups', t('rules.tab_groups')],
        ['rules', t('tab.rules')],
        ['all', t('rules.tab_all')],
      ] as [Tab, string][]
    ).filter(([t]) => all[t].length);
    const tab = tabs.some(([id]) => id === this._tab) ? this._tab : tabs[0]?.[0];
    const words = q.split(/\s+/).filter(Boolean);
    let list = q
      ? Object.values(all)
          .flat()
          .filter((c, i, arr) => {
            const hay = `${c.label} ${c.sub ?? ''} ${c.group} ${c.subject}`.toLowerCase();
            return words.every((w) => hay.includes(w)) && arr.findIndex((x) => x.subject === c.subject) === i;
          })
          .slice(0, 300)
      : (all[tab] ?? []).slice(0, tab === 'all' ? 400 : undefined);
    if (q) list = list.map((c) => ({ ...c, group: t('rules.hits') }));
    const groups = [...new Set(list.map((c) => c.group))];
    return html`
      <div class="tools">
        <label class="search">${icon(mdiMagnify, 18)}<input
            id="picker-search"
            placeholder=${t('rules.search_placeholder')}
            .value=${this._q}
            @input=${(e: Event) => (this._q = (e.target as HTMLInputElement).value)}
        /></label>
        ${q ? nothing : html`<div class="seg" role="tablist">
              ${tabs.map(([id, label]) => html`<button role="tab" aria-pressed=${id === tab ? 'true' : 'false'} @click=${() => (this._tab = id)}>${label}</button>`)}
            </div>`}
      </div>
      <div class="list">
        ${groups.length
          ? groups.map(
              (g) => html`<div>
                <h3>${g}</h3>
                <div class="group">
                  ${list
                    .filter((c) => c.group === g)
                    .map(
                      (c) => html`<button class="row cand ${c.subject === this._draft.subject ? 'sel' : ''}" @click=${() => this._pickSubject(c.subject)}>
                        <span class="ic-wrap">${icon(c.icon, 20)}</span>
                        <span class="grow"><div class="title">${c.label}</div>${c.sub ? html`<div class="sub">${c.sub}</div>` : nothing}</span>
                        ${c.subject === this._draft.subject ? html`<span class="check">${icon(mdiCheck, 20)}</span>` : nothing}
                      </button>`,
                    )}
                </div>
              </div>`,
            )
          : html`<div class="empty">${t('rules.nothing_found')}</div>`}
      </div>
    `;
  }

  private _renderVerb() {
    const info = subjectInfo(this.store, this._draft.subject);
    const verbs = verbsFor(info.kind, this.flavour);
    const sel = verbs.find((v) => v.id === this._draft.verb);
    const ownFor = !!sel?.params?.some((p) => p.key === 'for');
    const showFor =
      this.flavour === 'action'
        ? info.kind !== 'wait' && !ownFor
        : this.flavour === 'state'
          ? !ownFor
          : !ownFor && !!sel && FOR_EVENT_KINDS.has(info.kind) && !['changes', 'pressed', 'activated', 'ran'].includes(sel.id);
    const label = (v: Verb) => (info.plural && v.pl ? v.pl : v.label).replace(/\{(\w+)\}/g, '…');
    return html`
      <div class="list">
        <div class="group">
          <button class="row subject-head" @click=${() => (this.step = 'subject')}>
            <span class="cand"><span class="ic-wrap">${icon(info.icon, 20)}</span></span>
            <span class="grow"><div class="title">${info.label.replace(/^./, (c) => c.toUpperCase())}</div><div class="sub">${t('rules.tap_to_change')}</div></span>
          </button>
        </div>
        <div>
          <h3>${this.flavour === 'action' ? t('rules.verb_action') : this.flavour === 'event' ? t('rules.verb_event') : t('rules.verb_state')}</h3>
          <div class="group">
            ${verbs.map(
              (v) => html`<button class="row verb ${v.id === this._draft.verb ? 'sel' : ''}" @click=${() => this._pickVerb(v)}>
                <span class="grow"><div class="title">${label(v)}</div>${v.hint ? html`<div class="sub">${v.hint}</div>` : nothing}</span>
                ${v.id === this._draft.verb ? html`<span class="check">${icon(mdiCheck, 20)}</span>` : nothing}
              </button>`,
            )}
          </div>
        </div>
        ${sel?.params?.length || showFor
          ? html`<div class="group params">
              ${sel?.params?.map((p) => html`<div class="param"><label>${p.label}</label>${this._param(p)}</div>`)}
              ${showFor
                ? html`<div class="param">
                    <label>${this.flavour === 'action' ? t('rules.for_action') : this.flavour === 'event' ? t('rules.for_event') : t('rules.for_state')}</label>
                    ${this._duration(this._draft.for, (d) => this._set('for', d), this.flavour === 'action' ? t('rules.for_permanent') : t('rules.for_now'))}
                  </div>`
                : nothing}
            </div>`
          : nothing}
        ${sel?.sensitive ? html`<p class="warn">${t('rules.sensitive_warn')}</p>` : nothing}
      </div>
      <footer><button class="btn primary" ?disabled=${!sel} @click=${this._done}>${icon(mdiCheck, 18)}${t('common.apply')}</button></footer>
    `;
  }

  override render() {
    const tone = this.section === 'when' ? (this.rule.type === 'while' ? 'tone-while' : 'tone-when') : this.section === 'else' ? 'tone-then' : `tone-${this.section}`;
    return html`<div class=${tone} style="display:contents">
      <header>
        ${this.step === 'verb'
          ? html`<button class="icon-btn" aria-label=${t('common.back')} @click=${() => (this.step = 'subject')}>${icon(mdiArrowLeft, 22)}</button>`
          : nothing}
        <h2>${this.heading ?? (TITLES.has(`${this.section}-${this.flavour}`) ? t(`rules.title_${this.section}_${this.flavour}` as I18nKey) : t('rules.pick'))}</h2>
        <button class="icon-btn" aria-label=${t('common.close')} @click=${this._close}>${icon(mdiClose, 22)}</button>
      </header>
      ${this.step === 'subject' ? this._renderSubject() : this._renderVerb()}
    </div>`;
  }
}
customElements.define('hr-picker', HrPicker);
