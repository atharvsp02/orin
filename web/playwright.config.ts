import { defineConfig, devices } from "@playwright/test"

const frontendPort = Number(process.env.PLAYWRIGHT_PORT ?? 3100)
const apiPort = Number(process.env.PLAYWRIGHT_API_PORT ?? 3199)

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${frontendPort}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: [
    {
      command: `PLAYWRIGHT_API_PORT=${apiPort} node e2e/proxy-api.mjs`,
      url: `http://127.0.0.1:${apiPort}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: `NEXT_DIST_DIR=.next-e2e ORIN_API_ORIGIN=http://127.0.0.1:${apiPort} npm run dev -- --hostname 127.0.0.1 --port ${frontendPort}`,
      url: `http://127.0.0.1:${frontendPort}/dashboard`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
})
