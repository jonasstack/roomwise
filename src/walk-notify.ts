import type { FurnitureConfig, HomeAssistant, WalkReminder } from './types';
import { getLanguage } from './i18n';
import { hrPhone } from './house-rules';

/**
 * Walk reminder messages: title and text as written by the user, everything else switched on by ticks
 * (walk time appended, "Done" button, important). The same composition is sent to the companion integration
 * (which sends the real reminders) and used for the test message from the editor.
 */
const de = () => getLanguage() !== 'en';

export function defaultTitle(f: FurnitureConfig): string {
  return f.name || (de() ? 'Gassi' : 'Walk');
}

export function defaultText(f: FurnitureConfig): string {
  const name = f.name || (de() ? 'Der Hund' : 'The dog');
  return de() ? `${name} muss raus!` : `${name} needs to go out!`;
}

/** Text as the server needs it: {zeit} is filled in with the walk time when it is to be appended */
export function textTemplate(f: FurnitureConfig, r: WalkReminder): string {
  const base = (r.text?.trim() || defaultText(f)).replace(/[{}]/g, '');
  return r.show_time === false ? base : `${base} ${de() ? '(Gassi um {zeit})' : '(walk at {zeit})'}`;
}

/** Extra notification data: "Done" button, important (shown also in Focus / Do not disturb where allowed) */
export function notifyData(r: WalkReminder, tag: string, action: string): Record<string, unknown> {
  const data: Record<string, unknown> = { tag };
  if (r.done_button !== false) data.actions = [{ action, title: de() ? 'Erledigt' : 'Done' }];
  if (r.important) Object.assign(data, { push: { 'interruption-level': 'time-sensitive' }, priority: 'high', ttl: 0 });
  return data;
}

/** The notify service of a person's phone (companion app), if it can be found. With Hausregeln the phone it found
 *  for the person (one source for card and Hausregeln), otherwise looked up here the same way. */
export function phoneOf(hass: HomeAssistant, person: string): string | undefined {
  const hr = hrPhone(hass, person);
  if (hr) return hr;
  const notify = Object.keys(hass.services?.notify ?? {});
  const trackers = (hass.states[person]?.attributes.device_trackers as string[] | undefined) ?? [];
  for (const tr of trackers) {
    const dev = hass.entities?.[tr]?.device_id;
    const name = dev ? (hass.devices?.[dev]?.name_by_user ?? hass.devices?.[dev]?.name) : undefined;
    const slug = (name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const hit = notify.find((n) => n === `mobile_app_${slug}`) ?? notify.find((n) => slug && n.startsWith('mobile_app_') && n.includes(slug));
    if (hit) return `notify.${hit}`;
  }
  return undefined;
}

/** Who gets it right now: with a zone only the people inside it; nobody inside → everyone (or nobody) */
export function recipients(hass: HomeAssistant, notify: WalkReminder['notify']): { services: string[]; fallback: boolean } {
  const targets = notify?.targets ?? [];
  if (!notify?.zone) return { services: targets.map((t) => t.service), fallback: false };
  const zone = notify.zone;
  const z = hass.states[zone];
  const inside = (person?: string) => {
    const st = person ? hass.states[person]?.state : undefined;
    if (!st) return false;
    return zone === 'zone.home' ? st === 'home' : !!z && (st === z.attributes.friendly_name || st === zone.slice(5) || st === zone);
  };
  const chosen = targets.filter((t) => inside(t.person)).map((t) => t.service);
  if (chosen.length) return { services: chosen, fallback: false };
  return { services: (notify.fallback ?? 'all') === 'all' ? targets.map((t) => t.service) : [], fallback: true };
}

/** Test from the editor: the message as it would arrive now (marked as a test) */
export async function sendTest(hass: HomeAssistant, f: FurnitureConfig, r: WalkReminder): Promise<{ sent: string[]; failed: string[]; spoken: boolean; fallback: boolean }> {
  const slot = [...(f.pet?.walks ?? [])].sort()[0] ?? '07:00';
  const title = `${r.title?.trim() || defaultTitle(f)}${de() ? ' (Test)' : ' (test)'}`;
  const message = textTemplate(f, r).replaceAll('{zeit}', slot);
  const { services, fallback } = recipients(hass, r.notify);
  const sent: string[] = [];
  const failed: string[] = [];
  for (const svc of services) {
    const name = svc.replace(/^notify\./, '');
    try {
      await hass.callService('notify', name, { title, message, data: notifyData(r, 'fp-walk-test', 'FP_WALK_TEST') });
      sent.push(svc);
    } catch {
      try {
        await hass.callService('notify', name, { title, message });
        sent.push(svc);
      } catch {
        failed.push(svc);
      }
    }
  }
  let spoken = false;
  if (r.speak?.tts_entity && r.speak.media_player) {
    try {
      await hass.callService('tts', 'speak', { media_player_entity_id: r.speak.media_player, message, cache: true, ...(r.speak.language ? { language: r.speak.language } : {}) }, { entity_id: r.speak.tts_entity });
      spoken = true;
    } catch {
      /* speaker not reachable */
    }
  }
  return { sent, failed, spoken, fallback };
}
