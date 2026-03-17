import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "build",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: process.env.VITE_API_URL
      ? undefined
      : { "/api": "http://localhost:3001", "/health": "http://localhost:3001" },
  },
});
