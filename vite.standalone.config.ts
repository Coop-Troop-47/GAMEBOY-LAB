import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const standaloneRoot = fileURLToPath(new URL("./standalone/", import.meta.url));
const outputRoot = fileURLToPath(new URL("./public/", import.meta.url));

export default defineConfig({
  root: standaloneRoot,
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: outputRoot,
    emptyOutDir: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      input: `${standaloneRoot}gbc-lab.html`,
    },
  },
  resolve: {
    alias: {
      "@": projectRoot,
    },
  },
});
