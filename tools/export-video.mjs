// Export a scene's story (story.ts) as an MP4: the story clock is stepped frame by frame and screenshotted
// until the story ends. One take with no fades: the first frame is the cover a feed shows.
//
// usage: pnpm dev   (in another terminal)
//        pnpm export:video [--scene koi|whales] [--url http://localhost:5188] [--fps 30] [--size 2160] [--css 720] [--crf 18]
//                          [--theme light|dark] [--shade on|off] [--seed 1] [--out out/<scene>.mp4] [--keep] [--chrome <path>]
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const url = arg("url", "http://localhost:5188");
const fps = +arg("fps", 30), size = +arg("size", 2160);
// The layout viewport sets how large the glyph grid sits in the frame; the scale factor alone reaches the pixel size.
const css = +arg("css", 720);
// The simulation runs in 1/60 s steps; a frame has to land on one.
if (60 % fps) throw new Error(`--fps ${fps} must divide 60`);
// The one lossy pass: encode straight to the shipped quality, never compress the output again.
const crf = arg("crf", "18");
const scene = arg("scene", "koi"), theme = arg("theme", "light"), seed = arg("seed", "1");
// The koi pond's canopy shade is drawn on the canvas, not on the glyph grid; off leaves only glyphs.
const shade = arg("shade", "on");
const out = arg("out", join(here, "..", "out", `${scene}.mp4`));
// However the story runs, the take stops here.
const MAX_SECONDS = 90;
const chrome = arg("chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
const work = join(dirname(out), ".export");

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const browser = await chromium.launch({
  executablePath: chrome, headless: true,
  args: ["--headless=new", "--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: css, height: css }, deviceScaleFactor: size / css });
page.on("pageerror", (e) => console.error("[page]", e.message));
await page.goto(`${url}/?scene=${scene}&theme=${theme}&seed=${seed}&shade=${shade}&export`);
await page.waitForFunction(() => window.story, null, { timeout: 30000 });
// A face that fails to load falls back silently and the whole video ships in the wrong type.
const broken = await page.evaluate(async () => {
  await document.fonts.load('600 16px "Geist Mono"');
  await document.fonts.ready;
  // Unused unicode-range subsets stay "unloaded"; only a failed face, or none at all, is a problem.
  const failed = [...document.fonts].filter((f) => f.status === "error").map((f) => f.family);
  return document.fonts.check('600 16px "Geist Mono"') ? failed : [...failed, "Geist Mono (not loaded)"];
});
if (broken.length) throw new Error(`fonts failed to load: ${broken.join(", ")}`);

const opening = await page.evaluate((scene) => window.story.open(scene), scene);
console.log(`${scene} opens at ${opening.toFixed(2)} s · ${fps} fps · ${size}×${size} · ${theme} · shade ${shade} · seed ${seed}`);

const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const step = (dt) => page.evaluate((dt) => window.story.step(dt), dt);
await frame();

const started = Date.now();
let total = 0;
for (; total < MAX_SECONDS * fps; total++) {
  if (total > 0) { await step(1 / fps); await frame(); }
  // The end is the first frame not shown, so a story of n seconds is exactly n × fps frames.
  if (await page.evaluate(() => window.story.ended())) break;
  await page.screenshot({ path: join(work, `${String(total).padStart(5, "0")}.jpg`), type: "jpeg", quality: 95 });
  if (total % 60 === 59) console.log(`  ${total + 1} frames · ${((Date.now() - started) / (total + 1) / 1000).toFixed(2)} s/frame`);
}
console.log(`story ${(total / fps).toFixed(2)} s · ${total} frames`);
// Whatever the story used up should be back by the end, or it vanishes at the cut.
const left = await page.evaluate(() => window.story.leftover());
if (left) console.warn(`warning: ${left} at the end; try another --seed`);
await browser.close();

mkdirSync(dirname(out), { recursive: true });
execFileSync("ffmpeg", [
  "-y", "-loglevel", "error", "-framerate", String(fps), "-i", join(work, "%05d.jpg"),
  "-c:v", "libx264", "-preset", "slow", "-crf", crf, "-pix_fmt", "yuv420p", "-movflags", "+faststart", out,
], { stdio: "inherit" });
if (!process.argv.includes("--keep")) rmSync(work, { recursive: true, force: true }); // frames are scratch; --keep leaves them
console.log(`done → ${out}`);
