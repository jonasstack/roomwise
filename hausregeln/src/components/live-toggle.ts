import { css, html, nothing, type PropertyValues } from 'lit';
import { StoreElement } from '../base';
import { shared } from '../design/shared';
import { kit } from '../design/kit';
import { LightLive, isLight, type LightSetting } from '../lightlive';
import { t } from '../i18n';
// i18n: complete

/**
 * <hr-live-toggle .store .lights .setting .perLight>: "Live an den Lampen ansehen" for a simple light setting that is
 * not edited in <hr-light-action> (Urlaubslicht, Reinschau-Licht). While on, the setting – and every change of it –
 * shows on the real lamps (LightLive: the integration's house_rules/light/preview, or the panel itself); switched off,
 * the window closed or the page left, the lamps go back exactly as they were. Guests cannot drive lamps.
 */
export class HrLiveToggle extends StoreElement {
  static override properties = {
    ...StoreElement.properties,
    lights: { attribute: false },
    setting: { attribute: false },
    perLight: { attribute: false },
    _on: { state: true },
    _note: { state: true },
  };
  declare lights: string[];
  declare setting: LightSetting;
  /** a lamp's own values (e.g. its own brightness) on top of the setting */
  declare perLight: Record<string, LightSetting> | undefined;
  declare _on: boolean;
  declare _note: string;
  private _ctl?: LightLive;
  private _started: string[] = [];
  private readonly _bye = () => void this._stop();

  constructor() {
    super();
    this.lights = [];
    this.setting = {};
    this._on = false;
    this._note = '';
  }

  static override styles = [
    shared,
    kit,
    css`
      :host {
        display: block;
      }
    `,
  ];

  private get _lamps(): string[] {
    return (this.lights ?? []).filter(isLight);
  }

  private _start() {
    if (!this.store.canEdit) {
      this._note = t('light.live_guest');
      return;
    }
    const s = this.store;
    this._ctl = new LightLive(
      { state: (e) => s.lightState(e), call: (sv, e, d) => s.lightCall(sv, e, d), preview: (m) => s.lightPreview(m) },
      (err, e) => {
        const msg = String((err as Error)?.message ?? err);
        this._note = e ? t('light.live_failed', { name: s.device(e)?.name ?? e, error: msg }) : t('light.live_ended', { error: msg });
        if (!e) void this._stop();
      },
    );
    this._started = this._lamps;
    this._ctl.start(this._started);
    this._on = true;
    this._note = '';
    window.addEventListener('pagehide', this._bye);
    this._push();
  }

  private async _stop() {
    const ctl = this._ctl;
    this._ctl = undefined;
    this._on = false;
    window.removeEventListener('pagehide', this._bye);
    await ctl?.stop(true);
  }

  private _push() {
    const ctl = this._ctl;
    if (!ctl) return;
    for (const e of this._lamps) ctl.show([e], { mode: 'on', ...this.setting, ...(this.perLight?.[e] ?? {}) });
  }

  protected override updated(changed: PropertyValues): void {
    super.updated(changed);
    if (!this._on) return;
    if (changed.has('lights') && this._lamps.join() !== this._started.join()) {
      // other lamps chosen: the old ones back, the new ones live
      void this._stop().then(() => this._start());
      return;
    }
    if (changed.has('setting') || changed.has('perLight')) this._push();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    void this._stop();
  }

  override render() {
    const none = !this._lamps.length;
    return html`<div class="rl-box">
      <div class="line">
        <span class="grow"><b>${t('live.title')}</b><small>${none ? t('live.no_lamps') : this._on ? t('light.live_note') : t('live.sub')}</small></span>
        <button class="switch" role="switch" aria-label=${t('live.title')} aria-checked=${this._on ? 'true' : 'false'} ?disabled=${none} @click=${() => (this._on ? void this._stop() : this._start())}></button>
      </div>
      ${this._note ? html`<small>${this._note}</small>` : nothing}
    </div>`;
  }
}
customElements.define('hr-live-toggle', HrLiveToggle);
