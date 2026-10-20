import { STEP, type OceanEngine } from "./src/engine";

/**
 * One take per scene for video export, each the scene's core moment told once, opening and
 * closing on the water at rest. A take, not a loop: the creatures never swim back to where they
 * started, and a crossfade between two casts of them shows as ghosts.
 */

/** mulberry32: a small seeded stream. */
function stream(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seed Math.random before the engine seeds its cast. The simulation and the drawing each draw
 * on a stream of their own, so the creatures swim the same however many frames a second are
 * drawn, and a quick low-frame-rate dry run shows the very story the final export will.
 */
export function seedRandom(seed: number) {
  const streams = { world: stream(seed), render: stream(seed ^ 0x9e3779b9) };
  Math.random = streams.world;
  return streams;
}

/** What a story can do with the clock. */
interface Clock {
  engine: OceanEngine;
  canvas: HTMLCanvasElement;
  /** dt seconds on, then one frame drawn. */
  step(dt: number): void;
  /** Run on, drawing at 30 fps, until `done`. The simulation keeps history, so only forward. */
  runUntil(done: () => boolean): void;
  /** Click the water at a fraction of the canvas, at simulation time t. */
  castAt(t: number, x: number, y: number): void;
}

interface Story {
  /** Run to the opening frame; returns its time. */
  open(): number;
  /** Whether the frame just drawn is the last. */
  ended(): boolean;
  /** Anything the take left undone that would vanish at the cut; empty when clean. */
  leftover(): string;
}

/**
 * Koi: calm water, a hand casts food three times at one spot, the koi rush in and clear it,
 * then drift back to idling. Nothing is left afloat, so it ends on the quiet pond it opened on.
 */
function koiStory({ engine, castAt, runUntil }: Clock): Story {
  /** Long enough for the cast to spread out from where it was seeded. */
  const OPEN = 14;
  /** The water as it is, before the hand. */
  const CALM = 4;
  /** First handful → every pellet eaten and the koi back to an idle glide. */
  const FEAST = 18;
  /** Where the hand casts, as fractions of the canvas: open water a little left of and below centre. */
  const SPOT = { x: 0.42, y: 0.58 };
  /** Three handfuls close together, the way a hand casts food: seconds after the first, offset. */
  const HANDFULS = [
    { at: 0, dx: 0, dy: 0 },
    { at: 0.8, dx: 0.04, dy: -0.025 },
    { at: 1.6, dx: -0.03, dy: 0.03 },
  ];
  return {
    open() {
      for (const h of HANDFULS) castAt(OPEN + CALM + h.at, SPOT.x + h.dx, SPOT.y + h.dy);
      runUntil(() => engine.time >= OPEN - STEP / 2);
      return OPEN;
    },
    ended: () => engine.time >= OPEN + CALM + FEAST - STEP / 2,
    leftover: () => (engine.pellets ? `${engine.pellets} pellets still afloat` : ""),
  };
}

/**
 * Whales: the pod at rest after a feed, then one whole bubble net: they ring the densest swarm,
 * tighten it, lunge up through the middle and surface with a splash, and the water settles. The
 * pod keeps its own clock, so the take runs from one splash to the next rather than to a length.
 */
function whalesStory({ engine, runUntil }: Clock): Story {
  /** Into the rest after a splash: the rings have spread and the swarms are gathering again. */
  const AFTER_SPLASH = 3;
  /** After the take's own splash, for its rings to spread and the pod to settle. */
  const SETTLE = 4;
  let surfaced = -1;
  let last = engine.podPhase;
  /** The time the pod last came up from a lunge, watched from step to step. */
  const watch = () => {
    const phase = engine.podPhase;
    if (last === "lunge" && phase === "rest") surfaced = engine.time;
    last = phase;
  };
  return {
    open() {
      // The first net is cast before the swarms have formed; open after it, at rest.
      runUntil(() => (watch(), surfaced >= 0));
      const opening = surfaced + AFTER_SPLASH;
      runUntil(() => engine.time >= opening - STEP / 2);
      surfaced = -1;
      return opening;
    },
    ended: () => (watch(), surfaced >= 0 && engine.time >= surfaced + SETTLE - STEP / 2),
    leftover: () => "",
  };
}

const STORIES: Record<string, (clock: Clock) => Story> = { koi: koiStory, whales: whalesStory };

/** Hand the engine's clock to the export script as `window.story`. */
export function exposeStory(engine: OceanEngine, canvas: HTMLCanvasElement, streams: ReturnType<typeof seedRandom>) {
  engine.pause();
  // Clicks waiting for the clock to reach them.
  const casts: { t: number; x: number; y: number }[] = [];

  function step(dt: number) {
    Math.random = streams.world;
    for (let i = Math.round(dt / STEP); i > 0; i--) {
      while (casts.length && casts[0].t <= engine.time + 1e-9) {
        const { x, y } = casts.shift()!;
        engine.poke(x * canvas.clientWidth, y * canvas.clientHeight);
      }
      engine.advance(STEP);
    }
    Math.random = streams.render;
    engine.draw(dt);
  }

  const clock: Clock = {
    engine,
    canvas,
    step,
    runUntil(done) {
      while (!done()) step(STEP * 2);
    },
    castAt(t, x, y) {
      casts.push({ t, x, y });
      casts.sort((a, b) => a.t - b.t);
    },
  };

  let story: Story | null = null;
  const api = {
    step,
    /** Run the scene's story to its opening frame; returns the opening's time. */
    open(scene: string) {
      const make = STORIES[scene];
      if (!make) throw new Error(`no story for scene "${scene}"; there are: ${Object.keys(STORIES).join(", ")}`);
      story = make(clock);
      return story.open();
    },
    ended: () => story!.ended(),
    leftover: () => story!.leftover(),
  };
  (window as unknown as { story: typeof api }).story = api;
}
