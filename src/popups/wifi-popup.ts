import { css, html, nothing, svg } from 'lit';
import { PopupBase } from './popup-base';
import type { FurnitureConfig, HomeAssistant } from '../types';
import { entityName, isUnavailable } from '../ha';
import { t } from '../i18n';
import { qrMatrix, qrPath, wifiPayload, type WifiNetwork } from '../wifi-qr';

/** What Home Assistant knows about the router: a guest Wi-Fi QR code (image entity), its on/off switch, the internet
 *  connection and how many devices are connected. Found without any setup: AVM FRITZ!Box Tools (`fritz`) by its
 *  entities, other routers by an image entity that is clearly a guest Wi-Fi QR code. */
export interface RouterInfo {
  image?: string;
  guestSwitch?: string;
  connected?: string;
  devices?: number;
}

const GUEST = /(guest|gast)/i;
const WIFI = /(wifi|wi_fi|wi-fi|wlan)/i;

export function detectRouter(hass: HomeAssistant, piece?: FurnitureConfig): RouterInfo {
  const reg = Object.values(hass.entities ?? {});
  const name = (id: string) => `${id} ${String(hass.states[id]?.attributes.friendly_name ?? '')}`;
  // the piece may name the QR image itself (linked entities); otherwise the router's device decides
  const linked = [piece?.entity, ...Object.values(piece?.entities ?? {})].filter((e): e is string => typeof e === 'string');
  const pieceDevice = linked.map((e) => hass.entities?.[e]?.device_id).find(Boolean);
  const images = reg.filter((e) => e.entity_id.startsWith('image.') && hass.states[e.entity_id]);
  const fritzImages = images.filter((e) => e.platform === 'fritz');
  const guessed = images.filter((e) => e.platform !== 'fritz' && GUEST.test(name(e.entity_id)) && (WIFI.test(name(e.entity_id)) || /qr/i.test(name(e.entity_id))));
  const img =
    linked.find((e) => e.startsWith('image.') && hass.states[e]) ??
    [...fritzImages, ...guessed].sort((a, b) => Number(b.device_id === pieceDevice) - Number(a.device_id === pieceDevice))[0]?.entity_id;
  const imgEntry = img ? hass.entities?.[img] : undefined;
  const device = imgEntry?.device_id ?? pieceDevice;
  const fritz = imgEntry?.platform === 'fritz' || (!!pieceDevice && reg.some((e) => e.device_id === pieceDevice && e.platform === 'fritz'));
  const sameBox = (e: { device_id?: string; platform?: string }) => (fritz ? e.platform === 'fritz' : !!device && e.device_id === device);
  const switches = reg.filter((e) => e.entity_id.startsWith('switch.') && hass.states[e.entity_id] && sameBox(e));
  // FRITZ!Box: the "Wi-Fi Guest" switch (translation key); other routers: a guest Wi-Fi switch of the same device
  const guestSwitch =
    linked.find((e) => e.startsWith('switch.') && GUEST.test(name(e))) ??
    switches.find((e) => e.translation_key === 'wi_fi_guest')?.entity_id ??
    switches.find((e) => GUEST.test(name(e.entity_id)) && WIFI.test(name(e.entity_id)))?.entity_id;
  const out: RouterInfo = { image: img, guestSwitch };
  if (fritz) {
    const boxEntities = reg.filter((e) => e.platform === 'fritz' && (!device || e.device_id === device || !e.device_id));
    out.connected = boxEntities.find((e) => e.entity_id.startsWith('binary_sensor.') && e.translation_key === 'is_connected')?.entity_id;
    // devices the FRITZ!Box reports (device trackers of the integration, if enabled): those at home
    const trackers = reg.filter((e) => e.platform === 'fritz' && e.entity_id.startsWith('device_tracker.') && hass.states[e.entity_id]);
    if (trackers.length) out.devices = trackers.filter((e) => hass.states[e.entity_id]?.state === 'home').length;
  }
  return out;
}

type Source = { kind: 'net'; net: WifiNetwork } | { kind: 'router'; image: string };

/** Wi-Fi: QR codes to join the home's networks (stored in the companion integration, never in the dashboard) and,
 *  with a FRITZ!Box or another router Home Assistant knows, its guest Wi-Fi with an on/off switch */
export class FpWifiPopup extends PopupBase {
  static override properties = {
    ...PopupBase.properties,
    piece: { attribute: false },
    _nets: { state: true },
    _missing: { state: true },
    _pick: { state: true },
    _show: { state: true },
  };
  declare piece?: FurnitureConfig;
  declare _nets?: WifiNetwork[];
  /** the companion integration is not set up (or too old): only the router's own QR code */
  declare _missing: boolean;
  declare _pick: number;
  declare _show: boolean;

  constructor() {
    super();
    this._missing = false;
    this._pick = 0;
    this._show = false;
  }

  override connectedCallback() {
    super.connectedCallback();
    if (this._nets === undefined) void this.load();
  }

  private async load() {
    try {
      const r = await this.hass.callWS<{ networks: WifiNetwork[] }>({ type: 'floorplan_card/wifi/get' });
      this._nets = r?.networks ?? [];
    } catch {
      this._nets = [];
      this._missing = true;
    }
  }

  private get router(): RouterInfo {
    return detectRouter(this.hass, this.piece);
  }

  private sources(r: RouterInfo): Source[] {
    const out: Source[] = (this._nets ?? []).map((net) => ({ kind: 'net', net }));
    if (r.image) out.push({ kind: 'router', image: r.image });
    return out;
  }

  private label(s: Source): string {
    return s.kind === 'net' ? s.net.name || s.net.ssid : t('wifi.guest');
  }

  private qr(net: WifiNetwork) {
    let m: boolean[][];
    try {
      m = qrMatrix(wifiPayload(net));
    } catch {
      return html`<div class="qr-note">${t('wifi.too_long')}</div>`;
    }
    const n = m.length + 8;
    return html`<svg class="qr" viewBox="0 0 ${n} ${n}" role="img" aria-label=${t('wifi.qr_for', { ssid: net.ssid })} shape-rendering="crispEdges">
      ${svg`<rect width=${n} height=${n} fill="#fff"></rect><path d=${qrPath(m)} fill="#000"></path>`}
    </svg>`;
  }

  private security(net: WifiNetwork): string {
    return net.security === 'nopass' ? t('wifi.open') : net.security.toUpperCase();
  }

  private renderNet(net: WifiNetwork) {
    const open = net.security === 'nopass' || !net.password;
    return html`<div class="qr-card" data-net=${net.id}>
        ${this.qr(net)}
        <div class="ssid">${net.ssid}</div>
        <div class="meta">${net.hidden ? t('wifi.meta_hidden', { security: this.security(net) }) : this.security(net)}</div>
      </div>
      ${open
        ? nothing
        : html`<div class="group">
            <div class="row">
              <div class="grow">
                <div class="subtitle">${t('wifi.password')}</div>
                <div class="pw ${this._show ? 'shown' : ''}">${this._show ? net.password : '•'.repeat(Math.min(12, net.password.length))}</div>
              </div>
              <button class="btn plain pressable show" aria-pressed=${this._show ? 'true' : 'false'} @click=${() => (this._show = !this._show)}>
                ${t(this._show ? 'wifi.hide_password' : 'wifi.show_password')}
              </button>
            </div>
          </div>`}`;
  }

  private renderRouter(image: string, r: RouterInfo) {
    const img = this.ctx.getState(image);
    const sw = r.guestSwitch ? this.ctx.getState(r.guestSwitch) : undefined;
    const off = sw?.state === 'off';
    const pic = img?.attributes.entity_picture as string | undefined;
    return html`<div class="qr-card router ${off ? 'off' : ''}">
        ${pic && !isUnavailable(img) ? html`<img class="qr" src=${this.hass.hassUrl(pic)} alt=${t('wifi.qr_for', { ssid: String(img?.attributes.friendly_name ?? '') })} />` : html`<div class="qr-note">${t('card.unavailable')}</div>`}
        <div class="ssid">${entityName(this.hass, image, img)}</div>
        <div class="meta">${off ? t('wifi.guest_is_off') : t('wifi.from_router')}</div>
      </div>
      ${sw
        ? html`<div class="group">
            <div class="row">
              <ha-icon icon="mdi:wifi-star" style="color:var(--fp-label-2)"></ha-icon>
              <div class="grow"><div class="title">${t('wifi.guest_wifi')}</div></div>
              <button class="switch guest-switch" role="switch" aria-label=${t('wifi.guest_wifi')} aria-checked=${off ? 'false' : 'true'} ?disabled=${isUnavailable(sw)} @click=${() => this.toggleGuest(r.guestSwitch!, !off)}>
                <span class="track"><span class="knob"></span></span>
              </button>
            </div>
          </div>`
        : nothing}`;
  }

  /** On at once; off asks first (guests on it lose the connection) */
  private async toggleGuest(entity: string, isOn: boolean) {
    if (isOn && !(await this.ctx.host.confirm(t('wifi.guest_off_confirm')))) return;
    await this.safe(() => this.hass.callService('switch', isOn ? 'turn_off' : 'turn_on', { entity_id: entity }));
  }

  private status(r: RouterInfo): string {
    const c = r.connected ? this.ctx.getState(r.connected) : undefined;
    const parts: string[] = [];
    if (c && !isUnavailable(c)) parts.push(c.state === 'on' ? t('wifi.online') : t('wifi.offline'));
    if (r.devices != null) parts.push(t('wifi.devices', { n: r.devices }));
    return parts.join(' · ');
  }

  override render() {
    const title = this.piece?.name || t('wifi.title');
    const r = this.router;
    const list = this.sources(r);
    const pick = Math.min(this._pick, Math.max(0, list.length - 1));
    const cur = list[pick];
    const status = this.status(r);
    const c = r.connected ? this.ctx.getState(r.connected) : undefined;
    return html`
      ${this.renderHeader({
        icon: html`<ha-icon icon="mdi:wifi"></ha-icon>`,
        title,
        subtitle: status || (list.length ? t('wifi.scan_hint') : ' '),
      })}
      ${this._nets === undefined
        ? html`<div class="qr-note">${t('wifi.loading')}</div>`
        : !cur
          ? html`<div class="empty">
              <ha-icon icon="mdi:qrcode"></ha-icon>
              <div>${t(this._missing ? 'wifi.empty_companion' : this.hass.user?.is_admin ? 'wifi.empty_admin' : 'wifi.empty')}</div>
            </div>`
          : html`${list.length > 1
                ? html`<div class="chips pick" role="group" aria-label=${t('wifi.networks')}>
                    ${list.map((s, i) => html`<button class="chip pressable" aria-pressed=${i === pick ? 'true' : 'false'} @click=${() => ((this._pick = i), (this._show = false))}>${this.label(s)}</button>`)}
                  </div>`
                : nothing}
              <div class="stack">${cur.kind === 'net' ? this.renderNet(cur.net) : this.renderRouter(cur.image, r)}</div>`}
      ${c && !isUnavailable(c) && c.state !== 'on' ? html`<div class="note warn"><ha-icon icon="mdi:web-off"></ha-icon><span>${t('wifi.offline_note')}</span></div>` : nothing}
      ${this.piece?.entity
        ? html`<button class="btn plain pressable details" @click=${() => this.ctx.host.node.dispatchEvent(new CustomEvent('hass-more-info', { detail: { entityId: this.piece!.entity }, bubbles: true, composed: true }))}>
            ${t('common.details')}
          </button>`
        : nothing}
    `;
  }

  static override styles = [
    ...PopupBase.styles,
    css`
      .pick {
        justify-content: center;
        margin-bottom: var(--fp-space-4);
      }
      .qr-card {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--fp-space-2);
        text-align: center;
      }
      .qr {
        display: block;
        width: min(100%, 360px, 52vh);
        aspect-ratio: 1;
        height: auto;
        border-radius: var(--fp-radius-m);
        background: #fff;
        box-shadow: 0 0 0 1px var(--fp-separator);
        image-rendering: pixelated;
      }
      .router.off .qr {
        opacity: 0.25;
        filter: grayscale(1);
      }
      .ssid {
        margin-top: var(--fp-space-2);
        font-size: var(--fp-text-title3);
        font-weight: var(--fp-weight-semibold);
        overflow-wrap: anywhere;
      }
      .meta,
      .qr-note {
        font-size: var(--fp-text-subhead);
        color: var(--fp-label-2);
      }
      .qr-note {
        text-align: center;
        padding: var(--fp-space-6) 0;
      }
      .pw {
        font-size: var(--fp-text-body);
        font-variant-numeric: tabular-nums;
        letter-spacing: 0.08em;
        overflow-wrap: anywhere;
        user-select: all;
      }
      .pw.shown {
        letter-spacing: 0.02em;
        font-family: ui-monospace, 'SF Mono', Menlo, monospace;
      }
      .show {
        flex: none;
      }
      .empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--fp-space-3);
        text-align: center;
        color: var(--fp-label-2);
        padding: var(--fp-space-5) var(--fp-space-4);
      }
      .empty ha-icon {
        --mdc-icon-size: 44px;
        color: var(--fp-label-3);
      }
      .note {
        display: flex;
        gap: var(--fp-space-2);
        align-items: center;
        margin-top: var(--fp-space-4);
        font-size: var(--fp-text-footnote);
        color: var(--fp-label-2);
      }
      .note.warn ha-icon {
        color: var(--fp-orange);
      }
      .details {
        display: block;
        margin: var(--fp-space-3) auto 0;
      }
    `,
  ];
}

if (!customElements.get('fp-wifi-popup')) customElements.define('fp-wifi-popup', FpWifiPopup);
