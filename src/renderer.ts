/**
 * Draws the World as a grid of ASCII cells:
 *   1. a pure black cell grid
 *   2. a wake field that diffuses where things swim, lighting the dots cyan
 *   3. fish as minimal ASCII dashes, one per cell, glinting on hard turns
 *   4. sharks rasterised cell-by-cell with supersampled edges: grey blocks
 *      shaded by the light, dense glyphs, and shimmering accent colours
 */
import { CanopyField } from "./canopy";
import { CausticsField } from "./caustics";
import { CloudField } from "./clouds";
import { clamp, hash3, smoothstep, valueNoise, windAt } from "./math";
import { RippleField } from "./ripple";
import { MeadowRenderer } from "./meadow";
import type { RGB, Scene } from "./scene";
import { BUBBLE_LIFE, BUBBLE_RISE, SHARK_NODES, SLITHER_K, type Shark, type SharkKind, type World } from "./world";

const ALPHA_LEVELS = 6;
const FISH_ALPHAS = [0.28, 0.42, 0.58, 0.74, 0.9];
const BUBBLE_ALPHAS = [0.15, 0.3, 0.5, 0.7, 0.9];
/** Floor-shadow strength steps, each one fillStyle. */
const FLOOR_LEVELS = [0.25, 0.5, 0.75, 1];

// Depth through water: deeper creatures fade toward the scene's fog colour and their glyphs
// lose contrast, up to FOG_MAX; a creature swimming above casts SHADOW on those beneath.
const FOG_RATE = 1.3;
const FOG_MAX = 0.6;
const SHADOW = 0.45;
/** How far a creature's shadow falls from it, as a fraction of its length, away from the light. */
const SHADOW_DROP = 0.08;
/**
 * Shadows on a visible pond floor: how far they fall from the body (fractions of L) for a
 * creature lying deepest (depth 0, near the floor) and nearest the surface (depth 1), and how
 * dark they are. The nearer the surface, the further off and fainter the shadow.
 */
const FLOOR_DROP_DEEP = 0.05;
const FLOOR_DROP_SHALLOW = 0.16;
const FLOOR_ALPHA = 0.15;
/**
 * Caustics in glyphs: beads of light along the net, with no way to them. Line glyphs laid along
 * it (`- \\ | /`) made every line ruler-straight; light lines swell and thin and bend. Above
 * CAUSTIC_SHOW of light beyond its share a cell shows; the bead fills out (`. : o`) and its ink
 * strengthens, in CAUSTIC_INKS steps, as the light grows toward CAUSTIC_FULL.
 */
// Under a full gust the light runs heavy-tailed: a tenth of the cells over 0.9 beyond their
// share, a twentieth over 1.6, one in a hundred over 4.2. About the brightest sixth show, the
// net's lines; beads and ink follow the light's logarithm, as the eye does.
const CAUSTIC_SHOW = 0.55;
const CAUSTIC_FULL = 5;
/**
 * A food pellet: a large solid dot, so it reads as a thing in the water, not a point of light
 * like a glint's `+` and `*`.
 */
const FOOD_GLYPH = "●";
/** A glint this strong or more is at its height: `*`, below it `+`. */
const GLINT_PEAK = 0.7;
/** The part of the gust field's range over which the chop, and its net of light, comes up. */
const CHOP_GUST: [number, number] = [0.3, 0.65];
const CAUSTIC_GLYPHS = ".:o";
const CAUSTIC_INKS = 8;
/** How much of the gust field's range shakes a canopy's branches. */
const CANOPY_GUST: [number, number] = [0.35, 0.8];
/**
 * The grain on a cloud's face, sparse on the lit ones and fuller in shade. Round, with no way to
 * them, like the beads of the caustics; from the brightest face to the dimmest.
 */
const CLOUD_GLYPHS = ".:oO@";
/** How many steps darker than its fill a cloud's glyph is inked. */
const CLOUD_INK = 3;
/** Steps of cloud brightness, each one fillStyle; the darkest is not drawn. */
const CLOUD_LEVELS = 12;
/** The faintest level a cloud is drawn at where it hides part of a creature. */
const CLOUD_VEIL = 4;
/** Cloud this thick (in the tops' 0–1) is solid; thinner wisps let the sky through. */
const CLOUD_BODY = 0.45;
/** How dark a flyer's shadow makes the sunlit tops it falls on. */
const CLOUD_SHADOW = 0.55;
/**
 * A flyer and the cloud, in the tops' 0–1 height. Above the top it is clear MIST_BAND up and fades
 * toward the scene's fog to MIST_TOP at the top. Below it, it is veiled further, to MIST_DEEP, as
 * it goes VEIL_DEPTH down, and hidden outright only once that deep in cloud at least VEIL_THICK
 * thick: diving in, a body thins into the cloud by degrees, and through thin cloud it still shows.
 */
const MIST_BAND = 0.22;
const MIST_TOP = 0.35;
const MIST_DEEP = 0.88;
const VEIL_DEPTH = 0.35;
const VEIL_THICK = 0.55;
/** A modelled head's height for its half-width, and the sun's elevation over it (radians). */
const HEAD_HEIGHT = 0.9;
const HEAD_SUN = 0.75;
/** How far a flyer's shadow falls on the clouds per unit of height above them, as a fraction of its length. */
const LIFT_SHADOW = 0.07;
/** A flyer looks this much wider per unit of height above the tops' middle: it is nearer the eye. */
const LIFT_SCALE = 0.2;

// Dot colour classes: blue, green, red, pale. The wake class after them takes the scene's colour.
const DOT_RGB: RGB[] = [
  [48, 52, 235],
  [52, 205, 60],
  [228, 50, 44],
  [190, 212, 255],
];
const DOT_BASE_ALPHA = [1, 1, 1, 1, 1];
const WAKE = DOT_RGB.length;

/**
 * Candidates for the measured ink ramp: marks and round shapes, from a dot to the densest blots
 * (`$` and `&` dropped: dense, but busy enough to read as noise across a face).
 * Left out are the glyphs that draw a line or a bracket (`- _ = ~ | / \ ( ) [ ] { } < >`), which
 * point a way and read as strokes rather than tone, and letters, which in a row read as words: a
 * body inked in `tvvvtnaSM` looked like garbled text. INK_STEPS of the candidates, evenly spaced
 * in measured ink, make the ramp.
 */
const INK_CANDIDATES = " .,:;'\"`^*+oO0@#%8";
const INK_STEPS = 16;
/**
 * How steeply a measured ramp's ink rises into the shade: ink = (1 − light) ^ INK_CURVE. And its
 * ink colour, as a share of the skin under it: the dense glyphs a measured ramp reaches for would
 * grey a white body at the koi's darker ink.
 */
const INK_CURVE = 2.2;
const MEASURED_INK = 0.72;

// Sparse glyphs on bright skin, dense glyphs in shadow, so the texture
// reinforces the shading instead of fighting it.
const SKIN_RAMP = ":;t%SX8#@";
const FIN_GLYPHS = "%;tS:";
const RIDGE_GLYPHS = "@8%";
const EDGE_HEAVY = ":;";
const EDGE_LIGHT = ".',`";


const FLAG_BODY = 1;
const FLAG_EDGE = 2;
const FLAG_FIN = 3;
const FLAG_RIDGE = 4;
const FLAG_EYE = 5;
/** Dark skin markings: tiger bars, zebra-shark spots. */
const FLAG_MARK = 6;
const MARK_GLYPHS = "#%@";
/** Koi red (hi) patches: lit skin in their own colour instead of the species tint. */
const FLAG_HI = 7;
const HI_TINT: RGB = [1.55, 0.5, 0.24];
/** Pale skin in the shape's own `pectoralTint`: humpback flippers, and throat pleats on a lunge. */
const FLAG_PALE = 8;
/**
 * A strand thinner than a cell, a dragon's barbel: a pale glyph with no block, so it reads as a
 * thread of light rather than a row of solid cells or scattered specks of edge.
 */
const FLAG_STRAND = 9;
/** A claw: pale like a horn, and like a strand too thin to cover a cell, so solid on a centre hit. */
const FLAG_CLAW = 10;
/**
 * The thick root of a barbel: white skin, solid on a centre hit like a claw, so the barbel reads
 * as a line of light leaving the muzzle and only thins to a thread (FLAG_STRAND) past
 * WHISKER_SOLID of its length. Drawn as strands all the way, it was too faint to hold the head.
 */
const FLAG_WHISKER = 11;
const WHISKER_SOLID = 0.55;
/**
 * A lock of the tail's hair: solid jade near its root, like a barbel's (FLAG_HAIR), then a jade
 * thread (FLAG_HAIR_END) past HAIR_SOLID of its length. The locks start TAIL_ROOT of the length
 * before the tip, so they grow out of the tail rather than off its end.
 */
const FLAG_HAIR = 12;
const FLAG_HAIR_END = 13;
const HAIR_SOLID = 0.8;
const TAIL_ROOT = 0.05;
/** Numbers per leg in a pose (see poseLegs), and how slowly the legs shift against the body wave's phase. */
const LEG_POSE = 7;
const LEG_RATE = 0.5;
const STRAND_GLYPHS = ".:+";
const KOI_VARIETIES = 4;

// Ripple water (simulated in ripple.ts): the crest height that starts to show, and how fast
// crests brighten above it.
const RIPPLE_SHOW = 0.08;
const RIPPLE_GAIN = 14;
/**
 * How hard a tail stroke pushes the surface, per frame at the peak of the beat, rising with
 * speed: STROKE · (1 + speed / STROKE_SPEED). Tuned by how many cells a wake lights
 * (tools/ripple-scale.ts): a gliding koi ~50, rushing ~160, against ~18 for one pellet, ~76
 * for a handful and ~145 for a raindrop.
 */
const RIPPLE_STROKE = 0.022;
const STROKE_SPEED = 150;
/** Amplitude of a raindrop's ringing; other drops scale it by their event strength. */
const DROP_AMP = 0.18;
/** A koi gulping food makes a small slurp of a ring. */
const GULP_AMP = 0.1;
/**
 * Cat's paws: gusts roughen the water in patches that sweep downwind. A gust field (value
 * noise GUST_PX across) travels at GUST_SPEED times the surface drift; where it is above
 * GUST_FLOOR, each frame lands a few tiny pokes, so wind reads as shifting rough patches on
 * otherwise glassy water, the way it does on a real pond. Tuned to light about 275 cells on
 * average across a 1280×800 pond: below ~70 the gusts vanish, above ~1000 they cover it.
 */
const GUST_PX = 240;
const GUST_SPEED = 2.5;
const GUST_FLOOR = 0.6;
const GUST_POKES = 60;
const GUST_AMP = 0.11;
// A drop doesn't just dent the water: it craters and rebounds a few times, so the impact
// point rings at DROP_HZ for three cycles and sends out a train of rings almost at once.
const DROP_HZ = 4;
const DROP_DECAY = 0.3;

/** Sparse glyphs and skin-coloured ink, so glossy skin (koi) reads smooth rather than grainy. */
const GLOSSY_RAMP = "':;+=*";
const GLOSSY_INK = 0.62;
/**
 * Koi fins are white membranes, thick and nearly opaque at the root and thinning to nothing at
 * the edge. Expressed in the two channels the rest of the picture uses: the block is a cool
 * white that lets through more of the water or floor behind it the thinner the fin gets
 * (GLOSSY_FIN_SEE at the root, GLOSSY_FIN_SEE_EDGE at the rim), and the glyphs thin out the
 * same way, so the fin dissolves into the water instead of ending in a hard outline. The cool
 * tint sets it apart from a warm floor by hue where brightness can't. Lit about as brightly as
 * the skin; a shark fin's 40 + 120 left koi fins grey on any water.
 */
const GLOSSY_FIN_LEVEL = 205;
const GLOSSY_FIN_SEE = 0.1;
const GLOSSY_FIN_SEE_EDGE = 0.65;
const GLOSSY_FIN_TINT: RGB = [1.18, 1.23, 1.28];
/** Fin glyphs by thickness, from the rim (none) to the root. */
const GLOSSY_FIN_RAMP = " .':;";
/** The level the floor's fill light lifts unlit skin toward, scaled by the palette's ambient. */
const FILL_LEVEL = 215;

/** Pectoral anhedral in radians; `pectoral[3]` is the reach seen from above at this droop. */
const PECTORAL_DROOP = 0.35;

// Sub-cell sample offsets for anti-aliased silhouettes.
const SUBSAMPLES = [0.25, 0.3, 0.75, 0.3, 0.25, 0.72, 0.75, 0.72];

/** Classic top-down half-width at s ∈ [0, 1] (snout → tail), as a fraction of length. */
function classicHalfWidth(s: number) {
  if (s < 0.13) return 0.09 * Math.pow(Math.sin(((s / 0.13) * Math.PI) / 2), 0.95);
  if (s < 0.3) return 0.09 + 0.016 * smoothstep(0.13, 0.3, s);
  if (s < 0.84) return 0.019 + 0.087 * Math.pow(1 - (s - 0.3) / 0.54, 1.25);
  const k = (s - 0.84) / 0.16;
  return 0.019 * (1 - k) + 0.012 * Math.sin(k * Math.PI);
}

/** Body outline and fin layout per species. All values are fractions of length. */
interface SharkShape {
  halfWidth: (s: number) => number;
  /** Pectoral fin: leading root, trailing root, tip position along the body, and reach. */
  pectoral: [number, number, number, number];
  /** Notched (falcate) trailing edge on the pectorals. */
  falcate: boolean;
  /**
   * Fan-shaped pectorals and pelvics, broad at the outer edge. The fin then pivots on the
   * spine at the first value and the other two mark its leading and trailing outer corners.
   */
  fanFins?: boolean;
  /** Pelvic fins: leading root, trailing root, tip, reach. */
  pelvic: [number, number, number, number];
  /** Forked caudal fin reach, or 0 when the tail is a ribbon (zebra shark). */
  caudal: number;
  /** Fan tail instead of a fork: where along the body it starts flaring out to `caudal`. */
  caudalFan?: number;
  /** Smooth skin: sparse glyphs inked in a darker shade of the skin. */
  glossy?: boolean;
  /**
   * How the pectoral and pelvic fins move and curve. They flap through `flap[0]` radians at
   * `flap[1]` times the tail-beat rate, with the tip trailing the root by up to `lag` more, so
   * a flapping fin bends like a paddle instead of swinging like a stick, and they arch back by
   * `arch` radians from root to tip even at rest. Sharks barely flutter; koi scull all the
   * time; a humpback sweeps its long, arched flippers slowly. A fin does not bend with the
   * trunk behind its root: tried, that folded the outer fin of a turn onto the flank.
   */
  finMotion?: { flap: [number, number]; lag: number; arch: number };
  /** Body wave: amplitude (fraction of L), how sharply it grows toward the tail, and wavenumber. */
  wave?: [number, number, number];
  /** Colour of pale skin: the white leading edge of a humpback's flippers and its throat pleats. */
  pectoralTint?: RGB;
  /**
   * Pectorals as long blades of nearly even width with a rounded tip (humpback flippers)
   * instead of triangles. The blade runs from the middle of the root to the tip; its chord
   * is the root's length.
   */
  flipper?: boolean;
  dorsal: [number, number];
  secondDorsal: [number, number];
  /**
   * Hammerheads' cephalofoil: half-span, how far its tips sweep back, its depth, and the
   * notch in the middle of the front edge. All fractions of length; absent for other sharks.
   */
  head?: { span: number; sweep: number; depth: number; notch: number };
  /** null when the eyes sit somewhere else (hammerhead: on the cephalofoil tips). */
  eye: [number, number] | null;
  gills: [number, number];
  /** Skin colour multipliers (r, g, b). */
  tint: [number, number, number];
  /** Colour of a glossy shape's fins, and of its FLAG_HI skin; koi white and koi red when absent. */
  finTint?: RGB;
  hiTint?: RGB;
  /** The eye's glyph colour. */
  eyeInk?: string;
  /**
   * Horns, one each side: a tapering blade from (u0, a0) to (u1, a1) along and out from the
   * spine, root thickness `width`. Fractions of length. Drawn pale, in pectoralTint.
   */
  horns?: { u0: number; a0: number; u1: number; a1: number; width: number };
  /**
   * Barbels trailing from the snout, one each side: root (u, a), how far back (`length`) and out
   * (`spread`) they run, and how far they wave. Fractions of length; a few px thick, so they
   * draw as a trail of light edge glyphs.
   */
  whiskers?: { u: number; a: number; length: number; spread: number; wave: number };
  /**
   * Fur down the back in the hi colour: a strip `strip` of the half-width wide from `from` along
   * the body, flaring past the flanks over `ruff` (from, to) in tufts up to `size` of the length,
   * and a tail of `tail.count` long locks fanning back from the tip, the middle one longest at
   * `tail.length` of the length, spreading `tail.spread` either side at their ends. The tufts and
   * locks stream back as the body flies.
   */
  mane?: {
    strip: number;
    from: number;
    ruff: [number, number];
    size: number;
    tail: { count: number; length: number; spread: number };
  };
  /**
   * Skin glyphs from a ramp measured off the font's own ink (measureInk), so a glyph's darkness
   * follows the shading and the strokes carry the body's volume, rather than a short hand-picked set.
   */
  measuredInk?: boolean;
  /**
   * Legs instead of fins, rooted where the pectorals and pelvics would be: an upper limb and a
   * forearm bent at the elbow (lengths and root half-thickness, fractions of length), a tuft of
   * fur at the elbow in the hi colour, and a hand at the wrist with three claws fanned from it,
   * pale like the horns. The forelegs reach forward to grasp, the hind legs trail back, and they
   * stroke in diagonal pairs.
   */
  legs?: { upper: number; lower: number; claw: number; thick: number };
  /**
   * Height in flight along the body, in the cloud tops' 0–1: the head held at `head`, the body
   * rising and dipping `swing` about `mid`, k radians per length. The wave keeps still in
   * space as the body slides through it, so the body dives into the clouds and comes up again
   * at the same spots, like a serpent through waves.
   */
  lift?: { head: number; mid: number; swing: number; k: number };
  /**
   * The head modelled as a surface rather than the body's round tube, back to `to` along the
   * body: a rounded skull, a ridge down the bridge of the nose `ridge` high, and brows `brow`
   * high swelling over the eyes. Lit by its slopes toward the sun, across and along it.
   */
  relief?: { to: number; ridge: number; brow: number };
  /** How far past the spine any part reaches, as a fraction of length; bounds the cell search. */
  extent?: number;
}

const SHAPES: Record<SharkKind, SharkShape> = {
  classic: {
    halfWidth: classicHalfWidth,
    pectoral: [0.15, 0.43, 0.55, 0.26],
    falcate: true,
    pelvic: [0.57, 0.65, 0.69, 0.085],
    caudal: 0.085,
    dorsal: [0.33, 0.47],
    secondDorsal: [0.71, 0.76],
    eye: [0.1, 0.14],
    gills: [0.19, 0.29],
    tint: [0.92, 0.97, 1.05],
  },
  // Slim neck under a wide, swept-back cephalofoil (drawn in sampleShark),
  // tall first dorsal, long upper tail lobe. Bronze-olive grey.
  hammerhead: {
    halfWidth: (s) => {
      if (s < 0.06) return 0.045;
      if (s < 0.3) return 0.045 + 0.061 * smoothstep(0.06, 0.3, s);
      return classicHalfWidth(s) * 0.92;
    },
    head: { span: 0.17, sweep: 0.035, depth: 0.09, notch: 0 },
    pectoral: [0.17, 0.4, 0.5, 0.22],
    falcate: true,
    pelvic: [0.56, 0.63, 0.67, 0.075],
    caudal: 0.11,
    dorsal: [0.28, 0.44],
    secondDorsal: [0.7, 0.74],
    eye: null,
    gills: [0.16, 0.26],
    tint: [0.96, 0.98, 0.9],
  },
  // Blunt, square snout on a heavy body; barred back. Warm grey-brown.
  tiger: {
    halfWidth: (s) => {
      if (s < 0.13) return 0.1 * Math.pow(Math.sin(((s / 0.13) * Math.PI) / 2), 0.45);
      if (s < 0.3) return 0.1 + 0.014 * smoothstep(0.13, 0.3, s);
      if (s < 0.84) return 0.019 + 0.095 * Math.pow(1 - (s - 0.3) / 0.54, 1.2);
      const k = (s - 0.84) / 0.16;
      return 0.019 * (1 - k) + 0.012 * Math.sin(k * Math.PI);
    },
    pectoral: [0.15, 0.42, 0.53, 0.25],
    falcate: true,
    pelvic: [0.57, 0.65, 0.69, 0.085],
    caudal: 0.095,
    dorsal: [0.33, 0.46],
    secondDorsal: [0.71, 0.75],
    eye: [0.08, 0.12],
    gills: [0.19, 0.28],
    tint: [1.02, 0.95, 0.84],
  },
  // Short rounded head, body done by half-length, then a long ribbon of a
  // tail fin. Broad rounded pectorals, spotted sandy skin.
  zebra: {
    halfWidth: (s) => {
      if (s < 0.1) return 0.075 * Math.pow(Math.sin(((s / 0.1) * Math.PI) / 2), 0.7);
      if (s < 0.28) return 0.075 + 0.025 * smoothstep(0.1, 0.28, s);
      if (s < 0.55) return 0.022 + 0.078 * Math.pow(1 - (s - 0.28) / 0.27, 1.1);
      const k = (s - 0.55) / 0.45;
      return 0.022 * (1 - k * k) + 0.012 * Math.sin(k * Math.PI);
    },
    pectoral: [0.12, 0.3, 0.36, 0.19],
    falcate: false,
    pelvic: [0.42, 0.48, 0.51, 0.065],
    caudal: 0,
    dorsal: [0.36, 0.44],
    secondDorsal: [0.49, 0.53],
    eye: [0.06, 0.09],
    gills: [0.13, 0.2],
    tint: [1.08, 0.97, 0.74],
  },
  // Great hammerhead: a broader, nearly straight-edged cephalofoil with a notch at the centre,
  // a towering sickle first dorsal (drawn long and bright from above), and a cooler slate skin.
  greathammer: {
    halfWidth: (s) => {
      if (s < 0.05) return 0.04;
      if (s < 0.3) return 0.04 + 0.07 * smoothstep(0.05, 0.3, s);
      return classicHalfWidth(s) * 0.95;
    },
    head: { span: 0.21, sweep: 0.006, depth: 0.085, notch: 0.014 },
    pectoral: [0.16, 0.38, 0.49, 0.24],
    falcate: true,
    pelvic: [0.55, 0.62, 0.67, 0.085],
    caudal: 0.13,
    dorsal: [0.24, 0.45],
    secondDorsal: [0.68, 0.74],
    eye: null,
    gills: [0.15, 0.25],
    tint: [0.86, 0.93, 1.02],
  },
  // Shortfin mako: a long conical snout, a torpedo body that narrows hard to the tail stalk,
  // and a tall crescent tail. Metallic indigo back.
  mako: {
    halfWidth: (s) => {
      if (s < 0.17) return 0.088 * Math.pow(Math.sin(((s / 0.17) * Math.PI) / 2), 1.5);
      if (s < 0.32) return 0.088 + 0.012 * smoothstep(0.17, 0.32, s);
      if (s < 0.86) return 0.014 + 0.086 * Math.pow(1 - (s - 0.32) / 0.54, 1.45);
      const k = (s - 0.86) / 0.14;
      return 0.014 * (1 - k) + 0.01 * Math.sin(k * Math.PI);
    },
    pectoral: [0.18, 0.4, 0.5, 0.21],
    falcate: true,
    pelvic: [0.58, 0.64, 0.68, 0.06],
    caudal: 0.13,
    dorsal: [0.34, 0.45],
    secondDorsal: [0.76, 0.79],
    eye: [0.11, 0.15],
    gills: [0.2, 0.3],
    tint: [0.78, 0.9, 1.2],
  },
  // Thresher: a compact body over the front half, then the upper tail lobe as a long whip
  // that's as long as the shark itself. Big eyes, long sickle pectorals, bronze-violet skin.
  thresher: {
    halfWidth: (s) => {
      if (s < 0.08) return 0.07 * Math.pow(Math.sin(((s / 0.08) * Math.PI) / 2), 0.75);
      if (s < 0.2) return 0.07 + 0.02 * smoothstep(0.08, 0.2, s);
      if (s < 0.48) return 0.012 + 0.078 * Math.pow(1 - (s - 0.2) / 0.28, 1.3);
      // The whip: thin, with a slight sickle swell before it tapers out.
      const k = (s - 0.48) / 0.52;
      return 0.012 * (1 - k) + 0.006 * Math.sin(k * Math.PI * 0.9) + 0.002;
    },
    pectoral: [0.12, 0.27, 0.36, 0.2],
    falcate: true,
    pelvic: [0.37, 0.41, 0.44, 0.045],
    caudal: 0,
    dorsal: [0.24, 0.32],
    secondDorsal: [0.45, 0.47],
    eye: [0.05, 0.1],
    gills: [0.11, 0.18],
    tint: [1.0, 0.9, 1.08],
  },
  // Nurse shark: a blunt, broad head, a heavy flattened body with both dorsals set far back,
  // rounded paddle pectorals, and a long low tail with no lower lobe. Tawny brown.
  nurse: {
    halfWidth: (s) => {
      if (s < 0.08) return 0.085 * Math.pow(Math.sin(((s / 0.08) * Math.PI) / 2), 0.4);
      if (s < 0.3) return 0.085 + 0.02 * smoothstep(0.08, 0.3, s);
      if (s < 0.72) return 0.022 + 0.083 * Math.pow(1 - (s - 0.3) / 0.42, 1.1);
      const k = (s - 0.72) / 0.28;
      return 0.022 * (1 - k * k) + 0.014 * Math.sin(k * Math.PI);
    },
    pectoral: [0.16, 0.34, 0.4, 0.17],
    falcate: false,
    pelvic: [0.45, 0.52, 0.55, 0.075],
    caudal: 0,
    dorsal: [0.5, 0.58],
    secondDorsal: [0.63, 0.69],
    eye: [0.05, 0.075],
    gills: [0.14, 0.22],
    tint: [1.1, 0.96, 0.76],
  },
  // Koi: a round blunt head, a deep back that tapers to a slim peduncle, short rounded fins,
  // one long dorsal and a broad tail. White base; the red and black come from marking().
  koi: {
    halfWidth: (s) => {
      if (s < 0.12) return 0.085 * Math.pow(Math.sin(((s / 0.12) * Math.PI) / 2), 0.55);
      if (s < 0.32) return 0.085 + 0.03 * smoothstep(0.12, 0.32, s);
      if (s < 0.8) return 0.03 + 0.085 * Math.pow(1 - (s - 0.32) / 0.48, 1.1);
      const k = (s - 0.8) / 0.2;
      return 0.03 * (1 - k) + 0.012 * Math.sin(k * Math.PI);
    },
    // Reach is measured from the spine, so a fin only shows where it clears the half-width
    // (about 0.1 at the pectorals, 0.08 at the pelvics). Fans keep the part outside broad.
    pectoral: [0.18, 0.22, 0.3, 0.17],
    falcate: false,
    fanFins: true,
    pelvic: [0.48, 0.51, 0.58, 0.13],
    // A broad fan that flares to the end, with a shallow fork.
    caudal: 0.14,
    caudalFan: 0.8,
    glossy: true,
    // Supple and loose: a bigger swing that reaches further up the body, in a tighter S.
    wave: [0.065, 1.3, 6.3],
    finMotion: { flap: [0.22, 1.4], lag: 0.3, arch: 0.15 },
    dorsal: [0.36, 0.6],
    secondDorsal: [0, 0],
    eye: [0.06, 0.09],
    gills: [0, 0],
    tint: [1.4, 1.37, 1.28],
  },
  // Humpback from above: a flat, broad head studded with tubercles, a long taper to a slim
  // tail stock, a small dorsal hump far back, wide flukes, and the wing-long white flippers
  // a third of the body long. No pelvic fins. Charcoal back.
  humpback: {
    halfWidth: (s) => {
      if (s < 0.16) return 0.075 * Math.pow(Math.sin(((s / 0.16) * Math.PI) / 2), 0.6);
      if (s < 0.32) return 0.075 + 0.03 * smoothstep(0.16, 0.32, s);
      if (s < 0.86) return 0.018 + 0.087 * Math.pow(1 - (s - 0.32) / 0.54, 1.2);
      return 0.018 * (1 - (s - 0.86) / 0.14);
    },
    // Blade flippers a third of the body long, about an eighth as wide.
    pectoral: [0.24, 0.32, 0.56, 0.36],
    falcate: false,
    flipper: true,
    finMotion: { flap: [0.1, 0.35], lag: 0.14, arch: 0.22 },
    pectoralTint: [1.3, 1.33, 1.36],
    pelvic: [0, 0, 0, 0],
    caudal: 0.17,
    caudalFan: 0.86,
    dorsal: [0.63, 0.67],
    secondDorsal: [0, 0],
    eye: [0.19, 0.21],
    gills: [0, 0],
    tint: [0.66, 0.72, 0.8],
  },
  // A white river dragon: long and slender as a serpent, a narrow muzzle and cheeks that swell
  // at the jaw, a slim neck, an even body tapering to a tuft at the tail. Pearl-white scales, a
  // jade mane down the back that flares at the neck, pale horns, long barbels, four small legs.
  dragon: {
    // The head is drawn well over twice its true share of the length, as a portrait gives the
    // face room: about eleven cells across, twice the neck. Smaller, its eyes, horns and barbels
    // each had a cell or two and ran together. The muzzle is slim and nearly straight-sided to a
    // round nose, flaring only at the eyes: tapering all the way from the cheeks, it read as a
    // wide, open, triangular jaw. A long muzzle,
    // cheeks at the eyes, the skull, then a neck plainly narrower than the head, so the head
    // stands apart from the body instead of running into it.
    halfWidth: (s) => {
      if (s < 0.016) return 0.018 * Math.pow(Math.sin(((s / 0.016) * Math.PI) / 2), 0.5);
      if (s < 0.048) return 0.018 + 0.003 * smoothstep(0.016, 0.048, s);
      if (s < 0.074) return 0.021 + 0.034 * smoothstep(0.048, 0.074, s);
      if (s < 0.103) return 0.055 - 0.009 * smoothstep(0.076, 0.103, s);
      if (s < 0.135) return 0.046 - 0.028 * smoothstep(0.103, 0.135, s);
      if (s < 0.75) return 0.018 + 0.006 * smoothstep(0.135, 0.29, s);
      const k = (s - 0.75) / 0.25;
      return 0.024 * Math.pow(1 - k, 1.2) + 0.005 * k;
    },
    // Leg roots: shoulders and hips. The legs themselves are `legs`, not these fins.
    pectoral: [0.23, 0.25, 0.28, 0.06],
    falcate: false,
    // About three cells thick at the shoulder: thinner, a leg was a one-cell stick and its elbow,
    // claws and tuft fell between the cells. Short beside the body, or it reads as a lizard.
    legs: { upper: 0.045, lower: 0.038, claw: 0.028, thick: 0.016 },
    pelvic: [0.46, 0.48, 0.51, 0.06],
    // No tail fin: the tail ends in locks of hair (mane.tail).
    caudal: 0,
    glossy: true,
    measuredInk: true,
    // Two S-bends from neck to tail, all the way along rather than growing to the tail.
    wave: [0.06, 0.35, SLITHER_K],
    finMotion: { flap: [0.4, 1], lag: 0.25, arch: 0.3 },
    pectoralTint: [1.42, 1.32, 1.06],
    finTint: [0.62, 1.12, 1.02],
    hiTint: [0.42, 1.1, 0.96],
    eyeInk: "#7ff0d0",
    // Horns from the back of the skull, swept back and out clear of the head; long barbels from
    // the muzzle, streaming back wide of the neck.
    horns: { u0: 0.078, a0: 0.035, u1: 0.168, a1: 0.095, width: 0.011 },
    whiskers: { u: 0.01, a: 0.019, length: 0.3, spread: 0.085, wave: 0.03 },
    // Jade hair from behind the skull down the back, and a ruff at the neck: the head itself
    // stays white, or its eyes, horns and barbels are lost in the jade.
    mane: { strip: 0.28, from: 0.105, ruff: [0.125, 0.3], size: 0.028, tail: { count: 5, length: 0.15, spread: 0.06 } },
    lift: { head: 1.2, mid: 0.45, swing: 0.55, k: 7 },
    relief: { to: 0.12, ridge: 0.35, brow: 0.5 },
    extent: 0.22,
    dorsal: [0, 0],
    secondDorsal: [0, 0],
    eye: [0.057, 0.066],
    gills: [0, 0],
    tint: [1.3, 1.32, 1.36],
  },
};

const KINDS = Object.keys(SHAPES) as SharkKind[];
/**
 * Sharks' pectorals are stiff: they don't flap, they only curve a little.
 * Only the tip of a long swept-back triangle shows past the flank, so even a few degrees of
 * flap swings much of it under the body and the fin seems to shrink.
 */
const DEFAULT_FIN_MOTION = { flap: [0.015, 0.5] as [number, number], lag: 0.015, arch: 0.12 };

/** "#rgb" or "#rrggbb" to [r, g, b]. */
function hexRGB(hex: string): RGB {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as RGB;
}

/** CLOUD_LEVELS colours from the sky through a cloud's dim faces (at half) to its lit ones. */
function cloudRamp(dim: RGB, lit: RGB, sky: RGB) {
  return Array.from({ length: CLOUD_LEVELS }, (_, k) => {
    const b = k / (CLOUD_LEVELS - 1);
    const [from, to, f] = b < 0.5 ? [sky, dim, b / 0.5] : [dim, lit, (b - 0.5) / 0.5];
    return `rgb(${from.map((v, j) => Math.round(v + (to[j] - v) * f)).join(",")})`;
  });
}

function inTriangle(
  px: number, py: number,
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number,
) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/** Visible dark-grey cell grid, snapped to device pixels. Shared with the sidebar backdrop. */
export function paintGrid(
  g: CanvasRenderingContext2D, W: number, H: number, cw: number, ch: number, dpr: number,
  stroke = "rgba(255,255,255,0.055)",
) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.strokeStyle = stroke;
  g.lineWidth = 1;
  g.beginPath();
  for (let c = 0; c <= Math.ceil(W / cw); c++) {
    const x = Math.round(c * cw * dpr) + 0.5;
    g.moveTo(x, 0);
    g.lineTo(x, H * dpr);
  }
  for (let r = 0; r <= Math.ceil(H / ch); r++) {
    const y = Math.round(r * ch * dpr) + 0.5;
    g.moveTo(0, y);
    g.lineTo(W * dpr, y);
  }
  g.stroke();
}

export class AsciiRenderer {
  private meadow = new MeadowRenderer();
  private ctx: CanvasRenderingContext2D;
  private bg: HTMLCanvasElement;
  private dpr = 1;
  private width = 0;
  private height = 0;
  private cw = 12;
  private ch = 18;
  private cols = 0;
  private rows = 0;
  private fontFamily = "ui-monospace, Menlo, monospace";

  private dotKind = new Uint8Array(0); // 0 none, 1 blue, 2 green, 3 red, 4 pale
  private dotPhase = new Float32Array(0);
  private dotFreq = new Float32Array(0);
  private energy = new Float32Array(0);
  private energyTmp = new Float32Array(0);
  private heat = new Float32Array(0);
  private bucketOf = new Uint8Array(0);
  private bucketOrder = new Int32Array(0);
  private bucketCounts = new Int32Array((WAKE + 1) * ALPHA_LEVELS + 1);
  private dotStyles: string[] = [];

  /** The scene the colours below were built for; render() rebuilds them when the world's changes. */
  private scene: Scene | null = null;
  private accents: string[] = [];
  private lightX = 0;
  private lightY = 0;

  private sharkFlag = new Uint8Array(0);
  private sharkShade = new Float32Array(0);
  private sharkKey = new Uint32Array(0);
  private sharkDepth = new Float32Array(0);
  private sharkKind = new Uint8Array(0);
  /** Cells darkened by a shark's shadow on the seabed. */
  /** Depth of the nearest creature shading each cell: its shadow, or its edge over a deeper body. */
  private sharkShadow = new Float32Array(0);
  /** Shadow cast on the pond floor in each cell, 0–1, where the scene's floor shows. */
  private floorShade = new Float32Array(0);
  private floorStyles: string[] = [];
  /** Sunlight through the scene's canopy, if it has one. */
  private canopy = new CanopyField();
  /** How much of the canopy's shade falls this frame, as the world eases it in or out. */
  private shadeAmount = 0;
  /** Sun bent and mirrored by the ripples, on a sunny scene, and its ink by glyph. */
  private caustics = new CausticsField();
  private causticStyles: string[] = [];
  private glintStyle = "";
  /** A cloud sea under the flyers, on a scene that has one, and how far the wind has carried it, px. */
  private clouds = new CloudField();
  private cloudDrift = { x: 0, y: 0 };
  /** Cloud cells bucketed by brightness, and each bucket's colour: sky, through the dim faces, to the lit ones. */
  private cloudBuckets: number[][] = Array.from({ length: CLOUD_LEVELS }, () => []);
  private cloudStyles: string[] = [];
  /** How far each creature cell has faded into the cloud it skims or flies in, 0–1, toward the fog. */
  private sharkMist = new Float32Array(0);
  /** The current shark's height-wave phase (its lift), and its height at the last sample. */
  private liftPhase = 0;
  private hitLift = 1;
  /** The mane's tufts streaming back: their phase along the body. */
  private flutter = 0;
  /** The current creature's legs this frame, LEG_POSE numbers each (see poseLegs). */
  private legPose = new Float32Array(4 * LEG_POSE);
  /** Skin glyphs from sparse to dense by their measured ink, and the font they were measured in. */
  private inkRamp = SKIN_RAMP;
  private inkFont = "";
  /** Where along the last segment() tested the point fell, 0–1. */
  private segT = 0;
  private spine = new Float32Array(SHARK_NODES * 2);
  private arc = new Float32Array(SHARK_NODES);
  private arcTotal = 1;
  private shape = SHAPES.classic;
  private sharkId = 0;
  private finTipLeft = 0;
  private finTipRight = 0;
  /**
   * Straight frames pinned to the spine at the pectoral and pelvic roots: a point and the
   * tailward tangent there. Fins are tested in these, not in body coordinates.
   */
  private pecFrame = { x: 0, y: 0, tx: 1, ty: 0 };
  private pelFrame = { x: 0, y: 0, tx: 1, ty: 0 };
  /** The tail's end, where its locks of hair are tested, and the body wave there: the locks carry it on. */
  private tailFrame = { x: 0, y: 0, tx: 1, ty: 0 };
  private tailWave = { amp: 0, phase: 0, k: 0 };
  /** The fins' pose this frame: a sweep (flap) about the root. */
  private finSweep = 0;
  /** Extra sweep at the fin tip: its lag behind the flap plus its resting arch. */
  private finTipSweep = 0;
  private finPose = { u: 0, a: 0 };
  /** The current shark's gape, 0 shut → 1 wide. */
  private gape = 0;
  /** Where the dorsal midline sits across the body (−1…1, signed like v) once the shark rolls. */
  private rollX = 0;
  // Scratch outputs of sampleShark(), to avoid allocating per sample.
  private hitFlag = 0;
  private hitShade = 0;
  private hitS = 0;
  private hitV = 0;
  private hitDist = 0;

  /** Cells holding a fish this frame (frame stamp); dots skip them. */
  private fishStamp = new Uint32Array(0);
  private frameId = 0;
  /** Fish cells bucketed by brightness, so each bucket is one fillStyle. */
  private fishBuckets: number[][] = FISH_ALPHAS.map(() => []);
  private fishStyles: string[] = [];
  /** Ripple water's own square-grid surface; `energy` is sampled from it on ripple scenes. */
  private ripple = new RippleField();
  private wind = { x: 0, y: 0 };
  /** How far the gust field has drifted downwind, px. */
  private gustDrift = { x: 0, y: 0 };
  /** Impacts still ringing on ripple water; r in px, and a negative age until they land. */
  private drops: { x: number; y: number; age: number; amp: number; r: number }[] = [];
  private bubbleStyles: string[] = [];
  private fogRGB: RGB = [0, 0, 0];
  private fogStrength = 1;
  private ambient = 0;
  /** The water (or floor) colour behind everything, for what shows through translucent fins. */
  private waterRGB: RGB = [0, 0, 0];
  /** Pellet cells this frame, drawn in the scene's food colour. */
  private foodCells: number[] = [];
  private foodStyle = "";

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;
    this.bg = document.createElement("canvas");
  }

  private applyScene(scene: Scene, world: World) {
    // A theme only recolours: keep the water moving. A new scene starts its water still.
    const recast = this.scene?.name !== scene.name;
    this.scene = scene;
    const shade = scene.floorShadow;
    this.floorStyles = shade ? FLOOR_LEVELS.map((a) => `rgba(${shade.join(",")},${(a * FLOOR_ALPHA).toFixed(3)})`) : [];
    // Leaf shade takes the floor-shadow colour: the same scattered light fills both in.
    this.canopy.set(scene.canopy, scene.light, shade ?? [0, 0, 0]);
    this.caustics.set(scene.caustics, scene.light);
    this.clouds.set(scene.clouds, scene.light);
    this.cloudStyles = scene.clouds ? cloudRamp(scene.clouds.dim, scene.clouds.lit, hexRGB(scene.background)) : [];
    const ink = scene.caustics?.ink;
    this.causticStyles = ink ? Array.from({ length: CAUSTIC_INKS }, (_, k) => `rgba(${ink.join(",")},${(0.35 + (0.6 * k) / (CAUSTIC_INKS - 1)).toFixed(2)})`) : [];
    this.glintStyle = scene.caustics ? `rgb(${scene.caustics.glintInk.join(",")})` : "";
    this.dotStyles = [];
    for (let c = 0; c <= WAKE; c++) {
      const [r, g, b] = c === WAKE ? scene.wake : DOT_RGB[c];
      for (let l = 0; l < ALPHA_LEVELS; l++) {
        const a = (DOT_BASE_ALPHA[c] * (l + 1)) / ALPHA_LEVELS;
        this.dotStyles.push(`rgba(${r},${g},${b},${a.toFixed(3)})`);
      }
    }
    const [wr, wg, wb] = scene.wake;
    this.bubbleStyles = BUBBLE_ALPHAS.map((a) => `rgba(${wr},${wg},${wb},${a})`);
    const [fr, fg, fb] = scene.fish;
    this.fishStyles = FISH_ALPHAS.map((a) => `rgba(${fr},${fg},${fb},${a})`);
    this.foodStyle = `rgb(${scene.food.join(",")})`;
    this.accents = scene.accents;
    this.fogRGB = scene.fog;
    this.fogStrength = scene.fogStrength;
    this.ambient = scene.ambient;
    this.waterRGB = hexRGB(scene.background);
    [this.lightX, this.lightY] = scene.light;
    this.ripple.setOpen(!scene.shore);
    if (recast) {
      // A new sky opens with its cloud weighed against the creatures, not down the same side.
      let cx = 0;
      let cy = 0;
      for (const sh of world.sharks) {
        for (let k = 0; k < SHARK_NODES; k++) {
          cx += sh.nodes[k * 2] / this.width - 0.5;
          cy += sh.nodes[k * 2 + 1] / this.height - 0.5;
        }
      }
      const nodes = Math.max(1, world.sharks.length * SHARK_NODES);
      this.clouds.settle(Math.random, { x: cx / nodes, y: cy / nodes });
      // A glowing wake and a wave field don't mean the same thing; start the new water still.
      this.energy.fill(0);
      this.energyTmp.fill(0);
      this.heat.fill(0);
      this.drops.length = 0;
      this.ripple.clear();
    }
    this.paintBackground();
  }

  get cellWidth() {
    return this.cw;
  }

  get cellHeight() {
    return this.ch;
  }

  setFontFamily(family: string) {
    if (family) this.fontFamily = family;
  }

  resize(width: number, height: number, dpr: number) {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.cw = clamp(Math.round(width / 124), 8, 13);
    this.ch = Math.round(this.cw * 1.45);
    this.cols = Math.ceil(width / this.cw);
    this.rows = Math.ceil(height / this.ch);

    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.bg.width = this.canvas.width;
    this.bg.height = this.canvas.height;

    const n = this.cols * this.rows;
    this.dotKind = new Uint8Array(n);
    this.dotPhase = new Float32Array(n);
    this.dotFreq = new Float32Array(n);
    this.energy = new Float32Array(n);
    this.energyTmp = new Float32Array(n);
    this.heat = new Float32Array(n);
    this.bucketOf = new Uint8Array(n);
    this.bucketOrder = new Int32Array(n);
    this.sharkFlag = new Uint8Array(n);
    this.sharkShade = new Float32Array(n);
    this.sharkKey = new Uint32Array(n);
    this.sharkDepth = new Float32Array(n);
    this.sharkKind = new Uint8Array(n);
    this.sharkShadow = new Float32Array(n);
    this.floorShade = new Float32Array(n);
    this.sharkMist = new Float32Array(n);
    this.fishStamp = new Uint32Array(n);
    this.ripple.resize(width, height, this.cw);
    this.canopy.resize(this.cols, this.rows, this.cw, this.ch, width, height);
    this.caustics.resize(this.cols, this.rows, this.cw, this.ch, width, height);
    this.clouds.resize(this.cols, this.rows, this.cw, this.ch, width, height);

    for (let i = 0; i < n; i++) {
      const col = i % this.cols;
      const row = (i / this.cols) | 0;
      // No ambient dots: the grid stays black. Only the cyan wake lights cells.
      this.dotKind[i] = 0;
      this.dotPhase[i] = hash3(col, row, 23) * Math.PI * 2;
      this.dotFreq[i] = 0.3 + hash3(col, row, 37) * 1.1;
    }
    this.paintBackground();
  }

  private paintBackground() {
    const g = this.bg.getContext("2d");
    const { scene } = this;
    if (!g || !scene) return;
    const { width: W, height: H, dpr, cw, ch } = this;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = scene.background;
    g.fillRect(0, 0, W, H);
    paintGrid(g, W, H, cw, ch, dpr, scene.grid);
  }

  render(world: World, dt: number) {
    const { ctx, dpr, cols, ch } = this;
    if (cols === 0) return;
    if (world.scene !== this.scene) this.applyScene(world.scene, world);
    if (world.scene.meadow) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.meadow.render(ctx, world, this.cw, this.ch, this.fontFamily);
      return;
    }
    const t = world.time;
    windAt(t, world.windSpeed, this.wind);
    // The gust field rides on the wind; carried step by step, so it slows when the wind eases
    // instead of leaping (wind × t would sweep it across the pond as the wind changed).
    this.gustDrift.x += this.wind.x * GUST_SPEED * dt;
    this.gustDrift.y += this.wind.y * GUST_SPEED * dt;
    this.shadeAmount = this.canopy.active ? world.shade : 0;
    if (this.shadeAmount > 0.001) {
      const [lo, hi] = CANOPY_GUST;
      const wind = world.windSpeed / Math.max(1, world.scene.wind);
      this.canopy.update(t, wind, (x, y) => smoothstep(lo, hi, this.gust(x, y)));
    }

    this.consumeEvents(world);
    if (this.clouds.active) {
      // The sea of cloud rides the wind, carried step by step like the gusts; a click or the
      // pointer leaves energy that parts it for a while.
      this.cloudDrift.x += this.wind.x * dt;
      this.cloudDrift.y += this.wind.y * dt;
      this.clouds.update(t, this.cloudDrift.x, this.cloudDrift.y, this.energy);
    }
    this.rasterizeSharks(world.sharks, t);
    this.depositWake(world, dt);
    this.diffuse(dt);
    if (this.caustics.active) {
      const breeze = world.windSpeed / Math.max(1, world.scene.wind);
      const [lo, hi] = CHOP_GUST;
      this.caustics.update(this.ripple, t, breeze, (x, y) => smoothstep(lo, hi, this.gust(x, y)), (i) => this.sunAt(i));
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.bg, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.drawFloorShadows();
    this.markFish(world);
    this.drawDots(t);

    ctx.font = `600 ${Math.round(ch * 0.74)}px ${this.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    this.drawCaustics();
    this.drawClouds();
    this.drawHeat();
    this.drawFish();
    this.drawSharks(t);
    this.drawBubbles(world);
    this.drawShade();
    this.drawGlints();
  }

  // ── simulation → field ──────────────────────────────────────────────

  private cellIndex(x: number, y: number) {
    const c = Math.floor(x / this.cw);
    const r = Math.floor(y / this.ch);
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return -1;
    return r * this.cols + c;
  }

  private stamp(field: Float32Array, x: number, y: number, radius: number, amount: number) {
    const c0 = Math.floor(x / this.cw);
    const r0 = Math.floor(y / this.ch);
    for (let r = r0 - radius; r <= r0 + radius; r++) {
      for (let c = c0 - radius; c <= c0 + radius; c++) {
        if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) continue;
        const d = Math.hypot(c - c0, (r - r0) * 1.4);
        if (d > radius + 0.5) continue;
        const i = r * this.cols + c;
        field[i] = Math.min(1.6, field[i] + amount * (1 - d / (radius + 1)));
      }
    }
  }

  private consumeEvents(world: World) {
    const ripple = world.scene.water === "ripple";
    for (const e of world.events) {
      if (e.kind === "eat") {
        // Embers only where something was killed, not where a pellet was taken.
        if (world.scene.diet === "fish") this.stamp(this.heat, e.x, e.y, 2, 1);
        if (ripple) this.drops.push({ x: e.x, y: e.y, age: 0, amp: GULP_AMP, r: 12 });
        else this.stamp(this.energy, e.x, e.y, 3, 0.9);
      } else if (e.kind === "drop") {
        if (ripple) this.drops.push({ x: e.x, y: e.y, age: -(e.delay ?? 0), amp: DROP_AMP * (e.strength ?? 1), r: 12 });
        else this.stamp(this.energy, e.x, e.y, 2, 1);
      } else if (ripple) {
        // A whale breaching or a hard slap: a wide impact that rings like a big drop.
        this.drops.push({ x: e.x, y: e.y, age: -(e.delay ?? 0), amp: 0.9 * (e.strength ?? 1), r: 36 });
      } else {
        this.stamp(this.energy, e.x, e.y, 6, 1.4);
      }
    }
    world.events.length = 0;
  }

  private depositWake(world: World, dt: number) {
    if (world.scene.water === "ripple") {
      this.stirRipples(world, dt);
      return;
    }
    const { energy } = this;
    if (world.scene.water === "cloud") {
      // Nothing flying leaves a glow in the sky; a resting pointer slowly parts the clouds under it.
      if (world.pointer.active) this.stamp(energy, world.pointer.x, world.pointer.y, 2, 0.05);
      return;
    }
    for (const f of world.fish) {
      if (!f.alive) continue;
      const i = this.cellIndex(f.x, f.y);
      if (i >= 0) energy[i] = Math.min(1.6, energy[i] + 0.012 + f.alarm * 0.03);
    }
    for (const sh of world.sharks) {
      // The tail sweeps the most water.
      for (let k = SHARK_NODES - 6; k < SHARK_NODES; k++) {
        const i = this.cellIndex(sh.nodes[k * 2], sh.nodes[k * 2 + 1]);
        if (i >= 0) energy[i] = Math.min(1.6, energy[i] + 0.05 + sh.speed * 0.0012);
      }
    }
    if (world.pointer.active) {
      this.stamp(energy, world.pointer.x, world.pointer.y, 1, 0.08);
    }
  }

  /**
   * A steady deposit would pile ripple water into humps, so here swimmers push the surface
   * back and forth with their tail beat instead: each stroke sends out a ring and the
   * pushes cancel over a beat. Only the big creatures stir the surface; small fish swim
   * too deep and too light to ring it. A resting fingertip trembles and rings the same way.
   */
  private stirRipples(world: World, dt: number) {
    const { ripple, drops } = this;
    for (let k = drops.length - 1; k >= 0; k--) {
      const d = drops[k];
      if (d.age > 3 / DROP_HZ) {
        drops.splice(k, 1);
        continue;
      }
      if (d.age >= 0) {
        ripple.stamp(d.x, d.y, d.r, d.amp * Math.sin(2 * Math.PI * DROP_HZ * d.age) * Math.exp(-d.age / DROP_DECAY));
      }
      d.age += dt;
    }
    for (const sh of world.sharks) {
      const k = SHARK_NODES - 1;
      const stroke = RIPPLE_STROKE * (1 + sh.speed / STROKE_SPEED);
      ripple.stamp(sh.nodes[k * 2], sh.nodes[k * 2 + 1], 8, stroke * Math.sin(sh.phase));
    }
    if (world.pointer.active) {
      ripple.stamp(world.pointer.x, world.pointer.y, 12, 0.05 * Math.sin(world.time * 9));
    }
    this.roughen(world);
  }

  /** Cat's paws: tiny pokes where the gust field, drifting downwind, is strong. */
  private roughen(world: World) {
    const speed = world.windSpeed;
    if (speed <= 0) return;
    const { width: W, height: H, wind } = this;
    const strength = speed / Math.max(1, world.scene.wind);
    const pokes = Math.round(GUST_POKES * strength * ((W * H) / (1280 * 800)));
    for (let k = 0; k < pokes; k++) {
      const x = Math.random() * W;
      const y = Math.random() * H;
      const g = this.gust(x, y);
      if (g < GUST_FLOOR) continue;
      const amp = GUST_AMP * strength * ((g - GUST_FLOOR) / (1 - GUST_FLOOR));
      this.ripple.stamp(x, y, 6, Math.random() < 0.5 ? amp : -amp);
    }
  }

  /** The gust field at a point, 0–1, drifting downwind: it roughens the water and shakes the trees. */
  private gust(x: number, y: number) {
    const { gustDrift } = this;
    return valueNoise((x - gustDrift.x) / GUST_PX, (y - gustDrift.y) / GUST_PX, 91);
  }

  /** Blur + decay so wakes spread out and fade, or, on ripple water, propagate as waves. */
  private diffuse(dt: number) {
    const { cols, rows, energy, energyTmp: tmp, heat, cw, ch } = this;
    if (this.scene?.water === "ripple") {
      this.ripple.step(dt, this.wind.x, this.wind.y);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) energy[r * cols + c] = this.ripple.sample(c * cw + cw / 2, r * ch + ch / 2);
      }
    } else {
      const decay = Math.exp(-dt * 1.5);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          const l = c > 0 ? energy[i - 1] : energy[i];
          const rt = c < cols - 1 ? energy[i + 1] : energy[i];
          const u = r > 0 ? energy[i - cols] : energy[i];
          const d = r < rows - 1 ? energy[i + cols] : energy[i];
          tmp[i] = (energy[i] * 4 + l + rt + u + d) * 0.125 * decay;
        }
      }
      this.energy = tmp;
      this.energyTmp = energy;
    }
    const heatDecay = Math.exp(-dt * 2.2);
    for (let i = 0; i < heat.length; i++) heat[i] *= heatDecay;
  }

  // ── sharks ──────────────────────────────────────────────────────────

  /**
   * Classify one point against the current shark (spine/arc already built).
   * Body coordinates: s along the spine (0 snout → 1 tail), v across it.
   * Writes hit* fields and returns whether the point is on the shark.
   */
  private sampleShark(px: number, py: number, L: number) {
    const { spine, arc } = this;
    const N = SHARK_NODES;
    let best = Infinity;
    let bestS = 0;
    let bestSign = 1;
    let bestNx = 0;
    let bestNy = 0;
    let bestTx = 1;
    let bestTy = 0;
    for (let k = 0; k < N - 1; k++) {
      const ax = spine[k * 2];
      const ay = spine[k * 2 + 1];
      const sx = spine[(k + 1) * 2] - ax;
      const sy = spine[(k + 1) * 2 + 1] - ay;
      const len2 = sx * sx + sy * sy || 1;
      const u = clamp(((px - ax) * sx + (py - ay) * sy) / len2, 0, 1);
      const qx = ax + sx * u;
      const qy = ay + sy * u;
      const d2 = (px - qx) ** 2 + (py - qy) ** 2;
      if (d2 < best) {
        best = d2;
        const len = Math.sqrt(len2);
        bestS = (arc[k] + u * len) / this.arcTotal;
        bestSign = sx * (py - ay) - sy * (px - ax) >= 0 ? 1 : -1;
        bestNx = (-sy / len) * bestSign;
        bestNy = (sx / len) * bestSign;
        bestTx = sx / len;
        bestTy = sy / len;
      }
    }

    const a = Math.sqrt(best);
    const s = bestS;
    const u = s * L;
    const shape = this.shape;
    // A lunging whale's throat balloons out behind the open jaw.
    const swell = this.gape > 0 ? 1 + this.gape * 0.8 * (1 - smoothstep(0.05, 0.42, s)) : 1;
    let w = shape.halfWidth(s) * L * swell;
    if (shape.lift) {
      // A flyer's high reaches are nearer the eye, so a little wider; its low ones narrower.
      this.hitLift = this.altitude(s);
      w *= 1 + LIFT_SCALE * (this.hitLift - 0.5);
    }
    this.hitDist = a;
    this.hitS = s;
    this.hitV = a * bestSign;

    const head = this.shape.head;
    if (head && u < L * (head.sweep + head.depth + head.notch)) {
      // Cephalofoil: a wide wing across the snout, its tips swept back toward the eyes,
      // and on a great hammerhead a shallow notch in the middle of the front edge.
      const span = L * head.span;
      const r = a / span;
      const front = L * head.sweep * r * r + L * head.notch * Math.max(0, 1 - r / 0.14);
      // Full depth almost to the tips, so the wing reads as a solid bar rather than a thin line.
      const depth = L * head.depth * (1 - 0.2 * r * r * r * r);
      if (r <= 1 && u >= front && u <= front + depth) {
        this.hitFlag = r > 0.84 ? FLAG_EYE : FLAG_BODY;
        this.hitShade = r > 0.84 ? 0 : 0.62 - 0.2 * r + (u < front + L * 0.012 ? 0.1 : 0);
        return true;
      }
    }

    if (a <= w) {
      const across = a / (w || 1);
      // Rounded back lit from the top-left; flanks fall off into shadow.
      const facing = (bestNx * this.lightX + bestNy * this.lightY) * across;
      let shade = 0.58 - across * across * 0.42 + facing * 0.26;
      // A round body shades the same however it rolls; the roll shows in the markings.
      // fromBack is the distance from the dorsal midline, which slides with the roll,
      // and past the old silhouette edge the pale belly comes into view.
      const fromBack = Math.abs(across * bestSign - this.rollX);
      if (shape.relief && s < shape.relief.to) shade = this.headLight(s, across, bestNx, bestNy, bestTx, bestTy, w, L);
      shade = Math.min(1, shade * (1 + 0.9 * smoothstep(1, 1.25, fromBack)));
      let flag = FLAG_BODY;
      if (s > shape.dorsal[0] && s < shape.dorsal[1] && fromBack < 0.3) {
        // First dorsal fin, catching the light.
        flag = FLAG_RIDGE;
        shade = 1;
      } else if (s > shape.secondDorsal[0] && s < shape.secondDorsal[1] && fromBack < 0.4) {
        shade = Math.max(shade, 0.82);
      } else if (shape.eye && s > shape.eye[0] && s < shape.eye[1] && across > 0.6) {
        flag = FLAG_EYE;
        shade = 0;
      } else if (s > shape.gills[0] && s < shape.gills[1] && across > 0.58) {
        // Five gill slits.
        if (Math.floor(((s - shape.gills[0]) / (shape.gills[1] - shape.gills[0])) * 5) % 2 === 0) shade *= 0.45;
      } else if (s < 0.05 && !shape.relief) {
        // Pale snout tip.
        shade = Math.max(shade, 0.7);
      } else if (shape === SHAPES.zebra && s > 0.08 && s < 0.55 && (across < 0.1 || Math.abs(across - 0.6) < 0.08)) {
        // Zebra sharks carry pale ridges down the back.
        shade = Math.max(shade, 0.8);
      } else if (this.gape > 0.3 && s < 0.4 && across > 0.45 && Math.floor(across * 10) % 2 === 0) {
        // Throat pleats, stretched open and pale.
        flag = FLAG_PALE;
      } else {
        flag = this.marking(s, a * bestSign, L, across) || FLAG_BODY;
      }
      this.hitFlag = flag;
      this.hitShade = shade;
      return true;
    }
    // Legs reach out over the ruff that grows at the shoulders.
    if (shape.legs && this.inLegs(px, py, L)) return true;
    if ((shape.horns || shape.whiskers || shape.mane) && this.inAdornment(px, py, u, a, w, s, L)) return true;

    // Fins are rigid: they turn with the body at the root but don't bend with it. So they're
    // tested in a straight frame pinned at the root (fu along, fa out), not in body coordinates,
    // which fan out round a bend: a long fin on the outside of a turn stretched to nearly twice
    // its length, and squashed on the inside.
    const [p0, p1, p2] = shape.pectoral;
    const pf = this.pecFrame;
    const pdx = px - pf.x;
    const pdy = py - pf.y;
    const pcross = pf.tx * pdy - pf.ty * pdx;
    const tip = pcross >= 0 ? this.finTipRight : this.finTipLeft;
    const pec = this.poseFin((L * (p0 + p1)) / 2, pdx * pf.tx + pdy * pf.ty, Math.abs(pcross), tip);
    const fu = pec.u;
    const fa = pec.a;
    if (shape.legs) {
      // Tested above, before the ruff.
    } else if (shape.flipper) {
      const flag = this.inFlipper(fu, fa, L, tip);
      if (flag) {
        this.hitFlag = flag;
        this.hitShade = flag === FLAG_PALE ? 0.5 : 0.38 + 0.22 * (1 - clamp(fa / tip, 0, 1));
        return true;
      }
    } else if (
      shape.fanFins
        ? inTriangle(fu, fa, L * p0, 0, L * p1, tip, L * p2, tip * 0.8)
        : inTriangle(fu, fa, L * p0, 0, L * p1, 0, L * p2, tip) &&
          // Falcate (sickle) fins get a concave trailing edge.
          !(shape.falcate && inTriangle(fu, fa, L * p1, 0, L * (p1 + (p2 - p1) * 0.33), tip * 0.55, L * p2, tip))
    ) {
      this.hitFlag = shape.pectoralTint
        ? FLAG_PALE
        : this.marking(s, a * bestSign, L, 0) === FLAG_MARK ? FLAG_MARK : FLAG_FIN;
      // White flippers are the brightest thing on a humpback; other fins sit in the body's shade.
      this.hitShade = (shape.pectoralTint ? 0.62 : 0.38) + (shape.pectoralTint ? 0.3 : 0.22) * (1 - clamp(fa / tip, 0, 1));
      // A supple fish's fin is thick at the root and thins to nothing at the edge.
      if (shape.glossy) {
        const root = shape.halfWidth((p0 + p1) / 2) * L;
        this.hitShade = 1 - clamp((fa - root) / Math.max(1, tip - root), 0, 1);
      }
      return true;
    }
    const [v0, v1, v2, vr] = shape.pelvic;
    const vf = this.pelFrame;
    const vdx = px - vf.x;
    const vdy = py - vf.y;
    const vcross = vf.tx * vdy - vf.ty * vdx;
    const pel = this.poseFin((L * (v0 + v1)) / 2, vdx * vf.tx + vdy * vf.ty, Math.abs(vcross), L * vr);
    const vu = pel.u;
    const va = pel.a;
    // A degenerate triangle would contain every point, so no pelvics means vr = 0 and none drawn.
    const pelvic =
      vr > 0 &&
      !shape.legs &&
      (shape.fanFins
        ? inTriangle(vu, va, L * v0, 0, L * v1, L * vr, L * v2, L * vr * 0.8)
        : inTriangle(vu, va, L * v0, 0, L * v1, 0, L * v2, L * vr));
    // Forked caudal fin.
    const caudal = !pelvic && shape.caudal > 0 && this.inCaudal(u, a, L);
    if (pelvic || caudal) {
      this.hitFlag = FLAG_FIN;
      this.hitShade = 0.36;
      if (shape.glossy) {
        // Membrane thickness: from the root out to the edge, and along the tail to its tips.
        const fan = shape.caudalFan ?? 0.86;
        const root = shape.halfWidth((v0 + v1) / 2) * L;
        this.hitShade = pelvic
          ? 1 - clamp((va - root) / Math.max(1, L * vr - root), 0, 1)
          : 1 - clamp((u - L * fan) / (L * (1 - fan)), 0, 1);
      }
      return true;
    }
    return false;
  }

  /**
   * The four legs, each in the straight frame at its root (along the spine tailward, out from
   * it), posed this frame in legPose: skin for the limbs, hi-coloured fur at the elbow, strands
   * for the claws. Sets the hit and returns true on one.
   */
  private inLegs(px: number, py: number, L: number) {
    const legs = this.shape.legs!;
    const pose = this.legPose;
    const thick = L * legs.thick;
    const reach = L * (legs.upper + legs.lower + legs.claw) + thick;
    for (let hind = 0; hind < 2; hind++) {
      const f = hind ? this.pelFrame : this.pecFrame;
      const dx = px - f.x;
      const dy = py - f.y;
      if (dx * dx + dy * dy > reach * reach) continue;
      const cross = f.tx * dy - f.ty * dx;
      const u = dx * f.tx + dy * f.ty;
      const out = Math.abs(cross);
      const k = (hind * 2 + (cross >= 0 ? 0 : 1)) * LEG_POSE;
      const eu = pose[k];
      const ea = pose[k + 1];
      const wu = pose[k + 2];
      const wa = pose[k + 3];
      // Claws over the hand they spring from, the hand over the forearm: three spread forward and
      // a shorter one behind, on the side away from the body, as on an eagle's foot.
      const spread = pose[k + 6];
      for (let c = 0; c < 4; c++) {
        const back = c === 3;
        const dir = pose[k + 4] + (back ? (Math.sin(pose[k + 4] + 2.4) > Math.sin(pose[k + 4] - 2.4) ? 2.4 : -2.4) : (c - 1) * spread);
        const len = L * legs.claw * (back ? 0.6 : c === 1 ? 1.1 : 1);
        const d = this.segment(u, out, wu, wa, wu + Math.cos(dir) * len, wa + Math.sin(dir) * len);
        if (this.segT > 0.2 && d < thick * 0.34 * (1 - 0.6 * this.segT)) {
          this.hitFlag = FLAG_CLAW;
          this.hitShade = 0.8 - 0.3 * this.segT;
          return true;
        }
      }
      const palm = Math.hypot(u - wu, out - wa);
      if (palm < thick * 0.8) {
        this.hitFlag = FLAG_BODY;
        this.hitShade = 0.7 - 0.3 * (palm / (thick * 0.8)) ** 2;
        return true;
      }
      let d = this.segment(u, out, eu, ea, wu, wa);
      let r = thick * 0.75 * (1 - 0.2 * this.segT);
      if (d >= r) {
        d = this.segment(u, out, 0, 0, eu, ea);
        r = thick * (1 - 0.25 * this.segT);
      }
      if (d < r) {
        // A round limb, lit along its top.
        this.hitFlag = FLAG_BODY;
        this.hitShade = 0.66 - 0.36 * (d / r) ** 2;
        return true;
      }
      // Fur at the elbow, streaming back.
      const tu = eu + Math.cos(pose[k + 5]) * L * 0.05;
      const ta = ea + Math.sin(pose[k + 5]) * L * 0.05;
      if (this.segment(u, out, eu, ea, tu, ta) < thick * 0.85 * (1 - 0.75 * this.segT)) {
        this.hitFlag = FLAG_HI;
        this.hitShade = 0.7 - 0.3 * this.segT;
        return true;
      }
    }
    return false;
  }

  /** Distance from (u, a) to the segment from (u0, a0) to (u1, a1); where along it falls in segT. */
  private segment(u: number, a: number, u0: number, a0: number, u1: number, a1: number) {
    const du = u1 - u0;
    const da = a1 - a0;
    const t = clamp(((u - u0) * du + (a - a0) * da) / (du * du + da * da || 1), 0, 1);
    this.segT = t;
    return Math.hypot(u - u0 - du * t, a - a0 - da * t);
  }

  /**
   * Pose the four legs for this frame: per leg, the elbow and wrist in its root frame, the way the
   * claws point and how wide they spread, and the way the elbow tuft streams.
   *
   * A dragon flies by its body, not its legs: they don't paddle. They hold a posture, forelegs
   * reaching forward with the claws open, hind legs trailing back, and shift it slowly, the
   * claws closing and opening as if to grasp. Into a turn the forefoot on the inside reaches
   * further in and the outside one draws back. The root frames follow the swimming spine, not
   * the body wave, or the legs would swing with every S the body slides through.
   */
  private poseLegs(sh: Shark, L: number) {
    const legs = this.shape.legs!;
    const pose = this.legPose;
    const steer = clamp(sh.turn * 1.2, -0.35, 0.35);
    for (let leg = 0; leg < 4; leg++) {
      const hind = leg >= 2;
      const right = leg % 2 === 0;
      // Diagonal legs together, a quarter apart from the other pair, so they never all move at once.
      const q = sh.phase * LEG_RATE + (leg === 0 || leg === 3 ? 0 : Math.PI / 2);
      // Angles from tailward toward outward: past a right angle reaches forward.
      const reach = hind ? 0 : steer * (right ? 1 : -1);
      const upper = hind ? 1.2 + 0.08 * Math.sin(q) : 1.5 + 0.1 * Math.sin(q) + reach;
      const lower = hind ? upper - 0.7 + 0.06 * Math.sin(q - 1) : upper + 0.55 + 0.08 * Math.sin(q - 1) + reach * 0.5;
      const k = leg * LEG_POSE;
      pose[k] = Math.cos(upper) * L * legs.upper;
      pose[k + 1] = Math.sin(upper) * L * legs.upper;
      pose[k + 2] = pose[k] + Math.cos(lower) * L * legs.lower;
      pose[k + 3] = pose[k + 1] + Math.sin(lower) * L * legs.lower;
      pose[k + 4] = lower;
      pose[k + 5] = 0.25 + 0.1 * Math.sin(q - 0.6);
      // The grip: claws spread wide, then draw in, slowly.
      pose[k + 6] = 0.42 + 0.14 * Math.sin(q * 0.7 + leg);
    }
  }

  /** Steady the leg roots' frames: their tangent from the swimming spine, not the waving one. */
  private steadyLegFrames(sh: Shark) {
    const n = sh.nodes;
    for (const [frame, s] of [
      [this.pecFrame, (this.shape.pectoral[0] + this.shape.pectoral[1]) / 2],
      [this.pelFrame, (this.shape.pelvic[0] + this.shape.pelvic[1]) / 2],
    ] as const) {
      const k = clamp(Math.round(s * (SHARK_NODES - 1)), 1, SHARK_NODES - 2);
      const tx = n[(k + 1) * 2] - n[(k - 1) * 2];
      const ty = n[(k + 1) * 2 + 1] - n[(k - 1) * 2 + 1];
      const len = Math.hypot(tx, ty) || 1;
      frame.tx = tx / len;
      frame.ty = ty / len;
    }
  }

  /**
   * A dragon's horns, barbels, and the tufts its mane flares into past the flanks, at (u along,
   * a out from the spine) where the body's half-width is w. Sets the hit and returns true on one.
   */
  private inAdornment(px: number, py: number, u: number, a: number, w: number, s: number, L: number) {
    const { horns, whiskers, mane } = this.shape;
    if (horns) {
      const du = L * (horns.u1 - horns.u0);
      const da = L * (horns.a1 - horns.a0);
      const pu = u - L * horns.u0;
      const pa = a - L * horns.a0;
      const t = (pu * du + pa * da) / (du * du + da * da);
      if (t > 0 && t < 1 && Math.abs(pu * da - pa * du) / Math.hypot(du, da) < L * horns.width * (1 - 0.75 * t)) {
        this.hitFlag = FLAG_PALE;
        this.hitShade = 0.75 - 0.3 * t;
        return true;
      }
    }
    if (whiskers) {
      const t = (u - L * whiskers.u) / (L * whiskers.length);
      if (t > 0 && t < 1) {
        // Streaming back and out, a ripple running down them toward the free end, which waves most.
        // They flare out at once from the muzzle, clear of the cheeks, then run back.
        const along = L * (whiskers.a + whiskers.spread * (1 - (1 - t) ** 2) + whiskers.wave * t * Math.sin(t * 7 + this.flutter * 1.4));
        // About a cell wide, so a barbel at a slant still lands on a cell centre all the way along.
        if (Math.abs(a - along) < this.cw * 0.8 * (1 - 0.5 * t)) {
          // A solid line of light near the root, thinning to a thread toward the tip.
          this.hitFlag = t < WHISKER_SOLID ? FLAG_WHISKER : FLAG_STRAND;
          this.hitShade = t < WHISKER_SOLID ? 0.9 : 1 - t;
          return true;
        }
      }
    }
    if (mane && this.inTailLocks(px, py, L)) return true;
    if (mane && s > mane.ruff[0] && s < mane.ruff[1]) {
      // A ruff behind the head, in tufts that stream toward the tail. Solid jade, lit like the
      // mane: drawn as a fin membrane, its thin ends let the sky through and went murky.
      const [r0, r1] = mane.ruff;
      const neck = smoothstep(r0, r0 + 0.02, s) * (1 - smoothstep(r0 + 0.05, r1, s));
      const tuft = Math.max(0, Math.sin(s * 120 + this.flutter)) ** 2;
      const fringe = L * mane.size * neck * (0.6 + 0.4 * tuft);
      if (a < w + fringe) {
        this.hitFlag = FLAG_HI;
        this.hitShade = 0.75 - 0.4 * ((a - w) / Math.max(1, fringe));
        return true;
      }
    }
    return false;
  }

  /**
   * The tail's locks of hair, tested in a frame at the tail's end (along it tailward, across it
   * signed) so they run on past the tip: each fans out from a little before the tip, rippling
   * as it streams, solid near the root and a thread at the end. A filled plume blurred into one
   * mass; separate locks keep the flow of the hair.
   */
  private inTailLocks(px: number, py: number, L: number) {
    const { count, length, spread } = this.shape.mane!.tail;
    const f = this.tailFrame;
    const dx = px - f.x;
    const dy = py - f.y;
    const along = dx * f.tx + dy * f.ty + L * TAIL_ROOT;
    if (along < 0 || along > L * (length + TAIL_ROOT)) return false;
    const across = f.tx * dy - f.ty * dx;
    // Past the tip the hair keeps to the S the body slides along: the body wave carried on beyond
    // the tip, less the straight line the tail already points along. Pinned straight to the tip,
    // the locks stuck out like an ornament while the body swam on through its curves.
    const past = Math.max(0, along - L * TAIL_ROOT) / L;
    const k1 = this.tailWave.k;
    const at = this.tailWave.phase - k1;
    const flow = -this.tailWave.amp * (Math.sin(at - k1 * past) - Math.sin(at) + Math.cos(at) * k1 * past);
    for (let k = 0; k < count; k++) {
      const side = k - (count - 1) / 2;
      const len = L * (length + TAIL_ROOT) * (1 - 0.18 * Math.abs(side));
      const t = along / len;
      if (t >= 1) continue;
      const lane = flow + L * (spread * (side / ((count - 1) / 2)) * t * t + 0.01 * t * Math.sin(t * 6 + this.flutter * 1.3 + k * 1.7));
      if (Math.abs(across - lane) < this.cw * 0.85 * (1 - 0.45 * t) + 1) {
        this.hitFlag = t < HAIR_SOLID ? FLAG_HAIR : FLAG_HAIR_END;
        this.hitShade = t < HAIR_SOLID ? 0.75 - 0.3 * t : 1 - t;
        return true;
      }
    }
    return false;
  }

  /**
   * Light on a head modelled as a surface (shape.relief), at s along the body and `across` its
   * half-width w, with n the outward normal across the body and t the tailward tangent there.
   * The height is a rounded skull, 1 − across², plus a ridge down the middle (the bridge of the
   * nose) and brows over the eyes; the light is Lambert on that surface's slopes for a sun at
   * HEAD_SUN up from the horizon, from the scene's side. Shaded as the body's tube, the head was
   * one even tone from the midline to the edges, and read flat.
   */
  private headLight(s: number, across: number, nx: number, ny: number, tx: number, ty: number, w: number, L: number) {
    const { relief, eye } = this.shape;
    const { ridge, brow } = relief!;
    const eyeS = eye ? (eye[0] + eye[1]) / 2 : 0;
    const r = Math.exp(-((across / 0.2) ** 2));
    const b = Math.exp(-(((across - 0.5) / 0.18) ** 2) - ((s - eyeS) / 0.014) ** 2);
    // Height per unit across, and per unit s; the head stands about its own half-width high.
    const dAcross = -2 * across - ridge * r * ((2 * across) / 0.04) - brow * b * ((2 * (across - 0.5)) / 0.0324);
    const dS = -brow * b * ((2 * (s - eyeS)) / 0.000196);
    // Slopes in px per px: across the half-width w, and along the length L.
    const gx = dAcross * nx * HEAD_HEIGHT + ((dS * w) / L) * tx * HEAD_HEIGHT;
    const gy = dAcross * ny * HEAD_HEIGHT + ((dS * w) / L) * ty * HEAD_HEIGHT;
    // The surface normal is (−g, 1); the sun comes from (lightX, lightY) and HEAD_SUN up.
    const up = Math.sin(HEAD_SUN);
    const side = Math.cos(HEAD_SUN);
    const lambert = ((-gx * this.lightX - gy * this.lightY) * side + up) / Math.sqrt(1 + gx * gx + gy * gy);
    // Flat top about as bright as the body's lit back (0.8); faces turned well away down to 0.25.
    return clamp(0.43 + 0.58 * lambert, 0, 1);
  }

  /** The current flyer's height at s along its body, in the cloud tops' 0–1. */
  private altitude(s: number) {
    const lift = this.shape.lift!;
    const body = lift.mid + lift.swing * Math.sin(this.liftPhase - lift.k * s);
    return lift.head + (body - lift.head) * smoothstep(0.03, 0.25, s);
  }

  /**
   * A humpback flipper at (u along, a out from the spine): a long blade of nearly even width,
   * tapering a little and rounding off at the tip, swept back from the shoulder. The upper
   * side is dark skin; the leading edge, the one facing the head, is white and knobbed with
   * tubercles. Returns the cell's flag, or 0 when the point is off the flipper.
   */
  /**
   * A fin is tested in a straight frame at its root (along, out), then the sample is turned
   * about the root to pose the fin: swept by finSweep at the root and by finTipSweep more
   * toward the tip (its arch, and its lag behind the flap). Turning rather than stretching keeps
   * the fin its own length whatever the body does.
   */
  private poseFin(rootU: number, along: number, out: number, reach: number) {
    const r = Math.hypot(along, out);
    const res = this.finPose;
    if (r < 1e-6) {
      res.u = rootU;
      res.a = 0;
      return res;
    }
    const toTip = Math.min(1, r / Math.max(1, reach));
    const turn = this.finSweep + this.finTipSweep * toTip;
    const angle = clamp(Math.atan2(out, along) + turn, 0, Math.PI);
    res.u = rootU + r * Math.cos(angle);
    res.a = r * Math.sin(angle);
    return res;
  }

  /** Point and tailward unit tangent on the render spine at fraction s of its length. */
  private spineFrame(s: number, out: { x: number; y: number; tx: number; ty: number }) {
    const { spine, arc } = this;
    const target = clamp(s, 0, 1) * this.arcTotal;
    let k = 0;
    while (k < SHARK_NODES - 2 && arc[k + 1] < target) k++;
    const ax = spine[k * 2];
    const ay = spine[k * 2 + 1];
    const bx = spine[k * 2 + 2];
    const by = spine[k * 2 + 3];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const f = clamp((target - arc[k]) / len, 0, 1);
    out.x = ax + (bx - ax) * f;
    out.y = ay + (by - ay) * f;
    out.tx = (bx - ax) / len;
    out.ty = (by - ay) / len;
  }

  private inFlipper(u: number, a: number, L: number, tip: number) {
    const [p0, p1, p2] = this.shape.pectoral;
    const rootU = (L * (p0 + p1)) / 2;
    const ax = L * p2 - rootU;
    const ay = tip;
    const len2 = ax * ax + ay * ay;
    const px = u - rootU;
    const t = (px * ax + a * ay) / len2;
    if (t <= 0 || t >= 1) return 0;
    // Distance across the blade, positive on the leading edge (toward the head).
    const across = (a * ax - px * ay) / Math.sqrt(len2);
    const round = t > 0.85 ? Math.sqrt(1 - ((t - 0.85) / 0.15) ** 2) : 1;
    const half = ((L * (p1 - p0)) / 2) * (1 - 0.25 * t) * round;
    if (Math.abs(across) > half) return 0;
    if (across < half * 0.4) return FLAG_FIN;
    return t > 0.15 && (t * 7) % 1 < 0.3 ? FLAG_RIDGE : FLAG_PALE;
  }

  private inCaudal(u: number, a: number, L: number) {
    const { caudal, caudalFan } = this.shape;
    if (caudalFan === undefined) return inTriangle(u, a, L * 0.86, 0, L * 0.95, 0, L, L * caudal);
    // k runs 0 → 1 along the fan. It must stay below 1: every point past the tail tip
    // projects onto it (u = L), and taking those in would hang a disc off the tail.
    const k = (u - L * caudalFan) / (L * (1 - caudalFan));
    if (k <= 0 || k >= 1) return false;
    const spread = L * caudal;
    if (a > spread * Math.pow(k, 0.7)) return false;
    // Shallow fork: the middle of the trailing edge stops short of the lobes.
    return k < 1 - 0.25 * (1 - a / spread);
  }

  /** Skin pattern at a body point (s along, v across): 0 for plain skin, FLAG_MARK (dark) or FLAG_HI (koi red). */
  private marking(s: number, v: number, L: number, across: number) {
    const mane = this.shape.mane;
    if (mane) {
      // The mane down the back, one unbroken line from the crown to the tail tuft.
      return s > mane.from && s < 0.94 && across < mane.strip ? FLAG_HI : 0;
    }
    if (this.shape === SHAPES.tiger) {
      // Wavy vertical bars over the back half, fading out toward the head.
      if (s < 0.2 || s > 0.9 || across > 0.85) return 0;
      const wobble = 0.35 * Math.sin((v / L) * 25 + s * 5);
      const bar = Math.sin(s * Math.PI * 2 * 9 + wobble);
      return bar > 0.65 - 0.5 * smoothstep(0.2, 0.42, s) + 0.4 * smoothstep(0.8, 0.9, s) ? FLAG_MARK : 0;
    }
    if (this.shape === SHAPES.zebra) {
      // Leopard spots on a jittered grid, so they ride along with the skin.
      if (s < 0.07) return 0;
      const gu = (s * L) / (L * 0.06);
      const gv = v / (L * 0.045);
      const cu = Math.floor(gu);
      const cv = Math.floor(gv);
      const jx = hash3(cu, cv, this.sharkId) * 0.5 + 0.25;
      const jy = hash3(cu, cv, this.sharkId + 11) * 0.5 + 0.25;
      return (gu - cu - jx) ** 2 + (gv - cv - jy) ** 2 < 0.08 ? FLAG_MARK : 0;
    }
    if (this.shape === SHAPES.humpback) {
      // Tubercles: knobs scattered over the top of the head, caught by the light like the ridge.
      if (s > 0.15 || across > 0.75) return 0;
      const gu = s / 0.05;
      const gv = v / (L * 0.04);
      const cu = Math.floor(gu);
      const cv = Math.floor(gv);
      const jx = hash3(cu, cv, this.sharkId) * 0.5 + 0.25;
      const jy = hash3(cu, cv, this.sharkId + 11) * 0.5 + 0.25;
      return (gu - cu - jx) ** 2 + (gv - cv - jy) ** 2 < 0.05 ? FLAG_RIDGE : 0;
    }
    if (this.shape === SHAPES.koi) {
      // Varieties cycle by id, so any pond shows several.
      const variety = (this.sharkId - 1) % KOI_VARIETIES;
      const w = v / L;
      // Orenji ogon: orange all over, white fins and tail.
      if (variety === 3) return s < 0.82 ? FLAG_HI : 0;
      // Tancho: one red disc on the crown and nothing else.
      if (variety === 2) return (s - 0.1) ** 2 + w * w < 0.042 ** 2 ? FLAG_HI : 0;
      // Sanke: kohaku plus black sumi spots along the back.
      if (variety === 1 && s > 0.2 && s < 0.78 && valueNoise(s * 14, w * 40, this.sharkId + 7) > 0.74) return FLAG_MARK;
      // Kohaku: soft red blobs on white, the tail left clean.
      return s < 0.8 && valueNoise(s * 7, w * 18, this.sharkId) > 0.52 ? FLAG_HI : 0;
    }
    return 0;
  }

  /**
   * Build a smooth, undulating render spine from the sim spine, then
   * supersample every cell in the shark's bounding box against the shape.
   * Fully covered cells become solid skin; partial cells become edge glyphs.
   */
  private rasterizeSharks(sharks: Shark[], t: number) {
    const { sharkFlag, sharkShade, sharkKey, sharkDepth, sharkKind, sharkShadow, sharkMist, floorShade, clouds, spine, arc, cw, ch, cols, rows } = this;
    sharkFlag.fill(0);
    sharkShadow.fill(0);
    floorShade.fill(0);
    if (clouds.active) {
      clouds.shadow.fill(0);
      clouds.veil.fill(0);
    }
    const floor = !!this.scene?.floorShadow;

    for (const sh of sharks) {
      const L = sh.length;
      const N = SHARK_NODES;
      const n = sh.nodes;
      const swim = clamp(sh.speed / 60, 0.4, 1.4);
      this.shape = SHAPES[sh.kind];
      this.sharkId = sh.id;
      this.gape = sh.gape;
      const kindIndex = KINDS.indexOf(sh.kind);
      this.flutter = -t * 2.2;
      const lift = this.shape.lift;
      // The height wave keeps still in space along with the body wave, so its phase runs at
      // its own wavenumber's share of the body wave's.
      if (lift) this.liftPhase = (sh.phase * lift.k) / (this.shape.wave?.[2] ?? SLITHER_K);
      this.hitLift = 1;
      const cloudy = clouds.active && !!lift;
      if (this.shape.legs) this.poseLegs(sh, L);

      // Travelling body wave, growing toward the tail.
      for (let k = 0; k < N; k++) {
        const s = k / (N - 1);
        const a = Math.max(0, k - 1);
        const b = Math.min(N - 1, k + 1);
        let tx = n[a * 2] - n[b * 2];
        let ty = n[a * 2 + 1] - n[b * 2 + 1];
        const tl = Math.hypot(tx, ty) || 1;
        tx /= tl;
        ty /= tl;
        const [waveAmp, wavePow, waveK] = this.shape.wave ?? [0.05, 1.8, 5.2];
        const amp = L * waveAmp * (0.1 + 0.9 * Math.pow(s, wavePow)) * swim;
        const off = amp * Math.sin(sh.phase - s * waveK);
        spine[k * 2] = n[k * 2] - ty * off;
        spine[k * 2 + 1] = n[k * 2 + 1] + tx * off;
      }
      arc[0] = 0;
      for (let k = 1; k < N; k++) {
        arc[k] =
          arc[k - 1] +
          Math.hypot(spine[k * 2] - spine[(k - 1) * 2], spine[k * 2 + 1] - spine[(k - 1) * 2 + 1]);
      }
      this.arcTotal = arc[N - 1] || 1;
      const { pectoral, pelvic } = this.shape;
      this.spineFrame((pectoral[0] + pectoral[1]) / 2, this.pecFrame);
      this.spineFrame((pelvic[0] + pelvic[1]) / 2, this.pelFrame);
      if (this.shape.legs) this.steadyLegFrames(sh);
      if (this.shape.mane) {
        this.spineFrame(1 - TAIL_ROOT * 0.2, this.tailFrame);
        const [waveAmp, , waveK] = this.shape.wave ?? [0.05, 1.8, 5.2];
        this.tailWave.amp = L * waveAmp * swim;
        this.tailWave.phase = sh.phase;
        this.tailWave.k = waveK;
      }
      const motion = this.shape.finMotion ?? DEFAULT_FIN_MOTION;
      const flapPhase = sh.phase * motion.flap[1];
      // A fin grows out of the body, so sweeping its root back buries more of it under the
      // flank and it shows shorter. The root therefore only ever swings forward of rest, and
      // the arch curves the fin about its middle (tip back, root forward by half as much)
      // rather than turning it, so the visible length never drops below the resting one.
      this.finSweep = motion.flap[0] * (Math.sin(flapPhase) - 1) - motion.arch * 0.5;
      this.finTipSweep = motion.arch + motion.lag * Math.sin(flapPhase - 1.2);

      // Bank into turns. Pectorals droop below the horizontal, so from above they
      // foreshorten by cos(droop). Rolling tips the inside fin further down and levels
      // the outside one; projection only ever shortens, so a level fin shows its true
      // length and no more. The inside of a turn is the v < 0 side when bank > 0.
      const bank = clamp(sh.turn * 0.45, -0.35, 0.35);
      const droop = PECTORAL_DROOP + 0.12 * Math.sin(sh.phase * 0.5);
      const trueReach = (L * this.shape.pectoral[3]) / Math.cos(PECTORAL_DROOP);
      this.finTipRight = trueReach * Math.cos(droop - bank);
      this.finTipLeft = trueReach * Math.cos(droop + bank);
      // Rolling by `bank` radians slides the back toward the inside of the turn.
      this.rollX = -Math.sin(bank);

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let k = 0; k < N; k++) {
        minX = Math.min(minX, spine[k * 2]);
        maxX = Math.max(maxX, spine[k * 2]);
        minY = Math.min(minY, spine[k * 2 + 1]);
        maxY = Math.max(maxY, spine[k * 2 + 1]);
      }
      // Wide enough for the longest flipper even when it levels out in a bank.
      const reach = L * (this.shape.extent ?? Math.max(0.36, this.shape.pectoral[3] / Math.cos(PECTORAL_DROOP) + 0.02));
      const c0 = Math.max(0, Math.floor((minX - reach) / cw));
      const c1 = Math.min(cols - 1, Math.floor((maxX + reach) / cw));
      const r0 = Math.max(0, Math.floor((minY - reach) / ch));
      const r1 = Math.min(rows - 1, Math.floor((maxY + reach) / ch));
      if (c0 > c1 || r0 > r1) continue;

      const skipBeyond = reach + Math.hypot(cw, ch);
      // Light comes from above at the scene's angle, so the shadow falls the other way.
      const shadowDc = Math.round((-this.lightX * L * SHADOW_DROP) / cw);
      const shadowDr = Math.round((-this.lightY * L * SHADOW_DROP) / ch);
      const floorDrop = L * (FLOOR_DROP_DEEP + (FLOOR_DROP_SHALLOW - FLOOR_DROP_DEEP) * sh.depth);
      const floorDc = Math.round((-this.lightX * floorDrop) / cw);
      const floorDr = Math.round((-this.lightY * floorDrop) / ch);
      // Nearer the surface, the shadow falls further off and spreads fainter.
      const floorDark = 1.15 - 0.45 * sh.depth;

      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const x = c * cw;
          const y = r * ch;
          const centerHit = this.sampleShark(x + cw / 2, y + ch / 2, L);
          if (!centerHit && this.hitDist > skipBeyond) continue;
          const flag = this.hitFlag;
          const shade = this.hitShade;
          const s = this.hitS;
          const v = this.hitV;
          const height = this.hitLift;

          let hits = centerHit ? 1 : 0;
          for (let k = 0; k < SUBSAMPLES.length; k += 2) {
            if (this.sampleShark(x + SUBSAMPLES[k] * cw, y + SUBSAMPLES[k + 1] * ch, L)) hits++;
          }
          if (hits === 0) continue;
          const coverage = hits / 5;

          const i = r * cols + c;
          let mist = 0;
          let inCloud = false;
          if (cloudy) {
            const top = clouds.hide[i];
            if (top > 0) {
              const under = top - height;
              if (under > 0) {
                // In the cloud: veiled the deeper it goes, and gone only where the cloud is thick
                // and the body well down in it. Thin cloud never hides it outright.
                const veil = smoothstep(0, VEIL_DEPTH, under) * smoothstep(0, VEIL_THICK, top);
                if (veil > 0.999) {
                  clouds.veil[i] = 1;
                  continue;
                }
                mist = MIST_TOP + (MIST_DEEP - MIST_TOP) * veil;
                inCloud = true;
              } else {
                // Skimming the tops: the mist thins out above them.
                mist = MIST_TOP * (1 - smoothstep(0, MIST_BAND, -under));
              }
            }
          }
          // A strand, claw or lock never covers enough of a cell to be solid; its centre crossing it is enough.
          const solid =
            centerHit &&
            (coverage >= 0.6 || flag === FLAG_STRAND || flag === FLAG_CLAW || flag === FLAG_WHISKER || flag === FLAG_HAIR || flag === FLAG_HAIR_END);
          // Sharks are drawn deepest first. Where this one's soft edge crosses a deeper body,
          // keep that body and shade it instead: a dark rim, not a hole punched through it.
          if (!solid && sharkFlag[i] && sharkFlag[i] !== FLAG_EDGE) {
            sharkShadow[i] = Math.max(sharkShadow[i], sh.depth);
            continue;
          }
          // Body-anchored key so each glyph rides along with the skin.
          const key = (hash3(Math.round(s * 52), Math.round(v / (cw * 0.9)), sh.id) * 4294967295) >>> 0;
          sharkKey[i] = key;
          sharkDepth[i] = sh.depth;
          sharkKind[i] = kindIndex;
          sharkMist[i] = mist;

          if (solid) {
            sharkFlag[i] = flag;
            const flicker = (hash3(c, r, Math.floor(t * 6)) - 0.5) * 0.06;
            sharkShade[i] = clamp(shade + flicker, 0, 1);
            const sc = c + shadowDc;
            const sr = r + shadowDr;
            if (sc >= 0 && sr >= 0 && sc < cols && sr < rows) {
              const j = sr * cols + sc;
              sharkShadow[j] = Math.max(sharkShadow[j], sh.depth);
            }
            if (floor) this.castOn(floorShade, c + floorDc, r + floorDr, floorDark);
            if (cloudy && !inCloud) {
              // Sunlight past a flyer lands on the tops below, the further off the higher it flies.
              const drop = (height - Math.max(0, clouds.hide[i])) * LIFT_SHADOW * L;
              this.castOn(clouds.shadow, c + Math.round((-this.lightX * drop) / cw), r + Math.round((-this.lightY * drop) / ch), 1);
            }
          } else {
            sharkFlag[i] = FLAG_EDGE;
            sharkShade[i] = coverage;
          }
        }
      }
    }
  }

  /** Lay a soft shadow in `field` around cell (c, r): full in the cell, half beside it. */
  private castOn(field: Float32Array, c: number, r: number, dark: number) {
    const { cols, rows } = this;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const cc = c + dc;
        const rr = r + dr;
        if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) continue;
        const j = rr * cols + cc;
        const v = (dc === 0 && dr === 0 ? 1 : dc === 0 || dr === 0 ? 0.5 : 0.25) * dark;
        if (v > field[j]) field[j] = v;
      }
    }
  }

  /**
   * Leaf shade over everything in the water: the floor, the koi, the fish, the rings. It stays a
   * continuous image multiplied over the lot, not glyphs: the shrub is known by its leaves and
   * twigs, finer than a cell. A leaf's shadow slides off the stone onto a koi's back and off
   * again; the koi swim a hand's depth under the surface, too little to set them apart.
   */
  private drawShade() {
    const { ctx, canopy, shadeAmount } = this;
    const image = canopy.image;
    if (shadeAmount <= 0.001 || !image) return;
    ctx.globalCompositeOperation = "multiply";
    ctx.globalAlpha = shadeAmount;
    ctx.drawImage(image, 0, 0, canopy.imageWidth, canopy.imageHeight);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }


  /**
   * The net of light on the floor, in white beads, fuller and stronger where it is brighter;
   * under everything in the water, and not where a fish or a koi lies over it.
   */
  private drawCaustics() {
    const { ctx, caustics, cols, cw, ch, sharkFlag, fishStamp, frameId, causticStyles } = this;
    if (!caustics.active || !causticStyles.length) return;
    const level = caustics.level;
    for (let i = 0; i < level.length; i++) {
      const e = level[i];
      if (e < CAUSTIC_SHOW || sharkFlag[i] || fishStamp[i] === frameId) continue;
      const u = Math.min(0.999, Math.log(e / CAUSTIC_SHOW) / Math.log(CAUSTIC_FULL / CAUSTIC_SHOW));
      ctx.fillStyle = causticStyles[Math.floor(u * CAUSTIC_INKS)];
      ctx.fillText(CAUSTIC_GLYPHS[Math.floor(u * CAUSTIC_GLYPHS.length)], (i % cols) * cw + cw / 2, ((i / cols) | 0) * ch + ch / 2 + 1);
    }
  }

  /**
   * Sun mirrored off the ripples, on the surface over everything: a lone spark in the sun's
   * yellow. A food pellet is a brown dot that holds still; a glint flashes, `+` as it comes and
   * goes and `*` at its height, so it twinkles as the ripples pass. A glow around it would tell
   * it from food too, but it isn't drawn in glyphs, so the difference is in the glyph.
   */
  private drawGlints() {
    const { ctx, caustics, cols, cw, ch, glintStyle } = this;
    if (!caustics.active || !glintStyle) return;
    ctx.fillStyle = glintStyle;
    for (const { cell, strength } of caustics.glints) {
      ctx.fillText(strength < GLINT_PEAK ? "+" : "*", (cell % cols) * cw + cw / 2, ((cell / cols) | 0) * ch + ch / 2 + 1);
    }
  }


  /**
   * The cloud sea, per cell in the two channels everything else here uses. The fill is the
   * cloud's brightness: the sunlight on its face, darkened where a flyer's shadow falls, thinned
   * toward the sky at the wisps of an edge. It covers the whole cell, grid line and all, so the
   * cloud reads as one soft mass, apart from the tiled scales of the creatures. Over it a glyph
   * in a darker ink, sparse on the lit faces and dense in their shade, as on the skins, gives the
   * billows their grain. Not where a creature is in view over it.
   */
  private drawClouds() {
    const { ctx, clouds, cols, cw, ch, sharkFlag, cloudBuckets, cloudStyles } = this;
    if (!clouds.active || !cloudStyles.length) return;
    const { top, lit, shadow, veil } = clouds;
    for (const bucket of cloudBuckets) bucket.length = 0;
    for (let i = 0; i < top.length; i++) {
      const tp = top[i];
      if ((tp <= 0 && !veil[i]) || sharkFlag[i]) continue;
      const light = 0.15 + 0.85 * lit[i] * (1 - CLOUD_SHADOW * shadow[i]);
      // Half a step of dither per cell, so an even face doesn't print as one flat patch.
      const dither = hash3(i, 3, 41) - 0.5;
      let level = Math.floor(smoothstep(0, CLOUD_BODY, tp) * light * CLOUD_LEVELS + dither);
      // Where it hides part of a creature the cloud must show, or the creature just has a hole.
      if (veil[i]) level = Math.max(level, CLOUD_VEIL);
      if (level > 0) cloudBuckets[Math.min(CLOUD_LEVELS - 1, level)].push(i);
    }
    for (let b = 1; b < CLOUD_LEVELS; b++) {
      const bucket = cloudBuckets[b];
      if (!bucket.length) continue;
      ctx.fillStyle = cloudStyles[b];
      for (const i of bucket) ctx.fillRect((i % cols) * cw, ((i / cols) | 0) * ch, cw, ch);
    }
    for (let b = 1; b < CLOUD_LEVELS; b++) {
      const bucket = cloudBuckets[b];
      if (!bucket.length) continue;
      // The ink sits a few steps below the fill; brighter faces take less of it.
      ctx.fillStyle = cloudStyles[Math.max(0, b - CLOUD_INK)];
      const glyph = CLOUD_GLYPHS[Math.floor((1 - b / CLOUD_LEVELS) * CLOUD_GLYPHS.length)];
      for (const i of bucket) ctx.fillText(glyph, (i % cols) * cw + cw / 2, ((i / cols) | 0) * ch + ch / 2 + 1);
    }
  }

  /** Sunlight reaching cell i through the canopy, as much of its shade as falls now. */
  private sunAt(i: number) {
    return this.shadeAmount > 0.001 ? 1 - (1 - this.canopy.sun[i]) * this.shadeAmount : 1;
  }

  /** Shadows on the pond floor, under everything else in the water. */
  private drawFloorShadows() {
    const { ctx, cols, rows, cw, ch, floorShade, sharkFlag, floorStyles } = this;
    if (!floorStyles.length) return;
    const n = cols * rows;
    for (let i = 0; i < n; i++) {
      // A koi can only shade the floor where the sun reaches it.
      const v = floorShade[i] * this.sunAt(i);
      if (v <= 0 || sharkFlag[i]) continue;
      ctx.fillStyle = floorStyles[clamp(Math.floor(v * FLOOR_LEVELS.length), 0, FLOOR_LEVELS.length - 1)];
      ctx.fillRect((i % cols) * cw, ((i / cols) | 0) * ch, cw, ch);
    }
  }

  /**
   * Glyphs sorted by how much ink they lay in this font, measured rather than guessed: each is
   * drawn large and its coverage summed. INK_STEPS are kept, evenly spaced from the sparsest to
   * the densest, so the step from one to the next is the same in tone all along the ramp.
   */
  private measureInk() {
    const key = `${this.fontFamily}|${document.fonts?.status ?? ""}`;
    if (key === this.inkFont) return;
    this.inkFont = key;
    const size = 48;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = Math.round(size * 1.45);
    const g = canvas.getContext("2d", { willReadFrequently: true });
    if (!g) return;
    g.font = `600 ${Math.round(size * 0.74 * 1.45)}px ${this.fontFamily}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    const inks = [...INK_CANDIDATES].map((glyph) => {
      g.clearRect(0, 0, canvas.width, canvas.height);
      g.fillText(glyph, canvas.width / 2, canvas.height / 2);
      const data = g.getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0;
      for (let k = 3; k < data.length; k += 4) sum += data[k];
      return { glyph, ink: sum };
    });
    inks.sort((a, b) => a.ink - b.ink);
    // The blank leaves a cell bare; the ramp starts at the first glyph with any ink.
    const marks = inks.filter((m) => m.ink > 0);
    const lo = marks[0].ink;
    const hi = marks[marks.length - 1].ink;
    let ramp = "";
    for (let k = 0; k < INK_STEPS; k++) {
      const want = lo + ((hi - lo) * k) / (INK_STEPS - 1);
      let best = marks[0];
      for (const m of marks) if (!ramp.includes(m.glyph) && Math.abs(m.ink - want) < Math.abs(best.ink - want)) best = m;
      if (!ramp.includes(best.glyph)) ramp += best.glyph;
    }
    this.inkRamp = ramp;
  }

  private drawSharks(t: number) {
    const { ctx, cols, rows, cw, ch, sharkFlag, sharkShade, sharkKey, sharkDepth, sharkKind, sharkShadow } = this;
    this.measureInk();
    const n = cols * rows;
    for (let i = 0; i < n; i++) {
      const flag = sharkFlag[i];
      if (!flag) continue;
      const col = i % cols;
      const row = (i / cols) | 0;
      const x = col * cw;
      const y = row * ch;
      const key = sharkKey[i];
      const shade = sharkShade[i];
      const depth = sharkDepth[i];
      // Shaded by a creature swimming above: its shadow, or the rim where its edge crosses.
      const shadowed = sharkShadow[i] > depth + 0.001;
      // A pale floor's fill light softens the shadow one fish casts on another.
      const dim = (0.7 + 0.3 * depth) * (shadowed ? SHADOW + (1 - SHADOW) * this.ambient : 1);
      // Deep water and the mist of cloud tops skimmed are the same veil, whichever is thicker.
      const fog = Math.max(clamp((1 - depth) * FOG_RATE, 0, FOG_MAX) * this.fogStrength, this.sharkMist[i]);
      const [fogR, fogG, fogB] = this.fogRGB;
      // Glyphs fade into their own cell (or the water, for edges) as the creature goes deeper.
      ctx.globalAlpha = 1 - fog * 0.7;
      const shape = SHAPES[KINDS[sharkKind[i]]];
      const [tr, tg, tb] =
        flag === FLAG_HI || flag === FLAG_HAIR
          ? (shape.hiTint ?? HI_TINT)
          : flag === FLAG_PALE || flag === FLAG_CLAW
            ? (shape.pectoralTint ?? shape.tint)
            : flag === FLAG_FIN && shape.glossy
              ? (shape.finTint ?? GLOSSY_FIN_TINT)
              : shape.tint;

      // Colours re-roll on a staggered clock so the hide shimmers.
      const tick = Math.floor(t * 2.4 + (key % 997) / 97);
      const roll = hash3(key, tick, 7);

      if (flag === FLAG_STRAND || flag === FLAG_HAIR_END) {
        // A thread of light: near white for a barbel, jade for a lock of hair, a little brighter
        // toward the root. Dimmer, on a bright sky they read as grey specks.
        const [pr, pg, pb] = flag === FLAG_HAIR_END ? (shape.hiTint ?? HI_TINT) : shape.tint;
        const g = (190 + shade * 40) * dim;
        ctx.fillStyle = `rgb(${Math.min(255, Math.round(g * pr + (fogR - g * pr) * fog))},${Math.min(255, Math.round(g * pg + (fogG - g * pg) * fog))},${Math.min(255, Math.round(g * pb + (fogB - g * pb) * fog))})`;
        ctx.fillText(STRAND_GLYPHS[Math.min(STRAND_GLYPHS.length - 1, Math.floor(shade * STRAND_GLYPHS.length))], x + cw / 2, y + ch / 2 + 1);
        continue;
      }
      if (flag === FLAG_EDGE) {
        // Soft, anti-aliased silhouette: no block, just a light glyph.
        const set = shade >= 0.5 ? EDGE_HEAVY : EDGE_LIGHT;
        const g = (70 + shade * 80) * dim;
        ctx.fillStyle =
          roll < 0.07
            ? this.accents[key % this.accents.length]
            : `rgb(${Math.round(g * tr + (fogR - g * tr) * fog)},${Math.round(g * tg + (fogG - g * tg) * fog)},${Math.min(255, Math.round(g * tb + 6 + (fogB - g * tb - 6) * fog))})`;
        ctx.fillText(set[(key >>> 8) % set.length], x + cw / 2, y + ch / 2 + 1);
        continue;
      }

      let level: number;
      let glyph: string;
      if (flag === FLAG_RIDGE) {
        level = 226;
        // On a koi the back reads as the row of big mirror scales doitsu koi carry there.
        glyph = shape.glossy ? "o" : RIDGE_GLYPHS[(key >>> 8) % RIDGE_GLYPHS.length];
      } else if (flag === FLAG_EYE) {
        level = 12;
        glyph = "o";
      } else if (flag === FLAG_MARK) {
        level = 24 + shade * 22;
        glyph = MARK_GLYPHS[(key >>> 8) % MARK_GLYPHS.length];
      } else if (flag === FLAG_FIN) {
        level = 40 + shade * 120;
        glyph = FIN_GLYPHS[(key >>> 8) % FIN_GLYPHS.length];
        if (shape.glossy) {
          // A white translucent membrane with fine rays; mixed below with a little of whatever
          // lies behind it, dark water or a pale floor.
          // shade is the membrane's thickness here: the glyphs thin out toward the rim with it.
          level = GLOSSY_FIN_LEVEL;
          const jitter = ((key >>> 4) % 3) - 1;
          glyph = GLOSSY_FIN_RAMP[clamp(Math.floor(shade * (GLOSSY_FIN_RAMP.length - 0.01)) + jitter, 0, GLOSSY_FIN_RAMP.length - 1)];
        }
      } else {
        level = 46 + shade * 160;
        const jitter = ((key >>> 4) % 3) - 1;
        const ramp = shape.measuredInk ? this.inkRamp : shape.glossy ? GLOSSY_RAMP : SKIN_RAMP;
        // Claws and barbels are extremities, fine at the ends: the sparse third of the ramp.
        const span = flag === FLAG_CLAW || flag === FLAG_WHISKER ? ramp.length / 3 : ramp.length;
        // On a measured ramp, ink rises steeply only into the shade, as in ASCII art: most of a lit
        // body stays sparse and its shaded flank turns dense, which is what gives it volume. Taken
        // straight, the lit middle of a round body landed mid-ramp and the whole dragon went grey.
        const ink = shape.measuredInk ? Math.pow(1 - shade, INK_CURVE) : 1 - shade;
        glyph = ramp[clamp(Math.floor(ink * (span - 0.01)) + jitter, 0, Math.ceil(span) - 1)];
      }
      level *= dim;
      // Fill light from a pale floor lifts unlit skin most and lit skin least. Pigment (black
      // sumi, the eye) stays dark: fill light brightens light, it doesn't bleach colour.
      if (flag !== FLAG_EYE && flag !== FLAG_MARK) level += (FILL_LEVEL - level) * this.ambient * (1 - 0.6 * shade);
      // Tinted per species; the classic tint is a cool blue-grey, like a back seen through deep water.
      let skinR = Math.min(255, Math.round(level * tr));
      let skinG = Math.min(255, Math.round(level * tg));
      let skinB = Math.min(255, Math.round(level * tb + 4));
      if (flag === FLAG_FIN && shape.glossy) {
        const [wr, wg, wb] = this.waterRGB;
        const see = GLOSSY_FIN_SEE + (GLOSSY_FIN_SEE_EDGE - GLOSSY_FIN_SEE) * (1 - shade);
        skinR = Math.round(skinR + (wr - skinR) * see);
        skinG = Math.round(skinG + (wg - skinG) * see);
        skinB = Math.round(skinB + (wb - skinB) * see);
      }
      // The block is opaque, so it takes the fog itself rather than through alpha.
      ctx.globalAlpha = 1;
      ctx.fillStyle = `rgb(${Math.round(skinR + (fogR - skinR) * fog)},${Math.round(skinG + (fogG - skinG) * fog)},${Math.round(skinB + (fogB - skinB) * fog)})`;
      ctx.fillRect(x + 1, y + 1, cw - 1, ch - 1);
      ctx.globalAlpha = 1 - fog * 0.7;

      let color: string;
      if (flag === FLAG_EYE) color = shape.eyeInk ?? "#9aa0ad";
      else if (flag === FLAG_MARK) color = `rgb(${Math.round(70 * tr)},${Math.round(70 * tg)},${Math.round(70 * tb)})`;
      else if (roll < 0.09) color = this.accents[key % this.accents.length];
      else if (roll < 0.13) color = "#ffffff";
      else if (shape.glossy) {
        const inkK = shape.measuredInk ? MEASURED_INK : GLOSSY_INK;
        color = `rgb(${Math.round(skinR * inkK)},${Math.round(skinG * inkK)},${Math.round(skinB * inkK)})`;
      } else color = shade > 0.55 ? "#0e0f13" : "#1b1d24";
      ctx.fillStyle = color;
      ctx.fillText(glyph, x + cw / 2, y + ch / 2 + 1);
    }
    ctx.globalAlpha = 1;
  }

  /** Rising air shows as faint specks; at the surface it foams as O → o → ° and fades. */
  private drawBubbles(world: World) {
    const { ctx, cw, ch, bubbleStyles } = this;
    for (const b of world.bubbles) {
      const c = Math.floor(b.x / cw);
      const r = Math.floor(b.y / ch);
      if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) continue;
      let glyph: string;
      let level: number;
      if (b.age < BUBBLE_RISE) {
        glyph = ".";
        level = 0;
      } else {
        const a = (b.age - BUBBLE_RISE) / BUBBLE_LIFE;
        glyph = a < 0.12 ? "O" : a < 0.55 ? "o" : "°";
        level = clamp(Math.floor((1 - a) * bubbleStyles.length), 0, bubbleStyles.length - 1);
      }
      ctx.fillStyle = bubbleStyles[level];
      ctx.fillText(glyph, c * cw + cw / 2, r * ch + ch / 2 + 1);
    }
  }

  // ── fish, dots, heat ────────────────────────────────────────────────

  /**
   * Snap each fish to a cell and bucket it by brightness: far fish are dim,
   * near fish brighter, and turning or panicking fish glint. Nearer fish
   * claim a cell first when two land in the same one.
   */
  private markFish(world: World) {
    const { fishStamp, fishBuckets, sharkFlag, foodCells } = this;
    const species = world.scene.species;
    const frame = ++this.frameId;
    for (const bucket of fishBuckets) bucket.length = 0;
    foodCells.length = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (const f of world.fish) {
        if (!f.alive || (f.depth > 0.78 ? 0 : 1) !== pass) continue;
        const i = this.cellIndex(f.x, f.y);
        if (i < 0 || fishStamp[i] === frame || sharkFlag[i]) continue;
        fishStamp[i] = frame;
        if (species[f.species].food) {
          foodCells.push(i);
          continue;
        }
        const glint = clamp(Math.abs(f.turn) / 3.5, 0, 1);
        const v = 0.3 + (0.4 * (f.depth - 0.55)) / 0.45 + 0.3 * Math.max(glint, f.alarm);
        fishBuckets[clamp(Math.floor(v * FISH_ALPHAS.length), 0, FISH_ALPHAS.length - 1)].push(i);
      }
    }
  }

  private drawFish() {
    const { ctx, cw, ch, cols, fishBuckets } = this;
    for (let b = 0; b < fishBuckets.length; b++) {
      const bucket = fishBuckets[b];
      if (!bucket.length) continue;
      ctx.fillStyle = this.fishStyles[b];
      for (const i of bucket) {
        ctx.fillText("-", (i % cols) * cw + cw / 2, ((i / cols) | 0) * ch + ch / 2 + 1);
      }
    }
    ctx.fillStyle = this.foodStyle;
    for (const i of this.foodCells) {
      ctx.fillText(FOOD_GLYPH, (i % cols) * cw + cw / 2, ((i / cols) | 0) * ch + ch / 2 + 1);
    }
  }

  private drawHeat() {
    const { ctx, heat, cols, cw, ch } = this;
    for (let i = 0; i < heat.length; i++) {
      const h = heat[i];
      if (h < 0.08) continue;
      const col = i % cols;
      const row = (i / cols) | 0;
      ctx.fillStyle = h > 0.5 ? `rgba(255,120,60,${h.toFixed(2)})` : `rgba(220,40,40,${(h * 1.6).toFixed(2)})`;
      ctx.fillText(h > 0.6 ? "*" : "·", col * cw + cw / 2, row * ch + ch / 2 + 1);
    }
  }

  /**
   * Every cell's dot twinkles on its own clock, is modulated by slow
   * caustic light bands, and flares cyan where the wake field is strong.
   * Dots are bucketed by colour/alpha so each bucket is one fillStyle.
   */
  private drawDots(t: number) {
    const { ctx, cols, rows, cw, ch, dotKind, dotPhase, dotFreq, energy, sharkFlag, sharkShadow, fishStamp, frameId } = this;
    const { bucketOf, bucketOrder, bucketCounts } = this;
    // A cloud sea's field only parts the clouds; it never glows.
    if (this.scene?.water === "cloud") return;
    const n = cols * rows;
    const SKIP = bucketCounts.length - 1;
    bucketCounts.fill(0);
    // Wake glows once it builds up; on ripple water only the crests show, as rings.
    const ripple = this.scene?.water === "ripple";
    const show = ripple ? RIPPLE_SHOW : 0.45;
    const gain = ripple ? RIPPLE_GAIN : 5;

    for (let i = 0; i < n; i++) {
      const e = energy[i];
      const kind = dotKind[i];
      if (sharkFlag[i] || fishStamp[i] === frameId || (kind === 0 && e < show)) {
        bucketOf[i] = SKIP;
        continue;
      }
      let bucket: number;
      if (e > show) {
        const level = clamp(Math.floor((e - show) * gain), 0, ALPHA_LEVELS - 1);
        bucket = WAKE * ALPHA_LEVELS + level;
      } else {
        const col = i % cols;
        const row = (i / cols) | 0;
        // Dots stay bright and crisp; the twinkle is a gentle breathe, not a fade.
        const twinkle = 0.5 + 0.5 * Math.sin(t * dotFreq[i] + dotPhase[i]);
        const caustic = 0.85 + 0.15 * Math.sin(col * 0.11 + t * 0.35) * Math.sin(row * 0.17 - t * 0.27);
        let v = clamp((0.55 + 0.45 * twinkle) * caustic + e * 2, 0, 1);
        if (sharkShadow[i]) v *= 0.2;
        bucket = (kind - 1) * ALPHA_LEVELS + clamp(Math.floor(v * ALPHA_LEVELS), 0, ALPHA_LEVELS - 1);
      }
      bucketOf[i] = bucket;
      bucketCounts[bucket]++;
    }

    // Counting sort cells by bucket.
    const starts = new Int32Array(bucketCounts.length);
    for (let b = 1; b < bucketCounts.length; b++) starts[b] = starts[b - 1] + bucketCounts[b - 1];
    const cursor = starts.slice();
    for (let i = 0; i < n; i++) {
      const b = bucketOf[i];
      if (b !== SKIP) bucketOrder[cursor[b]++] = i;
    }

    const small = Math.max(2, Math.round(cw * 0.19));
    const large = small + 1;
    for (let b = 0; b < SKIP; b++) {
      const count = bucketCounts[b];
      if (!count) continue;
      ctx.fillStyle = this.dotStyles[b];
      const size = b >= WAKE * ALPHA_LEVELS ? large : small;
      const start = starts[b];
      for (let k = start; k < start + count; k++) {
        const i = bucketOrder[k];
        const col = i % cols;
        const row = (i / cols) | 0;
        // Sit the dot low-right in its cell, as in the reference.
        ctx.fillRect(Math.round(col * cw + cw * 0.66 - size / 2), Math.round(row * ch + ch * 0.64 - size / 2), size, size);
      }
    }
  }
}
