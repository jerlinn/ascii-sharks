/**
 * Artificial-life sim for the hero: tiny fish schools and the sharks that hunt them.
 *
 * Fish: Reynolds boids (separation / alignment / cohesion) in Couzin-style
 * zones, with a blind spot behind each fish. Alarm spreads from fish to fish
 * through the school (a "wave of agitation"), so a whole school bolts even
 * when only its edge can see the shark. Fleeing fish break sideways around the
 * shark's path, which gives the fountain effect seen in real bait balls.
 *
 * Sharks: Reynolds steering (wander + pursuit + separation) on a
 * follow-the-leader spine. Hunger builds over time and drops when they eat.
 * They prefer fish in sparse spots, since dense schools confuse predators,
 * so stragglers get picked off. Eaten fish come back later as new schools
 * swimming in from the edges, which keeps the population steady.
 */
import { angleDiff, clamp, current, rand, randInt, TAU, windAt } from "./math";
import { OCEAN, type Scene } from "./scene";
import { pickSpecies } from "./species";
import { ButterflyField } from "./butterflies";

export const SHARK_NODES = 20;

export type SharkKind =
  | "classic" | "hammerhead" | "zebra" | "tiger" | "greathammer" | "mako" | "thresher" | "nurse"
  | "koi" | "humpback" | "dragon";

/**
 * Which sharks to put in the water; size is relative to the biggest. Depth (0 far → 1 near)
 * follows size unless given: a dragon is several times a shark's length but no nearer.
 */
export type SharkSpec = { kind: SharkKind; size: number; depth?: number };

/**
 * A dragon's body wave: its wavenumber along the body (radians per length), two S-bends from
 * neck to tail. The renderer draws the wave; the sim runs its phase.
 */
export const SLITHER_K = 12.5;

export interface Fish {
  x: number;
  y: number;
  vx: number;
  vy: number;
  species: number;
  /** 0 calm → 1 panicking. Spreads to neighbours. */
  alarm: number;
  alive: boolean;
  respawnAt: number;
  /** Tail-beat phase. */
  phase: number;
  /** Smoothed angular velocity (rad/s); hard turns flash silver. */
  turn: number;
  /** 0.55 far → 1 near. */
  depth: number;
  /** Rotation sense shared by a school when it mills into a bait ball. */
  millDir: 1 | -1;
}

export interface Shark {
  id: number;
  kind: SharkKind;
  length: number;
  /** Spine positions, snout first: [x0, y0, x1, y1, ...]. */
  nodes: Float32Array;
  heading: number;
  speed: number;
  /** Tail-beat phase; drives the body wave in the renderer. */
  phase: number;
  /** Smoothed angular velocity (rad/s); the shark banks its fins into turns. */
  turn: number;
  hunger: number;
  wander: number;
  orbitDir: 1 | -1;
  orbitRadius: number;
  target: Fish | null;
  retargetAt: number;
  /** 0 far / dim → 1 near / bright. */
  depth: number;
  /** 0 shut → 1 wide: a lunging whale's mouth and swollen throat. */
  gape: number;
  // Bubble-net bookkeeping: how far round the ring this whale has swum, its last bearing
  // from the ring's centre, and where it last blew a bubble.
  swept: number;
  ringAngle: number;
  lastBubbleX: number;
  lastBubbleY: number;
  // Meandering: the waypoint being swum to, when to give up on it, and a burst of speed
  // after each new heading that fades into a glide.
  goalX: number;
  goalY: number;
  goalAt: number;
  burst: number;
  /** 0 calm → 1 chasing food: rises quickly when food is in reach, ebbs slowly once it's gone. */
  excite: number;
  /** Eased target speed, which speed then follows: two easings, so it never lurches. */
  pace: number;
}

/** Air from a whale's blowhole: rises for BUBBLE_RISE seconds, then foams on the surface. */
export interface Bubble {
  x: number;
  y: number;
  age: number;
}

/** A pod hunting together: rest, blow a net round the densest swarm, then lunge through it. */
interface Pod {
  phase: "rest" | "net" | "lunge";
  /** When rest or the lunge ends. */
  until: number;
  started: number;
  x: number;
  y: number;
  radius0: number;
  radius: number;
  dir: 1 | -1;
}

export interface WorldEvent {
  /** splash: a hard slap that scatters fish; drop: a pellet or raindrop landing. */
  kind: "eat" | "splash" | "drop";
  x: number;
  y: number;
  /** Scales the ripple; 1 when absent. */
  strength?: number;
  /** Seconds before it lands, so a handful of food patters down instead of hitting at once. */
  delay?: number;
}

const FISH_SEPARATION_K = 420;
const FISH_ALIGN_K = 1.4;
const FISH_COHESION_K = 1;
const FISH_FLEE_K = 1100;
const BLIND_COS = -0.6; // ~127° either side of the heading is visible
/**
 * How a kind of spine creature moves. `bend` is how far each spine joint can flex, so the
 * body curls to about L / (19 · bend) at tightest; `turnRadius` (a fraction of L) should stay
 * outside that, or the head drags the body into a kink. `idleRate` caps the turn rate in rad/s
 * when not hunting. `meander`: idle by swimming waypoint to waypoint in quick turns and glides,
 * instead of circling the screen. `accel`: how fast speed follows its target, per second.
 * `space`: personal space from others of its kind, as a fraction of their summed lengths, and
 * `push`: how hard that space is kept. Koi pass over and under one another at different depths
 * and barely push; at full strength, two koi that drift together shove each other round in
 * circles, both bodies locked in a C.
 * `pivot`: a turn rate (rad/s) available however slowly it swims. Sharks turn on momentum, so
 * their turning circle shrinks with speed and a slow shark turns slowly; a koi can sweep its
 * pectorals and swing round almost on the spot.
 * `relax`: how fast the body springs back straight, per second. With none, the spine only
 * follows the path the head took, like a train on rails: a flick of the head leaves a corner
 * the body holds until it has swum a whole length past it, which reads as a stiff C. A real
 * fish's body is elastic: the tail sweeps round to line up with the head, cutting the corner.
 * `stride`: a meanderer's next waypoint lies this many lengths off (shortest, longest), and it
 * counts as reached within the third value. A koi is a quarter of the pond; a dragon spans it.
 * `cruise`: scales the cruising speed every kind shares (30 px/s plus 4% of its length a second).
 * `slither`: the body wave's wavenumber when the wave stands still in space, its phase running
 * at speed · k / L, so the body slides along one S-shaped path like a snake's instead of
 * beating like a fish's tail.
 */
interface Motion {
  turnRadius: number;
  bend: number;
  idleRate: number;
  meander: boolean;
  accel: number;
  space: number;
  pivot: number;
  relax: number;
  push: number;
  stride: [number, number, number];
  cruise?: number;
  slither?: number;
}
const SHARK_MOTION: Motion = {
  turnRadius: 0.22, bend: 0.16, idleRate: 0.8, meander: false, accel: 1.1, space: 0.45, pivot: 0, relax: 0, push: 1,
  stride: [1, 2.2, 0.6],
};
const MOTION: Partial<Record<SharkKind, Motion>> = {
  // Supple: the body curls to about L/4, so a koi flicks round and glides on. Quick off the
  // mark for food, and happy to swim close to the others.
  koi: {
    turnRadius: 0.24, bend: 0.22, idleRate: 2.6, meander: true, accel: 3.5, space: 0.16, pivot: 2.6, relax: 3, push: 0.25,
    stride: [1, 2.2, 0.6],
  },
  // Soars: long sweeping arcs from one waypoint half its length off to the next, never a flick.
  // Its S comes from the body wave sliding along the path, not from the turns.
  dragon: {
    turnRadius: 0.3, bend: 0.2, idleRate: 0.45, meander: true, accel: 0.8, space: 0.3, pivot: 0, relax: 0.5, push: 1,
    stride: [0.45, 0.8, 0.22], cruise: 1.6, slither: SLITHER_K,
  },
};
/**
 * Supple swimmers steer in proportion to how far off course they are, closing the gap at this
 * rate per second, rather than turning flat out at every wobble of the steering.
 */
const SUPPLE_STEER = 4;
/** Joints behind the head that take part in a flick. */
const FLICK_JOINTS = 10;
/** A supple turn that outlasts the flick only curls the body this far toward its limit. */
const SUPPLE_CURL = 0.75;
/**
 * A koi rushing for food swims this many body lengths a second, about eight times its idle pace
 * (the scene idles slowly on purpose; a dash for food shouldn't inherit that). Within
 * FEED_EASE lengths of the food it eases off, gliding in to take it rather than overshooting.
 */
const FEED_RUSH = 1.1;
const FEED_EASE = 0.8;
/** Food lands within this many body lengths of a koi and it comes, hungry or not. */
const FEED_TEMPT = 4;
/** Small fish smell food this far off, and are drawn in this hard. */
const FOOD_SENSE = 220;
const FOOD_PULL = 160;
/** Pellets kept in reserve for clicks to scatter. */
const FOOD_POOL = 48;
const FOOD_PER_DROP = 7;

const BUBBLE_SPACING = 14;
export const BUBBLE_RISE = 1;
export const BUBBLE_LIFE = 4.5;
/** Bubbles herd krill while they rise and for a moment after, as a curtain. */
const BUBBLE_CURTAIN = BUBBLE_RISE + 1.5;
const BUBBLE_R = 30;
/** Seconds to tighten the net from its first radius to NET_CLOSE of it. */
const NET_TIME = 10;
const NET_CLOSE = 0.72;
/** The lead whale lunges once it has swum this many turns round the net. */
const NET_TURNS = 0.9;
const LUNGE_TIME = 2.6;

export class World {
  width = 0;
  height = 0;
  time = 0;
  fish: Fish[] = [];
  sharks: Shark[] = [];
  events: WorldEvent[] = [];
  bubbles: Bubble[] = [];
  readonly meadow = new ButterflyField();
  private pod: Pod = { phase: "rest", until: 0, started: 0, x: 0, y: 0, radius0: 0, radius: 0, dir: 1 };
  pointer = { x: 0, y: 0, active: false };

  /** Fish neighbourhood radius; the spatial hash bucket size matches it. */
  private perception = 60;
  /** Per-species personal space in px (x, y). */
  private sepX: number[] = [];
  private sepY: number[] = [];
  private foreignSep = 40;
  private cellW = 0;
  private cellH = 0;
  private bucketCols = 0;
  private bucketRows = 0;
  private bucketHead = new Int32Array(0);
  private bucketCount = new Uint16Array(0);
  private bucketNext = new Int32Array(0);
  private lastSpawn = 0;
  private tmp = { x: 0, y: 0 };
  private steer = { x: 0, y: 0 };
  private wind = { x: 0, y: 0 };
  /** Whether the scene's wind blows, and how far it has eased toward that (0 still → 1 full). */
  private windOn = true;
  private windEase = 1;
  /** Whether the canopy's shade falls, and how far it has eased toward that (0 none → 1 full). */
  private shadeOn = true;
  private shadeEase = 1;
  private nextRain = 0;

  /** fishCount overrides the area-based population (the sidebar wants a single small school). */
  constructor(
    public scene: Scene = OCEAN,
    private fishCount?: number,
  ) {}

  /** Recolour the scene (a theme change): same cast, same water, nothing reseeded. */
  restyle(scene: Scene) {
    this.scene = scene;
  }

  /** Swap the whole cast; the new scene starts fresh. */
  setScene(scene: Scene) {
    this.scene = scene;
    if (this.width === 0) return;
    this.setSpacing();
    this.seed();
  }

  resize(width: number, height: number, cellW: number, cellH: number) {
    const first = this.width === 0;
    this.width = width;
    this.height = height;
    this.cellW = cellW;
    this.cellH = cellH;
    this.setSpacing();

    if (this.scene.meadow) {
      if (first || this.meadow.butterflies.length === 0) this.seed();
      else this.meadow.resize(width, height);
      return;
    }

    if (first || this.fish.length === 0) {
      this.seed();
      return;
    }
    for (const f of this.fish) {
      f.x = clamp(f.x, 0, width);
      f.y = clamp(f.y, 0, height);
    }
  }

  private setSpacing() {
    const { cellW, cellH } = this;
    // Spacing is set in grid cells so every fish lands in its own cell.
    this.sepX = this.scene.species.map((sp) => sp.spacing[0] * cellW);
    this.sepY = this.scene.species.map((sp) => sp.spacing[1] * cellH);
    this.perception = Math.max(cellH * 3, cellW * 5.5);
    this.foreignSep = cellW * 3;
  }

  seed() {
    const { width: W, height: H } = this;
    this.events.length = 0;
    this.meadow.clear();
    if (this.scene.meadow) this.meadow.seed(W, H, this.scene.meadow, this.time);
    const minSide = Math.min(W, H);
    const baseLength = clamp(minSide * 0.44, 170, 430);
    const sharkSpecs = this.scene.sharks;
    const sharkCount = sharkSpecs.length;

    this.sharks = [];
    for (let i = 0; i < sharkCount; i++) {
      const { kind, size, depth = size } = sharkSpecs[i];
      const length = baseLength * size;
      const orbitRadius = minSide * rand(0.28, 0.4);
      const a = (i / sharkCount) * TAU + rand(-0.4, 0.4);
      const orbitDir: 1 | -1 = i % 2 === 0 ? 1 : -1;
      const x = W / 2 + Math.cos(a) * orbitRadius * (W / minSide) * 0.9;
      const y = H / 2 + Math.sin(a) * orbitRadius;
      const heading = a + (orbitDir * Math.PI) / 2;
      const nodes = new Float32Array(SHARK_NODES * 2);
      const seg = length / (SHARK_NODES - 1);
      for (let n = 0; n < SHARK_NODES; n++) {
        nodes[n * 2] = x - Math.cos(heading) * seg * n;
        nodes[n * 2 + 1] = y - Math.sin(heading) * seg * n;
      }
      this.sharks.push({
        id: i + 1,
        kind,
        length,
        nodes,
        heading,
        speed: 30,
        phase: rand(0, TAU),
        turn: 0,
        hunger: rand(0.25, 0.75),
        wander: 0,
        orbitDir,
        orbitRadius,
        target: null,
        retargetAt: 0,
        depth,
        gape: 0,
        swept: 0,
        ringAngle: 0,
        lastBubbleX: x,
        lastBubbleY: y,
        goalX: x,
        goalY: y,
        goalAt: 0,
        burst: 0,
        excite: 0,
        pace: 30,
      });
    }
    // Smaller (farther) sharks draw first so the big one swims over them.
    this.sharks.sort((a, b) => a.length - b.length);
    this.bubbles = [];
    // Let the swarms settle before the first net.
    this.pod.phase = "rest";
    this.pod.until = this.time + 4;

    const total = this.fishCount ?? Math.round(clamp(Math.round((W * H) / 4400), 85, 340) * this.scene.schoolDensity);
    this.fish = [];
    while (this.fish.length < total) {
      const species = pickSpecies(this.scene.species);
      const sp = this.scene.species[species];
      const size = Math.min(randInt(sp.schoolSize[0], sp.schoolSize[1]), total - this.fish.length);
      const millDir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
      const cx = rand(W * 0.06, W * 0.94);
      const cy = rand(H * 0.08, H * 0.92);
      // Mostly level headings: fish cruise sideways far more than up or down.
      const dir = (Math.random() < 0.5 ? 0 : Math.PI) + rand(-0.5, 0.5);
      for (let k = 0; k < size; k++) {
        this.fish.push({
          x: cx + rand(-1, 1) * this.sepX[species] * Math.sqrt(size),
          y: cy + rand(-1, 1) * this.sepY[species] * Math.sqrt(size) * 0.6,
          vx: Math.cos(dir) * sp.cruise,
          vy: Math.sin(dir) * sp.cruise,
          species,
          alarm: 0,
          alive: true,
          respawnAt: 0,
          phase: rand(0, TAU),
          turn: 0,
          depth: rand(0.55, 1),
          millDir,
        });
      }
    }
    const food = this.scene.species.findIndex((sp) => sp.food);
    if (food >= 0) {
      for (let k = 0; k < FOOD_POOL; k++) {
        this.fish.push({
          x: 0, y: 0, vx: 0, vy: 0, species: food, alarm: 0,
          alive: false, respawnAt: Infinity, phase: 0, turn: 0, depth: 1, millDir: 1,
        });
      }
    }
    this.bucketNext = new Int32Array(this.fish.length);
  }

  /** A click on the water: scatter the fish, or drop food, depending on the scene. */
  poke(x: number, y: number) {
    if (this.scene.meadow) this.meadow.scatter(x, y, this.time);
    else if (this.scene.click === "feed") this.feed(x, y);
    else this.splash(x, y);
  }

  /**
   * Scatter a handful of pellets around (x, y). They patter down over a quarter second, each
   * with a small ripple (a pellet is far lighter than a raindrop), and the splash of landing
   * pushes them apart a little before they settle and drift with the wind.
   */
  feed(x: number, y: number) {
    let dropped = 0;
    for (const f of this.fish) {
      if (dropped === FOOD_PER_DROP) break;
      if (f.alive || !this.scene.species[f.species].food) continue;
      const a = rand(0, TAU);
      const r = Math.pow(Math.random(), 0.7) * 55;
      const push = rand(20, 45);
      f.x = clamp(x + Math.cos(a) * r, 0, this.width);
      f.y = clamp(y + Math.sin(a) * r, 0, this.height);
      f.vx = Math.cos(a) * push;
      f.vy = Math.sin(a) * push;
      f.alive = true;
      this.events.push({ kind: "drop", x: f.x, y: f.y, strength: 0.17, delay: rand(0, 0.25) });
      dropped++;
    }
  }

  splash(x: number, y: number) {
    this.events.push({ kind: "splash", x, y });
    const r = 240;
    for (const f of this.fish) {
      if (!f.alive) continue;
      const dx = f.x - x;
      const dy = f.y - y;
      const d = Math.hypot(dx, dy);
      if (d > r || d < 1e-3) continue;
      // Flash expansion: everybody nearby bolts straight out.
      const k = (1 - d / r) * 260;
      f.vx += (dx / d) * k;
      f.vy += (dy / d) * k;
      f.alarm = 1;
    }
  }

  /** Switch the wind; it rises or dies away over a couple of seconds unless `instant`. */
  setWind(on: boolean, instant = false) {
    this.windOn = on;
    if (instant) this.windEase = on ? 1 : 0;
  }

  get windEnabled() {
    return this.windOn;
  }

  /** Switch the canopy's shade; it comes and goes like the sun behind a cloud unless `instant`. */
  setShade(on: boolean, instant = false) {
    this.shadeOn = on;
    if (instant) this.shadeEase = on ? 1 : 0;
  }

  /** Where the whales' bubble-net feeding stands: resting, ringing a swarm, or lunging up through it. */
  get podPhase() {
    return this.pod.phase;
  }

  get shadeEnabled() {
    return this.shadeOn;
  }

  /** How much of the canopy's shade falls now, 0–1; always 0 in a scene without one. */
  get shade() {
    return this.scene.canopy ? this.shadeEase : 0;
  }

  /** The wind's current speed in px/s: the scene's, eased up or down as it's switched on or off. */
  get windSpeed() {
    return this.scene.wind * this.windEase;
  }

  step(dt: number) {
    this.time += dt;
    // A breeze rises and dies away over a couple of seconds rather than switching.
    this.windEase += ((this.windOn ? 1 : 0) - this.windEase) * Math.min(1, dt * 1.2);
    this.shadeEase += ((this.shadeOn ? 1 : 0) - this.shadeEase) * Math.min(1, dt * 2);
    if (this.scene.meadow) {
      this.meadow.step(dt, this.time, this.windSpeed, this.pointer);
      return;
    }
    if (this.scene.rain > 0 && this.time >= this.nextRain) {
      this.events.push({ kind: "drop", x: rand(0, this.width), y: rand(0, this.height) });
      // Poisson arrivals, so the drops never fall into a beat.
      this.nextRain = this.time - Math.log(1 - Math.random()) / this.scene.rain;
    }
    this.rebuildHash();
    this.stepFish(dt);
    this.stepSharks(dt);
    this.stepBubbles(dt);
    this.respawn();
  }

  private rebuildHash() {
    const size = this.perception;
    const pad = 2;
    this.bucketCols = Math.ceil(this.width / size) + pad * 2;
    this.bucketRows = Math.ceil(this.height / size) + pad * 2;
    const n = this.bucketCols * this.bucketRows;
    if (this.bucketHead.length !== n) {
      this.bucketHead = new Int32Array(n);
      this.bucketCount = new Uint16Array(n);
    }
    this.bucketHead.fill(-1);
    this.bucketCount.fill(0);
    if (this.bucketNext.length !== this.fish.length) {
      this.bucketNext = new Int32Array(this.fish.length);
    }
    for (let i = 0; i < this.fish.length; i++) {
      const f = this.fish[i];
      // Pellets aren't neighbours: fish neither school with them nor give them room.
      if (!f.alive || this.scene.species[f.species].food) continue;
      const b = this.bucketOf(f.x, f.y);
      this.bucketNext[i] = this.bucketHead[b];
      this.bucketHead[b] = i;
      this.bucketCount[b]++;
    }
  }

  private bucketOf(x: number, y: number) {
    const size = this.perception;
    const c = clamp(Math.floor(x / size) + 2, 0, this.bucketCols - 1);
    const r = clamp(Math.floor(y / size) + 2, 0, this.bucketRows - 1);
    return r * this.bucketCols + c;
  }

  private stepFish(dt: number) {
    const { fish, sharks, pointer, width: W, height: H, time } = this;
    const R = this.perception;
    const R2 = R * R;
    const foreignSep = this.foreignSep;
    const size = this.perception;
    const cols = this.bucketCols;
    const rows = this.bucketRows;
    const head = this.bucketHead;
    const next = this.bucketNext;
    const cur = this.tmp;
    const calmDecay = Math.exp(-dt * 0.7);
    const contagion = Math.min(1, dt * 6);
    const pellets = fish.filter((f) => f.alive && this.scene.species[f.species].food);
    const wind = windAt(time, this.windSpeed, this.wind);

    for (let i = 0; i < fish.length; i++) {
      const f = fish[i];
      if (!f.alive) continue;
      const sp = this.scene.species[f.species];
      if (sp.food) {
        // Pellets float: they settle from the push of landing and ride the wind and current.
        current(f.x, f.y, time, cur);
        const k = Math.min(1, dt * 1.5);
        f.vx += (cur.x * 0.3 + wind.x * 0.8 - f.vx) * k;
        f.vy += (cur.y * 0.3 + wind.y * 0.8 - f.vy) * k;
        f.x = clamp(f.x + f.vx * dt, 0, W);
        f.y = clamp(f.y + f.vy * dt, 0, H);
        continue;
      }
      // Alarmed fish want more room: the school flashes apart around a
      // shark and closes back up once the threat fades.
      const spread = 1 + 1.8 * f.alarm;
      const sepX = this.sepX[f.species] * spread;
      const sepY = this.sepY[f.species] * spread;

      const speed = Math.hypot(f.vx, f.vy) || 1;
      const hx = f.vx / speed;
      const hy = f.vy / speed;

      let ax = 0;
      let ay = 0;
      let sx = 0;
      let sy = 0;
      let avx = 0;
      let avy = 0;
      let cx = 0;
      let cy = 0;
      let n = 0;
      let neighbourAlarm = 0;

      const bc = clamp(Math.floor(f.x / size) + 2, 0, cols - 1);
      const br = clamp(Math.floor(f.y / size) + 2, 0, rows - 1);
      for (let r = Math.max(0, br - 1); r <= Math.min(rows - 1, br + 1); r++) {
        for (let c = Math.max(0, bc - 1); c <= Math.min(cols - 1, bc + 1); c++) {
          let j = head[r * cols + c];
          while (j !== -1) {
            if (j !== i) {
              const o = fish[j];
              const dx = o.x - f.x;
              const dy = o.y - f.y;
              const d2 = dx * dx + dy * dy;
              if (d2 < R2 && d2 > 1e-6) {
                const d = Math.sqrt(d2);
                // Blind zone directly behind the fish.
                if ((dx * hx + dy * hy) / d > BLIND_COS) {
                  // Elliptical personal space: wide along x, tight along y.
                  const qx = dx / sepX;
                  const qy = dy / sepY;
                  const q2 = qx * qx + qy * qy;
                  if (q2 < 1) {
                    const q = Math.sqrt(q2) || 1e-3;
                    const k = (1 - q) / q;
                    sx -= qx * k;
                    sy -= qy * k;
                  }
                  if (o.species === f.species) {
                    avx += o.vx;
                    avy += o.vy;
                    cx += dx;
                    cy += dy;
                    n++;
                  } else if (d < foreignSep) {
                    // Different species keep their own schools.
                    const k = ((1 - d / foreignSep) / d) * 0.6;
                    sx -= dx * k;
                    sy -= dy * k;
                  }
                  if (o.alarm > neighbourAlarm) neighbourAlarm = o.alarm;
                }
              }
            }
            j = next[j];
          }
        }
      }

      ax += sx * FISH_SEPARATION_K;
      ay += sy * FISH_SEPARATION_K;
      if (n > 0) {
        const alignK = FISH_ALIGN_K * sp.align;
        const cohesionK = FISH_COHESION_K * sp.cohesion * (1 - 0.8 * f.alarm);
        ax += (avx / n - f.vx) * alignK + (cx / n) * cohesionK;
        ay += (avy / n - f.vy) * alignK + (cy / n) * cohesionK;
        if (sp.mill > 0) {
          // Circle the local centre: the school spins into a bait ball.
          const cl = Math.hypot(cx, cy) || 1;
          ax += (-cy / cl) * f.millDir * sp.mill * (1 - f.alarm);
          ay += (cx / cl) * f.millDir * sp.mill * (1 - f.alarm);
        }
      }

      // Predators. Distance is measured to the nearest point along the front
      // half of the shark, so fish also give the flanks a wide berth.
      let fear = 0;
      for (const sh of sharks) {
        const fearR = sh.length * 0.6 + 60;
        let best = Infinity;
        let bx = 0;
        let by = 0;
        for (let k = 0; k <= 12; k += 3) {
          const nx = sh.nodes[k * 2];
          const ny = sh.nodes[k * 2 + 1];
          const d2 = (f.x - nx) ** 2 + (f.y - ny) ** 2;
          if (d2 < best) {
            best = d2;
            bx = nx;
            by = ny;
          }
        }
        const d = Math.sqrt(best);
        if (d >= fearR || d < 1e-3) continue;
        let w = 1 - d / fearR;
        w *= w;
        const awayX = (f.x - bx) / d;
        const awayY = (f.y - by) / d;
        // Fountain effect: break to whichever side of the shark's path you're on.
        const shx = Math.cos(sh.heading);
        const shy = Math.sin(sh.heading);
        const side = shx * (f.y - sh.nodes[1]) - shy * (f.x - sh.nodes[0]) >= 0 ? 1 : -1;
        ax += (awayX * 0.7 - shy * side * 0.9) * FISH_FLEE_K * w * (sp.fear ?? 1);
        ay += (awayY * 0.7 + shx * side * 0.9) * FISH_FLEE_K * w * (sp.fear ?? 1);
        fear = Math.max(fear, Math.sqrt(w));
      }

      // A bubble curtain: prey won't swim through rising air, so a ring of it herds them in.
      for (const b of this.bubbles) {
        if (b.age > BUBBLE_CURTAIN) continue;
        const dx = f.x - b.x;
        const dy = f.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > BUBBLE_R * BUBBLE_R || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const w = 1 - d / BUBBLE_R;
        ax += (dx / d) * FISH_FLEE_K * 0.6 * w;
        ay += (dy / d) * FISH_FLEE_K * 0.6 * w;
      }

      if (pointer.active) {
        const pr = 130;
        const dx = f.x - pointer.x;
        const dy = f.y - pointer.y;
        const d = Math.hypot(dx, dy);
        if (d < pr && d > 1e-3) {
          const w = (1 - d / pr) ** 2;
          ax += (dx / d) * FISH_FLEE_K * w;
          ay += (dy / d) * FISH_FLEE_K * w;
          fear = Math.max(fear, Math.sqrt(w) * 0.8);
        }
      }

      // Alarm: direct threat sets it, neighbours pass it along (slightly
      // weaker each hop), and it fades on its own.
      let alarm = Math.max(f.alarm * calmDecay, fear);
      const relayed = neighbourAlarm * 0.86;
      if (relayed > alarm) alarm += (relayed - alarm) * contagion;
      f.alarm = alarm;

      // Food in the water draws small fish in to nose around it, until a koi scares them off.
      let near2 = FOOD_SENSE * FOOD_SENSE;
      let foodX = 0;
      let foodY = 0;
      for (const p of pellets) {
        const d2 = (p.x - f.x) ** 2 + (p.y - f.y) ** 2;
        if (d2 < near2) {
          near2 = d2;
          foodX = p.x;
          foodY = p.y;
        }
      }
      if (near2 < FOOD_SENSE * FOOD_SENSE) {
        const d = Math.sqrt(near2) || 1;
        const w = (1 - d / FOOD_SENSE) * (1 - f.alarm) * FOOD_PULL;
        ax += ((foodX - f.x) / d) * w;
        ay += ((foodY - f.y) / d) * w;
      }

      // Soft walls.
      const m = 36;
      if (f.x < m) ax += (m - f.x) * 7;
      else if (f.x > W - m) ax -= (f.x - (W - m)) * 7;
      if (f.y < m) ay += (m - f.y) * 7;
      else if (f.y > H - m) ay -= (f.y - (H - m)) * 7;

      // Ambient current and a little individual restlessness.
      current(f.x, f.y, time, cur);
      ax += cur.x * 0.5 + (Math.random() - 0.5) * sp.jitter;
      ay += cur.y * 0.5 + (Math.random() - 0.5) * sp.jitter;
      // Swim level, except when bolting from danger.
      ay -= f.vy * sp.verticalDrag * (1 - 0.7 * f.alarm);

      // Relax toward a preferred speed that rises with panic.
      const preferred = sp.cruise * (1 + 1.3 * f.alarm);
      ax += (preferred - speed) * hx * 1.6;
      ay += (preferred - speed) * hy * 1.6;

      const before = Math.atan2(f.vy, f.vx);
      f.vx += ax * dt;
      f.vy += ay * dt;
      const maxSpeed = sp.maxSpeed * (1 + 1.8 * f.alarm);
      const s = Math.hypot(f.vx, f.vy);
      if (s > maxSpeed) {
        f.vx *= maxSpeed / s;
        f.vy *= maxSpeed / s;
      } else if (s < sp.minSpeed && s > 1e-3) {
        f.vx *= sp.minSpeed / s;
        f.vy *= sp.minSpeed / s;
      }
      f.turn += (angleDiff(before, Math.atan2(f.vy, f.vx)) / dt - f.turn) * Math.min(1, dt * 8);
      f.phase += dt * (7 + Math.hypot(f.vx, f.vy) * 0.12);
      f.x = clamp(f.x + f.vx * dt, -60, W + 60);
      f.y = clamp(f.y + f.vy * dt, -60, H + 60);
    }
  }

  private stepSharks(dt: number) {
    const { sharks, width: W, height: H, time } = this;
    const cxW = W / 2;
    const cyW = H / 2;
    const steer = this.steer;
    const bubbleNet = this.scene.hunt === "bubble-net";
    if (bubbleNet) this.updatePod(dt);

    for (const sh of sharks) {
      const L = sh.length;
      const nodes = sh.nodes;
      const motion = MOTION[sh.kind] ?? SHARK_MOTION;
      const hx = nodes[0];
      const hy = nodes[1];

      sh.hunger = Math.min(1, sh.hunger + dt * 0.03);

      // Momentum.
      let dx = Math.cos(sh.heading);
      let dy = Math.sin(sh.heading);

      // Wander: a slowly drifting offset on a circle ahead of the snout.
      sh.wander = clamp(sh.wander + (Math.random() - 0.5) * dt * 3.2, -1.1, 1.1);
      // Meanderers hold their line between waypoints; a strong wander would bend it into an arc.
      const wanderK = motion.meander ? 0.1 : 0.45;
      dx += Math.cos(sh.heading + sh.wander) * wanderK;
      dy += Math.sin(sh.heading + sh.wander) * wanderK;

      let hunting = false;
      let closing = 0;
      let pace = 1;
      if (bubbleNet) {
        pace = this.steerPod(sh, dt, steer);
        dx += steer.x;
        dy += steer.y;
        hunting = this.pod.phase === "lunge";
      } else {
        // Hunt.
        if (time >= sh.retargetAt) {
          sh.target = this.findPrey(sh);
          sh.retargetAt = time + 0.45;
        }
        const t = sh.target;
        // Food landing close by draws even a sated koi; anything further waits for hunger.
        const tempting = !!t && this.scene.diet === "food" && Math.hypot(t.x - hx, t.y - hy) < L * FEED_TEMPT;
        if (t && t.alive && (sh.hunger > 0.3 || tempting)) {
          // Pursuit: aim at where the fish is about to be.
          const tx = t.x + t.vx * 0.35 - hx;
          const ty = t.y + t.vy * 0.35 - hy;
          const d = Math.hypot(tx, ty) || 1;
          const w = 1.4 + 2.6 * sh.hunger;
          // Food inside a supple fish's turning circle can't be reached by turning harder; it
          // would only spin round it. Swim on, and come back round once it's outside. The circle
          // is the one the body can actually hold through a sustained turn, with some margin:
          // judging by a tighter one left koi orbiting the food just outside its reach.
          const err = angleDiff(sh.heading, Math.atan2(ty, tx));
          const circle = (L / (SHARK_NODES - 1) / (motion.bend * SUPPLE_CURL)) * 1.15;
          if (!(motion.pivot > 0 && d < 2 * circle * Math.abs(Math.sin(err)))) {
            dx += (tx / d) * w;
            dy += (ty / d) * w;
          }
          hunting = true;
          closing = clamp(1 - d / (L * 0.9), 0, 1);
        } else {
          if (motion.meander) this.meander(sh, steer);
          else this.patrol(sh, steer);
          dx += steer.x;
          dy += steer.y;
        }
      }

      // Give other sharks room, except a pod at work: whales follow one another round the
      // net and lunge side by side.
      for (const other of sharks) {
        if (other === sh || (bubbleNet && this.pod.phase !== "rest")) continue;
        for (let k = 0; k < SHARK_NODES; k += 4) {
          const ox = hx - other.nodes[k * 2];
          const oy = hy - other.nodes[k * 2 + 1];
          const d = Math.hypot(ox, oy);
          const range = (L + other.length) * motion.space;
          if (d < range && d > 1e-3) {
            // Koi crowding food jostle shoulder to shoulder rather than keeping their distance.
            const w = (1 - d / range) * 3 * motion.push * (hunting && this.scene.diet === "food" ? 0.3 : 1);
            dx += (ox / d) * w;
            dy += (oy / d) * w;
          }
        }
      }

      // Keep the headline mostly clear: a soft elliptical no-swim zone.
      const ex = (hx - cxW) / (W * 0.3);
      const ey = (hy - cyW) / (H * 0.16);
      const e2 = ex * ex + ey * ey;
      if (this.scene.clearCenter && e2 < 1) {
        const e = Math.sqrt(e2) || 1e-3;
        const w = (1 - e) * (hunting ? 1 : 2.5);
        dx += (ex / e) * w;
        dy += (ey / e) * w;
      }

      // Turn back once the snout leaves the frame, so bodies dip off-screen
      // now and then but the sharks never wander away for good.
      // Measured on the body or the screen, whichever is smaller: a dragon longer than the screen
      // is wide would otherwise stray half a screen out before turning back.
      const reachIn = Math.min(L, Math.min(W, H));
      const over = Math.max(-hx, hx - W, -hy, hy - H);
      if (over > -reachIn * 0.05) {
        const w = clamp((over + reachIn * 0.05) / (reachIn * 0.35), 0, 1) * 3.5;
        if (motion.meander) {
          // Straight off the wall it's nosing into. Steering every koi that reaches a wall at
          // the one centre point would gather the whole pond there.
          if (over === -hx) dx += w;
          else if (over === hx - W) dx -= w;
          else if (over === -hy) dy += w;
          else dy -= w;
        } else {
          const toX = cxW - hx;
          const toY = cyW - hy;
          const d = Math.hypot(toX, toY) || 1;
          dx += (toX / d) * w;
          dy += (toY / d) * w;
        }
      }

      const desired = Math.atan2(dy, dx);
      const want = angleDiff(sh.heading, desired);
      // Sharks can't pivot on the spot: the turning circle grows with speed.
      const agility = Math.min(
        hunting ? 1.7 + closing : motion.idleRate,
        Math.max(motion.pivot, sh.speed / (L * motion.turnRadius)),
      );
      let maxTurn = agility * dt;
      let turned: number;
      if (motion.pivot > 0) {
        maxTurn = Math.min(maxTurn, this.turnRoom(sh, motion, want > 0 ? 1 : -1, dt));
        turned = clamp(want * Math.min(1, dt * SUPPLE_STEER), -maxTurn, maxTurn);
      } else {
        turned = clamp(want, -maxTurn, maxTurn);
      }
      sh.heading += turned;
      sh.turn += (turned / dt - sh.turn) * Math.min(1, dt * 3);

      const cruise = (30 + L * 0.04) * (motion.cruise ?? 1);
      sh.burst *= Math.exp(-dt * 0.9);
      if (motion.meander) {
        // Excitement, not distance to the next pellet, sets a koi's pace: it stays up between
        // bites and through a moment without a target, instead of surging and slumping.
        sh.excite += ((hunting ? 1 : 0) - sh.excite) * Math.min(1, dt * (hunting ? 3 : 0.35));
        const calm = cruise * (0.75 + 0.75 * sh.burst);
        const t = sh.target;
        const near = t && t.alive ? Math.hypot(t.x - hx, t.y - hy) / L : Infinity;
        // Brake as the food falls off the nose, as a fish overshooting it would.
        const offNose = t && t.alive ? Math.max(0, Math.cos(angleDiff(sh.heading, Math.atan2(t.y - hy, t.x - hx)))) : 1;
        const rush = FEED_RUSH * L * clamp(near / FEED_EASE, 0.3, 1) * (0.35 + 0.65 * offNose);
        sh.pace += (calm + (Math.max(calm, rush) - calm) * sh.excite - sh.pace) * Math.min(1, dt * 3.5);
        sh.speed += (sh.pace - sh.speed) * Math.min(1, dt * motion.accel);
      } else {
        const targetSpeed = bubbleNet ? cruise * pace : hunting ? cruise * (1.45 + closing * 1.5) : cruise;
        sh.speed += (targetSpeed - sh.speed) * Math.min(1, dt * motion.accel);
      }
      sh.phase += dt * (motion.slither ? (sh.speed * motion.slither) / L : 2 + sh.speed / 24);

      nodes[0] += Math.cos(sh.heading) * sh.speed * dt;
      nodes[1] += Math.sin(sh.heading) * sh.speed * dt;

      // Follow-the-leader spine, with a stiffness limit per joint so the
      // body bends into a C at most and never folds back on itself.
      const seg = L / (SHARK_NODES - 1);
      const maxBend = motion.bend;
      const keep = 1 - Math.min(1, dt * motion.relax);
      let prevAngle = sh.heading + Math.PI;
      for (let k = 1; k < SHARK_NODES; k++) {
        const px = nodes[(k - 1) * 2];
        const py = nodes[(k - 1) * 2 + 1];
        let angle = Math.atan2(nodes[k * 2 + 1] - py, nodes[k * 2] - px);
        angle = prevAngle + clamp(angleDiff(prevAngle, angle) * keep, -maxBend, maxBend);
        nodes[k * 2] = px + Math.cos(angle) * seg;
        nodes[k * 2 + 1] = py + Math.sin(angle) * seg;
        prevAngle = angle;
      }

      // Feed.
      if (bubbleNet) {
        this.gulp(sh);
      } else if (sh.hunger > 0.15 || this.scene.diet === "food") {
        // Koi feed by suction and draw food in from a little way off.
        const mouthR = L * (this.scene.diet === "food" ? 0.1 : 0.05) + 8;
        const mx = nodes[0];
        const my = nodes[1];
        for (const f of this.fish) {
          if (!f.alive || !this.onMenu(f)) continue;
          if ((f.x - mx) ** 2 + (f.y - my) ** 2 < mouthR * mouthR) {
            f.alive = false;
            // Fish come back as a new school; pellets only when someone feeds again.
            f.respawnAt = this.scene.species[f.species].food ? Infinity : time + rand(3, 8);
            sh.hunger = Math.max(0, sh.hunger - 0.16);
            // A meanderer swims off somewhere new after each bite, so the crowd breaks up.
            sh.goalAt = 0;
            this.events.push({ kind: "eat", x: f.x, y: f.y });
          }
        }
      }
    }
  }

  /**
   * How far a supple fish can swing its head this step. It can flick round as fast as the slack
   * left in the front of its body allows, curling into a C; once that's spent, only swimming
   * forward makes more room, at speed · bend / segment. Turning any faster would drag the whole
   * curled body round the head as one rigid piece: a jerk each frame, and a stiff C spinning on
   * the spot. The sustained rate stops short of the joints' limit (SUPPLE_CURL) so a long turn
   * keeps a soft arc instead of locking the body into a full C. The flick belongs to the start
   * of a turn: it fades as the front curls, or the slack the body's spring frees each frame
   * would be spent at once and keep the body wound to its limit for the whole turn.
   */
  private turnRoom(sh: Shark, motion: Motion, dir: 1 | -1, dt: number) {
    const nodes = sh.nodes;
    const seg = sh.length / (SHARK_NODES - 1);
    let prev = sh.heading + Math.PI;
    let slack = 0;
    let curled = 0;
    for (let k = 1; k <= FLICK_JOINTS; k++) {
      const angle = Math.atan2(nodes[k * 2 + 1] - nodes[k * 2 - 1], nodes[k * 2] - nodes[k * 2 - 2]);
      // Turning toward dir bends these joints the other way, so their room is bend + bend·dir.
      const bend = angleDiff(prev, angle) * dir;
      slack += Math.max(0, motion.bend + bend);
      curled += Math.max(0, -bend);
      prev = angle;
    }
    const fresh = (1 - Math.min(1, curled / (FLICK_JOINTS * motion.bend))) ** 2;
    return ((sh.speed * motion.bend * SUPPLE_CURL) / seg) * dt + slack * Math.min(1, dt * 6) * fresh;
  }

  /**
   * Idle like a koi: swim for a waypoint a couple of body lengths off to one side, and on
   * reaching it (or growing bored of it) pick the next. Each new heading is a quick flick of
   * 20° to 110°, mostly onward rather than back, with a burst that fades into a glide.
   */
  private meander(sh: Shark, out: { x: number; y: number }) {
    const { width: W, height: H, time } = this;
    const L = sh.length;
    const hx = sh.nodes[0];
    const hy = sh.nodes[1];
    const motion = MOTION[sh.kind] ?? SHARK_MOTION;
    const [near, far, reached] = motion.stride;
    if (time >= sh.goalAt || Math.hypot(sh.goalX - hx, sh.goalY - hy) < L * reached) {
      // Room to swing round inside the frame: a dragon turns on a circle a third of the screen wide.
      const m = Math.max(Math.min(W, H) * 0.12, Math.min(L * motion.turnRadius, Math.min(W, H) * 0.4));
      // Of a few headings off to either side, take the one whose waypoint lands furthest from
      // the other koi, so the pond stays spread out and a crowd breaks up after feeding.
      // Waypoints are one to two lengths off: a koi is a quarter of the pond wide, and further
      // ones mostly land outside it and get clamped to the wall.
      let gx = hx;
      let gy = hy;
      let roomiest = -1;
      for (let tries = 0; tries < 4; tries++) {
        const a = sh.heading + (Math.random() < 0.5 ? 1 : -1) * rand(0.3, 1.9);
        const d = rand(near, far) * L;
        const x = clamp(hx + Math.cos(a) * d, m, W - m);
        const y = clamp(hy + Math.sin(a) * d, m, H - m);
        let room = Infinity;
        for (const o of this.sharks) {
          if (o !== sh) room = Math.min(room, Math.hypot(o.nodes[0] - x, o.nodes[1] - y));
        }
        if (room > roomiest) {
          roomiest = room;
          gx = x;
          gy = y;
        }
      }
      sh.goalX = gx;
      sh.goalY = gy;
      sh.goalAt = time + rand(4, 8);
      sh.burst = 1;
    }
    const dx = sh.goalX - hx;
    const dy = sh.goalY - hy;
    const d = Math.hypot(dx, dy) || 1;
    out.x = (dx / d) * 1.4;
    out.y = (dy / d) * 1.4;
  }

  /** Patrol: a lazy circuit around the headline. */
  private patrol(sh: Shark, out: { x: number; y: number }) {
    const { width: W, height: H, time } = this;
    const minSide = Math.min(W, H);
    const rx = (sh.nodes[0] - W / 2) / (W / minSide);
    const ry = sh.nodes[1] - H / 2;
    const r = Math.hypot(rx, ry) || 1;
    const radius = sh.orbitRadius * (1 + 0.15 * Math.sin(time * 0.05 + sh.id));
    const radial = clamp((radius - r) / radius, -1, 1);
    out.x = ((-ry / r) * sh.orbitDir + (rx / r) * radial * 0.9) * 0.55;
    out.y = ((rx / r) * sh.orbitDir + (ry / r) * radial * 0.9) * 0.55;
  }

  /**
   * Bubble-net feeding, the pod's clock. Rest until the swarms settle, then ring the densest
   * one; once the whales have swum most of the way round, everyone lunges through the middle,
   * and the pod surfaces with a splash.
   */
  private updatePod(dt: number) {
    const { pod, time, sharks } = this;
    if (pod.phase === "rest") {
      if (time < pod.until) return;
      const swarm = this.densestSwarm();
      if (!swarm) {
        pod.until = time + 2;
        return;
      }
      const { width: W, height: H } = this;
      // About 0.8 of the biggest whale's length at first, closing to about 0.6: a body can
      // curl to L/3 and turn on 0.4 L, so anything much tighter can't be held.
      pod.radius0 = Math.min(W, H) * 0.36;
      pod.radius = pod.radius0;
      this.centrePod(swarm.x, swarm.y);
      pod.dir = Math.random() < 0.5 ? 1 : -1;
      pod.started = time;
      pod.phase = "net";
      for (const sh of sharks) {
        sh.swept = 0;
        sh.ringAngle = Math.atan2(sh.nodes[1] - pod.y, sh.nodes[0] - pod.x);
      }
      return;
    }
    if (pod.phase === "net") {
      pod.radius = pod.radius0 * (1 - (1 - NET_CLOSE) * Math.min(1, (time - pod.started) / NET_TIME));
      // The net drifts with the swarm it holds.
      const held = this.centroidWithin(pod.x, pod.y, pod.radius * 1.3);
      if (held) {
        const k = Math.min(1, dt * 0.5);
        this.centrePod(pod.x + (held.x - pod.x) * k, pod.y + (held.y - pod.y) * k);
      }
      let lead = 0;
      for (const sh of sharks) lead = Math.max(lead, sh.swept);
      if (lead >= TAU * NET_TURNS || time - pod.started > NET_TIME * 1.8) {
        pod.phase = "lunge";
        pod.until = time + LUNGE_TIME;
      }
      return;
    }
    if (time >= pod.until) {
      for (const sh of sharks) this.events.push({ kind: "splash", x: sh.nodes[0], y: sh.nodes[1] });
      pod.phase = "rest";
      pod.until = time + rand(5, 8);
    }
  }

  /** Put the net's centre at (x, y), kept far enough from the edges for the whole ring. */
  private centrePod(x: number, y: number) {
    const { pod, width: W, height: H } = this;
    const m = pod.radius0 + 30;
    pod.x = W > 2 * m ? clamp(x, m, W - m) : W / 2;
    pod.y = H > 2 * m ? clamp(y, m, H - m) : H / 2;
  }

  /** Centroid of the live, non-food fish within r of (x, y), or null if there are too few. */
  private centroidWithin(x: number, y: number, r: number) {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const f of this.fish) {
      if (!f.alive || this.scene.species[f.species].food) continue;
      if ((f.x - x) ** 2 + (f.y - y) ** 2 > r * r) continue;
      sx += f.x;
      sy += f.y;
      n++;
    }
    return n > 5 ? { x: sx / n, y: sy / n } : null;
  }

  /** One whale's share of the pod's plan; returns its pace as a multiple of cruise. */
  private steerPod(sh: Shark, dt: number, out: { x: number; y: number }) {
    const pod = this.pod;
    const hx = sh.nodes[0];
    const hy = sh.nodes[1];
    const settle = Math.min(1, dt * 3);
    if (pod.phase === "rest") {
      sh.gape += (0 - sh.gape) * settle;
      this.patrol(sh, out);
      return 1;
    }
    const rx = hx - pod.x;
    const ry = hy - pod.y;
    const r = Math.hypot(rx, ry) || 1;
    if (pod.phase === "net") {
      if (r > pod.radius * 1.4) {
        // Still on the way: head for the ring, already leaning into the circling direction.
        out.x = ((-rx / r) * 3 + (-ry / r) * pod.dir * 0.8) * 2.2;
        out.y = ((-ry / r) * 3 + (rx / r) * pod.dir * 0.8) * 2.2;
        sh.ringAngle = Math.atan2(ry, rx);
        sh.gape += (0 - sh.gape) * settle;
        return 2;
      }
      // Swim the ring, pulled back onto it from either side, blowing bubbles beneath.
      const radial = clamp((pod.radius - r) / pod.radius, -1, 1);
      out.x = ((-ry / r) * pod.dir + (rx / r) * radial * 1.6) * 2.2;
      out.y = ((rx / r) * pod.dir + (ry / r) * radial * 1.6) * 2.2;
      const angle = Math.atan2(ry, rx);
      const onRing = Math.abs(r - pod.radius) < pod.radius * 0.3;
      if (onRing) sh.swept += angleDiff(sh.ringAngle, angle) * pod.dir;
      sh.ringAngle = angle;
      // Air goes out under the head and trails behind it as the whale swims on.
      const bx = sh.nodes[6];
      const by = sh.nodes[7];
      if (onRing && Math.hypot(bx - sh.lastBubbleX, by - sh.lastBubbleY) > BUBBLE_SPACING) {
        this.bubbles.push({ x: bx + rand(-5, 5), y: by + rand(-5, 5), age: 0 });
        sh.lastBubbleX = bx;
        sh.lastBubbleY = by;
      }
      sh.gape += (0 - sh.gape) * settle;
      return 2.4;
    }
    // Lunge: up through the middle, the mouth opening wide as it closes in. Each whale aims
    // a little to its own side of the centre, so the pod surfaces side by side, not in a pile.
    const tx = pod.x + (rx / r) * pod.radius * 0.25 - hx;
    const ty = pod.y + (ry / r) * pod.radius * 0.25 - hy;
    const td = Math.hypot(tx, ty) || 1;
    out.x = (tx / td) * 4;
    out.y = (ty / td) * 4;
    sh.gape += ((r < pod.radius ? 1 : 0.3) - sh.gape) * settle;
    return 2.6;
  }

  /** A lunging whale engulfs everything in its open mouth, a swarm at a time, without a sound. */
  private gulp(sh: Shark) {
    if (sh.gape < 0.5) return;
    const L = sh.length;
    const mx = sh.nodes[0] + Math.cos(sh.heading) * L * 0.04;
    const my = sh.nodes[1] + Math.sin(sh.heading) * L * 0.04;
    const mouthR = L * 0.12 * sh.gape + 6;
    for (const f of this.fish) {
      if (!f.alive || !this.onMenu(f)) continue;
      if ((f.x - mx) ** 2 + (f.y - my) ** 2 < mouthR * mouthR) {
        f.alive = false;
        f.respawnAt = this.time + rand(3, 8);
      }
    }
  }

  /**
   * Centre of the best patch of fish to ring, from the spatial hash: dense, and not too far
   * from where the pod already is. Null when there's no real swarm.
   */
  private densestSwarm() {
    const { bucketCount, bucketHead, bucketNext, bucketCols: cols, bucketRows: rows, fish, sharks } = this;
    let px = 0;
    let py = 0;
    for (const sh of sharks) {
      px += sh.nodes[0] / sharks.length;
      py += sh.nodes[1] / sharks.length;
    }
    const size = this.perception;
    const reach = Math.min(this.width, this.height) * 0.8;
    let best = -1;
    let bestScore = 0;
    for (let b = 0; b < bucketCount.length; b++) {
      if (bucketCount[b] < 8) continue;
      // Bucket centres, undoing the hash's two-bucket pad.
      const bx = ((b % cols) - 2 + 0.5) * size;
      const by = (((b / cols) | 0) - 2 + 0.5) * size;
      const score = bucketCount[b] * Math.exp(-Math.hypot(bx - px, by - py) / reach);
      if (score > bestScore) {
        bestScore = score;
        best = b;
      }
    }
    if (best < 0) return null;
    const bc = best % cols;
    const br = (best / cols) | 0;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let r = Math.max(0, br - 1); r <= Math.min(rows - 1, br + 1); r++) {
      for (let c = Math.max(0, bc - 1); c <= Math.min(cols - 1, bc + 1); c++) {
        for (let j = bucketHead[r * cols + c]; j !== -1; j = bucketNext[j]) {
          sx += fish[j].x;
          sy += fish[j].y;
          n++;
        }
      }
    }
    return { x: sx / n, y: sy / n };
  }

  /** Rising air surfaces with a fizz of tiny ripples, foams outward a little, then pops. */
  private stepBubbles(dt: number) {
    const { bubbles, pod } = this;
    for (let k = bubbles.length - 1; k >= 0; k--) {
      const b = bubbles[k];
      const before = b.age;
      b.age += dt;
      if (before < BUBBLE_RISE && b.age >= BUBBLE_RISE && Math.random() < 0.5) {
        this.events.push({ kind: "drop", x: b.x, y: b.y, strength: 0.58 });
      }
      if (b.age >= BUBBLE_RISE) {
        // Upwelling under the net spreads the foam outward from its centre.
        const dx = b.x - pod.x;
        const dy = b.y - pod.y;
        const d = Math.hypot(dx, dy) || 1;
        b.x += (dx / d) * 6 * dt;
        b.y += (dy / d) * 6 * dt;
      }
      if (b.age > BUBBLE_RISE + BUBBLE_LIFE) bubbles.splice(k, 1);
    }
  }

  /**
   * Pick prey in the shark's forward cone, preferring close fish in sparse
   * buckets (stragglers) over fish buried in a dense school.
   */
  private findPrey(sh: Shark): Fish | null {
    // Koi hear food land anywhere in the pond and turn round for it; sharks hunt what's ahead.
    const anywhere = this.scene.diet === "food";
    const range = anywhere ? Infinity : sh.length * 0.9 + 160;
    const hx = sh.nodes[0];
    const hy = sh.nodes[1];
    const fx = Math.cos(sh.heading);
    const fy = Math.sin(sh.heading);
    let best: Fish | null = null;
    let bestScore = Infinity;
    let currentScore = Infinity;

    for (const f of this.fish) {
      if (!f.alive || !this.onMenu(f)) continue;
      const dx = f.x - hx;
      const dy = f.y - hy;
      const d = Math.hypot(dx, dy);
      if (d > range || d < 1e-3) continue;
      const cos = (dx * fx + dy * fy) / d;
      if (cos < 0.2 && !anywhere) continue;
      const crowd = this.bucketCount[this.bucketOf(f.x, f.y)];
      const score = d * (1 + (1 - cos) * 0.8) * (1 + crowd * 0.07);
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
      if (f === sh.target) currentScore = score;
    }
    // Stick with the current target unless something is clearly better.
    if (sh.target && currentScore < bestScore * 1.3) return sh.target;
    return best;
  }

  /** Whether the big creatures eat this: fish in the ocean, pellets in the pond. */
  private onMenu(f: Fish) {
    return !!this.scene.species[f.species].food === (this.scene.diet === "food");
  }

  private respawn() {
    const { time, width: W, height: H } = this;
    const due: Fish[] = [];
    for (const f of this.fish) if (!f.alive && f.respawnAt <= time) due.push(f);
    if (due.length === 0) return;
    if (due.length < 6 && time - this.lastSpawn < 9) return;
    this.lastSpawn = time;

    // A new school swims in from a random edge.
    const side = randInt(0, 3);
    const along = rand(0.15, 0.85);
    const x = side === 0 ? -20 : side === 1 ? W + 20 : along * W;
    const y = side === 2 ? -20 : side === 3 ? H + 20 : along * H;
    const inward = Math.atan2(H / 2 - y, W / 2 - x) + rand(-0.5, 0.5);
    const species = pickSpecies(this.scene.species);
    const sp = this.scene.species[species];
    const millDir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
    for (const f of due.slice(0, sp.schoolSize[1])) {
      f.alive = true;
      f.species = species;
      f.alarm = 0;
      f.turn = 0;
      f.millDir = millDir;
      f.x = x + rand(-1, 1) * this.perception;
      f.y = y + rand(-1, 1) * this.perception;
      f.vx = Math.cos(inward) * sp.cruise * 1.4;
      f.vy = Math.sin(inward) * sp.cruise * 1.4;
    }
  }
}
