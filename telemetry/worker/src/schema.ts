/**
 * Strict validation of what roomwise sends (custom_components/roomwise/house_rules/telemetry.py).
 * Unknown fields are rejected, strings must match tight patterns (no free text can slip through), numbers are
 * bounded, maps and lists are size-limited. A tiny hand-written validator: no dependencies.
 */

export type Rule =
  | { t: 'str'; re: RegExp; optional?: boolean; nullable?: boolean }
  | { t: 'int'; min: number; max: number; optional?: boolean }
  | { t: 'bool'; optional?: boolean }
  | { t: 'obj'; fields: Record<string, Rule>; optional?: boolean }
  | { t: 'map'; key: RegExp; value: Rule; max: number; optional?: boolean }
  | { t: 'list'; item: Rule; max: number; optional?: boolean };

const str = (re: RegExp, extra: { optional?: boolean; nullable?: boolean } = {}): Rule => ({ t: 'str', re, ...extra });
const int = (min: number, max: number, optional = false): Rule => ({ t: 'int', min, max, optional });
const bool = (optional = false): Rule => ({ t: 'bool', optional });
const obj = (fields: Record<string, Rule>, optional = false): Rule => ({ t: 'obj', fields, optional });
const map = (key: RegExp, value: Rule, max: number, optional = false): Rule => ({ t: 'map', key, value, max, optional });
const list = (item: Rule, max: number, optional = false): Rule => ({ t: 'list', item, max, optional });

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERSION = /^[0-9A-Za-z.+-]{1,30}$/;
const WORD = /^[a-z0-9_]{1,50}$/;
const COUNT = int(0, 1_000_000);

const client = obj({
  browser: str(/^(chrome|edge|firefox|safari|samsung|opera|ha_app|fully|other)$/),
  engine: str(/^(blink|gecko|webkit|other)$/),
  engine_version: int(0, 999),
  webgl: str(/^(none|webgl1|webgl2)$/),
  gpu: str(/^(adreno|mali|powervr|apple|intel|nvidia|amd|software|other|unknown)$/),
  tier: str(/^(fast|ok|slow|very_slow|2d)$/),
  profile: str(/^(high|eco)$/),
  view: str(/^(2d|3d)$/),
  screen: str(/^(phone|tablet|desktop)$/),
  cores: str(/^(1-2|3-4|5-8|9\+|unknown)$/),
  count: COUNT,
});

export const REPORT: Rule = obj({
  schema: int(1, 1),
  install_id: str(UUID),
  period_days: int(1, 31),
  versions: obj({
    roomwise: str(VERSION),
    house_rules: str(VERSION, { optional: true, nullable: true }),
    floorplan_card: str(VERSION, { optional: true, nullable: true }),
    ha: str(VERSION),
    python: str(/^\d{1,2}\.\d{1,2}$/),
  }),
  ha: obj({
    language: str(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$|^$/),
    unit_system: str(/^(metric|us_customary)$/),
    installation: str(/^(Home Assistant (OS|Container|Supervised|Core)|other|unknown)$/),
  }),
  entities: obj({
    domains: map(WORD, COUNT, 300),
    device_classes: map(/^[a-z0-9_]{1,50}:[a-z0-9_]{1,50}$/, COUNT, 500),
  }),
  platforms: map(WORD, map(WORD, COUNT, 200), 300),
  shapes: list(
    obj({
      domain: str(WORD),
      platform: str(WORD),
      shape: str(/^[a-z0-9_=,.;:+-]{1,200}$/),
      count: COUNT,
    }),
    300,
  ),
  features: map(WORD, bool(), 40),
  roomwise: obj({
    floorplan_card: bool(),
    cards: int(0, 1000),
    entry_alert: bool(),
    pets: int(0, 50),
    vacuum_adapters: map(WORD, int(0, 100), 10),
  }),
  counts: map(WORD, COUNT, 40),
  clients: list(client, 50),
});

export const ERROR: Rule = obj({
  schema: int(1, 1),
  install_id: str(UUID),
  fingerprint: str(/^[0-9a-f]{8,64}$/),
  type: str(/^[A-Za-z_][A-Za-z0-9_.]{0,79}$/),
  // "house_rules/core.py:123 rebuild" – our own files only
  frames: list(str(/^(house_rules|floorplan_card)\/[A-Za-z0-9_\/]{1,100}\.py:\d{1,6} [A-Za-z_<>][A-Za-z0-9_<>]{0,80}$/), 25),
  count: int(1, 100_000),
  versions: obj({ roomwise: str(VERSION), ha: str(VERSION) }),
});

/** null = valid, else the first problem (path: reason) */
export function validate(rule: Rule, v: unknown, path = '$'): string | null {
  switch (rule.t) {
    case 'str':
      if (v === null && rule.nullable) return null;
      return typeof v === 'string' && rule.re.test(v) ? null : `${path}: invalid string`;
    case 'int':
      return typeof v === 'number' && Number.isInteger(v) && v >= rule.min && v <= rule.max ? null : `${path}: invalid number`;
    case 'bool':
      return typeof v === 'boolean' ? null : `${path}: invalid boolean`;
    case 'obj': {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return `${path}: object expected`;
      const o = v as Record<string, unknown>;
      for (const k of Object.keys(o)) if (!(k in rule.fields)) return `${path}.${k}: unknown field`;
      for (const [k, r] of Object.entries(rule.fields)) {
        if (!(k in o)) {
          if (r.optional) continue;
          return `${path}.${k}: missing`;
        }
        const e = validate(r, o[k], `${path}.${k}`);
        if (e) return e;
      }
      return null;
    }
    case 'map': {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return `${path}: object expected`;
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.length > rule.max) return `${path}: too many entries`;
      for (const [k, x] of entries) {
        if (!rule.key.test(k)) return `${path}: invalid key`;
        const e = validate(rule.value, x, `${path}.${k}`);
        if (e) return e;
      }
      return null;
    }
    case 'list': {
      if (!Array.isArray(v)) return `${path}: list expected`;
      if (v.length > rule.max) return `${path}: too many items`;
      for (let i = 0; i < v.length; i++) {
        const e = validate(rule.item, v[i], `${path}[${i}]`);
        if (e) return e;
      }
      return null;
    }
  }
}
