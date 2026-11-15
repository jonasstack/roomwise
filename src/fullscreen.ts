/**
 * Real full screen for the card, without Home Assistant's sidebar and header.
 *
 * Where the browser can show a single element in full screen, the card itself goes full screen and its overlay
 * layer (popups, sheets, toasts, the editor – normally a portal in document.body) moves into the card while it lasts,
 * so everything keeps working on top of the plan. Where it can't or refuses (iPhone Safari, some WebViews and kiosk
 * browsers), a kiosk mode hides Home Assistant's sidebar and header while the card is shown. The button to leave
 * shows only for a few seconds after panning or zooming.
 *
 * Switched on, it is remembered on this device (per card) until it is switched off with the button (or Escape): after
 * reloading, a restart of Home Assistant (the view is rebuilt) or when the browser ends full screen by itself, it comes
 * back at once. Browsers allow real full screen only from a tap, so it first comes back as the kiosk mode and turns
 * into real full screen with the next tap on the card.
 *
 * The kiosk mode reaches into Home Assistant's own elements (home-assistant-main, ha-drawer, ha-sidebar, hui-root).
 * Their inner structure changes between versions: every step is optional and fails silently, and every style it
 * sets is put back exactly as it was.
 */

type FsDoc = Document & { webkitFullscreenEnabled?: boolean; webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => void };

export type FullscreenMode = 'none' | 'fullscreen' | 'kiosk';

/** ms the button to leave full screen stays after the last pan / pinch / wheel */
const REVEAL_MS = 3000;

/** Can this browser show one element (not just the whole page) in full screen? */
export function canElementFullscreen(el: HTMLElement): boolean {
  const d = document as FsDoc;
  return !!((d.fullscreenEnabled && typeof el.requestFullscreen === 'function') || (d.webkitFullscreenEnabled && typeof (el as FsEl).webkitRequestFullscreen === 'function'));
}

function isFullscreen(el: Element): boolean {
  for (const sel of [':fullscreen', ':-webkit-full-screen']) {
    try {
      if (el.matches(sel)) return true;
    } catch {
      /* selector unknown in this browser */
    }
  }
  return false;
}

/** The hosts above an element across shadow roots, nearest first */
function hostsAbove(el: Element): Element[] {
  const out: Element[] = [];
  let n: Node | null = el;
  while (n) {
    const parent: Node | null = n.parentNode;
    if (parent instanceof ShadowRoot) {
      out.push(parent.host);
      n = parent.host;
    } else n = parent;
  }
  return out;
}

/** Hide Home Assistant's sidebar and the dashboard header; returns how to undo it (empty when nothing was found). */
export function hideHomeAssistantChrome(card: Element): (() => void)[] {
  const undo: (() => void)[] = [];
  const set = (el: Element | null | undefined, prop: string, value: string) => {
    if (!(el instanceof HTMLElement)) return;
    const old = el.style.getPropertyValue(prop);
    const prio = el.style.getPropertyPriority(prop);
    el.style.setProperty(prop, value, 'important');
    undo.push(() => {
      if (old) el.style.setProperty(prop, old, prio);
      else el.style.removeProperty(prop);
    });
  };
  try {
    const hosts = hostsAbove(card);
    const main = hosts.find((h) => h.localName === 'home-assistant-main') ?? document.querySelector('home-assistant')?.shadowRoot?.querySelector('home-assistant-main');
    const drawer = main?.shadowRoot?.querySelector('ha-drawer');
    if (drawer) {
      set(drawer, '--mdc-drawer-width', '0px');
      set(drawer.querySelector('ha-sidebar'), 'display', 'none');
      set(drawer.shadowRoot?.querySelector('.mdc-drawer'), 'display', 'none');
      const content = drawer.shadowRoot?.querySelector('.mdc-drawer-app-content');
      set(content, 'margin-left', '0');
      set(content, 'padding-left', '0');
    }
    // the dashboard (hui-root): its header, and the room the view keeps free for it
    const root = hosts.find((h) => h.localName === 'hui-root');
    if (root) {
      set(root, '--header-height', '0px');
      for (const h of root.shadowRoot?.querySelectorAll('.header, app-header, ha-app-header, app-toolbar') ?? []) set(h, 'display', 'none');
      const view = root.shadowRoot?.querySelector('#view');
      set(view, 'padding-top', 'env(safe-area-inset-top)');
    }
  } catch {
    /* Home Assistant changed its inside: stay as it is */
  }
  return undo;
}

/** Full screen (or kiosk) state of one card. `layer()` is the card's overlay layer, `onChange` re-renders the card. */
export class CardFullscreen {
  mode: FullscreenMode = 'none';
  /** the button to leave is shown: only after panning or zooming, for a few seconds */
  revealed = false;
  private undo: (() => void)[] = [];
  private listening = false;
  private revealTimer?: number;
  /** a finger or button is down: shown controls stay (holding the compass, rotating) */
  private down = false;
  private revealAt = 0;
  /** real full screen was refused after a restore (kiosk browser, WebView): do not ask again on every tap */
  private upgradeFailed = false;
  private restoreTimer?: number;

  constructor(
    private card: HTMLElement,
    private layer: () => HTMLElement | undefined,
    private onChange: () => void,
    /** key of the card on this device ("fp-fs-<card id>"), for remembering it */
    private key: () => string = () => 'fp-fs-plan',
  ) {}

  /** switched on by the user (and not off with the button since): kept across reloads on this device */
  get wanted(): boolean {
    try {
      return localStorage.getItem(this.key()) === '1';
    } catch {
      return false;
    }
  }

  private set wanted(on: boolean) {
    try {
      if (on) localStorage.setItem(this.key(), '1');
      else localStorage.removeItem(this.key());
    } catch {
      /* storage blocked: not remembered */
    }
  }

  /** On the page again (reload, restart, view rebuilt): back to full screen when it was on. */
  restore() {
    clearTimeout(this.restoreTimer);
    // a moment later: Home Assistant's elements around the card (for the kiosk mode) are there by then
    this.restoreTimer = window.setTimeout(() => {
      if (this.wanted && !this.active && this.card.isConnected) void this.enter();
    }, 300);
  }

  connect() {
    if (this.listening) return;
    this.listening = true;
    document.addEventListener('fullscreenchange', this.sync);
    document.addEventListener('webkitfullscreenchange', this.sync);
    window.addEventListener('keydown', this.onKey, { capture: true });
    window.addEventListener('popstate', this.onNavigate);
    window.addEventListener('location-changed', this.onNavigate);
    this.card.addEventListener('wheel', this.onMove, { passive: true });
    this.card.addEventListener('pointermove', this.onMove, { passive: true });
    this.card.addEventListener('touchmove', this.onMove, { passive: true });
    this.card.addEventListener('pointerdown', this.onDown, { passive: true });
    // a tap allows real full screen: pointerdown for the mouse, pointerup for touch and pen (what browsers accept)
    this.card.addEventListener('pointerdown', this.upgrade, { capture: true });
    this.card.addEventListener('pointerup', this.upgrade, { capture: true });
    window.addEventListener('pointerup', this.onUp, { passive: true });
    window.addEventListener('pointercancel', this.onUp, { passive: true });
  }

  /** The card leaves the page (navigation, dashboard edit): everything back to normal */
  disconnect() {
    this.listening = false;
    document.removeEventListener('fullscreenchange', this.sync);
    document.removeEventListener('webkitfullscreenchange', this.sync);
    window.removeEventListener('keydown', this.onKey, { capture: true });
    window.removeEventListener('popstate', this.onNavigate);
    window.removeEventListener('location-changed', this.onNavigate);
    this.card.removeEventListener('wheel', this.onMove);
    this.card.removeEventListener('pointermove', this.onMove);
    this.card.removeEventListener('touchmove', this.onMove);
    this.card.removeEventListener('pointerdown', this.onDown);
    this.card.removeEventListener('pointerdown', this.upgrade, { capture: true });
    this.card.removeEventListener('pointerup', this.upgrade, { capture: true });
    clearTimeout(this.restoreTimer);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onUp);
    this.hide();
    if (this.mode === 'fullscreen') this.exitFullscreen();
    this.unkiosk();
    this.placeLayer(false);
    this.mode = 'none';
  }

  get active(): boolean {
    return this.mode !== 'none';
  }

  /** The button: on (remembered) / off (forgotten) */
  toggle() {
    if (this.active) this.exit(true);
    else {
      this.wanted = true;
      this.upgradeFailed = false;
      void this.enter();
    }
  }

  async enter() {
    if (this.active) return;
    const el = this.card as FsEl;
    if (canElementFullscreen(el)) {
      this.placeLayer(true);
      try {
        if (typeof el.requestFullscreen === 'function') await el.requestFullscreen({ navigationUI: 'hide' });
        else el.webkitRequestFullscreen?.();
        this.mode = 'fullscreen';
        this.onChange();
        return;
      } catch {
        // refused (no user gesture, a kiosk browser's setting …): the kiosk mode instead
        this.placeLayer(false);
      }
    }
    this.undo = hideHomeAssistantChrome(this.card);
    if (this.undo.length) {
      this.mode = 'kiosk';
      this.card.toggleAttribute('kiosk', true);
      this.onChange();
    }
    this.settleKiosk();
  }

  /** Right after a reload Home Assistant builds its sidebar and header bit by bit: a part not there yet at the first
   * try stayed visible (a bar on the left) until the first tap. Hide again a few times while the page settles, and
   * tell the page its size changed so the plan fits the full area at once. */
  private settleTimers: number[] = [];
  private settleKiosk() {
    for (const t of this.settleTimers) clearTimeout(t);
    this.settleTimers = [300, 900, 2000, 4000, 7000].map((ms) =>
      window.setTimeout(() => {
        if (!this.card.isConnected || !this.wanted || this.mode === 'fullscreen') return;
        if (this.mode === 'kiosk') {
          for (const u of this.undo.reverse()) {
            try {
              u();
            } catch {
              /* element gone */
            }
          }
        }
        this.undo = hideHomeAssistantChrome(this.card);
        if (this.undo.length && this.mode !== 'kiosk') {
          this.mode = 'kiosk';
          this.card.toggleAttribute('kiosk', true);
          this.onChange();
        }
        window.dispatchEvent(new Event('resize'));
      }, ms),
    );
  }

  /** `byUser`: the button or Escape – not remembered any more; else (the card goes away) it comes back later */
  exit(byUser = false) {
    if (byUser) this.wanted = false;
    this.hide();
    if (this.mode === 'fullscreen') this.exitFullscreen();
    this.unkiosk();
    this.placeLayer(false);
    this.mode = 'none';
    this.onChange();
  }

  /** A layer made while in full screen belongs into the card too */
  adopt(layer: HTMLElement) {
    if (this.mode === 'fullscreen') this.placeLayer(true, layer);
  }

  private exitFullscreen() {
    const d = document as FsDoc;
    if (!isFullscreen(this.card)) return;
    if (typeof d.exitFullscreen === 'function') d.exitFullscreen().catch(() => {});
    else d.webkitExitFullscreen?.();
  }

  private unkiosk() {
    for (const t of this.settleTimers) clearTimeout(t);
    this.settleTimers = [];
    for (const u of this.undo.reverse()) {
      try {
        u();
      } catch {
        /* element gone */
      }
    }
    this.undo = [];
    this.card.removeAttribute('kiosk');
  }

  /** inside = into the card's shadow root (shown in full screen), else back to document.body */
  private placeLayer(inside: boolean, layer = this.layer()) {
    if (!layer) return;
    const target = inside ? this.card.shadowRoot : document.body;
    if (target && layer.parentNode !== target) target.appendChild(layer);
  }

  /** Full screen ended by the browser (Escape, swipe, back gesture) or began elsewhere */
  private sync = () => {
    const on = isFullscreen(this.card);
    if (!on && this.mode === 'fullscreen') {
      this.hide();
      this.mode = 'none';
      this.placeLayer(false);
      // ended by the browser (focus lost, the WebView, a gesture), not by the button: it stays on – as kiosk mode until
      // the next tap brings real full screen back
      if (this.wanted) {
        this.undo = hideHomeAssistantChrome(this.card);
        if (this.undo.length) {
          this.mode = 'kiosk';
          this.card.toggleAttribute('kiosk', true);
        }
      }
      this.onChange();
    }
  };

  /** Restored as kiosk mode: the first tap on the card turns it into real full screen (needs that tap). */
  private upgrading = false;
  private upgrade = (e: PointerEvent) => {
    if ((e.type === 'pointerdown') !== (e.pointerType === 'mouse')) return;
    if (this.upgrading || this.mode !== 'kiosk' || !this.wanted || this.upgradeFailed || !canElementFullscreen(this.card)) return;
    this.upgrading = true;
    const el = this.card as FsEl;
    this.placeLayer(true);
    const done = () => {
      this.upgrading = false;
      this.unkiosk();
      this.mode = 'fullscreen';
      this.onChange();
    };
    const failed = () => {
      this.upgrading = false;
      this.upgradeFailed = true;
      this.placeLayer(false);
    };
    try {
      if (typeof el.requestFullscreen === 'function') el.requestFullscreen({ navigationUI: 'hide' }).then(done, failed);
      else {
        el.webkitRequestFullscreen?.();
        window.setTimeout(() => (isFullscreen(this.card) ? done() : failed()), 300);
      }
    } catch {
      failed();
    }
  };

  private onKey = (e: KeyboardEvent) => {
    // in the kiosk mode Escape ends it, unless a popup or sheet is open (then Escape closes that first)
    if (e.key !== 'Escape' || this.mode !== 'kiosk') return;
    const layer = this.layer() as (HTMLElement & { hasDialog?: boolean }) | undefined;
    if (layer?.hasDialog) return;
    this.exit(true);
  };

  /** Panning (a pressed pointer or a finger moving), pinching or the wheel: show the button to leave for a while */
  private onMove = (e: Event) => {
    if (this.mode === 'none') return;
    if (e.type === 'pointermove') {
      const p = e as PointerEvent;
      if (p.pointerType === 'mouse' ? !p.buttons : !p.pressure && !p.buttons) return;
    }
    const now = performance.now();
    if (this.revealed && now - this.revealAt < 250) return; // moves come many per second: renew the timer now and then
    this.revealAt = now;
    clearTimeout(this.revealTimer);
    this.revealTimer = window.setTimeout(this.expire, REVEAL_MS);
    if (!this.revealed) {
      this.revealed = true;
      this.onChange();
    }
  };

  private onDown = () => {
    this.down = true;
  };

  private onUp = () => {
    this.down = false;
  };

  /** time is up: hide, unless a finger is still down (then a moment later) */
  private expire = () => {
    if (this.down && this.revealed) this.revealTimer = window.setTimeout(this.expire, 500);
    else this.hide();
  };

  private hide() {
    clearTimeout(this.revealTimer);
    if (!this.revealed) return;
    this.revealed = false;
    this.onChange();
  }

  private onNavigate = () => {
    // another view or dashboard: the kiosk mode belongs to this card only
    if (this.mode === 'kiosk') setTimeout(() => this.card.isConnected || this.exit(), 300);
  };
}
