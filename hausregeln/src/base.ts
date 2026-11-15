import { LitElement, type PropertyValues } from 'lit';
import type { Store } from './store';
import { liveStore, type HassLike } from './live';

/** A Lit element that re-renders whenever the store changes. */
export class StoreElement extends LitElement {
  static override properties = { store: { attribute: false }, place: { attribute: false } };
  declare store: Store;
  /** a place in this view that a link points to (the panel hands it over once): see reveal() */
  declare place: string | undefined;

  /** Used on its own (e.g. in the floorplan card): hand over hass, the shared live store is used. */
  set hass(h: HassLike | undefined) {
    if (h?.connection) {
      const s = liveStore(h);
      if (this.store !== s) this.store = s;
    }
  }
  private _sub?: Store;
  private _missed = false;
  private readonly _onChange = () => {
    // while a window with unsaved input is open, live updates wait (nothing jumps or resets under the finger)
    if (this.frozen()) {
      this._missed = true;
      return;
    }
    this.requestUpdate();
  };

  /** true while live updates should not re-render this element */
  protected frozen(): boolean {
    return false;
  }

  /** call when the window closes: catch up on what came in meanwhile */
  protected thaw(): void {
    if (this._missed) {
      this._missed = false;
      this.requestUpdate();
    }
  }

  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has('store') && this._sub !== this.store) {
      this._sub?.removeEventListener('change', this._onChange);
      this._sub = this.store;
      this._sub?.addEventListener('change', this._onChange);
    }
  }

  protected override updated(changed: PropertyValues): void {
    super.updated(changed);
    if (changed.has('place') && this.place) this.reveal(this.place);
  }

  /** A link points to a place in this view: scroll to the element with that id (and open it and every fold around
   * it). Views with places that open differently override this. */
  protected reveal(anchor: string): void {
    const el = this.renderRoot.querySelector<HTMLElement>(`#${CSS.escape(anchor)}`);
    if (!el) return;
    for (let p: HTMLElement | null = el; p; p = p.parentElement) if (p instanceof HTMLDetailsElement) p.open = true;
    // after the folds opened and laid out; once more if parts above it grew meanwhile (data that arrives later)
    requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    setTimeout(() => {
      if (Math.abs(el.getBoundingClientRect().top - 72) > 48) el.scrollIntoView({ block: 'start' });
    }, 700);
  }

  override connectedCallback(): void {
    super.connectedCallback();
    if (this._sub) this._sub.addEventListener('change', this._onChange);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._sub?.removeEventListener('change', this._onChange);
  }
}
