/** Shared color helpers for user paints (furniture, floors, walls). */

export function parseHex(hex: string): [number, number, number] {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return isNaN(n) || h.length !== 6 ? [200, 200, 200] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Lighten (pct > 0) or darken (pct < 0) a hex color; returns a hex color. */
export function tone(hex: string, pct: number): string {
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(pct >= 0 ? c + (255 - c) * pct : c * (1 + pct))));
  return '#' + parseHex(hex).map((c) => f(c).toString(16).padStart(2, '0')).join('');
}

export function luminance(hex: string) {
  const [r, g, b] = parseHex(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** User paint, dimmed in dark mode so it sits in the theme (CSS color expression). */
export const paint = (c: string) => `color-mix(in srgb, ${c} var(--fp-paint-mix), var(--fp-room))`;
