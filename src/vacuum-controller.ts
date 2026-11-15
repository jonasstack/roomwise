import type { FloorplanCardConfig, HomeAssistant } from './types';
import { serverKey, subscribeVacuums, vacuumLearned, vacuumMap, vacuumPath, vacuumsOf, type ServerVacuumState } from './entry-server';
import type { GlScene } from './gl/scene';

const MOVING = new Set(['cleaning', 'returning']);
const IN_RUN = new Set(['cleaning', 'paused', 'returning']);

/**
 * The card's side of the live vacuums: follows the positions the companion integration pushes and hands them to
 * the 3D scene (no re-render of the card for that); fetches what each vacuum has learned about the floor at
 * the start and after every run.
 */
export class VacuumController {
  private sub?: Promise<() => void>;
  private key = '';
  private states: Record<string, ServerVacuumState> = {};
  private learnedFor = new Map<string, number>();
  /** run whose trail has been fetched, per vacuum */
  private trailFor = new Map<string, number>();
  private lastState = new Map<string, string>();

  constructor(private scene: () => GlScene | undefined) {}

  watch(hass: HomeAssistant, cfg: FloorplanCardConfig | undefined, on: boolean) {
    const vacs = cfg ? vacuumsOf(cfg) : [];
    const key = on && vacs.length ? serverKey(cfg) : '';
    if (key === this.key) return;
    this.key = key;
    void this.sub?.then((u) => u()).catch(() => {});
    this.sub = undefined;
    if (!key) return;
    this.sub = subscribeVacuums(hass, key, (st) => {
      const prev = this.states;
      this.states = st ?? {};
      for (const [id, s] of Object.entries(this.states)) {
        // a run ended: the server has learned more
        if (prev[id] && MOVING.has(prev[id].state ?? '') && !MOVING.has(s.state ?? '')) this.learnedFor.delete(id);
      }
      this.pump(hass);
    });
    this.sub.catch(() => (this.key = ''));
  }

  /** Hand the latest positions (and learned floor) to the scene's vacuums (also after the scene rebuilt them) */
  pump(hass: HomeAssistant | undefined) {
    const scene = this.scene();
    if (!hass) return;
    let missing = !scene;
    for (const [id, s] of Object.entries(this.states)) {
      if (!scene?.hasLiveVacuum(id)) {
        missing = true;
        continue;
      }
      if (s.x != null && s.y != null) scene.feedVacuum(id, s.x, s.y, s.seq, s.iv, s.t);
      // its trail so far (a tablet that loads during a run shows it from the start); the run over: gone
      const run = s.run ?? 0;
      // the run has just ended (not on every push while it sits in the dock)
      if (!IN_RUN.has(s.state ?? '') && IN_RUN.has(this.lastState.get(id) ?? '')) {
        scene.clearVacuumTrail(id);
        this.trailFor.delete(id);
      }
      this.lastState.set(id, s.state ?? '');
      if (IN_RUN.has(s.state ?? '') && this.trailFor.get(id) !== run) {
        this.trailFor.set(id, run);
        void vacuumPath(hass, s.entity).then((p) => p && p.run === run && this.scene()?.setVacuumTrail(id, run, p.pts));
      }
      if (!this.learnedFor.has(id)) {
        this.learnedFor.set(id, Date.now());
        void vacuumLearned(hass, s.entity).then((l) => l && this.scene()?.setVacuumLearned(id, l));
        void vacuumMap(hass, s.entity).then((m) => m && this.scene()?.setVacuumMap(id, m));
      }
    }
    // the scene builds its vacuums a moment later: try again shortly
    if (missing && Object.keys(this.states).length && this.retries++ < 20) {
      clearTimeout(this.retry);
      this.retry = window.setTimeout(() => this.pump(hass), 600);
    } else if (!missing) this.retries = 0;
  }
  private retry?: number;
  private retries = 0;

  stop() {
    void this.sub?.then((u) => u()).catch(() => {});
    this.sub = undefined;
    this.key = '';
  }
}
