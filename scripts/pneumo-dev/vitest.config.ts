import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: "pneumo-dev",
    environment: "node",
    include: ["*.test.ts"],
  },
});
