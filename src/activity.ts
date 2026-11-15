/**
 * Shared "the user is moving the view" signal: background work (weather animation, floor rasterizing,
 * prebuilding) steps aside while a gesture or camera flight is running.
 * Also: when somebody last touched the card — calm, purely decorative life (the dog strolling, cloud
 * frame rate) winds down on an unattended wall tablet.
 */
let until = 0;
let touched = performance.now();

export function markActive(ms = 300) {
  until = Math.max(until, performance.now() + ms);
  touched = performance.now();
}

export function isActive() {
  return performance.now() < until;
}

/** Somebody tapped / looked at the card (without moving the view) */
export function noteTouch() {
  touched = performance.now();
}

/** Milliseconds since the last touch or gesture */
export function idleFor() {
  return performance.now() - touched;
}

/** Nobody has used the card for a while: decorative animations rest */
export const UNATTENDED = 4 * 60 * 1000;
