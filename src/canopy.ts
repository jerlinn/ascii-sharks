/**
 * Tree shade: the shadow of a Japanese enkianthus (dōdan-tsutsuji) leaning over the pond, drawn as
 * a continuous image of the light reaching the floor, and averaged per cell for what needs sun
 * by the cell. It stays an image where the pond's other light goes into glyphs: what makes it
 * this shrub is the shape of its leaves and the run of its twigs, finer than a cell, and in
 * glyphs it was only a dapple.
 *
 * The tree is grown in three dimensions, the way the shrub grows: each stem gives off whorls of
 * three or four branches that arch out nearly level, tier above tier; each branch forks again in
 * whorls at its middle and tip, and every finest shoot ends in a rosette of five to seven narrow
 * leaves, its tip lifting a little at the end. Shadows fall along the sun's rays, so a point at
 * height z lands z · slant further on, away from the light: the tiers of one stem fall apart
 * across the water by their heights.
 *
 * Height also sets how soft a shadow is: the sun is a disc, not a point, so the higher a leaf
 * hangs above the floor, the wider its penumbra, and the more skylight scatters in to fill it.
 * Each piece of the tree is rasterised straight into one of LEVELS light buffers, each half the
 * resolution of the last, chosen by its height: rasterised coarse, a leaf is already blurred,
 * and scaling each level up into the next sharper one softens it further. A piece between two
 * levels is shared out between them, so softness follows height without steps. The levels
 * multiply, so shadows from different heights deepen where they cross.
 *
 * Leaves are translucent: each multiplies the light it covers by 1 − alpha, so the shade deepens
 * where they overlap, and a single leaf reads lighter than the twig it grows on. Pieces smaller
 * than a sample are splatted bilinearly by their area rather than sampled, so they glide across
 * the buffer as they sway instead of hopping from sample to sample.
 *
 * Path2D was the first way: some 17,000 path calls a frame at about a microsecond each, against
 * under a millisecond for all the tree's own arithmetic. Rasterising in place costs less than
 * either, and leaves no canvas to read back for the koi.
 *
 * Wind passes down the tree: each shoot swings about its base and everything it carries rides
 * along, so the outer sprays travel furthest. How hard it blows at each shoot comes from the
 * gust field that roughens the water, so a gust shakes the shade where it ruffles the pond.
 */
import { clamp } from "./math";

/** Screen px per sample at the sharpest level. */
const BASE_PX = 3;
const LEVELS = 4;
/** Steps between two levels a piece can sit at, so softness follows height without jumps. */
const STEPS = 4;
const SUBS = (LEVELS - 1) * STEPS + 1;
/**
 * How much light a leaf and a twig each block, and how much the highest shade fades. Light: the
 * koi are the subject, and a shallow pond's floor is lit by the sky as well as the sun.
 */
const LEAF_ALPHA = 0.36;
const WOOD_ALPHA = 0.5;
const HIGH_FADE = 0.5;
/** The share of a leader's side branches that grow into long arms. */
const LONG_ARMS = 0.22;
/** Leaves to a whorl, at every twig's tip. */
const WHORL = 6;

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A leaf of a tip whorl: its bearing from the shoot's, length (in S), width (of its length), and
 * how much of its length the sun sees as the whorl cups upward (1 flat).
 */
interface Leaf { angle: number; len: number; width: number; cup: number; phase: number; c: number; s: number }

/**
 * Sway phases come in PHASES steps, so each stem looks its swaying up in one table of sines per
 * frame (WAVES frequencies × PHASES phases) instead of calling sin for every shoot and leaf:
 * some 50,000 calls a frame otherwise, the most of the tree's own cost.
 */
const PHASES = 64;
/** Shoots' sway (three) and bob (two), leaves' flutter and roll, in radians per second at pace 1. */
const WAVES = [0.47, 1.31, 2.9, 0.61, 1.7, 2.3, 1.3];
/**
 * A shoot: a curve of segments turning by bendAz / bendEl at each node (bearing over the water,
 * elevation above it), carrying kids at its nodes and leaves near its tip. Kids keep their
 * heading relative to the shoot at the node they leave, so they ride on its sway.
 */
interface Shoot {
  order: number;
  segLen: number;
  width: number;
  bendAz: number[];
  bendEl: number[];
  kids: { at: number; daz: number; del: number; shoot: Shoot }[];
  leaves: Leaf[];
  phase: number;
  /** Where each node is this frame, and the heading there: x, y, z, az, el. */
  nodes: Float64Array;
  /**
   * The bends, fixed once grown, as rotations: cos and sin of bendAz, then of bendEl, per node.
   * Each frame turns one heading per shoot along them by multiplying, no trig in the loop.
   */
  turns: Float64Array;
}

/**
 * How each order of shoot curves: segments, how far it arches over (elevation lost from base to
 * tip), how much its last third lifts again, and the kink at each node, which on the leader is
 * strong: it turns at every branch it gives off.
 */
const FORM = [
  { segs: 16, arch: 0.35, lift: 0, zig: 0.08 },
  { segs: 10, arch: 0.45, lift: 0.25, zig: 0.08 },
  { segs: 6, arch: 0.25, lift: 0.3, zig: 0.1 },
  { segs: 4, arch: 0.1, lift: 0.2, zig: 0.1 },
];

/** One stem and all it carries; lengths in S, the screen's shorter side. */
export interface StemSpec {
  seed: number;
  /**
   * Where its foot's shadow falls, from the screen's top-left corner (off screen, on the bank),
   * and how high the foot stands above the water: a stem on a high bank holds its whole crown
   * high, soft and pale in shadow; one rooted low at the water casts it crisp and dark. Given by
   * its shadow, raising a foot leaves the picture where it was.
   */
  base: [number, number];
  foot: number;
  /** The bearing it leans toward on the screen (0 right, π/2 down), and its rise from level. */
  bearing: number;
  rise: number;
  len: number;
  width: number;
  /** Reach of its longest, lowest side branch. */
  tier: number;
  /** How far the wind moves it, and how fast it sways. */
  reach: number;
  pace: number;
}

export interface Canopy {
  stems: StemSpec[];
  /** How far a shadow falls along the ground per unit of height: 1 / tan(sun elevation). */
  slant: number;
  /**
   * How soft the highest leaves' shadow is, as a level (0 sharpest, LEVELS − 1 softest); the
   * lowest leaves' is always sharp, and softness follows height between them. Tied to the
   * canopy's own range of heights rather than to a penumbra per unit height, so its layers
   * always stand apart, crisp in front and soft behind, whatever the screen or the tree.
   */
  softest: number;
  leafLen: number;
}

function shoot(r: () => number, order: number, len: number, width: number): Shoot {
  const f = FORM[order];
  const n = f.segs;
  const s: Shoot = { order, segLen: len / n, width, bendAz: [], bendEl: [], kids: [], leaves: [], phase: Math.floor(r() * PHASES), nodes: new Float64Array(n * 5), turns: new Float64Array(n * 4) };
  // A slight curl and S under the kinks at its nodes (see KINK), so no stretch is ruler-straight.
  const curl = (r() - 0.5) * (order === 0 ? 0.3 : 0.6);
  const wave = (r() - 0.5) * (order === 0 ? 0.25 : 0.5);
  for (let i = 0; i < n; i++) {
    const zig = (i % 2 ? 1 : -1) * f.zig * (0.6 + 0.8 * r());
    s.bendAz.push(curl / n + ((wave * Math.PI) / n) * Math.cos((Math.PI * (i + 0.5)) / n) + zig);
    s.bendEl.push(-f.arch / n + (i / n > 0.66 ? f.lift / (n * 0.34) : 0) + (r() - 0.5) * 0.03);
  }
  return s;
}

/**
 * How sharply a shoot of each order kinks away from a kid it gives off. The shrub grows
 * sympodially: at each node the way on is taken by a side bud, so the shoot runs nearly straight
 * between nodes and turns abruptly at them, away from the branch it just gave off. That angular
 * zigzag, not a smooth curve, is what makes it look alive.
 */
const KINK = [0.32, 0.38, 0.3, 0.2];

/**
 * A kid at the node nearest fraction `at` of the shoot, turned daz from it and del above it; the
 * shoot itself kinks the other way from there on.
 */
function kid(r: () => number, s: Shoot, at: number, daz: number, del: number, child: Shoot) {
  const node = clamp(Math.round(at * s.bendAz.length) - 1, 0, s.bendAz.length - 1);
  s.kids.push({ at: node, daz, del, shoot: child });
  if (node + 1 < s.bendAz.length) {
    s.bendAz[node + 1] -= Math.sign(daz) * KINK[s.order] * (0.6 + 0.8 * r());
    s.bendEl[node + 1] += (r() - 0.5) * 0.15;
  }
}

/**
 * The leaves at a twig's tip: a whorl of six, spread evenly round it like a small umbrella and
 * cupped a little upward, so the sun sees each one shortened. Few whorls face the sun squarely:
 * each is tipped about some axis, so its shadow is squashed that way, into an ellipse rather
 * than a six-pointed star.
 */
function whorlOfLeaves(r: () => number, s: Shoot, leafLen: number) {
  const turn = r() * 6.283;
  const size = leafLen * (0.8 + 0.4 * r());
  const axis = r() * 6.283;
  const squash = 0.4 + 0.6 * r();
  for (let j = 0; j < WHORL; j++) {
    const angle = turn + (j / WHORL) * 6.283 + (r() - 0.5) * 0.5;
    // Squash the leaf's direction across the tipping axis; its width takes the rest of the area.
    const along = Math.cos(angle - axis);
    const across = squash * Math.sin(angle - axis);
    const stretch = Math.hypot(along, across);
    s.leaves.push({
      angle: axis + Math.atan2(across, along),
      len: size * (0.7 + 0.5 * r()),
      width: (0.5 + 0.1 * r()) * (squash / stretch) ** 0.5,
      cup: (0.75 + 0.2 * r()) * stretch,
      phase: Math.floor(r() * PHASES),
      c: 0,
      s: 0,
    });
  }
}

/**
 * Grow a stem as the shrub grows: a slender leader, kinked at each node, gives off long side
 * branches one at a time, alternately, reaching out nearly level, the lowest longest. Each
 * branch sends out a few side twigs and forks at its tip at a narrow angle; those fork once more
 * into hair-fine twigs carrying the leaves. Air everywhere between.
 */
function stem(spec: StemSpec, leafLen: number): Shoot {
  const r = rng(spec.seed);
  const twig = (order: number, len: number, width: number): Shoot => {
    const s = shoot(r, order, len, width);
    const side = r() < 0.5 ? 1 : -1;
    if (order === 3) whorlOfLeaves(r, s, leafLen);
    else if (order === 2) {
      for (const at of [0.4, 0.7]) {
        if (r() < 0.7) kid(r, s, at, (at < 0.5 ? side : -side) * (0.5 + 0.4 * r()), 0.1, twig(3, len * (0.4 + 0.3 * r()), width * 0.6));
      }
      if (r() < 0.65) {
        kid(r, s, 1, -0.4 - 0.35 * r(), 0.08, twig(3, len * (0.45 + 0.3 * r()), width * 0.6));
        kid(r, s, 1, 0.4 + 0.35 * r(), 0.08, twig(3, len * (0.45 + 0.3 * r()), width * 0.6));
      } else whorlOfLeaves(r, s, leafLen);
    } else {
      let turn = side;
      for (const at of [0.25, 0.45, 0.65, 0.82]) {
        if (r() < 0.9) kid(r, s, at, turn * (0.55 + 0.45 * r()), 0.12, twig(2, len * (0.3 + 0.25 * r()), width * 0.5));
        turn = -turn;
      }
      kid(r, s, 1, -0.35 - 0.3 * r(), 0.1, twig(2, len * (0.35 + 0.25 * r()), width * 0.5));
      kid(r, s, 1, 0.35 + 0.3 * r(), 0.1, twig(2, len * (0.3 + 0.25 * r()), width * 0.5));
    }
    return s;
  };
  // Side branches leave the rising leader nearly level, so they start at about -rise from it.
  const s = shoot(r, 0, spec.len, spec.width);
  let side = r() < 0.5 ? 1 : -1;
  for (let at = 0.12; at < 0.97; at += 0.09 + 0.04 * r()) {
    // Uneven, not graded: now and then a long arm reaches far out with its sprays at the end,
    // and between them short ones. Lengths that only taper with height close the canopy's edge
    // into a straight line, and the corner reads as a triangle.
    const reach = r() < LONG_ARMS ? 1.5 + 0.7 * r() : 0.4 + 0.6 * r();
    const len = spec.tier * (1.1 - 0.4 * at) * reach;
    kid(r, s, at, side * (0.9 + 0.6 * r()), -spec.rise + 0.2 + 0.25 * r(), twig(1, len, spec.width * 0.45));
    side = -side;
  }
  kid(r, s, 1, -0.35, -0.2, twig(1, spec.tier * 0.5, spec.width * 0.45));
  kid(r, s, 1, 0.35, -0.15, twig(1, spec.tier * 0.45, spec.width * 0.45));
  settle(s);
  return s;
}

/** Widen `range` to the heights of a shoot's leaves at rest, the shoot leaving z at elevation el. */
function leafHeights(s: Shoot, z: number, el: number, range: { lo: number; hi: number }) {
  const zs: number[] = [];
  const els: number[] = [];
  for (let i = 0; i < s.bendEl.length; i++) {
    el += s.bendEl[i];
    z += Math.sin(el) * s.segLen;
    zs.push(z);
    els.push(el);
  }
  if (s.leaves.length) {
    range.lo = Math.min(range.lo, z);
    range.hi = Math.max(range.hi, z);
  }
  for (const k of s.kids) leafHeights(k.shoot, zs[k.at], els[k.at] + k.del, range);
}

/** Once a shoot and all it carries are grown (kinks included), fix their bends as rotations. */
function settle(s: Shoot) {
  for (let i = 0; i < s.bendAz.length; i++) {
    s.turns[i * 4] = Math.cos(s.bendAz[i]);
    s.turns[i * 4 + 1] = Math.sin(s.bendAz[i]);
    s.turns[i * 4 + 2] = Math.cos(s.bendEl[i]);
    s.turns[i * 4 + 3] = Math.sin(s.bendEl[i]);
  }
  for (const l of s.leaves) {
    l.c = Math.cos(l.angle);
    l.s = Math.sin(l.angle);
  }
  for (const k of s.kids) settle(k.shoot);
}

/**
 * Half-width of a leaf at fraction t of its length, of its widest: elliptic, widest a little
 * before the middle (t = 0.4), wedge-shaped into the stalk and drawn out to a slender point.
 */
function leafProfile(t: number) {
  return 3.47 * t * (1 - t) * (1.6 - t);
}

/**
 * A light buffer: the sunlight left at each sample, 1 = all; `scale` samples per screen px. The
 * canopy only shades a corner, so each level keeps the box it has touched (x0 > x1 when none)
 * and only that is cleared, scaled up and painted.
 */
interface Level { T: Float32Array; w: number; h: number; scale: number; x0: number; y0: number; x1: number; y1: number }

function touch(l: Level, x0: number, y0: number, x1: number, y1: number) {
  if (x0 < l.x0) l.x0 = Math.max(0, x0);
  if (y0 < l.y0) l.y0 = Math.max(0, y0);
  if (x1 > l.x1) l.x1 = Math.min(l.w - 1, x1);
  if (y1 > l.y1) l.y1 = Math.min(l.h - 1, y1);
}

/** Back to full sun inside the touched box, and nothing touched. */
function clear(l: Level) {
  for (let j = l.y0; j <= l.y1; j++) l.T.fill(1, j * l.w + l.x0, j * l.w + l.x1 + 1);
  l.x0 = l.w;
  l.y0 = l.h;
  l.x1 = -1;
  l.y1 = -1;
}

/** Dim the four samples around (x, y), in sample units, by `depth` (optical depth × area) shared bilinearly. */
function splat(l: Level, x: number, y: number, depth: number) {
  const gx = x - 0.5;
  const gy = y - 0.5;
  const i = Math.floor(gx);
  const j = Math.floor(gy);
  const tx = gx - i;
  const ty = gy - j;
  const { T, w, h } = l;
  touch(l, i, j, i + 1, j + 1);
  if (i >= 0 && j >= 0 && i < w && j < h) T[j * w + i] *= Math.max(0, 1 - depth * (1 - tx) * (1 - ty));
  if (i + 1 >= 0 && j >= 0 && i + 1 < w && j < h) T[j * w + i + 1] *= Math.max(0, 1 - depth * tx * (1 - ty));
  if (i >= 0 && j + 1 >= 0 && i < w && j + 1 < h) T[(j + 1) * w + i] *= Math.max(0, 1 - depth * (1 - tx) * ty);
  if (i + 1 >= 0 && j + 1 >= 0 && i + 1 < w && j + 1 < h) T[(j + 1) * w + i + 1] *= Math.max(0, 1 - depth * tx * ty);
}

/** A leaf from (x, y) at angle a, len px long, its width that fraction of its length, blocking alpha. */
function leaf(l: Level, x: number, y: number, c: number, s: number, len: number, width: number, alpha: number) {
  const q = l.scale;
  const L = len * q;
  const H = 0.45 * len * width * q;
  if (L < 2.5) {
    splat(l, (x + c * len * 0.55) * q, (y + s * len * 0.55) * q, -Math.log(1 - alpha) * 0.62 * L * 2 * H);
    return;
  }
  const bx = x * q;
  const by = y * q;
  const x0 = Math.max(0, Math.floor(Math.min(bx, bx + c * L) - H - 1));
  const x1 = Math.min(l.w - 1, Math.ceil(Math.max(bx, bx + c * L) + H + 1));
  const y0 = Math.max(0, Math.floor(Math.min(by, by + s * L) - H - 1));
  const y1 = Math.min(l.h - 1, Math.ceil(Math.max(by, by + s * L) + H + 1));
  touch(l, x0, y0, x1, y1);
  const { T, w } = l;
  for (let j = y0; j <= y1; j++) {
    const dy = j + 0.5 - by;
    for (let i = x0; i <= x1; i++) {
      const dx = i + 0.5 - bx;
      const u = dx * c + dy * s;
      const along = clamp(Math.min(u, L - u) + 0.5, 0, 1);
      if (along <= 0) continue;
      const v = Math.abs(dy * c - dx * s);
      if (v > H + 0.5) continue;
      const across = clamp(H * leafProfile(clamp(u / L, 0, 1)) - v + 0.5, 0, 1);
      if (across > 0) T[j * w + i] *= 1 - alpha * along * across;
    }
  }
}

/** A twig's segment, tapering from half-width r0 to r1 px, blocking alpha where it covers fully. */
function twig(l: Level, x0: number, y0: number, x1: number, y1: number, r0: number, r1: number, alpha: number) {
  const q = l.scale;
  const ax = x0 * q;
  const ay = y0 * q;
  const ex = x1 * q - ax;
  const ey = y1 * q - ay;
  const len = Math.hypot(ex, ey);
  if (Math.max(r0, r1) * q < 1) {
    // Thinner than a sample: lay its area along it a sample at a time.
    const steps = Math.max(1, Math.ceil(len));
    const depth = -Math.log(1 - alpha) * (len / steps) * 2 * q;
    for (let k = 0; k < steps; k++) {
      const t = (k + 0.5) / steps;
      splat(l, ax + ex * t, ay + ey * t, depth * (r0 + (r1 - r0) * t));
    }
    return;
  }
  const R = Math.max(r0, r1) * q;
  const ll = len * len || 1;
  const { T, w } = l;
  const i0 = Math.max(0, Math.floor(Math.min(ax, ax + ex) - R - 1));
  const i1 = Math.min(l.w - 1, Math.ceil(Math.max(ax, ax + ex) + R + 1));
  const j0 = Math.max(0, Math.floor(Math.min(ay, ay + ey) - R - 1));
  const j1 = Math.min(l.h - 1, Math.ceil(Math.max(ay, ay + ey) + R + 1));
  touch(l, i0, j0, i1, j1);
  for (let j = j0; j <= j1; j++) {
    const dy = j + 0.5 - ay;
    for (let i = i0; i <= i1; i++) {
      const dx = i + 0.5 - ax;
      const t = clamp((dx * ex + dy * ey) / ll, 0, 1);
      const px = dx - ex * t;
      const py = dy - ey * t;
      const d = Math.sqrt(px * px + py * py);
      const cover = clamp((r0 + (r1 - r0) * t) * q - d + 0.5, 0, 1);
      if (cover > 0) T[j * w + i] *= 1 - alpha * cover;
    }
  }
}

/**
 * Multiply the light of `src` into `dst`, one level sharper, scaled up bilinearly. At exactly
 * twice the size, every new sample sits a quarter of the way between two old ones, so this is
 * two passes of a fixed 1:3 blend, across into `row` and then down.
 */
function upInto(src: Level, dst: Level, row: Float32Array) {
  const { T: S, w: sw, h: sh } = src;
  const { T, w, h } = dst;
  if (src.x0 > src.x1) return;
  // Outside the source's box it is all sun and scales up to all sun: only its box, doubled.
  const X0 = Math.max(0, 2 * src.x0 - 2);
  const X1 = Math.min(w - 1, 2 * src.x1 + 3);
  const Y0 = Math.max(0, 2 * src.y0 - 2);
  const Y1 = Math.min(h - 1, 2 * src.y1 + 3);
  for (let j = Math.max(0, (Y0 >> 1) - 1); j <= Math.min(sh - 1, (Y1 >> 1) + 1); j++) {
    for (let i = X0; i <= X1; i++) {
      const m = i >> 1;
      const a = clamp(i & 1 ? m : m - 1, 0, sw - 1);
      const b = Math.min(a + 1, sw - 1);
      row[j * w + i] = i & 1 ? 0.75 * S[j * sw + a] + 0.25 * S[j * sw + b] : 0.25 * S[j * sw + a] + 0.75 * S[j * sw + b];
    }
  }
  for (let j = Y0; j <= Y1; j++) {
    const m = j >> 1;
    const a = clamp(j & 1 ? m : m - 1, 0, sh - 1) * w;
    const b = Math.min(a / w + 1, sh - 1) * w;
    const wa = j & 1 ? 0.75 : 0.25;
    const wb = 1 - wa;
    for (let i = X0; i <= X1; i++) T[j * w + i] *= wa * row[a + i] + wb * row[b + i];
  }
  touch(dst, X0, Y0, X1, Y1);
}

export class CanopyField {
  /** Light reaching the floor in each character cell, 0–1; all 1 without a canopy. */
  sun = new Float32Array(0);
  private canopy: Canopy | null = null;
  private stems: { spec: StemSpec; root: Shoot }[] = [];
  private shade: [number, number, number] = [0, 0, 0];
  /** The heights of the lowest and highest leaves at rest, which span the softness. */
  private low = 0;
  private high = 1;
  private light: [number, number] = [0, -1];
  private cols = 0;
  private rows = 0;
  private width = 0;
  private height = 0;
  private levels: Level[] = [];
  /** This frame's sines for the stem being drawn: WAVES × PHASES. */
  private wave = new Float32Array(WAVES.length * PHASES);
  /** Scratch for scaling a level up: the next sharper level's width by this one's height. */
  private row = new Float32Array(0);
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private pixels: ImageData | null = null;
  /** The box of the image painted last frame. */
  private painted = { x0: 0, y0: 0, x1: -1, y1: -1 };
  /** The cell each sample of the sharpest level falls in (−1 off the grid), samples per cell, and scratch. */
  private cellOf = new Int32Array(0);
  private perCell = new Float32Array(0);
  private shadeSum = new Float32Array(0);
  private shadeMax = new Float32Array(0);

  get active() {
    return this.canopy !== null;
  }

  /** The light on the floor in the shade colour, white in full sun; imageWidth × imageHeight px. */
  get image() {
    return this.canvas;
  }

  get imageWidth() {
    return (this.levels[0]?.w ?? 0) * BASE_PX;
  }

  get imageHeight() {
    return (this.levels[0]?.h ?? 0) * BASE_PX;
  }

  /** Plant a scene's trees, lit from `light` (its horizontal light vector), shading in `shade`. */
  set(canopy: Canopy | null, light: [number, number], shade: [number, number, number]) {
    if (canopy !== this.canopy) {
      this.stems = (canopy?.stems ?? []).map((spec) => ({ spec, root: stem(spec, canopy!.leafLen) }));
      const range = { lo: Infinity, hi: -Infinity };
      for (const { spec, root } of this.stems) leafHeights(root, spec.foot, spec.rise, range);
      this.low = range.lo;
      this.high = range.hi;
    }
    this.canopy = canopy;
    this.light = light;
    this.shade = shade;
    this.sun.fill(1);
  }

  resize(cols: number, rows: number, cw: number, ch: number, width: number, height: number) {
    Object.assign(this, { cols, rows, width, height });
    this.sun = new Float32Array(cols * rows).fill(1);
    this.levels = [];
    for (let k = 0; k < LEVELS; k++) {
      const px = BASE_PX * 2 ** k;
      const w = Math.ceil(width / px) + 1;
      const h = Math.ceil(height / px) + 1;
      this.levels.push({ T: new Float32Array(w * h).fill(1), w, h, scale: 1 / px, x0: w, y0: h, x1: -1, y1: -1 });
    }
    this.row = new Float32Array(this.levels[0].w * this.levels[1].h);
    const { w, h } = this.levels[0];
    this.cellOf = new Int32Array(w * h).fill(-1);
    this.perCell = new Float32Array(cols * rows);
    this.shadeSum = new Float32Array(cols * rows);
    this.shadeMax = new Float32Array(cols * rows);
    for (let j = 0; j < h; j++) {
      const r = Math.floor(((j + 0.5) * BASE_PX) / ch);
      for (let i = 0; i < w; i++) {
        const c = Math.floor(((i + 0.5) * BASE_PX) / cw);
        if (r >= rows || c >= cols) continue;
        this.cellOf[j * w + i] = r * cols + c;
        this.perCell[r * cols + c]++;
      }
    }
    if (typeof document === "undefined") return;
    this.canvas ??= document.createElement("canvas");
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext("2d");
    this.pixels = this.ctx?.createImageData(w, h) ?? null;
    this.pixels?.data.fill(255);
    this.painted = { x0: 0, y0: 0, x1: -1, y1: -1 };
    if (this.pixels) this.ctx?.putImageData(this.pixels, 0, 0);
  }

  /**
   * Sway the trees to time t and relight the floor. `wind` is the breeze's strength (0 still, 1
   * the scene's), `gust(x, y)` how hard it blows at a screen point, 0–1.
   */
  update(t: number, wind: number, gust: (x: number, y: number) => number) {
    const { canopy, levels } = this;
    if (!canopy || !levels.length) return;
    for (const l of levels) clear(l);
    for (const { spec, root } of this.stems) this.draw(spec, root, t, wind, gust);
    for (let k = LEVELS - 1; k > 0; k--) upInto(levels[k], levels[k - 1], this.row);

    // Each cell's shade is taken over all of it, not sampled at its middle, so a leaf's shadow
    // moving into a cell darkens it by degrees rather than all at once: partly its average, and
    // partly its deepest, so a leaf narrower than the cell isn't washed out by the light around.
    const { T, w, x0, y0, x1, y1 } = levels[0];
    const { sun, shadeSum, shadeMax, perCell, cellOf } = this;
    shadeSum.fill(0);
    shadeMax.fill(0);
    for (let j = y0; j <= y1; j++) {
      for (let i = j * w + x0; i <= j * w + x1; i++) {
        const cell = cellOf[i];
        if (cell < 0) continue;
        const d = 1 - T[i];
        shadeSum[cell] += d;
        if (d > shadeMax[cell]) shadeMax[cell] = d;
      }
    }
    for (let i = 0; i < sun.length; i++) sun[i] = perCell[i] ? 1 - (0.4 * shadeSum[i]) / perCell[i] - 0.6 * shadeMax[i] : 1;

    // Repaint what is shaded now and what was last frame, which may have come back into sun.
    const { ctx, pixels } = this;
    if (!ctx || !pixels) return;
    const d = pixels.data;
    const [sr, sg, sb] = this.shade;
    const was = this.painted;
    const px0 = Math.min(x0, was.x0);
    const py0 = Math.min(y0, was.y0);
    const px1 = Math.max(x1, was.x1);
    const py1 = Math.max(y1, was.y1);
    Object.assign(was, { x0, y0, x1, y1 });
    if (px0 > px1) return;
    for (let j = py0; j <= py1; j++) {
      for (let i = j * w + px0; i <= j * w + px1; i++) {
        const v = T[i];
        d[i * 4] = sr + (255 - sr) * v;
        d[i * 4 + 1] = sg + (255 - sg) * v;
        d[i * 4 + 2] = sb + (255 - sb) * v;
      }
    }
    ctx.putImageData(pixels, 0, 0, px0, py0, px1 - px0 + 1, py1 - py0 + 1);
  }

  /** Cast one stem's shadow at time t into the levels for each piece's height. */
  private draw(spec: StemSpec, root: Shoot, t: number, wind: number, gust: (x: number, y: number) => number) {
    const canopy = this.canopy!;
    const levels = this.levels;
    const S = Math.min(this.width, this.height);
    const ll = Math.hypot(this.light[0], this.light[1]) || 1;
    // A point's shadow falls this far away from the light per unit of its height.
    const fx = (-this.light[0] / ll) * canopy.slant;
    const fy = (-this.light[1] / ll) * canopy.slant;
    const pace = spec.pace;
    const wave = this.wave;
    for (let k = 0; k < WAVES.length; k++) {
      for (let j = 0; j < PHASES; j++) wave[k * PHASES + j] = Math.sin(t * WAVES[k] * pace + (j / PHASES) * 6.283);
    }
    // The height step a piece at height z falls in, from the lowest leaves (sharp) to the
    // highest (canopy.softest). Step s sits between levels ⌊s / STEPS⌋ and the next,
    // (s % STEPS) / STEPS of the way, and the higher the shade, the more skylight fills it.
    const { low, high } = this;
    const top = canopy.softest * STEPS;
    const place = (z: number) => clamp(Math.round(((z - low) / (high - low || 1)) * top), 0, SUBS - 1);
    const fadeAt = (step: number) => 1 - (HIGH_FADE * step) / top;
    const walk = (sh: Shoot, x: number, y: number, z: number, az: number, el: number) => {
      const o = sh.order;
      let sx = (x + z * fx) * S;
      let sy = (y + z * fy) * S;
      const local = 0.2 + wind * (0.5 + gust(sx, sy));
      // Each wave at its own multiple of the phase, so the five don't move in step.
      const p = sh.phase;
      const sway = wave[p] + 0.45 * wave[PHASES + ((p * 7) % PHASES)] + 0.2 * wave[2 * PHASES + ((p * 13) % PHASES)];
      const bob = wave[3 * PHASES + ((p * 5) % PHASES)] + 0.4 * wave[4 * PHASES + ((p * 11) % PHASES)];
      az += local * spec.reach * (0.01 + 0.025 * o) * sway;
      el += local * spec.reach * (0.008 + 0.02 * o) * bob;
      const n = sh.bendAz.length;
      // Each node's true position and heading, for the kids that leave it.
      const nodes = sh.nodes;
      const turns = sh.turns;
      let ca = Math.cos(az);
      let sa = Math.sin(az);
      let ce = Math.cos(el);
      let se = Math.sin(el);
      for (let i = 0; i < n; i++) {
        az += sh.bendAz[i];
        el += sh.bendEl[i];
        const j = i * 4;
        const ca1 = ca * turns[j] - sa * turns[j + 1];
        sa = sa * turns[j] + ca * turns[j + 1];
        ca = ca1;
        const ce1 = ce * turns[j + 2] - se * turns[j + 3];
        se = se * turns[j + 2] + ce * turns[j + 3];
        ce = ce1;
        const run = ce * sh.segLen;
        const z0 = z;
        x += ca * run;
        y += sa * run;
        z += se * sh.segLen;
        nodes[i * 5] = x;
        nodes[i * 5 + 1] = y;
        nodes[i * 5 + 2] = z;
        nodes[i * 5 + 3] = az;
        nodes[i * 5 + 4] = el;
        const ex = (x + z * fx) * S;
        const ey = (y + z * fy) * S;
        const r0 = 0.5 * sh.width * S * (1 - (0.65 * i) / n);
        const r1 = 0.5 * sh.width * S * (1 - (0.65 * (i + 1)) / n);
        const step = place((z0 + z) / 2);
        const k = Math.floor(step / STEPS);
        const share = (step % STEPS) / STEPS;
        const fade = fadeAt(step);
        twig(levels[k], sx, sy, ex, ey, r0, r1, WOOD_ALPHA * fade * (1 - share));
        if (share > 0 && k + 1 < LEVELS) twig(levels[k + 1], sx, sy, ex, ey, r0, r1, WOOD_ALPHA * fade * share);
        sx = ex;
        sy = ey;
      }
      if (sh.leaves.length) {
        const step = place(z);
        const k = Math.floor(step / STEPS);
        const share = (step % STEPS) / STEPS;
        const fade = fadeAt(step);
        for (const l of sh.leaves) {
          // Its bearing turned on from the tip's, then by a small flutter (sin d ≈ d).
          const c0 = ca * l.c - sa * l.s;
          const s0 = sa * l.c + ca * l.s;
          const d = 0.15 * local * wave[5 * PHASES + l.phase];
          const cd = 1 - (d * d) / 2;
          const c = c0 * cd - s0 * d;
          const sn = s0 * cd + c0 * d;
          // A leaf rolling in the wind narrows to the sun, and its shadow flickers.
          const roll = 0.75 + 0.25 * Math.abs(wave[6 * PHASES + ((l.phase * 3) % PHASES)]);
          const len = l.len * l.cup * S;
          // Out on its short stalk, so the whorl opens from a small ring, not a point.
          const bx = sx + c * len * 0.12;
          const by = sy + sn * len * 0.12;
          leaf(levels[k], bx, by, c, sn, len, l.width * roll, LEAF_ALPHA * fade * (1 - share));
          if (share > 0 && k + 1 < LEVELS) leaf(levels[k + 1], bx, by, c, sn, len, l.width * roll, LEAF_ALPHA * fade * share);
        }
      }
      for (const child of sh.kids) {
        const k = child.at * 5;
        walk(child.shoot, nodes[k], nodes[k + 1], nodes[k + 2], nodes[k + 3] + child.daz, nodes[k + 4] + child.del);
      }
    };
    walk(root, spec.base[0] - spec.foot * fx, spec.base[1] - spec.foot * fy, spec.foot, spec.bearing, spec.rise);
  }
}

// A dōdan-tsutsuji on the bank just beyond the top-left corner: one slender leader on the high
// bank leaning out over the water, its bare foot off screen and its crown high, so its shade is
// the soft, pale one behind; and a smaller one rooted low by the water below it, whose sprays
// cast the crisp, dark shade in front; a little further along
// the top, one short branch pokes in on its own. One lopsided mass trailing off along the top,
// not a corner held from both sides: a branch down each edge would read as a pincer round the
// pond. The koi are the subject: most of the water is in sun, and a koi swimming into the corner
// or along the top passes under the leaves.
export const ENKIANTHUS: Canopy = {
  slant: 0.75,
  softest: 2.2,
  leafLen: 0.016,
  stems: [
    { seed: 7, base: [-0.3, -0.32], foot: 0.3, bearing: 0.6, rise: 1.0, len: 0.72, width: 0.0065, tier: 0.38, reach: 1, pace: 1 },
    { seed: 19, base: [-0.34, 0.12], foot: 0, bearing: 0.15, rise: 0.85, len: 0.45, width: 0.0055, tier: 0.3, reach: 1.3, pace: 0.85 },
    { seed: 31, base: [0.46, -0.44], foot: 0.15, bearing: 1.5, rise: 0.9, len: 0.36, width: 0.005, tier: 0.24, reach: 1.4, pace: 0.9 },
  ],
};
