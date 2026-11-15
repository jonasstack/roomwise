/** Car models: real outer dimensions (cm) and body class for the 3D model */
export interface CarShape {
  de: string;
  en: string;
  L: number;
  W: number;
  H: number;
  body: 'micro' | 'hatch' | 'sedan' | 'estate' | 'suv' | 'coupe' | 'van' | 'box' | 'onebow';
  /** Mercedes star / EQ light band */
  star?: boolean;
  band?: boolean;
  ev?: boolean;
}

export const CARS: Record<string, CarShape> = {
  smart_fortwo: { de: 'smart fortwo EQ', en: 'smart fortwo EQ', L: 270, W: 166, H: 155, body: 'micro', ev: true },
  smart_1: { de: 'smart #1', en: 'smart #1', L: 427, W: 182, H: 164, body: 'suv', band: true, ev: true },
  smart_3: { de: 'smart #3', en: 'smart #3', L: 440, W: 184, H: 156, body: 'coupe', band: true, ev: true },
  smart_5: { de: 'smart #5', en: 'smart #5', L: 470, W: 192, H: 170, body: 'box', band: true, ev: true },
  merc_a: { de: 'Mercedes A-Klasse', en: 'Mercedes A-Class', L: 442, W: 180, H: 144, body: 'hatch', star: true },
  merc_c: { de: 'Mercedes C-Klasse', en: 'Mercedes C-Class', L: 475, W: 182, H: 144, body: 'sedan', star: true },
  merc_c_t: { de: 'Mercedes C-Klasse T-Modell', en: 'Mercedes C-Class Estate', L: 476, W: 182, H: 145, body: 'estate', star: true },
  merc_e: { de: 'Mercedes E-Klasse', en: 'Mercedes E-Class', L: 495, W: 188, H: 147, body: 'sedan', star: true },
  merc_glc: { de: 'Mercedes GLC', en: 'Mercedes GLC', L: 472, W: 189, H: 164, body: 'suv', star: true },
  merc_g: { de: 'Mercedes G-Klasse', en: 'Mercedes G-Class', L: 482, W: 193, H: 197, body: 'box', star: true },
  merc_eqa: { de: 'Mercedes EQA', en: 'Mercedes EQA', L: 446, W: 183, H: 162, body: 'suv', star: true, band: true, ev: true },
  merc_eqb: { de: 'Mercedes EQB', en: 'Mercedes EQB', L: 468, W: 183, H: 167, body: 'box', star: true, band: true, ev: true },
  merc_cla: { de: 'Mercedes CLA (elektrisch)', en: 'Mercedes CLA (electric)', L: 472, W: 186, H: 147, body: 'coupe', star: true, band: true, ev: true },
  merc_eqe: { de: 'Mercedes EQE', en: 'Mercedes EQE', L: 495, W: 191, H: 151, body: 'onebow', star: true, band: true, ev: true },
  merc_eqs: { de: 'Mercedes EQS', en: 'Mercedes EQS', L: 522, W: 193, H: 151, body: 'onebow', star: true, band: true, ev: true },
  merc_eqs_suv: { de: 'Mercedes EQS SUV', en: 'Mercedes EQS SUV', L: 513, W: 203, H: 172, body: 'suv', star: true, band: true, ev: true },
  merc_v: { de: 'Mercedes V-Klasse / EQV', en: 'Mercedes V-Class / EQV', L: 514, W: 193, H: 190, body: 'van', star: true },
  vw_id3: { de: 'VW ID.3', en: 'VW ID.3', L: 426, W: 181, H: 157, body: 'hatch', band: true, ev: true },
  vw_id4: { de: 'VW ID.4', en: 'VW ID.4', L: 458, W: 185, H: 164, body: 'suv', band: true, ev: true },
  tesla_3: { de: 'Tesla Model 3', en: 'Tesla Model 3', L: 472, W: 185, H: 144, body: 'coupe', ev: true },
  tesla_y: { de: 'Tesla Model Y', en: 'Tesla Model Y', L: 475, W: 192, H: 162, body: 'suv', ev: true },
  bmw_i4: { de: 'BMW i4', en: 'BMW i4', L: 478, W: 185, H: 145, body: 'coupe', ev: true },
  small: { de: 'Kleinwagen', en: 'Small car', L: 400, W: 175, H: 150, body: 'hatch' },
  compact: { de: 'Kompaktwagen', en: 'Compact car', L: 430, W: 180, H: 148, body: 'hatch' },
  estate: { de: 'Kombi', en: 'Estate', L: 470, W: 183, H: 150, body: 'estate' },
  suv: { de: 'SUV', en: 'SUV', L: 465, W: 188, H: 168, body: 'suv' },
  van: { de: 'Transporter / Bus', en: 'Van', L: 500, W: 195, H: 195, body: 'van' },
};


/** Side profile of a body class (fractions of length / height) — 3D model and side view */
export interface Profile {
  belt: number;
  hood: number;
  /** positions along the length, 0 = rear … 1 = front */
  cowl: number;
  roofF: number;
  roofR: number;
  deck: number;
  trunk: number;
  overF: number;
  overR: number;
}

export const PROFILES: Record<CarShape['body'], Profile> = {
  sedan: { belt: 0.57, hood: 0.5, cowl: 0.71, roofF: 0.58, roofR: 0.31, deck: 0.2, trunk: 0.56, overF: 0.2, overR: 0.22 },
  coupe: { belt: 0.56, hood: 0.47, cowl: 0.75, roofF: 0.6, roofR: 0.33, deck: 0.08, trunk: 0.55, overF: 0.2, overR: 0.21 },
  hatch: { belt: 0.56, hood: 0.52, cowl: 0.73, roofF: 0.6, roofR: 0.13, deck: 0.04, trunk: 0.56, overF: 0.19, overR: 0.18 },
  estate: { belt: 0.56, hood: 0.51, cowl: 0.72, roofF: 0.59, roofR: 0.07, deck: 0.025, trunk: 0.56, overF: 0.19, overR: 0.22 },
  suv: { belt: 0.6, hood: 0.6, cowl: 0.74, roofF: 0.63, roofR: 0.1, deck: 0.035, trunk: 0.6, overF: 0.19, overR: 0.19 },
  box: { belt: 0.6, hood: 0.63, cowl: 0.79, roofF: 0.72, roofR: 0.045, deck: 0.025, trunk: 0.6, overF: 0.17, overR: 0.17 },
  van: { belt: 0.52, hood: 0.5, cowl: 0.88, roofF: 0.83, roofR: 0.02, deck: 0.012, trunk: 0.52, overF: 0.16, overR: 0.16 },
  /** Mercedes EQ "one bow": cab-forward, one arch from the short bonnet over the roof to the short tail;
   *  high shoulder, shallow side windows (EQE V295: 4946 mm, wheelbase 3120, overhangs 896 / 930 mm) */
  onebow: { belt: 0.6, hood: 0.5, cowl: 0.735, roofF: 0.6, roofR: 0.32, deck: 0.075, trunk: 0.61, overF: 0.181, overR: 0.188 },
  micro: { belt: 0.52, hood: 0.5, cowl: 0.87, roofF: 0.73, roofR: 0.09, deck: 0.035, trunk: 0.52, overF: 0.11, overR: 0.09 },
};

