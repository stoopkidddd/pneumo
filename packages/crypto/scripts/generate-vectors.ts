import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { serializeVectors } from "./vectors.js";

const outputUrl = new URL("../vectors/v1.json", import.meta.url);
await mkdir(dirname(fileURLToPath(outputUrl)), { recursive: true });
await writeFile(outputUrl, await serializeVectors(), "utf8");
