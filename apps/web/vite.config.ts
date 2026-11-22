import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Same React app is served as a PWA and embedded by the Tauri desktop shell.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // Desktop (Tauri) builds skip the service worker.
      disable: process.env.TAURI_ENV_PLATFORM !== undefined,
      manifest: {
        name: "Nonlinear",
        short_name: "Nonlinear",
        description: "Local-first GitHub release & code-review workspace",
        theme_color: "#16161d",
        background_color: "#16161d",
        display: "standalone",
        icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,woff2}"],
        navigateFallback: "index.html",
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        // Grammars are large; cache on first use so semantic expansion works offline afterwards.
        runtimeCaching: [{ urlPattern: /\.wasm$/, handler: "CacheFirst", options: { cacheName: "nonlinear-wasm" } }],
      },
    }),
  ],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  worker: { format: "es" },
  build: { target: "es2022", sourcemap: true },
  test: { environment: "jsdom" },
} as never);
