// How big each kind of disturbance looks on ripple water: the most cells it lights at once.
// Mirrors how src/renderer.ts drives src/ripple.ts; keep the constants below in step with it.
// Run: node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/bin/esbuild tools/ripple-scale.ts --bundle --platform=node --log-level=warning | node
import { RippleField } from "../src/ripple";

const SHOW = 0.08; // RIPPLE_SHOW
const DROP_AMP = 0.18;
const DROP_HZ = 4;
const DROP_DECAY = 0.3;
const GULP_AMP = 0.1;
const STROKE = 0.022;
const STROKE_SPEED = 150;
const PELLET = 0.17; // feed() event strength

function lit(drive: (field: RippleField, f: number) => void, frames = 180) {
  const field = new RippleField();
  field.resize(1280, 800, 10);
  field.setOpen(true);
  let most = 0;
  for (let f = 0; f < frames; f++) {
    drive(field, f);
    field.step(1 / 60, 0, 0);
    let n = 0;
    for (let y = 5; y < 800; y += 15) for (let x = 5; x < 1280; x += 10) if (field.sample(x, y) > SHOW) n++;
    most = Math.max(most, n);
  }
  return most;
}
const ring = (amp: number, x = 640, y = 400, delay = 0) => (field: RippleField, f: number) => {
  const t = f / 60 - delay;
  if (t >= 0 && t < 3 / DROP_HZ) field.stamp(x, y, 12, amp * Math.sin(2 * Math.PI * DROP_HZ * t) * Math.exp(-t / DROP_DECAY));
};
const handful = (field: RippleField, f: number) => {
  for (let i = 0; i < 7; i++) {
    const r = 45 * Math.sqrt(i / 7);
    ring(DROP_AMP * PELLET, 640 + Math.cos(i * 2.4) * r, 400 + Math.sin(i * 2.4) * r, (i % 4) * 0.07)(field, f);
  }
};
const wake = (speed: number) => (field: RippleField, f: number) => {
  const t = f / 60;
  field.stamp(300 + speed * t, 400, 8, STROKE * (1 + speed / STROKE_SPEED) * Math.sin(t * (2 + speed / 24)));
};

console.log(`one pellet        ${lit(ring(DROP_AMP * PELLET))}`);
console.log(`koi gulping food  ${lit(ring(GULP_AMP))}`);
console.log(`koi gliding 40    ${lit(wake(40))}`);
console.log(`handful of pellets${lit(handful)}`);
console.log(`raindrop          ${lit(ring(DROP_AMP))}`);
console.log(`koi rushing 180   ${lit(wake(180))}`);
