/**
 * What the card reports for Hausregeln' anonymous diagnostics (house_rules/telemetry/client, only counted while
 * the owner opted in; see PRIVACY.md): browser family and engine major version, WebGL level, a coarse graphics
 * chip family, the measured 3D performance tier, profile, view, screen class and CPU cores bucket. Coarse
 * categories only, nothing that names the home or the device. Once per browser and day, measured a minute after
 * the card appeared, from frame times the 3D scene already records (no extra rendering).
 */
export interface ClientInfo {
  browser: string;
  engine: string;
  engine_version: number;
  webgl: 'none' | 'webgl1' | 'webgl2';
  gpu: string;
  tier: 'fast' | 'ok' | 'slow' | 'very_slow' | '2d';
  profile: 'high' | 'eco';
  view: '2d' | '3d';
  screen: 'phone' | 'tablet' | 'desktop';
  cores: string;
}

const KEY = 'roomwise-telemetry-day';

/** Browser family and engine from the user agent (only the family names, never the full string) */
export function browserOf(ua: string): { browser: string; engine: string; engine_version: number } {
  const num = (re: RegExp) => Number(ua.match(re)?.[1] ?? 0) || 0;
  const browser = /Home ?Assistant\//i.test(ua)
    ? 'ha_app'
    : /Fully/i.test(ua)
      ? 'fully'
      : /SamsungBrowser/.test(ua)
        ? 'samsung'
        : /Edg\//.test(ua)
          ? 'edge'
          : /OPR\//.test(ua)
            ? 'opera'
            : /Firefox\//.test(ua)
              ? 'firefox'
              : /Chrome\/|CriOS\//.test(ua)
                ? 'chrome'
                : /Safari\//.test(ua)
                  ? 'safari'
                  : 'other';
  if (/Gecko\/\d/.test(ua) && /Firefox\//.test(ua)) return { browser, engine: 'gecko', engine_version: num(/Firefox\/(\d+)/) };
  // every browser on iOS is WebKit
  if (/iPhone|iPad|iPod/.test(ua) || (/AppleWebKit/.test(ua) && !/Chrome\//.test(ua))) return { browser, engine: 'webkit', engine_version: num(/Version\/(\d+)/) || num(/OS (\d+)_/) };
  if (/Chrome\//.test(ua)) return { browser, engine: 'blink', engine_version: num(/Chrome\/(\d+)/) };
  return { browser, engine: 'other', engine_version: 0 };
}

/** WebGL level and the family of the graphics chip (not the exact model) */
export function webglOf(): { webgl: ClientInfo['webgl']; gpu: string } {
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') as WebGLRenderingContext | null) ?? c.getContext('webgl');
    if (!gl) return { webgl: 'none', gpu: 'unknown' };
    const level = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext ? 'webgl2' : 'webgl1';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const r = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)).toLowerCase();
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    const gpu = /adreno/.test(r)
      ? 'adreno'
      : /mali/.test(r)
        ? 'mali'
        : /powervr/.test(r)
          ? 'powervr'
          : /apple/.test(r)
            ? 'apple'
            : /swiftshader|llvmpipe|software/.test(r)
              ? 'software'
              : /intel/.test(r)
                ? 'intel'
                : /nvidia|geforce/.test(r)
                  ? 'nvidia'
                  : /amd|radeon/.test(r)
                    ? 'amd'
                    : 'other';
    return { webgl: level, gpu };
  } catch {
    return { webgl: 'none', gpu: 'unknown' };
  }
}

/** Performance tier from the median CPU time of the 3D scene's frames (ms) */
export function tierOf(frameMs: number[], view: '2d' | '3d'): ClientInfo['tier'] {
  if (view === '2d' || !frameMs.length) return '2d';
  const m = [...frameMs].sort((a, b) => a - b)[Math.floor(frameMs.length / 2)];
  return m < 8 ? 'fast' : m < 16 ? 'ok' : m < 33 ? 'slow' : 'very_slow';
}

export function screenOf(): ClientInfo['screen'] {
  const s = Math.min(window.screen?.width || window.innerWidth, window.screen?.height || window.innerHeight);
  return s < 600 ? 'phone' : s < 1000 || navigator.maxTouchPoints > 0 ? 'tablet' : 'desktop';
}

export function coresOf(): string {
  const n = navigator.hardwareConcurrency || 0;
  return !n ? 'unknown' : n <= 2 ? '1-2' : n <= 4 ? '3-4' : n <= 8 ? '5-8' : '9+';
}

/** Already reported from this browser today? (marks it when not) */
export function reportedToday(): boolean {
  const day = new Date().toISOString().slice(0, 10);
  try {
    if (localStorage.getItem(KEY) === day) return true;
    localStorage.setItem(KEY, day);
  } catch {
    // no storage (private window): report at most once per page load
  }
  return false;
}

/**
 * A minute after the card appeared: sample the 3D frame times every 5 s (values the scene keeps anyway) and send
 * the report once. `state()` gives the current frame time (0 = nothing rendered), view and profile.
 */
export function scheduleClientReport(state: () => { frameMs: number; view: '2d' | '3d'; profile: 'high' | 'eco' } | null, send: (info: ClientInfo) => Promise<unknown>): () => void {
  if (reportedToday()) return () => undefined;
  const samples: number[] = [];
  let n = 0;
  const timer = window.setInterval(() => {
    const s = state();
    if (s && s.frameMs > 0) samples.push(s.frameMs);
    if (++n < 12) return;
    window.clearInterval(timer);
    if (!s) return;
    void send({ ...browserOf(navigator.userAgent), ...webglOf(), tier: tierOf(samples, s.view), profile: s.profile, view: s.view, screen: screenOf(), cores: coresOf() }).catch(() => undefined);
  }, 5000);
  return () => window.clearInterval(timer);
}
