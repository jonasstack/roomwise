/**
 * Texts of the panel in German and English.
 *
 * The dictionaries live per area in src/i18n/*.ts, each with both languages side by side; German is the base and
 * English must have every key (the type and tools/i18n-check.mjs make sure of it). The language follows the
 * Home Assistant user: hass.locale.language ?? hass.language, German for "de*", English for everything else.
 *
 * Never translate at module load (constants are built before hass is known): call t() while rendering.
 */
import * as common from './i18n/common';
import * as rules from './i18n/rules';
import * as history from './i18n/history';
import * as rooms from './i18n/rooms';
import * as devices from './i18n/devices';
import * as settings from './i18n/settings';
import * as alarm from './i18n/alarm';
import * as home from './i18n/home';
import * as warning from './i18n/warning';
import * as panel from './i18n/panel';
import * as vocab from './i18n/vocab';
import * as release from './i18n/release';
import * as heat from './i18n/heat';
import * as lights from './i18n/lights';

const de = { ...common.de, ...rules.de, ...history.de, ...rooms.de, ...devices.de, ...settings.de, ...alarm.de, ...home.de, ...warning.de, ...panel.de, ...vocab.de, ...release.de, ...heat.de, ...lights.de };
const en: Record<string, string> = { ...common.en, ...rules.en, ...history.en, ...rooms.en, ...devices.en, ...settings.en, ...alarm.en, ...home.en, ...warning.en, ...panel.en, ...vocab.en, ...release.en, ...heat.en, ...lights.en };

export type I18nKey = keyof typeof de;
export type Lang = 'de' | 'en';

let lang: Lang = 'de';
/** the full locale for Intl (e.g. "en-GB" formats times with 24 hours, "en-US" with AM/PM) */
let intl = 'de-DE';
let hour12: boolean | undefined;
const listeners = new Set<(l: Lang) => void>();

/** Minimal part of hass the language comes from. */
export interface HassLocale {
  language?: string;
  locale?: { language?: string; time_format?: string; number_format?: string };
}

/** Sets the language; returns true if it changed (callers then re-render). */
export function setLanguage(language: string | undefined, timeFormat?: string): boolean {
  const raw = (language || 'de').replace('_', '-');
  const next: Lang = raw.toLowerCase().startsWith('de') ? 'de' : 'en';
  // dates and numbers follow the user's region when it speaks the same language ("en-GB", "de-AT"), else the default
  intl = raw.toLowerCase().startsWith(next) && raw.includes('-') ? raw : next === 'de' ? 'de-DE' : 'en-US';
  hour12 = timeFormat === '12' ? true : timeFormat === '24' ? false : undefined;
  if (next === lang) return false;
  lang = next;
  for (const f of listeners) f(lang);
  return true;
}

/** Language from a hass object (user profile first, then the system). */
export function setLanguageFrom(hass: HassLocale | undefined): boolean {
  if (!hass) return false;
  return setLanguage(hass.locale?.language ?? hass.language, hass.locale?.time_format);
}

export const getLanguage = (): Lang => lang;
export const intlLocale = (): string => intl;

export function onLanguageChange(f: (l: Lang) => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** A text with {placeholders}: t('rules.count', { n: 3 }). Unknown keys come back as the key (visible, never empty). */
export function t(key: I18nKey, params?: Record<string, string | number | undefined | null>): string {
  let s = (lang === 'en' ? en[key] : undefined) ?? (de as Record<string, string>)[key] ?? key;
  if (params) s = s.replace(/\{(\w+)\}/g, (m, k: string) => (params[k] == null ? m : String(params[k])));
  return s;
}

/** Singular/plural: tn('rules.steps', n) uses "rules.steps_one" for 1 and "rules.steps_other" else; {n} is filled in. */
export function tn(key: string, n: number, params?: Record<string, string | number | undefined | null>): string {
  return t(`${key}_${n === 1 ? 'one' : 'other'}` as I18nKey, { n: fmtNumber(n, 0), ...params });
}

/** 21.5 → "21,5" (German) / "21.5" (English). */
export function fmtNumber(n: number, digits?: number): string {
  if (!Number.isFinite(n)) return String(n);
  return new Intl.NumberFormat(intl, digits == null ? { maximumFractionDigits: 2 } : { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}

/** Clock time of a date (or ISO string): "07:30" / "7:30 AM". */
export function fmtTime(d: Date | string | number): string {
  return new Date(d).toLocaleTimeString(intl, { hour: '2-digit', minute: '2-digit', ...(hour12 == null ? {} : { hour12 }) });
}

/** A "HH:MM" string from a rule in the user's clock format. */
export function fmtClock(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm ?? '');
  if (!m) return hhmm ?? '';
  const d = new Date(2000, 0, 1, Number(m[1]), Number(m[2]));
  return fmtTime(d);
}

/** Date with Intl options, e.g. { weekday: 'long', day: 'numeric', month: 'long' }. */
export function fmtDate(d: Date | string | number, opts: Intl.DateTimeFormatOptions): string {
  return new Date(d).toLocaleDateString(intl, opts);
}

/** "A, B und C" / "A, B and C" */
export function fmtList(items: string[], type: 'conjunction' | 'disjunction' = 'conjunction'): string {
  try {
    return new Intl.ListFormat(intl, { style: 'long', type }).format(items);
  } catch {
    return items.join(', ');
  }
}

/** Sorting by name in the user's language. */
export function compare(a: string, b: string): number {
  return a.localeCompare(b, intl);
}

/** "„Name“" / "“Name”" */
export function quote(s: string): string {
  return lang === 'de' ? `„${s}“` : `“${s}”`;
}

/** "in der Küche" (the room's German phrase from the server) / "in the Kitchen" */
export function roomIn(room: { name: string; in?: string } | undefined, fallback = ''): string {
  if (!room) return fallback;
  if (lang === 'de') return room.in || `im ${room.name}`;
  return /^(the |my |our )|'s\b/i.test(room.name) ? `in ${room.name}` : `in the ${room.name}`;
}
