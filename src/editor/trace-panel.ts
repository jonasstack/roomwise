import { html, nothing, svg, type TemplateResult } from 'lit';
import type { FloorplanCardConfig, HomeAssistant, Point, TraceImage } from '../types';
import type { FloorplanEditorUI } from './editor-ui';
import { t } from '../i18n';
import { round } from '../geometry';
import { deleteImage, imageIds, keepsImages, uploadImage } from '../shared-plans';
import { TRACE_LIMITS, TRACE_TYPES, calibrate, processImage, rememberImage, traceCorners, type ProcessedImage } from '../trace';
import { uid } from '../config';

/** What a tap / drag on the plan does while the trace panel is open */
export interface TraceMode {
  mode: 'calibrate' | 'move' | null;
  /** calibration: the marked points (plan units) */
  pts: Point[];
}

/** Picture ids of the editor that are not stored yet (uploaded on "Save") */
export const PENDING = 'new_';

/** Open a file picker for a picture of the floor plan */
export function pickTraceImage(ed: FloorplanEditorUI) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = [...TRACE_TYPES, 'application/pdf', '.pdf'].join(',');
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    if (f) void loadTraceImage(ed, f);
  });
  input.click();
}

/** Read a picture into the current floor (resized; kept in the editor until "Save") */
export async function loadTraceImage(ed: FloorplanEditorUI, file: File): Promise<boolean> {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    ed.layer.toast(t('trace.pdf'));
    return false;
  }
  if (file.type && !file.type.startsWith('image/')) {
    ed.layer.toast(t('trace.not_image'));
    return false;
  }
  const img = await processImage(file, keepsImages() ? TRACE_LIMITS.companion : TRACE_LIMITS.inline);
  if (!img) {
    ed.layer.toast(t('trace.unreadable'));
    return false;
  }
  const id = uid(PENDING.slice(0, -1));
  ed.pendingImages.set(id, img);
  const ratio = img.height / img.width;
  // as wide as what is drawn so far (at least 10 m), in the middle of the view
  const fb = ed.floor.rooms.flatMap((r) => r.points);
  const w = fb.length ? Math.max(1000, Math.max(...fb.map((p) => p[0])) - Math.min(...fb.map((p) => p[0]))) : 1200;
  const c = ed.viewCenterPoint();
  const prev = ed.floor.trace;
  ed.mutate((_d, f) => {
    f.trace = { image: id, x: round(c[0] - w / 2), y: round(c[1] - (w * ratio) / 2), w: round(w), ratio, opacity: prev?.opacity ?? 0.5, show: prev?.show };
  });
  ed.setTraceMode({ mode: 'calibrate', pts: [] });
  ed.layer.toast(t('trace.loaded'));
  return true;
}

/** The trace image's picture for the editor's plan */
export function patchTrace(ed: FloorplanEditorUI, fn: (tr: TraceImage) => TraceImage | undefined, record = true) {
  ed.mutate((_d, f) => {
    if (!f.trace) return;
    const next = fn(f.trace);
    if (next) f.trace = next;
    else delete f.trace;
  }, record);
}

/** A tap on the plan while calibrating: up to two points */
export function traceTap(ed: FloorplanEditorUI, w: Point) {
  const m = ed._traceMode;
  if (m?.mode !== 'calibrate') return;
  const pts = m.pts.length >= 2 ? [w] : [...m.pts, w];
  ed.setTraceMode({ ...m, pts });
}

/** Scale by the two marked points and the distance typed in (cm) */
export function applyCalibration(ed: FloorplanEditorUI, cm: number) {
  const m = ed._traceMode;
  if (!m || m.pts.length < 2 || !(cm > 0)) return;
  patchTrace(ed, (tr) => calibrate(tr, m.pts[0], m.pts[1], cm));
  ed.setTraceMode({ mode: null, pts: [] });
  ed.layer.toast(t('trace.calibrated'));
}

/** Markers of the calibration and the picture's outline (overlay of the editor's plan) */
export function traceOverlay(ed: FloorplanEditorUI): unknown[] {
  const tr = ed.floor.trace;
  const m = ed._traceMode;
  if (ed._panel !== 'trace' || !tr) return [];
  const out: unknown[] = [];
  const k = 1 / (ed.plan?.panZoom?.scale ?? 1);
  const c = traceCorners(tr);
  out.push(svg`<polygon class="ed-trace-box ${m?.mode === 'move' ? 'on' : ''}" points=${c.map((p) => p.join(',')).join(' ')}></polygon>`);
  if (m?.mode === 'calibrate' && m.pts.length) {
    const [a, b] = m.pts;
    if (b) out.push(svg`<line class="ed-trace-line" x1=${a[0]} y1=${a[1]} x2=${b[0]} y2=${b[1]}></line>`);
    for (const p of m.pts) out.push(svg`<circle class="ed-trace-pt" cx=${p[0]} cy=${p[1]} r=${7 * k}></circle>`);
  }
  return out;
}

/** The trace panel: load, calibrate, place, fade, turn, show on the card, remove */
export function renderTracePanel(ed: FloorplanEditorUI): TemplateResult {
  const tr = ed.floor.trace;
  const m = ed._traceMode ?? { mode: null, pts: [] };
  if (!tr)
    return html`<p class="panel-hint">${t('trace.intro')}</p>
      <div class="group">
        <button class="row pressable" data-trace-load @click=${() => pickTraceImage(ed)}>
          <ha-icon icon="mdi:image-plus-outline" style="color:var(--fp-accent)"></ha-icon>
          <div class="grow"><div class="title accent">${t('trace.load')}</div><div class="subtitle wrap">${t('trace.load_sub')}</div></div>
        </button>
      </div>
      <div class="hint-s">${t(keepsImages() ? 'trace.where_companion' : 'trace.where_inline')}</div>`;
  const opacity = Math.round((tr.opacity ?? 0.5) * 100);
  const rot = tr.rotation ?? 0;
  const dist = (m.pts.length === 2 ? Math.hypot(m.pts[1][0] - m.pts[0][0], m.pts[1][1] - m.pts[0][1]) : 0);
  return html`
    <div class="section-title">${t('trace.scale')}</div>
    <div class="group">
      <button
        class="row pressable"
        data-trace-calibrate
        aria-pressed=${m.mode === 'calibrate' ? 'true' : 'false'}
        @click=${() => ed.setTraceMode(m.mode === 'calibrate' ? { mode: null, pts: [] } : { mode: 'calibrate', pts: [] })}
      >
        <ha-icon icon="mdi:ruler" style="color:var(--fp-accent)"></ha-icon>
        <div class="grow">
          <div class="title accent">${m.mode === 'calibrate' ? t('trace.calibrate_stop') : t('trace.calibrate')}</div>
          <div class="subtitle wrap">${t(m.mode === 'calibrate' ? (m.pts.length < 2 ? 'trace.calibrate_pts' : 'trace.calibrate_len') : 'trace.calibrate_sub', { n: 2 - m.pts.length })}</div>
        </div>
      </button>
      ${m.mode === 'calibrate' && m.pts.length === 2
        ? html`<form
            class="row field-row"
            @submit=${(e: Event) => {
              e.preventDefault();
              const v = Number(((e.currentTarget as HTMLFormElement).elements.namedItem('cm') as HTMLInputElement).value.replace(',', '.'));
              applyCalibration(ed, v);
            }}
          >
            <label class="subtitle" for="trace-cm">${t('trace.distance')}</label>
            <input id="trace-cm" name="cm" class="field inline num" data-trace-cm type="text" inputmode="decimal" placeholder=${String(Math.round(dist))} autofocus />
            <button class="btn accent pressable" type="submit">${t('trace.apply')}</button>
          </form>`
        : nothing}
    </div>

    <div class="section-title">${t('trace.place')}</div>
    <div class="group">
      <button
        class="row pressable"
        data-trace-move
        aria-pressed=${m.mode === 'move' ? 'true' : 'false'}
        @click=${() => ed.setTraceMode(m.mode === 'move' ? { mode: null, pts: [] } : { mode: 'move', pts: [] })}
      >
        <ha-icon icon="mdi:cursor-move" style="color:var(--fp-accent)"></ha-icon>
        <div class="grow">
          <div class="title accent">${m.mode === 'move' ? t('trace.move_stop') : t('trace.move')}</div>
          <div class="subtitle wrap">${t('trace.move_sub')}</div>
        </div>
      </button>
      ${numRow(t('trace.width'), tr.w, 'cm', (v) => v > 10 && patchTrace(ed, (x) => ({ ...x, w: v })), 'w')}
      ${numRow(t('trace.rotation'), rot, '°', (v) => patchTrace(ed, (x) => ({ ...x, rotation: ((((v + 180) % 360) + 360) % 360) - 180 || undefined })), 'rotation')}
      <label class="row field-row">
        <span class="subtitle">${t('trace.opacity')}</span>
        <input
          type="range"
          class="grow"
          data-trace-opacity
          min="5"
          max="100"
          step="5"
          .value=${String(opacity)}
          aria-valuetext=${`${opacity} %`}
          @input=${(e: Event) => patchTrace(ed, (x) => ({ ...x, opacity: Number((e.target as HTMLInputElement).value) / 100 }), false)}
          @change=${(e: Event) => patchTrace(ed, (x) => ({ ...x, opacity: Number((e.target as HTMLInputElement).value) / 100 }))}
        />
        <span class="num step-val">${opacity} %</span>
      </label>
    </div>
    <div class="hint-s">${t('trace.keys')}</div>

    <div class="section-title">${t('trace.visibility')}</div>
    <div class="group">
      ${switchRow(t('trace.hide_editor'), ed._traceHidden, () => (ed._traceHidden = !ed._traceHidden), 'hide')}
      ${switchRow(t('trace.show_card'), !!tr.show, () => patchTrace(ed, (x) => ({ ...x, show: x.show ? undefined : true })), 'show', t('trace.show_card_sub'))}
    </div>
    <div class="group" style="margin-top:var(--fp-space-3)">
      <button class="row pressable" data-trace-replace @click=${() => pickTraceImage(ed)}>
        <ha-icon icon="mdi:image-edit-outline" style="color:var(--fp-accent)"></ha-icon>
        <div class="grow"><div class="title accent">${t('trace.replace')}</div></div>
      </button>
      <button
        class="row pressable"
        data-trace-remove
        @click=${() => {
          patchTrace(ed, () => undefined);
          ed.setTraceMode({ mode: null, pts: [] });
        }}
      >
        <ha-icon icon="mdi:image-remove-outline" style="color:var(--fp-red)"></ha-icon>
        <div class="grow"><div class="title" style="color:var(--fp-red)">${t('trace.remove')}</div></div>
      </button>
    </div>
  `;
}

function numRow(label: string, value: number, unit: string, set: (v: number) => void, key: string) {
  return html`<label class="row field-row">
    <span class="subtitle">${label}</span>
    <input
      class="field inline num"
      data-trace=${key}
      aria-label=${label}
      type="text"
      inputmode="decimal"
      .value=${String(round(value, 1))}
      @change=${(e: Event) => {
        const v = Number((e.target as HTMLInputElement).value.replace(',', '.'));
        if (Number.isFinite(v)) set(v);
      }}
    />
    <span class="subtitle">${unit}</span>
  </label>`;
}

function switchRow(label: string, on: boolean, toggle: () => void, key: string, sub?: string) {
  return html`<div class="row">
    <div class="grow"><div class="title">${label}</div>${sub ? html`<div class="subtitle">${sub}</div>` : nothing}</div>
    <button class="switch" role="switch" data-trace=${key} aria-label=${label} aria-checked=${on ? 'true' : 'false'} @click=${toggle}>
      <span class="track"><span class="knob"></span></span>
    </button>
  </div>`;
}

/**
 * Before saving: pictures loaded in this editor go to the companion (their id replaces the temporary one) or,
 * without it, into the config itself. Returns the config to save.
 */
export async function storeTraceImages(hass: HomeAssistant, cfg: FloorplanCardConfig, pending: Map<string, ProcessedImage>): Promise<FloorplanCardConfig> {
  const out = structuredClone(cfg);
  for (const f of out.floors) {
    const id = f.trace?.image;
    if (!f.trace || !id?.startsWith(PENDING)) continue;
    const img = pending.get(id);
    if (!img) {
      delete f.trace;
      continue;
    }
    if (keepsImages()) {
      const stored = await uploadImage(hass, img.data, img.width, img.height);
      rememberImage(stored, img.data);
      f.trace = { ...f.trace, image: stored };
    } else {
      const { image: _drop, ...rest } = f.trace;
      f.trace = { ...rest, src: img.data };
    }
  }
  return out;
}

/** After saving: pictures this card no longer uses are removed from the companion */
export async function dropUnusedImages(hass: HomeAssistant, before: FloorplanCardConfig, after: FloorplanCardConfig) {
  const keep = imageIds(after);
  for (const id of imageIds(before)) if (!keep.has(id) && !id.startsWith(PENDING)) await deleteImage(hass, id);
}
