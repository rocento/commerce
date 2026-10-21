import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "e2e/onboarding",
  use: { headless: true, viewport: { width: 1440, height: 1000 } },
  reporter: "list",
  webServer: [
    {
      command: "pnpm dev:onboarding",
      url: "http://127.0.0.1:3100",
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "pnpm dev:onboarding-staff",
      url: "http://127.0.0.1:3101",
      reuseExistingServer: !process.env.CI,
    },
  ],
});
