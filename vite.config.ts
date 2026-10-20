import { defineConfig } from "vite";

// Fixed, so tools/export-loop.mjs finds the dev server at its default --url.
export default defineConfig({ server: { port: 5188, strictPort: true } });
