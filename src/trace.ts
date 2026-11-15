import type { HomeAssistant, Point, TraceImage } from './types';
import { loadImage } from './shared-plans';

/**
 * Trace images: a photo or scan of a floor plan under a floor in the editor, to draw the rooms on. The picture is
 * resized in the browser before it is kept anywhere — in the companion integration (up to 2400 px, about 1 MB) or,
 * without it, small right in the card config (up to 1200 px, about 250 KB) so the dashboard stays quick to load.
 */

/** Where the picture will be kept decides how big it may be */
export const TRACE_LIMITS = {
  companion: { side: 2400, bytes: 1_400_000 },
  inline: { side: 1200, bytes: 250_000 },
} as const;

export const TRACE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/svg+xml'];

export interface ProcessedImage {
  data: string;
  width: number;
  height: number;
}

/** Decodes a picture file and re-encodes it as JPEG, smaller until it fits (`undefined`: not a readable picture) */
export async function processImage(file: Blob, limit: { side: number; bytes: number }): Promise<ProcessedImage | undefined> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const w0 = img.naturalWidth || 1000;
    const h0 = img.naturalHeight || 1000;
    let side = Math.min(limit.side, Math.max(w0, h0));
    for (let attempt = 0; attempt < 8; attempt++) {
      const k = side / Math.max(w0, h0);
      const w = Math.max(1, Math.round(w0 * k));
      const h = Math.max(1, Math.round(h0 * k));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return undefined;
      // transparent scans become white paper, not black
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      for (const q of [0.82, 0.7, 0.58]) {
        const data = canvas.toDataURL('image/jpeg', q);
        if (data.length <= limit.bytes) return { data, width: w, height: h };
      }
      side = Math.round(side * 0.75);
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const traceHeight = (tr: TraceImage) => tr.w * (tr.ratio || 1);
export const traceCenter = (tr: TraceImage): Point => [tr.x + tr.w / 2, tr.y + traceHeight(tr) / 2];

/** The four corners of the placed picture (plan units), for its outline in the editor */
export function traceCorners(tr: TraceImage): Point[] {
  const [cx, cy] = traceCenter(tr);
  const a = ((tr.rotation ?? 0) * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const hw = tr.w / 2;
  const hh = traceHeight(tr) / 2;
  return ([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as Point[]).map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
}

/** Scale the picture so the distance between two marked points becomes `cm`; the first point stays where it is */
export function calibrate(tr: TraceImage, p0: Point, p1: Point, cm: number): TraceImage {
  const measured = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  if (!(measured > 0) || !(cm > 0)) return tr;
  const f = cm / measured;
  const [cx, cy] = traceCenter(tr);
  const nc: Point = [p0[0] + (cx - p0[0]) * f, p0[1] + (cy - p0[1]) * f];
  const w = tr.w * f;
  const h = w * (tr.ratio || 1);
  return { ...tr, w: round1(w), x: round1(nc[0] - w / 2), y: round1(nc[1] - h / 2) };
}

const round1 = (v: number) => Math.round(v * 10) / 10;

// picture data by id for synchronous rendering (the promise cache lives in shared-plans)
const ready = new Map<string, string>();
const asked = new Map<string, Set<() => void>>();

/** The picture to draw: inline, a picture just loaded in the editor (`pending`), or the companion's (loaded once,
 *  then `onLoad` asks for a new render) */
export function traceHref(hass: HomeAssistant | undefined, tr: TraceImage | undefined, onLoad: () => void, pending?: Map<string, ProcessedImage>): string | undefined {
  if (!tr) return undefined;
  if (tr.src) return tr.src;
  const id = tr.image;
  if (!id) return undefined;
  const p = pending?.get(id);
  if (p) return p.data;
  const have = ready.get(id);
  if (have) return have;
  if (!hass) return undefined;
  const waiting = asked.get(id);
  if (waiting) {
    waiting.add(onLoad);
    return undefined;
  }
  const cbs = new Set([onLoad]);
  asked.set(id, cbs);
  void loadImage(hass, id).then((data) => {
    asked.delete(id);
    if (!data) return;
    ready.set(id, data);
    for (const cb of cbs) cb();
  });
  return undefined;
}

/** Remember an uploaded picture under its new id (no second download) */
export function rememberImage(id: string, data: string) {
  ready.set(id, data);
}
