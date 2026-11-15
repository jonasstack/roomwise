// Types of the Emscripten module (chromaprint.js); only what song-capture.ts uses.
export interface ChromaprintModule {
  HEAP16: Int16Array;
  HEAP32: Int32Array;
  UTF8ToString(ptr: number): string;
  _malloc(size: number): number;
  _free(ptr: number): void;
  _chromaprint_new(algorithm: number): number;
  _chromaprint_free(ctx: number): void;
  _chromaprint_start(ctx: number, sampleRate: number, channels: number): number;
  _chromaprint_feed(ctx: number, data: number, size: number): number;
  _chromaprint_finish(ctx: number): number;
  _chromaprint_get_fingerprint(ctx: number, out: number): number;
}
declare function createChromaprintModule(arg?: { locateFile?: (path: string, dir: string) => string }): Promise<ChromaprintModule>;
export default createChromaprintModule;
