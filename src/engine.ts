import { AsciiRenderer } from "./renderer";
import { OCEAN, themed, type Scene, type Theme } from "./scene";
import { World } from "./world";

export const STEP = 1 / 60;
const MAX_STEPS = 4;

/**
 * Wires World + AsciiRenderer to a canvas: fixed-timestep loop, resize,
 * pointer input, pausing off-screen, and prefers-reduced-motion.
 */
export class OceanEngine {
  private world: World;
  private renderer: AsciiRenderer;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private visible = true;
  private reducedMotion: MediaQueryList;
  private resizeObserver: ResizeObserver;
  private intersectionObserver: IntersectionObserver;
  private disposed = false;
  /** Paused: no frames of its own; time moves only through advance() and draw(). */
  private paused = false;
  /** The scene as given, before the theme recolours it. */
  private base: Scene;
  private currentTheme: Theme = "dark";

  /** maxDpr caps the canvas resolution; an export lifts it to render at the capture's scale. */
  constructor(
    private canvas: HTMLCanvasElement,
    scene: Scene = OCEAN,
    private options: { maxDpr?: number } = {},
  ) {
    this.base = scene;
    this.world = new World(scene);
    this.renderer = new AsciiRenderer(canvas);
    this.renderer.setFontFamily(getComputedStyle(canvas).fontFamily);
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.intersectionObserver = new IntersectionObserver(([entry]) => {
      this.visible = entry.isIntersecting;
      this.schedule();
    });
    this.intersectionObserver.observe(canvas);

    this.reducedMotion.addEventListener("change", this.onMotionPreference);
    window.addEventListener("pointermove", this.onPointerMove, { passive: true });
    window.addEventListener("pointerdown", this.onPointerDown, { passive: true });
    document.documentElement.addEventListener("pointerleave", this.onPointerLeave);
    window.addEventListener("blur", this.onPointerLeave);

    this.resize();
    // Canvas text can't trigger a webfont load; once the mono face is in, redraw.
    document.fonts?.load(`600 16px ${getComputedStyle(canvas).fontFamily}`).then(() => {
      if (!this.disposed && this.reducedMotion.matches) this.drawStill();
    });
    this.schedule();
  }

  destroy() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.intersectionObserver.disconnect();
    this.reducedMotion.removeEventListener("change", this.onMotionPreference);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerdown", this.onPointerDown);
    document.documentElement.removeEventListener("pointerleave", this.onPointerLeave);
    window.removeEventListener("blur", this.onPointerLeave);
  }

  /** The scene as given (untinted by the theme). */
  get scene() {
    return this.base;
  }

  setScene(scene: Scene) {
    this.base = scene;
    this.world.setScene(themed(scene, this.currentTheme));
    if (this.reducedMotion.matches) this.drawStill(true);
  }

  /** Light or dark. Only recolours, and only scenes with a daylight palette; nothing reseeds. */
  setTheme(theme: Theme) {
    this.currentTheme = theme;
    this.world.restyle(themed(this.base, theme));
    if (this.reducedMotion.matches) this.drawStill(false);
  }

  get theme() {
    return this.currentTheme;
  }

  /**
   * Let the scene's wind blow or die down, without disturbing anything else in the water. It
   * eases over a couple of seconds; `instant` sets it outright, as when a page opens.
   */
  setWind(on: boolean, instant = false) {
    this.world.setWind(on, instant);
  }

  get wind() {
    return this.world.windEnabled;
  }

  /** Let a scene's canopy cast its shade or not; it fades over about a second unless `instant`. */
  setShade(on: boolean, instant = false) {
    // A still frame has no time to fade over.
    this.world.setShade(on, instant || this.reducedMotion.matches);
    if (this.reducedMotion.matches) this.drawStill(false);
  }

  get shade() {
    return this.world.shadeEnabled;
  }

  /** Stop the clock for frame-by-frame capture; from here on only advance() and draw() move it. */
  pause() {
    this.paused = true;
    cancelAnimationFrame(this.raf);
  }

  /** Seconds simulated so far. */
  get time() {
    return this.world.time;
  }

  /** Run the simulation dt seconds on, in fixed steps, without drawing. */
  advance(dt: number) {
    for (let i = Math.round(dt / STEP); i > 0; i--) this.world.step(STEP);
  }

  /** Draw the water as it is now; dt is how long since the last draw, for wakes and ripples. */
  draw(dt: number) {
    this.renderer.render(this.world, dt);
  }

  /** A click on the water at (x, y) px in the canvas: food or a splash, as the scene has it. */
  poke(x: number, y: number) {
    this.world.poke(x, y);
  }

  /** The whales' feeding: "rest", "net" while they ring a swarm, "lunge" up through it. */
  get podPhase() {
    return this.world.podPhase;
  }

  /** Food still afloat. */
  get pellets() {
    return this.world.fish.filter((f) => f.alive && this.world.scene.species[f.species].food).length;
  }

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const dpr = Math.min(window.devicePixelRatio || 1, this.options.maxDpr ?? 2);
    this.renderer.resize(rect.width, rect.height, dpr);
    this.world.resize(rect.width, rect.height, this.renderer.cellWidth, this.renderer.cellHeight);
    if (this.reducedMotion.matches) this.drawStill();
  }

  private schedule() {
    cancelAnimationFrame(this.raf);
    if (this.disposed || this.paused || !this.visible || this.reducedMotion.matches) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.acc += dt;
    let steps = 0;
    while (this.acc >= STEP && steps < MAX_STEPS) {
      this.world.step(STEP);
      this.acc -= STEP;
      steps++;
    }
    if (steps === MAX_STEPS) this.acc = 0;
    this.renderer.render(this.world, dt);
    this.raf = requestAnimationFrame(this.frame);
  };

  /** Reduced motion: let the ecosystem settle, then show a single frame. */
  private drawStill(settle = this.world.time < 4) {
    if (settle) {
      for (let i = 0; i < 240; i++) this.world.step(STEP);
    }
    this.renderer.render(this.world, STEP);
  }

  private onMotionPreference = () => {
    if (this.reducedMotion.matches) {
      cancelAnimationFrame(this.raf);
      this.drawStill();
    } else {
      this.schedule();
    }
  };

  private toLocal(e: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const inside = x >= 0 && y >= 0 && x <= rect.width && y <= rect.height;
    return { x, y, inside };
  }

  private onPointerMove = (e: PointerEvent) => {
    const { x, y, inside } = this.toLocal(e);
    const p = this.world.pointer;
    p.x = x;
    p.y = y;
    p.active = inside && e.pointerType !== "touch";
  };

  private onPointerDown = (e: PointerEvent) => {
    const { x, y, inside } = this.toLocal(e);
    if (inside && !this.reducedMotion.matches) this.world.poke(x, y);
  };

  private onPointerLeave = () => {
    this.world.pointer.active = false;
  };
}
