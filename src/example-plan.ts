import type { FloorplanCardConfig, FurnitureConfig, OpeningConfig, RoomConfig } from './types';
import { t } from './i18n';

/**
 * A neutral demo flat for "load an example" in the card's first steps: five rooms and a hallway with doors,
 * windows and furniture, linked to no device. Units: 1 = 1 cm. Names follow the card's language.
 */
export function examplePlan(): FloorplanCardConfig {
  const rect = (id: string, name: string, x0: number, y0: number, x1: number, y1: number, floor: RoomConfig['floor']): RoomConfig => ({
    id,
    name,
    points: [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ],
    floor,
  });
  const rooms: RoomConfig[] = [
    rect('ex_living', t('example.living'), 0, 0, 500, 420, { type: 'herringbone', color: '#c99a62' }),
    rect('ex_kitchen', t('example.kitchen'), 500, 0, 860, 240, { type: 'tiles', size: 30 }),
    rect('ex_bath', t('example.bath'), 500, 240, 860, 420, { type: 'tiles', size: 20 }),
    rect('ex_hall', t('example.hall'), 0, 420, 860, 560, { type: 'tiles', size: 40 }),
    rect('ex_bedroom', t('example.bedroom'), 0, 560, 480, 900, { type: 'planks' }),
    rect('ex_office', t('example.office'), 480, 560, 860, 900, { type: 'planks' }),
  ];
  const o = (id: string, type: 'door' | 'window', a: [number, number], b: [number, number], extra: Partial<OpeningConfig> = {}): OpeningConfig => ({ id, type, a, b, ...extra });
  const openings: OpeningConfig[] = [
    o('ex_front_door', 'door', [860, 450], [860, 540], { name: t('example.front_door') }),
    o('ex_door_living', 'door', [180, 420], [270, 420]),
    o('ex_door_kitchen', 'door', [500, 80], [500, 170], { hinge_b: true }),
    o('ex_door_bath', 'door', [600, 420], [680, 420], { hinge_b: true }),
    o('ex_door_bedroom', 'door', [300, 560], [390, 560]),
    o('ex_door_office', 'door', [620, 560], [710, 560], { hinge_b: true }),
    o('ex_win_living', 'window', [120, 0], [380, 0]),
    o('ex_win_kitchen', 'window', [600, 0], [780, 0]),
    o('ex_win_bath', 'window', [860, 290], [860, 370]),
    o('ex_win_bedroom', 'window', [100, 900], [340, 900]),
    o('ex_win_office', 'window', [560, 900], [760, 900]),
  ];
  const f = (id: string, kind: string, x: number, y: number, w: number, h: number, rotation = 0): FurnitureConfig => ({ id, kind, x, y, w, h, ...(rotation ? { rotation } : {}) });
  const furniture: FurnitureConfig[] = [
    f('ex_sofa', 'sofa', 250, 360, 220, 95),
    f('ex_rug', 'rug', 250, 220, 200, 140),
    f('ex_coffee', 'coffee_table', 250, 230, 110, 60),
    f('ex_tv_stand', 'tv_stand', 250, 26, 180, 42, 180),
    f('ex_plant', 'plant', 40, 40, 50, 50),
    f('ex_lamp', 'floor_lamp', 460, 380, 40, 40),
    f('ex_counter', 'counter', 690, 31, 300, 62, 180),
    f('ex_table', 'dining_table', 690, 170, 140, 80),
    f('ex_tub', 'bathtub', 770, 380, 170, 75),
    f('ex_toilet', 'toilet', 530, 290, 38, 60, 90),
    f('ex_basin', 'washbasin', 640, 268, 60, 46, 180),
    f('ex_bed', 'bed', 240, 795, 180, 205, 180),
    f('ex_nightstand', 'nightstand', 120, 875, 45, 40, 180),
    f('ex_wardrobe', 'wardrobe', 31, 700, 200, 60, 90),
    f('ex_desk', 'desk', 670, 862, 140, 70, 180),
    f('ex_chair', 'office_chair', 670, 800, 60, 60),
  ];
  return {
    type: 'custom:floorplan-card',
    floors: [{ id: 'floor_example', name: t('card.default_floor'), rooms, devices: [], openings, furniture }],
  };
}
