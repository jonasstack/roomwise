/**
 * Keyboard and screen reader helpers shared by the plan, the popups and the editor: focus across shadow roots,
 * a focus trap for dialogs, spatial arrow navigation and the reduced-motion preference.
 */

/** The element that really has the focus (inside shadow roots) */
export function deepActive(): HTMLElement | null {
  let a = document.activeElement as HTMLElement | null;
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement as HTMLElement;
  return a;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** Tabbable elements in document order, looking into open shadow roots and slots */
export function tabbables(root: Element | ShadowRoot): HTMLElement[] {
  const out: HTMLElement[] = [];
  const visit = (node: Element | ShadowRoot) => {
    const assigned = node instanceof HTMLSlotElement ? node.assignedElements({ flatten: true }) : [];
    const kids = assigned.length ? assigned : Array.from(node.children);
    for (const el of kids) {
      const h = el as HTMLElement;
      if (h.hidden || h.getAttribute('aria-hidden') === 'true' || h.hasAttribute('inert')) continue;
      if (h.matches(FOCUSABLE) && isVisible(h)) out.push(h);
      // a shadow host shows its own children only through its slots
      if (h.shadowRoot) visit(h.shadowRoot);
      else visit(h);
    }
  };
  visit(root);
  return out;
}

function isVisible(el: HTMLElement): boolean {
  if (typeof el.checkVisibility === 'function') return el.checkVisibility({ visibilityProperty: true } as CheckVisibilityOptions);
  const r = el.getBoundingClientRect();
  return r.width > 0 || r.height > 0;
}

/** Tab / Shift+Tab stay inside `container` (a dialog). Returns true when it moved the focus. */
export function trapTab(e: KeyboardEvent, container: Element | ShadowRoot): boolean {
  if (e.key !== 'Tab') return false;
  const items = tabbables(container);
  if (!items.length) {
    e.preventDefault();
    return true;
  }
  const active = deepActive();
  const i = active ? items.indexOf(active) : -1;
  const inside = i >= 0 || (active && (container instanceof ShadowRoot ? container.host.contains(active) || container.contains(active) : container.contains(active)));
  let next: HTMLElement | undefined;
  if (!inside || i < 0) next = e.shiftKey ? items[items.length - 1] : items[0];
  else if (e.shiftKey && i === 0) next = items[items.length - 1];
  else if (!e.shiftKey && i === items.length - 1) next = items[0];
  if (!next) return false;
  e.preventDefault();
  next.focus();
  return true;
}

/** Focus the first sensible element of a dialog (its first control, else the dialog itself) */
export function focusFirst(container: HTMLElement, fallback?: HTMLElement) {
  const items = tabbables(container);
  // skip a leading close button when there is something better to start with
  const first = items.find((el) => !/close|schließen/i.test(el.getAttribute('aria-label') ?? '')) ?? items[0];
  (first ?? fallback ?? container).focus({ preventScroll: true });
}

/** The person asked the system for less motion */
export function reducedMotion(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The next item for an arrow key, by where the items are on screen: the closest one in that direction (sideways
 * distance counts double). Undefined when there is none.
 */
export function spatialNext<T>(items: { item: T; x: number; y: number }[], from: { x: number; y: number }, key: string): T | undefined {
  const dir = key === 'ArrowLeft' ? [-1, 0] : key === 'ArrowRight' ? [1, 0] : key === 'ArrowUp' ? [0, -1] : key === 'ArrowDown' ? [0, 1] : undefined;
  if (!dir) return undefined;
  let best: T | undefined;
  let score = Infinity;
  for (const c of items) {
    const dx = c.x - from.x;
    const dy = c.y - from.y;
    const along = dx * dir[0] + dy * dir[1];
    if (along <= 4) continue;
    const side = Math.abs(dx * dir[1] - dy * dir[0]);
    const s = along + side * 2;
    if (s < score) {
      score = s;
      best = c.item;
    }
  }
  return best;
}
