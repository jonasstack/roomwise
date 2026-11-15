import type { HassEntity, HomeAssistant } from './types';

interface Override {
  state?: string;
  attributes?: Record<string, unknown>;
  base?: string; // last_updated of the real state when the override was set
  until: number;
}

const TTL = 10000;

/**
 * Optimistic state overlay: shows the expected state immediately after an action and drops the
 * override as soon as HA reports a newer state, on failure, or after a timeout.
 */
export class OptimisticStore {
  private overrides = new Map<string, Override>();
  private timer?: number;

  constructor(private onChange: () => void) {}

  set(hass: HomeAssistant, entityId: string, state?: string, attributes?: Record<string, unknown>) {
    const real = hass.states[entityId];
    this.overrides.set(entityId, { state, attributes, base: real?.last_updated, until: Date.now() + TTL });
    this.schedule();
    this.onChange();
  }

  clear(entityIds: string[]) {
    let changed = false;
    for (const id of entityIds) changed = this.overrides.delete(id) || changed;
    if (changed) this.onChange();
  }

  /** Call on every hass update. Returns true if something was dropped. */
  reconcile(hass: HomeAssistant): boolean {
    let changed = false;
    const now = Date.now();
    for (const [id, o] of this.overrides) {
      const real = hass.states[id];
      if (!real || real.last_updated !== o.base || now > o.until) {
        this.overrides.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  get(hass: HomeAssistant, entityId: string): HassEntity | undefined {
    const real = hass?.states[entityId];
    const o = this.overrides.get(entityId);
    if (!o || !real) return real;
    return {
      ...real,
      state: o.state ?? real.state,
      attributes: o.attributes ? { ...real.attributes, ...o.attributes } : real.attributes,
    };
  }

  has(entityId: string) {
    return this.overrides.has(entityId);
  }

  private schedule() {
    clearTimeout(this.timer);
    if (!this.overrides.size) return;
    const next = Math.min(...[...this.overrides.values()].map((o) => o.until)) - Date.now();
    this.timer = window.setTimeout(() => {
      const now = Date.now();
      let changed = false;
      for (const [id, o] of this.overrides)
        if (now >= o.until) {
          this.overrides.delete(id);
          changed = true;
        }
      if (changed) this.onChange();
      this.schedule();
    }, Math.max(50, next + 10));
  }

  destroy() {
    clearTimeout(this.timer);
  }
}
