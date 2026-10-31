import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@pneumo/server-e2e",
    environment: "node",
    include: ["src/**/*.e2e.ts", "../../scripts/pneumo-dev/smoke.e2e.ts"],
    globalSetup: ["./e2e/global-setup.ts"],
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
