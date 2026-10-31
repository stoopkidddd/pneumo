import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: (
      [
        ["packages/protocol", "@pneumo/protocol"],
        ["packages/crypto", "@pneumo/crypto"],
        ["apps/server", "@pneumo/server"],
        ["apps/web", "@pneumo/web"],
      ] as const
    ).map(([root, name]) => ({
      root,
      test: {
        name,
        environment: "node",
        include: ["src/**/*.test.{ts,tsx}"],
      },
    })),
  },
});
