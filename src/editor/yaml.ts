/** Minimal YAML emitter for card configs (objects, arrays, strings, numbers, booleans). */

const PLAIN = /^[A-Za-z_][\w.\-/ ]*$/;
const RESERVED = /^(true|false|yes|no|on|off|null|~)$/i;

function scalar(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const s = String(v);
  if (PLAIN.test(s) && !RESERVED.test(s) && !s.endsWith(' ') && !/^\d/.test(s)) return s;
  return JSON.stringify(s);
}

const isFlat = (a: unknown[]) => a.every((x) => x === null || typeof x !== 'object') && a.length <= 8;
const isPoint = (a: unknown) => Array.isArray(a) && a.length === 2 && a.every((x) => typeof x === 'number');

function emit(v: unknown, indent: number, out: string[], prefix: string) {
  const pad = '  '.repeat(indent);
  if (Array.isArray(v)) {
    if (!v.length) return void out.push(`${prefix} []`);
    if (isFlat(v) && (isPoint(v) || v.every((x) => typeof x === 'number'))) return void out.push(`${prefix} [${v.map(scalar).join(', ')}]`);
    if (v.every(isPoint)) {
      // Points: one flow sequence per line keeps polygons readable.
      out.push(prefix);
      for (const p of v as number[][]) out.push(`${pad}  - [${p.map(scalar).join(', ')}]`);
      return;
    }
    out.push(prefix);
    for (const item of v) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const entries = Object.entries(item).filter(([, x]) => x !== undefined);
        if (!entries.length) {
          out.push(`${pad}  - {}`);
          continue;
        }
        entries.forEach(([k, x], i) => emitEntry(k, x, indent + 2, out, i === 0 ? `${pad}  - ` : `${pad}    `));
      } else if (Array.isArray(item)) emit(item, indent + 1, out, `${pad}  -`);
      else out.push(`${pad}  - ${scalar(item)}`);
    }
    return;
  }
  if (v && typeof v === 'object') {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined);
    if (!entries.length) return void out.push(`${prefix} {}`);
    if (prefix) out.push(prefix);
    for (const [k, x] of entries) emitEntry(k, x, prefix ? indent + 1 : indent, out, '  '.repeat(prefix ? indent + 1 : indent));
    return;
  }
  out.push(`${prefix} ${scalar(v)}`);
}

function emitEntry(k: string, x: unknown, indent: number, out: string[], lead: string) {
  const key = `${lead}${scalar(k)}:`;
  if (x && typeof x === 'object') emit(x, indent, out, key);
  else out.push(`${key} ${scalar(x)}`);
}

export function toYaml(v: unknown): string {
  const out: string[] = [];
  emit(v, 0, out, '');
  return out.join('\n') + '\n';
}
