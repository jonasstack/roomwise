/**
 * Renders a rule as a sentence with coloured chips (cards, device view, suggestions).
 * The editor renders the same pieces line by line and makes them tappable.
 */
import { html, nothing, type TemplateResult } from 'lit';
import type { Rule } from './model';
import type { Store } from './store';
import { clauseView, joiner, moreSteps, type Section } from './describe';
import { icon } from './design/shared';
import { t } from './i18n';
// i18n: complete

export function toneOf(rule: Rule, section: Section): string {
  if (section === 'when') return rule.type === 'while' ? 'tone-while' : 'tone-when';
  if (section === 'else') return 'tone-then';
  return `tone-${section}`;
}

export function sentence(store: Store, rule: Rule, opts: { limit?: number } = {}): TemplateResult {
  const parts: TemplateResult[] = [];
  let first = true;
  for (const section of ['when', 'and', 'then', 'only', 'else'] as Section[]) {
    const list = rule[section] ?? [];
    const shown = opts.limit && section === 'then' && list.length > opts.limit ? list.slice(0, opts.limit) : list;
    shown.forEach((c, i) => {
      const v = clauseView(store, c, section);
      const word = joiner(rule, section, i);
      parts.push(html`<span class="part ${toneOf(rule, section)}"
        ><span class="kw">${first ? word : word.toLowerCase()}</span>
        ${v.verbPre ? html`<span class="chip verb">${v.verbPre}</span> ` : nothing}${v.subject
          ? html`<span class="chip ${v.subject.missing ? 'missing' : ''}">${icon(v.subject.icon, 14)}${v.subject.label}</span> `
          : nothing}${v.verb || !v.verbPre
          ? html`<span class="chip verb">${v.verb}${v.mods.length ? html` <span class="muted">${v.mods.join(' · ')}</span>` : nothing}</span>`
          : v.mods.length
            ? html`<span class="muted">${v.mods.join(' · ')}</span>`
            : nothing}${(c.or ?? []).map((alt) => {
          const a = clauseView(store, alt, section);
          return html` <span class="kw">${t('join.or')}</span> ${a.verbPre ? html`<span class="chip verb">${a.verbPre}</span> ` : nothing}${a.subject ? html`<span class="chip">${icon(a.subject.icon, 14)}${a.subject.label}</span> ` : nothing}${a.verb ? html`<span class="chip verb">${a.verb}</span>` : nothing}`;
        })}<span
        >${rule.then.length && ((section === 'and' && i === list.length - 1) || (section === 'when' && i === list.length - 1 && !rule.and.length)) ? ',' : ''}</span
      >`);
      first = false;
    });
    if (shown.length < list.length) {
      const n = list.length - shown.length;
      parts.push(html`<span class="part muted">${moreSteps(n)}</span>`);
    }
  }
  return html`<span class="sentence">${parts}</span>`;
}

/** Rules that this rule sets off, and rules that set it off (via "start rule" or the house mode). */
export function links(store: Store, rule: Rule): { to: Rule[]; from: Rule[] } {
  const feeds = (a: Rule, b: Rule) =>
    a.id !== b.id &&
    a.then.some(
      (t) =>
        (t.subject === `rule:${b.id}` && t.verb === 'run') ||
        (t.subject === 'mode' && t.verb === 'set' && b.when.some((w) => w.subject === 'mode' && w.verb === 'changes_to' && w.mode === t.mode)),
    ) ||
    b.when.some((w) => w.subject === `rule:${a.id}`);
  return {
    to: store.rules.filter((r) => feeds(rule, r)),
    from: store.rules.filter((r) => feeds(r, rule)),
  };
}
