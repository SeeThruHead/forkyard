import { defineConfig } from "vite"

export default defineConfig({
  server: { host: "127.0.0.1", port: Number(process.env.DEV_HOME_PORT ?? 4415), strictPort: true, allowedHosts: [".localhost"] }
})
