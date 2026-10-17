import { defineConfig } from "vite"

const publicUrl = new URL(process.env.CONSOLE_URL ?? "http://localhost:5173")

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: Number(process.env.PORT ?? 5173),
    strictPort: true,
    allowedHosts: [publicUrl.hostname],
    hmr: { clientPort: Number(publicUrl.port || 80) },
    proxy: {
      "/api": {
        target: process.env.GATEWAY_URL ?? "http://localhost:4200",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, "")
      }
    }
  }
})
