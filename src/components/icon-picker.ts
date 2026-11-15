import { LitElement, css, html, nothing } from 'lit';
import type { HomeAssistant } from '../types';
import { t } from '../i18n';

/**
 * Icon picker for the editor. Uses Home Assistant's own `ha-icon-picker` (all Material Design Icons, searchable)
 * when the frontend has it loaded; otherwise a searchable grid of common icons (English names plus German words)
 * and a field that takes any `mdi:` name. Emits `value-change` with `{ value }` (undefined = default icon).
 */
const GROUPS: [string, string[]][] = [
  ['licht lampe light leuchte', ['lightbulb', 'lightbulb-outline', 'ceiling-light', 'floor-lamp', 'lamp', 'desk-lamp', 'led-strip-variant', 'wall-sconce', 'string-lights', 'spotlight', 'track-light', 'chandelier', 'lightbulb-group', 'outdoor-lamp', 'coach-lamp']],
  ['schalter steckdose switch socket power strom', ['power-socket-eu', 'power-plug', 'power-plug-outline', 'toggle-switch-variant', 'light-switch', 'power', 'flash', 'lightning-bolt', 'battery', 'battery-charging', 'solar-power', 'solar-panel', 'transmission-tower', 'meter-electric', 'home-battery']],
  ['klima heizung temperatur climate heat thermostat', ['thermometer', 'thermostat', 'radiator', 'heat-pump', 'air-conditioner', 'fan', 'air-purifier', 'snowflake', 'fire', 'water-boiler', 'heat-wave', 'hvac', 'humidifier', 'dehumidifier', 'water-percent']],
  ['sensor fenster tuer kontakt window door contact', ['window-closed-variant', 'window-open-variant', 'door', 'door-open', 'door-closed', 'door-sliding', 'garage', 'garage-open', 'gate', 'gate-open', 'motion-sensor', 'smoke-detector', 'water-alert', 'leak', 'eye', 'eye-outline', 'shield-home', 'cctv', 'doorbell', 'doorbell-video', 'mailbox']],
  ['schloss lock sicherheit alarm security', ['lock', 'lock-open-variant', 'lock-smart', 'key', 'key-variant', 'shield-lock', 'shield-check', 'alarm-light', 'bell-ring', 'police-badge', 'fingerprint', 'safe']],
  ['auto car fahrzeug vehicle laden ev', ['car', 'car-side', 'car-electric', 'car-sports', 'car-estate', 'car-hatchback', 'car-convertible', 'car-door', 'car-door-lock', 'car-back', 'car-select', 'car-key', 'car-battery', 'car-seat-heater', 'car-seat', 'steering', 'car-defrost-front', 'car-defrost-rear', 'car-light-high', 'car-light-alert', 'car-tire-alert', 'car-brake-parking', 'car-cruise-control', 'car-info', 'car-wrench', 'ev-station', 'ev-plug-type2', 'ev-plug-ccs2', 'gas-station', 'speedometer', 'counter', 'map-marker', 'map-marker-distance', 'bullhorn', 'motorbike', 'bike', 'scooter', 'truck', 'van-utility', 'rv-truck', 'tractor']],
  ['medien musik tv media music speaker', ['television', 'speaker', 'speaker-wireless', 'cast', 'music', 'radio', 'gamepad-variant', 'projector', 'soundbar', 'headphones', 'microphone', 'video']],
  ['kueche haushalt kitchen appliance', ['fridge-outline', 'stove', 'microwave', 'dishwasher', 'washing-machine', 'tumble-dryer', 'coffee-maker-outline', 'kettle-outline', 'toaster', 'blender', 'robot-vacuum', 'robot-mower', 'iron', 'trash-can', 'water-pump', 'faucet', 'shower', 'bathtub', 'toilet']],
  ['rollo jalousie cover blind', ['window-shutter', 'window-shutter-open', 'blinds', 'blinds-open', 'roller-shade', 'curtains', 'curtains-closed', 'awning']],
  ['garten draussen garden outdoor wetter weather', ['flower', 'tree', 'grass', 'sprinkler', 'sprinkler-variant', 'watering-can', 'pool', 'weather-sunny', 'weather-rainy', 'weather-windy', 'umbrella', 'barbecue', 'fence', 'home-outline']],
  ['raum haus zimmer room house', ['home', 'home-variant', 'sofa', 'bed', 'desk', 'chair-rolling', 'table-furniture', 'stairs', 'office-building', 'warehouse', 'baby-carriage', 'teddy-bear', 'dog', 'cat', 'paw']],
  ['netzwerk computer network', ['router-wireless', 'wifi', 'server', 'laptop', 'monitor', 'printer', 'cellphone', 'tablet', 'nas', 'access-point']],
  ['allgemein general', ['information-outline', 'alert-circle-outline', 'check-circle-outline', 'star', 'heart', 'clock-outline', 'clock-start', 'calendar', 'timer-outline', 'gauge', 'chart-line', 'cog', 'tools', 'script-text', 'palette', 'circle', 'square-rounded', 'gesture-tap', 'account', 'account-group']],
];
const ALL = GROUPS.flatMap(([words, icons]) => icons.map((i) => ({ icon: `mdi:${i}`, key: `${i.replace(/-/g, ' ')} ${words}` })));

export class FpIconPicker extends LitElement {
  static override properties = { hass: { attribute: false }, value: { type: String }, placeholder: { type: String }, _q: { state: true }, _open: { state: true } };
  declare hass?: HomeAssistant;
  declare value?: string;
  /** shown when no icon is chosen (the entity's own icon) */
  declare placeholder?: string;
  declare _q: string;
  declare _open: boolean;

  constructor() {
    super();
    this._q = '';
    this._open = false;
  }

  private set(v: string | undefined) {
    const value = v?.trim() ? (v.includes(':') ? v.trim() : `mdi:${v.trim()}`) : undefined;
    this.value = value;
    this.dispatchEvent(new CustomEvent('value-change', { detail: { value }, bubbles: true, composed: true }));
  }

  override render() {
    // Home Assistant's own picker: every icon, its search
    if (customElements.get('ha-icon-picker') && this.hass)
      return html`<ha-icon-picker
        .hass=${this.hass}
        .value=${this.value ?? ''}
        .placeholder=${this.placeholder ?? ''}
        .label=${t('editor.icon')}
        @value-changed=${(e: CustomEvent) => {
          e.stopPropagation();
          this.set(e.detail.value);
        }}
      ></ha-icon-picker>`;
    const q = this._q.trim().toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
    const list = q ? ALL.filter((x) => x.key.includes(q) || x.icon.includes(q)) : ALL;
    return html`<div class="row">
        <span class="cur"><ha-icon .icon=${this.value || this.placeholder || 'mdi:shape-outline'}></ha-icon></span>
        <input
          class="field"
          data-icon-input
          .value=${this._open ? this._q : (this.value ?? '')}
          placeholder=${this.placeholder ?? t('editor.icon_search')}
          aria-label=${t('editor.icon')}
          @focus=${() => {
            this._open = true;
            this._q = '';
          }}
          @input=${(e: Event) => (this._q = (e.target as HTMLInputElement).value)}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key !== 'Enter') return;
            this.set(this._q.startsWith('mdi:') ? this._q : list[0]?.icon ?? this._q);
            this._open = false;
          }}
        />
        ${this.value
          ? html`<button class="clear" aria-label=${t('editor.icon_default')} title=${t('editor.icon_default')} @click=${() => this.set(undefined)}><ha-icon icon="mdi:close-circle"></ha-icon></button>`
          : nothing}
      </div>
      ${this._open
        ? html`<div class="grid" role="listbox">
              ${q.startsWith('mdi:') && !list.some((x) => x.icon === q)
                ? html`<button class="ic" role="option" title=${q} data-icon=${q} @click=${() => ((this._open = false), this.set(q))}><ha-icon .icon=${q}></ha-icon></button>`
                : nothing}
              ${list.slice(0, 120).map(
                (x) => html`<button class="ic ${x.icon === this.value ? 'sel' : ''}" role="option" aria-selected=${x.icon === this.value ? 'true' : 'false'} title=${x.icon} data-icon=${x.icon} @click=${() => ((this._open = false), this.set(x.icon))}>
                  <ha-icon .icon=${x.icon}></ha-icon>
                </button>`,
              )}
            </div>
            <div class="hint">${t('editor.icon_hint')}</div>`
        : nothing}`;
  }

  static override styles = css`
    :host {
      display: block;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .cur {
      width: 36px;
      height: 36px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--fp-fill, rgba(120, 120, 128, 0.12));
      color: var(--fp-label, #000);
      flex: none;
    }
    .field {
      flex: 1;
      min-width: 0;
      font: inherit;
      font-size: var(--fp-text-subhead, 15px);
      padding: 8px 10px;
      border-radius: 10px;
      border: 1px solid var(--fp-separator, rgba(0, 0, 0, 0.12));
      background: var(--fp-surface, #fff);
      color: var(--fp-label, #000);
    }
    .clear {
      border: 0;
      background: none;
      padding: 4px;
      color: var(--fp-label-3, #999);
      cursor: pointer;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(40px, 1fr));
      gap: 4px;
      margin-top: 8px;
      max-height: 220px;
      overflow: auto;
    }
    .ic {
      height: 40px;
      border: 0;
      border-radius: 10px;
      background: var(--fp-fill, rgba(120, 120, 128, 0.1));
      color: var(--fp-label, #000);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .ic.sel {
      background: var(--fp-accent, #007aff);
      color: #fff;
    }
    .hint {
      margin-top: 6px;
      font-size: var(--fp-text-caption, 12px);
      color: var(--fp-label-3, #999);
    }
  `;
}

if (!customElements.get('fp-icon-picker')) customElements.define('fp-icon-picker', FpIconPicker);
