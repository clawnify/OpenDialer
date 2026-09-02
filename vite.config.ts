import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true },
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src/client") } },
  server: {
    proxy: { "/api": { target: `http://localhost:${process.env.API_PORT || 8789}`, changeOrigin: true } },
  },
});
