// Shared by the floor tests: a three-storey home made from the live floor, set IN THE PAGE ONLY (never saved).
export const FIND = `const find = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'FLOORPLAN-CARD') return el; if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } };`;
export const cardFn = (page) => (expr) => page.evaluate(`(async () => { ${FIND} const card = find(document); const plan = card.shadowRoot.querySelector('fp-plan'); const slider = card.shadowRoot.querySelector('fp-floor-slider'); return ${expr}; })()`);
export const BLOCK = ['light', 'climate', 'vacuum', 'cover', 'switch', 'lock', 'button', 'media_player', 'fan', 'todo', 'homeassistant', 'script', 'scene', 'automation', 'notify', 'tts', 'siren', 'alarm_control_panel', 'input_boolean', 'input_button', 'number', 'select'];

/** EG = the live floor (+ stairs in the hall), OG above (smaller, stairs at the same spot), Keller below */
export const SETUP = `(() => {
  const live = card.rawConfig.floors[0];
  const hall = live.rooms.find((r) => r.name === 'Flur') ?? live.rooms[0];
  const xs = hall.points.map((p) => p[0]), ys = hall.points.map((p) => p[1]);
  const sx = (Math.min(...xs) + Math.max(...xs)) / 2, sy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const stairs = (id) => ({ id, kind: 'stairs', x: sx, y: sy, w: 90, h: 200 });
  const rect = (id, name, x0, y0, x1, y1) => ({ id, name, points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] });
  const eg = { ...live, name: 'Erdgeschoss', level: 0, furniture: [...(live.furniture ?? []), stairs('st_eg')] };
  const og = { id: 'fl_og', name: 'Obergeschoss', level: 1, devices: [], openings: [], furniture: [stairs('st_og'), { id: 'og_bed', kind: 'bed', x: 200, y: 160, w: 160, h: 200 }, { id: 'og_desk', kind: 'desk', x: 760, y: 200, w: 140, h: 70 }],
    rooms: [rect('og_kid', 'Kinderzimmer', -11, 0, 401, 330), rect('og_hall', 'Galerie', 401, 0, 555, 413), rect('og_work', 'Arbeitszimmer', 555, 0, 934, 330), rect('og_bath', 'Duschbad', 555, 330, 800, 413)] };
  const kg = { id: 'fl_kg', name: 'Keller', level: -1, devices: [], openings: [], furniture: [{ id: 'kg_washer', kind: 'washer', x: 620, y: 150, w: 60, h: 60 }],
    rooms: [rect('kg_store', 'Vorrat', -11, 0, 401, 413), rect('kg_tech', 'Technik', 401, 0, 934, 413)] };
  card.setConfig({ ...card.rawConfig, floors: [eg, og, kg] });
  return true;
})()`;
