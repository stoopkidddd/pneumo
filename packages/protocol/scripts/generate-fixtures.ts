import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFixtures } from "../src/fixtures.js";

const fixtureRoot = fileURLToPath(new URL("../fixtures/", import.meta.url));
const fixturePathPattern = /^(?:valid|invalid)\/[A-Za-z0-9-]+\.json$/;
const fixtures = buildFixtures();
const entries = Object.entries(fixtures).sort(([left], [right]) => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
});

for (const [relativePath] of entries) {
  if (!fixturePathPattern.test(relativePath)) {
    throw new Error(`Refusing to write unsafe fixture path: ${relativePath}`);
  }
}

for (const directory of ["valid", "invalid"] as const) {
  await rm(join(fixtureRoot, directory), { recursive: true, force: true });
  await mkdir(join(fixtureRoot, directory), { recursive: true });
}

for (const [relativePath, contents] of entries) {
  const destination = join(fixtureRoot, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, contents, "utf8");
}

console.log(`Generated ${entries.length} protocol fixtures.`);
