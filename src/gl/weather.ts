/**
 * Procedural weather in WebGL (fragment shaders on a full-card quad):
 * back layer  — stars and two layers of volumetric-looking clouds, lit from the sun's side
 *               (bright rims, darker undersides, sunset glow), drifting with the wind;
 * front layer — cloud shadows passing over the house, fog banks, rain streaks (three depths)
 *               and snow flakes.
 * Clouds render at reduced resolution (they are soft anyway), so this stays cheap on tablets.
 */
import { idleFor, isActive, UNATTENDED } from '../activity';

export interface WeatherParams {
  /** 0..1 cloud cover */
  cover: number;
  /** screen direction the wind blows to */
  wind: [number, number];
  /** 0..1 wind strength */
  windK: number;
  /** screen direction towards the sun */
  sun: [number, number];
  /** 0..1 direct sun (shadow strength) */
  sunK: number;
  stars: number;
  rain: number;
  snow: number;
  fog: number;
  /** precipitation slant (radians) */
  slant: number;
  colors: {
    light: [number, number, number];
    dark: [number, number, number];
    glow: [number, number, number, number];
    shadow: [number, number, number];
    fog: [number, number, number, number];
    rain: [number, number, number, number];
    snow: [number, number, number, number];
  };
  cloudAlpha: number;
  /** freeze time (reduced motion) */
  still?: boolean;
}

const NOISE = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 uRes;
uniform float uTime;
// lattice wrapped to 289 cells and a hash that keeps its numbers small: stays clean on low-precision mobile GPUs
float hash(vec2 p) {
  p = mod(p, 289.0);
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
const mat2 ROT = mat2(1.6, 1.2, -1.2, 1.6);
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p = ROT * p; a *= 0.5; } return v; }
float fbm3(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 3; i++) { v += a * noise(p); p = ROT * p; a *= 0.5; } return v; }
`;

const VERT = `attribute vec2 aPos; void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const BACK = `${NOISE}
uniform float uCover, uStars, uAlpha;
uniform vec2 uWind, uSun;
uniform vec3 uLight, uDark;
uniform vec4 uGlow;
// density of a cloud layer + a sample shifted towards the sun (self shadowing)
vec2 layer(vec2 p, float cover, bool far) {
  // gentle warping (no marble swirls) + fine billows on top: puffy cumulus; the self-shadow sample and the
  // far deck need less detail (cheaper on tablets)
  vec2 q = vec2(fbm3(p), fbm3(p + vec2(5.2, 1.3)));
  vec2 w = p + 0.55 * q;
  float puff = noise(p * 7.0) * 0.11;
  float d = (far ? fbm3(w) : fbm(w)) + puff;
  float s = fbm3(w + uSun * 0.16) + puff;
  float lo = 0.86 - cover * 0.62;
  return vec2(smoothstep(lo, lo + 0.16, d), smoothstep(lo, lo + 0.16, s));
}
uniform float uTimeB, uMix;
vec4 scene(float t) {
  vec2 uv = gl_FragCoord.xy / uRes;
  float aspect = uRes.x / uRes.y;
  // the cloud deck is seen at an angle: flatter vertically
  vec2 p = vec2(uv.x * aspect, uv.y * 1.6);
  vec4 col = vec4(0.0);
  if (uStars > 0.01) {
    vec2 g = gl_FragCoord.xy / 2.2;
    vec2 id = floor(g);
    float h = hash(id);
    if (h > 0.9965) {
      float tw = 0.45 + 0.55 * sin(t * (0.8 + h * 2.6) + h * 50.0);
      float d = length(fract(g) - 0.5);
      float a = (1.0 - smoothstep(0.0, 0.42, d)) * tw * uStars;
      col = vec4(vec3(1.0, 0.98, 0.94) * a, a);
    }
  }
  for (int L = 0; L < 2; L++) {
    bool far = L == 0;
    float sc = far ? 3.8 : 2.3;
    float sp = far ? 0.0035 : 0.0065;
    vec2 pp = p * sc + uWind * t * sp * sc + (far ? vec2(17.3, 4.1) : vec2(0.0));
    float cov = uCover * (far ? 0.8 : 1.0);
    vec2 ds = layer(pp, cov, far);
    float d = ds.x;
    if (d < 0.003) continue;
    // sun side bright, far side and thick cores darker (silver lining on the sunny edge)
    float lit = clamp(0.62 + (d - ds.y) * 2.6, 0.0, 1.0);
    float core = smoothstep(0.55, 1.0, ds.y) * 0.35;
    vec3 c = mix(uDark, uLight, clamp(lit - core, 0.0, 1.0));
    float rim = clamp((d - ds.y) * 3.0, 0.0, 1.0) * (1.0 - d * 0.5);
    c = mix(c, uGlow.rgb, rim * uGlow.a);
    c += rim * 0.12;
    float a = pow(d, 0.8) * uAlpha * (far ? 0.55 : 1.0);
    col = vec4(c * a, a) + col * (1.0 - a);
  }
  return col;
}
void main() {
  vec4 col = scene(uTime);
  if (uMix > 0.001) col = mix(col, scene(uTimeB), uMix);
  gl_FragColor = col;
}`;

const FRONT = `${NOISE}
uniform float uCover, uSunK, uSnow, uFog, uSlant, uWindK;
uniform vec2 uWind, uSun;
uniform vec3 uShadow;
uniform vec4 uFogC, uSnowC;
float clouds(vec2 p, float cover) {
  vec2 q = vec2(fbm3(p), fbm3(p + vec2(5.2, 1.3)));
  float d = fbm3(p + 0.55 * q) + noise(p * 7.0) * 0.09;
  float lo = 0.86 - cover * 0.62;
  return smoothstep(lo, lo + 0.2, d);
}
uniform float uTimeB, uMix;
float T;
float snow(vec2 uv, float cols, float speed, float size) {
  vec2 p = uv * cols;
  p.y += T * speed;
  vec2 id = floor(p);
  float h = hash(id);
  vec2 c = vec2(0.5 + 0.32 * sin(T * (0.6 + h) + h * 30.0), 0.5 + 0.3 * (h - 0.5));
  float d = length(fract(p) - c);
  return (1.0 - smoothstep(size * 0.4, size, d)) * step(0.55, fract(h * 7.3));
}
vec4 scene(float t) {
  T = t;
  vec2 uv = gl_FragCoord.xy / uRes;
  float aspect = uRes.x / uRes.y;
  vec4 col = vec4(0.0);
  // cloud shadows sweeping over the house (same deck as the near clouds, offset away from the sun)
  if (uCover > 0.08 && uSunK > 0.02) {
    vec2 p = vec2(uv.x * aspect, uv.y * 1.6) * 2.3 + uWind * t * 0.0065 * 2.3 - uSun * 0.35;
    float d = clouds(p, uCover);
    float a = d * (0.14 + 0.2 * uSunK);
    col = vec4(uShadow * a, a);
  }
  // fog banks
  if (uFog > 0.01) {
    vec2 p = vec2(uv.x * aspect * 1.2 + t * 0.01, uv.y * 2.6);
    float f = smoothstep(0.3, 0.75, fbm(p)) * 0.8 + smoothstep(0.35, 0.8, fbm(p * 0.55 + vec2(3.1, t * 0.003))) * 0.6;
    float a = clamp(0.18 + f * 0.75, 0.0, 0.92) * uFog * max(uFogC.a, 0.6);
    col = vec4(uFogC.rgb * a, a) + col * (1.0 - a);
  }
  // precipitation: rotate for the slant
  if (uSnow > 0.01) {
    vec2 q = vec2(uv.x * aspect, uv.y);
    float cs = cos(uSlant), sn = sin(uSlant);
    q = vec2(cs * q.x - sn * q.y, sn * q.x + cs * q.y);
    if (uSnow > 0.01) {
      float s = snow(q, 60.0, 0.5, 0.09) + snow(q + 0.41, 40.0, 0.34, 0.11) * 0.85 + snow(q + 0.83, 26.0, 0.22, 0.13) * 0.75;
      float a = clamp(s * uSnow, 0.0, 1.0) * uSnowC.a;
      col = vec4(uSnowC.rgb * a, a) + col * (1.0 - a);
    }
  }
  return col;
}
void main() {
  vec4 col = scene(uTime);
  if (uMix > 0.001) col = mix(col, scene(uTimeB), uMix);
  gl_FragColor = col;
}`;

/**
 * Rain as real streaks: a few hundred thin quads moved by the vertex shader. Only the drops' pixels are
 * shaded (the old full-screen rain shaded every pixel 30 times a second — the tablet's GPU could not keep up).
 */
const RAIN_VERT = `
attribute vec4 aSeed;   // x, y phase, depth 0..1, density rank 0..1
attribute vec2 aCorner; // across -1..1, along 0..1 (0 = head)
uniform vec2 uRes;
uniform float uTime, uSlant, uRain, uPx;
varying vec2 vC;
varying float vA;
void main() {
  float depth = aSeed.z;
  // fewer drops in light rain: higher ranks drop out
  if (aSeed.w > uRain) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float speed = mix(0.75, 1.55, depth);          // screen heights per second
  float y = 1.2 - fract(aSeed.y + uTime * speed) * 1.45;
  float x = aSeed.x * 1.5 - 0.25;
  vec2 dir = vec2(sin(uSlant), -cos(uSlant));     // falling direction (screen, y up)
  vec2 p = vec2(x * uRes.x, y * uRes.y);
  p.x += (1.0 - y) * uRes.y * tan(uSlant);
  float len = mix(16.0, 38.0, depth) * uPx;
  float wid = max(0.9, mix(1.0, 1.9, depth) * uPx);
  vec2 side = vec2(-dir.y, dir.x);
  p += -dir * len * aCorner.y + side * wid * aCorner.x;
  gl_Position = vec4(p / uRes * 2.0 - 1.0, 0.0, 1.0);
  vC = aCorner;
  vA = mix(0.5, 1.0, depth);
}`;
const RAIN_FRAG = `
precision mediump float;
uniform vec4 uRainC;
varying vec2 vC;
varying float vA;
void main() {
  float across = 1.0 - abs(vC.x);
  float a = sqrt(across) * (1.0 - vC.y * 0.85) * vA * min(1.0, uRainC.a * 1.6);
  gl_FragColor = vec4(uRainC.rgb * a, a);
}`;
const DROPS = 420;

const CYCLE = 1800;
const HANDOVER = 4;

/** Fragment shader float precision of this device (bits), for the stats overlay */
export function shaderPrecision(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return '–';
    const hi = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    const md = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.MEDIUM_FLOAT);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return `highp ${hi?.precision ?? 0} bit · mediump ${md?.precision ?? 0} bit`;
  } catch {
    return '–';
  }
}

export class WeatherGL {
  private gl: WebGLRenderingContext;
  private prog: WebGLProgram;
  private quad!: WebGLBuffer;
  private rainProg?: WebGLProgram;
  private rainBuf?: { seed: WebGLBuffer; corner: WebGLBuffer; n: number };
  private rainLoc = new Map<string, WebGLUniformLocation | null>();
  /** canvas pixels per CSS pixel */
  private pxScale = 1;
  private loc = new Map<string, WebGLUniformLocation | null>();
  private raf = 0;
  private t0 = performance.now();
  private params?: WeatherParams;
  private ro: ResizeObserver;
  private visible = true;
  /** A popup or the editor covers the plan: the sky holds still (a change of weather still draws once) */
  private covered = false;
  private coveredAt = 0;
  private onVis = () => {
    this.visible = document.visibilityState === 'visible';
    if (this.visible) this.kick();
  };
  dead = false;
  /** frames drawn so far (diagnostics) */
  draws = 0;

  static supported(): boolean {
    try {
      return !!document.createElement('canvas').getContext('webgl');
    } catch {
      return false;
    }
  }

  constructor(
    readonly canvas: HTMLCanvasElement,
    private kind: 'back' | 'front',
  ) {
    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false, depth: false, powerPreference: 'low-power' });
    if (!gl) throw new Error('no webgl');
    this.gl = gl;
    this.prog = this.program(VERT, kind === 'back' ? BACK : FRONT);
    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    document.addEventListener('visibilitychange', this.onVis);
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.dead = true;
    });
    this.resize();
  }

  private program(vs: string, fs: string) {
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
    return p;
  }

  /** Rain drops: built on first use */
  private rainSetup() {
    const gl = this.gl;
    this.rainProg = this.program(RAIN_VERT, RAIN_FRAG);
    const seed: number[] = [];
    const corner: number[] = [];
    let h = 7;
    const rnd = () => ((h = (h * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < DROPS; i++) {
      const s4 = [rnd(), rnd(), rnd() ** 1.6, (i + 0.5) / DROPS];
      // two triangles: (-1,0) (1,0) (-1,1) / (1,0) (1,1) (-1,1)
      for (const c of [[-1, 0], [1, 0], [-1, 1], [1, 0], [1, 1], [-1, 1]]) {
        seed.push(...s4);
        corner.push(c[0], c[1]);
      }
    }
    const b = (data: number[]) => {
      const buf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
      return buf;
    };
    this.rainBuf = { seed: b(seed), corner: b(corner), n: DROPS * 6 };
  }

  private drawRain(t: number, p: WeatherParams) {
    const gl = this.gl;
    if (!this.rainProg) this.rainSetup();
    const prog = this.rainProg!;
    const buf = this.rainBuf!;
    gl.useProgram(prog);
    const u = (n: string) => {
      if (!this.rainLoc.has(n)) this.rainLoc.set(n, gl.getUniformLocation(prog, n));
      return this.rainLoc.get(n)!;
    };
    const attr = (name: string, b: WebGLBuffer, size: number) => {
      const a = gl.getAttribLocation(prog, name);
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.enableVertexAttribArray(a);
      gl.vertexAttribPointer(a, size, gl.FLOAT, false, 0, 0);
      return a;
    };
    const a1 = attr('aSeed', buf.seed, 4);
    const a2 = attr('aCorner', buf.corner, 2);
    gl.uniform2f(u('uRes'), this.canvas.width, this.canvas.height);
    gl.uniform1f(u('uTime'), t);
    gl.uniform1f(u('uSlant'), p.slant);
    gl.uniform1f(u('uRain'), Math.min(1, p.rain));
    gl.uniform1f(u('uPx'), this.pxScale);
    gl.uniform4fv(u('uRainC'), p.colors.rain);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, buf.n);
    gl.disable(gl.BLEND);
    gl.disableVertexAttribArray(a1);
    gl.disableVertexAttribArray(a2);
  }

  /** Full-card field (clouds, shadows, fog, snow) */
  private fieldActive(p: WeatherParams): boolean {
    return this.kind === 'back' ? p.cover > 0.05 || p.stars > 0.01 : (p.cover > 0.08 && p.sunK > 0.02) || p.snow > 0.01 || p.fog > 0.01;
  }

  private u(name: string) {
    if (!this.loc.has(name)) this.loc.set(name, this.gl.getUniformLocation(this.prog, name));
    return this.loc.get(name)!;
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    // clouds are soft: 45 % resolution; precipitation needs crisper lines
    // (measured: each step up in resolution costs the tablet's GPU as much as the whole 3D scene)
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const scale = this.kind === 'back' ? 0.45 : Math.min(1, dpr * 0.6);
    this.pxScale = scale;
    const w = Math.max(16, Math.round(r.width * scale));
    const h = Math.max(16, Math.round(r.height * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.gl.viewport(0, 0, w, h);
    }
    this.force = true;
    this.kick();
  }

  set(p: WeatherParams) {
    this.params = p;
    this.force = true;
    this.kick();
  }

  /** Next frame draws regardless of the frame budget (new parameters, resize) */
  private force = true;
  private lastDraw = 0;
  private timer = 0;

  private active(): boolean {
    const p = this.params;
    if (!p) return false;
    return this.fieldActive(p) || (this.kind === 'front' && p.rain > 0.01);
  }

  setCovered(on: boolean) {
    if (on === this.covered) return;
    this.covered = on;
    if (on) this.coveredAt = performance.now();
    else {
      // the shader clock leaves the covered time out: clouds and rain go on where they stopped
      this.t0 += performance.now() - this.coveredAt;
      this.kick();
    }
  }

  private kick() {
    clearTimeout(this.timer);
    this.timer = 0;
    if (!this.raf && !this.dead) this.raf = requestAnimationFrame(this.frame);
  }

  /** Next frame in about `ms` (a timer, then the display's next refresh: no busy frame loop) */
  private later(ms: number) {
    if (this.dead || !this.visible || this.covered || this.raf || this.timer) return;
    if (ms <= 18) this.raf = requestAnimationFrame(this.frame);
    else
      this.timer = window.setTimeout(() => {
        this.timer = 0;
        if (!this.raf && !this.dead) this.raf = requestAnimationFrame(this.frame);
      }, ms - 8);
  }

  /** Frame budget: precipitation 30 frames/s (20 on an unattended tablet), slow clouds 15 (8); behind rain
   * or snow the clouds are a dull deck: 10 */
  private gap(p: WeatherParams): number {
    const calm = idleFor() > UNATTENDED;
    const precip = p.rain > 0.01 || p.snow > 0.01;
    if (this.kind === 'front') return precip ? (calm ? 50 : 33) : calm ? 125 : 66;
    return precip ? (calm ? 160 : 100) : calm ? 125 : 66;
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (this.dead) return;
    const gl = this.gl;
    const p = this.params;
    if (!this.force && this.covered) return;
    if (!this.force && p && !p.still) {
      // while the view moves the clouds hold still, so the 3D scene gets the GPU; rain and snow keep falling,
      // at half their usual rate (they would look frozen otherwise)
      if (isActive()) {
        if (this.kind !== 'front' || (p.rain <= 0.01 && p.snow <= 0.01)) return this.later(120);
        const wait = this.gap(p) * 2 - (now - this.lastDraw);
        if (wait > 4) return this.later(wait);
      } else {
        const wait = this.gap(p) - (now - this.lastDraw);
        if (wait > 4) return this.later(wait);
      }
    }
    this.force = false;
    this.lastDraw = now;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!p || !this.active()) return;
    // shader time runs in 30-minute cycles (small numbers keep the noise precise on any GPU); the last
    // seconds of a cycle blend into the next one so nothing jumps
    const raw = p.still ? 40 : ((this.covered ? this.coveredAt : performance.now()) - this.t0) / 1000;
    const t = raw % CYCLE;
    const mixK = t > CYCLE - HANDOVER ? (t - (CYCLE - HANDOVER)) / HANDOVER : 0;
    if (this.fieldActive(p)) {
      gl.useProgram(this.prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      const a = gl.getAttribLocation(this.prog, 'aPos');
      gl.enableVertexAttribArray(a);
      gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(this.u('uRes'), this.canvas.width, this.canvas.height);
      gl.uniform1f(this.u('uTime'), t);
      gl.uniform1f(this.u('uTimeB'), t - CYCLE);
      gl.uniform1f(this.u('uMix'), mixK * mixK * (3 - 2 * mixK));
      gl.uniform1f(this.u('uCover'), p.cover);
      gl.uniform2f(this.u('uWind'), p.wind[0], -p.wind[1]);
      gl.uniform2f(this.u('uSun'), p.sun[0], -p.sun[1]);
      if (this.kind === 'back') {
        gl.uniform1f(this.u('uStars'), p.stars);
        gl.uniform1f(this.u('uAlpha'), p.cloudAlpha);
        gl.uniform3fv(this.u('uLight'), p.colors.light);
        gl.uniform3fv(this.u('uDark'), p.colors.dark);
        gl.uniform4fv(this.u('uGlow'), p.colors.glow);
      } else {
        gl.uniform1f(this.u('uSunK'), p.sunK);
        gl.uniform1f(this.u('uSnow'), p.snow);
        gl.uniform1f(this.u('uFog'), p.fog);
        gl.uniform1f(this.u('uSlant'), p.slant);
        gl.uniform1f(this.u('uWindK'), p.windK);
        gl.uniform3fv(this.u('uShadow'), p.colors.shadow);
        gl.uniform4fv(this.u('uFogC'), p.colors.fog);
        gl.uniform4fv(this.u('uSnowC'), p.colors.snow);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.disableVertexAttribArray(a);
    }
    if (this.kind === 'front' && p.rain > 0.01) this.drawRain(raw % 600, p);
    this.draws++;
    if (!p.still) this.later(this.gap(p));
  };

  destroy() {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.timer);
    this.ro.disconnect();
    document.removeEventListener('visibilitychange', this.onVis);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.dead = true;
  }
}

/** "rgb(…)", "rgba(…)", "#rrggbb" → linear-ish 0..1 components (alpha last) */
export function parseColor(s: string, fallback: [number, number, number, number]): [number, number, number, number] {
  const t = s.trim();
  if (t.startsWith('#') && (t.length === 7 || t.length === 4)) {
    const h = t.length === 4 ? t.slice(1).split('').map((c) => c + c).join('') : t.slice(1);
    const n = parseInt(h, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
  }
  const m = t.match(/[\d.]+/g);
  if (!m || m.length < 3) return fallback;
  const v = m.map(Number);
  if (t.startsWith('color(')) return [v[0], v[1], v[2], v[3] ?? 1];
  return [v[0] / 255, v[1] / 255, v[2] / 255, v[3] ?? 1];
}
