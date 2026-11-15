import type { FloorplanCardConfig, HomeAssistant } from './types';
import { defaultTexts, ENTRY_DEFAULTS, ttsLanguage, windowsOf } from './entry-alert';
import { getLanguage } from './i18n';
import { defaultTitle, textTemplate } from './walk-notify';
import type { LearnedFloor, VacuumMap } from './vacuum-live';

/**
 * The card's companion integration (custom_components/floorplan_card, same HACS package): it runs what must
 * work without any tablet — the front door warning (announcement, flashing lights, acknowledged by a switch
 * or a tap) and walk check-offs shared by every device. The card configures it over the websocket; without
 * the integration everything keeps working on the devices that show the card.
 */
export interface CompanionInfo {
  version: string;
  loaded: boolean;
  /** card ids whose warning runs on the server */
  entry_alert: string[];
  /** card id → signature of the dogs' settings the server has */
  pets?: Record<string, string>;
  /** card id → signature of the vacuums the server follows */
  vacuums?: Record<string, string>;
  /** card id → signature of the warning settings the server has */
  entry_alert_sig?: Record<string, string>;
  /** what this version offers beyond the basics: 'plans' (shared floor plans), 'images' (trace images), 'wifi' */
  features?: string[];
}

let infoPromise: Promise<CompanionInfo | undefined> | undefined;
let infoConn: unknown;
let info: CompanionInfo | undefined;
/** the question "is the companion there" has been answered (for this connection) */
let known = false;
export function companionKnown(): boolean {
  return known;
}
const listeners = new Set<() => void>();

/** Whether the companion is set up (cached per connection; `fresh` asks again) */
export function companion(hass: HomeAssistant | undefined, fresh = false): Promise<CompanionInfo | undefined> {
  // (tests with temporary configurations run without the server, so they never change its data)
  if (!hass || (window as { __fpNoCompanion?: boolean }).__fpNoCompanion) {
    known = true;
    return Promise.resolve(undefined);
  }
  if (!infoPromise || infoConn !== hass.connection || fresh) {
    if (infoConn !== hass.connection) known = false;
    infoConn = hass.connection;
    infoPromise = hass
      .callWS<CompanionInfo>({ type: 'floorplan_card/info' })
      .then((r) => (r?.loaded ? r : undefined))
      .catch(() => undefined)
      .then((r) => {
        info = r;
        known = true;
        for (const l of listeners) l();
        return r;
      });
  }
  return infoPromise;
}

/** Last known companion state (synchronous) */
export function companionInfo(): CompanionInfo | undefined {
  return info;
}

export function onCompanion(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The key of a card's settings on the server: its card_id — or, for a shared floor plan, the plan's, so every card
 *  showing it shares one front door warning, one set of dogs and vacuums (never doubled reminders) */
export const serverKey = (cfg: Pick<FloorplanCardConfig, 'card_id' | 'plan'> | undefined) => (cfg?.plan ? `plan_${cfg.plan}` : (cfg?.card_id ?? 'plan'));
const cardKey = serverKey;

/** The warning goes to the server unless switched off (on by default, as soon as the companion is there) */
export function serverWanted(cfg: FloorplanCardConfig | undefined): boolean {
  return !!cfg?.entry_alert?.door && cfg.entry_alert.server !== false;
}

/** The server runs this card's warning: the cards only show it */
export function serverActive(_hass: HomeAssistant | undefined, cfg: FloorplanCardConfig | undefined): boolean {
  return serverWanted(cfg) && !!info?.entry_alert.includes(cardKey(cfg!));
}

const sigOf = (v: unknown) => {
  const json = JSON.stringify(v);
  let h = 2166136261;
  for (let i = 0; i < json.length; i++) h = Math.imul(h ^ json.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
};

/** Hand over the warning (older companions do not take a signature) */
async function setAlert(hass: HomeAssistant, cardId: string, config: Record<string, unknown>, sig: string) {
  try {
    await hass.callWS({ type: 'floorplan_card/entry_alert/set', card_id: cardId, config, sig });
  } catch {
    await hass.callWS({ type: 'floorplan_card/entry_alert/set', card_id: cardId, config });
  }
}

/** Keep the server's copy of the warning current (admins; also without opening the editor). `hrRuns`: Hausregeln
 *  runs the warning, the server's copy goes (the companion also stands aside by itself while Hausregeln warns). */
export async function syncAlert(hass: HomeAssistant, cfg: FloorplanCardConfig, hrRuns = false): Promise<void> {
  if (!hass.user?.is_admin || !info) return;
  const key = cardKey(cfg);
  const has = info.entry_alert.includes(key);
  if (hrRuns || !serverWanted(cfg)) {
    if (has) await hass.callWS({ type: 'floorplan_card/entry_alert/remove', card_id: key }).catch(() => {});
    else return;
  } else {
    const sc = await serverConfig(hass, cfg);
    if (!sc) return;
    const sig = sigOf(sc);
    // (an older companion knows no signatures: then only hand it over when it has nothing yet — re-sending
    // would re-arm a warning that may be running right now)
    if (has && (!info.entry_alert_sig || info.entry_alert_sig[key] === sig)) return;
    await setAlert(hass, key, sc, sig).catch((e) => console.warn('[floorplan-card] warning', e));
  }
  await companion(hass, true);
}

/** A card's settings on the server under an old key are dropped (the card now shows a shared plan, whose key takes
 *  over): its warning stops, its dogs and vacuums are no longer followed under that key */
export async function releaseServer(hass: HomeAssistant, key: string): Promise<void> {
  const i = await companion(hass, true);
  if (!i || !hass.user?.is_admin) return;
  if (i.entry_alert.includes(key)) await hass.callWS({ type: 'floorplan_card/entry_alert/remove', card_id: key }).catch(() => {});
  if (key in (i.pets ?? {})) await hass.callWS({ type: 'floorplan_card/pets/set', card_id: key, pets: [], sig: '' }).catch(() => {});
  if (key in (i.vacuums ?? {})) await hass.callWS({ type: 'floorplan_card/vacuums/set', card_id: key, vacuums: [], sig: '' }).catch(() => {});
  await companion(hass, true);
}

/** A tap on a tablet acknowledges the server's warning */
export function ackServer(hass: HomeAssistant | undefined, cfg: FloorplanCardConfig | undefined) {
  if (!hass || !cfg) return;
  hass.callWS({ type: 'floorplan_card/entry_alert/ack', card_id: cardKey(cfg) }).catch(() => {});
}

const supportsColor = (hass: HomeAssistant, id: string) =>
  ((hass.states[id]?.attributes.supported_color_modes as string[] | undefined) ?? []).some((m) => ['hs', 'xy', 'rgb', 'rgbw', 'rgbww'].includes(m));

/** The warning as the server needs it: entity ids, window names in checking order, final texts, language */
export async function serverConfig(hass: HomeAssistant, cfg: FloorplanCardConfig): Promise<Record<string, unknown> | undefined> {
  const ec = cfg.entry_alert;
  if (!ec?.door) return undefined;
  const byId = new Map<string, string>();
  for (const f of cfg.floors ?? []) for (const o of f.openings ?? []) if (o.entity) byId.set(o.id, o.entity);
  const door = byId.get(ec.door);
  if (!door) return undefined;
  const windows = windowsOf(cfg)
    .map((w) => ({ e: byId.get(w.id)!, n: w.name }))
    .filter((w) => w.e);
  if (!windows.length) return undefined;
  const tx = defaultTexts();
  const lights = (ec.flash_lights ?? []).filter((id) => id.startsWith('light.'));
  return {
    door,
    windows,
    ack_entity: ec.ack_entity,
    timeout: Math.max(0, ec.timeout ?? ENTRY_DEFAULTS.timeout),
    mode: ec.mode ?? ENTRY_DEFAULTS.mode,
    tts_entity: ec.tts_entity,
    media_player: ec.media_player,
    language: ec.tts_entity ? ec.tts_language || (await ttsLanguage(hass, ec.tts_entity)) : undefined,
    texts: { general: ec.text_general || tx.general, all: ec.text_all || tx.all, single: ec.text_single || tx.single },
    and: getLanguage() === 'en' ? ' and ' : ' und ',
    flash_color: lights.filter((id) => supportsColor(hass, id)),
    flash_plain: lights.filter((id) => !supportsColor(hass, id)),
  };
}

/** The companion is installed but not added yet: add it (one config entry, nothing to fill in) */
async function setUpCompanion(hass: HomeAssistant): Promise<boolean> {
  try {
    const flow = await hass.callApi<{ flow_id: string; type: string }>('POST', 'config/config_entries/flow', { handler: 'floorplan_card', show_advanced_options: false });
    if (flow.type === 'form') await hass.callApi('POST', `config/config_entries/flow/${flow.flow_id}`, {});
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 300));
      if (await companion(hass, true)) return true;
    }
  } catch {
    /* not installed */
  }
  return false;
}

/** Hand the card's warning to the server (or take it back); returns an error text */
export async function syncServer(hass: HomeAssistant, cfg: FloorplanCardConfig, wasOn: boolean): Promise<string | undefined> {
  const on = serverWanted(cfg);
  // switched on by hand (not just the default): then a missing companion is worth a message
  const explicit = cfg.entry_alert?.server === true;
  if (!on && !wasOn) {
    // the dogs still go to the server (walk state, reminders) when it is there
    if (await companion(hass, true)) {
      await syncPets(hass, cfg, true);
      await syncVacuums(hass, cfg, true);
    }
    return undefined;
  }
  const de = getLanguage() !== 'en';
  if (!(await companion(hass, true)) && !(explicit && (await setUpCompanion(hass))))
    return explicit ? (de ? 'Die Begleit-Integration „Grundriss-Karte“ ist nicht installiert.' : 'The companion integration "Floorplan card" is not installed.') : undefined;
  try {
    if (!on) {
      await hass.callWS({ type: 'floorplan_card/entry_alert/remove', card_id: cardKey(cfg) });
    } else {
      const sc = await serverConfig(hass, cfg);
      if (!sc) return explicit ? (de ? 'Haustür mit Kontaktsensor und Fenster mit Sensoren nötig.' : 'Front door with contact sensor and windows with sensors needed.') : undefined;
      await setAlert(hass, cardKey(cfg), sc, sigOf(sc));
    }
    await companion(hass, true);
    await syncPets(hass, cfg, true);
    await syncVacuums(hass, cfg, true);
    return undefined;
  } catch (e) {
    return String((e as { message?: string })?.message ?? e);
  }
}

// ---------- the warning's state, the same on every tablet ----------

export interface ServerAlertState {
  active: boolean;
  phase: 'alarm' | 'linger' | null;
  /** open windows (entity ids) */
  windows: string[];
  /** when the announcement comes (ms) */
  deadline: number | null;
  spoken: boolean;
}

export function subscribeAlert(hass: HomeAssistant, cardId: string, cb: (st: ServerAlertState | null) => void): Promise<() => void> {
  return hass.connection.subscribeMessage<ServerAlertState | null>(cb, { type: 'floorplan_card/entry_alert/subscribe', card_id: cardId });
}

// ---------- dogs: walk state and reminders on the server ----------

export interface ServerPetState {
  mode: 'idle' | 'due' | 'away';
  slot?: string;
  next?: string;
  done: string[];
  awaySince?: number | null;
}

/** The dogs as the server needs them (walk times, presence, reminders with final texts) */
export async function petsServerConfig(hass: HomeAssistant, cfg: FloorplanCardConfig): Promise<{ pets: Record<string, unknown>[]; sig: string }> {
  const de = getLanguage() !== 'en';
  const pets: Record<string, unknown>[] = [];
  for (const f of cfg.floors ?? [])
    for (const p of f.furniture ?? []) {
      if (p.kind !== 'dog' || (!p.pet?.walks?.length && !p.entity)) continue;
      const r = p.pet?.remind;
      const speak = r?.speak?.tts_entity && r.speak.media_player ? { ...r.speak, language: r.speak.language || (await ttsLanguage(hass, r.speak.tts_entity)) } : undefined;
      pets.push({
        id: p.id,
        name: p.name || (de ? 'Hund' : 'Dog'),
        walks: p.pet?.walks ?? [],
        presence: p.entity,
        remind: r
          ? {
              after: r.after ?? 0,
              repeat: r.repeat ?? 0,
              count: r.count,
              title: r.title?.trim() || defaultTitle(p),
              text: textTemplate(p, r),
              done_label: de ? 'Erledigt' : 'Done',
              done_button: r.done_button !== false,
              important: !!r.important,
              notify: r.notify?.targets?.length ? r.notify : undefined,
              speak,
            }
          : undefined,
      });
    }
  const json = JSON.stringify(pets);
  let h = 2166136261;
  for (let i = 0; i < json.length; i++) h = Math.imul(h ^ json.charCodeAt(i), 16777619);
  return { pets, sig: (h >>> 0).toString(36) };
}

/** Hand the dogs to the server when it has an older version of them (admins only) */
export async function syncPets(hass: HomeAssistant, cfg: FloorplanCardConfig, force = false): Promise<void> {
  if (!hass.user?.is_admin || !info) return;
  const { pets, sig } = await petsServerConfig(hass, cfg);
  if (!force && info.pets?.[cardKey(cfg)] === sig) return;
  if (!pets.length && !(cardKey(cfg) in (info.pets ?? {}))) return;
  await hass.callWS({ type: 'floorplan_card/pets/set', card_id: cardKey(cfg), pets, sig }).catch((e) => console.warn('[floorplan-card] walks', e));
  await companion(hass, true);
}

export function subscribePets(hass: HomeAssistant, cardId: string, cb: (st: Record<string, ServerPetState> | null) => void): Promise<() => void> {
  return hass.connection.subscribeMessage<Record<string, ServerPetState> | null>(cb, { type: 'floorplan_card/pets/subscribe', card_id: cardId });
}

// ---------- robot vacuums: live position ----------

export interface ServerVacuumState {
  entity: string;
  state: string | null;
  x: number | null;
  y: number | null;
  t: number | null;
  seq: number;
  /** counts the vacuum's runs (companion 1.5+): a new one starts a new trail */
  run?: number;
  /** where the position comes from: roborock, map_camera (Dreame, Xiaomi Cloud Map Extractor …), valetudo */
  adapter?: VacuumAdapterKind;
  /** ms between two new positions while it moves (map cameras report only every few seconds) */
  iv?: number;
}

export type VacuumAdapterKind = 'roborock' | 'map_camera' | 'valetudo';

/** Where a vacuum's position and map come from, and the rooms of its own map the card can have cleaned */
export interface VacuumInfo {
  adapter: VacuumAdapterKind | null;
  /** the map entity (camera / image) it reads */
  source: string | null;
  /** the vacuum's integration (roborock, dreame_vacuum, xiaomi_miio, mqtt …) */
  platform: string | null;
  segments: { id: string; name: string | null }[];
  /** the card can start cleaning single segments */
  clean: boolean;
  /** map entities that may belong to it, best first */
  candidates: string[];
}

/** The vacuums of a card the server should follow (pieces linked to a vacuum entity, with a map entity picked
 * by hand if there is one) */
export function vacuumsOf(cfg: FloorplanCardConfig) {
  const out: { id: string; entity: string; map?: string }[] = [];
  for (const f of cfg.floors ?? [])
    for (const p of f.furniture ?? [])
      if (p.kind === 'robot_vacuum' && p.entity?.startsWith('vacuum.')) out.push({ id: p.id, entity: p.entity, ...(p.vacuum?.map_entity ? { map: p.vacuum.map_entity } : {}) });
  return out;
}

export async function syncVacuums(hass: HomeAssistant, cfg: FloorplanCardConfig, force = false): Promise<void> {
  if (!hass.user?.is_admin || !info) return;
  const vacs = vacuumsOf(cfg);
  const sig = sigOf(vacs);
  const has = cardKey(cfg) in (info.vacuums ?? {});
  if (!force && (has ? info.vacuums?.[cardKey(cfg)] === sig : !vacs.length)) return;
  await hass.callWS({ type: 'floorplan_card/vacuums/set', card_id: cardKey(cfg), vacuums: vacs, sig }).catch(() => {});
  await companion(hass, true);
}

export function subscribeVacuums(hass: HomeAssistant, cardId: string, cb: (st: Record<string, ServerVacuumState> | null) => void): Promise<() => void> {
  return hass.connection.subscribeMessage<Record<string, ServerVacuumState> | null>(cb, { type: 'floorplan_card/vacuums/subscribe', card_id: cardId });
}

export function vacuumLearned(hass: HomeAssistant, entity: string): Promise<LearnedFloor | undefined> {
  return hass.callWS<LearnedFloor>({ type: 'floorplan_card/vacuums/learned', entity }).catch(() => undefined);
}

/** The vacuum's own map (rooms with names, walls, dock), robot millimetres; undefined if not available.
 * `map`: a map entity picked in the editor (else the one the server uses) */
export function vacuumMap(hass: HomeAssistant, entity: string, map?: string): Promise<VacuumMap | undefined> {
  return hass
    .callWS<VacuumMap | null>({ type: 'floorplan_card/vacuums/map', entity, ...(map ? { map } : {}) })
    .then((m) => m ?? undefined)
    .catch(() => undefined);
}

/** Where position and map come from, segments and cleaning; undefined: older companion */
export function vacuumInfo(hass: HomeAssistant, entity: string, map?: string): Promise<VacuumInfo | undefined> {
  return hass.callWS<VacuumInfo>({ type: 'floorplan_card/vacuums/info', entity, ...(map ? { map } : {}) }).catch(() => undefined);
}

/** Clean segments (rooms) of the vacuum's own map, the way its integration does it */
export function vacuumClean(hass: HomeAssistant, entity: string, segments: string[]): Promise<unknown> {
  return hass.callWS({ type: 'floorplan_card/vacuums/clean', entity, segments });
}

/** Where the vacuum has cleaned in its current run (robot mm); undefined: not known (older companion) */
export function vacuumPath(hass: HomeAssistant, entity: string): Promise<{ run: number; start: number; pts: [number, number][] } | undefined> {
  return hass
    .callWS<{ run: number; start: number; pts: [number, number][] } | null>({ type: 'floorplan_card/vacuums/path', entity })
    .then((p) => p ?? undefined)
    .catch(() => undefined);
}

export function vacuumReset(hass: HomeAssistant, entity: string): Promise<unknown> {
  return hass.callWS({ type: 'floorplan_card/vacuums/reset', entity });
}

// ---------- walks shared by every device ----------

export function walkDoneOnServer(hass: HomeAssistant, cardId: string, petId: string, slot: string) {
  hass.callWS({ type: 'floorplan_card/walks/done', card_id: cardId, pet_id: petId, slot }).catch(() => {});
}

/** Today's checked-off walks of a card's pets, pushed on every change */
export function subscribeWalks(hass: HomeAssistant, cardId: string, cb: (walks: Record<string, string[]>) => void): Promise<() => void> {
  return hass.connection.subscribeMessage<Record<string, string[]>>(cb, { type: 'floorplan_card/walks/subscribe', card_id: cardId });
}
