// Room Census front end. The census runtime (Python, repository root) publishes the data; this
// project renders it into a static site. Production is served at the domain root only.
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  site: "https://roomcensus.xyz",
  output: "static",
  trailingSlash: "always",
  // public data is copied here by scripts/stage-public-data.mjs before every build
  publicDir: "./.public",
  outDir: "./dist",
  build: {
    format: "directory",
    // external files only: the Content-Security-Policy allows no inline script or style
    inlineStylesheets: "never",
  },
  devToolbar: { enabled: false },
  server: { host: "127.0.0.1", port: 4321 },
  vite: {
    plugins: [tailwindcss()],
    build: { assetsInlineLimit: 0, sourcemap: false },
  },
});
