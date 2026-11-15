/**
 * Turns rules into sentences (German or English, see i18n.ts). The editor shows the same pieces as tappable chips.
 */
// i18n: complete
import type { Clause, LightAction, Rule } from './model';
import { lightText } from './lightspec';
import type { Store } from './store';
import { KINDS, MODES, domainKind, findVerb, formatDuration, formatOffset, type Kind } from './vocabulary';
import { fmtDate, fmtNumber, fmtTime, getLanguage, quote, roomIn as roomPhrase, t, tn, type I18nKey } from './i18n';

/** light colors as stored in rules (German words the integration knows) → their name */
const COLOR_KEYS: Record<string, I18nKey> = {
  'warmweiß': 'rules.color_warm', // i18n-ignore (stored value)
  'neutralweiß': 'rules.color_neutral', // i18n-ignore
  'kaltweiß': 'rules.color_cold', // i18n-ignore
  rot: 'rules.color_red',
  orange: 'rules.color_orange',
  'grün': 'rules.color_green', // i18n-ignore
  blau: 'rules.color_blue',
  lila: 'rules.color_purple',
};

/** "Lights" → "lights" in the middle of an English sentence (not "HA automations") */
const lcFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

export type Section = 'when' | 'and' | 'then' | 'only' | 'else';

export interface SubjectInfo {
  label: string;
  icon: string;
  kind: string;
  plural: boolean;
  /** "in der Küche" */
  where?: string;
  missing?: boolean;
}

export function subjectInfo(store: Store, subject: string): SubjectInfo {
  const kindOf = (id: string): Kind => KINDS[id] ?? KINDS.switch;
  const roomIn = (r?: string) => (r === 'same' ? t('common.same_room') : r ? roomPhrase(store.room(r), r) : undefined);

  let m = subject.match(/^(any|all):([a-z_]+)(?:@([a-z_]+))?$/);
  if (m) {
    const k = kindOf(m[2]);
    const where = roomIn(m[3]);
    const base = m[1] === 'any' ? k.any : t('describe.all', { plural: getLanguage() === 'en' ? lcFirst(k.plural) : k.plural });
    return { label: where ? `${base} ${where}` : base, icon: k.icon, kind: k.id, plural: m[1] === 'all', where };
  }
  if ((m = subject.match(/^room:(.+)$/))) {
    const r = store.room(m[1]);
    return { label: r?.name ?? m[1], icon: KINDS.room.icon, kind: 'room', plural: false, missing: !r };
  }
  if ((m = subject.match(/^zone:(.+)$/))) {
    const d = store.device(m[1]);
    return { label: d?.name ?? m[1], icon: KINDS.zone.icon, kind: 'zone', plural: false, missing: !d };
  }
  if ((m = subject.match(/^person:(.+)$/))) {
    if (m[1] === 'someone') return { label: t('common.someone'), icon: KINDS.person.icon, kind: 'person', plural: false };
    if (m[1] === 'everyone') return { label: t('common.everyone'), icon: KINDS.person.icon, kind: 'person', plural: true };
    const p = store.person(m[1]);
    return { label: p?.name ?? m[1], icon: KINDS.person.icon, kind: 'person', plural: false, missing: !p };
  }
  if ((m = subject.match(/^notify:(.+)$/))) {
    const who = m[1] === 'everyone' ? t('common.to_everyone') : store.person(m[1])?.name ?? m[1];
    return { label: who, icon: KINDS.notify.icon, kind: 'notify', plural: false };
  }
  if ((m = subject.match(/^group:(.+)$/))) {
    const g = store.group(m[1]);
    const kinds = new Set((g?.members ?? []).map((e) => store.device(e)?.kind).filter(Boolean));
    const kind = kinds.size === 1 ? [...kinds][0]! : 'group';
    return { label: g?.name ?? t('common.deleted_group'), icon: g?.icon ?? KINDS.group.icon, kind, plural: false, missing: !g };
  }
  if (subject === 'alarm') return { label: t('describe.alarm'), icon: KINDS.alarm.icon, kind: 'alarm', plural: false };
  if ((m = subject.match(/^rule:(.+)$/))) {
    const r = store.rule(m[1]);
    return { label: r ? quote(r.name) : t('common.deleted_rule'), icon: KINDS.rule.icon, kind: 'rule', plural: false, missing: !r };
  }
  if (KINDS[subject] && !KINDS[subject].placeholder) {
    const k = KINDS[subject];
    return { label: subject === 'sun' ? t('common.the_sun') : subject === 'mode' ? t('describe.mode') : k.label, icon: k.icon, kind: subject, plural: false };
  }
  const d = store.device(subject);
  if (!d) {
    // any other entity: by its domain (sensor, select, button …)
    const e = subject.includes('.') ? store.entity(subject) : undefined;
    const kind = domainKind(subject);
    if (e) return { label: e.name, icon: KINDS[kind].icon, kind, plural: false };
    return { label: subject.split('.').pop() ?? subject, icon: KINDS[kind]?.icon ?? KINDS.switch.icon, kind: subject.includes('.') ? kind : 'switch', plural: false, missing: true };
  }
  return { label: d.name, icon: kindOf(d.kind).icon, kind: d.kind, plural: false };
}

function fill(label: string, clause: Clause, kind: string, verbId: string, store?: Store): string {
  const verb = findVerb(kind, verbId);
  return label.replace(/\{(\w+)\}/g, (_, key: string) => {
    const spec = verb?.params?.find((p) => p.key === key);
    const v = clause[key] ?? spec?.default;
    switch (spec?.type) {
      case 'duration':
        return formatDuration(v);
      case 'percent':
        return `${v} %`;
      case 'light':
        return lightText(v as Partial<LightAction>);
      case 'days':
        return (
          String(v ?? '')
            .split(',')
            .filter(Boolean)
            .map((d) => t(`logic.day_${d.trim().slice(0, 3)}` as I18nKey))
            .join(', ') || '…'
        );
      case 'temperature':
        return `${getLanguage() === 'de' ? String(v).replace('.', ',') : fmtNumber(Number(v))} °C`;
      case 'number':
        return `${v}${spec.unit ? ' ' + (getLanguage() === 'en' && spec.unit === 'Min.' ? 'min' : spec.unit) : ''}`;
      case 'mode':
        return MODES[String(v)]?.label ?? String(v);
      case 'color': {
        const key = COLOR_KEYS[String(v).toLowerCase()];
        return key ? t(key) : String(v ?? '…');
      }
      case 'zone':
        return v === 'home' ? t('common.home_zone') : (store?.placeName(String(v)) ?? String(v));
      case 'text': {
        const s = String(v ?? '');
        return s.length > 44 ? s.slice(0, 42) + '…' : s || '…';
      }
      default:
        return String(v ?? '…');
    }
  });
}

export interface ClauseView {
  subject?: SubjectInfo;
  /** the part of the verb before the subject (English actions: "turn on" + subject); mostly empty */
  verbPre?: string;
  /** the verb (after the subject); can be empty when verbPre holds all of it */
  verb: string;
  mods: string[];
  sensitive?: boolean;
  unknownVerb?: boolean;
}

export function clauseView(store: Store, clause: Clause, section: Section): ClauseView {
  if (section === 'else') section = 'then';
  if (clause.subject === 'logic') return { verb: logicText(store, clause, section), mods: [] };
  const subject = subjectInfo(store, clause.subject);
  const kind = KINDS[subject.kind];
  const verb = findVerb(subject.kind, clause.verb);
  let label = verb ? (subject.plural && verb.pl ? verb.pl : verb.label) : clause.verb;
  if (clause.plan) label = t(clause.verb === 'set_temp' ? 'describe.by_heat_plan' : 'describe.by_light_plan');
  const mods: string[] = [];
  const off = formatOffset(clause.offset);
  if (off) mods.push(off);
  if (section !== 'then' && clause.for && !verb?.params?.some((p) => p.key === 'for')) mods.push(t('describe.since', { d: formatDuration(clause.for) }));
  if (section === 'then' && clause.for && !verb?.params?.some((p) => p.key === 'for')) mods.push(t('describe.for', { d: formatDuration(clause.for) }));
  if (section === 'then' && clause.brightness != null && clause.verb === 'turn_on') mods.push(`${clause.brightness} %`);
  const hidden = !!kind?.hide_subject?.includes(section);
  // "{s}" marks where the subject goes (English actions: "turn on {s}"); without it the subject comes first
  const at = label.indexOf('{s}');
  const pre = at < 0 ? '' : label.slice(0, at);
  const post = at < 0 ? label : label.slice(at + 3);
  const text = (x: string) => fill(x, clause, subject.kind, clause.verb, store).replace(/\s+/g, ' ').trim();
  return {
    subject: hidden ? undefined : subject,
    verbPre: hidden ? undefined : text(pre) || undefined,
    verb: hidden ? text(pre + ' ' + post) : text(post),
    mods,
    sensitive: verb?.sensitive,
    unknownVerb: !verb,
  };
}

/** a block of the advanced logic (logic.py) in words: "eins davon: (A oder B)", "3× wiederholen: …" */
export function logicText(store: Store, c: Clause, section: Section): string {
  const cond = section === 'then' || section === 'else' ? 'and' : section;
  const list = (k: string) => (c[k] as Clause[] | undefined) ?? [];
  const conds = (xs: Clause[], join: 'and' | 'or' = 'and') => xs.map((x) => clauseText(store, x, cond)).join(` ${t(join === 'or' ? 'join.or' : 'join.and')} `) || '…';
  const steps = (xs: Clause[]) => xs.map((x) => clauseText(store, x, 'then')).join(', ') || '…';
  switch (c.verb) {
    case 'all':
    case 'any':
    case 'not':
      return t(`logic.text_${c.verb}`, { items: conds(list('items'), c.verb === 'all' ? 'and' : 'or') });
    case 'if':
      return t('logic.text_if', { cond: conds(list('if')), then: steps(list('then')) }) + (list('else').length ? t('logic.text_else', { steps: steps(list('else')) }) : '');
    case 'choose': {
      const cases = ((c.cases as { trigger?: string[]; when?: Clause[]; then?: Clause[] }[]) ?? []).map((x) =>
        t('logic.text_case', {
          cond: [x.trigger?.length ? t('logic.text_ids', { ids: x.trigger.join(', ') }) : '', x.when?.length ? conds(x.when) : ''].filter(Boolean).join(' ') || t('logic.text_always'),
          then: steps(x.then ?? []),
        }),
      );
      if (list('else').length) cases.push(t('logic.text_case_else', { steps: steps(list('else')) }));
      return t('logic.text_choose', { cases: cases.join('; ') });
    }
    case 'repeat':
      if ('while' in c) return t('logic.text_repeat_while', { cond: conds(list('while')), steps: steps(list('then')) });
      if ('until' in c) return t('logic.text_repeat_until', { cond: conds(list('until')), steps: steps(list('then')) });
      return t('logic.text_repeat_count', { n: Number(c.count ?? 2), steps: steps(list('then')) });
    case 'parallel':
      return t('logic.text_parallel', { steps: steps(list('then')) });
    case 'wait_until':
    case 'wait_trigger': {
      const what = c.verb === 'wait_until' ? conds(list('items')) : list('items').map((x) => clauseText(store, x, 'when')).join(` ${t('join.or')} `) || '…';
      const base = t(c.verb === 'wait_until' ? 'logic.text_wait_until' : 'logic.text_wait_trigger', { cond: what });
      return c.timeout ? base + t(c.continue === false ? 'logic.text_timeout_stop' : 'logic.text_timeout', { d: formatDuration(c.timeout) }) : base;
    }
    case 'set':
      return t('logic.text_set', { name: String(c.name ?? ''), source: c.from === 'trigger' || !c.from ? t('logic.var_trigger') : (store.device(String(c.from))?.name ?? String(c.from)) });
    default:
      return t('logic.text_stop');
  }
}

/** The word in front of a clause: Wenn / oder / und / Solange / Dann / danach / Nur (When / or / and / While / Then / then / Only if) */
export function joiner(rule: Rule, section: Section, index: number): string {
  if (section === 'when') return t(index === 0 ? (rule.type === 'while' ? 'join.while' : 'join.when') : rule.type === 'while' ? 'join.and' : 'join.or');
  if (section === 'and') return t('join.and');
  if (section === 'only') return t(index === 0 ? 'join.only' : 'join.and');
  const list = section === 'else' ? (rule.else ?? []) : rule.then;
  if (index === 0) return t(section === 'else' ? 'join.else' : 'join.then');
  return t(list[index - 1]?.subject === 'wait' ? 'join.after' : 'join.and');
}

export function clauseText(store: Store, clause: Clause, section: Section): string {
  const v = clauseView(store, clause, section);
  const one = [v.verbPre, v.subject?.label, v.verb, ...v.mods].filter(Boolean).join(' ');
  if (!clause.or?.length) return one;
  return `(${[one, ...clause.or.map((c) => clauseText(store, c, section))].join(` ${t('join.or')} `)})`;
}

/** One plain sentence, e.g. for lists, notifications and the text assistant. */
export function ruleSentence(store: Store, rule: Rule): string {
  const parts: string[] = [];
  for (const section of ['when', 'and', 'then', 'only', 'else'] as Section[])
    (rule[section] ?? []).forEach((c, i) => {
      let j = joiner(rule, section, i);
      if (parts.length && section !== 'when') j = j.toLowerCase();
      if ((section === 'then' || section === 'else') && i === 0) parts.push(',');
      // English reads better without "then": "When the door opens, turn on the light."
      if (section === 'then' && i === 0 && parts.length && getLanguage() === 'en') j = '';
      if (section === 'only' && i === 0 && parts.length && getLanguage() === 'en') parts.push(',');
      parts.push(`${j} ${clauseText(store, c, section)}`.trim());
    });
  return (parts.join(' ').replace(/ ,/g, ',') + '.').replace(/^./, (c) => c.toUpperCase());
}

/** All devices/rooms a rule touches, for highlighting (plan, device view). */
export function involved(rule: Rule): { subject: string; section: Section }[] {
  return (['when', 'and', 'then', 'only', 'else'] as Section[]).flatMap((section) => (rule[section] ?? []).map((c) => ({ subject: c.subject, section })));
}

export function relTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return t('time.never');
  const at = new Date(iso).getTime();
  const diff = Math.round((now - at) / 60000);
  const d = new Date(at);
  const time = fmtTime(d);
  if (diff < 0) {
    const tomorrow = new Date(now + 86400000).toDateString() === d.toDateString();
    return tomorrow ? t('time.tomorrow_at', { time }) : t('time.day_at', { day: fmtDate(d, { weekday: 'short' }), time });
  }
  if (diff < 1) return t('time.just_now');
  if (diff < 60) return t('time.min_ago', { n: diff });
  if (new Date(now).toDateString() === d.toDateString()) return t('time.today_at', { time });
  const y = new Date(now - 86400000).toDateString() === d.toDateString();
  return y ? t('time.yesterday_at', { time }) : t('time.day_at', { day: fmtDate(d, { day: 'numeric', month: 'short' }), time });
}

export function sinceText(iso: string, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (min < 1) return t('time.since_now');
  if (min < 60) return t('time.since_min', { n: min });
  const h = Math.floor(min / 60);
  return h < 24 ? t('time.since_h', { n: h }) : t('time.since_d', { n: Math.floor(h / 24) });
}

/** "und ein weiterer Schritt" / "and 2 more steps" */
export const moreSteps = (n: number): string => tn('describe.more_steps', n);
