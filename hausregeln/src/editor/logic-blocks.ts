/**
 * The building blocks of the advanced logic ("Erweitert", see logic.py): and/or/not groups for conditions,
 * if / choose / repeat / parallel / wait / set / stop for steps. New blocks start with sensible defaults.
 */
// i18n: complete
import type { Clause } from '../model';
import type { I18nKey } from '../i18n';

export type GroupVerb = 'all' | 'any' | 'not';
export type StepVerb = 'if' | 'choose' | 'repeat' | 'parallel' | 'wait_until' | 'wait_trigger' | 'set' | 'stop';

export const GROUP_VERBS: GroupVerb[] = ['all', 'any', 'not'];
export const STEP_VERBS: StepVerb[] = ['if', 'choose', 'repeat', 'parallel', 'wait_until', 'wait_trigger', 'set', 'stop'];

export const BLOCK_LABEL: Record<GroupVerb | StepVerb, I18nKey> = {
  all: 'logic.all',
  any: 'logic.any',
  not: 'logic.not',
  if: 'logic.if',
  choose: 'logic.choose',
  repeat: 'logic.repeat',
  parallel: 'logic.parallel',
  wait_until: 'logic.wait_until',
  wait_trigger: 'logic.wait_trigger',
  set: 'logic.set',
  stop: 'logic.stop',
};

export const isLogic = (c: Clause | undefined): boolean => c?.subject === 'logic';

export function newBlock(verb: GroupVerb | StepVerb): Clause {
  const c: Clause = { subject: 'logic', verb };
  switch (verb) {
    case 'all':
    case 'any':
    case 'not':
      return { ...c, items: [] };
    case 'if':
      return { ...c, if: [], then: [], else: [] };
    case 'choose':
      return { ...c, cases: [{ trigger: [], when: [], then: [] }], else: [] };
    case 'repeat':
      return { ...c, count: 3, then: [] };
    case 'parallel':
      return { ...c, then: [] };
    case 'wait_until':
    case 'wait_trigger':
      return { ...c, items: [], timeout: '10m', continue: true };
    case 'set':
      return { ...c, name: 'value', from: 'trigger' };
    default:
      return c;
  }
}
