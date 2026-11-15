// Fake states for design screenshots: wraps the card's hass setter, so every read (also optimistic) sees them.
// Nothing reaches HA: service calls are intercepted by openHA's block list.
export const FIND = `const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } };`;
export const cardFn = (page) => (expr) => page.evaluate(`(async () => { ${FIND} const card = find(document); const plan = card.shadowRoot.querySelector('fp-plan'); return ${expr}; })()`);

/** scenario: { weather: 'sunny'|'rainy'|'pouring'|..., lights: bool, heat: bool, open: string[] (entity ids of open contacts),
 *  states: { id: { state, attributes } } (changes existing entities), add: { states, entities, devices, areas } (extra
 *  entities with their registry entries, e.g. a demo car the test instance lacks) } */
export async function fakeStates(page, sc) {
  await page.evaluate(([FIND, sc]) => {
    const find = new Function(`${FIND} return find(document);`);
    const card = find();
    const ha = document.querySelector('home-assistant');
    const proto = Object.getPrototypeOf(card);
    let d; for (let p = proto; p && !d; p = Object.getPrototypeOf(p)) d = Object.getOwnPropertyDescriptor(p, 'hass');
    const patch = (h) => {
      const st = { ...h.states };
      for (const id in st) {
        const s = st[id];
        const dom = id.split('.')[0];
        const set = (state, attrs = {}) => (st[id] = { ...s, state, attributes: { ...s.attributes, ...attrs } });
        if (dom === 'weather' && sc.weather) set(sc.weather, { cloud_coverage: sc.cover ?? (sc.weather === 'sunny' ? 10 : 90), wind_speed: sc.wind ?? 12, wind_bearing: 250 });
        if (dom === 'light' && sc.lights != null) set(sc.lights ? 'on' : 'off', sc.lights ? { brightness: 200, color_mode: 'rgb', rgb_color: [255, 200, 140] } : {});
        if (dom === 'climate' && sc.heat != null) set('heat', { hvac_action: sc.heat ? 'heating' : 'idle', temperature: 22, current_temperature: 20.5 });
        if (sc.states && sc.states[id]) set(sc.states[id].state ?? s.state, sc.states[id].attributes ?? {});
        if (id === 'sun.sun' && sc.night) set('below_horizon', { elevation: -14, azimuth: 290 });
        if (dom === 'binary_sensor' && /contact|fenster|tur/.test(id) && sc.open) set(sc.open.includes(id) ? 'on' : 'off');
      }
      const add = sc.add;
      if (!add) return { ...h, states: st };
      const now = new Date().toISOString();
      for (const [id, x] of Object.entries(add.states ?? {})) st[id] = { entity_id: id, last_changed: now, last_updated: now, context: { id: '' }, attributes: {}, ...x };
      return { ...h, states: st, entities: { ...h.entities, ...add.entities }, devices: { ...h.devices, ...add.devices }, areas: { ...h.areas, ...add.areas } };
    };
    Object.defineProperty(card, 'hass', { configurable: true, set(h) { d.set.call(this, patch(h)); }, get() { return d.get.call(this); } });
    card.hass = ha.hass;
  }, [FIND, sc]);
  await page.waitForTimeout(1200);
}
