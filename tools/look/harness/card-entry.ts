// Standalone page for the card (no Home Assistant): small stand-ins for ha-card / ha-icon / ha-state-icon and a
// fake hass object built from a neutral demo plan. Bundled by tools/look/card.mjs; nothing reaches a real home.
import * as mdi from '@mdi/js';
import '../../../src/floorplan-card';

const w = window as unknown as Record<string, unknown>;
w.__fpNoCompanion = true;
w.__fpHrOff = true;

const path = (icon?: string) => {
  const n = 'mdi' + String(icon ?? '').replace(/^mdi:/, '').replace(/(^|-)([a-z0-9])/g, (_m, _d, c: string) => c.toUpperCase());
  return (mdi as Record<string, string>)[n] ?? mdi.mdiHelpCircleOutline;
};
class Icon extends HTMLElement {
  static observedAttributes = ['icon'];
  private _icon?: string;
  set icon(v: string | undefined) {
    this._icon = v;
    this.draw();
  }
  get icon() {
    return this._icon;
  }
  attributeChangedCallback() {
    this._icon = this.getAttribute('icon') ?? undefined;
    this.draw();
  }
  connectedCallback() {
    this.style.display ||= 'inline-flex';
    this.draw();
  }
  set stateObj(s: { entity_id: string } | undefined) {
    const d = s?.entity_id.split('.')[0];
    this.icon = { light: 'mdi:lightbulb', climate: 'mdi:thermostat', media_player: 'mdi:speaker', vacuum: 'mdi:robot-vacuum', binary_sensor: 'mdi:checkbox-blank-circle-outline', sensor: 'mdi:eye' }[d ?? ''] ?? 'mdi:circle-small';
  }
  set hass(_h: unknown) {}
  draw() {
    const size = 'var(--mdc-icon-size, 24px)';
    (this.shadowRoot ?? this.attachShadow({ mode: "open" })).innerHTML = `<svg viewBox="0 0 24 24" style="width:${size};height:${size};fill:currentColor;display:block"><path d="${path(this._icon)}"></path></svg>`;
  }
}
customElements.define('ha-icon', Icon);
customElements.define('ha-state-icon', class extends Icon {});
customElements.define(
  'ha-card',
  class extends HTMLElement {
    constructor() {
      super();
      // like Home Assistant's own card: a block with the card background (the card sets its own style attribute)
      this.attachShadow({ mode: 'open' }).innerHTML = '<style>:host{display:block;background:var(--ha-card-background,var(--card-background-color))}</style><slot></slot>';
    }
  },
);

/** Theme variables like Home Assistant's light / dark default and a theme with light text on a dark tint */
const THEMES: Record<string, Record<string, string>> = {
  light: { '--primary-background-color': '#fafafa', '--card-background-color': '#ffffff', '--primary-text-color': '#212121', '--secondary-text-color': '#727272', '--primary-color': '#03a9f4', '--divider-color': 'rgba(0,0,0,.12)', '--state-icon-color': '#44739e' },
  dark: { '--primary-background-color': '#111111', '--card-background-color': '#1c1c1c', '--primary-text-color': '#e1e1e1', '--secondary-text-color': '#9b9b9b', '--primary-color': '#03a9f4', '--divider-color': 'rgba(225,225,225,.12)', '--state-icon-color': '#44739e' },
  // a "light text" theme: light text on a mid-dark coloured background, but reported as not dark
  tinted: { '--primary-background-color': '#33415c', '--card-background-color': '#3d4b68', '--primary-text-color': '#f2f4f8', '--secondary-text-color': '#c4cad6', '--primary-color': '#ffb74d', '--divider-color': 'rgba(255,255,255,.15)', '--state-icon-color': '#ffd180' },
};

const st = (entity_id: string, state: string, attributes: Record<string, unknown> = {}) => ({ entity_id, state, attributes, last_changed: new Date().toISOString(), last_updated: new Date().toISOString(), context: { id: 'x' } });

/** Mount the card: config, theme, language, long names, many states */
w.mountCard = (o: { config: Record<string, unknown>; theme?: string; lang?: string; lightsOn?: boolean; night?: boolean; weather?: string }) => {
  const theme = THEMES[o.theme ?? 'light'];
  for (const [k, v] of Object.entries(theme)) document.documentElement.style.setProperty(k, v);
  document.body.style.background = theme['--primary-background-color'];
  document.body.style.color = theme['--primary-text-color'];
  const ids = new Set<string>();
  JSON.stringify(o.config).replace(/"([a-z_]+\.[a-z0-9_]+)"/g, (_m, id: string) => (ids.add(id), ''));
  const states: Record<string, unknown> = {};
  for (const id of ids) {
    const d = id.split('.')[0];
    const name = id.split('.')[1].replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
    if (d === 'light') states[id] = st(id, o.lightsOn ? 'on' : 'off', { friendly_name: name, brightness: 180, color_mode: 'color_temp', color_temp_kelvin: 2900, supported_color_modes: ['color_temp', 'hs'] });
    else if (d === 'sensor') states[id] = st(id, /humid/.test(id) ? '48' : '21.4', { friendly_name: name, unit_of_measurement: /humid/.test(id) ? '%' : '°C', device_class: /humid/.test(id) ? 'humidity' : 'temperature' });
    else if (d === 'climate') states[id] = st(id, 'heat', { friendly_name: name, current_temperature: 20.5, temperature: 21.5, hvac_action: 'heating', hvac_modes: ['off', 'heat'], min_temp: 7, max_temp: 30 });
    else if (d === 'binary_sensor') states[id] = st(id, /window/.test(id) ? 'on' : 'off', { friendly_name: name, device_class: /window/.test(id) ? 'window' : 'door' });
    else if (d === 'media_player') states[id] = st(id, 'playing', { friendly_name: name, media_title: 'A very long song title that should be cut off cleanly', media_artist: 'Artist', volume_level: 0.3 });
    else if (d === 'vacuum') states[id] = st(id, 'docked', { friendly_name: name, battery_level: 87 });
    else states[id] = st(id, 'on', { friendly_name: name });
  }
  states['sun.sun'] = st('sun.sun', o.night ? 'below_horizon' : 'above_horizon', { elevation: o.night ? -12 : 35, azimuth: o.night ? 290 : 160 });
  states['weather.home'] = st('weather.home', o.weather ?? 'partlycloudy', { temperature: 14, cloud_coverage: 40, wind_speed: 12, wind_bearing: 250, friendly_name: 'Home' });
  const reject = () => Promise.reject({ code: 'unknown_command', message: 'Unknown command.' });
  const hass = {
    states,
    entities: {},
    areas: {},
    devices: {},
    floors: {},
    services: {},
    user: { id: 'u', name: 'Demo', is_admin: true, is_owner: true },
    language: o.lang ?? 'de',
    locale: { language: o.lang ?? 'de', number_format: 'language', time_format: '24' },
    themes: { darkMode: o.theme === 'dark', theme: 'default', themes: {} },
    hassUrl: (p = '') => p,
    callService: async () => ({ context: { id: 'x' } }),
    callWS: reject,
    callApi: reject,
    formatEntityState: (s: { state: string; attributes: { unit_of_measurement?: string } }) => `${s.state}${s.attributes.unit_of_measurement ? ' ' + s.attributes.unit_of_measurement : ''}`,
    formatEntityAttributeValue: (_s: unknown, _a: string, v: unknown) => String(v ?? ''),
    connection: { subscribeMessage: async () => () => {}, subscribeEvents: async () => () => {}, sendMessagePromise: reject },
  };
  document.querySelector('floorplan-card')?.remove();
  const card = document.createElement('floorplan-card') as HTMLElement & { setConfig(c: unknown): void; hass: unknown };
  card.setConfig(o.config);
  card.hass = hass;
  document.querySelector('#host')!.append(card);
  return true;
};
