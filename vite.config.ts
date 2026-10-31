import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  // `NEXT_PUBLIC_` is accepted as a public-key alias for migration from Next.js.
  envPrefix: ["VITE_", "NEXT_PUBLIC_"],
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  define: {
    "import.meta.env.VITE_BASENAME": JSON.stringify(
      process.env.VITE_BASENAME || ""
    ),
  },
  server: {
    port: 5173,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: {
      // Le backend Go écoute sur :3000. Sans proxy, les appels /api/v1/*
      // partent vers le serveur Vite et retournent index.html au lieu du JSON.
      "/api": "http://localhost:3000",
      "/healthz": "http://localhost:3000",
      "/readyz": "http://localhost:3000",
    },
  },
});
