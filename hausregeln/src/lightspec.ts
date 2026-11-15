/**
 * Light settings in the panel: what a lamp can do (from its state), colour strings and their conversions,
 * a setting in a few words. The same colour strings as the integration (lightspec.py):
 * "warm" | "kerze" | "neutral" | "kalt" | "k:3200" | "#ff8800" | "rgbw:r,g,b,w" | "rgbww:r,g,b,cw,ww" | "hs:h,s" |
 * "xy:x,y" | "white" | "none" (keep the colour).
 */
// i18n: complete
import type { LightAction } from './model';
import { t, type I18nKey } from './i18n';

export interface LightCaps {
  /** supported_color_modes: onoff, brightness, color_temp, hs, xy, rgb, rgbw, rgbww, white */
  modes: string[];
  min_k: number;
  max_k: number;
  effects: string[];
  features: number;
}

export const COLOR_MODES = ['hs', 'rgb', 'rgbw', 'rgbww', 'xy'];
export const FEATURE_FLASH = 8;
export const FEATURE_TRANSITION = 32;
export const PRESETS: [string, I18nKey][] = [
  ['kerze', 'light.preset_kerze'],
  ['warm', 'light.preset_warm'],
  ['neutral', 'light.preset_neutral'],
  ['kalt', 'light.preset_kalt'],
];
/** colour swatches of the picker */
export const SWATCHES = ['#ff0000', '#ff6a00', '#ffb000', '#ffe600', '#7cff00', '#00d26a', '#00e5ff', '#0080ff', '#3d3dff', '#8a2be2', '#ff00c8', '#ff6f91'];

/** what a lamp can do; unknown lamps (demo, not loaded yet) can do everything */
export function lightCaps(st: { attributes: Record<string, unknown> } | undefined): LightCaps {
  const a = st?.attributes ?? {};
  let modes = ((a.supported_color_modes as string[] | undefined) ?? []).map(String);
  if (!modes.length) modes = st ? (a.brightness != null ? ['brightness'] : ['onoff']) : ['color_temp', 'hs', 'rgb', 'rgbw', 'rgbww', 'xy'];
  return {
    modes,
    min_k: Number(a.min_color_temp_kelvin ?? 2000),
    max_k: Number(a.max_color_temp_kelvin ?? 6500),
    effects: ((a.effect_list as string[] | undefined) ?? []).map(String),
    features: Number(a.supported_features ?? (st ? 0 : 255)),
  };
}

export const hasColor = (c: LightCaps) => c.modes.some((m) => COLOR_MODES.includes(m));
export const hasWhite = (c: LightCaps) => c.modes.includes('color_temp');
export const dimmable = (c: LightCaps) => !(c.modes.length === 1 && c.modes[0] === 'onoff');

/** several lamps together: what at least one of them can do */
export function unionCaps(list: LightCaps[]): LightCaps {
  if (!list.length) return lightCaps(undefined);
  return {
    modes: [...new Set(list.flatMap((c) => c.modes))],
    min_k: Math.min(...list.map((c) => c.min_k)),
    max_k: Math.max(...list.map((c) => c.max_k)),
    effects: [...new Set(list.flatMap((c) => c.effects))],
    features: list.reduce((f, c) => f | c.features, 0),
  };
}

export type ColorKind = 'preset' | 'kelvin' | 'rgb' | 'rgbw' | 'rgbww' | 'hs' | 'xy' | 'white' | 'none';

export function colorKind(c: string | undefined): ColorKind {
  const s = String(c ?? '').toLowerCase();
  if (PRESETS.some(([p]) => p === s)) return 'preset';
  if (s.startsWith('k:')) return 'kelvin';
  if (s.startsWith('#')) return 'rgb';
  const m = s.match(/^(rgbww|rgbw|hs|xy):/);
  if (m) return m[1] as ColorKind;
  if (s === 'white') return 'white';
  return 'none';
}

export const nums = (c: string) => (c.split(':')[1] ?? '').split(',').map(Number);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const hex2 = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');

export function rgbToHex(r: number, g: number, b: number): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

export function hexToRgb(h: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
  const v = m ? m[1] : 'ffffff';
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

export function kelvinToRgb(k: number): [number, number, number] {
  const tt = clamp(k, 1000, 40000) / 100;
  const r = tt <= 66 ? 255 : 329.698727446 * (tt - 60) ** -0.1332047592;
  const g = tt <= 66 ? 99.4708025861 * Math.log(tt) - 161.1195681661 : 288.1221695283 * (tt - 60) ** -0.0755148492;
  const b = tt >= 66 ? 255 : tt <= 19 ? 0 : 138.5177312231 * Math.log(tt - 10) - 305.0447927307;
  return [clamp(Math.round(r), 0, 255), clamp(Math.round(g), 0, 255), clamp(Math.round(b), 0, 255)];
}

export function hsToRgb(h: number, s: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return 255 * (1 - (s / 100) * Math.max(0, Math.min(k, 4 - k, 1)));
  };
  return [Math.round(f(5)), Math.round(f(3)), Math.round(f(1))];
}

export function rgbToHs(r: number, g: number, b: number): [number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [Math.round(((h * 60 + 360) % 360) * 10) / 10, max ? Math.round((d / max) * 1000) / 10 : 0];
}

/** xy at full brightness → RGB exactly like Home Assistant (color_xy_to_RGB, the inverse "Wide RGB D65") */
export function xyToRgb(x: number, y: number): [number, number, number] {
  const yy = Math.max(y, 1e-11);
  const X = x / yy;
  const Z = (1 - x - y) / yy;
  const lin = [X * 1.656492 - 0.354851 - Z * 0.255038, -X * 0.707196 + 1.655397 + Z * 0.036152, X * 0.051713 - 0.121364 + Z * 1.01153];
  const rgb = lin.map((c) => Math.max(0, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
  const m = Math.max(...rgb);
  return rgb.map((c) => Math.trunc((m > 1 ? c / m : c) * 255)) as [number, number, number];
}

/** RGB → xy exactly like Home Assistant (color_RGB_to_xy: "Wide RGB D65", 3 decimals; lightspec.py rgb_to_xy) */
export function rgbToXy(r: number, g: number, b: number): [number, number] {
  const lin = (c: number) => ((c /= 255) > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92);
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const X = R * 0.664511 + G * 0.154324 + B * 0.162028;
  const Y = R * 0.283881 + G * 0.668433 + B * 0.047685;
  const Z = R * 0.000088 + G * 0.07231 + B * 0.986039;
  const s = X + Y + Z;
  if (!s) return [0.3127, 0.329];
  return [Math.round((X / s) * 1000) / 1000, Math.round((Y / s) * 1000) / 1000];
}

export const PRESET_K: Record<string, number> = { kerze: 2200, warm: 2700, neutral: 4000, kalt: 5500 };

/** any colour string → RGB (for the swatch and to switch between formats) */
export function toRgb(c: string | undefined): [number, number, number] {
  const s = String(c ?? '').toLowerCase();
  const n = nums(s);
  switch (colorKind(s)) {
    case 'preset':
      return kelvinToRgb(PRESET_K[s]);
    case 'kelvin':
      return kelvinToRgb(n[0]);
    case 'rgb':
      return hexToRgb(s);
    case 'rgbw': {
      const out = [n[0] + n[3], n[1] + n[3], n[2] + n[3]];
      const f = Math.max(...n.slice(0, 4)) / (Math.max(...out) || 1);
      return out.map((x) => Math.round(x * f)) as [number, number, number];
    }
    case 'rgbww': {
      const cw = kelvinToRgb(6500);
      const ww = kelvinToRgb(2700);
      const out = [0, 1, 2].map((i) => n[i] + (n[3] * cw[i]) / 255 + (n[4] * ww[i]) / 255);
      const f = Math.max(...n) / (Math.max(...out) || 1);
      return out.map((x) => Math.round(x * f)) as [number, number, number];
    }
    case 'hs':
      return hsToRgb(n[0], n[1]);
    case 'xy':
      return xyToRgb(n[0], n[1]);
    default:
      return [255, 236, 210];
  }
}

/** the same colour in another format of the picker */
export function convert(c: string, to: 'rgb' | 'rgbw' | 'rgbww' | 'hs' | 'xy'): string {
  const [r, g, b] = toRgb(c);
  if (to === 'rgb') return rgbToHex(r, g, b);
  if (to === 'hs') return `hs:${rgbToHs(r, g, b).join(',')}`;
  if (to === 'xy') return `xy:${rgbToXy(r, g, b).join(',')}`;
  const w = Math.min(r, g, b);
  const rest = [r - w, g - w, b - w];
  const f = Math.max(r, g, b) / (Math.max(...rest, w) || 1);
  const [rr, gg, bb, ww] = [...rest, w].map((x) => Math.round(x * f));
  return to === 'rgbw' ? `rgbw:${rr},${gg},${bb},${ww}` : `rgbww:${rr},${gg},${bb},${Math.ceil(ww / 2)},${Math.floor(ww / 2)}`;
}

export const cssColor = (c: string | undefined) => {
  const [r, g, b] = toRgb(c);
  return `rgb(${r},${g},${b})`;
};

/** how a colour reads: "warm", "3200 K", "#ff8800", "RGBW 255,0,0,40" */
export function colorText(c: string | undefined): string {
  const s = String(c ?? '');
  const kind = colorKind(s);
  if (kind === 'preset') return t(PRESETS.find(([p]) => p === s)![1]);
  if (kind === 'kelvin') return `${s.slice(2)} K`;
  if (kind === 'rgb') return s;
  if (kind === 'white') return t('light.white_channel');
  if (kind === 'none') return t('light.keep_color');
  return `${kind.toUpperCase()} ${s.split(':')[1]}`;
}

/** a light setting in a few words: "an, 60 %, warm, Effekt „candle“" */
export function lightText(a: Partial<LightAction> | undefined): string {
  const x = a ?? {};
  if (x.mode === 'off') return t('light.off');
  if (x.mode === 'scene') return t('light.scene_x', { scene: x.scene || '…' });
  const parts = [x.bri != null && typeof x.bri === 'number' ? `${x.bri}/255` : x.brightness != null ? `${x.brightness}${typeof x.brightness === 'number' ? ' %' : ''}` : '', x.color ? colorText(x.color) : ''];
  if (x.effect) parts.push(t('light.effect_x', { effect: x.effect }));
  if (x.transition) parts.push(t('light.fade_x', { n: x.transition }));
  if (x.flash) parts.push(t(x.flash === 'long' ? 'light.flash_long' : 'light.flash_short'));
  if (x.per_light && Object.keys(x.per_light).length) parts.push(t('light.each_own'));
  return parts.filter(Boolean).join(', ');
}
