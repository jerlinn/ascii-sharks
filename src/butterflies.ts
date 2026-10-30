import { angleDiff, clamp, rand, smoothstep, TAU } from "./math";

export interface WingPalette {
  fill: string;
  light: string;
  ink: string;
  spots: string;
}

export interface Meadow {
  wings: WingPalette[];
  petals: string[];
  grass: string[];
  shadow: string;
  butterflyArea: number;
  flowerArea: number;
  flowerBeds: { center: [number, number]; spread: [number, number]; share: number }[];
}

export const DAY_MEADOW: Meadow = {
  wings: [
    { fill: "#d68b30", light: "#f3b750", ink: "#493e2b", spots: "#fff1c6" },
    { fill: "#73a8bc", light: "#aed8dc", ink: "#344b51", spots: "#eaf4df" },
    { fill: "#e9d893", light: "#fff0bc", ink: "#716649", spots: "#fff8de" },
    { fill: "#c58879", light: "#e7af95", ink: "#624637", spots: "#ffe7c4" },
  ],
  petals: ["#fff9e7"],
  grass: ["#8fa77f", "#a2b58c", "#b6c5a0", "#789970"],
  shadow: "#6e8d70",
  butterflyArea: 100000,
  flowerArea: 80000,
  flowerBeds: [
    { center: [0.18, 0.71], spread: [0.18, 0.12], share: 0.75 },
    { center: [0.82, 0.23], spread: [0.09, 0.07], share: 0.25 },
  ],
};

export interface FlowerBed { x: number; y: number; rx: number; ry: number; phase: number }
export interface Flower {
  x: number;
  y: number;
  radius: number;
  phase: number;
  kind: number;
}

export interface Butterfly {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  heading: number;
  speed: number;
  /** Continuous angular velocity; steering changes its acceleration, never resets heading. */
  turnRate: number;
  bank: number;
  /** Stroke fraction, 0–1. */
  phase: number;
  /** Wing elevation above the body plane, in radians; width is its cosine projection. */
  wingAngle: number;
  wingVelocity: number;
  wingOpen: number;
  strokeStrength: number;
  strokeTarget: number;
  strokeRate: number;
  beatsLeft: number;
  glideUntil: number;
  /** Unprojected half-span; size also includes perspective. */
  wingspan: number;
  size: number;
  height: number;
  cruiseHeight: number;
  nectarAffinity: number;
  nextVisitAt: number;
  mode: "roam" | "nectar" | "rest";
  target: number;
  goalX: number;
  goalY: number;
  until: number;
  startledUntil: number;
}

const OPEN_WING_ANGLE = 0.12;
const WING_SWEEP = 1.28;
export const FLIGHT_TURN_RATE = 1.5;
export const STARTLE_TURN_RATE = 2.2;
export const FLIGHT_TURN_ACCEL = 3.2;

/** A sinusoid in angle space: zero angular speed at both ends, with smooth reversals. */
export function strokeWingAngle(phase: number) {
  return OPEN_WING_ANGLE + WING_SWEEP * (0.5 - 0.5 * Math.cos(phase * TAU));
}

/** A rigid wing rotates about its root; it does not expand and contract across the screen. */
export function wingProjection(angle: number, bank = 0) {
  return Math.max(0.06, Math.cos(angle + bank));
}

/** Height is distance above the ground toward the viewer: near wings can be four times wider. */
export function projectedSize(wingspan: number, height: number) {
  return wingspan * (0.34 + 1.34 * height ** 1.25);
}

/** Flowers and visitors share this displacement, so a resting butterfly stays on its flower. */
export function flowerSway(flower: Flower, time: number, wind: number) {
  return Math.sin(time * 1.1 + flower.phase) * wind * 0.23
    + Math.sin(time * 0.47 + flower.phase * 2) * wind * 0.12;
}

export class ButterflyField {
  butterflies: Butterfly[] = [];
  flowers: Flower[] = [];
  beds: FlowerBed[] = [];
  width = 0;
  height = 0;
  seedDrift = 0;

  clear() { this.butterflies = []; this.flowers = []; this.beds = []; this.seedDrift = 0; }

  seed(width: number, height: number, meadow: Meadow, time: number) {
    this.width = width;
    this.height = height;
    const flowerCount = Math.round(clamp(width * height / meadow.flowerArea, 11, 18));
    const flowerScale = clamp(Math.min(width, height) / 700, 0.72, 1.1);
    // Two diagonal accents: a denser large bed and a smaller answering bed, with open air between.
    this.beds = meadow.flowerBeds.map(({ center, spread }) => ({
      x: width * center[0], y: height * center[1],
      rx: Math.min(width * spread[0], 175),
      ry: Math.min(height * spread[1], 108),
      phase: rand(0, TAU),
    }));
    let allocated = 0;
    this.flowers = this.beds.flatMap((bed, index) => {
      const count = index === this.beds.length - 1
        ? flowerCount - allocated
        : Math.round(flowerCount * meadow.flowerBeds[index].share);
      allocated += count;
      return Array.from({ length: count }, (_, n) => {
        const angle = n * 2.39996 + bed.phase + rand(-0.12, 0.12);
        // More blooms share the core; the outer few are smaller and more widely spaced.
        const r = ((n + 0.45) / count) ** 0.85 * 0.82;
        return {
          x: bed.x + Math.cos(angle) * bed.rx * r,
          y: bed.y + Math.sin(angle) * bed.ry * r,
          radius: rand(20, 26) * flowerScale * (1 - r * 0.18),
          phase: rand(0, TAU), kind: 0,
        };
      });
    });
    const count = Math.round(clamp(width * height / meadow.butterflyArea, 7, 17));
    const baseSpan = clamp(Math.min(width, height) * 0.061, 29, 48);
    this.butterflies = Array.from({ length: count }, (_, i) => {
      // Stratified depth ensures a full depth range in every cast, including phone-sized casts.
      const height = 0.1 + ((i + rand(0.1, 0.9)) / count) * 0.85;
      const heading = rand(-Math.PI, Math.PI);
      const wingspan = baseSpan * rand(0.9, 1.12);
      const strokeRate = rand(2.1, 3.4);
      const b: Butterfly = {
        id: i, x: rand(width * 0.12, width * 0.88), y: rand(this.height * 0.12, this.height * 0.8),
        vx: Math.sin(heading) * 30, vy: -Math.cos(heading) * 30, heading, speed: 30, turnRate: 0, bank: 0,
        phase: rand(0, 1), wingAngle: 0, wingVelocity: 0, wingOpen: 1,
        strokeStrength: 1, strokeTarget: strokeRate, strokeRate, beatsLeft: Math.floor(rand(3, 7)),
        glideUntil: 0, wingspan, size: projectedSize(wingspan, height),
        height, cruiseHeight: height, nectarAffinity: height < 0.48 ? rand(0.35, 0.8) : 0,
        nextVisitAt: time + rand(8, 20),
        mode: "roam", target: -1, goalX: 0, goalY: 0, until: time + rand(3, 8), startledUntil: 0,
      };
      this.chooseAir(b, time);
      b.until = time + rand(2, 7);
      b.wingAngle = strokeWingAngle(b.phase);
      b.wingOpen = wingProjection(b.wingAngle);
      return b;
    });
  }

  resize(width: number, height: number) {
    const sx = width / this.width;
    const sy = height / this.height;
    const scale = Math.min(width, height) / Math.min(this.width, this.height);
    for (const bed of this.beds) { bed.x *= sx; bed.y *= sy; bed.rx *= sx; bed.ry *= sy; }
    for (const f of this.flowers) { f.x *= sx; f.y *= sy; f.radius = clamp(f.radius * scale, 14, 35); }
    for (const b of this.butterflies) {
      b.x *= sx; b.y *= sy; b.goalX *= sx; b.goalY *= sy;
      b.wingspan = clamp(b.wingspan * scale, 26, 55);
      b.size = projectedSize(b.wingspan, b.height);
    }
    this.width = width; this.height = height;
  }

  scatter(x: number, y: number, time: number) {
    for (const b of this.butterflies) {
      let dx = b.x - x;
      let dy = b.y - y;
      if (Math.hypot(dx, dy) > 210) continue;
      if (Math.hypot(dx, dy) < 1) { dx = Math.sin(b.heading); dy = -Math.cos(b.heading); }
      const normal = Math.hypot(dx, dy);
      this.chooseAir(b, time);
      b.startledUntil = time + 1.6;
      b.nextVisitAt = time + rand(14, 26);
      b.glideUntil = 0;
      b.beatsLeft = 7;
      // A startle changes the destination and urgency, preserving the current tangent.
      b.goalX = clamp(b.x + dx / normal * 260, this.width * 0.06, this.width * 0.94);
      b.goalY = clamp(b.y + dy / normal * 260, this.height * 0.07, this.height * 0.86);
    }
  }

  private chooseAir(b: Butterfly, time: number) {
    b.mode = "roam";
    b.target = -1;
    const angle = b.heading + rand(-1.1, 1.1);
    const stride = rand(110, 280);
    b.goalX = clamp(b.x + Math.sin(angle) * stride, this.width * 0.08, this.width * 0.92);
    b.goalY = clamp(b.y - Math.cos(angle) * stride, this.height * 0.09, this.height * 0.83);
    b.until = time + rand(4, 9);
  }

  private chooseFlower(b: Butterfly, time: number) {
    let best = -1;
    let score = Infinity;
    for (let index = 0; index < this.flowers.length; index++) {
      if (this.butterflies.some((other) => other !== b && other.target === index)) continue;
      const f = this.flowers[index];
      const next = Math.hypot(f.x - b.x, f.y - b.y) * rand(0.8, 1.2);
      if (next < score) { best = index; score = next; }
    }
    if (best < 0) return;
    b.mode = "nectar";
    b.target = best;
    b.until = time + 26;
  }

  private stepWings(b: Butterfly, dt: number, time: number, startled: boolean) {
    const resting = b.mode === "rest";
    const gliding = time < b.glideUntil && !startled;
    // Phase keeps running through glides; frequency eases instead of stepping at a beat boundary.
    const rate = b.strokeTarget * (startled ? 1.45 : 1);
    b.strokeRate += (rate - b.strokeRate) * (1 - Math.exp(-dt * 2));
    b.phase += dt * b.strokeRate;
    if (b.phase >= 1) {
      b.phase %= 1;
      if (!resting && !gliding) {
        b.strokeTarget = rand(2, 3.5);
        b.beatsLeft--;
        if (b.beatsLeft <= 0 && !startled) {
          b.glideUntil = time + rand(0.45, 1.3);
          b.beatsLeft = Math.floor(rand(3, 7));
        }
      }
    }
    const powered = !resting && (startled || time >= b.glideUntil);
    b.strokeStrength += ((powered ? 1 : 0) - b.strokeStrength) * (1 - Math.exp(-dt * 7));
    const target = resting
      ? 1.18 + Math.sin(time * 0.8 + b.id) * 0.1
      : OPEN_WING_ANGLE + b.strokeStrength * (strokeWingAngle(b.phase) - OPEN_WING_ANGLE);
    // Exact critically damped step: preserve angle AND angular velocity when a glide,
    // landing or startle changes the target. Stable at the engine's fixed timestep.
    const response = resting ? 14 : 48;
    const offset = b.wingAngle - target;
    const momentum = b.wingVelocity + response * offset;
    const decay = Math.exp(-response * dt);
    b.wingAngle = target + (offset + momentum * dt) * decay;
    b.wingVelocity = (b.wingVelocity - response * momentum * dt) * decay;
    b.wingOpen = wingProjection(b.wingAngle);
  }

  step(dt: number, time: number, wind: number, pointer: { x: number; y: number; active: boolean }) {
    const ease = 1 - Math.exp(-dt * 2.7);
    this.seedDrift += wind * 0.3 * dt;
    for (const b of this.butterflies) {
      const frightened = time < b.startledUntil;
      this.stepWings(b, dt, time, frightened);
      if (b.mode === "rest") {
        const f = this.flowers[b.target];
        // Finish the last few pixels of arrival without snapping onto the flower centre.
        const follow = 1 - Math.exp(-dt * 7);
        b.x += (f.x + flowerSway(f, time, wind) - b.x) * follow;
        b.y += (f.y - b.y) * follow;
        b.turnRate *= Math.exp(-dt * 5);
        b.height += (0.025 - b.height) * ease;
        b.size = projectedSize(b.wingspan, b.height);
        if (time >= b.until || (pointer.active && Math.hypot(pointer.x - b.x, pointer.y - b.y) < 65)) {
          this.chooseAir(b, time);
          b.nextVisitAt = time + rand(18, 35);
        }
        continue;
      }
      if (time >= b.until) this.chooseAir(b, time);
      if (b.mode === "roam" && time >= b.nextVisitAt) {
        b.nextVisitAt = time + rand(14, 30);
        const visitors = this.butterflies.filter((other) => other.mode !== "roam").length;
        if (!frightened && visitors < Math.max(1, Math.floor(this.butterflies.length * 0.22)) && Math.random() < b.nectarAffinity) this.chooseFlower(b, time);
      }
      if (b.mode === "nectar") {
        const f = this.flowers[b.target];
        b.goalX = f.x + flowerSway(f, time, wind);
        b.goalY = f.y;
      }
      // Refresh a reached waypoint before deriving this step's desired bearing.
      if (b.mode === "roam" && !frightened && Math.hypot(b.goalX - b.x, b.goalY - b.y) < Math.max(55, b.speed)) this.chooseAir(b, time);
      const dx = b.goalX - b.x;
      const dy = b.goalY - b.y;
      const distance = Math.hypot(dx, dy);
      if (!frightened && b.mode === "nectar" && distance < 4 && b.speed < 6) {
        b.mode = "rest";
        b.vx = b.vy = b.speed = 0;
        b.until = time + rand(2, 4.5);
        continue;
      }
      const flutter = Math.sin(time * 1.4 + b.id * 3.1) * 0.7 + Math.sin(time * 0.63 + b.id) * 0.3;
      let goal = Math.atan2(dx, -dy) + flutter * clamp(distance / 100, 0, 1);
      const glide = time < b.glideUntil;
      let speed = (30 + b.wingspan * 0.55) * (glide ? 1.15 : 0.9 + b.wingOpen * 0.2);
      if (b.mode === "nectar") speed = Math.min(speed, Math.max(0, distance - 1) * 1.15);
      if (frightened) { goal = Math.atan2(dx, -dy); speed = 105; }
      let desiredVX = Math.sin(goal) * speed;
      let desiredVY = -Math.cos(goal) * speed;
      for (const other of this.butterflies) {
        if (other === b || other.mode === "rest" || Math.abs(other.height - b.height) > 0.23) continue;
        const ox = b.x - other.x, oy = b.y - other.y, d = Math.hypot(ox, oy);
        const space = (b.size + other.size) * 0.9;
        if (d > 0.1 && d < space) { const push = (1 - d / space) * 32; desiredVX += ox / d * push; desiredVY += oy / d * push; }
      }
      if (pointer.active) {
        const px = b.x - pointer.x, py = b.y - pointer.y, d = Math.hypot(px, py);
        if (d > 0.1 && d < 100) { desiredVX += px / d * 45; desiredVY += py / d * 45; }
      }
      // Look ahead along the current tangent: start bending before reaching the boundary.
      const margin = Math.max(22, b.size * 0.55);
      const look = Math.max(55, b.speed * 1.5);
      const hx = Math.sin(b.heading), hy = -Math.cos(b.heading);
      const aheadX = b.x + hx * look, aheadY = b.y + hy * look;
      desiredVX += Math.max(0, margin - aheadX) * 2.8 - Math.max(0, aheadX - this.width + margin) * 2.8;
      desiredVY += Math.max(0, margin - aheadY) * 2.8 - Math.max(0, aheadY - this.height + margin + 55) * 2.8;
      desiredVX += wind * 0.18;
      const bearing = Math.hypot(desiredVX, desiredVY) > 0.01 ? Math.atan2(desiredVX, -desiredVY) : b.heading;
      const turnLimit = frightened ? STARTLE_TURN_RATE : FLIGHT_TURN_RATE;
      const desiredTurn = clamp(angleDiff(b.heading, bearing) * 1.8, -turnLimit, turnLimit);
      const oldTurn = b.turnRate;
      b.turnRate += clamp((desiredTurn - b.turnRate) * (1 - Math.exp(-dt * 3)), -FLIGHT_TURN_ACCEL * dt, FLIGHT_TURN_ACCEL * dt);
      b.heading += (oldTurn + b.turnRate) * 0.5 * dt;

      // Brake while a banked turn needs more room. Keep velocity tangent to the body;
      // interpolating two opposed velocity vectors can cancel and reverse through atan2(0,0).
      const roomX = Math.abs(hx) < 0.001 ? Infinity : (hx > 0 ? this.width - b.x : b.x) / Math.abs(hx);
      const roomY = Math.abs(hy) < 0.001 ? Infinity : (hy > 0 ? this.height - 45 - b.y : b.y) / Math.abs(hy);
      const safeSpeed = Math.max(8, Math.min(roomX, roomY) * 0.55);
      speed = Math.min(speed, safeSpeed);
      b.speed += (speed - b.speed) * (1 - Math.exp(-dt * (speed < b.speed ? 6 : 2)));
      b.vx = Math.sin(b.heading) * b.speed;
      b.vy = -Math.cos(b.heading) * b.speed;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.bank += (clamp(b.turnRate * 0.4, -0.65, 0.65) - b.bank) * ease;
      const cruise = b.cruiseHeight + Math.sin(time * 0.27 + b.id * 2) * 0.065;
      const lift = frightened ? Math.min(1, cruise + 0.25) : b.mode === "nectar" ? Math.max(0.025, cruise * smoothstep(0, 150, distance)) : cruise;
      b.height += (clamp(lift, 0.025, 1) - b.height) * (1 - Math.exp(-dt * 1.1));
      b.size = projectedSize(b.wingspan, b.height);
    }
  }
}
