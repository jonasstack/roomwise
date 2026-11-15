/**
 * Address of a file shipped next to the card (3D models in models/). The build splits the card into an entry
 * and chunks in chunks/ (tools/build.mjs): code in a chunk finds the card's folder one level up; the single-file
 * build (card-only install) lies in that folder itself.
 */
export function assetUrl(path: string): string {
  try {
    const here = import.meta.url;
    return new URL((/\/chunks\/[^/]*$/.test(new URL(here).pathname) ? '../' : './') + path, here).href;
  } catch {
    return `/local/floorplan-card/${path}`;
  }
}

/**
 * A lazily loaded chunk (3D scene …) could not be fetched: the card on the server was updated while this page
 * stayed open (the old chunks are gone), or the network dropped for a moment. Browsers remember a failed module
 * fetch for the life of the page, so only a reload brings it back. A wall tablet never reloads by itself:
 * reload once nobody has touched the page for a while (or it is hidden), at most once per 10 minutes, never
 * while the editor is open. Errors thrown by the chunk's own code are not fetch failures and never reload.
 */
export function reloadForChunk(err: unknown, busy: () => boolean): boolean {
  const msg = String((err as Error)?.message ?? err);
  if (!(err instanceof TypeError) || !/dynamically imported module|module script failed|failed to fetch|load failed/i.test(msg)) return false;
  const KEY = 'fp-chunk-reload';
  try {
    if (Date.now() - Number(sessionStorage.getItem(KEY) ?? 0) < 600_000) return false;
  } catch {
    return false; // without storage there is no guard against a reload loop
  }
  if (pendingReload) return true;
  pendingReload = true;
  let last = performance.now();
  const touch = () => (last = performance.now());
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(ev, touch, { capture: true, passive: true });
  const timer = window.setInterval(() => {
    if (navigator.onLine === false || busy()) return;
    if (!document.hidden && performance.now() - last < IDLE_BEFORE_RELOAD) return;
    clearInterval(timer);
    try {
      sessionStorage.setItem(KEY, String(Date.now()));
    } catch {
      return;
    }
    location.reload();
  }, 2000);
  return true;
}
let pendingReload = false;
/** Quiet time before the page reloads for a missing chunk (ms) */
const IDLE_BEFORE_RELOAD = 15_000;
