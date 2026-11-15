/**
 * <hr-logic>: one block of the advanced logic ("Erweitert", logic.py) as a box: an and/or/not group of conditions,
 * or a step block (if/else, choose by trigger, repeat, at the same time, wait until, wait for, remember a value,
 * stop). Nested lists are <hr-conditions> again (with blocks of their own), so it nests like a Node-RED flow.
 * Fires "change" with detail = the new clause, or null to remove it.
 */
// i18n: complete
import { css, html, nothing, type TemplateResult } from 'lit';
import { mdiClose } from '@mdi/js';
import { StoreElement } from '../base';
import type { Clause } from '../model';
import { icon, shared } from '../design/shared';
import { t } from '../i18n';
import { formatDuration } from '../vocabulary';
import { BLOCK_LABEL, GROUP_VERBS, type GroupVerb } from './logic-blocks';
import '../components/conditions';

const TIMEOUTS = ['', '30s', '1m', '5m', '10m', '30m', '1h'];

export class HrLogic extends StoreElement {
  static override properties = {
    ...StoreElement.properties,
    clause: { attribute: false },
    triggerIds: { attribute: false },
  };
  declare clause: Clause;
  /** the rule's trigger ids (for "choose") */
  declare triggerIds: string[];

  constructor() {
    super();
    this.triggerIds = [];
  }

  static override styles = [
    shared,
    css`
      :host {
        display: block;
      }
      .block {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-2);
        padding: var(--hr-space-2) var(--hr-space-3) var(--hr-space-3);
        border-radius: var(--hr-radius-m);
        border-left: 3px solid var(--tone, var(--hr-accent));
        background: color-mix(in srgb, var(--tone, var(--hr-accent)) 6%, var(--hr-surface));
      }
      .head {
        display: flex;
        align-items: center;
        gap: var(--hr-space-2);
        font-weight: 700;
      }
      .head .grow {
        flex: 1;
      }
      .part {
        font-size: var(--hr-text-footnote);
        font-weight: 700;
        color: var(--tone, var(--hr-accent));
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }
      .case {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-2);
        padding: var(--hr-space-2);
        border-radius: var(--hr-radius-s, 8px);
        background: var(--hr-bg);
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .chips button {
        min-height: 32px;
        padding: 0 12px;
        border-radius: var(--hr-radius-full);
        background: var(--hr-fill);
        font-size: var(--hr-text-footnote);
      }
      .chips button[aria-pressed='true'] {
        background: var(--tone, var(--hr-accent));
        color: #fff;
      }
      .note {
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
      }
      input,
      select {
        min-height: 36px;
        padding: 0 8px;
        border-radius: var(--hr-radius-s, 8px);
        border: 1px solid color-mix(in srgb, var(--hr-label) 20%, transparent);
        background: var(--hr-bg);
        color: var(--hr-label);
        font: inherit;
      }
      input.num {
        width: 5.5em;
      }
      .fields {
        display: flex;
        flex-wrap: wrap;
        gap: var(--hr-space-2);
        align-items: center;
      }
      .rm {
        width: 34px;
        height: 34px;
        color: var(--hr-label-3);
      }
    `,
  ];

  private _emit(c: Clause | null) {
    this.dispatchEvent(new CustomEvent('change', { detail: c }));
  }

  private _up(patch: Partial<Clause>) {
    this._emit({ ...this.clause, ...patch });
  }

  /** a nested list: conditions ("and"), steps ("then") or triggers ("when") */
  private _list(key: string, section: 'and' | 'then' | 'when', list: Clause[] | undefined, set?: (v: Clause[]) => void, joiner: 'and' | 'or' = 'and'): TemplateResult {
    return html`<hr-conditions
      .store=${this.store}
      .clauses=${list ?? []}
      section=${section}
      joiner=${joiner}
      advanced
      .triggerIds=${this.triggerIds}
      @change=${(e: CustomEvent<Clause[]>) => {
        e.stopPropagation();
        if (set) set(e.detail);
        else this._up({ [key]: e.detail });
      }}
    ></hr-conditions>`;
  }

  private _timeout(c: Clause) {
    return html`<span class="part">${t('logic.timeout')}</span>
      <div class="chips">
        ${TIMEOUTS.map((d) => html`<button aria-pressed=${(c.timeout ?? '') === d ? 'true' : 'false'} @click=${() => this._up({ timeout: d })}>${d ? formatDuration(d) : t('logic.no_timeout')}</button>`)}
      </div>
      ${c.timeout
        ? html`<div class="chips">
            <button aria-pressed=${c.continue !== false ? 'true' : 'false'} @click=${() => this._up({ continue: true })}>${t('logic.timeout_go_on')}</button>
            <button aria-pressed=${c.continue === false ? 'true' : 'false'} @click=${() => this._up({ continue: false })}>${t('logic.timeout_stop')}</button>
          </div>`
        : nothing}`;
  }

  private _body(c: Clause): TemplateResult {
    const verb = c.verb;
    switch (verb) {
      case 'all':
      case 'any':
      case 'not':
        return html`<div class="chips">
            ${GROUP_VERBS.map((g: GroupVerb) => html`<button aria-pressed=${verb === g ? 'true' : 'false'} @click=${() => this._up({ verb: g })}>${t(BLOCK_LABEL[g])}</button>`)}
          </div>
          <p class="note">${t(`logic.${verb}_hint`)}</p>
          ${this._list('items', 'and', c.items as Clause[], undefined, verb === 'all' ? 'and' : 'or')}`;
      case 'if':
        return html`<span class="part">${t('logic.part_if')}</span>${this._list('if', 'and', c.if as Clause[])}
          <span class="part">${t('logic.part_then')}</span>${this._list('then', 'then', c.then as Clause[])}
          <span class="part">${t('logic.part_else')}</span>${this._list('else', 'then', c.else as Clause[])}`;
      case 'choose': {
        const cases = (c.cases as { trigger: string[]; when: Clause[]; then: Clause[] }[]) ?? [];
        const setCase = (i: number, patch: Partial<(typeof cases)[number]> | null) =>
          this._up({ cases: patch ? cases.map((x, j) => (j === i ? { ...x, ...patch } : x)) : cases.filter((_x, j) => j !== i) });
        return html`<p class="note">${t('logic.choose_hint')}</p>
          ${cases.map(
            (x, i) => html`<div class="case">
              <div class="head"><span class="part grow">${t('logic.case_n', { n: i + 1 })}</span><button class="icon-btn rm" aria-label=${t('common.remove')} @click=${() => setCase(i, null)}>${icon(mdiClose, 16)}</button></div>
              ${this.triggerIds.length
                ? html`<span class="note">${t('logic.case_triggers')}</span>
                    <div class="chips">
                      ${this.triggerIds.map((id) => html`<button aria-pressed=${x.trigger.includes(id) ? 'true' : 'false'} @click=${() => setCase(i, { trigger: x.trigger.includes(id) ? x.trigger.filter((y) => y !== id) : [...x.trigger, id] })}>${id}</button>`)}
                    </div>`
                : html`<span class="note">${t('logic.no_trigger_ids')}</span>`}
              <span class="part">${t('logic.part_if')}</span>${this._list('', 'and', x.when, (v) => setCase(i, { when: v }))}
              <span class="part">${t('logic.part_then')}</span>${this._list('', 'then', x.then, (v) => setCase(i, { then: v }))}
            </div>`,
          )}
          <div class="chips"><button @click=${() => this._up({ cases: [...cases, { trigger: [], when: [], then: [] }] })}>${t('logic.add_case')}</button></div>
          <span class="part">${t('logic.part_else')}</span>${this._list('else', 'then', c.else as Clause[])}`;
      }
      case 'repeat': {
        const how = 'while' in c ? 'while' : 'until' in c ? 'until' : 'count';
        const to = (h: string) => {
          const { count: _c, while: _w, until: _u, ...rest } = c;
          this._emit({ ...rest, ...(h === 'count' ? { count: 3 } : { [h]: [] }) } as Clause);
        };
        return html`<div class="chips">
            ${(['count', 'while', 'until'] as const).map((h) => html`<button aria-pressed=${how === h ? 'true' : 'false'} @click=${() => to(h)}>${t(`logic.repeat_${h}`)}</button>`)}
          </div>
          ${how === 'count'
            ? html`<div class="fields"><input class="num" type="number" min="1" max="100" .value=${String(c.count ?? 3)} aria-label=${t('logic.repeat_count')} @change=${(e: Event) => this._up({ count: Math.max(1, Math.min(100, Number((e.target as HTMLInputElement).value) || 1)) })} /><span class="note">${t('logic.times')}</span></div>`
            : this._list(how, 'and', c[how] as Clause[])}
          <span class="part">${t('logic.part_steps')}</span>${this._list('then', 'then', c.then as Clause[])}`;
      }
      case 'parallel':
        return html`<p class="note">${t('logic.parallel_hint')}</p>${this._list('then', 'then', c.then as Clause[])}`;
      case 'wait_until':
        return html`${this._list('items', 'and', c.items as Clause[])}${this._timeout(c)}`;
      case 'wait_trigger':
        return html`${this._list('items', 'when', c.items as Clause[], undefined, 'or')}${this._timeout(c)}`;
      case 'set':
        return html`<div class="fields">
            <label class="note">${t('logic.var_name')} <input .value=${String(c.name ?? '')} pattern="[a-z0-9_]+" @change=${(e: Event) => this._up({ name: (e.target as HTMLInputElement).value.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 30) })} /></label>
            <label class="note">${t('logic.var_from')}
              <input .value=${c.from === 'trigger' ? '' : String(c.from ?? '')} placeholder=${t('logic.var_trigger')} @change=${(e: Event) => this._up({ from: (e.target as HTMLInputElement).value.trim() || 'trigger' })} />
            </label>
            <label class="note">${t('logic.var_attr')} <input .value=${String(c.attr ?? '')} placeholder="brightness" @change=${(e: Event) => this._up({ attr: (e.target as HTMLInputElement).value.trim() || undefined })} /></label>
          </div>
          <p class="note">${t('logic.var_map')}</p>
          <div class="fields">
            ${(['in_min', 'in_max', 'out_min', 'out_max'] as const).map(
              (k) => html`<label class="note">${t(`logic.${k}`)} <input class="num" type="number" .value=${c[k] == null ? '' : String(c[k])} @change=${(e: Event) => { const v = (e.target as HTMLInputElement).value; this._up({ [k]: v === '' ? undefined : Number(v) }); }} /></label>`,
            )}
          </div>
          <p class="note">${t('logic.var_use', { name: `$${c.name ?? 'value'}` })}</p>`;
      default:
        return html`<p class="note">${t('logic.stop_hint')}</p>`;
    }
  }

  override render() {
    const c = this.clause;
    if (!c) return nothing;
    const group = (GROUP_VERBS as string[]).includes(c.verb);
    return html`<div class="block" style=${group ? '--tone: var(--hr-and)' : '--tone: var(--hr-then)'}>
      <div class="head">
        <span class="grow">${group ? t('logic.group') : t(BLOCK_LABEL[c.verb as keyof typeof BLOCK_LABEL] ?? 'logic.stop')}</span>
        <button class="icon-btn rm" aria-label=${t('common.remove')} @click=${() => this._emit(null)}>${icon(mdiClose, 18)}</button>
      </div>
      ${this._body(c)}
    </div>`;
  }
}
customElements.define('hr-logic', HrLogic);
