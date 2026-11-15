/**
 * Rasterizes the static part of the plan's floor SVG (rooms, floor materials, sun beams, door swings,
 * label leaders) into a canvas, so WebGL can draw the floor as one textured plane. The live SVG is
 * cloned with its computed styles inlined (CSS variables, theme), so the texture looks exactly like the
 * SVG did. Dynamic layers (room light, lamp pools, night tint, focus) are drawn by WebGL separately.
 */
const STYLE_PROPS = [
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  'display',
  'stop-color',
  'stop-opacity',
];

/** Layers: static (rarely changes) and dynamic (lights, pools, focus) — by top-level group class */
export const FLOOR_STATIC = ['below', 'rooms', 'floors', 'stairwell', 'beams', 'leaders'];
// door swings and window sashes are not drawn on the 3D floor: real leaves and sashes show their state
export const FLOOR_DYNAMIC = ['occ', 'glows', 'ffxs', 'hrmarks', 'spills', 'focus-dim'];
const KEEP_TAGS = new Set(['defs', 'clipPath', 'mask', 'radialGradient', 'linearGradient', 'pattern']);

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Definitions each layer needs (by id) */
const DEFS: Record<'static' | 'dynamic', RegExp> = {
  static: /^fp-(floor|beam|clip|wall-mask)/,
  dynamic: /^fp-(ffx|glow|spill)/,
};

/**
 * Cheap content signature of a layer (markup of its groups and definitions): when a layer comes back
 * unchanged — e.g. after a trip through the 2D view — its texture is kept instead of rasterized again.
 */
export function layerSignature(svgEl: SVGSVGElement, keep: string[]): string {
  const layer: 'static' | 'dynamic' = keep === FLOOR_STATIC ? 'static' : 'dynamic';
  let sig = '';
  for (const el of svgEl.children) {
    if (el.tagName === 'defs') {
      for (const d of el.children) if (DEFS[layer].test(d.id)) sig += d.outerHTML;
      continue;
    }
    const cls = (el.getAttribute('class') ?? '').split(/\s+/);
    if (cls.some((c) => keep.includes(c))) sig += el.outerHTML;
  }
  // a short hash keeps the comparison and memory small
  let h1 = 0x811c9dc5;
  let h2 = 0;
  for (let i = 0; i < sig.length; i++) {
    const c = sig.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = (h2 * 31 + c) | 0;
  }
  return `${sig.length}:${h1 >>> 0}:${h2 >>> 0}`;
}

export async function rasterizeFloor(svgEl: SVGSVGElement, region: Region, maxPx: number, keep: string[]): Promise<HTMLCanvasElement | undefined> {
  const k = Math.min(maxPx / region.w, maxPx / region.h, 3);
  const pw = Math.max(16, Math.round(region.w * k));
  const ph = Math.max(16, Math.round(region.h * k));
  const layer: 'static' | 'dynamic' = keep === FLOOR_STATIC ? 'static' : 'dynamic';
  // build a fresh SVG from only the needed layers and definitions (cheap: no full clone)
  const clone = svgEl.cloneNode(false) as SVGSVGElement;
  const copy = (src: Element): Element => {
    const dst = src.cloneNode(true) as Element;
    const a = [src, ...src.querySelectorAll('*')];
    const b = [dst, ...dst.querySelectorAll('*')];
    for (let i = 0; i < a.length && i < b.length; i++) {
      const cs = getComputedStyle(a[i]);
      const st = (b[i] as SVGElement).style;
      if (!st) continue;
      for (const p of STYLE_PROPS) {
        const v = cs.getPropertyValue(p);
        if (v) st.setProperty(p, v);
      }
    }
    return dst;
  };
  for (const el of [...svgEl.children]) {
    if (el.tagName === 'defs') {
      const defs = el.cloneNode(false) as Element;
      for (const d of [...el.children]) if (DEFS[layer].test(d.id)) defs.appendChild(copy(d));
      if (defs.childElementCount) clone.appendChild(defs);
      continue;
    }
    if (KEEP_TAGS.has(el.tagName)) {
      if (DEFS[layer].test(el.id)) clone.appendChild(copy(el));
      continue;
    }
    const cls = (el.getAttribute('class') ?? '').split(/\s+/);
    if (cls.some((c) => keep.includes(c))) clone.appendChild(copy(el));
  }
  // door leaves, alert lines etc. inside openings are hidden in 3D anyway; drop alert highlights
  for (const el of [...clone.querySelectorAll('.alert-line')]) el.remove();
  clone.removeAttribute('class');
  clone.removeAttribute('style');
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('viewBox', `${region.x} ${region.y} ${region.w} ${region.h}`);
  clone.setAttribute('width', String(pw));
  clone.setAttribute('height', String(ph));
  clone.setAttribute('preserveAspectRatio', 'none');
  const text = new XMLSerializer().serializeToString(clone);
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
  try {
    await img.decode();
  } catch {
    return undefined;
  }
  const canvas = document.createElement('canvas');
  canvas.width = pw;
  canvas.height = ph;
  canvas.getContext('2d')!.drawImage(img, 0, 0, pw, ph);
  return canvas;
}
