/**
 * Sunlight on a rippled pond: caustics on the floor and glints on the surface, both read off the
 * surface the ripple field already simulates, so a raindrop, a koi's tail or a gust that rings
 * the water also rings the light. Worked out as light, drawn as the rest of the pond is: per
 * character cell, in glyphs and colour, so it sits in the same picture as the koi.
 *
 * Caustics. Each ray of sun bends where it enters the water, by the slope of the surface there,
 * and lands on the floor displaced in proportion. Rays are laid over the surface on a grid, each
 * displaced by the slope under it and splatted onto the floor; where neighbours converge (under
 * a trough, which acts as a lens) the floor gathers more light than its share, in bright lines
 * that knot into a net. Still water spreads them evenly and shows nothing.
 *
 * The net of a sunny pool or pond on a breezy day isn't the rings of a raindrop: thin lines knot
 * into uneven cells that drift and twist. It comes from chop, many small waves crossing from
 * around the wind's way at once, and the light is bent by that chop (`Swell`) as well as by the
 * ripples the pond simulates, so a raindrop or a koi's wake still stirs the net it lies on. A
 * pond's chop comes and goes in patches with the gusts, so the net does too, and leaves the
 * floor clear between them. The chop's waves travel as water waves do, the long ones
 * faster, so the net works and changes rather than sliding along whole. Its mesh is as wide as the waves that make it, so the light is bent by
 * a smoothed surface: the wind's fine roughness would knit it into a dense, small-meshed lace.
 * Each cell shows the brightest light that fell in it, so a line a few px wide still reads as a
 * line of white glyphs. The rays focus over a depth, not just under the surface, so the net is on the
 * floor; the koi, a hand's depth down, swim over it clean.
 *
 * Glints. Seen from straight above, the sun shows in the water only where the surface tips
 * toward it steeply enough to mirror it upward: on the faces of ripples turned to the sun, in
 * flashes that come and go as the ripples pass. Each is a cell where the glint field peaks, on
 * the surface over everything.
 *
 * Both need direct sun: where a tree shades the pond, there are neither.
 */
import { clamp, smoothstep } from "./math";
import type { RGB } from "./scene";
import type { RippleField } from "./ripple";

/** Screen px between rays, and between samples of the floor's light. */
const RAY_PX = 5;
/** Glints weaker than this at their peak are not drawn, nor within GLINT_APART cells of a brighter one. */
const GLINT_MIN = 0.35;
const GLINT_APART = 3;
/** Passes of a 1-2-1 blur over the surface's slopes before they bend the light. */
const SMOOTH = 3;

/** Wind chop: waves crossing from around the wind's way, which only the light is bent by. */
export interface Swell {
  count: number;
  /** Shortest and longest wave, px. */
  wavelength: [number, number];
  /** Each wave's steepness (height per px at its peak), in a full breeze and in a still one. */
  slope: number;
  still: number;
  /** Speed of a wave 200 px long, px/s; others go as the root of their length. */
  speed: number;
  /** The way the chop runs (radians, screen y down) and how widely its waves fan about it. */
  bearing: number;
  spread: number;
}

export interface Caustics {
  /** How far a ray lands from straight down per unit of slope, px: the floor's depth, in effect. */
  focus: number;
  /**
   * Slopes toward the sun (height per px) where glints begin and reach full strength: only the
   * steepest few in a thousand of the surface's faces, so glints come as sparks, not a sheen.
   * On this pond the slope toward the sun is under 0.005 for 99% of it and 0.008 for 99.9%.
   */
  glint: [number, number];
  /** The colour the net of light is drawn in on the floor. */
  ink: RGB;
  swell: Swell;
  /**
   * The colour of a glint's spark: the sun's yellow, apart from the white net, the dark rings
   * and the brown of the food; its glow is what marks it as light.
   */
  glintInk: RGB;
}

export class CausticsField {
  /** Light gathered in each character cell beyond its share (0 = still water's), sun taken in. */
  level = new Float32Array(0);
  /** This frame's glints: the cell each is in and its strength, 0–1. */
  glints: { cell: number; strength: number }[] = [];
  private spec: Caustics | null = null;
  private lightX = 0;
  private lightY = -1;
  private cols = 0;
  private rows = 0;
  private cw = 1;
  private ch = 1;
  private w = 0;
  private h = 0;
  /** Light gathered on the floor per sample (1 = its share under still water). */
  private gathered = new Float32Array(0);
  private glint = new Float32Array(0);
  private gx = new Float32Array(0);
  private gy = new Float32Array(0);
  private tmp = new Float32Array(0);
  private perCell = new Float32Array(0);
  private peak = new Float32Array(0);
  /** How rough the chop is at each ripple node this frame. */
  private rough = new Float32Array(0);
  /** The chop's waves: direction, wavenumber, angular speed and phase, and their column tables. */
  private waves: { dx: number; dy: number; k: number; omega: number; phase: number; weight: number }[] = [];
  private colSin: Float32Array[] = [];
  private colCos: Float32Array[] = [];
  private tableCols = 0;

  get active() {
    return this.spec !== null;
  }

  set(spec: Caustics | null, light: [number, number]) {
    this.spec = spec;
    const l = Math.hypot(light[0], light[1]) || 1;
    this.lightX = light[0] / l;
    this.lightY = light[1] / l;
    this.level.fill(0);
    this.glints.length = 0;
    this.waves = [];
    this.tableCols = 0;
    if (!spec) return;
    // Fixed once per scene from a seed: the same pond has the same chop.
    let seed = 41;
    const r = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const sw = spec.swell;
    for (let i = 0; i < sw.count; i++) {
      const a = sw.bearing + ((i + 0.5) / sw.count - 0.5) * 2 * sw.spread + (r() - 0.5) * 0.4;
      const lambda = sw.wavelength[0] + (sw.wavelength[1] - sw.wavelength[0]) * r();
      const k = (2 * Math.PI) / lambda;
      // Uneven strengths, so no one spacing rules and the cells come out of every size.
      this.waves.push({ dx: Math.cos(a), dy: Math.sin(a), k, omega: k * sw.speed * Math.sqrt(lambda / 200), phase: r() * 6.283, weight: 0.5 + 0.8 * r() });
    }
  }

  resize(cols: number, rows: number, cw: number, ch: number, width: number, height: number) {
    Object.assign(this, { cols, rows, cw, ch });
    this.level = new Float32Array(cols * rows);
    this.perCell = new Float32Array(cols * rows);
    this.peak = new Float32Array(cols * rows);
    this.w = Math.ceil(width / RAY_PX) + 1;
    this.h = Math.ceil(height / RAY_PX) + 1;
    this.gathered = new Float32Array(this.w * this.h);
    this.glint = new Float32Array(this.w * this.h);
  }

  /**
   * Bend the sun through the surface as it is at time t. The chop is as rough as `breeze` (0
   * still, 1 the scene's wind) and the gusts make it: `gust(x, y)`, 0–1, is how hard the wind
   * blows at a point. `sun(cell)` is the direct sun in a cell, 0–1.
   */
  update(ripple: RippleField, t: number, breeze: number, gust: (x: number, y: number) => number, sun: (cell: number) => number) {
    const { spec, w, h, gathered, glint } = this;
    if (!spec || w === 0) return;
    const { cols: gc, rows: gr, size } = ripple.grid;
    if (this.gx.length !== gc * gr) {
      this.gx = new Float32Array(gc * gr);
      this.gy = new Float32Array(gc * gr);
      this.tmp = new Float32Array(gc * gr);
    }
    const { gx, gy } = this;
    ripple.slopes(gx, gy);
    for (let k = 0; k < SMOOTH; k++) {
      this.smooth(gx, gc, gr);
      this.smooth(gy, gc, gr);
    }
    // The wind roughens a pond in patches, where its gusts come down, and leaves the rest glassy:
    // so the net lies where a gust is passing, and between gusts the floor is clear.
    if (this.rough.length !== gc * gr) this.rough = new Float32Array(gc * gr);
    const { still, slope } = spec.swell;
    for (let r = 0; r < gr; r++) {
      for (let c = 0; c < gc; c++) this.rough[r * gc + c] = still + (slope - still) * breeze * gust(c * size, r * size);
    }
    this.chop(gc, gr, size, t);

    gathered.fill(0);
    for (let j = 0; j < h; j++) {
      const y = (j + 0.5) * RAY_PX;
      const v = clamp(y / size, 0, gr - 1.001);
      const r = Math.floor(v);
      const fy = v - r;
      for (let i = 0; i < w; i++) {
        const x = (i + 0.5) * RAY_PX;
        const u = clamp(x / size, 0, gc - 1.001);
        const c = Math.floor(u);
        const fx = u - c;
        const k = r * gc + c;
        // The slope under the ray, bilinearly between the nodes, so the net comes out smooth.
        const sx = (gx[k] * (1 - fx) + gx[k + 1] * fx) * (1 - fy) + (gx[k + gc] * (1 - fx) + gx[k + gc + 1] * fx) * fy;
        const sy = (gy[k] * (1 - fx) + gy[k + 1] * fx) * (1 - fy) + (gy[k + gc] * (1 - fx) + gy[k + gc + 1] * fx) * fy;
        // Where it lands, in samples, shared bilinearly among the four around.
        const lx = (x + sx * spec.focus) / RAY_PX - 0.5;
        const ly = (y + sy * spec.focus) / RAY_PX - 0.5;
        const a = Math.floor(lx);
        const b = Math.floor(ly);
        const tx = lx - a;
        const ty = ly - b;
        if (a >= 0 && b >= 0 && a + 1 < w && b + 1 < h) {
          const m = b * w + a;
          gathered[m] += (1 - tx) * (1 - ty);
          gathered[m + 1] += tx * (1 - ty);
          gathered[m + w] += (1 - tx) * ty;
          gathered[m + w + 1] += tx * ty;
        }
      }
    }

    // Glints are mirror-sharp: they come off the surface as it is, not the smoothed one.
    ripple.slopes(gx, gy);
    const [g0, g1] = spec.glint;
    for (let j = 0; j < h; j++) {
      const r = Math.min(gr - 1, Math.round(((j + 0.5) * RAY_PX) / size));
      for (let i = 0; i < w; i++) {
        const k = r * gc + Math.min(gc - 1, Math.round(((i + 0.5) * RAY_PX) / size));
        // The surface tips toward the sun where it falls away from it: the normal leans sunward.
        glint[j * w + i] = smoothstep(g0, g1, -(gx[k] * this.lightX + gy[k] * this.lightY));
      }
    }

    // Each cell takes the light that fell in it, half its average and half its brightest: the
    // brightest alone would wash a thin line out to nothing in a wide cell, the average alone
    // would square every line off to the cell. A wide soft line then spans several cells and
    // fades at its edges, a thin one stays thin: the light gives each line its own width.
    const { cols, rows, cw, ch, level, perCell, peak } = this;
    level.fill(0);
    perCell.fill(0);
    peak.fill(0);
    for (let j = 1; j < h - 1; j++) {
      const row = Math.floor(((j + 0.5) * RAY_PX) / ch);
      if (row >= rows) break;
      for (let i = 1; i < w - 1; i++) {
        const col = Math.floor(((i + 0.5) * RAY_PX) / cw);
        if (col >= cols) break;
        const cell = row * cols + col;
        const e = Math.max(0, gathered[j * w + i] - 1);
        level[cell] += e;
        perCell[cell]++;
        if (e > peak[cell]) peak[cell] = e;
      }
    }
    for (let i = 0; i < level.length; i++) {
      level[i] = perCell[i] ? (0.5 * level[i]) / perCell[i] + 0.5 * peak[i] : 0;
      if (level[i] > 0) level[i] *= sun(i);
    }

    // A glint where the field peaks, brightest first, none within GLINT_APART cells of another:
    // a steep face lights a patch of samples, and they would come out as a clump, not a spark.
    const peaks: { cell: number; strength: number }[] = [];
    for (let j = 1; j < h - 1; j++) {
      for (let i = 1; i < w - 1; i++) {
        const k = j * w + i;
        const g = glint[k];
        if (g < GLINT_MIN || g < glint[k - 1] || g < glint[k + 1] || g < glint[k - w] || g < glint[k + w]) continue;
        const row = Math.floor(((j + 0.5) * RAY_PX) / ch);
        const col = Math.floor(((i + 0.5) * RAY_PX) / cw);
        if (row >= rows || col >= cols) continue;
        const cell = row * cols + col;
        const strength = g * sun(cell);
        if (strength >= GLINT_MIN) peaks.push({ cell, strength });
      }
    }
    peaks.sort((a, b) => b.strength - a.strength);
    this.glints.length = 0;
    for (const p of peaks) {
      const c = p.cell % cols;
      const r = (p.cell / cols) | 0;
      const near = this.glints.some((q) => Math.abs((q.cell % cols) - c) <= GLINT_APART && Math.abs(((q.cell / cols) | 0) - r) <= GLINT_APART);
      if (!near) this.glints.push(p);
    }
  }

  /**
   * Add the chop's slopes at the ripple grid's nodes. A wave's height A·cos(k·p − ωt + φ) has the
   * slope −A·k·sin(…) along its way; sin(a + b) splits into a column part (a = k·dx·x, fixed) and
   * a row part (b = k·dy·y − ωt + φ, per frame), so each node costs two multiplies a wave.
   */
  private chop(gc: number, gr: number, size: number, t: number) {
    const { gx, gy, waves, rough } = this;
    if (this.tableCols !== gc) {
      this.colSin = waves.map((w) => Float32Array.from({ length: gc }, (_, c) => Math.sin(w.k * w.dx * c * size)));
      this.colCos = waves.map((w) => Float32Array.from({ length: gc }, (_, c) => Math.cos(w.k * w.dx * c * size)));
      this.tableCols = gc;
    }
    waves.forEach((w, n) => {
      const cs = this.colSin[n];
      const cc = this.colCos[n];
      const sx = -w.weight * w.dx;
      const sy = -w.weight * w.dy;
      for (let r = 0; r < gr; r++) {
        const b = w.k * w.dy * r * size - w.omega * t + w.phase;
        const sb = Math.sin(b);
        const cb = Math.cos(b);
        const row = r * gc;
        for (let c = 0; c < gc; c++) {
          const s = (cs[c] * cb + cc[c] * sb) * rough[row + c];
          gx[row + c] += sx * s;
          gy[row + c] += sy * s;
        }
      }
    });
  }

  /** One pass of a 1-2-1 blur each way over a field on the ripple grid. */
  private smooth(f: Float32Array, w: number, h: number) {
    const { tmp } = this;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        tmp[k] = 0.5 * f[k] + 0.25 * (f[i > 0 ? k - 1 : k] + f[i < w - 1 ? k + 1 : k]);
      }
    }
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        f[k] = 0.5 * tmp[k] + 0.25 * (tmp[j > 0 ? k - w : k] + tmp[j < h - 1 ? k + w : k]);
      }
    }
  }
}

// A shallow koi pond on a sunny day: white light on the stone, gold sparks on the water.
export const POND_CAUSTICS: Caustics = {
  focus: 3600,
  // Waves 120–340 px long, fanned ±70° about the prevailing breeze, steep enough together to
  // bring the light to a focus in sharp lines on the floor.
  swell: { count: 12, wavelength: [120, 340], slope: 0.003, still: 0.001, speed: 28, bearing: 0.6, spread: 1.2 },
  glint: [0.006, 0.012],
  ink: [255, 255, 252],
  glintInk: [236, 186, 40],
};
