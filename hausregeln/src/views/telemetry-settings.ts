/**
 * <hr-telemetry-settings>: anonymous diagnostics ("Diagnosedaten", opt-in, off by default; telemetry.py, PRIVACY.md).
 * The switch, what is collected, "Vorschau: genau das wird gesendet" (the exact JSON), "Meine Daten löschen" and a
 * link to the privacy notice. Without a deployed server the switch shows "noch nicht verfügbar". `compact`: only the
 * explanation and the preview (the setup wizard asks yes/no itself).
 */
import { css, html, nothing } from 'lit';
import { mdiChartBoxOutline, mdiChevronDown, mdiDeleteOutline, mdiEyeOutline, mdiShieldLockOutline } from '@mdi/js';
import { StoreElement } from '../base';
import { fire, icon, shared } from '../design/shared';
import '../components/sheet';
import { t } from '../i18n';

export interface TelemetryView {
  on: boolean;
  available: boolean;
  asked: boolean;
  last_report: string | null;
  next_report: string | null;
  errors_pending: number;
  privacy_url: string;
  install_id?: string | null;
}

export class HrTelemetrySettings extends StoreElement {
  static override properties = {
    ...StoreElement.properties,
    compact: { type: Boolean },
    _view: { state: true },
    _preview: { state: true },
    _busy: { state: true },
  };
  declare compact: boolean;
  declare _view: TelemetryView | null;
  declare _preview: string | null;
  declare _busy: boolean;

  constructor() {
    super();
    this.compact = false;
    this._view = null;
    this._preview = null;
    this._busy = false;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    void this._load();
  }

  private async _load() {
    this._view = (await this.store.callHA<TelemetryView>({ type: 'house_rules/telemetry/get' }).catch(() => null)) ?? null;
  }

  private async _toggle(on: boolean) {
    this._busy = true;
    try {
      this._view = await this.store.callHA<TelemetryView>({ type: 'house_rules/telemetry/set', on });
      fire(this, 'hr-toast', on ? 'Diagnosedaten eingeschaltet. Danke!' : 'Diagnosedaten ausgeschaltet, deine Daten auf dem Server werden gelöscht.');
    } catch (e) {
      fire(this, 'hr-toast', (e as Error).message || 'Das hat nicht geklappt.');
    }
    this._busy = false;
  }

  private async _showPreview() {
    const p = await this.store.callHA<Record<string, unknown>>({ type: 'house_rules/telemetry/preview' }).catch(() => null);
    this._preview = p ? JSON.stringify(p, null, 2) : 'In der Vorschau gibt es keine Daten.';
  }

  private async _delete() {
    this._busy = true;
    const r = await this.store.callHA<{ ok: boolean; retry?: boolean }>({ type: 'house_rules/telemetry/delete' }).catch(() => null);
    fire(this, 'hr-toast', r?.ok ? 'Deine Daten auf dem Server sind gelöscht. Ab jetzt gilt eine neue Kennung.' : 'Der Server war nicht erreichbar. Das Löschen wird automatisch wiederholt.');
    await this._load();
    this._busy = false;
  }

  static override styles = [
    shared,
    css`
      :host {
        display: block;
      }
      ul {
        margin: var(--hr-space-2) 0 0;
        padding-left: 1.2em;
        color: var(--hr-label-2);
        font-size: var(--hr-text-footnote);
      }
      li {
        margin: 2px 0;
      }
      .row > .ic {
        color: var(--hr-accent);
      }
      .sub.na {
        color: color-mix(in srgb, var(--hr-orange) 75%, var(--hr-label));
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--hr-space-2);
        margin-top: var(--hr-space-3);
      }
      .actions a,
      .actions button {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      pre {
        margin: 0;
        padding: var(--hr-space-4);
        font-size: 12px;
        line-height: 1.45;
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 70vh;
        overflow: auto;
      }
      .sheet-head {
        padding: var(--hr-space-4) var(--hr-space-4) 0;
      }
      .sheet-head p {
        color: var(--hr-label-2);
        font-size: var(--hr-text-footnote);
      }
    `,
  ];

  private _what() {
    return html`<ul>
      <li>Versionen (roomwise, Home Assistant, Python), Sprache und Einheiten</li>
      <li>Wie viele Geräte es je Art gibt und über welche Integration sie laufen (z. B. „Heizung über zha: 4“)</li>
      <li>Was die Geräte können (z. B. Heizmodi, Temperaturschritt, Ventilstellung vorhanden)</li>
      <li>Welche Funktionen von roomwise an sind und wie viele Regeln und Pläne es gibt (nur Anzahlen)</li>
      <li>Browser, Grafik und Leistungsstufe der Grundriss-Karte</li>
      <li>Fehler im Code von roomwise: Art des Fehlers und Zeilen im Code, ohne Meldungstext</li>
    </ul>
    <p class="sub">Nie: Namen, Entitäten, Räume, Zonen, Personen, Standort, IP-Adressen, Zugangsdaten oder eigene Texte. Einmal pro Woche, mit einer zufälligen Kennung.</p>`;
  }

  override render() {
    const v = this._view;
    const s = this.store;
    const on = !!v?.on;
    const avail = !!v?.available;
    const sheet = this._preview
      ? html`<hr-sheet width="720" label="Vorschau" @close=${() => (this._preview = null)}>
          <div class="sheet-head"><b>Vorschau: genau das wird gesendet</b><p>Der nächste Wochenbericht und wartende Fehlerberichte, so wie sie den Server erreichen würden.</p></div>
          <pre>${this._preview}</pre>
        </hr-sheet>`
      : nothing;
    const privacy = html`<a class="btn small plain" href=${v?.privacy_url ?? '#'} target="_blank" rel="noopener">${icon(mdiShieldLockOutline, 18)}Datenschutz</a>`;
    const preview = html`<button class="btn small tinted" @click=${() => this._showPreview()}>${icon(mdiEyeOutline, 18)}Vorschau: genau das wird gesendet</button>`;
    if (this.compact) return html`${this._what()}<div class="actions">${preview}${privacy}</div>${sheet}`;
    const sub = !avail ? html`<span class="sub na">Noch nicht verfügbar: Der Server für Diagnosedaten ist noch nicht eingerichtet. Es wird nichts gesendet.</span>` : on ? `An. ${v?.last_report ? `Zuletzt gesendet am ${new Date(v.last_report).toLocaleDateString('de-DE')}.` : 'Der erste Bericht geht in den nächsten Stunden raus.'}` : 'Aus. Es wird nichts gesendet.';
    return html`<div class="group">
        <div class="row">
          ${icon(mdiChartBoxOutline, 24)}
          <span class="grow"><div class="title">Anonyme Diagnosedaten senden</div><div class="sub">${sub}</div></span>
          <button class="switch" role="switch" aria-label="Anonyme Diagnosedaten senden" aria-checked=${on ? 'true' : 'false'} ?disabled=${!s.haAdmin || this._busy || (!avail && !on)} @click=${() => this._toggle(!on)}></button>
        </div>
      </div>
      <details class="more"><summary>${t('settings.telemetry_what')}${icon(mdiChevronDown, 18)}</summary>${this._what()}</details>
      <div class="actions">
        ${s.admin ? preview : nothing}
        ${s.haAdmin && on && avail ? html`<button class="btn small danger" ?disabled=${this._busy} @click=${() => this._delete()}>${icon(mdiDeleteOutline, 18)}Meine Daten löschen</button>` : nothing}
        ${privacy}
      </div>
      ${s.admin && !s.haAdmin ? html`<p class="sub">${t('rel.ha_admin_only')}</p>` : nothing}
      ${on && v?.install_id ? html`<p class="sub">Deine zufällige Kennung: <code>${v.install_id}</code></p>` : nothing}
      ${sheet}`;
  }
}
customElements.define('hr-telemetry-settings', HrTelemetrySettings);
