import { flowerSway, wingProjection, type Butterfly, type Flower, type WingPalette } from "./butterflies";
import { hash3, TAU, valueNoise } from "./math";
import type { World } from "./world";

/** A four-lobed wing in body coordinates, with two ellipse lobes and a small scalloped rim. */
function wingRadius(u: number, v: number) {
  const fore = Math.hypot((u - 0.48 + v * 0.13) / 0.53, (v + 0.29) / 0.66);
  const hind = Math.hypot((u - 0.36) / 0.37, (v - 0.4) / 0.47);
  const scallop = 0.025 * Math.sin(Math.atan2(v, u) * 19);
  const notch = 0.17 * Math.exp(-(((v - 0.16) / 0.13) ** 2));
  return Math.min(fore, hind) + scallop + notch;
}

/** Procedural garden, sampled into the same coloured cells and ink glyphs as the water scenes. */
export class MeadowRenderer {
  render(ctx: CanvasRenderingContext2D, world: World, cw: number, ch: number, font: string) {
    const { scene, width, height, time, meadow, windSpeed } = world;
    const palette = scene.meadow!;
    ctx.globalAlpha = 1;
    ctx.fillStyle = scene.background;
    ctx.fillRect(0, 0, width, height);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `600 ${Math.round(ch * 0.74)}px ${font}`;

    // A broad sunlit clearing, low clover at the edges. All detail is stable in ground space.
    const cols = Math.ceil(width / cw);
    const rows = Math.ceil(height / ch);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = (c + 0.5) * cw;
        const y = (r + 0.5) * ch;
        const patch = valueNoise(x / 190, y / 190, 63);
        const light = valueNoise(x / 310 + Math.sin(time * 0.13) * windSpeed / 280, y / 270, 18);
        let bedCover = 0;
        for (const bed of meadow.beds) {
          const distance = ((x - bed.x) / (bed.rx * 1.25)) ** 2 + ((y - bed.y) / (bed.ry * 1.35)) ** 2;
          bedCover = Math.max(bedCover, Math.exp(-distance * 1.7));
        }
        ctx.globalAlpha = 0.025 + patch * 0.07 + bedCover * 0.16;
        ctx.fillStyle = palette.grass[1];
        ctx.fillRect(c * cw, r * ch, cw, ch);
        // Dappled leaf shade stays broad and quiet, letting small flying shadows read clearly.
        if (light > 0.58) {
          ctx.globalAlpha = (light - 0.58) * 0.2;
          ctx.fillStyle = palette.shadow;
          ctx.fillRect(c * cw, r * ch, cw, ch);
        }
        const seed = hash3(c, r, 37);
        if (seed > 0.025 + bedCover * 0.35) continue;
        const sway = Math.sin(time * 1.2 + x / 80 + y / 170) * windSpeed / 18;
        ctx.globalAlpha = 0.25 + patch * 0.3;
        ctx.fillStyle = palette.grass[Math.floor(hash3(c, r, 14) * palette.grass.length)];
        ctx.fillText(seed < 0.035 ? ";" : seed < 0.095 ? "'" : ",", x + sway, y);
      }
    }
    ctx.globalAlpha = 1;

    const visitors = [...meadow.butterflies].sort((a, b) => a.height - b.height);
    // Shadows are below the flowers. Height controls offset, softness and strength together.
    ctx.save();
    ctx.fillStyle = palette.shadow;
    for (const b of visitors) {
      if (b.height < 0.07) continue;
      ctx.globalAlpha = 0.11 - b.height * 0.045;
      ctx.filter = `blur(${3 + b.height * 4}px)`;
      ctx.save();
      ctx.translate(b.x + 9 + b.height * 21, b.y + 12 + b.height * 25);
      ctx.rotate(b.heading);
      const span = b.size * b.wingOpen;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(side * span * 0.4, 0, span * 0.55, b.size * 0.68, side * -0.3, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }
    ctx.restore();

    // Rosettes first, then blossoms: neighbouring plants form continuous flowering islands.
    const cell = Math.max(2.2, cw * 0.27);
    const row = cell * 1.4;
    ctx.font = `600 ${Math.round(row * 0.87)}px ${font}`;
    for (const f of meadow.flowers) this.drawLeaves(ctx, f, time, windSpeed, cell, row);
    const blossoms = [...meadow.flowers].sort((a, b) => a.y - b.y);
    for (const f of blossoms) this.drawFlower(ctx, f, time, windSpeed, palette.petals[f.kind], cell, row);

    // Floating seeds catch the sunlight, with no glowing trail behind a flying insect.
    ctx.font = `600 ${Math.round(ch * 0.7)}px ${font}`;
    ctx.fillStyle = "#f9f9e8";
    const motes = Math.round(width * height / 47000);
    for (let i = 0; i < motes; i++) {
      const mx = hash3(i, 2, 14) * width;
      const my = hash3(i, 5, 14) * height;
      const drift = meadow.seedDrift;
      ctx.globalAlpha = 0.3 + Math.sin(time * 0.7 + i) * 0.18;
      ctx.fillText(".", (mx + drift) % width, (my - time * 3 % height + height) % height);
    }
    ctx.globalAlpha = 1;
    const wingCell = Math.max(3.5, cw * 0.58);
    const wingRow = wingCell * 1.45;
    ctx.font = `600 ${Math.round(wingRow * 0.9)}px ${font}`;
    for (const b of visitors) this.drawButterfly(ctx, b, palette.wings[b.id % palette.wings.length], wingCell, wingRow);
    ctx.globalAlpha = 1;
  }

  private drawLeaves(ctx: CanvasRenderingContext2D, f: Flower, time: number, wind: number, cw: number, ch: number) {
    const x = f.x + flowerSway(f, time, wind) * 0.6;
    const reach = f.radius * 1.9;
    for (let py = -reach; py <= reach; py += ch) {
      for (let px = -reach; px <= reach; px += cw) {
        let leaf = Infinity;
        let across = 0;
        for (let k = 0; k < 5; k++) {
          const angle = f.phase + k * 2.39996;
          const u = (px * Math.cos(angle) + py * Math.sin(angle)) / f.radius;
          const v = (-px * Math.sin(angle) + py * Math.cos(angle)) / f.radius;
          const radius = ((u - 0.9) / 0.85) ** 2 + (v / 0.22) ** 2;
          if (radius < leaf) { leaf = radius; across = Math.abs(v); }
        }
        if (leaf > 1) continue;
        ctx.globalAlpha = 0.65;
        ctx.fillStyle = leaf < 0.55 ? "#96af80" : "#a7ba8f";
        ctx.fillRect(x + px - cw / 2, f.y + py - ch / 2, cw, ch);
        ctx.fillStyle = "#69895f";
        ctx.globalAlpha = across < 0.035 ? 0.55 : 0.25;
        ctx.fillText(across < 0.035 ? ":" : ".", x + px, f.y + py);
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawFlower(ctx: CanvasRenderingContext2D, f: Flower, time: number, wind: number, petal: string, cw: number, ch: number) {
    const x = f.x + flowerSway(f, time, wind);
    const radius = f.radius;
    ctx.save();
    ctx.fillStyle = "#69815b";
    ctx.globalAlpha = 0.14;
    ctx.filter = "blur(3px)";
    ctx.beginPath();
    ctx.ellipse(x + 5, f.y + 7, radius, radius * 0.8, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
    const petals = f.kind === 0 ? 10 : f.kind === 1 ? 7 : 8;
    const petalWidth = f.kind === 0 ? 0.19 : 0.27;
    const reach = radius * 1.15;
    for (let py = -reach; py <= reach; py += ch) {
      for (let px = -reach; px <= reach; px += cw) {
        const d = Math.hypot(px, py) / radius;
        let inside = Infinity;
        let along = 0;
        let across = 0;
        for (let k = 0; k < petals; k++) {
          const angle = f.phase + k * TAU / petals;
          const u = (px * Math.cos(angle) + py * Math.sin(angle)) / radius;
          const v = (-px * Math.sin(angle) + py * Math.cos(angle)) / radius;
          const shape = ((u - 0.56) / 0.51) ** 2 + (v / petalWidth) ** 2;
          if (shape < inside) { inside = shape; along = u; across = Math.abs(v); }
        }
        const center = d < 0.255;
        if (!center && inside > 1) continue;
        const crease = !center && along < 0.65 && across < 0.018;
        ctx.fillStyle = center ? (d < 0.17 ? "#ba913d" : "#d8b957") : petal;
        ctx.fillRect(x + px - cw / 2, f.y + py - ch / 2, cw, ch);
        ctx.fillStyle = center ? "#80642f" : f.kind === 2 ? "#987089" : "#b3a77b";
        ctx.globalAlpha = center ? 0.7 : crease ? 0.55 : 0.16;
        ctx.fillText(center ? ":" : crease ? ":" : ".", x + px, f.y + py);
        ctx.globalAlpha = 1;
      }
    }
  }

  private drawButterfly(ctx: CanvasRenderingContext2D, b: Butterfly, palette: WingPalette, cw: number, ch: number) {
    const cos = Math.cos(b.heading);
    const sin = Math.sin(b.heading);
    const extent = b.size * 1.45;
    const x0 = Math.floor((b.x - extent) / cw);
    const x1 = Math.ceil((b.x + extent) / cw);
    const y0 = Math.floor((b.y - extent) / ch);
    const y1 = Math.ceil((b.y + extent) / ch);
    for (let r = y0; r <= y1; r++) {
      for (let c = x0; c <= x1; c++) {
        const x = (c + 0.5) * cw;
        const y = (r + 0.5) * ch;
        const dx = x - b.x;
        const dy = y - b.y;
        const u = (dx * cos + dy * sin) / b.size;
        const v = (-dx * sin + dy * cos) / b.size;
        const projection = wingProjection(b.wingAngle, Math.sign(u) * b.bank * 0.28);
        const a = Math.abs(u) / projection;
        const radius = wingRadius(a, v);
        const body = Math.abs(u) < Math.max(0.055, cw / b.size * 0.55) && v > -0.49 && v < 0.52;
        const antenna = v < -0.43 && v > -0.84 && Math.abs(Math.abs(u) - (-v - 0.4) * 0.4) < 0.027;
        if (!body && !antenna && (radius > 1 || a < 0.045)) continue;
        let fill = palette.fill;
        let ink = palette.ink;
        let glyph = ":";
        if (body || antenna) {
          fill = palette.ink;
          ink = palette.spots;
          glyph = body ? ":" : "'";
        } else {
          const angle = Math.atan2(v + 0.05, a - 0.03);
          const vein = Math.abs(Math.sin(angle * 7 + a * 1.8));
          const rim = radius > 0.81;
          const spot = radius > 0.84 && radius < 0.97 && Math.sin(angle * 24) > 0.35;
          const eye = Math.hypot((a - 0.52) / 0.15, (v - 0.39) / 0.17);
          if (rim || vein < 0.085 || eye < 0.9) {
            fill = spot || eye < 0.42 ? palette.spots : palette.ink;
            glyph = spot ? "." : ";";
          } else {
            fill = radius < 0.55 ? palette.light : palette.fill;
            glyph = hash3(Math.round(a * 23), Math.round(v * 23), b.id) > 0.62 ? ":" : ".";
          }
        }
        ctx.globalAlpha = 0.5 + b.height * 0.5;
        ctx.fillStyle = fill;
        ctx.fillRect(x - cw / 2, y - ch / 2, cw, ch);
        ctx.fillStyle = ink;
        ctx.globalAlpha = (body ? 0.65 : 0.48) * (0.5 + b.height * 0.5);
        ctx.fillText(glyph, x, y);
      }
    }
    ctx.globalAlpha = 1;
  }
}
