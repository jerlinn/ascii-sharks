// Run with `node tools/ripple-lab.mjs`. Mirrors propagate() and stamp() in src/renderer.ts.
// Compare drop models: static bump vs. short oscillating source (crater + rebound).
const cw = 10.3, ch = 15, ky = (cw / ch) ** 2, SHOW = 0.08;
function sim({ C2, D, source, label }) {
  const cols = 201, rows = 121, c0 = 100, r0 = 60;
  let h = new Float32Array(cols * rows), p = new Float32Array(cols * rows);
  const stamp = (amt, R) => {
    for (let r = r0 - R; r <= r0 + R; r++) for (let c = c0 - R; c <= c0 + R; c++) {
      const d = Math.hypot(c - c0, (r - r0) * 1.4); if (d > R + 0.5) continue;
      h[r * cols + c] += amt * (1 - d / (R + 1));
    }
  };
  const lines = [];
  let firstTwo = null;
  for (let f = 0; f < 150; f++) {
    source(f, stamp);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = r * cols + c, hi = h[i];
      const l = c > 0 ? h[i - 1] : hi, rt = c < cols - 1 ? h[i + 1] : hi, u = r > 0 ? h[i - cols] : hi, d = r < rows - 1 ? h[i + cols] : hi;
      p[i] = (2 * hi - p[i] + C2 * (l + rt - 2 * hi + (u + d - 2 * hi) * ky)) * D;
    }
    [h, p] = [p, h];
    // crests along the row: local maxima above SHOW
    const crests = [];
    for (let c = c0 + 1; c < cols - 1; c++) {
      const v = h[r0 * cols + c];
      if (v > SHOW && v >= h[r0 * cols + c - 1] && v >= h[r0 * cols + c + 1]) crests.push(Math.round((c - c0) * cw));
    }
    if (firstTwo === null && crests.length >= 2) firstTwo = f;
    if ([6, 12, 24, 48, 72, 96, 120].includes(f)) lines.push(`  t=${(f / 60).toFixed(2)}s crests(px): ${crests.join(",") || "-"}`);
  }
  console.log(`${label}: 2 rings visible from frame ${firstTwo}`);
  console.log(lines.join("\n"));
}
const bump = (f, stamp) => { if (f === 0) stamp(1, 2); };
// Crater then rebound: the surface at the impact rings for a few cycles, decaying fast.
const oscillate = (freq, amp, tau) => (f, stamp) => {
  const t = f / 60;
  if (t < 3 / freq) stamp(amp * Math.sin(2 * Math.PI * freq * t) * Math.exp(-t / tau), 1);
};
sim({ label: "current: bump, C2=0.25, D=0.985", C2: 0.25, D: 0.985, source: bump });
sim({ label: "bump, half speed C2=0.0625, D=0.992", C2: 0.0625, D: 0.992, source: bump });
sim({ label: "oscillating 3Hz, half speed", C2: 0.0625, D: 0.992, source: oscillate(3, 0.35, 0.35) });
sim({ label: "oscillating 4Hz, half speed", C2: 0.0625, D: 0.992, source: oscillate(4, 0.35, 0.3) });
