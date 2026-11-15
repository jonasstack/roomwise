import { svg, type SVGTemplateResult } from 'lit';
import type { FloorMaterial, FloorType } from './types';
import { getLanguage } from './i18n';

/** Floor materials as SVG patterns in plan units (1 unit ≈ 1 cm). */

export interface FloorTypeInfo {
  type: FloorType;
  de: string;
  en: string;
  /** default color */
  color: string;
  /** default tile size (cm) where applicable */
  size?: number;
  palette: 'wood' | 'tile' | 'carpet' | 'garden';
  /** Meant for outdoor areas (offered first there) */
  outdoor?: boolean;
}

export const FLOOR_TYPES: FloorTypeInfo[] = [
  { type: 'planks', de: 'Dielen', en: 'Planks', color: '#d2a878', palette: 'wood' },
  { type: 'herringbone', de: 'Fischgrät', en: 'Herringbone', color: '#c99a62', palette: 'wood' },
  { type: 'tiles', de: 'Fliesen', en: 'Tiles', color: '#e4e2dd', size: 60, palette: 'tile' },
  { type: 'hex', de: 'Sechseck', en: 'Hexagon', color: '#a8b8a0', size: 20, palette: 'tile' },
  { type: 'checker', de: 'Schachbrett', en: 'Checker', color: '#2c2c2e', size: 30, palette: 'tile' },
  { type: 'carpet', de: 'Teppich', en: 'Carpet', color: '#b9b2a6', palette: 'carpet' },
  { type: 'color', de: 'Farbe', en: 'Color', color: '#e9e6e0', palette: 'tile' },
  { type: 'concrete', de: 'Beton / Estrich', en: 'Concrete', color: '#b4b2ad', size: 300, palette: 'tile' },
  { type: 'grass', de: 'Rasen', en: 'Lawn', color: '#7fae5f', palette: 'garden', outdoor: true },
  { type: 'paving', de: 'Pflaster', en: 'Paving', color: '#b7b0a6', size: 20, palette: 'tile', outdoor: true },
  { type: 'decking', de: 'Holzdeck', en: 'Decking', color: '#a87b4f', palette: 'wood', outdoor: true },
  { type: 'gravel', de: 'Kies', en: 'Gravel', color: '#c9c1b2', palette: 'tile', outdoor: true },
  { type: 'soil', de: 'Beet / Erde', en: 'Soil', color: '#6b4a36', palette: 'garden', outdoor: true },
  { type: 'water', de: 'Wasser', en: 'Water', color: '#4fa8d0', palette: 'garden', outdoor: true },
];

export const FLOOR_TYPE = new Map(FLOOR_TYPES.map((f) => [f.type, f]));

/** A named colour: German name, English name */
export interface NamedColor {
  name: string;
  en: string;
  color: string;
}

/** Name of a palette colour in the card's language */
export const colorName = (c: { name: string; en?: string }) => (getLanguage() === 'en' && c.en ? c.en : c.name);

export const PALETTES: Record<string, NamedColor[]> = {
  wood: [
    { name: 'Eiche hell', en: 'Light oak', color: '#e3c9a0' },
    { name: 'Eiche natur', en: 'Natural oak', color: '#d2a878' },
    { name: 'Eiche geräuchert', en: 'Smoked oak', color: '#a87b4f' },
    { name: 'Nussbaum', en: 'Walnut', color: '#7d5639' },
    { name: 'Grau-Eiche', en: 'Grey oak', color: '#b8afa4' },
    { name: 'Weiß geölt', en: 'White oiled', color: '#efe7da' },
  ],
  tile: [
    { name: 'Weiß', en: 'White', color: '#f4f4f2' },
    { name: 'Hellgrau', en: 'Light grey', color: '#d9d9d6' },
    { name: 'Beton', en: 'Concrete', color: '#a9a8a3' },
    { name: 'Anthrazit', en: 'Anthracite', color: '#4a4a4c' },
    { name: 'Sand', en: 'Sand', color: '#e2d5bf' },
    { name: 'Terrakotta', en: 'Terracotta', color: '#c8714e' },
    { name: 'Salbei', en: 'Sage', color: '#a8b8a0' },
    { name: 'Taubenblau', en: 'Dove blue', color: '#8fa9c0' },
    { name: 'Petrol', en: 'Petrol', color: '#3f6f73' },
    { name: 'Schwarz', en: 'Black', color: '#2a2a2c' },
  ],
  garden: [
    { name: 'Rasen', en: 'Lawn', color: '#7fae5f' },
    { name: 'Sattgrün', en: 'Deep green', color: '#5f9a4a' },
    { name: 'Trockenrasen', en: 'Dry grass', color: '#a4b26a' },
    { name: 'Moos', en: 'Moss', color: '#6f8a52' },
    { name: 'Erde', en: 'Soil', color: '#6b4a36' },
    { name: 'Rindenmulch', en: 'Bark mulch', color: '#5a3e2c' },
    { name: 'Wasser', en: 'Water', color: '#4fa8d0' },
    { name: 'Teich', en: 'Pond', color: '#3f7f9a' },
  ],
  carpet: [
    { name: 'Greige', en: 'Greige', color: '#b9b2a6' },
    { name: 'Hellgrau', en: 'Light grey', color: '#c9c9c6' },
    { name: 'Graphit', en: 'Graphite', color: '#5b5b5f' },
    { name: 'Creme', en: 'Cream', color: '#e8dfcc' },
    { name: 'Moos', en: 'Moss', color: '#8a9478' },
    { name: 'Rost', en: 'Rust', color: '#a65f42' },
  ],
};

export const floorTypeLabel = (f: FloorTypeInfo) => (getLanguage() === 'en' ? f.en : f.de);

// ---------- color helpers ----------

function parse(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return isNaN(n) ? [200, 200, 200] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Lighten (pct > 0) or darken (pct < 0) a hex color. */
export function shade(hex: string, pct: number): string {
  const [r, g, b] = parse(hex);
  const f = (c: number) => Math.round(pct >= 0 ? c + (255 - c) * pct : c * (1 + pct));
  return `rgb(${f(r)}, ${f(g)}, ${f(b)})`;
}

function luminance(hex: string) {
  const [r, g, b] = parse(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

const hash = (a: number, b: number) => {
  const x = Math.sin(a * 91.7 + b * 47.3) * 9301.13;
  return x - Math.floor(x);
};

// ---------- patterns ----------

/** <pattern> element for a floor material. Returns undefined for plain room color. */
export function floorPattern(id: string, m: FloorMaterial | undefined): SVGTemplateResult | undefined {
  if (!m || !m.type || m.type === 'none') return undefined;
  const info = FLOOR_TYPE.get(m.type);
  const color = m.color ?? info?.color ?? '#cccccc';
  switch (m.type) {
    case 'color':
      return svg`<pattern id=${id} width="100" height="100" patternUnits="userSpaceOnUse"><rect width="100" height="100" fill=${color}></rect></pattern>`;
    case 'carpet': {
      const dot = shade(color, luminance(color) > 0.5 ? -0.07 : 0.08);
      return svg`<pattern id=${id} width="6" height="6" patternUnits="userSpaceOnUse">
        <rect width="6" height="6" fill=${color}></rect>
        <circle cx="1.5" cy="1.5" r="0.9" fill=${dot}></circle><circle cx="4.5" cy="4.5" r="0.9" fill=${dot}></circle>
      </pattern>`;
    }
    case 'planks':
      return planks(id, color, m.angle ?? 0);
    case 'herringbone':
      return herringbone(id, color, m.angle ?? 0);
    case 'tiles':
      return tiles(id, color, m.size ?? info?.size ?? 60, m.angle ?? 0);
    case 'checker':
      return checker(id, color, m.size ?? info?.size ?? 30, m.angle ?? 0);
    case 'hex':
      return hex(id, color, m.size ?? info?.size ?? 20, m.angle ?? 0);
    case 'grass':
      return grass(id, color, m.angle ?? 0);
    case 'paving':
      return paving(id, color, m.size ?? info?.size ?? 20, m.angle ?? 0);
    case 'decking':
      return decking(id, color, m.angle ?? 0);
    case 'gravel':
      return gravel(id, color);
    case 'concrete':
      return concrete(id, color, m.size ?? info?.size ?? 300, m.angle ?? 0);
    case 'soil':
      return soil(id, color);
    case 'water':
      return water(id, color);
  }
  return undefined;
}

/** Lawn: mowing stripes and fine blades */
function grass(id: string, color: string, angle: number) {
  const S = 120;
  const blades: SVGTemplateResult[] = [];
  for (let i = 0; i < 70; i++) {
    const x = hash(i, 1) * S;
    const y = hash(i, 2) * S * 2;
    const c = hash(i, 3) > 0.5 ? shade(color, -0.12) : shade(color, 0.1);
    blades.push(svg`<line x1=${x.toFixed(1)} y1=${y.toFixed(1)} x2=${(x + (hash(i, 4) - 0.5) * 3).toFixed(1)} y2=${(y - 3 - hash(i, 5) * 3).toFixed(1)} stroke=${c} stroke-width="0.8" stroke-linecap="round"></line>`);
  }
  return svg`<pattern id=${id} width=${S} height=${S * 2} patternUnits="userSpaceOnUse" patternTransform=${`rotate(${angle})`}>
    <rect width=${S} height=${S * 2} fill=${color}></rect>
    <rect width=${S / 2} height=${S * 2} fill=${shade(color, 0.06)}></rect>
    ${blades}
  </pattern>`;
}

/** Paving stones in running bond */
function paving(id: string, color: string, size: number, angle: number) {
  const w = size;
  const h = size * 0.5;
  const j = grout(color);
  const sh = [shade(color, 0.05), color, shade(color, -0.05), shade(color, 0.02)];
  const stones: SVGTemplateResult[] = [];
  for (let row = 0; row < 4; row++)
    for (let k = -1; k < 4; k++) {
      const x = (k + (row % 2) * 0.5) * w;
      stones.push(svg`<rect x=${x + 0.6} y=${row * h + 0.6} width=${w - 1.2} height=${h - 1.2} rx="1.2" fill=${sh[Math.floor(hash(row, k + 5) * sh.length)]}></rect>`);
    }
  return svg`<pattern id=${id} width=${w * 3} height=${h * 4} patternUnits="userSpaceOnUse" patternTransform=${`rotate(${angle})`}><rect width=${w * 3} height=${h * 4} fill=${j}></rect>${stones}</pattern>`;
}

/** Decking boards with gaps */
function decking(id: string, color: string, angle: number) {
  const W = 14;
  const L = 400;
  const sh = woodShades(color);
  const boards = [0, 1, 2, 3].map((r) => svg`<rect x="0" y=${r * W + 0.6} width=${L} height=${W - 1.2} fill=${sh[r % sh.length]}></rect>
    <line x1="0" y1=${r * W + W * 0.35} x2=${L} y2=${r * W + W * 0.35} stroke=${shade(color, -0.08)} stroke-width="0.5"></line>`);
  return svg`<pattern id=${id} width=${L} height=${W * 4} patternUnits="userSpaceOnUse" patternTransform=${`rotate(${angle})`}><rect width=${L} height=${W * 4} fill=${shade(color, -0.45)}></rect>${boards}</pattern>`;
}

function gravel(id: string, color: string) {
  const S = 24;
  const dots = Array.from({ length: 40 }, (_, i) => svg`<circle cx=${(hash(i, 7) * S).toFixed(1)} cy=${(hash(i, 8) * S).toFixed(1)} r=${(0.7 + hash(i, 9) * 1.1).toFixed(2)} fill=${shade(color, (hash(i, 10) - 0.5) * 0.4)}></circle>`);
  return svg`<pattern id=${id} width=${S} height=${S} patternUnits="userSpaceOnUse"><rect width=${S} height=${S} fill=${color}></rect>${dots}</pattern>`;
}

/** Concrete / screed (garage, utility room): fine speckles and cut joints every few metres */
function concrete(id: string, color: string, size: number, angle: number) {
  const S = Math.max(100, size);
  const specks = Array.from({ length: 60 }, (_, i) => svg`<circle cx=${(hash(i, 21) * S).toFixed(1)} cy=${(hash(i, 22) * S).toFixed(1)} r=${(0.6 + hash(i, 23) * 0.9).toFixed(2)} fill=${shade(color, (hash(i, 24) - 0.5) * 0.18)}></circle>`);
  return svg`<pattern id=${id} width=${S} height=${S} patternUnits="userSpaceOnUse" patternTransform=${`rotate(${angle})`}>
    <rect width=${S} height=${S} fill=${color}></rect>${specks}
    <path d=${`M 0 0.5 H ${S} M 0.5 0 V ${S}`} stroke=${shade(color, -0.14)} stroke-width="1"></path>
  </pattern>`;
}

function soil(id: string, color: string) {
  const S = 30;
  const dots = Array.from({ length: 26 }, (_, i) => svg`<ellipse cx=${(hash(i, 11) * S).toFixed(1)} cy=${(hash(i, 12) * S).toFixed(1)} rx=${(0.8 + hash(i, 13) * 1.6).toFixed(2)} ry="0.8" fill=${shade(color, (hash(i, 14) - 0.5) * 0.35)}></ellipse>`);
  return svg`<pattern id=${id} width=${S} height=${S} patternUnits="userSpaceOnUse"><rect width=${S} height=${S} fill=${color}></rect>${dots}</pattern>`;
}

function water(id: string, color: string) {
  const S = 80;
  return svg`<pattern id=${id} width=${S} height=${S / 2} patternUnits="userSpaceOnUse">
    <rect width=${S} height=${S / 2} fill=${color}></rect>
    <path d=${`M 0 12 q 10 -4 20 0 t 20 0 t 20 0 t 20 0`} fill="none" stroke=${shade(color, 0.25)} stroke-width="1.2" opacity="0.7"></path>
    <path d=${`M -10 30 q 10 -4 20 0 t 20 0 t 20 0 t 20 0 t 20 0`} fill="none" stroke=${shade(color, 0.18)} stroke-width="1" opacity="0.5"></path>
  </pattern>`;
}

function woodShades(color: string) {
  return [shade(color, 0.04), color, shade(color, -0.05), shade(color, 0.02), shade(color, -0.08), shade(color, 0.06)];
}

/** Staggered floorboards: 20 cm wide, 120 cm long, four row offsets. */
function planks(id: string, color: string, angle: number) {
  const W = 20;
  const L = 120;
  const offs = [0, 0.5, 0.25, 0.75];
  const sh = woodShades(color);
  const seam = shade(color, -0.22);
  const grain = shade(color, -0.1);
  const rects: SVGTemplateResult[] = [];
  offs.forEach((o, row) => {
    for (let k = -1; k <= 1; k++) {
      const x = (o + k) * L;
      const c = sh[Math.floor(hash(row, k + 3) * sh.length)];
      rects.push(svg`<rect x=${x} y=${row * W} width=${L} height=${W} fill=${c} stroke=${seam} stroke-width="0.7"></rect>`);
      // subtle grain line (derived from the base hex color, slightly darker)
      rects.push(svg`<line x1=${x + 8} y1=${row * W + W * 0.35} x2=${x + L * 0.7} y2=${row * W + W * 0.4} stroke=${grain} stroke-width="0.6"></line>`);
    }
  });
  return svg`<pattern id=${id} width=${L} height=${W * 4} patternUnits="userSpaceOnUse" patternTransform=${`rotate(${angle})`}>${rects}</pattern>`;
}

/**
 * Herringbone: planks W×L (L = 4W). Lattice vectors (W, W) and (L, −L) with a horizontal and a
 * vertical plank per cell; rectangular period 2L × 2L, rotated 45°.
 */
function herringbone(id: string, color: string, angle: number) {
  const W = 9;
  const L = 36;
  const P = 2 * L;
  const sh = woodShades(color);
  const seam = shade(color, -0.22);
  const rects: SVGTemplateResult[] = [];
  for (let m = -16; m <= 16; m++)
    for (let n = -4; n <= 4; n++) {
      const ox = m * W + n * L;
      const oy = m * W - n * L;
      const hRect = [ox, oy, L, W];
      const vRect = [ox, oy + W, W, L];
      for (const [i, [x, y, w, h]] of [hRect, vRect].entries()) {
        if (x > P || y > P || x + w < 0 || y + h < 0) continue;
        const c = sh[Math.floor(hash(((m % 8) + 8) % 8, ((n % 2) + 2) % 2 + i * 3) * sh.length)];
        rects.push(svg`<rect x=${x} y=${y} width=${w} height=${h} fill=${c} stroke=${seam} stroke-width="0.6"></rect>`);
      }
    }
  return svg`<pattern id=${id} width=${P} height=${P} patternUnits="userSpaceOnUse" patternTransform=${`rotate(${45 + angle})`}>${rects}</pattern>`;
}

function grout(color: string) {
  return luminance(color) > 0.55 ? shade(color, -0.16) : shade(color, 0.22);
}

function tiles(id: string, color: string, size: number, angle: number) {
  const g = Math.max(0.8, size * 0.025);
  return svg`<pattern id=${id} width=${size} height=${size} patternUnits="userSpaceOnUse" patternTransform=${`rotate(${angle})`}>
    <rect width=${size} height=${size} fill=${grout(color)}></rect>
    <rect x=${g / 2} y=${g / 2} width=${size - g} height=${size - g} rx=${g * 0.6} fill=${color}></rect>
    <rect x=${g / 2} y=${g / 2} width=${size - g} height=${(size - g) * 0.5} rx=${g * 0.6} fill=${shade(color, 0.04)}></rect>
  </pattern>`;
}

function checker(id: string, color: string, size: number, angle: number) {
  const other = luminance(color) > 0.5 ? '#2c2c2e' : '#f2f1ee';
  const g = Math.max(0.6, size * 0.02);
  const gc = shade(luminance(color) > 0.5 ? color : other, -0.18);
  return svg`<pattern id=${id} width=${size * 2} height=${size * 2} patternUnits="userSpaceOnUse" patternTransform=${`rotate(${angle})`}>
    <rect width=${size * 2} height=${size * 2} fill=${gc}></rect>
    <rect x=${g / 2} y=${g / 2} width=${size - g} height=${size - g} fill=${color}></rect>
    <rect x=${size + g / 2} y=${size + g / 2} width=${size - g} height=${size - g} fill=${color}></rect>
    <rect x=${size + g / 2} y=${g / 2} width=${size - g} height=${size - g} fill=${other}></rect>
    <rect x=${g / 2} y=${size + g / 2} width=${size - g} height=${size - g} fill=${other}></rect>
  </pattern>`;
}

/** Pointy-top hexagons with radius r = size / 2. */
function hex(id: string, color: string, size: number, angle: number) {
  const r = size / 2;
  const w = Math.sqrt(3) * r;
  const h = 3 * r;
  const poly = (cx: number, cy: number) =>
    Array.from({ length: 6 }, (_, i) => {
      const a = ((60 * i - 30) * Math.PI) / 180;
      return `${(cx + r * 0.94 * Math.cos(a)).toFixed(2)},${(cy + r * 0.94 * Math.sin(a)).toFixed(2)}`;
    }).join(' ');
  const centers: [number, number][] = [
    [w / 2, r],
    [0, r * 2.5],
    [w, r * 2.5],
    [w / 2, r * 4],
    [0, -r * 0.5],
    [w, -r * 0.5],
  ];
  return svg`<pattern id=${id} width=${w} height=${h} patternUnits="userSpaceOnUse" patternTransform=${`rotate(${angle})`}>
    <rect width=${w} height=${h} fill=${grout(color)}></rect>
    ${centers.map(([x, y]) => svg`<polygon points=${poly(x, y)} fill=${color}></polygon>`)}
  </pattern>`;
}

/** Wall paints (interior/exterior). */
export const WALL_PAINTS: NamedColor[] = [
  { name: 'Weiß', en: 'White', color: '#f7f7f5' },
  { name: 'Altweiß', en: 'Off-white', color: '#f1ece2' },
  { name: 'Hellgrau', en: 'Light grey', color: '#dcdcd8' },
  { name: 'Greige', en: 'Greige', color: '#cfc6b8' },
  { name: 'Sand', en: 'Sand', color: '#e3d3b5' },
  { name: 'Salbei', en: 'Sage', color: '#b9c4ae' },
  { name: 'Taubenblau', en: 'Dove blue', color: '#a9b9c9' },
  { name: 'Rosé', en: 'Rosé', color: '#e6c9c1' },
  { name: 'Terrakotta', en: 'Terracotta', color: '#c98b6b' },
  { name: 'Ocker', en: 'Ochre', color: '#d9b25f' },
  { name: 'Petrol', en: 'Petrol', color: '#4f7a7d' },
  { name: 'Anthrazit', en: 'Anthracite', color: '#4b4b4d' },
];
