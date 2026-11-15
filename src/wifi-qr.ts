/**
 * Wi-Fi QR codes: the join text phones understand (`WIFI:T:WPA;S:<ssid>;P:<password>;H:false;;`) and a small QR
 * encoder (byte mode, error correction M, versions 1–15: up to 412 bytes, more than any SSID + passphrase needs).
 * Only the Wi-Fi popup imports this (a chunk of its own).
 */

export type WifiSecurity = 'wpa' | 'wpa2' | 'wpa3' | 'nopass';

export interface WifiNetwork {
  id: string;
  name: string;
  ssid: string;
  password: string;
  security: WifiSecurity;
  hidden?: boolean;
  /** only admins see it (and its QR code) */
  admins_only?: boolean;
}

/** Backslash before the characters the format reserves. Hex-looking text is not quoted: phones that do not strip
 *  quotes would take them as part of a password like "12345678" */
export function wifiEscape(s: string): string {
  return s.replace(/([\\;,:"])/g, '\\$1');
}

/** The text in the QR code. WPA, WPA2 and WPA3 are all "WPA" (phones pick the method); WPA3 alone adds `R:1` (the
 *  Wi-Fi Alliance's transition-disable flag), so newer phones do not fall back to WPA2 */
export function wifiPayload(n: Pick<WifiNetwork, 'ssid' | 'password' | 'security' | 'hidden'>): string {
  const open = n.security === 'nopass' || !n.password;
  return (
    `WIFI:T:${open ? 'nopass' : 'WPA'};` +
    (!open && n.security === 'wpa3' ? 'R:1;' : '') +
    `S:${wifiEscape(n.ssid)};` +
    (open ? '' : `P:${wifiEscape(n.password)};`) +
    `H:${n.hidden ? 'true' : 'false'};;`
  );
}

// ---------- QR encoder (ISO/IEC 18004, byte mode, ECC level M) ----------

const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24];
const BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10];
const MAX_VERSION = 15;

function rawModules(ver: number): number {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const a = Math.floor(ver / 7) + 2;
    n -= (25 * a - 10) * a - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}
const dataCodewords = (ver: number) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * BLOCKS[ver];

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number): number[] {
  const r = new Array<number>(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      r[j] = gfMul(r[j], root);
      if (j + 1 < degree) r[j] ^= r[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return r;
}

function rsRemainder(data: number[], div: number[]): number[] {
  const r = new Array<number>(div.length).fill(0);
  for (const b of data) {
    const f = b ^ (r.shift() as number);
    r.push(0);
    div.forEach((c, i) => (r[i] ^= gfMul(c, f)));
  }
  return r;
}

function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = ver * 4 + 10; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

/** The QR code of a text as rows of dark (true) / light modules, without the quiet zone. Throws when too long. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = Array.from(new TextEncoder().encode(text));
  let ver = 1;
  for (; ver <= MAX_VERSION; ver++) if (4 + (ver < 10 ? 8 : 16) + bytes.length * 8 <= dataCodewords(ver) * 8) break;
  if (ver > MAX_VERSION) throw new Error('text too long for a QR code');

  // data bits: mode "byte", length, the bytes, terminator, padding
  const bits: number[] = [];
  const put = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  put(4, 4);
  put(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const cap = dataCodewords(ver) * 8;
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

  // error correction per block, interleaved
  const nBlocks = BLOCKS[ver];
  const eccLen = ECC_PER_BLOCK[ver];
  const raw = Math.floor(rawModules(ver) / 8);
  const nShort = nBlocks - (raw % nBlocks);
  const shortLen = Math.floor(raw / nBlocks);
  const div = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < nBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < nShort) dat.push(0);
    blocks.push([...dat, ...ecc]);
  }
  const words: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => (i !== shortLen - eccLen || j >= nShort) && words.push(b[i]));

  // function patterns
  const size = ver * 4 + 17;
  const mod = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    mod[y][x] = dark;
    fn[y][x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
  }
  const al = alignmentPositions(ver);
  al.forEach((ax, i) =>
    al.forEach((ay, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }),
  );
  const drawFormat = (mask: number) => {
    const d = (0 << 3) | mask; // ECC level M = 0b00
    let r = d;
    for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const b = ((d << 10) | r) ^ 0x5412;
    const bit = (i: number) => ((b >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (ver >= 7) {
    let r = ver;
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const b = (ver << 12) | r;
    for (let i = 0; i < 18; i++) {
      const dark = ((b >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const c = Math.floor(i / 3);
      set(a, c, dark);
      set(c, a, dark);
    }
  }

  // codewords in the zigzag
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++)
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - v : v;
        if (!fn[y][x] && i < words.length * 8) {
          mod[y][x] = ((words[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
  }

  // the mask with the lowest penalty
  const masks: ((x: number, y: number) => boolean)[] = [
    (x, y) => (x + y) % 2 === 0,
    (_x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const apply = (m: number) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && masks[m](x, y)) mod[y][x] = !mod[y][x];
  };
  let best = 0;
  let bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    apply(m);
    drawFormat(m);
    const s = penalty(mod);
    if (s < bestScore) (best = m), (bestScore = s);
    apply(m); // undo (XOR)
  }
  apply(best);
  drawFormat(best);
  return mod;
}

/** The standard's penalty: runs of five and more, 2×2 blocks, finder-like patterns, dark/light balance */
function penalty(m: boolean[][]): number {
  const n = m.length;
  let score = 0;
  let dark = 0;
  const line = (get: (i: number) => boolean) => {
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && get(i) === get(i - 1)) run++;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    // 1:1:3:1:1 with four light modules on one side
    for (let i = 0; i + 10 < n; i++) {
      const p = [1, 0, 1, 1, 1, 0, 1].every((b, k) => get(i + 4 + k) === !!b);
      if (p && [0, 1, 2, 3].every((k) => !get(i + k))) score += 40;
      const q = [1, 0, 1, 1, 1, 0, 1].every((b, k) => get(i + k) === !!b);
      if (q && [7, 8, 9, 10].every((k) => !get(i + k))) score += 40;
    }
  };
  for (let y = 0; y < n; y++) {
    line((x) => m[y][x]);
    line((x) => m[x][y]);
    for (let x = 0; x < n; x++) {
      if (m[y][x]) dark++;
      if (x + 1 < n && y + 1 < n && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
    }
  }
  const k = Math.ceil(Math.abs(dark * 20 - n * n * 10) / (n * n)) - 1;
  return score + Math.max(0, k) * 10;
}

/** One SVG path of the dark modules (1 unit per module, shifted by the quiet zone) */
export function qrPath(m: boolean[][], quiet = 4): string {
  let d = '';
  m.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue;
      let w = 1;
      while (row[x + w]) w++;
      d += `M${x + quiet} ${y + quiet}h${w}v1h-${w}z`;
      x += w - 1;
    }
  });
  return d;
}

/** A `WIFI:` text back to its fields (QR code read from a picture); undefined when it is no Wi-Fi code */
export function wifiParse(text: string): Pick<WifiNetwork, 'ssid' | 'password' | 'security' | 'hidden'> | undefined {
  if (!/^WIFI:/i.test(text)) return undefined;
  const f: Record<string, string> = {};
  let key = '';
  let val = '';
  let inKey = true;
  let quoted = false;
  for (let i = 5; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length) {
      if (inKey) key += text[++i];
      else val += text[++i];
    } else if (inKey && c === ':') inKey = false;
    else if (!inKey && c === '"') quoted = !quoted;
    else if (!quoted && c === ';') {
      if (key) f[key.toUpperCase()] = val;
      key = val = '';
      inKey = true;
    } else if (inKey) key += c;
    else val += c;
  }
  if (key) f[key.toUpperCase()] = val;
  if (!f.S) return undefined;
  const type = (f.T ?? '').toUpperCase();
  const security: WifiSecurity = !type || type === 'NOPASS' ? (f.P ? 'wpa2' : 'nopass') : type === 'SAE' || f.R === '1' ? 'wpa3' : 'wpa2';
  return { ssid: f.S, password: security === 'nopass' ? '' : (f.P ?? ''), security, hidden: /^true$/i.test(f.H ?? '') };
}
