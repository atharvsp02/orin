import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:3100",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: [
    {
      command: "node e2e/proxy-api.mjs",
      url: "http://127.0.0.1:3199/health",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: "ORIN_API_ORIGIN=http://127.0.0.1:3199 npm run dev -- --hostname 127.0.0.1 --port 3100",
      url: "http://127.0.0.1:3100/dashboard",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
})
