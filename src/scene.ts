import { ENKIANTHUS, type Canopy } from "./canopy";
import { POND_CAUSTICS, type Caustics } from "./caustics";
import { SUNLIT_CLOUDS, type Clouds } from "./clouds";
import { KRILL_SPECIES, OCEAN_SPECIES, POND_SPECIES, type Species } from "./species";
import type { SharkSpec } from "./world";

export type RGB = [number, number, number];

/** Everything that sets one tank apart from another; the sim and renderer are shared. */
export interface Scene {
  name: string;
  /** Spine creatures; size is relative to the biggest. */
  sharks: SharkSpec[];
  /** Schooling fish, one glyph each. */
  species: Species[];
  background: string;
  grid: string;
  /** Glow left where things swim. */
  wake: RGB;
  /** The water's own colour: deeper creatures fade toward it and lose contrast. */
  fog: RGB;
  /**
   * How far deeper creatures fade into the fog, as a fraction of the renderer's maximum. Dark
   * water swallows them; clear shallow water barely veils them, and fading koi toward a pale
   * fog at full strength only washes them out.
   */
  fogStrength: number;
  /**
   * Fill light thrown back up by a pale floor, 0–1. Over dark water an unlit flank is dark;
   * over pale stone the floor lights it from below and softens every shadow on the fish.
   */
  ambient: number;
  fish: RGB;
  /** Colours that shimmer across the creatures' skin. */
  accents: string[];
  /** Horizontal part of the light, as a unit vector in screen space; it shades the creatures. */
  light: [number, number];
  /** Scales the area-based fish count. */
  schoolDensity: number;
  /** What the spine creatures eat: schooling fish, or the pellets a click drops. */
  diet: "fish" | "food";
  /** A click either scatters the fish or drops food. */
  click: "scatter" | "feed";
  /** Raindrops per second. */
  rain: number;
  /**
   * A glowing wake that diffuses, a surface that carries ripples as waves, or a cloud sea, where
   * the same diffusing field shows no glow and only parts the clouds where a click lands.
   */
  water: "wake" | "ripple" | "cloud";
  /** Ripples bounce off the edges like a pond wall; without a shore they run out to open sea. */
  shore: boolean;
  /** Surface drift from the wind, px/s (gusting, its bearing wandering); 0 for still water. */
  wind: number;
  /** Pellet colour. */
  food: RGB;
  /** Each spine creature chases its own prey, or the pod rings a swarm in bubbles and lunges. */
  hunt: "chase" | "bubble-net";
  /** Keep the middle of the screen clear for a headline. */
  clearCenter: boolean;
  /**
   * Shadows cast on a pale floor seen through clear water, in this colour; null where the
   * floor is too dark or deep to show them.
   */
  floorShadow: RGB | null;
  /**
   * A tree between the sun and the water, its leaf shadows swaying over the pond in the
   * floorShadow colour; null where there is no sun to cast them.
   */
  canopy: Canopy | null;
  /**
   * Sun through a rippled surface: a net of light on the floor and glints on the water, from
   * the ripples themselves; null where there is no sun, or no floor to see it on.
   */
  caustics: Caustics | null;
  /**
   * A sea of cloud below the creatures: what flies lower than its tops is hidden in it, what
   * flies above casts a shadow on it. Null where there is open water instead.
   */
  clouds: Clouds | null;
  /** A light-mode palette, for scenes that have one: the same water by day, not inverted. */
  daylight?: Palette;
}

/** Everything a theme can recolour; the cast, the physics and the light direction stay put. */
export type Palette = Pick<
  Scene,
  | "background" | "grid" | "wake" | "fog" | "fogStrength" | "ambient" | "fish" | "accents" | "food" | "floorShadow" | "canopy" | "caustics" | "clouds"
>;

export type Theme = "dark" | "light";

/** The scene as seen in a theme; scenes without a daylight palette always stay dark. */
export function themed(scene: Scene, theme: Theme): Scene {
  return theme === "light" && scene.daylight ? { ...scene, ...scene.daylight } : scene;
}

// The landing hero: two classic sharks and two hammerheads at staggered depths, lit from the
// top-left. The cephalofoil gives the four a second silhouette, so they don't read as clones.
export const OCEAN: Scene = {
  name: "ocean",
  sharks: [
    { kind: "classic", size: 1 },
    { kind: "hammerhead", size: 0.88 },
    { kind: "classic", size: 0.78 },
    { kind: "hammerhead", size: 0.7 },
  ],
  species: OCEAN_SPECIES,
  background: "#000",
  grid: "rgba(255,255,255,0.055)",
  wake: [110, 230, 255],
  fog: [8, 20, 40],
  fogStrength: 1,
  ambient: 0,
  fish: [230, 238, 255],
  accents: ["#e0892c", "#e03a32", "#b44ae0", "#33c8cc", "#3cb54a", "#3150e8", "#d9c14a"],
  light: [-0.6, -0.8],
  schoolDensity: 1,
  diet: "fish",
  click: "scatter",
  rain: 0,
  water: "wake",
  shore: false,
  wind: 0,
  food: [220, 160, 90],
  hunt: "chase",
  clearCenter: true,
  floorShadow: null,
  canopy: null,
  caustics: null,
  clouds: null,
};

// Koi circling dark green water, a few ricefish, rain on the surface. A click drops food
// and the koi come for it; every pellet and raindrop rings out as a ripple.
export const KOI_POND: Scene = {
  name: "koi",
  sharks: [
    { kind: "koi", size: 0.95 },
    { kind: "koi", size: 0.86 },
    { kind: "koi", size: 0.79 },
    { kind: "koi", size: 0.73 },
    { kind: "koi", size: 0.68 },
  ],
  species: POND_SPECIES,
  background: "#020c09",
  grid: "rgba(150,255,210,0.045)",
  wake: [170, 232, 215],
  fog: [10, 36, 28],
  fogStrength: 1,
  ambient: 0,
  fish: [196, 218, 176],
  accents: ["#ffd27a", "#ffffff", "#ffb36b", "#fff1c9"],
  light: [-0.6, -0.8],
  schoolDensity: 0.12,
  diet: "food",
  click: "feed",
  rain: 1.6,
  water: "ripple",
  shore: true,
  // A breeze over the pond: gusts roughen the water in patches that sweep across it, rings
  // drift downwind into eggs, and floating food drifts with it. A light breeze drives a
  // surface drift of about a third of the ripples' own speed (155 px/s).
  wind: 50,
  food: [214, 150, 84],
  hunt: "chase",
  clearCenter: false,
  floorShadow: null,
  canopy: null,
  caustics: null,
  clouds: null,
  // By day: a clear, shallow pond over pale stone. The koi keep their light and shading; what
  // changes is what lies under them. The floor shows through, deeper koi fade toward the pale
  // water, ripples read darker than the floor, and every koi casts a soft shadow on the bottom,
  // the mark of a koi pond seen from above.
  daylight: {
    background: "#dfe3d6",
    grid: "rgba(40,70,55,0.07)",
    wake: [60, 120, 110],
    fog: [190, 206, 196],
    fogStrength: 0.35,
    ambient: 0.35,
    fish: [80, 96, 70],
    accents: ["#c9862b", "#ffffff", "#d9a441"],
    food: [140, 88, 38],
    // Soft and cool: light scattering in the water fills a shadow on a shallow floor.
    floorShadow: [70, 104, 92],
    // Sun through a dōdan-tsutsuji at the pond's edge: its leaf shadows sway over the water.
    canopy: ENKIANTHUS,
    // Sun through the rippled water: a net of light on the stone, glints on the surface.
    caustics: POND_CAUSTICS,
    clouds: null,
  },
};

// Humpbacks over open blue water. Krill gather into swarms; the pod circles the densest one,
// blowing a ring of bubbles that herds the krill inward, then lunges up through the middle.
export const WHALES: Scene = {
  name: "whales",
  sharks: [
    // One adult with two young, swimming deeper. The net has to span more than half the
    // adult's length for it to ring it, so it grows with her (see pod.radius0 in world.ts).
    { kind: "humpback", size: 1 },
    { kind: "humpback", size: 0.62 },
    { kind: "humpback", size: 0.56 },
  ],
  species: KRILL_SPECIES,
  background: "#02121c",
  grid: "rgba(120,200,255,0.05)",
  wake: [205, 236, 255],
  fog: [8, 44, 66],
  fogStrength: 1,
  ambient: 0,
  fish: [255, 150, 120],
  accents: ["#9fd8ff", "#ffffff", "#7fb3d5"],
  light: [-0.6, -0.8],
  schoolDensity: 1.2,
  diet: "fish",
  click: "scatter",
  rain: 0,
  water: "ripple",
  shore: false,
  wind: 0,
  food: [214, 150, 84],
  hunt: "bubble-net",
  clearCenter: false,
  floorShadow: null,
  canopy: null,
  caustics: null,
  clouds: null,
};

// A white dragon over a sea of cloud by day, the land far below hazed blue through the gaps. Its
// body rises and dips in a wave that stays put as it flies, so the body threads in and out of the
// cloud tops at the same places, the way a sea serpent rides through waves, and wherever it flies
// above them its shadow falls on the clouds. A click parts the clouds.
export const DRAGON: Scene = {
  name: "dragon",
  // Long: at 2.2 the legs and body together read as a lizard.
  sharks: [{ kind: "dragon", size: 3, depth: 1 }],
  species: [],
  background: "#6b97c9",
  grid: "rgba(255,255,255,0.07)",
  wake: [255, 255, 255],
  // Mist: the colour the body fades into where it skims the cloud tops.
  fog: [234, 241, 250],
  fogStrength: 1,
  // Sky and the sunlit cloud sea below fill the dragon's shaded flanks: it is a white dragon, and
  // at 0.4 it went grey. Its volume is carried by the ink and the modelled head, not by darkness.
  ambient: 0.6,
  fish: [255, 255, 255],
  // Glints on the scales; the jade belongs to the mane alone.
  accents: ["#ffffff", "#fff4d6", "#d8f3ff"],
  light: [-0.6, -0.8],
  schoolDensity: 0,
  diet: "fish",
  click: "scatter",
  rain: 0,
  water: "cloud",
  shore: false,
  // High wind carries the cloud sea slowly past.
  wind: 16,
  food: [214, 150, 84],
  hunt: "chase",
  clearCenter: false,
  floorShadow: null,
  canopy: null,
  caustics: null,
  clouds: SUNLIT_CLOUDS,
};

export const SCENES: Scene[] = [KOI_POND, OCEAN, WHALES, DRAGON];
