import sunIcon from "@phosphor-icons/core/regular/sun.svg?raw";
import treeIcon from "@phosphor-icons/core/regular/tree.svg?raw";
import windIcon from "@phosphor-icons/core/regular/wind.svg?raw";
import { exposeStory, seedRandom } from "./story";
import { OceanEngine, SCENES, themed, type Scene, type SharkKind, type Theme } from "./src";

const FADE_MS = 260;

const params = new URLSearchParams(location.search);
// ?sharks=thresher,hammerhead,mako,nurse recasts every scene: first is biggest, the rest step down.
const kinds = params.get("sharks")?.split(",").filter(Boolean) as SharkKind[] | undefined;
const sharks = kinds?.map((kind, i) => ({ kind, size: 1 - i * 0.1 }));
const cast = (scene: Scene) => (sharks ? { ...scene, sharks } : scene);

const canvas = document.querySelector("canvas")!;
const nav = document.querySelector<HTMLElement>(".scenes")!;
const controls = document.querySelector<HTMLElement>(".controls")!;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

// ?export hands the clock to tools/export-video.mjs: seeded (?seed=N), paused, switchers hidden.
const exporting = params.has("export");
const streams = exporting ? seedRandom(Number(params.get("seed") ?? 1)) : null;
document.body.classList.toggle("export", exporting);

// ?scene=whales picks the starting tank.
let current = Math.max(0, SCENES.findIndex((s) => s.name === params.get("scene")));
const engine = new OceanEngine(canvas, cast(SCENES[current]), exporting ? { maxDpr: Infinity } : {});
if (streams) exposeStory(engine, canvas, streams);
// ?wind=off opens with the water still.
engine.setWind(params.get("wind") !== "off", true);
// ?shade=off opens with the canopy's shade gone.
engine.setShade(params.get("shade") !== "off", true);
// ?theme=light|dark, else the system's; it only shows on scenes that have a daylight palette.
let theme: Theme =
  params.get("theme") === "light" || params.get("theme") === "dark"
    ? (params.get("theme") as Theme)
    : matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
engine.setTheme(theme);

const buttons = SCENES.map((scene, i) => {
  const button = document.createElement("button");
  button.type = "button";
  const key = document.createElement("span");
  key.textContent = String(i + 1);
  button.append(key, scene.name);
  button.addEventListener("click", () => show(i));
  nav.append(button);
  return button;
});
// Shown only where the scene, as themed, has a canopy to cast shade.
const shadeButton = iconButton(treeIcon, "shade (S)", toggleShade);
// Shown only on scenes that have a wind to switch.
const windButton = iconButton(windIcon, "wind (W)", toggleWind);
const themeButton = iconButton(sunIcon, "light (L)", toggleTheme);

function iconButton(svg: string, label: string, onClick: () => void) {
  const button = document.createElement("button");
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = svg;
  button.addEventListener("click", onClick);
  controls.append(button);
  return button;
}

// The engine splashes on any pointerdown over the canvas; keep the switchers' clicks dry.
for (const bar of [nav, controls]) bar.addEventListener("pointerdown", (e) => e.stopPropagation());
addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const n = Number(e.key);
  if (n >= 1 && n <= SCENES.length) show(n - 1);
  // By physical key: under an input method e.key reads "Process" for letters.
  else if (e.code === "KeyW" && SCENES[current].wind > 0) toggleWind();
  else if (e.code === "KeyS" && themed(SCENES[current], theme).canopy) toggleShade();
  else if (e.code === "KeyL" && SCENES[current].daylight) toggleTheme();
});
markCurrent();

function markCurrent() {
  buttons.forEach((b, i) => b.setAttribute("aria-pressed", String(i === current)));
  windButton.hidden = SCENES[current].wind === 0;
  windButton.setAttribute("aria-pressed", String(engine.wind));
  themeButton.hidden = !SCENES[current].daylight;
  shadeButton.hidden = !themed(SCENES[current], theme).canopy;
  shadeButton.setAttribute("aria-pressed", String(engine.shade));
  themeButton.setAttribute("aria-pressed", String(theme === "light"));
  // The page behind the canvas matches the water, so fades between scenes don't flash.
  const shown = themed(SCENES[current], theme);
  document.body.style.backgroundColor = shown.background;
  document.body.classList.toggle("light", shown !== SCENES[current]);
}

function toggleTheme() {
  theme = theme === "light" ? "dark" : "light";
  params.set("theme", theme);
  history.replaceState(null, "", `?${params}`);
  markCurrent();
  clearTimeout(swap);
  if (reducedMotion.matches) {
    engine.setTheme(theme);
    return;
  }
  // Same dip as a scene change, so day doesn't snap to night; the koi swim on underneath.
  canvas.style.opacity = "0";
  swap = setTimeout(() => {
    engine.setTheme(theme);
    canvas.style.opacity = "1";
  }, FADE_MS);
}

function toggleShade() {
  engine.setShade(!engine.shade);
  if (engine.shade) params.delete("shade");
  else params.set("shade", "off");
  history.replaceState(null, "", `?${params}`);
  markCurrent();
}

function toggleWind() {
  engine.setWind(!engine.wind);
  if (engine.wind) params.delete("wind");
  else params.set("wind", "off");
  history.replaceState(null, "", `?${params}`);
  markCurrent();
}

let swap = 0;
function show(i: number) {
  if (i === current) return;
  current = i;
  markCurrent();
  params.set("scene", SCENES[i].name);
  history.replaceState(null, "", `?${params}`);
  clearTimeout(swap);
  if (reducedMotion.matches) {
    engine.setScene(cast(SCENES[i]));
    return;
  }
  // Dip to the page (already the new water's colour), recast while nothing shows, fade back in.
  canvas.style.opacity = "0";
  swap = setTimeout(() => {
    engine.setScene(cast(SCENES[current]));
    canvas.style.opacity = "1";
  }, FADE_MS);
}
