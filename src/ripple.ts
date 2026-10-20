/**
 * Ripple water, simulated on its own square grid and sampled into the ASCII cells for display.
 *
 * The character cells are taller than wide, so a wave there is resolved more coarsely up and
 * down than across; its numerical error differs by direction and rings come out wide, like a
 * rounded rectangle. A square grid with the isotropic nine-point Laplacian keeps them round.
 *
 * The surface is a damped wave equation, h' = (2h − h_prev + c²∇²h) · damping, which a surface
 * drift (wind) carries along by shifting both time levels each step. Edges either reflect, like
 * a pond wall, or soak waves up in a sponge, like open water running on past the frame.
 */

// c² = 1/16 of a grid step is about 155 px/s at 10 px cells: raindrop ripples at a koi's scale.
const C2 = 0.0625;
const DAMP = 0.992;
// Open water: damping ramps in quadratically over SPONGE_PX, to SPONGE_MAX per step at the edge.
// Wide and gentle beats narrow and strong; a steep ramp reflects too (tools/sponge-lab.mjs).
const SPONGE_PX = 140;
const SPONGE_MAX = 0.06;

export class RippleField {
  private cols = 0;
  private rows = 0;
  private size = 10;
  private h = new Float32Array(0);
  private prev = new Float32Array(0);
  private scratchH = new Float32Array(0);
  private scratchPrev = new Float32Array(0);
  private sponge: Float32Array | null = null;
  private open = false;

  /** Cover a width × height area with square cells `size` px across. */
  resize(width: number, height: number, size: number) {
    this.size = size;
    this.cols = Math.ceil(width / size) + 1;
    this.rows = Math.ceil(height / size) + 1;
    const n = this.cols * this.rows;
    this.h = new Float32Array(n);
    this.prev = new Float32Array(n);
    this.scratchH = new Float32Array(n);
    this.scratchPrev = new Float32Array(n);
    this.buildSponge();
  }

  /** Reflecting walls (a pond) or an absorbing sponge (open water). */
  setOpen(open: boolean) {
    this.open = open;
    this.buildSponge();
  }

  clear() {
    this.h.fill(0);
    this.prev.fill(0);
  }

  /** Push the surface by `amount` at (x, y) px, falling off linearly to nothing at radius px. */
  stamp(x: number, y: number, radius: number, amount: number) {
    const { cols, rows, size, h } = this;
    const reach = radius + size;
    const c0 = Math.max(0, Math.floor((x - reach) / size));
    const c1 = Math.min(cols - 1, Math.ceil((x + reach) / size));
    const r0 = Math.max(0, Math.floor((y - reach) / size));
    const r1 = Math.min(rows - 1, Math.ceil((y + reach) / size));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const d = Math.hypot(c * size - x, r * size - y);
        if (d > reach) continue;
        const i = r * cols + c;
        h[i] = Math.max(-1.6, Math.min(1.6, h[i] + amount * (1 - d / reach)));
      }
    }
  }

  /** Nodes across and down, and px between them. */
  get grid() {
    return { cols: this.cols, rows: this.rows, size: this.size };
  }

  /**
   * The surface's slope at every node, by central differences, in height per px: into gx and gy,
   * each sized like the grid. Light bends and glints by these.
   */
  slopes(gx: Float32Array, gy: Float32Array) {
    const { cols, rows, size, h } = this;
    const k = 0.5 / size;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        gx[i] = (h[c < cols - 1 ? i + 1 : i] - h[c > 0 ? i - 1 : i]) * k;
        gy[i] = (h[r < rows - 1 ? i + cols : i] - h[r > 0 ? i - cols : i]) * k;
      }
    }
  }

  /** Surface height at (x, y) px, bilinearly interpolated. */
  sample(x: number, y: number) {
    return this.bilinear(this.h, x / this.size, y / this.size);
  }

  /** Advance by dt seconds (in 1/60 s steps), with the surface drifting at (windX, windY) px/s. */
  step(dt: number, windX: number, windY: number) {
    const steps = Math.max(1, Math.min(3, Math.round(dt * 60)));
    for (let n = 0; n < steps; n++) {
      this.propagate();
      if (windX !== 0 || windY !== 0) this.drift(windX / 60 / this.size, windY / 60 / this.size);
    }
  }

  private propagate() {
    const { cols, rows, h, prev, sponge } = this;
    for (let r = 0; r < rows; r++) {
      const up = r > 0 ? -cols : 0;
      const down = r < rows - 1 ? cols : 0;
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const left = c > 0 ? -1 : 0;
        const right = c < cols - 1 ? 1 : 0;
        const hi = h[i];
        // Nine-point Laplacian: (4·edges + corners − 20·centre) / 6. Mirrored at the walls.
        const edges = h[i + left] + h[i + right] + h[i + up] + h[i + down];
        const corners = h[i + up + left] + h[i + up + right] + h[i + down + left] + h[i + down + right];
        const laplacian = (4 * edges + corners - 20 * hi) / 6;
        // prev[i] is read once, then overwritten with the next step.
        prev[i] = (2 * hi - prev[i] + C2 * laplacian) * DAMP * (sponge ? sponge[i] : 1);
      }
    }
    this.h = prev;
    this.prev = h;
  }

  /** Carry both time levels downwind by (dx, dy) cells: semi-Lagrangian, so any speed is stable. */
  private drift(dx: number, dy: number) {
    const { cols, rows } = this;
    for (const [src, dst] of [
      [this.h, this.scratchH],
      [this.prev, this.scratchPrev],
    ] as const) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) dst[r * cols + c] = this.bilinear(src, c - dx, r - dy);
      }
    }
    [this.h, this.scratchH] = [this.scratchH, this.h];
    [this.prev, this.scratchPrev] = [this.scratchPrev, this.prev];
  }

  private bilinear(field: Float32Array, gx: number, gy: number) {
    const { cols, rows } = this;
    const x = Math.max(0, Math.min(cols - 1.001, gx));
    const y = Math.max(0, Math.min(rows - 1.001, gy));
    const c = Math.floor(x);
    const r = Math.floor(y);
    const fx = x - c;
    const fy = y - r;
    const i = r * cols + c;
    const top = field[i] + (field[i + 1] - field[i]) * fx;
    const bottom = field[i + cols] + (field[i + cols + 1] - field[i + cols]) * fx;
    return top + (bottom - top) * fy;
  }

  private buildSponge() {
    const { cols, rows, size } = this;
    if (!this.open || cols === 0) {
      this.sponge = null;
      return;
    }
    const sponge = new Float32Array(cols * rows).fill(1);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const d = Math.min(c, cols - 1 - c, r, rows - 1 - r) * (size / SPONGE_PX);
        if (d < 1) sponge[r * cols + c] = 1 - SPONGE_MAX * (1 - d) ** 2;
      }
    }
    this.sponge = sponge;
  }
}
