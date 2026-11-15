import { css, unsafeCSS, type CSSResult } from 'lit';

/**
 * Design tokens, same language as the floorplan card (iOS system palette, 4pt grid).
 * Each part of a sentence has its own colour, used everywhere a rule is shown:
 *   when (Wenn) orange · while (Solange) purple · and (Und) teal · then (Dann) blue · only (Nur) indigo
 */
const LIGHT = `
  --hr-font: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, 'Helvetica Neue', system-ui, sans-serif;
  --hr-font-sentence: ui-rounded, 'SF Pro Rounded', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif;
  --hr-text-caption: 12px;
  --hr-text-footnote: 13px;
  --hr-text-subhead: 15px;
  --hr-text-body: 17px;
  --hr-text-title3: 20px;
  --hr-text-title2: 22px;
  --hr-text-title1: 28px;
  --hr-text-large: 34px;

  --hr-space-1: 4px;
  --hr-space-2: 8px;
  --hr-space-3: 12px;
  --hr-space-4: 16px;
  --hr-space-5: 20px;
  --hr-space-6: 24px;
  --hr-space-7: 32px;
  --hr-space-8: 40px;

  --hr-radius-s: 10px;
  --hr-radius-m: 14px;
  --hr-radius-l: 20px;
  --hr-radius-xl: 28px;
  --hr-radius-full: 999px;
  --hr-hit: 44px;

  --hr-dur-fast: 150ms;
  --hr-dur: 220ms;
  --hr-ease: cubic-bezier(0.2, 0.8, 0.2, 1);

  --hr-accent: #007aff;
  --hr-on-accent: #ffffff;
  --hr-green: #34c759;
  --hr-red: #ff3b30;
  --hr-orange: #ff9500;
  --hr-yellow: #ffcc00;

  --hr-when: #f08a00;
  --hr-while: #a24fd6;
  --hr-and: #1a9fb5;
  --hr-then: #007aff;
  --hr-only: #5856d6;

  --hr-bg: #f2f2f7;
  --hr-surface: #ffffff;
  --hr-surface-2: #f2f2f7;
  --hr-surface-raised: #ffffff;
  --hr-fill: rgba(118, 118, 128, 0.12);
  --hr-fill-strong: rgba(120, 120, 128, 0.2);
  --hr-label: #1c1c1e;
  --hr-label-2: rgba(60, 60, 67, 0.64);
  --hr-label-3: rgba(60, 60, 67, 0.34);
  --hr-separator: rgba(60, 60, 67, 0.14);
  --hr-scrim: rgba(0, 0, 0, 0.26);
  --hr-glow: #ffdc8f;
  --hr-tint: 13%;

  --hr-shadow-1: 0 1px 2px rgba(0, 0, 0, 0.06), 0 0 1px rgba(0, 0, 0, 0.06);
  --hr-shadow-2: 0 6px 18px rgba(0, 0, 0, 0.07), 0 1px 3px rgba(0, 0, 0, 0.05);
  --hr-shadow-3: 0 24px 60px rgba(0, 0, 0, 0.18), 0 6px 18px rgba(0, 0, 0, 0.08);
  color-scheme: light;
`;

const DARK = `
  --hr-accent: #0a84ff;
  --hr-green: #30d158;
  --hr-red: #ff453a;
  --hr-orange: #ff9f0a;
  --hr-yellow: #ffd60a;

  --hr-when: #ff9f0a;
  --hr-while: #c77dff;
  --hr-and: #40c8e0;
  --hr-then: #3d9bff;
  --hr-only: #8e8cff;

  --hr-bg: #000000;
  --hr-surface: #1c1c1e;
  --hr-surface-2: #2c2c2e;
  --hr-surface-raised: #2c2c2e;
  --hr-fill: rgba(118, 118, 128, 0.24);
  --hr-fill-strong: rgba(120, 120, 128, 0.36);
  --hr-label: #ffffff;
  --hr-label-2: rgba(235, 235, 245, 0.64);
  --hr-label-3: rgba(235, 235, 245, 0.32);
  --hr-separator: rgba(84, 84, 88, 0.6);
  --hr-scrim: rgba(0, 0, 0, 0.55);
  --hr-glow: #ffcd78;
  --hr-tint: 22%;

  --hr-shadow-1: 0 0 0 1px rgba(255, 255, 255, 0.04);
  --hr-shadow-2: 0 0 0 1px rgba(255, 255, 255, 0.05);
  --hr-shadow-3: 0 24px 60px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.06);
  color-scheme: dark;
`;

/** Tokens for a top-level host. Embeddable elements pass a selector so they only apply when used on their own. */
export function tokensFor(host = ':host'): CSSResult {
  return css`
    ${unsafeCSS(`${host} {${LIGHT}}`)}
    ${unsafeCSS(`${host.replace(/\)$/, '')}${host.endsWith(')') ? '[dark])' : '([dark])'} {${DARK}}`)}
  `;
}

export const tokens = tokensFor(':host');
