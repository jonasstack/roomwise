// A neutral demo plan for the standalone card page (tools/look/card.mjs): no real home, made-up entity ids.
/** examples/basic.yaml plus a kitchen, a dog, a long room name and a second floor */
const ROOMS = [
  { id: 'room_living', name: 'Living room', area: 'living_room', points: [[0, 0], [520, 0], [520, 420], [0, 420]], temperature: 'sensor.living_room_temperature', humidity: 'sensor.living_room_humidity', climate: 'climate.living_room', lights: ['light.living_room_ceiling', 'light.living_room_floor_lamp'], floor: { type: 'herringbone', color: '#c99a62' } },
  { id: 'room_bedroom', name: 'Bedroom with a really long name for testing', area: 'bedroom', points: [[520, 0], [880, 0], [880, 420], [520, 420]], lights: ['light.bedroom_ceiling', 'light.bedside'], temperature: 'sensor.bedroom_temperature', floor: { type: 'planks' } },
  { id: 'room_kitchen', name: 'Kitchen', points: [[880, 0], [1160, 0], [1160, 560], [880, 560]], lights: ['light.kitchen'], temperature: 'sensor.kitchen_temperature', floor: { type: 'tiles', size: 40 } },
  { id: 'room_hall', name: 'Hallway', points: [[0, 420], [880, 420], [880, 560], [0, 560]], floor: { type: 'tiles', size: 30 } },
];
export const CONFIG = {
  type: 'custom:floorplan-card', card_id: 'fp_demo', height: '100vh', north: 0, view_mode: '2d',
  floors: [
    {
      id: 'floor_home', name: 'Ground floor', rooms: ROOMS,
      openings: [
        { id: 'door_front', type: 'door', a: [380, 560], b: [470, 560], entity: 'binary_sensor.front_door' },
        { id: 'door_living', type: 'door', a: [180, 420], b: [270, 420] },
        { id: 'door_bedroom', type: 'door', a: [620, 420], b: [710, 420], hinge_b: true },
        { id: 'door_kitchen', type: 'door', a: [880, 450], b: [880, 530] },
        { id: 'win_living', type: 'window', a: [140, 0], b: [380, 0], entity: 'binary_sensor.living_room_window' },
        { id: 'win_bedroom', type: 'window', a: [640, 0], b: [800, 0], entity: 'binary_sensor.bedroom_window' },
        { id: 'win_kitchen', type: 'window', a: [1160, 120], b: [1160, 320] },
      ],
      devices: [
        { id: 'dev_tv', entity: 'media_player.living_room_tv', icon: 'mdi:television', x: 260, y: 380 },
        { id: 'dev_vacuum', entity: 'vacuum.robot', x: 820, y: 520 },
      ],
      furniture: [
        { id: 'sofa', kind: 'sofa', x: 260, y: 120, w: 220, h: 95, rotation: 180 },
        { id: 'lamp', kind: 'floor_lamp', x: 60, y: 60, w: 40, h: 40, entity: 'light.living_room_floor_lamp' },
        { id: 'rug', kind: 'rug', x: 260, y: 230, w: 200, h: 140 },
        { id: 'radiator', kind: 'radiator', x: 470, y: 12, w: 80, h: 10 },
        { id: 'bed', kind: 'bed', x: 700, y: 210, w: 160, h: 200, rotation: 90 },
        { id: 'wardrobe', kind: 'wardrobe', x: 846, y: 120, w: 160, h: 60, rotation: 270 },
        { id: 'counter', kind: 'counter', x: 1130, y: 300, w: 300, h: 60, rotation: 90 },
        { id: 'fridge', kind: 'fridge', x: 920, y: 40, w: 70, h: 70 },
        { id: 'table', kind: 'dining_table', x: 990, y: 380, w: 140, h: 90 },
        { id: 'dog', kind: 'dog', variant: 'medium', x: 380, y: 300, w: 72, h: 26, name: 'Bello', pet: { walks: ['08:00', '18:00'] } },
      ],
    },
    { id: 'floor_up', name: 'Upper floor', level: 1, rooms: [{ id: 'room_office', name: 'Office', points: [[0, 0], [520, 0], [520, 420], [0, 420]], lights: ['light.office'] }], openings: [], devices: [], furniture: [{ id: 'desk', kind: 'desk', x: 260, y: 60, w: 160, h: 70 }] },
  ],
};
