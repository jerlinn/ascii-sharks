import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = mkdtempSync(join(tmpdir(), 'butterfly-check-'));
try {
  execFileSync(join(root, 'node_modules/.bin/tsc'), [
    'src/world.ts', '--module', 'commonjs', '--target', 'ES2022', '--strict',
    '--skipLibCheck', '--outDir', output,
  ], { cwd: root, stdio: 'pipe' });
  const require = createRequire(import.meta.url);
  const { World } = require(join(output, 'world.js'));
  const { BUTTERFLIES, SCENES } = require(join(output, 'scene.js'));
  const { strokeWingAngle, wingProjection, projectedSize, STARTLE_TURN_RATE, FLIGHT_TURN_ACCEL } = require(join(output, 'butterflies.js'));
  const { angleDiff } = require(join(output, 'math.js'));
  let seed = 43;
  Math.random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  assert(projectedSize(40, 0.95) / projectedSize(40, 0.1) > 3.6, 'Perspective must create visible scale separation');
  const epsilon = 1e-5;
  for (const end of [0, 0.5, 1]) {
    const velocity = (strokeWingAngle(end + epsilon) - strokeWingAngle(end - epsilon)) / (2 * epsilon);
    assert(Math.abs(velocity) < 1e-6, 'Angular velocity must reach zero at each reversal');
  }
  const leftSpeed = (strokeWingAngle(1) - strokeWingAngle(1 - epsilon)) / epsilon;
  const rightSpeed = (strokeWingAngle(epsilon) - strokeWingAngle(0)) / epsilon;
  assert(Math.abs(leftSpeed - rightSpeed) < 0.001, 'Periodic stroke must have continuous velocity');
  assert(Math.abs(wingProjection(Math.PI / 3) - 0.5) < 1e-8, 'Projected width must follow wing rotation');

  for (const [width, height] of [[1440, 900], [390, 844], [320, 640]]) {
    const world = new World(BUTTERFLIES);
    world.resize(width, height, 10, 14.5);
    const field = world.meadow;
    assert.equal(field.beds.length, 2, 'The composition has exactly two flower beds');
    assert.equal(new Set(field.flowers.map(f => f.kind)).size, 1, 'One flower species keeps the flight in focus');
    const [large, small] = field.beds;
    assert(large.x < width / 2 && large.y > height / 2 && small.x > width / 2 && small.y < height / 2, 'Flower beds sit across the diagonal');
    assert(large.rx * large.ry > small.rx * small.ry * 2, 'The two beds have a clear size hierarchy');
    for (const f of field.flowers) {
      assert(field.beds.some(b => ((f.x - b.x) / b.rx) ** 2 + ((f.y - b.y) / b.ry) ** 2 < 0.85 ** 2), 'Every flower belongs to a bed');
    }
    const alwaysAirborne = new Set(field.butterflies.map(b => b.id));
    let visits = 0, glides = 0, maxResting = 0;
    const previous = new Map();
    const glideStates = new Map();
    let smallest = Infinity, largest = 0;
    const angles = new Map();
    const modes = new Map();
    let transitions = 0;
    const flight = new Map();
    let maxTurn = 0;
    for (let step = 0; step < 120 * 60; step++) {
      world.step(1 / 60);
      maxResting = Math.max(maxResting, field.butterflies.filter(b => b.mode === 'rest').length);
      for (const b of field.butterflies) {
        assert([b.x,b.y,b.vx,b.vy,b.size,b.height,b.wingAngle,b.wingVelocity,b.wingOpen,b.heading].every(Number.isFinite));
        assert(b.x >= 0 && b.x <= width && b.y >= 0 && b.y <= height);
        assert(b.wingOpen >= 0.06 && b.wingOpen <= 1.001);
        if (angles.has(b.id)) assert(Math.abs(b.wingAngle - angles.get(b.id)) < 0.4, 'Flight, glide and rest must not snap the wing angle');
        const wingMode = b.mode === 'rest' ? 'rest' : b.glideUntil > world.time ? 'glide' : 'stroke';
        if (modes.has(b.id) && modes.get(b.id) !== wingMode) transitions++;
        angles.set(b.id, b.wingAngle);
        modes.set(b.id, wingMode);
        assert(b.mode === 'roam' ? b.target === -1 : b.target >= 0, 'Free flight must have no flower target');
        const prior = flight.get(b.id);
        if (prior && prior.mode !== 'rest' && b.mode !== 'rest') {
          const turn = Math.abs(angleDiff(prior.heading, b.heading)) * 60;
          maxTurn = Math.max(maxTurn, turn);
          assert(turn <= STARTLE_TURN_RATE + 1e-8, 'A new destination must not snap heading');
          assert(Math.abs(b.turnRate - prior.turnRate) * 60 <= FLIGHT_TURN_ACCEL + 1e-8, 'Turning acceleration must stay bounded');
          assert(Math.abs(b.x - prior.x - b.vx / 60) < 1e-7 && Math.abs(b.y - prior.y - b.vy / 60) < 1e-7, 'Position must follow the tangent without boundary clamping');
          if (b.speed > 0.01) assert(Math.abs(angleDiff(b.heading, Math.atan2(b.vx, -b.vy))) < 1e-7, 'Body heading must match the path tangent');
        }
        flight.set(b.id, { x: b.x, y: b.y, heading: b.heading, turnRate: b.turnRate, mode: b.mode });
        if (b.mode === 'rest') {
          if (previous.get(b.id) !== 'rest') visits++;
          alwaysAirborne.delete(b.id);
        }
        const gliding = b.glideUntil > world.time;
        if (gliding && !glideStates.get(b.id)) glides++;
        previous.set(b.id, b.mode);
        glideStates.set(b.id, gliding);
        smallest = Math.min(smallest, b.size);
        largest = Math.max(largest, b.size);
      }
    }
    assert(transitions > field.butterflies.length * 10, 'Verify repeated stroke, glide and landing transitions');
    assert(visits > 0, 'Some visitors should occasionally land');
    assert(alwaysAirborne.size >= Math.floor(field.butterflies.length / 2), 'Most butterflies should remain free-flying');
    assert(maxResting <= Math.max(1, Math.floor(field.butterflies.length * 0.22)), 'Landings must remain a minority');
    assert(glides > field.butterflies.length * 10, 'Flight should alternate strokes and glides');
    assert(largest / smallest > 3, 'Depth must remain visible during flight');
    const b = field.butterflies[0];
    const tangent = { heading: b.heading, vx: b.vx, vy: b.vy, turnRate: b.turnRate };
    world.poke(b.x, b.y);
    assert(b.mode === 'roam' && b.target === -1 && b.startledUntil > world.time);
    assert.deepEqual({ heading: b.heading, vx: b.vx, vy: b.vy, turnRate: b.turnRate }, tangent, 'Startling changes the destination while preserving motion');
    const count = field.butterflies.length;
    world.resize(width * 0.75, height, 8, 12);
    assert.equal(field.butterflies.length, count);
    for (const scene of SCENES) {
      world.setScene(scene);
      for (let k = 0; k < 120; k++) world.step(1 / 60);
      assert.equal(world.meadow.butterflies.length > 0, !!scene.meadow);
    }
    console.log(`${width}x${height}: max turn ${maxTurn.toFixed(2)} rad/s, ${visits} visits, ${alwaysAirborne.size}/${count} continuously airborne, ${glides} glides, ${(largest / smallest).toFixed(1)}x size range`);
  }
  for (const corner of [[25, 40], [295, 40], [25, 550], [295, 550]]) {
    const world = new World(BUTTERFLIES);
    world.resize(320, 640, 8, 12);
    world.setWind(false, true);
    const b = world.meadow.butterflies.at(-1);
    b.x = corner[0]; b.y = corner[1];
    b.heading = Math.atan2(b.x - 160, -(b.y - 300));
    b.speed = 30; b.turnRate = 0;
    b.vx = Math.sin(b.heading) * b.speed; b.vy = -Math.cos(b.heading) * b.speed;
    world.poke(b.x, b.y);
    for (let i = 0; i < 8 * 60; i++) {
      const heading = b.heading;
      const turnRate = b.turnRate;
      world.step(1 / 60);
      assert(Math.abs(angleDiff(heading, b.heading)) <= STARTLE_TURN_RATE / 60 + 1e-8, 'Edge startle must bank continuously');
      assert(Math.abs(b.turnRate - turnRate) <= FLIGHT_TURN_ACCEL / 60 + 1e-8);
      assert(b.x >= 0 && b.x <= 320 && b.y >= 0 && b.y <= 640, 'Edge escape must remain inside without teleporting');
    }
  }
  console.log('Four corner startles preserve heading and turn continuously within bounds');
} finally {
  rmSync(output, { recursive: true, force: true });
}
