/**
 * <hr-backup>: Einstellungen → Sichern und wiederherstellen. Download of everything set up as a JSON file
 * (house_rules/backup/export), and restoring one: read the file, preview what changes (house_rules/backup/preview),
 * choose a stand-in for every device that does not exist here, merge or replace, then restore. Admins only.
 */
import { css, html, nothing } from 'lit';
import { mdiAlertOutline, mdiTrayArrowDown, mdiTrayArrowUp } from '@mdi/js';
import { StoreElement } from '../base';
import { fire, icon, shared } from '../design/shared';
import '../components/sheet';
import { t } from '../i18n';

const MAX_BYTES = 2_000_000;

interface Section {
  key: string;
  label: string;
  incoming?: number;
  current?: number;
  new?: number;
  same?: number;
  only_here?: number;
  unknown_rooms?: string[];
  changed?: boolean;
}
interface Missing {
  entity_id: string;
  used_in: string[];
  candidates: { entity_id: string; name: string }[];
}
interface Preview {
  sections: Section[];
  missing: Missing[];
  alarm_armed: boolean;
  notes: string[];
  created?: string;
  app_version?: string;
}
interface Result {
  ok: boolean;
  sections: string[];
  skipped: string[];
  notes: string[];
}

export class HrBackup extends StoreElement {
  static override properties = {
    ...StoreElement.properties,
    _file: { state: true },
    _preview: { state: true },
    _error: { state: true },
    _mode: { state: true },
    _off: { state: true },
    _remap: { state: true },
    _busy: { state: true },
    _result: { state: true },
  };
  declare _file: { name: string; backup: Record<string, unknown> } | null;
  declare _preview: Preview | null;
  declare _error: string;
  declare _mode: 'merge' | 'replace';
  declare _off: Set<string>;
  declare _remap: Record<string, string>;
  declare _busy: boolean;
  declare _result: Result | null;

  constructor() {
    super();
    this._file = null;
    this._preview = null;
    this._error = '';
    this._mode = 'merge';
    this._off = new Set();
    this._remap = {};
    this._busy = false;
    this._result = null;
  }

  static override styles = [
    shared,
    css`
      .acts {
        display: flex;
        flex-wrap: wrap;
        gap: var(--hr-space-2);
        padding: var(--hr-space-4);
      }
      .lead {
        color: var(--hr-label-2);
        font-size: var(--hr-text-footnote);
        line-height: 1.45;
        padding: 0 var(--hr-space-4) var(--hr-space-4);
      }
      .sheet {
        display: flex;
        flex-direction: column;
        gap: var(--hr-space-4);
        padding: var(--hr-space-5);
      }
      h3 {
        font-size: var(--hr-text-title3);
        font-weight: 700;
      }
      h4 {
        font-size: var(--hr-text-subhead);
        font-weight: 700;
        margin-top: var(--hr-space-2);
      }
      .meta,
      .note {
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
        line-height: 1.45;
      }
      .warn {
        display: flex;
        gap: var(--hr-space-2);
        align-items: flex-start;
        color: color-mix(in srgb, var(--hr-orange) 75%, var(--hr-label));
        font-size: var(--hr-text-footnote);
        line-height: 1.45;
      }
      .err {
        color: var(--hr-red);
        font-size: var(--hr-text-footnote);
      }
      .group {
        background: var(--hr-fill);
      }
      .row input[type='checkbox'] {
        width: 20px;
        height: 20px;
        accent-color: var(--hr-accent);
      }
      .miss {
        flex-wrap: wrap;
      }
      .miss code {
        font-size: var(--hr-text-footnote);
      }
      select {
        border: 0;
        border-radius: var(--hr-radius-s);
        background: var(--hr-surface);
        padding: 0 12px;
        min-height: var(--hr-hit);
        font-size: var(--hr-text-subhead);
        color: var(--hr-label);
        max-width: 100%;
        flex: 1 1 220px;
      }
      .foot {
        display: flex;
        justify-content: flex-end;
        flex-wrap: wrap;
        gap: var(--hr-space-2);
      }
      ul {
        margin: 0;
        padding-left: 1.2em;
        font-size: var(--hr-text-footnote);
        color: var(--hr-label-2);
        line-height: 1.5;
      }
    `,
  ];

  // ------------------------------------------------------------------ export
  private async _export() {
    try {
      const backup = await this.store.callHA<Record<string, unknown>>({ type: 'house_rules/backup/export' });
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `hausregeln-sicherung-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      fire(this, 'hr-toast', 'Sicherung heruntergeladen');
    } catch (err) {
      fire(this, 'hr-toast', `Sichern ging nicht: ${(err as Error).message}`);
    }
  }

  // ------------------------------------------------------------------ import
  private _pick() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (f) void this._read(f);
    });
    input.click();
  }

  /** also called by tests with a File */
  async _read(f: File) {
    this._reset();
    if (f.size > MAX_BYTES) {
      this._file = { name: f.name, backup: {} };
      this._error = 'Die Datei ist zu groß für eine Sicherung von Hausregeln (höchstens 2 MB).';
      return;
    }
    let backup: Record<string, unknown>;
    try {
      backup = JSON.parse(await f.text());
    } catch {
      this._file = { name: f.name, backup: {} };
      this._error = 'Die Datei lässt sich nicht lesen. Ist es wirklich eine Sicherung (JSON)?';
      return;
    }
    this._file = { name: f.name, backup };
    await this._load();
  }

  private async _load() {
    if (!this._file) return;
    this._busy = true;
    try {
      this._preview = await this.store.callHA<Preview>({ type: 'house_rules/backup/preview', backup: this._file.backup, remap: this._remap });
      this._error = '';
    } catch (err) {
      this._preview = null;
      this._error = (err as Error).message.replace(/^invalid: /, '');
    } finally {
      this._busy = false;
    }
  }

  private _reset() {
    this._file = null;
    this._preview = null;
    this._error = '';
    this._mode = 'merge';
    this._off = new Set();
    this._remap = {};
    this._result = null;
  }

  private async _restore() {
    if (!this._file || !this._preview) return;
    this._busy = true;
    try {
      const sections = this._preview.sections.map((s) => s.key).filter((k) => !this._off.has(k));
      this._result = await this.store.callHA<Result>({ type: 'house_rules/backup/restore', backup: this._file.backup, mode: this._mode, sections, remap: this._remap });
      fire(this, 'hr-toast', 'Sicherung wiederhergestellt');
    } catch (err) {
      this._error = (err as Error).message.replace(/^invalid: /, '');
    } finally {
      this._busy = false;
    }
  }

  private _toggle(key: string) {
    const off = new Set(this._off);
    if (off.has(key)) off.delete(key);
    else off.add(key);
    this._off = off;
  }

  private _summary(s: Section): string {
    const n = (x?: number) => x ?? 0;
    if (s.key === 'rules' || s.key === 'groups') {
      const what = s.key === 'rules' ? 'Regeln' : 'Gruppen';
      if (this._mode === 'replace') return `${n(s.incoming)} ${what} aus der Sicherung ersetzen die ${n(s.current)} von hier.`;
      return `${n(s.new)} neu, ${n(s.same)} werden überschrieben, ${n(s.only_here)} von hier bleiben.`;
    }
    if (s.incoming !== undefined) {
      const rooms = s.unknown_rooms?.length ? ` Hier unbekannt: ${s.unknown_rooms.join(', ')}.` : '';
      return `${n(s.incoming)} in der Sicherung, ${n(s.current)} hier.${rooms}`;
    }
    return s.changed ? 'Wird übernommen.' : 'Schon genauso eingestellt.';
  }

  private _sheet() {
    const p = this._preview;
    const r = this._result;
    if (r)
      return html`<div class="sheet">
        <h3>Wiederhergestellt</h3>
        <p class="note">${r.sections.length} Teile aus der Sicherung sind übernommen.</p>
        ${r.notes.map((n) => html`<div class="warn">${icon(mdiAlertOutline, 18)}<span>${n}</span></div>`)}
        ${r.skipped.length ? html`<h4>Nicht übernommen</h4><ul>${r.skipped.map((x) => html`<li>${x}</li>`)}</ul>` : nothing}
        <div class="foot"><button class="btn primary" @click=${this._reset}>Fertig</button></div>
      </div>`;
    const created = p?.created ? new Date(p.created).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '';
    const armed = !!p?.alarm_armed && !this._off.has('alarm') && p.sections.some((s) => s.key === 'alarm');
    return html`<div class="sheet">
      <h3>Sicherung wiederherstellen</h3>
      <p class="meta">${this._file?.name}${created ? html` · vom ${created}` : nothing}${p?.app_version ? html` · Hausregeln ${p.app_version}` : nothing}</p>
      ${this._error ? html`<p class="err" role="alert">${this._error}</p>` : nothing}
      ${p
        ? html`
            <div class="seg" role="group" aria-label="Art">
              <button aria-pressed=${this._mode === 'merge' ? 'true' : 'false'} @click=${() => (this._mode = 'merge')}>Zusammenführen</button>
              <button aria-pressed=${this._mode === 'replace' ? 'true' : 'false'} @click=${() => (this._mode = 'replace')}>Ersetzen</button>
            </div>
            <p class="note">
              ${this._mode === 'merge'
                ? 'Zusammenführen: Regeln, Gruppen und Pläne aus der Sicherung kommen dazu oder überschreiben gleiche; was es nur hier gibt, bleibt.'
                : 'Ersetzen: Danach ist alles genau wie in der Sicherung. Regeln, die es nur hier gibt, landen im Papierkorb.'}
            </p>
            <h4>Was sich ändert</h4>
            <div class="group">
              ${p.sections.map(
                (s) => html`<label class="row">
                  <input type="checkbox" .checked=${!this._off.has(s.key)} @change=${() => this._toggle(s.key)} />
                  <span class="grow"><div class="title">${s.label}</div><div class="sub">${this._summary(s)}</div></span>
                </label>`,
              )}
            </div>
            ${p.missing.length
              ? html`<h4>Geräte, die es hier nicht gibt</h4>
                  <p class="note">Wähle für jedes ein Gerät aus diesem Zuhause. Ohne Auswahl bleibt es stehen und Home Assistant meldet es unter „Reparaturen“.</p>
                  <div class="group">
                    ${p.missing.map(
                      (m) => html`<div class="row miss">
                        <span class="grow"><code>${m.entity_id}</code><div class="sub">${m.used_in.join(', ')}</div></span>
                        <select
                          aria-label=${`Ersatz für ${m.entity_id}`}
                          data-entity=${m.entity_id}
                          @change=${(e: Event) => {
                            const v = (e.target as HTMLSelectElement).value;
                            const next = { ...this._remap };
                            if (v) next[m.entity_id] = v;
                            else delete next[m.entity_id];
                            this._remap = next;
                          }}
                        >
                          <option value="">Nicht ersetzen</option>
                          ${m.candidates.map((c) => html`<option value=${c.entity_id} ?selected=${this._remap[m.entity_id] === c.entity_id}>${c.name} (${c.entity_id})</option>`)}
                        </select>
                      </div>`,
                    )}
                  </div>`
              : nothing}
            ${p.notes.map((n) => html`<div class="warn">${icon(mdiAlertOutline, 18)}<span>${n}</span></div>`)}
            ${armed ? html`<div class="warn">${icon(mdiAlertOutline, 18)}<span>Die Alarmanlage ist scharf. Schalte sie erst aus oder nimm die Alarmanlage aus der Auswahl.</span></div>` : nothing}
          `
        : this._busy
          ? html`<p class="note">Lese die Sicherung …</p>`
          : nothing}
      <div class="foot">
        <button class="btn" @click=${this._reset}>Abbrechen</button>
        ${p
          ? html`<button class="btn ${this._mode === 'replace' ? 'danger' : 'primary'}" data-restore ?disabled=${this._busy || armed || p.sections.every((s) => this._off.has(s.key))} @click=${this._restore}>
              ${this._mode === 'replace' ? 'Ersetzen' : 'Zusammenführen'}
            </button>`
          : nothing}
      </div>
    </div>`;
  }

  override render() {
    if (!this.store.admin) return html`<p class="lead">Nur Admins können sichern und wiederherstellen.</p>`;
    return html`<div class="group">
        <div class="acts">
          <button class="btn tinted" data-export @click=${this._export}>${icon(mdiTrayArrowDown, 18)}Sicherung herunterladen</button>
          ${this.store.haAdmin ? html`<button class="btn" data-import @click=${this._pick}>${icon(mdiTrayArrowUp, 18)}Sicherung einspielen …</button>` : nothing}
        </div>
        ${this.store.haAdmin ? nothing : html`<p class="lead">${t('rel.ha_admin_only')}</p>`}
        <p class="lead">Eine Datei mit allem, was du eingerichtet hast, ohne PIN, Passkeys, Passwörter und KI-Schlüssel. Vor dem Einspielen siehst du, was sich ändert.</p>
      </div>
      ${this._file ? html`<hr-sheet width="640" label="Sicherung wiederherstellen" @close=${this._reset}>${this._sheet()}</hr-sheet>` : nothing}`;
  }
}
customElements.define('hr-backup', HrBackup);
