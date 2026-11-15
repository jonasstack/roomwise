import type { ActionConfig, MediaCommand, MediaControlsConfig } from './types';
import { runAction, type ActionHost } from './actions';

/** The ready-made slots of a media device, in the order the editor lists them */
export const MEDIA_SLOTS = ['power', 'power_on', 'power_off', 'volume_up', 'volume_down', 'mute', 'play_pause', 'previous', 'next'] as const;
export type MediaSlot = (typeof MEDIA_SLOTS)[number];

/** Does the command do anything? */
export function commandSet(cmd: MediaCommand | undefined): cmd is MediaCommand {
  if (!cmd) return false;
  if (cmd.script) return true;
  return !!cmd.action && cmd.action.action !== 'default' && cmd.action.action !== 'none';
}

/** Any own control configured at all? */
export function hasMediaControls(m: MediaControlsConfig | undefined): m is MediaControlsConfig {
  if (!m) return false;
  return MEDIA_SLOTS.some((k) => commandSet(m[k])) || !!m.sources?.some(commandSet) || !!m.buttons?.some(commandSet);
}

/** The action a command stands for: a script runs via script.turn_on (with its variables) */
export function commandAction(cmd: MediaCommand | undefined): ActionConfig | undefined {
  if (!commandSet(cmd)) return undefined;
  if (cmd.script)
    return {
      action: 'perform-action',
      perform_action: 'script.turn_on',
      target: { entity_id: cmd.script },
      data: cmd.variables && Object.keys(cmd.variables).length ? { variables: cmd.variables } : {},
    };
  return cmd.action;
}

/** Runs a command through the normal action path (confirmations, the slide before anything opens, toasts) */
export async function runMediaCommand(host: ActionHost, cmd: MediaCommand | undefined, entity?: string): Promise<void> {
  const action = commandAction(cmd);
  if (!action) return;
  // the device's own entity is the default target of an action without one (toggle, more-info …)
  await runAction(host, action.entity || !entity ? action : { ...action, entity }, {});
}

const isCommand = (c: unknown) =>
  c === undefined ||
  (!!c &&
    typeof c === 'object' &&
    (((c as MediaCommand).script === undefined || (typeof (c as MediaCommand).script === 'string' && /^script\.[a-z0-9_]+$/.test((c as MediaCommand).script!))) &&
      ((c as MediaCommand).variables === undefined || (typeof (c as MediaCommand).variables === 'object' && !Array.isArray((c as MediaCommand).variables))) &&
      ((c as MediaCommand).action === undefined || (typeof (c as MediaCommand).action === 'object' && typeof (c as MediaCommand).action!.action === 'string'))));

/** Checks the shape of a media block from outside (a file); true = fine */
export function validMediaControls(m: unknown): boolean {
  if (m === undefined) return true;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
  const c = m as Record<string, unknown>;
  if (!MEDIA_SLOTS.every((k) => isCommand(c[k]))) return false;
  for (const key of ['sources', 'buttons']) {
    const list = c[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > 50) return false;
    if (!list.every((x) => isCommand(x) && typeof x?.name === 'string' && (x.icon === undefined || typeof x.icon === 'string'))) return false;
  }
  // `recognize` (the former song recognition) in an old file is ignored
  return true;
}

