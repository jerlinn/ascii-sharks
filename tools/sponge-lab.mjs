// Run with `node tools/sponge-lab.mjs`. Mirrors propagate() in src/renderer.ts.
// Echo test: late-time wave energy inside a canvas-sized window, compared with the same drop
// on an effectively infinite sea (a grid so big the ring never reaches its edges).
const cw = 10, ch = 15, ky = (cw / ch) ** 2, C2 = 0.0625, D = 0.992;
const WIN_C = 128, WIN_R = 53;   // a 1280×800 canvas in cells
function run(pad, spongePx, maxDamp) {
  const cols = WIN_C + 2 * pad, rows = WIN_R + 2 * pad;
  const c0 = pad + 30, r0 = pad + 20;   // drop near the window's top-left
  let h = new Float32Array(cols * rows), p = new Float32Array(cols * rows);
  const sponge = new Float32Array(cols * rows).fill(1);
  if (spongePx > 0) for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const d = Math.min(c * cw, (cols - 1 - c) * cw, r * ch, (rows - 1 - r) * ch) / spongePx;
    if (d < 1) sponge[r * cols + c] = 1 - maxDamp * (1 - d) ** 2;
  }
  let late = 0;
  for (let f = 0; f < 600; f++) {
    const t = f / 60;
    if (t < 0.75) {
      const amt = 0.35 * Math.sin(2 * Math.PI * 4 * t) * Math.exp(-t / 0.3);
      for (let r = r0 - 1; r <= r0 + 1; r++) for (let c = c0 - 1; c <= c0 + 1; c++) {
        const d = Math.hypot(c - c0, (r - r0) * 1.4); if (d > 1.5) continue; h[r * cols + c] += amt * (1 - d / 2);
      }
    }
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = r * cols + c, hi = h[i];
      const l = c > 0 ? h[i - 1] : hi, rt = c < cols - 1 ? h[i + 1] : hi, u = r > 0 ? h[i - cols] : hi, d = r < rows - 1 ? h[i + cols] : hi;
      p[i] = (2 * hi - p[i] + C2 * (l + rt - 2 * hi + (u + d - 2 * hi) * ky)) * D * sponge[i];
    }
    [h, p] = [p, h];
    if (f >= 240) { // after the ring has had time to reach the window's edges and come back
      let e = 0;
      for (let r = pad; r < pad + WIN_R; r++) for (let c = pad; c < pad + WIN_C; c++) e += h[r * cols + c] ** 2;
      late += e;
    }
  }
  return late;
}
const sea = run(140, 0, 0);
const show = (name, v) => console.log(name.padEnd(20), `late energy ${(v / sea).toFixed(2)}× the open sea`);
show("open sea (ref)", sea);
show("mirror wall", run(0, 0, 0));
show("sponge 60px 0.10", run(0, 60, 0.1));
show("sponge 100px 0.08", run(0, 100, 0.08));
show("sponge 140px 0.06", run(0, 140, 0.06));
show("sponge 140px 0.12", run(0, 140, 0.12));
