import { LitElement, css, html } from 'lit';
import { shared } from '../design/shared';

/**
 * Modal surface: bottom sheet on narrow screens, centred panel on wide ones.
 * Fires "close" on scrim tap or Escape.
 */
export class HrSheet extends LitElement {
  static override properties = { width: { type: Number }, label: { type: String } };
  declare width: number;
  declare label: string;

  constructor() {
    super();
    this.width = 720;
    this.label = '';
  }

  /** open sheets, newest last: only the top one reacts to Escape */
  private static stack: HrSheet[] = [];

  private readonly _key = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && HrSheet.stack[HrSheet.stack.length - 1] === this) {
      e.stopImmediatePropagation();
      this._close();
    }
  };

  /** scroll containers of the page behind, locked while a sheet is open (with their old overflow) */
  private static locked: { el: HTMLElement; overflow: string }[] = [];

  override connectedCallback(): void {
    super.connectedCallback();
    HrSheet.stack.push(this);
    window.addEventListener('keydown', this._key);
    if (HrSheet.stack.length === 1) this._lockPage();
  }
  override disconnectedCallback(): void {
    super.disconnectedCallback();
    HrSheet.stack = HrSheet.stack.filter((s) => s !== this);
    window.removeEventListener('keydown', this._key);
    if (!HrSheet.stack.length) HrSheet._unlockPage();
  }

  /** the page behind must not scroll along: lock every scrolling ancestor (also across shadow roots) */
  private _lockPage() {
    const found: HTMLElement[] = [];
    let n: Node | null = this;
    while (n) {
      const parent: Node | null = (n as HTMLElement).parentElement ?? ((n.getRootNode() as ShadowRoot).host ?? null);
      if (parent === n) break;
      n = parent;
      if (n instanceof HTMLElement) {
        const oy = getComputedStyle(n).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) found.push(n);
      }
    }
    const root = document.scrollingElement as HTMLElement | null;
    if (root) found.push(root);
    HrSheet.locked = found.map((el) => ({ el, overflow: el.style.overflow }));
    for (const el of found) el.style.overflow = 'hidden';
  }

  private static _unlockPage() {
    for (const { el, overflow } of HrSheet.locked) el.style.overflow = overflow;
    HrSheet.locked = [];
  }

  // touch scrolling on the dark backdrop would move the page on iOS: swallow it
  private readonly _noScroll = (e: Event) => e.preventDefault();

  private _close() {
    this.dispatchEvent(new CustomEvent('close'));
  }

  static override styles = [
    shared,
    css`
      :host {
        position: fixed;
        inset: 0;
        z-index: 10;
        display: flex;
        align-items: flex-end;
        justify-content: center;
      }
      .scrim {
        position: absolute;
        inset: 0;
        background: var(--hr-scrim);
        animation: fade var(--hr-dur) var(--hr-ease);
      }
      .sheet {
        position: relative;
        width: 100%;
        overscroll-behavior: contain;
        max-height: calc(100% - 24px);
        display: flex;
        flex-direction: column;
        background: var(--hr-bg);
        border-radius: var(--hr-radius-xl) var(--hr-radius-xl) 0 0;
        box-shadow: var(--hr-shadow-3);
        overflow: hidden;
        animation: up var(--hr-dur) var(--hr-ease);
        padding-bottom: env(safe-area-inset-bottom, 0px);
      }
      @media (min-width: 760px) {
        :host {
          align-items: center;
          padding: 24px;
        }
        .sheet {
          border-radius: var(--hr-radius-xl);
          max-height: min(900px, 100%);
          animation-name: pop;
        }
      }
      @keyframes fade {
        from {
          opacity: 0;
        }
      }
      @keyframes up {
        from {
          transform: translateY(40px);
          opacity: 0;
        }
      }
      @keyframes pop {
        from {
          transform: scale(0.97);
          opacity: 0;
        }
      }
    `,
  ];

  override render() {
    return html`<div class="scrim" @click=${this._close} @touchmove=${this._noScroll} @wheel=${this._noScroll}></div>
      <section class="sheet" role="dialog" aria-modal="true" aria-label=${this.label} style="max-width:${this.width}px">
        <slot></slot>
      </section>`;
  }
}
customElements.define('hr-sheet', HrSheet);
