import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.VITE_API_PROXY_TARGET ?? `http://127.0.0.1:${env.PORT ?? "8787"}`;

  return {
    plugins: [react()],
    server: {
      port: 5176,
      proxy: {
        "/api": apiTarget
      }
    }
  };
});
