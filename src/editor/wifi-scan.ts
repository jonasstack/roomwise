import { wifiParse } from '../wifi-qr';

type Found = string | undefined;

/** The browser's own reader (Chrome/Edge on Android, ChromeOS, macOS; Safari 17+): fast and good with photos */
async function nativeScan(bmp: ImageBitmap): Promise<string[]> {
  const BD = (globalThis as { BarcodeDetector?: new (o: { formats: string[] }) => { detect(s: ImageBitmapSource): Promise<{ rawValue: string }[]> } }).BarcodeDetector;
  if (!BD) return [];
  try {
    const found = await new BD({ formats: ['qr_code'] }).detect(bmp);
    return found.map((f) => f.rawValue).filter(Boolean);
  } catch {
    return [];
  }
}

/** Reads the Wi-Fi QR code in a picture (a photo of the router's sticker, a printed guest Wi-Fi card) in the browser.
 *  First the browser's own reader, then jsQR (Apache-2.0, vendored, fetched only here) over several sizes and
 *  crops – a sticker photo often holds a small, slightly blurry code next to other codes and text.
 *  'no_qr': no QR code found, 'not_wifi': only other codes. */
export async function scanWifiImage(file: Blob) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
    .catch(() => createImageBitmap(file))
    .catch(() => {
      const e = new Error('picture cannot be decoded');
      e.name = 'bad_image';
      throw e;
    });
  const seen: string[] = [];
  const pick = (texts: string[]): Found => {
    for (const s of texts) if (!seen.includes(s)) seen.push(s);
    return texts.find((s) => wifiParse(s));
  };
  try {
    let hit = pick(await nativeScan(bmp));
    if (!hit) {
      // the vendored file is a UMD bundle: in the browser build it registers itself on the global object
      // instead of as the module's default export – take whichever is there
      const mod = (await import('../vendor/jsqr/jsQR.js')) as { default?: typeof import('../vendor/jsqr/jsQR.js').default };
      const jsQR = mod.default ?? (globalThis as unknown as { jsQR?: typeof import('../vendor/jsqr/jsQR.js').default }).jsQR;
      if (typeof jsQR !== 'function') throw new Error('QR reader not loaded');
      const W = bmp.width;
      const H = bmp.height;
      const canvas = document.createElement('canvas');
      const g = canvas.getContext('2d', { willReadFrequently: true })!;
      // [crop x, y, w, h as fractions] × long side in px
      const crops: [number, number, number, number][] = [
        [0, 0, 1, 1],
        [0.2, 0.2, 0.6, 0.6],
        [0, 0, 0.6, 0.6], [0.4, 0, 0.6, 0.6], [0, 0.4, 0.6, 0.6], [0.4, 0.4, 0.6, 0.6],
      ];
      const sizes = [1200, 2000, 800];
      outer: for (const [cx, cy, cw, ch] of crops) {
        for (const size of sizes) {
          const sw = W * cw;
          const sh = H * ch;
          const k = Math.min(cx === 0 && cw === 1 ? 1 : 2.5, size / Math.max(sw, sh));
          const w = Math.max(1, Math.round(sw * k));
          const h = Math.max(1, Math.round(sh * k));
          canvas.width = w;
          canvas.height = h;
          g.imageSmoothingQuality = 'high';
          g.drawImage(bmp, W * cx, H * cy, sw, sh, 0, 0, w, h);
          const code = jsQR(g.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
          if (code?.data) {
            hit = pick([code.data]);
            if (hit) break outer;
          }
          // let the page breathe between passes on a slow tablet
          await new Promise((r) => setTimeout(r, 0));
        }
      }
    }
    if (hit) return { net: wifiParse(hit)!, error: undefined };
    return { net: undefined, error: seen.length ? ('not_wifi' as const) : ('no_qr' as const) };
  } finally {
    bmp.close();
  }
}
