/**
 * Song recognition, the part that listens (a lazily loaded chunk, never in the entry file): records about 10 s from
 * the browser's microphone, computes the Chromaprint fingerprint in WebAssembly and returns only that fingerprint
 * and the duration. The audio itself stays in memory of this function and is dropped right after.
 * Chromaprint (LGPL-2.1, vendored in src/vendor/chromaprint/) is a separate file fetched on first use.
 */
import createChromaprintModule, { type ChromaprintModule } from './vendor/chromaprint/chromaprint.js';

export type CaptureFailure = 'unsupported' | 'denied' | 'no_mic' | 'suspended' | 'silent' | 'aborted' | 'failed';

export class CaptureError extends Error {
  constructor(public kind: CaptureFailure, message: string = kind) {
    super(message);
  }
}

let mod: Promise<ChromaprintModule> | undefined;
/** The WebAssembly module, loaded once from next to this chunk (chunks/chromaprint.wasm) */
const chromaprint = () => (mod ??= createChromaprintModule({ locateFile: (path) => new URL(path, import.meta.url).href }).catch((e) => ((mod = undefined), Promise.reject(e))));

/** Peak below this: nothing audible, no lookup (saves a request and never sends a fingerprint of silence) */
const SILENT = 0.003;

/** Asks for the microphone once (from a tap in the editor): true = allowed */
export async function askMicrophone(): Promise<CaptureFailure | 'ok'> {
  if (!navigator.mediaDevices?.getUserMedia) return 'unsupported';
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    for (const tr of s.getTracks()) tr.stop();
    return 'ok';
  } catch (e) {
    return failureOf(e);
  }
}

function failureOf(e: unknown): CaptureFailure {
  const name = (e as { name?: string })?.name;
  return name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'no_mic' : 'failed';
}

const aborted = (signal: AbortSignal) => {
  if (signal.aborted) throw new CaptureError('aborted');
};

/** Listens for `ms` and returns the fingerprint (compressed, base64 as AcoustID expects it) and the seconds heard */
export async function listen(ms: number, signal: AbortSignal): Promise<{ fingerprint: string; duration: number }> {
  if (!navigator.mediaDevices?.getUserMedia) throw new CaptureError('unsupported');
  aborted(signal);
  const modP = chromaprint();
  modP.catch(() => undefined);
  let stream: MediaStream;
  try {
    // raw sound: the voice filters of calls would damp the music
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
  } catch (e) {
    throw new CaptureError(failureOf(e), String((e as Error)?.message ?? e));
  }
  const chunks: Float32Array[] = [];
  let ac: AudioContext | undefined;
  let rate = 44100;
  try {
    aborted(signal);
    ac = new AudioContext();
    rate = ac.sampleRate;
    if (ac.state !== 'running') await Promise.race([ac.resume().catch(() => undefined), new Promise((r) => setTimeout(r, 800))]);
    // a browser that never had a tap on this page keeps audio suspended: try again next round
    if ((ac.state as string) !== 'running') throw new CaptureError('suspended');
    const src = ac.createMediaStreamSource(stream);
    // ScriptProcessor works in every supported browser without loading another module (an AudioWorklet would need one)
    const proc = ac.createScriptProcessor(4096, 1, 1);
    proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(proc);
    proc.connect(ac.destination);
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
      };
      const timer = setTimeout(() => (done(), resolve()), ms);
      const stop = () => (done(), reject(new CaptureError('aborted')));
      signal.addEventListener('abort', stop);
      // switched off while the microphone was starting
      if (signal.aborted) stop();
    });
    proc.onaudioprocess = null;
    src.disconnect();
    proc.disconnect();
  } finally {
    // the microphone goes off right away (the browser's own indicator too)
    for (const tr of stream.getTracks()) tr.stop();
    void ac?.close().catch(() => undefined);
  }
  aborted(signal);
  const n = chunks.reduce((s, c) => s + c.length, 0);
  const pcm = new Int16Array(n);
  let o = 0;
  let peak = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      const v = Math.max(-1, Math.min(1, c[i]));
      if (Math.abs(v) > peak) peak = Math.abs(v);
      pcm[o++] = v * 32767;
    }
  }
  chunks.length = 0;
  if (n < rate * 2 || peak < SILENT) throw new CaptureError('silent');
  const fingerprint = await fingerprintOf(await modP, pcm, rate);
  pcm.fill(0);
  if (!fingerprint) throw new CaptureError('silent');
  return { fingerprint, duration: Math.max(1, Math.round(n / rate)) };
}

/** Chromaprint over mono 16-bit samples (the default algorithm, like fpcalc) */
function fingerprintOf(m: ChromaprintModule, pcm: Int16Array, rate: number): string {
  const ctx = m._chromaprint_new(1);
  if (!ctx) throw new CaptureError('failed', 'chromaprint_new');
  const data = m._malloc(pcm.length * 2);
  const out = m._malloc(4);
  try {
    if (!m._chromaprint_start(ctx, rate, 1)) throw new CaptureError('failed', 'chromaprint_start');
    // HEAP views are read after malloc: the memory may have grown
    m.HEAP16.set(pcm, data >> 1);
    if (!m._chromaprint_feed(ctx, data, pcm.length) || !m._chromaprint_finish(ctx)) throw new CaptureError('failed', 'chromaprint_feed');
    if (!m._chromaprint_get_fingerprint(ctx, out)) return '';
    const str = m.HEAP32[out >> 2];
    const fp = m.UTF8ToString(str);
    m._free(str);
    return fp;
  } finally {
    m._free(out);
    m._free(data);
    m._chromaprint_free(ctx);
  }
}
