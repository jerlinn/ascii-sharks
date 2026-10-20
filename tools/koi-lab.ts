// Koi motion check: C-shape locks and tail jerk over 5 fixed seeds × 120 s.
// Run: node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/bin/esbuild tools/koi-lab.ts --bundle --platform=node --log-level=warning | node
import { World } from "../src/world";
import { KOI_POND } from "../src/scene";
const ang = (d: number) => { while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
function seed(n: number) { let a = n >>> 0; Math.random = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
let lockedS = 0, seconds = 0, holds = 0, longest = 0; const jerks: number[] = [];
for (const sd of [1, 2, 3, 4, 5]) {
  seed(sd);
  const w = new World({ ...KOI_POND, rain: 0 });
  w.resize(1280, 800, 10, 15);
  const held = new Map<number, number>(); const hist = new Map<number, Float32Array[]>();
  for (let f = 0; f < 60 * 120; f++) {
    w.step(1 / 60); w.events.length = 0;
    if (f < 120) continue;
    for (const sh of w.sharks) {
      seconds += 1 / 60;
      let prev = sh.heading + Math.PI, pos = 0, neg = 0;
      for (let k = 1; k < 20; k++) { const a = Math.atan2(sh.nodes[k*2+1]-sh.nodes[k*2-1], sh.nodes[k*2]-sh.nodes[k*2-2]); const b = ang(a - prev); prev = a; if (b > 0.198) pos++; if (b < -0.198) neg++; }
      const t = held.get(sh.id) ?? 0;
      if (Math.max(pos, neg) >= 12) { held.set(sh.id, t + 1 / 60); lockedS += 1 / 60; } else { if (t > 1) { holds++; longest = Math.max(longest, t); } held.set(sh.id, 0); }
      const h = hist.get(sh.id) ?? []; h.push(Float32Array.from(sh.nodes)); if (h.length > 3) h.shift(); hist.set(sh.id, h);
      if (h.length === 3) { let j = 0; for (let k = 1; k < 20; k++) j = Math.max(j, Math.hypot(h[2][k*2]-2*h[1][k*2]+h[0][k*2], h[2][k*2+1]-2*h[1][k*2+1]+h[0][k*2+1])); jerks.push(j); }
    }
  }
}
jerks.sort((a, b) => a - b);
const q = (p: number) => jerks[Math.floor(jerks.length * p)].toFixed(2);
console.log(`5 seeds × 120 s: locked ${(100 * lockedS / seconds).toFixed(1)}%, holds>1s per koi-minute ${(holds / (seconds / 60)).toFixed(2)}, longest ${longest.toFixed(1)}s; jerk p99 ${q(0.99)} p99.9 ${q(0.999)}`);
