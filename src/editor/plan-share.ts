import { html, nothing, type TemplateResult } from 'lit';
import type { FloorplanCardConfig, HomeAssistant } from '../types';
import type { FloorplanEditorUI } from './editor-ui';
import type { FloorplanLayer } from '../layer/floorplan-layer';
import { t } from '../i18n';
import { cleanConfig, normalizeConfig } from '../config';
import { cardPart, getPlan, listPlans, mergePlan, planPart, savePlan, sharesPlans, type PlanContent, type SharedPlan } from '../shared-plans';
import { saveCardConfig } from './save';
import { releaseServer, serverKey } from '../entry-server';

/** The draft's link to a shared plan: an existing one (id) or one to be created on "Save" (no id) */
export interface ShareState {
  id?: string;
  name: string;
  /** revision the editor started from (a save from elsewhere in between is a conflict) */
  rev?: number;
  /** the plan's content when the editor started (unchanged content is not saved again) */
  base?: string;
  /** name as stored */
  savedName?: string;
}

const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

/** The plan's content as it would be stored */
export const contentOf = (cfg: FloorplanCardConfig): PlanContent => planPart(cleanConfig(cfg));

/** The editor starts on a card that shows a shared plan */
export function shareFromCard(cfg: FloorplanCardConfig, shared: SharedPlan | undefined): ShareState | undefined {
  if (!cfg.plan) return undefined;
  return { id: cfg.plan, name: shared?.name ?? cfg.plan, savedName: shared?.name, rev: shared?.rev, base: shared ? stable(contentOf(cfg)) : undefined };
}

/**
 * Saves the draft of a card with a shared plan: the plan's content to the companion (new revision; asks before
 * overwriting a save from elsewhere), the card's own part to the dashboard (only when it changed). Returns the
 * stored card config and the merged one the card works with; undefined when the person cancelled.
 */
export async function saveShared(
  hass: HomeAssistant,
  layer: FloorplanLayer,
  original: FloorplanCardConfig,
  draft: FloorplanCardConfig,
  share: ShareState,
): Promise<{ stored: FloorplanCardConfig; merged: FloorplanCardConfig; plan: SharedPlan } | undefined> {
  const content = contentOf(draft);
  let id = share.id;
  let rev = share.rev ?? 0;
  let updated = new Date().toISOString();
  if (!id || stable(content) !== share.base || share.name !== share.savedName) {
    const req = { id, name: share.name, plan: content, rev: share.rev };
    let s;
    try {
      s = await savePlan(hass, req);
    } catch (e) {
      if ((e as { code?: string })?.code !== 'conflict') throw e;
      if (!(await layer.confirm(t('share.conflict')))) return undefined;
      s = await savePlan(hass, { ...req, force: true });
    }
    id = s.id;
    rev = s.rev;
    updated = s.updated;
  }
  const card = { ...cardPart(draft), plan: id } as FloorplanCardConfig;
  const stored = stable(cleanConfig(card)) === stable(cleanConfig(original)) ? original : await saveCardConfig(hass, original, card);
  // just shared: the card's settings on the server (warning, dogs, vacuums) move to the plan's key
  if (original.plan !== id && serverKey(original) !== serverKey(stored)) await releaseServer(hass, serverKey(original));
  return { stored, merged: normalizeConfig(mergePlan(stored, content)), plan: { id: id!, name: share.name, rev, updated, plan: content } };
}

/** Settings → "Use on several dashboards" */
export function shareSection(ed: FloorplanEditorUI): TemplateResult {
  const sh = ed._share;
  const can = sharesPlans();
  if (!can && !sh)
    return fold(
      ed,
      html`<div class="hint-s">${t('share.needs_companion')}</div>`,
      undefined,
    );
  if (sh)
    return fold(
      ed,
      html`<div class="group">
          <div class="row">
            <ha-icon icon="mdi:monitor-multiple" style="color:var(--fp-green)"></ha-icon>
            <div class="grow">
              <div class="title">${t('share.shared_as', { name: sh.name })}</div>
              <div class="subtitle wrap">${sh.id ? t('share.shared_sub') : t('share.pending_sub')}</div>
            </div>
          </div>
          <label class="row field-row">
            <span class="subtitle">${t('share.name')}</span>
            <input
              class="field inline"
              data-share-name
              .value=${sh.name}
              @change=${(e: Event) => ed.setShare({ ...sh, name: (e.target as HTMLInputElement).value.trim() || sh.name })}
            />
          </label>
          <button class="row pressable" data-share-unlink @click=${() => void unlink(ed)}>
            <ha-icon icon="mdi:link-variant-off" style="color:var(--fp-accent)"></ha-icon>
            <div class="grow"><div class="title accent">${t('share.unlink')}</div></div>
          </button>
        </div>
        <div class="hint-s">${t('share.shared_hint')}</div>`,
      sh.name,
    );
  if (!ed._plans) void ed.loadPlans();
  const plans = ed._plans ?? [];
  return fold(
      ed,
    html`<div class="group">
        <label class="row field-row">
          <span class="subtitle">${t('share.name')}</span>
          <input class="field inline" data-share-new-name placeholder=${ed._draft.title || t('share.default_name')} />
        </label>
        <button
          class="row pressable"
          data-share-make
          @click=${(e: Event) => {
            const input = (e.currentTarget as HTMLElement).parentElement?.querySelector('[data-share-new-name]') as HTMLInputElement | null;
            ed.setShare({ name: input?.value.trim() || ed._draft.title || t('share.default_name') });
            ed.layer.toast(t('share.on_save'));
          }}
        >
          <ha-icon icon="mdi:monitor-share" style="color:var(--fp-accent)"></ha-icon>
          <div class="grow"><div class="title accent">${t('share.make')}</div><div class="subtitle wrap">${t('share.make_sub')}</div></div>
        </button>
      </div>
      ${plans.length
        ? html`<div class="section-title">${t('share.existing')}</div>
            <div class="group">
              ${plans.map(
                (p) => html`<button class="row pressable" data-share-use=${p.id} @click=${() => void use(ed, p.id, p.name)}>
                  <ha-icon icon="mdi:floor-plan" style="color:var(--fp-accent)"></ha-icon>
                  <div class="grow">
                    <div class="title">${p.name}</div>
                    <div class="subtitle">${t('share.counts', { f: p.floors, r: p.rooms })}</div>
                  </div>
                  <span class="trailing accent">${t('share.use')}</span>
                </button>`,
              )}
            </div>`
        : nothing}`,
    undefined,
  );
}

function fold(ed: FloorplanEditorUI, body: unknown, sub: string | undefined) {
  return html`<details class="fold" data-share ?open=${ed.shareOpen}>
    <summary>
      <ha-icon icon="mdi:monitor-multiple" style="color:var(--fp-accent)"></ha-icon>
      <span class="grow">${t('share.title')}</span>
      ${sub ? html`<span class="sub">${sub}</span>` : nothing}
      <ha-icon class="chev" icon="mdi:chevron-right"></ha-icon>
    </summary>
    <div class="fold-body">${body}</div>
  </details>`;
}

/** Take a shared plan for this card: its content replaces the draft's plan (undoable until saved) */
async function use(ed: FloorplanEditorUI, id: string, name: string) {
  if (!(await ed.layer.confirm(t('share.use_confirm', { name })))) return;
  try {
    const p = await getPlan(ed.hass, id);
    ed.adoptShared(p);
    ed.layer.toast(t('share.used', { name: p.name }));
  } catch {
    ed.layer.toast(t('share.load_failed'));
  }
}

/** Back to a plan of its own: the card keeps a copy of the plan as it is now */
async function unlink(ed: FloorplanEditorUI) {
  if (ed._share?.id && !(await ed.layer.confirm(t('share.unlink_confirm')))) return;
  ed.setShare(undefined);
  ed.layer.toast(t('share.unlinked'));
}

/** Fresh list of the shared plans for the settings */
export async function fetchPlans(hass: HomeAssistant) {
  try {
    return await listPlans(hass);
  } catch {
    return [];
  }
}
