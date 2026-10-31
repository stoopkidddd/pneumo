import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node26",
  noExternal: [/^@pneumo\//],
  clean: true,
});
