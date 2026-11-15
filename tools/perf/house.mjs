// A synthetic demo house for performance runs: two floors of rooms in a grid with lights, climate, sensors,
// doors, windows and furniture bound to entities, plus thousands of unrelated entities (a large Home Assistant).
// Pure data, no browser: house({ rooms, extra }) → { config, states, entities, devices, areas, floors }.

const KINDS = [
  ['sofa', 220, 90, 'light'],
  ['bed', 160, 200],
  ['dining_table', 160, 90],
  ['floor_lamp', 40, 40, 'light'],
  ['tv', 140, 20, 'media_player'],
  ['fridge', 70, 70, 'switch'],
  ['plant', 40, 40],
  ['wardrobe', 200, 60],
  ['desk', 140, 70],
  ['radiator', 80, 12, 'climate'],
  ['fan', 40, 40, 'fan'],
  ['shelf', 120, 35],
];

export function house({ rooms = 16, extra = 2500, floors = 2, calm = false } = {}) {
  // calm: every window shut and nothing running, so nothing on the plan has a reason to move
  const states = {};
  const entities = {};
  const devices = {};
  const areas = {};
  const haFloors = {};
  const now = new Date().toISOString();
  const add = (entity_id, state, attributes = {}, area) => {
    states[entity_id] = { entity_id, state, attributes, last_changed: now, last_updated: now, context: { id: 'c' } };
    entities[entity_id] = { entity_id, area_id: area, platform: 'demo' };
  };
  add('sun.sun', 'above_horizon', { elevation: 35, azimuth: 180, rising: false, friendly_name: 'Sun' });
  add('weather.home', 'partlycloudy', { temperature: 14, wind_speed: 12, wind_bearing: 220, cloud_coverage: 40, friendly_name: 'Home' });

  const perFloor = Math.ceil(rooms / floors);
  const cols = Math.ceil(Math.sqrt(perFloor));
  const W = 420;
  const H = 360;
  const cfgFloors = [];
  let n = 0;
  for (let fl = 0; fl < floors; fl++) {
    const fid = `floor_${fl}`;
    haFloors[fid] = { floor_id: fid, name: `Floor ${fl}`, level: fl };
    const floor = { id: `f${fl}`, name: `Floor ${fl}`, floor: fid, level: fl, rooms: [], devices: [], openings: [], furniture: [] };
    for (let i = 0; i < perFloor && n < rooms; i++, n++) {
      const x0 = (i % cols) * W;
      const y0 = Math.floor(i / cols) * H;
      const area = `room_${n}`;
      areas[area] = { area_id: area, name: `Room ${n}`, floor_id: fid };
      const lights = [0, 1, 2].map((k) => `light.room_${n}_lamp_${k}`);
      lights.forEach((id, k) => add(id, k === 0 && n % 3 === 0 ? 'on' : 'off', { brightness: 180, color_mode: 'color_temp', color_temp_kelvin: 3000, supported_color_modes: ['color_temp'], friendly_name: `Room ${n} lamp ${k}` }, area));
      add(`sensor.room_${n}_temperature`, (19 + (n % 5)).toFixed(1), { device_class: 'temperature', unit_of_measurement: '°C', friendly_name: `Room ${n} temperature` }, area);
      add(`sensor.room_${n}_humidity`, String(40 + (n % 20)), { device_class: 'humidity', unit_of_measurement: '%', friendly_name: `Room ${n} humidity` }, area);
      add(`climate.room_${n}`, 'heat', { current_temperature: 20, temperature: 21, hvac_modes: ['off', 'heat'], min_temp: 5, max_temp: 30, friendly_name: `Room ${n} heating` }, area);
      add(`binary_sensor.room_${n}_window`, !calm && n % 7 === 0 ? 'on' : 'off', { device_class: 'window', friendly_name: `Room ${n} window` }, area);
      add(`binary_sensor.room_${n}_door`, 'off', { device_class: 'door', friendly_name: `Room ${n} door` }, area);
      const room = {
        id: `r${n}`,
        name: `Room ${n}`,
        area,
        points: [[x0, y0], [x0 + W, y0], [x0 + W, y0 + H], [x0, y0 + H]],
        temperature: `sensor.room_${n}_temperature`,
        humidity: `sensor.room_${n}_humidity`,
        climate: `climate.room_${n}`,
        sensors: [{ entity: `binary_sensor.room_${n}_window`, icon: 'mdi:window-open-variant' }],
      };
      // every second room uses its area's lights (no explicit list), like a fresh setup does
      if (n % 2) room.lights = lights;
      floor.rooms.push(room);
      floor.openings.push({ id: `w${n}`, type: 'window', a: [x0 + 120, y0], b: [x0 + 240, y0], entity: `binary_sensor.room_${n}_window` });
      floor.openings.push({ id: `d${n}`, type: 'door', a: [x0, y0 + 140], b: [x0, y0 + 230], entity: `binary_sensor.room_${n}_door` });
      KINDS.forEach(([kind, w, h, domain], k) => {
        if ((k + n) % 2) return; // about half of the catalogue per room
        let entity;
        if (domain === 'light') entity = lights[1 + (k % 2)];
        else if (domain === 'climate') entity = `climate.room_${n}`;
        else if (domain) {
          entity = `${domain}.room_${n}_${kind}`;
          add(entity, domain === 'media_player' ? 'idle' : 'off', { friendly_name: `Room ${n} ${kind}` }, area);
        }
        floor.furniture.push({ id: `p${n}_${k}`, kind, x: x0 + 40 + (k % 4) * 90, y: y0 + 40 + Math.floor(k / 4) * 100, w, h, ...(entity ? { entity } : {}) });
      });
      floor.devices.push({ id: `dev${n}`, entity: `sensor.room_${n}_temperature`, x: x0 + W - 40, y: y0 + H - 40 });
    }
    cfgFloors.push(floor);
  }
  // unrelated entities: what a large installation has beyond the plan
  for (let i = 0; i < extra; i++) add(`sensor.misc_${i}`, String(i % 100), { unit_of_measurement: 'W', friendly_name: `Misc ${i}` }, i % 4 ? undefined : `room_${i % rooms}`);
  add('todo.shopping', '2', { supported_features: 7, friendly_name: 'Shopping list' });
  // a car in the first room (its popup is a lazily loaded chunk); its device has as many entities as a connected
  // car brings, so the popup is long enough to scroll
  add('sensor.demo_car_battery', '64', { device_class: 'battery', unit_of_measurement: '%', friendly_name: 'Car battery' });
  const car = (id, state, attributes) => {
    add(id, state, attributes);
    entities[id].device_id = 'demo_car';
  };
  devices.demo_car = { id: 'demo_car', name: 'Demo car', manufacturer: 'Demo' };
  entities['sensor.demo_car_battery'].device_id = 'demo_car';
  car('sensor.demo_car_range', '310', { unit_of_measurement: 'km', friendly_name: 'Demo car range' });
  car('sensor.demo_car_odometer', '42110', { unit_of_measurement: 'km', friendly_name: 'Demo car odometer' });
  car('lock.demo_car_lock', 'locked', { friendly_name: 'Demo car lock' });
  car('binary_sensor.demo_car_charging', 'off', { device_class: 'battery_charging', friendly_name: 'Demo car charging' });
  car('binary_sensor.demo_car_plug', 'on', { device_class: 'plug', friendly_name: 'Demo car plug' });
  car('climate.demo_car_climate', 'off', { hvac_modes: ['off', 'heat_cool'], temperature: 21, friendly_name: 'Demo car climate' });
  car('number.demo_car_charge_limit', '80', { min: 50, max: 100, step: 10, unit_of_measurement: '%', friendly_name: 'Demo car charge limit' });
  car('device_tracker.demo_car_location', 'home', { friendly_name: 'Demo car location' });
  for (const p of ['front_left', 'front_right', 'rear_left', 'rear_right']) {
    car(`binary_sensor.demo_car_door_${p}`, 'off', { device_class: 'door', friendly_name: `Demo car door ${p.replace('_', ' ')}` });
    car(`binary_sensor.demo_car_window_${p}`, 'off', { device_class: 'window', friendly_name: `Demo car window ${p.replace('_', ' ')}` });
    car(`sensor.demo_car_tire_pressure_${p}`, '2.5', { device_class: 'pressure', unit_of_measurement: 'bar', friendly_name: `Demo car tire pressure ${p.replace('_', ' ')}` });
    car(`switch.demo_car_seat_heating_${p}`, 'off', { friendly_name: `Demo car seat heating ${p.replace('_', ' ')}` });
  }
  for (let i = 0; i < 12; i++) car(`sensor.demo_car_trip_${i}`, String(10 + i), { unit_of_measurement: 'km', friendly_name: `Demo car trip ${i}` });
  cfgFloors[0].furniture.push({ id: 'car1', kind: 'car', x: 60, y: 260, w: 180, h: 450, entities: { battery: 'sensor.demo_car_battery' } });
  const config = { type: 'custom:floorplan-card', card_id: 'perf_demo', height: '100vh', view_mode: 'auto', floors: cfgFloors };
  return { config, states, entities, devices, areas, floors: haFloors };
}

/** Entities that change often in a real home (power meters, temperatures) — none of them on the plan */
export const noisyIds = (h) => Object.keys(h.states).filter((id) => id.startsWith('sensor.misc_'));
/** Entities the plan shows */
export const planIds = (h) => Object.keys(h.states).filter((id) => /^(light|climate|sensor)\.room_\d+_(lamp_0|temperature)$|^climate\.room_\d+$/.test(id));
