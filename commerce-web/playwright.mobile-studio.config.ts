import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e/mobile-studio",
  outputDir: "test-results/mobile-studio",
  workers: 2,
  timeout: 30000,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5194",
    viewport: { width: 1440, height: 1100 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      "node packages/api-client/scripts/generate-mobile-validator.mjs --check && pnpm --filter @rocento/mobile-admin build && pnpm --filter @rocento/mobile-admin preview",
    url: "http://127.0.0.1:5194/",
    reuseExistingServer: false,
  },
});
