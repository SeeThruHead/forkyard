import { defineConfig } from "vite"

const frontendKeys = ["REACT_APP_API_URL", "GRAPH_URL", "IMAGE_API_URL", "FLAGS_BASE_URL", "SIGN_IN_URL", "BILLING_API_URL"]
const frontendEnv = Object.fromEntries(frontendKeys.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]))

export default defineConfig({
  define: { "process.env": frontendEnv },
  server: {
    host: "127.0.0.1",
    port: process.env.PORT ? Number(process.env.PORT) : 5273,
    strictPort: true,
    allowedHosts: [".localhost"],
    proxy: {
      "/graph-api": {
        target: process.env.GRAPH_API_URL ?? "http://127.0.0.1:4100",
        changeOrigin: true,
        rewrite: (requestPath) => requestPath.replace(/^\/graph-api/, "")
      },
      "/core-api": {
        target: process.env.CORE_API_URL ?? "http://127.0.0.1:8181",
        changeOrigin: true,
        rewrite: (requestPath) => requestPath.replace(/^\/core-api/, "")
      }
    }
  }
})
