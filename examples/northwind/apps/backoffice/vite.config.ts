import { defineConfig } from "vite"

const frontendKeys = ["REACT_APP_API_URL", "GRAPH_API_URL", "BILLING_API_URL", "FLAGS_BASE_URL"]
const frontendEnv = Object.fromEntries(frontendKeys.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]))

export default defineConfig({
  define: { "process.env": frontendEnv },
  server: {
    host: "127.0.0.1",
    port: process.env.PORT ? Number(process.env.PORT) : 5274,
    strictPort: true,
    allowedHosts: [".localhost"]
  }
})
