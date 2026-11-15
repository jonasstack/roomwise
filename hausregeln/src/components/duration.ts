/**
 * A − / + control for a time span that works down to seconds. The value is kept in minutes (as the backend
 * stores it, fractions allowed); the steps get finer below a minute: 5 s, then 30 s up to 10 min, then 1 min.
 */
import { html, type TemplateResult } from 'lit';
import { t } from '../i18n';
// i18n: complete

export function formatSeconds(total: number): string {
  const s = Math.round(total);
  if (s < 60) return t('dur.s', { n: s });
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m >= 60 && !rest && m % 60 === 0) return t('dur.h', { n: m / 60 });
  return rest ? t('dur.min_sec', { m, s: rest }) : t('dur.m', { n: m });
}

function stepUp(s: number): number {
  if (s < 60) return 5;
  if (s < 600) return 30;
  return 60;
}

function stepDown(s: number): number {
  if (s <= 60) return 5;
  if (s <= 600) return 30;
  return 60;
}

/** '90s' / '5m' / '1h' → seconds (0 for nothing) */
export function durToSec(d: unknown): number {
  const m = String(d ?? '').match(/^(\d+(?:[.,]\d+)?)\s*([smhd])$/);
  return m ? Number(m[1].replace(',', '.')) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as 's'] : 0;
}

/** seconds → the shortest text the backend reads ('3m', '90s', '2h'); '' for 0 */
export function secToDur(s: number): string {
  s = Math.round(s);
  if (!s) return '';
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}

/** minutes in, minutes out; min/max in minutes */
export function durationStepper(minutes: number, set: (minutes: number) => void, min = 0, max = 240): TemplateResult {
  const s = Math.round(minutes * 60);
  const to = (sec: number) => set(Math.max(min, Math.min(max, Math.round(sec) / 60)));
  return html`<span class="stepper">
    <button aria-label="weniger" @click=${() => to(Math.max(0, s - stepDown(s)))}>−</button>
    <output>${formatSeconds(s)}</output>
    <button aria-label="mehr" @click=${() => to(s + stepUp(s))}>+</button>
  </span>`;
}
