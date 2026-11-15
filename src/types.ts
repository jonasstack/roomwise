// ---------- Home Assistant (minimal surface we rely on) ----------

export interface HassEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, any>;
  last_changed: string;
  last_updated: string;
  context?: { id: string };
}

export interface HassEntityRegistryDisplayEntry {
  entity_id: string;
  name?: string;
  icon?: string;
  device_id?: string;
  area_id?: string;
  hidden?: boolean;
  entity_category?: 'config' | 'diagnostic';
  platform?: string;
  /** the integration's key for this entity (language independent, e.g. "mop_intensity") */
  translation_key?: string;
}

export interface HassDevice {
  id: string;
  name?: string;
  name_by_user?: string;
  area_id?: string | null;
}

export interface HassArea {
  area_id: string;
  name: string;
  floor_id?: string | null;
  icon?: string | null;
}

export interface HassFloor {
  floor_id: string;
  name: string;
  level?: number | null;
}

export interface HassUser {
  id: string;
  name: string;
  is_admin: boolean;
}

export interface HomeAssistant {
  states: Record<string, HassEntity>;
  entities: Record<string, HassEntityRegistryDisplayEntry>;
  devices: Record<string, HassDevice>;
  areas: Record<string, HassArea>;
  floors?: Record<string, HassFloor>;
  user?: HassUser;
  language: string;
  locale?: { language: string; number_format?: string };
  themes?: { darkMode?: boolean };
  connection: {
    subscribeMessage<T>(cb: (msg: T) => void, msg: Record<string, unknown>): Promise<() => void>;
  };
  callService(
    domain: string,
    service: string,
    data?: Record<string, unknown>,
    target?: Record<string, unknown>,
  ): Promise<unknown>;
  callWS<T>(msg: Record<string, unknown>): Promise<T>;
  services?: Record<string, Record<string, unknown>>;
  callApi<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, data?: Record<string, unknown>): Promise<T>;
  hassUrl(path?: string): string;
  formatEntityState?(entity: HassEntity, state?: string): string;
  formatEntityAttributeValue?(entity: HassEntity, attribute: string, value?: unknown): string;
}

// ---------- Card configuration ----------

export type Point = [number, number];

export type ActionType =
  | 'default'
  | 'toggle-lights'
  | 'toggle'
  | 'popup'
  | 'more-info'
  | 'perform-action'
  | 'call-service'
  | 'navigate'
  | 'url'
  | 'zoom'
  | 'none';

export interface ActionConfig {
  action: ActionType;
  /** Entity to act on; defaults to the device entity (or the room's lights). */
  entity?: string;
  /** perform-action / call-service */
  perform_action?: string;
  service?: string;
  data?: Record<string, unknown>;
  service_data?: Record<string, unknown>;
  target?: Record<string, unknown>;
  /** navigate */
  navigation_path?: string;
  /** url */
  url_path?: string;
  new_tab?: boolean;
  /** Ask before running. true or { text } */
  confirmation?: boolean | { text?: string };
}

export interface ActionSet {
  tap_action?: ActionConfig;
  double_tap_action?: ActionConfig;
  hold_action?: ActionConfig;
}

/**
 * One command of a media device: a script (run via `script.turn_on`, optionally with variables) or any other
 * action. Meant for devices only reachable by infrared / RF, whose remote codes live in Home Assistant scripts.
 */
export interface MediaCommand {
  /** script.* entity */
  script?: string;
  /** Variables handed to the script */
  variables?: Record<string, unknown>;
  /** Any other action instead of a script (perform-action, toggle …) */
  action?: ActionConfig;
}

export interface MediaInputConfig extends MediaCommand {
  name: string;
}

export interface MediaButtonConfig extends MediaCommand {
  name: string;
  icon?: string;
}

/**
 * Own controls of a media device. A slot set here wins over what the media_player itself can do;
 * a slot left empty falls back to the entity (when it supports it). Works without any entity, too.
 */
export interface MediaControlsConfig {
  /** Power toggle (one IR code for on and off) */
  power?: MediaCommand;
  power_on?: MediaCommand;
  power_off?: MediaCommand;
  volume_up?: MediaCommand;
  volume_down?: MediaCommand;
  mute?: MediaCommand;
  play_pause?: MediaCommand;
  next?: MediaCommand;
  previous?: MediaCommand;
  /** Inputs / sources, each with its own command */
  sources?: MediaInputConfig[];
  /** Further buttons (menu, OK, a favourite channel …) */
  buttons?: MediaButtonConfig[];
}

/** What a popup is opened for */
export interface PopupTarget {
  entity?: string;
  room?: RoomConfig;
  car?: FurnitureConfig;
  /** Furniture holding several devices (cabinet, shelf …): the overview of what is inside */
  piece?: FurnitureConfig;
  /** Media device: own buttons (with or without entity) */
  media?: MediaControlsConfig;
  /** Name / icon shown when there is no entity */
  name?: string;
  icon?: string;
  /** The piece / device the popup belongs to */
  item?: string;
  /** Router / access point: the Wi-Fi QR codes (networks from the companion, the router's guest Wi-Fi) */
  wifi?: FurnitureConfig;
  /** Washer, dryer, dishwasher: time left, "done" with "Gesehen" (appliance.ts) */
  appliance?: FurnitureConfig;
}

/**
 * Something inside a piece of furniture (cabinet, shelf, sideboard …): a device (`entity`) or, without any entity,
 * the Wi-Fi QR codes (`kind: 'wifi'`, e.g. a router Home Assistant does not know); own name and icon optional
 */
export interface FurnitureContentConfig {
  entity?: string;
  kind?: 'wifi';
  name?: string;
  icon?: string;
}

export interface RoomValueConfig {
  entity: string;
  icon?: string;
  name?: string;
}

/**
 * An entity the owner added by hand (or re-categorised): its role / group, an own name and icon.
 * Car: role = a role key (`sunroof`, `trunk` …) or a group of the overview (`climate`, `charge`, `access`, `status`).
 */
export interface ManualEntityConfig {
  entity: string;
  role?: string;
  icon?: string;
  name?: string;
}

export type FloorType = 'none' | 'color' | 'planks' | 'herringbone' | 'tiles' | 'hex' | 'checker' | 'carpet' | 'cork' | 'concrete' | 'grass' | 'paving' | 'gravel' | 'decking' | 'soil' | 'water';

export interface FloorMaterial {
  type: FloorType;
  /** Base color (wood tone, tile color, ...) */
  color?: string;
  /** Tile size in plan units (cm) */
  size?: number;
  /** Pattern rotation in degrees */
  angle?: number;
}

export interface RoomConfig extends ActionSet {
  id: string;
  name?: string;
  /** Outdoor area (garden, terrace, driveway): no walls, ground at the outside level */
  outdoor?: boolean;
  /**
   * Special kind of area: 'garage' (walls, concrete floor, garage door in a wall — also as a detached building
   * on the plot), 'plot' (the property line: an outdoor area drawn as a dashed boundary below everything else)
   */
  kind?: 'garage' | 'plot';
  area?: string;
  points: Point[];
  lights?: string[];
  temperature?: string;
  humidity?: string;
  climate?: string;
  /** Additional values shown in the room label (humidity, windows, ...). */
  sensors?: RoomValueConfig[];
  /** Entities of the room's HA area the suggestions leave out (the owner removed or excluded them) */
  exclude?: string[];
  /** Floor material (parquet, tiles, ...) */
  floor?: FloorMaterial;
  /** Paint of the walls facing into this room */
  wall_color?: string;
  /** View rotation used when zooming onto this room (the side you look from: 0 bottom, 90 right, 180 top, 270 left) */
  view_angle?: number;
  /** Override of the label anchor (otherwise: pole of inaccessibility). */
  label?: Point;
  hide_label?: boolean;
  /**
   * Engraved value (label style "wall"): where it goes per view direction (key: map rotation 0/90/180/270).
   * wall = edge of the room outline (from point i to i+1), t = position along it (0–1); 'floor'; 'hide'.
   * Missing: chosen automatically (a free, visible spot).
   */
  label_spots?: Record<string, LabelSpot>;
}

export interface DeviceConfig extends ActionSet {
  id: string;
  entity: string;
  x: number;
  y: number;
  name?: string;
  icon?: string;
  show_name?: boolean;
  show_state?: boolean;
  /** 'value': only the state as a quiet number (e.g. an outdoor temperature), no marker */
  display?: 'marker' | 'value';
  /** Own media buttons (scripts for infrared devices …) */
  media?: MediaControlsConfig;
}

/** passage: no wall there at all – an open way between two rooms ("Wand weg") */
export type OpeningType = 'door' | 'window' | 'garage' | 'passage';

/** How a garage door opens: sectional (panels slide up under the ceiling), up-and-over (one tilting panel), roller */
export type GarageVariant = 'sectional' | 'up_over' | 'roller';

/** A wall standing on its own (not a room's edge): drawn with "Wand ziehen", one record per straight piece */
export interface FreeWallConfig {
  id: string;
  a: Point;
  b: Point;
  /** cm, default: the plan's wall thickness */
  thickness?: number;
  /** cm above the floor; none = full height (cut like every other wall in 3D) */
  height?: number;
  /** paint (see paint()) */
  color?: string;
}

export interface OpeningConfig extends ActionSet {
  id: string;
  type: OpeningType;
  /** Endpoints on a wall */
  a: Point;
  b: Point;
  /** Contact sensor (binary_sensor) that reports open/closed; garage door: its cover (or a contact sensor) */
  entity?: string;
  /** Garage door: how it opens (default sectional) */
  variant?: GarageVariant;
  /** Hinge at b instead of a */
  hinge_b?: boolean;
  /** Door/sash swings to the other side of the wall */
  flip?: boolean;
  name?: string;
}

export interface FurnitureConfig extends ActionSet {
  id: string;
  kind: string;
  /** Linked entity (lamp, heater, fan, ...): shows its live state and makes the piece tappable */
  entity?: string;
  x: number;
  y: number;
  /** Width and depth in plan units (cm) */
  w: number;
  h: number;
  /** Degrees, clockwise */
  rotation?: number;
  /** Style variant (e.g. sofa: 2, 3, l) */
  variant?: string;
  /** Count (seats, chairs, doors, drawers, modules) */
  count?: number;
  /** Main color (hex) */
  color?: string;
  /** Accent color (cushions, bedding, top, ...) */
  accent?: string;
  /** Height in cm (3D) */
  height?: number;
  /** Height above the floor in cm (wall cabinets, hood, ...); small appliances sit on counters automatically */
  elevation?: number;
  /** Mirror horizontally (L-shapes, hinges) */
  flip?: boolean;
  name?: string;
  /** Dog / cat: look, walk times (entity = presence: home / out) */
  pet?: PetConfig;
  /** Robot vacuum driving live through the plan (companion integration) */
  vacuum?: VacuumLive;
  /** Further linked entities by role (car: battery, range, charging, location, address; storage: soc, power; …) */
  entities?: Record<string, string>;
  /** Show the main value(s) as a small chip above the piece (battery %, power, …) */
  show_value?: boolean;
  /** Car: battery level (%) at or below which it shows as empty (default 15) */
  low?: number;
  /** Washer, dryer, dishwasher (appliance.ts): plug fallback thresholds and how long "done" stays (hours, 0 = until seen) */
  appliance?: { run_w?: number; idle_w?: number; off_min?: number; hold?: number };
  /** Home battery: power sensor reports discharging as positive */
  invert_power?: boolean;
  /** Stairs: the floor (id) their chip leads to; default: the floor above, on the top floor the one below */
  stairs_to?: string;
  /** Car: entities of its device the detection must not use */
  exclude?: string[];
  /** Car: entities added by hand, each with a role or group, an own name and icon */
  extra?: ManualEntityConfig[];
  /** Media piece (TV, speaker …): own buttons; also without an entity (a pure infrared device) */
  media?: MediaControlsConfig;
  /** Devices inside the piece (cabinet, shelf …): a tap lists them first, each opens its own popup */
  contents?: FurnitureContentConfig[];
}

/** Robot map (mm) → plan (cm): offset, rotation (deg), scale (cm per mm, 0.1 = real), mirror */
export interface VacuumTransform {
  x: number;
  y: number;
  rot?: number;
  scale?: number;
  /** vertical scale on the plan when the plan is drawn a little out of proportion (default: same as scale) */
  scaleY?: number;
  mirror?: boolean;
}

/** A room of the vacuum's map placed by hand on top of the whole map's alignment (plan cm, degrees, factors),
 * about the room's middle `c` (robot mm) */
export interface VacuumRoomFit {
  c: [number, number];
  x?: number;
  y?: number;
  rot?: number;
  scale?: number;
  scaleY?: number;
}

export interface VacuumLive {
  transform?: VacuumTransform;
  /** rooms of the vacuum's map (by its room id) moved / turned / stretched on their own */
  rooms?: Record<string, VacuumRoomFit>;
  /** areas cut out of the vacuum's map (robot mm polygons): reflections, phantom rooms */
  crop?: [number, number][][];
  /** delayed (default): ~2.5 s behind, never guessing; live: as it happens, guessing in between */
  mode?: 'delayed' | 'live';
  /** seconds behind in delayed mode */
  delay?: number;
  /** map entity (camera / image) picked by hand; without it the companion finds the vacuum's map by itself */
  map_entity?: string;
}

export type LabelSpot = { wall: number; t?: number } | 'floor' | 'hide';

export interface WalkReminder {
  /** minutes after the walk time for the first reminder */
  after?: number;
  /** repeat every … minutes while still due (0 = once) */
  repeat?: number;
  /** at most … reminders */
  count?: number;
  /** title of the notification (default: the dog's name) */
  title?: string;
  /** text (default: "<name> muss raus!") */
  text?: string;
  /** append the walk time ("(Gassi um 18:30)"), default on */
  show_time?: boolean;
  /** "Done" button in the notification, default on */
  done_button?: boolean;
  /** important: shown also in Focus / Do not disturb (where the phone allows it) */
  important?: boolean;
  /** phone notifications */
  notify?: {
    targets: { service: string; person?: string }[];
    /** only people inside this zone; nobody inside → everyone (fallback 'all') or nobody */
    zone?: string;
    fallback?: 'all' | 'none';
  };
  /** announcement on a speaker */
  speak?: { tts_entity?: string; media_player?: string; language?: string };
}

/** A painted stroke on the dog's coat: a capsule from p to q (or a dot at p), radius r, colour c */
export interface PetPaint {
  p: [number, number, number];
  q?: [number, number, number];
  r: number;
  c: string;
}

export interface PetConfig {
  /** Walk times "HH:MM" (dog) */
  walks?: string[];
  /** (no longer used: a due walk stays until it is done) */
  walk_window?: number;
  markings?: 'none' | 'belly' | 'socks' | 'mask' | 'patches';
  ears?: 'floppy' | 'pointy' | 'small';
  tail?: 'long' | 'curled' | 'short' | 'fluffy';
  /** Collar & leash colour ('none': no collar) */
  collar?: string;
  /** Tag on the collar ('none': without) */
  tag?: string;
  /** Harness colour (absent: no harness) */
  harness?: string;
  /** Neckerchief colour (absent: none) */
  bandana?: string;
  /** Eye colour */
  eyes?: string;
  /** Layout of the patches (another seed = other patches) */
  seed?: number;
  /** Painted on the coat in the 3D editor (bind-pose model space of the dog) */
  paint?: PetPaint[];
  /** Dog on the plan with a smoother body (more triangles); default: lighter */
  detail?: boolean;
  /** Dog figure: 'realistic' (default) = the animated skinned model, 'simple' = the light code-drawn figure */
  figure?: 'simple' | 'realistic';
  /** Reminders when a walk is due (run by the companion integration) */
  remind?: WalkReminder;
  pose?: 'lying' | 'standing' | 'sitting' | 'curled';
}

export interface FloorConfig {
  id: string;
  name: string;
  /** Link to a Home Assistant floor: suggests name, level and the rooms (areas of that floor) */
  floor?: string;
  /** Storey: higher is further up (0 ground floor, -1 basement). Default: the HA floor's level, else the position in the list */
  level?: number;
  /** Short label for the compact floor slider ("EG", "OG"); default: derived from the name */
  short?: string;
  /** Ceiling height in cm (3D room view, editor with full walls); default 250 */
  height?: number;
  /** false: room corners and walls do not snap to the grid in the editor (a floor made from a robot vacuum's map –
   * its walls are not on a grid); they line up with what is already drawn instead. Default: on */
  grid_snap?: boolean;
  rooms: RoomConfig[];
  devices: DeviceConfig[];
  /** Walls standing on their own, not a room's edge: a partition, a half-height wall, a room divider ("Wand ziehen") */
  walls?: FreeWallConfig[];
  openings?: OpeningConfig[];
  furniture?: FurnitureConfig[];
  /** A picture of the floor plan (photo, scan) under the plan in the editor, to draw the rooms on */
  trace?: TraceImage;
}

/** Trace image of a floor: placed in plan units (cm), turned about its middle */
export interface TraceImage {
  /** Stored in the companion integration (id) … */
  image?: string;
  /** … or, without it, a small image right here (data URL) */
  src?: string;
  /** Top left corner and width in cm (the height follows the picture's aspect ratio) */
  x: number;
  y: number;
  w: number;
  /** aspect ratio height / width of the picture */
  ratio: number;
  /** degrees, clockwise, about the middle */
  rotation?: number;
  /** 0.05 … 1, default 0.5 */
  opacity?: number;
  /** Also show it on the card (2D), not only in the editor */
  show?: boolean;
}

export type WeatherQuality = 'smooth' | 'saver';
export type PerfProfile = 'high' | 'eco';

export type EntryAlertMode = 'none' | 'general' | 'all' | 'sequential';

/** Front door warning: when the front door opens while windows are open */
export interface EntryAlertConfig {
  /** Opening id of the front door (a door with a contact sensor) */
  door?: string;
  /** Open windows pulse red (with markers) */
  blink?: boolean;
  /** Entity whose change acknowledges the warning (button, input_button, event, binary_sensor, ...) */
  ack_entity?: string;
  /** Seconds until the announcement when nobody acknowledged */
  timeout?: number;
  /** Announcement */
  mode?: EntryAlertMode;
  tts_entity?: string;
  media_player?: string;
  /** TTS language (e.g. "de", "de-DE"); default: Home Assistant's language matched to the engine */
  tts_language?: string;
  /** Texts; {fenster} = window name(s), {anzahl} = count */
  text_general?: string;
  text_all?: string;
  text_single?: string;
  /** Checking order for "one after another" (window opening ids) */
  order?: string[];
  /** Only these HA users' devices speak / flash lights (empty: every device showing the card) */
  announce_users?: string[];
  /** Lights that flash red 3× at 100 % when the alarm starts, then return to their previous state */
  flash_lights?: string[];
  /** Runs on the server (companion integration), also without any tablet — on by default; false = only on the devices */
  server?: boolean;
  /** Windows (opening ids) the warning leaves out */
  exclude?: string[];
}

export interface FloorplanCardConfig {
  type: string;
  /** Stable id used to find this card in the dashboard when the editor saves. */
  card_id?: string;
  /** A shared floor plan (companion integration) by id: floors and the plan's own settings (SHARED_PLAN_KEYS) come
   *  from there instead of this config, the same on every dashboard that shows it. */
  plan?: string;
  title?: string;
  /** CSS height, e.g. "600px", "calc(100vh - 56px)". Default: derived from the plan aspect ratio. */
  height?: string;
  /** Grid size in cm for the editor (drawing / snapping only). */
  grid?: number;
  /** Wall thickness in cm (plan units). Default 8. */
  wall_width?: number;
  /** Show the edit pencil (admins only). Default true. */
  editable?: boolean;
  /** Theme override: auto (follow HA), light, dark */
  theme?: 'auto' | 'light' | 'dark';
  /** Direction of north on the plan in degrees (0 = up, 90 = right). */
  north?: number;
  /** auto (default): starts in 3D (2D on weak devices), the card's 2D/3D button switches per device; 2d / 3d: fixed, no button. Editor: "3D, switchable" / "2D only". */
  view_mode?: 'auto' | '2d' | '3d';
  /** "Wer ist wo" in the card's head (off unless true): persons, with Hausregeln' status lines when installed */
  people?: boolean;
  /** Default view rotation in degrees (clockwise). */
  orientation?: number;
  /** Per HA user defaults (key: user id). */
  users?: Record<string, { name?: string; orientation?: number; view_mode?: 'auto' | '2d' | '3d'; weather?: WeatherQuality; performance?: PerfProfile; floor?: string }>;
  /** Floor (id) the card starts on and returns to after the idle time (per user: `users[id].floor`); default: the first floor */
  default_floor?: string;
  /** Something worth telling on another floor (a washer done, a leak …): that floor faintly below the shown one, with
   * a label at the spot ("Etagen-Blick"). Default on; false switches it off. */
  floor_peek?: boolean;
  /** Several floors: the wheel / a two-finger swipe up or down moves the floor focus; zoom with Ctrl/⌘ + wheel or
   * pinching (default on; false = the wheel zooms as with one floor) */
  scroll_floors?: boolean;
  /** Upper floors: the floor below shows as a faint outline for context (2D and 3D); default on, false = off */
  floor_below?: boolean;
  /** 3D quality: 'high' (full) or 'eco' (lower resolution, simple shadows, no looping animations); per user in `users`.
   * Editor: "Effekte & Leistung" sets effects / performance / weather_quality together (full / eco / off). */
  performance?: PerfProfile;
  /** Show the performance overlay (fps, frame time, resolution, graphics chip) on every device. Per device: hold the compass 2 s. YAML only. */
  stats?: boolean;
  /** Weather rendering: 'smooth' (fluid, richer — default) or 'saver' (stepped, for weak devices); per user in `users` */
  weather_quality?: WeatherQuality;
  /** Seconds without touch after which rotation/zoom return to the start view (0 = never). Default 120. */
  idle_reset?: number;
  /** Room labels: outside next to the room where possible (auto, default) or always inside. */
  labels?: 'auto' | 'inside';
  /** Room values as floating labels ('badge') or engraved into a free wall of the room in 3D ('wall') */
  label_style?: 'badge' | 'wall';
  /** Hausregeln (if installed): room occupancy tint, house mode switch, alarm shield, a red ring at the cause of an alarm (pulse) */
  house_rules?: { occupancy?: boolean; mode?: boolean; alarm?: boolean; pulse?: boolean }; // occupancy: off unless true
  /** Tapping a room label: 'heating' opens the room's thermostat (room → climate), 'room' acts like tapping the room */
  label_tap?: 'room' | 'heating';
  /** Fade the room labels out while the view is moved (swipe, zoom, rotate) */
  hide_labels_on_move?: boolean;
  /** Room view: show the room's label at the top, clear of the room (false: stays in the scene) */
  focus_badge?: boolean;
  /** Paint of exterior walls and wall tops (3D) / walls (2D). */
  wall_color?: string;
  /** Wall height in cm for the 3D view (cut-away walls). Default 90. */
  wall_height?: number;
  /** Front door warning about open windows */
  entry_alert?: EntryAlertConfig;
  /** 3D renderer: 'auto' (WebGL when available, default), 'webgl' or 'css'. YAML only (troubleshooting). */
  renderer?: 'auto' | 'webgl' | 'css';
  /** Height in cm of the rearmost walls in 3D (exterior walls with nothing behind them from the current view). Default 170. */
  back_wall_height?: number;
  /** Weather entity for the ambient effects (default: first weather.* entity). */
  weather?: string;
  /** Sun entity (default sun.sun). YAML only. */
  sun?: string;
  /** Ambient effects (sun, weather): auto (default) respects reduced motion and weak hardware; on forces them; off. */
  effects?: 'auto' | 'on' | 'off';
  floors: FloorConfig[];
}

// ---------- Runtime ----------

export type HitKind = 'room' | 'device' | 'opening' | 'furniture' | 'label' | 'background';

export interface HitTarget {
  kind: HitKind;
  id?: string;
  /** a chip "↑ Obergeschoss" at stairs: the floor (id) it leads to */
  to?: string;
}

export interface ViewTransform {
  s: number;
  tx: number;
  ty: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Opening the editor with a suggested plan (first steps: from Home Assistant's areas, the example) */
export interface EditorStart {
  /** a suggested plan for the draft */
  config?: FloorplanCardConfig;
  /** shown once as a toast */
  hint?: string;
  /** open the settings at "Use on several dashboards" (pick a shared plan) */
  share?: boolean;
  /** a house with several floors: ask "Wo ist die Treppe?" (stairs-tool.ts) — never guessed */
  askStairs?: boolean;
}
