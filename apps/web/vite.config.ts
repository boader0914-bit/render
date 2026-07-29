import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 3310,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:3210" }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          return id.includes("node_modules/react") ? "react-vendor" : undefined;
        }
      }
    }
  },
  test: {
    environment: "node",
    include: ["apps/web/src/**/*.test.ts"]
  }
});
