/**
 * A sea of cloud in the sun, seen from above. Its tops are a height field of value noise, warped
 * so the billows swirl, drawn out along the wind into bands, and gathered into groups with open
 * sky between. The noise drifts with the wind and each octave works at its own pace, so the
 * billows change shape as they go rather than sliding past whole. Where the sky opens on a new
 * scene is picked, among a few random starts, for the one whose cloud balances the creatures
 * across the frame, so the picture doesn't open lopsided.
 *
 * It is drawn per character cell (renderer.ts, drawClouds): a fill for the cloud's brightness, the
 * sunlight on the slope of its tops, so the billows stand out lit on one side and dim on the
 * other; and over it a grain of glyphs, as on the creatures' skins.
 *
 * The tops are also a surface for things to go behind: anything flying lower than the cloud
 * top in a cell is hidden in it (the renderer compares), and anything above casts a shadow on
 * it, here in `shadow`.
 */
import { clamp, valueNoise } from "./math";
import type { RGB } from "./scene";

/**
 * Octaves of billow, each this much finer than the last and this much fainter. Past the first,
 * each folds about its middle (|2n − 1|), a crease along every zero, so the tops break into the
 * round puffs of cumulus seen from above instead of one smooth swell.
 */
const OCTAVES = 5;
const LACUNARITY = 2.03;
const GAIN = 0.45;
/** The mean of a folded octave, |2n − 1| of value noise (measured). */
const FOLD_MEAN = 0.357;
/** Octaves of the tops a flyer goes under; the finer ones only texture the cloud. */
const HIDE_OCTAVES = 2;
/** How far the billows swirl, in lattice units of the biggest one. */
const WARP = 1.1;
/** Lattice units a second each octave works by; the finer ones a little faster. */
const EVOLVE = 0.025;
/** Random starts settle() weighs, and the share of the sky it expects cloud to cover. */
const SETTLE_TRIES = 12;
const SETTLE_COVER = 0.35;
/** How much a unit of parting (energy left by a click or the pointer) lowers the tops. */
const PART = 0.7;

export interface Clouds {
  /** Tops turned to the sun, and turned away. */
  lit: RGB;
  dim: RGB;
  /** Noise level (about 0.5 on average) above which there is cloud; lower covers more sky. */
  floor: number;
  /** Noise above the floor at which a cloud is at its thickest. */
  depth: number;
  /** The biggest billows, as a fraction of the screen's short side. */
  scale: number;
  /**
   * Billows drawn out along `bearing` (radians, screen y down) by `stretch`, so the cloud lies in
   * bands and streets with the wind, as a cloud sea does, rather than in round heaps.
   */
  bands: { bearing: number; stretch: number };
  /**
   * Clouds gather in groups `scale` short sides across, with open sky between: the noise rises
   * and falls by up to `amount` over that scale, so some of the sky is full and some nearly bare.
   */
  groups: { scale: number; amount: number };
  /** How strongly the billows' faces turn to the light: lit = 0.5 + slope toward the sun (per px) × relief. */
  relief: number;
}

export class CloudField {
  /** Height of the cloud top in each cell, 0 at the edge to 1 at its thickest; below 0 in open sky. */
  top = new Float32Array(0);
  /**
   * The tops without their finest billows, what a flyer goes into. Cut against the full tops, a
   * body diving in broke up cell by cell along a ragged line; against these it goes under cleanly.
   */
  hide = new Float32Array(0);
  /** The cloud surface the tops are cut from, unclipped: its slopes are what the sun lights. */
  private surface = new Float32Array(0);
  /** How squarely each cell's top faces the sun, 0–1. */
  lit = new Float32Array(0);
  /** Shadow cast on the tops this frame, 0–1; whatever flies above fills it in. */
  shadow = new Float32Array(0);
  /** Cells where the cloud hides something this frame: drawn however faint the cloud, never a hole. */
  veil = new Uint8Array(0);
  private spec: Clouds | null = null;
  /** Where in the noise this sky starts, px; picked by settle(). */
  private origin = { x: 0, y: 0 };
  private lightX = 0;
  private lightY = 0;
  private cols = 0;
  private rows = 0;
  private cw = 1;
  private ch = 1;
  private width = 0;
  private height = 0;

  get active() {
    return this.spec !== null;
  }

  set(spec: Clouds | null, light: [number, number]) {
    this.spec = spec;
    [this.lightX, this.lightY] = light;
  }

  resize(cols: number, rows: number, cw: number, ch: number, width: number, height: number) {
    this.cols = cols;
    this.rows = rows;
    this.cw = cw;
    this.ch = ch;
    this.width = width;
    this.height = height;
    const n = cols * rows;
    this.top = new Float32Array(n);
    this.hide = new Float32Array(n);
    this.surface = new Float32Array(n);
    this.lit = new Float32Array(n);
    this.shadow = new Float32Array(n);
    this.veil = new Uint8Array(n);
  }

  /**
   * Pick where this sky starts in the noise: of a few random starts, the one whose cloud covers
   * about its usual share and is weighted against whatever already fills the frame, `counter`
   * (its centre, as fractions from the middle, −0.5…0.5): a dragon on the right wants its cloud
   * to the left, so the picture doesn't open with all its weight down one side.
   */
  settle(random: () => number, counter: { x: number; y: number }) {
    if (!this.spec || this.top.length === 0) return;
    const { cols, rows, top } = this;
    const still = new Float32Array(top.length);
    const span = 20 * Math.min(this.width, this.height);
    let best = Infinity;
    let pick = { x: 0, y: 0 };
    for (let k = 0; k < SETTLE_TRIES; k++) {
      this.origin = { x: random() * span, y: random() * span };
      this.update(0, 0, 0, still);
      let n = 0;
      let cx = 0;
      let cy = 0;
      for (let i = 0; i < top.length; i++) {
        if (top[i] <= 0) continue;
        n++;
        cx += (i % cols) / cols - 0.5;
        cy += ((i / cols) | 0) / rows - 0.5;
      }
      const cover = n / top.length;
      // Off-centre weight, plus how far the cover strays from its usual share.
      const score = n ? Math.hypot(cx / n + counter.x * 0.5, cy / n + counter.y * 0.5) + 2 * Math.abs(cover - SETTLE_COVER) : Infinity;
      if (score < best) {
        best = score;
        pick = this.origin;
      }
    }
    this.origin = pick;
  }

  /** The tops at time t, carried (driftX, driftY) px downwind, and lowered where `parted`. */
  update(t: number, driftX: number, driftY: number, parted: Float32Array) {
    const { spec, cols, rows, cw, ch, top, hide, surface, lit } = this;
    if (!spec) return;
    const short = Math.min(this.width, this.height);
    const unit = spec.scale * short;
    // Billows are laid out in the frame of their bands: drawn out along `bearing`, narrow across it.
    const along = Math.cos(spec.bands.bearing);
    const across = Math.sin(spec.bands.bearing);
    const stretch = spec.bands.stretch;
    const groupUnit = spec.groups.scale * short;
    let norm = 0;
    for (let o = 0, a = 1; o < OCTAVES; o++, a *= GAIN) norm += a;

    for (let r = 0; r < rows; r++) {
      const y = r * ch + ch / 2;
      for (let c = 0; c < cols; c++) {
        const x = c * cw + cw / 2;
        const dx = x - driftX - this.origin.x;
        const dy = y - driftY - this.origin.y;
        let qx = (dx * along + dy * across) / (unit * stretch);
        let qy = (dy * along - dx * across) / unit;
        // Swirl the billows: shift each point by a slower noise of its own.
        const wx = valueNoise(qx * 0.5 + 3.1, qy * 0.5 + t * EVOLVE * 0.4, 5) - 0.5;
        const wy = valueNoise(qx * 0.5 - t * EVOLVE * 0.4, qy * 0.5 + 7.7, 6) - 0.5;
        qx += wx * WARP;
        qy += wy * WARP;
        let sum = 0;
        let coarse = 0;
        for (let o = 0, a = 1, f = 1; o < OCTAVES; o++, a *= GAIN, f *= LACUNARITY) {
          const e = t * EVOLVE * (1 + 0.5 * o);
          const v = valueNoise(qx * f + e, qy * f - e * 0.7, 11 + o);
          const n = a * (o === 0 ? v : Math.abs(2 * v - 1));
          sum += n;
          // The fine octaves' share is taken at its mean, so the smoothed tops sit at the same height.
          coarse += o < HIDE_OCTAVES ? n : a * FOLD_MEAN;
        }
        const i = r * cols + c;
        // Clouds gather in groups with open sky between, a slower field drifting with the rest.
        const group = spec.groups.amount * (valueNoise(dx / groupUnit, dy / groupUnit + t * EVOLVE * 0.2, 21) - 0.5);
        const pile = group - parted[i] * PART;
        surface[i] = sum / norm + pile;
        top[i] = Math.min(1, (surface[i] - spec.floor) / spec.depth);
        hide[i] = Math.min(1, (coarse / norm + pile - spec.floor) / spec.depth);
      }
    }

    // Sunlight on the tops: the slope of the cloud surface toward the sun, from neighbouring
    // cells. Taken from the whole surface, not the clipped tops, so the inside of a cloud is
    // as billowed as its edges.
    const { lightX, lightY } = this;
    const gain = spec.relief;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (top[i] <= 0) continue;
        const left = surface[c > 0 ? i - 1 : i];
        const right = surface[c < cols - 1 ? i + 1 : i];
        const up = surface[r > 0 ? i - cols : i];
        const down = surface[r < rows - 1 ? i + cols : i];
        const hx = (right - left) / (2 * cw);
        const hy = (down - up) / (2 * ch);
        // A face tipped toward the sun is lit: its normal leans (−hx, −hy) and the sun is at (lightX, lightY).
        lit[i] = clamp(0.5 - (hx * lightX + hy * lightY) * gain, 0, 1);
      }
    }
  }
}

// A shade off pure white, so the dragon is the whitest thing in the sky.
export const SUNLIT_CLOUDS: Clouds = {
  lit: [240, 244, 250],
  dim: [156, 178, 210],
  // About a third of the sky, in a few banded groups (cloud-lab).
  floor: 0.56,
  depth: 0.22,
  scale: 0.42,
  bands: { bearing: 0.35, stretch: 2.2 },
  // Strongly grouped: a few bodies of cloud with clear sky between, not a scatter of small puffs.
  groups: { scale: 1.1, amount: 0.55 },
  // Spreads the faces' light from about 0.1 (p10) to 0.9 (p90), few clipped.
  relief: 250,
};
