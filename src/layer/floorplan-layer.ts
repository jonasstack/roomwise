import { LitElement, css, html, nothing, type PropertyValues } from 'lit';
import { unsafeStatic, html as staticHtml } from 'lit/static-html.js';
import { tokens, MOTION } from '../design/tokens';
import { components } from '../design/components';
import type { EditorStart, FloorplanCardConfig, FurnitureConfig, HomeAssistant, PopupTarget } from '../types';
import type { FloorplanCard } from '../floorplan-card';
import { POPUP_DOMAINS } from '../actions';
import { domainOf, entityName, fireEvent } from '../ha';
import { deepActive, focusFirst, trapTab } from '../a11y';
import { t } from '../i18n';
import type { PopupContext } from '../popups/popup-base';
import '../popups/light-popup';
import '../popups/climate-popup';
import '../popups/cover-popup';
import '../popups/room-popup';
import '../popups/vacuum-popup';
import '../popups/todo-popup';
import '../popups/lawn-mower-popup';
import '../popups/valve-popup';
import '../popups/lock-popup';
import '../popups/furniture-popup';
import '../popups/appliance-popup';
import '../components/slide-confirm';
import type { OpenRequest } from '../access';
import { houseRules, loadHouseRulesUi, type HrRule } from '../house-rules';

/** The editor, the car popup (it brings three.js for its picture) and the media popup (own buttons) are chunks of their own: fetched the first time they open, so the card starts without them */
const LAZY: Record<string, () => Promise<unknown>> = {
  'fp-car-popup': () => import('../popups/car-popup'),
  'fp-media-player-popup': () => import('../popups/media-player-popup'),
  'fp-wifi-popup': () => import('../popups/wifi-popup'),
  'floorplan-card-editor-ui': () => import('../editor/editor-ui'),
};
const popupTag = (target: PopupTarget) =>
  target.room ? 'fp-room-popup' : target.piece ? 'fp-furniture-popup' : target.wifi ? 'fp-wifi-popup' : target.appliance ? 'fp-appliance-popup' : target.car ? 'fp-car-popup' : target.media ? 'fp-media-player-popup' : `fp-${domainOf(target.entity!).replace('_', '-')}-popup`;

interface PopupEntry extends PopupTarget {
  key: number;
}

/**
 * Portal attached to document.body. Hosts popups, confirmations, toasts and the editor so they are
 * never clipped by dashboard containers (container queries / transforms create containing blocks).
 */
export class FloorplanLayer extends LitElement {
  static override properties = {
    hass: { attribute: false },
    dark: { type: Boolean, reflect: true },
    _dog: { state: true },
    _stack: { state: true },
    _closing: { state: true },
    _confirm: { state: true },
    _open: { state: true },
    _toast: { state: true },
    _editor: { state: true },
    _hr: { state: true },
  };
  /** Hausregeln sheet: everything about one device, or the sentence editor for a rule */
  declare _hr?: { kind: 'device'; entity: string } | { kind: 'editor'; rule?: HrRule; isNew: boolean };
  declare _dog?: { f: FurnitureConfig; resolve: (f: FurnitureConfig | undefined) => void };

  declare hass: HomeAssistant;
  declare dark: boolean;
  declare _stack: PopupEntry[];
  declare _closing: boolean;
  declare _confirm?: { text: string; resolve: (ok: boolean) => void };
  /** Second step before something opens (garage door, gate, lock, a car's sunroof …): slide to confirm */
  declare _open?: OpenRequest & { resolve: (ok: boolean) => void };
  declare _toast?: { text: string; key: number };
  declare _editor?: { floorId?: string; start?: EditorStart };

  card?: FloorplanCard;
  private cardConfig?: FloorplanCardConfig;
  private storedConfig?: FloorplanCardConfig;
  private toastTimer?: number;
  private closeTimer?: number;
  private key = 0;

  static attach(card: FloorplanCard): FloorplanLayer {
    const el = document.createElement('floorplan-card-layer') as FloorplanLayer;
    el.card = card;
    document.body.appendChild(el);
    return el;
  }

  constructor() {
    super();
    this._stack = [];
    this._closing = false;
    this.dark = false;
  }

  detach(card: FloorplanCard) {
    if (this.card !== card) return;
    if (this._editor) return; // keep the editor alive while the dashboard re-renders underneath
    this._confirm?.resolve(false);
    this._open?.resolve(false);
    this.remove();
  }

  /** cfg: as shown (popups); stored: as saved in the dashboard (the editor works on it, without what Hausregeln adds) */
  setCardConfig(cfg: FloorplanCardConfig, stored?: FloorplanCardConfig) {
    this.cardConfig = cfg;
    this.storedConfig = stored ?? cfg;
    this.requestUpdate();
  }

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener('keydown', this.onKey);
    this.syncCover();
  }

  /** The card underneath rests while anything covers it (also while a popup slides out) */
  private syncCover() {
    if (this.hasUpdated) this.card?.setCovered(this.openDialogs > 0 || !!this._open || this._closing);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this.onKey);
    this.card?.setCovered(false);
  }

  private onKey = (e: KeyboardEvent) => {
    // Tab stays inside the topmost dialog (popup, confirmation, editor)
    if (e.key === 'Tab') {
      const d = this.topDialog();
      if (d) trapTab(e, d);
      return;
    }
    if (e.key !== 'Escape') return;
    if (this._open) this.resolveOpen(false);
    else if (this._confirm) this.resolveConfirm(false);
    else if (this._dog) this.closeDog(undefined);
    else if (this._hr) this.closeHouseRules();
    else if (this._stack.length) this.closePopup();
  };

  // ---------- Focus (keyboard, screen readers) ----------

  /** Where the focus was before each open dialog (it goes back there when the dialog closes) */
  private focusStack: (HTMLElement | null)[] = [];

  /** Is a popup, sheet, confirmation or the editor open? (Escape belongs to it then) */
  get hasDialog(): boolean {
    return !!this.topDialog();
  }

  /** The dialog on top: confirmation, dog editor, Hausregeln, popup, editor */
  private topDialog(): Element | ShadowRoot | undefined {
    const r = this.renderRoot;
    const sheet = r.querySelector('.alert') ?? r.querySelector('.dog-sheet') ?? r.querySelector('.hr-sheet') ?? r.querySelector('.sheet');
    if (sheet) return sheet;
    const ed = r.querySelector('floorplan-card-editor-ui');
    return ed?.shadowRoot ?? undefined;
  }

  private get openDialogs(): number {
    return [this._editor, this._stack.length && !this._closing, this._hr, this._dog, this._confirm].filter(Boolean).length;
  }

  private lastOpen = 0;
  override updated(changed: PropertyValues) {
    super.updated(changed);
    const n = this.openDialogs;
    this.syncCover();
    if (n > this.lastOpen) {
      // a dialog opened: remember where the focus was, then move it into the dialog
      for (let i = this.lastOpen; i < n; i++) this.focusStack.push(deepActive());
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const d = this.topDialog();
          const el = d instanceof ShadowRoot ? (d.host as HTMLElement) : (d as HTMLElement | undefined);
          if (!el) return;
          const inside = deepActive();
          // already inside (the editor focuses its own first control): leave it
          if (inside && (d instanceof ShadowRoot ? d.contains(inside) : el.contains(inside))) return;
          if (d instanceof ShadowRoot) focusFirst(d.host.shadowRoot!.querySelector('.editor') as HTMLElement ?? el, el);
          else focusFirst(el, el);
        }),
      );
    } else if (n < this.lastOpen) {
      // closed: the focus goes back to what opened it
      let back: HTMLElement | null | undefined;
      for (let i = n; i < this.lastOpen; i++) back = this.focusStack.pop();
      if (back?.isConnected) requestAnimationFrame(() => back!.focus({ preventScroll: true }));
    }
    this.lastOpen = n;
  }

  /** The popup's name for screen readers */
  private dialogLabel(entry: PopupEntry): string {
    if (entry.room) return entry.room.name ?? t('editor.room');
    if (entry.piece) return entry.piece.name ?? t('editor.furniture_item');
    if (entry.wifi) return entry.wifi.name || t('wifi.title');
    const id = entry.car?.entity ?? entry.entity;
    return entry.car?.name ?? entry.name ?? (id && this.hass ? entityName(this.hass, id) : '');
  }

  // ---------- Popups ----------

  openPopup(target: PopupTarget) {
    if (target.entity && !target.car && !target.media && !POPUP_DOMAINS.has(domainOf(target.entity))) {
      fireEvent(this.card ?? this, 'hass-more-info', { entityId: target.entity });
      return;
    }
    if (!target.entity && !target.room && !target.car && !target.media && !target.piece && !target.wifi && !target.appliance) return;
    const tag = popupTag(target);
    if (!customElements.get(tag) && LAZY[tag]) {
      if (this.loading === tag) return; // a second tap while it loads
      this.loading = tag;
      void this.load(tag).then((ok) => {
        if (this.loading !== tag) return;
        this.loading = undefined;
        if (ok) this.openPopup(target);
      });
      return;
    }
    this.loading = undefined;
    if (this._closing) {
      // A popup is still animating out: replace it instead of stacking on top.
      clearTimeout(this.closeTimer);
      this._closing = false;
      this._stack = [];
    }
    this._stack = [...this._stack, { ...target, key: ++this.key }];
  }

  private loading?: string;

  /** Fetches a lazily loaded part; false (with a hint) when that fails, e.g. the card was updated meanwhile */
  private async load(tag: string): Promise<boolean> {
    try {
      await LAZY[tag]();
      return true;
    } catch (err) {
      console.warn('floorplan-card: could not load', tag, err);
      this.toast(t('card.reload_needed'));
      return false;
    }
  }

  closePopup = () => {
    if (!this._stack.length || this._closing) return;
    this._closing = true;
    this.closeTimer = window.setTimeout(() => {
      this._stack = [];
      this._closing = false;
    }, MOTION.fast);
  };

  back = () => {
    this._stack = this._stack.slice(0, -1);
  };

  private get popupCtx(): PopupContext {
    const card = this.card!;
    return {
      hass: this.hass,
      getState: card.getState,
      host: card.actionHost,
      close: this.closePopup,
      back: this._stack.length > 1 ? this.back : undefined,
      push: (target) => this.openPopup(target),
      config: this.cardConfig,
      openRules: this.hass && houseRules(this.hass).available ? (entity) => void this.openHouseRules({ kind: 'device', entity }) : undefined,
    };
  }

  // ---------- Hausregeln ----------

  /** Open Hausregeln's own UI (loaded once from the integration) above everything else */
  async openHouseRules(target: { kind: 'device'; entity: string } | { kind: 'editor'; rule?: HrRule; isNew: boolean }) {
    if (!(await loadHouseRulesUi())) return this.toast(t('hr.unavailable'));
    this._hr = target;
  }

  closeHouseRules = () => {
    this._hr = undefined;
  };

  /** The 3D dog editor on a draft of the piece; resolves with the changed piece ("Fertig") or nothing */
  async openDogEditor(f: FurnitureConfig): Promise<FurnitureConfig | undefined> {
    await import('../editor/dog-editor');
    this._dog?.resolve(undefined);
    return new Promise((resolve) => (this._dog = { f, resolve }));
  }

  private closeDog(f: FurnitureConfig | undefined) {
    this._dog?.resolve(f);
    this._dog = undefined;
  }

  private renderDog() {
    const d = this._dog;
    if (!d) return nothing;
    return html`<div class="scrim" @click=${() => this.closeDog(undefined)}></div>
      <div class="sheet-wrap" @click=${(e: Event) => e.target === e.currentTarget && this.closeDog(undefined)}>
        <div class="sheet dog-sheet" role="dialog" aria-modal="true" tabindex="-1" aria-label=${d.f.name ?? t('editor.furniture_item')}>
          <fp-dog-editor
            .furniture=${d.f}
            ?dark=${this.dark}
            @dog-done=${(e: CustomEvent<{ furniture: FurnitureConfig }>) => this.closeDog(e.detail.furniture)}
            @dog-cancel=${() => this.closeDog(undefined)}
          ></fp-dog-editor>
        </div>
      </div>`;
  }

  private renderHouseRules() {
    const h = this._hr;
    if (!h) return nothing;
    return html`<div class="scrim" @click=${this.closeHouseRules}></div>
      <div class="sheet-wrap" @click=${(e: Event) => e.target === e.currentTarget && this.closeHouseRules()}>
        <div class="sheet hr-sheet" role="dialog" aria-modal="true" tabindex="-1" aria-label=${t('hr.rules')}>
          ${h.kind === 'device'
            ? html`<house-rules-device
                standalone
                entity-id=${h.entity}
                ?dark=${this.dark}
                .hass=${this.hass}
                .closable=${true}
                @close=${this.closeHouseRules}
              ></house-rules-device>`
            : html`<house-rules-editor
                standalone
                ?dark=${this.dark}
                .hass=${this.hass}
                .isNew=${h.isNew}
                .rule=${h.rule ?? { id: '', name: '', type: 'when', when: [], and: [], then: [], only: [], enabled: true, options: {} }}
                @rule-saved=${this.closeHouseRules}
                @closed=${this.closeHouseRules}
              ></house-rules-editor>`}
        </div>
      </div>`;
  }

  // ---------- Confirm & toast ----------

  confirm(text: string): Promise<boolean> {
    this._confirm?.resolve(false);
    return new Promise((resolve) => (this._confirm = { text, resolve }));
  }

  private resolveConfirm(ok: boolean) {
    this._confirm?.resolve(ok);
    this._confirm = undefined;
  }

  /** Opening access (see access.ts): a sheet naming exactly what opens, confirmed only by sliding to the end */
  confirmOpen(req: OpenRequest): Promise<boolean> {
    this._open?.resolve(false);
    return new Promise((resolve) => (this._open = { ...req, resolve }));
  }

  private resolveOpen(ok: boolean) {
    this._open?.resolve(ok);
    this._open = undefined;
  }

  toast(text: string) {
    clearTimeout(this.toastTimer);
    this._toast = { text, key: ++this.key };
    this.toastTimer = window.setTimeout(() => (this._toast = undefined), 3200);
  }

  // ---------- Editor ----------

  /** start: open with a suggested plan in the draft (first steps: HA areas, the example); unsaved until "Save" */
  async openEditor(floorId?: string, start?: EditorStart) {
    if (!customElements.get('floorplan-card-editor-ui') && !(await this.load('floorplan-card-editor-ui'))) return;
    this._stack = [];
    this._editor = { floorId, start };
  }

  closeEditor = () => {
    this._editor = undefined;
    if (this.card && !this.card.isConnected) this.remove();
  };

  // ---------- Render ----------

  override render() {
    const top = this._stack[this._stack.length - 1];
    return html`
      ${this._editor && this.card
        ? html`<floorplan-card-editor-ui
            .hass=${this.hass}
            .card=${this.card}
            .config=${this.storedConfig ?? this.cardConfig}
            .floorId=${this._editor.floorId}
            .start=${this._editor.start}
            .layer=${this}
            role="dialog"
            aria-modal="true"
            aria-label=${t('card.edit')}
            @fp-editor-close=${this.closeEditor}
          ></floorplan-card-editor-ui>`
        : nothing}
      ${top
        ? html`<div class="scrim ${this._closing ? 'out' : ''}" @click=${this.closePopup}></div>
            <div class="sheet-wrap ${this._closing ? 'out' : ''}" @click=${(e: Event) => e.target === e.currentTarget && this.closePopup()}>
              <div class="sheet" role="dialog" aria-modal="true" tabindex="-1" aria-label=${this.dialogLabel(top)}>${this.renderPopup(top)}</div>
            </div>`
        : nothing}
      ${this.renderHouseRules()}
      ${this.renderDog()}
      ${this._confirm
        ? html`<div class="scrim" @click=${() => this.resolveConfirm(false)}></div>
            <div class="sheet-wrap">
              <div class="alert" role="alertdialog" aria-modal="true" tabindex="-1" aria-labelledby="fp-confirm-text">
                <div class="alert-text" id="fp-confirm-text">${this._confirm.text}</div>
                <div class="alert-actions">
                  <button class="btn pressable" @click=${() => this.resolveConfirm(false)}>${t('common.cancel')}</button>
                  <button class="btn accent pressable" @click=${() => this.resolveConfirm(true)}>${t('common.confirm')}</button>
                </div>
              </div>
            </div>`
        : nothing}
      ${this._open
        ? html`<div class="scrim" @click=${() => this.resolveOpen(false)}></div>
            <div class="sheet-wrap" @click=${(e: Event) => e.target === e.currentTarget && this.resolveOpen(false)}>
              <div class="alert open-confirm" role="alertdialog" aria-modal="true" aria-labelledby="fp-open-title">
                <div class="open-icon"><ha-icon .icon=${this._open.icon}></ha-icon></div>
                <div class="alert-text" id="fp-open-title">${this._open.title}</div>
                <div class="open-text">${this._open.text}</div>
                <fp-slide-confirm .label=${t(this._open.verb === 'unlock' ? 'access.slide_unlock' : this._open.verb === 'close' ? 'access.slide_close' : 'access.slide_open')} @confirmed=${() => this.resolveOpen(true)}></fp-slide-confirm>
                <button class="btn block pressable open-cancel" @click=${() => this.resolveOpen(false)}>${t('common.cancel')}</button>
              </div>
            </div>`
        : nothing}
      ${this._toast ? html`<div class="toast" role="status">${this._toast.text}</div>` : nothing}
    `;
  }

  private renderPopup(entry: PopupEntry) {
    const ctx = this.popupCtx;
    if (entry.room) return html`<fp-room-popup .ctx=${ctx} .room=${entry.room}></fp-room-popup>`;
    if (entry.piece) return html`<fp-furniture-popup .ctx=${ctx} .piece=${entry.piece}></fp-furniture-popup>`;
    if (entry.wifi) return html`<fp-wifi-popup .ctx=${ctx} .piece=${entry.wifi} .entityId=${''}></fp-wifi-popup>`;
    if (entry.appliance) return html`<fp-appliance-popup .ctx=${ctx} .piece=${entry.appliance} .entityId=${entry.appliance.entity ?? ''}></fp-appliance-popup>`;
    if (entry.car) return html`<fp-car-popup .ctx=${ctx} .car=${entry.car} .entityId=${entry.car.entity ?? ''}></fp-car-popup>`;
    const tag = unsafeStatic(popupTag(entry));
    if (entry.media)
      return html`<fp-media-player-popup
        .ctx=${ctx}
        .entityId=${entry.entity ?? ''}
        .media=${entry.media}
        .deviceName=${entry.name}
        .deviceIcon=${entry.icon}
      ></fp-media-player-popup>`;
    return staticHtml`<${tag} .ctx=${ctx} .entityId=${entry.entity}></${tag}>`;
  }

  static override styles = [
    tokens,
    components,
    css`
      :host {
        position: fixed;
        inset: 0;
        z-index: 9;
        pointer-events: none;
        font-family: var(--fp-font);
      }
      :host > * {
        pointer-events: auto;
      }
      .scrim {
        position: fixed;
        inset: 0;
        /* above the editor (z-index 1): its rule sheets and confirmations open on top of it */
        z-index: 2;
        background: var(--fp-scrim);
        animation: fade-in var(--fp-dur) var(--fp-ease) both;
      }
      .scrim.out {
        animation: fade-out var(--fp-dur-fast) var(--fp-ease-in-out) both;
      }
      .sheet-wrap {
        position: fixed;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--fp-space-6);
        pointer-events: auto;
        z-index: 2;
      }
      .sheet {
        width: min(max(600px, 34vw), 100%);
        max-height: min(900px, calc(100vh - 48px));
        overflow: auto;
        overscroll-behavior: contain;
        background: var(--fp-surface-2);
        border-radius: var(--fp-radius-xl);
        box-shadow: var(--fp-shadow-3);
        animation: sheet-in var(--fp-dur-slow) var(--fp-ease) both;
        scrollbar-width: none;
      }
      .sheet::-webkit-scrollbar {
        display: none;
      }
      /* Hausregeln's own elements need a height to lay out (their editor scrolls inside) */
      .sheet.hr-sheet {
        display: flex;
        flex-direction: column;
        height: min(820px, calc(100vh - 48px));
        overflow: hidden;
        width: min(max(640px, 38vw), 100%);
      }
      .sheet.dog-sheet {
        display: flex;
        flex-direction: column;
        padding: 0;
        overflow: hidden;
        width: min(1180px, calc(100vw - 32px));
        height: min(860px, calc(100vh - 32px));
        max-height: none;
      }
      .sheet.dog-sheet > * {
        flex: 1;
        min-height: 0;
      }
      .sheet.hr-sheet > * {
        flex: 1;
        min-height: 0;
      }
      .sheet-wrap.out .sheet {
        animation: sheet-out var(--fp-dur-fast) var(--fp-ease-in-out) both;
      }
      @media (max-width: 560px) {
        .sheet-wrap {
          align-items: flex-end;
          padding: var(--fp-space-2);
        }
        .sheet {
          border-radius: var(--fp-radius-xl);
        }
      }
      .alert {
        width: min(340px, 100%);
        background: var(--fp-surface-raised);
        border-radius: var(--fp-radius-l);
        box-shadow: var(--fp-shadow-3);
        padding: var(--fp-space-6) var(--fp-space-5) var(--fp-space-5);
        animation: sheet-in var(--fp-dur) var(--fp-ease) both;
        text-align: center;
      }
      .alert-text {
        font-size: var(--fp-text-body);
        font-weight: var(--fp-weight-semibold);
        margin-bottom: var(--fp-space-5);
        line-height: 1.35;
      }
      .alert-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--fp-space-3);
      }
      .open-confirm {
        width: min(380px, 100%);
      }
      .open-icon {
        width: 56px;
        height: 56px;
        margin: 0 auto var(--fp-space-3);
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(255, 59, 48, 0.14);
        color: var(--fp-red);
        --mdc-icon-size: 30px;
      }
      .open-confirm .alert-text {
        margin-bottom: var(--fp-space-2);
      }
      .open-text {
        font-size: var(--fp-text-subhead);
        color: var(--fp-label-2);
        line-height: 1.4;
        margin-bottom: var(--fp-space-5);
      }
      .open-cancel {
        margin-top: var(--fp-space-3);
        width: 100%;
      }
      .toast {
        position: fixed;
        left: 50%;
        bottom: var(--fp-space-7);
        transform: translateX(-50%);
        background: var(--fp-label);
        color: var(--fp-surface);
        padding: var(--fp-space-3) var(--fp-space-5);
        border-radius: var(--fp-radius-full);
        font-size: var(--fp-text-subhead);
        font-weight: var(--fp-weight-semibold);
        box-shadow: var(--fp-shadow-3);
        animation: toast-in var(--fp-dur-slow) var(--fp-ease) both;
        pointer-events: none;
        z-index: 2;
      }
      @keyframes fade-in {
        from {
          opacity: 0;
        }
      }
      @keyframes fade-out {
        to {
          opacity: 0;
        }
      }
      @keyframes sheet-in {
        from {
          opacity: 0;
          transform: translateY(16px) scale(0.98);
        }
      }
      @keyframes sheet-out {
        to {
          opacity: 0;
          transform: translateY(12px) scale(0.98);
        }
      }
      @keyframes toast-in {
        from {
          opacity: 0;
          transform: translate(-50%, 12px);
        }
      }
    `,
  ];
}

if (!customElements.get('floorplan-card-layer')) customElements.define('floorplan-card-layer', FloorplanLayer);
