import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      {
        find: /^@pierre\/theming\/themes$/,
        replacement: path.resolve(
          rootDirectory,
          "src/client/workspace-files/pierre-themes-curated.ts",
        ),
      },
      {
        find: /^shiki$/,
        replacement: path.resolve(
          rootDirectory,
          "src/client/workspace-files/shiki-curated.ts",
        ),
      },
      {
        find: /^shiki\/wasm$/,
        replacement: path.resolve(
          rootDirectory,
          "src/client/workspace-files/shiki-wasm-disabled.ts",
        ),
      },
      {
        find: "@client",
        replacement: path.resolve(rootDirectory, "src/client"),
      },
      {
        find: "@shared",
        replacement: path.resolve(rootDirectory, "src/shared"),
      },
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      // Preserve browser authority for the API's Host/Origin validation.
      "/api": { target: "http://127.0.0.1:4784", changeOrigin: false },
    },
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: false,
  },
});
