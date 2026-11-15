import type { FloorplanCardConfig, HomeAssistant, Point } from './types';

export type DayPhase = 'day' | 'golden' | 'twilight' | 'night';

export interface SunInfo {
  azimuth: number;
  elevation: number;
  up: boolean;
  phase: DayPhase;
  /** 0..1 how strong direct sunlight is (elevation + clouds) */
  strength: number;
  /** Unit vector in plan coordinates pointing from the building towards the sun */
  dir: Point;
}

export interface WeatherInfo {
  entity: string;
  condition: string;
  temperature?: number;
  unit: string;
  coverage: number;
  windBearing?: number;
  windSpeed?: number;
}

/** Plan direction (unit vector, y down) of a compass bearing given where north points on the plan. */
export function bearingToPlan(bearing: number, north = 0): Point {
  const a = ((bearing + north) * Math.PI) / 180;
  return [Math.sin(a), -Math.cos(a)];
}

const PRECIP = new Set(['rainy', 'pouring', 'snowy', 'snowy-rainy', 'hail', 'lightning', 'lightning-rainy']);
const CLOUDY = new Set(['cloudy', 'fog', 'rainy', 'pouring', 'snowy', 'snowy-rainy', 'hail', 'lightning', 'lightning-rainy']);

export function weatherInfo(hass: HomeAssistant, cfg: FloorplanCardConfig): WeatherInfo | undefined {
  const id = cfg.weather ?? Object.keys(hass.states).find((e) => e.startsWith('weather.'));
  const s = id ? hass.states[id] : undefined;
  if (!s || s.state === 'unavailable' || s.state === 'unknown') return undefined;
  const a = s.attributes;
  const coverage =
    typeof a.cloud_coverage === 'number'
      ? a.cloud_coverage
      : s.state === 'cloudy'
        ? 90
        : s.state === 'partlycloudy'
          ? 45
          : CLOUDY.has(s.state)
            ? 85
            : 5;
  return {
    entity: id!,
    condition: s.state,
    temperature: typeof a.temperature === 'number' ? a.temperature : undefined,
    unit: a.temperature_unit ?? '°',
    coverage,
    windBearing: a.wind_bearing,
    windSpeed: a.wind_speed,
  };
}

export function sunInfo(hass: HomeAssistant, cfg: FloorplanCardConfig, weather?: WeatherInfo): SunInfo | undefined {
  const s = hass.states[cfg.sun ?? 'sun.sun'];
  if (!s || typeof s.attributes.elevation !== 'number') return undefined;
  const elevation = s.attributes.elevation as number;
  const azimuth = (s.attributes.azimuth as number) ?? 180;
  const phase: DayPhase = elevation > 10 ? 'day' : elevation > 0 ? 'golden' : elevation > -6 ? 'twilight' : 'night';
  // Direct light: elevation, damped by clouds/fog/precipitation but never fully hidden while the sun is up,
  // so the sun's direction stays readable on the plan.
  const clouds = weather ? Math.min(1, weather.coverage / 100) : 0;
  const cond = weather?.condition ?? '';
  const damp = cond === 'fog' ? 0.55 : PRECIP.has(cond) ? 0.5 : 1;
  const raw = Math.min(1, elevation / 20) * (1 - clouds * 0.6) * damp;
  const strength = elevation <= 0 ? 0 : Math.max(0.22, Math.min(1, raw));
  return { azimuth, elevation, up: elevation > 0, phase, strength, dir: bearingToPlan(azimuth, cfg.north ?? 0) };
}

export function weatherIcon(condition: string, night = false): string {
  const map: Record<string, string> = {
    'clear-night': 'mdi:weather-night',
    cloudy: 'mdi:weather-cloudy',
    exceptional: 'mdi:alert-circle-outline',
    fog: 'mdi:weather-fog',
    hail: 'mdi:weather-hail',
    lightning: 'mdi:weather-lightning',
    'lightning-rainy': 'mdi:weather-lightning-rainy',
    partlycloudy: night ? 'mdi:weather-night-partly-cloudy' : 'mdi:weather-partly-cloudy',
    pouring: 'mdi:weather-pouring',
    rainy: 'mdi:weather-rainy',
    snowy: 'mdi:weather-snowy',
    'snowy-rainy': 'mdi:weather-snowy-rainy',
    sunny: night ? 'mdi:weather-night' : 'mdi:weather-sunny',
    windy: 'mdi:weather-windy',
    'windy-variant': 'mdi:weather-windy-variant',
  };
  return map[condition] ?? 'mdi:weather-partly-cloudy';
}

/** Whether animated effects should run: config, reduced motion and weak hardware. */
export function effectsLevel(cfg: FloorplanCardConfig): 'off' | 'static' | 'lite' | 'full' {
  if (cfg.effects === 'off') return 'off';
  const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced && cfg.effects !== 'on') return 'static';
  return isWeakDevice() && cfg.effects !== 'on' ? 'lite' : 'full';
}

export function isWeakDevice(): boolean {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return (nav.hardwareConcurrency ?? 8) <= 2 || (nav.deviceMemory ?? 8) <= 2;
}

// ---------- Atmosphere: sky colors and colored light from the sun's elevation ----------

type RGB = [number, number, number];
type RGBA = [number, number, number, number];

interface SkyKey {
  e: number;
  top: RGB;
  bottom: RGB;
  /** Glow on the side of the sun (also below the horizon: sunset/dawn light) */
  glow: RGBA;
  /** Color of direct light and how strongly it tints lit faces/beams */
  sun: RGB;
  sunK: number;
  /** Ambient color multiplied over the house (blue hour / night) */
  amb: RGB;
  ambK: number;
  shadow: RGB;
  cloud: RGBA;
  stars: number;
}

// Keyframes over the sun's elevation (degrees); light theme.
const SKY: SkyKey[] = [
  { e: -16, top: [9, 14, 32], bottom: [24, 32, 62], glow: [70, 90, 170, 0.22], sun: [168, 184, 255], sunK: 0.08, amb: [96, 108, 168], ambK: 0.5, shadow: [10, 14, 40], cloud: [70, 80, 115, 0.55], stars: 1 },
  { e: -8, top: [26, 33, 74], bottom: [92, 78, 128], glow: [190, 110, 170, 0.45], sun: [170, 160, 255], sunK: 0.12, amb: [132, 128, 184], ambK: 0.4, shadow: [30, 22, 70], cloud: [130, 110, 160, 0.7], stars: 0.6 },
  { e: -3, top: [70, 82, 140], bottom: [236, 140, 110], glow: [255, 120, 90, 0.75], sun: [255, 138, 112], sunK: 0.22, amb: [214, 168, 196], ambK: 0.26, shadow: [58, 40, 92], cloud: [250, 170, 160, 0.9], stars: 0.15 },
  { e: 2, top: [150, 176, 214], bottom: [247, 200, 150], glow: [255, 165, 95, 0.8], sun: [255, 176, 112], sunK: 0.26, amb: [255, 214, 178], ambK: 0.12, shadow: [74, 52, 102], cloud: [255, 226, 200, 0.95], stars: 0 },
  { e: 10, top: [150, 190, 232], bottom: [242, 234, 220], glow: [255, 214, 150, 0.6], sun: [255, 220, 166], sunK: 0.16, amb: [255, 244, 228], ambK: 0.04, shadow: [52, 58, 104], cloud: [255, 255, 255, 0.95], stars: 0 },
  { e: 30, top: [128, 180, 236], bottom: [214, 232, 248], glow: [255, 246, 220, 0.6], sun: [255, 242, 214], sunK: 0.1, amb: [255, 255, 255], ambK: 0, shadow: [40, 58, 102], cloud: [255, 255, 255, 0.95], stars: 0 },
];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpArr = <T extends number[]>(a: T, b: T, t: number) => a.map((v, i) => lerp(v, b[i], t)) as T;
const rgb = (c: number[]) => `rgb(${c.slice(0, 3).map((v) => Math.round(v)).join(', ')})`;
const rgba = (c: number[], a = c[3]) => `rgba(${c.slice(0, 3).map((v) => Math.round(v)).join(', ')}, ${Math.max(0, Math.min(1, a)).toFixed(3)})`;

export interface SkyPalette {
  vars: Record<string, string>;
  /** 0..1 how much night it is (stars, window light) */
  night: number;
}

/** Sky and light colors for the current sun elevation, weather and theme (CSS custom properties). */
/** Readable ink + soft halo for text drawn straight onto a sky colour */
function skyInk(c: RGB): Record<string, string> {
  const lum = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
  return lum < 0.45
    ? { '--fp-sky-ink': 'rgba(255, 255, 255, 0.88)', '--fp-sky-halo': 'rgba(0, 0, 0, 0.35)' }
    : { '--fp-sky-ink': 'rgba(20, 24, 32, 0.78)', '--fp-sky-halo': 'rgba(255, 255, 255, 0.45)' };
}

export function skyPalette(sun: SunInfo | undefined, weather: WeatherInfo | undefined, dark: boolean): SkyPalette | undefined {
  if (!sun) return undefined;
  const e = Math.max(SKY[0].e, Math.min(SKY[SKY.length - 1].e, sun.elevation));
  let i = 0;
  while (i < SKY.length - 2 && e > SKY[i + 1].e) i++;
  const A = SKY[i];
  const B = SKY[i + 1];
  const t = (e - A.e) / (B.e - A.e);
  let top = lerpArr(A.top, B.top, t);
  let bottom = lerpArr(A.bottom, B.bottom, t);
  const glow = lerpArr(A.glow, B.glow, t);
  let sunC = lerpArr(A.sun, B.sun, t);
  let sunK = lerp(A.sunK, B.sunK, t);
  const amb = lerpArr(A.amb, B.amb, t);
  let ambK = lerp(A.ambK, B.ambK, t);
  const shadow = lerpArr(A.shadow, B.shadow, t);
  let cloud = lerpArr(A.cloud, B.cloud, t);
  let stars = lerp(A.stars, B.stars, t);
  const day = Math.max(0, Math.min(1, (sun.elevation + 4) / 10)); // 0 night … 1 day

  // Clouds, fog and rain: greyer, flatter light, no stars
  const cover = weather ? Math.min(1, weather.coverage / 100) : 0;
  const cond = weather?.condition ?? '';
  const wet = PRECIP.has(cond) ? 0.35 : cond === 'fog' ? 0.45 : 0;
  const grey = Math.min(0.85, cover * 0.55 + wet);
  const greyTone: RGB = day > 0.5 ? [176, 184, 196] : [38, 44, 60];
  top = lerpArr(top, greyTone, grey);
  bottom = lerpArr(bottom, lerpArr(greyTone, [255, 255, 255], 0.25 * day) as RGB, grey * 0.8);
  glow[3] *= 1 - 0.7 * grey;
  sunK *= 1 - 0.6 * grey;
  stars *= Math.max(0, 1 - cover * 1.4);
  cloud = lerpArr(cloud, [cloud[0] * 0.8, cloud[1] * 0.82, cloud[2] * 0.86, cloud[3]], grey);
  if (cond.startsWith('lightning')) ambK = Math.max(ambK, 0.22);

  // Dark theme: deeper daytime sky so the plan keeps its contrast
  if (dark) {
    const k = 0.62 * day;
    const ink: RGB = [16, 20, 28];
    top = lerpArr(top, ink, k);
    bottom = lerpArr(bottom, ink, k);
    glow[3] *= 1 - 0.45 * day;
    // dark theme: clouds take on the deep sky colour (no milky veil), lit tops stay subtle
    cloud = [...lerpArr(cloud.slice(0, 3) as RGB, top, 0.5 + 0.15 * day).map((v) => v * 0.92), Math.max(0.8, cloud[3])] as RGBA;
    ambK *= 0.8;
  }
  const sunBeam = rgba(sunC, (dark ? 0.32 : 0.55) * (0.6 + 0.4 * (1 - grey)));
  sunC = lerpArr(sunC, [255, 255, 255], 0.1);
  return {
    night: 1 - day,
    vars: {
      '--fp-sky-top': rgb(top),
      '--fp-sky-bottom': rgb(bottom),
      '--fp-sky-glow': rgba(glow),
      '--fp-sky-glow-soft': rgba(glow, glow[3] * 0.35),
      '--fp-sun-tint': rgb(sunC),
      '--fp-sun-k': sunK.toFixed(3),
      '--fp-sun-beam': sunBeam,
      '--fp-amb': rgb(amb),
      '--fp-amb-k': ambK.toFixed(3),
      '--fp-shadow-tint': rgb(shadow),
      '--fp-cloud': rgba(cloud),
      // shaded cloud bellies: a darker shade of the sky itself (bluish grey by day, near black at night)
      '--fp-cloud-dark': rgb(lerpArr(lerpArr(top, [0, 0, 0] as RGB, dark ? 0.45 : 0.28), shadow, dark ? 0.15 : 0.25)),
      '--fp-cloud-shadow': rgba(shadow, 0.1 + 0.08 * day),
      '--fp-star-k': stars.toFixed(3),
      // text placed directly on the sky (outdoor values): light on a dark sky, dark on a bright one
      ...skyInk(lerpArr(top, bottom, 0.5)),
    },
  };
}
