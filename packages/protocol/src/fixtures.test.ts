import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { buildFixtures, fixtureCases } from "./fixtures.js";
import { jsonSchemas } from "./schemas.js";

const fixtureRoot = fileURLToPath(new URL("../fixtures/", import.meta.url));

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}

function comparePaths(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

async function listFiles(directory: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }

  const paths: string[] = [];
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await listFiles(absolutePath)));
    } else {
      paths.push(relative(fixtureRoot, absolutePath).split("\\").join("/"));
    }
  }
  return paths.sort(comparePaths);
}

const requiredFixturePaths: string[] = [
  "valid/NotePayload--default.json",
  "valid/NotePayload--titled.json",
  "valid/LinkPayload--default.json",
  "valid/LinkPayload--described.json",
  "valid/FilePayload--default.json",
  "valid/FilePayload--captioned.json",
  "valid/DeviceDTO--online.json",
  "valid/DeviceDTO--offline.json",
  "valid/DeviceRecord--with-webpush.json",
  "valid/DeviceRecord--without-webpush.json",
  "valid/PushPayload--note.json",
  "valid/PushPayload--link.json",
  "valid/PushPayload--file.json",
  "valid/PushRecord--note.json",
  "valid/PushRecord--file.json",
  "valid/PushDTO--note.json",
  "valid/PushDTO--file.json",
  "valid/CreatePushRequest--note.json",
  "valid/CreatePushRequest--file.json",
  "valid/MeResponse--auto.json",
  "valid/MeResponse--direct.json",
  "valid/MeResponse--proxy.json",
  "valid/CreateFileResponse--direct.json",
  "valid/CreateFileResponse--proxy.json",
  "valid/GetFileResponse--direct.json",
  "valid/GetFileResponse--proxy.json",
  "valid/ListDevicesResponse--default.json",
  "valid/ListDevicesResponse--empty.json",
  "valid/ListPushesQuery--default.json",
  "valid/ListPushesQuery--paged.json",
  "valid/ListPushesResponse--complete.json",
  "valid/ListPushesResponse--paged.json",
  "valid/ListPushesResponse--empty.json",
  "valid/HelloFrame--initial.json",
  "valid/HelloFrame--resume.json",
  "valid/ClientFrame--hello.json",
  "valid/ClientFrame--pong.json",
  "valid/ServerFrame--ready.json",
  "valid/ServerFrame--push.json",
  "valid/ServerFrame--push-deleted.json",
  "valid/ServerFrame--device-added.json",
  "valid/ServerFrame--device-updated.json",
  "valid/ServerFrame--device-removed.json",
  "valid/ServerFrame--replay-done.json",
  "valid/ServerFrame--resync.json",
  "valid/ServerFrame--ping.json",
];

for (const platform of ["web", "android", "desktop", "cli"] as const) {
  requiredFixturePaths.push(`valid/Platform--${platform}.json`);
}
for (const mode of ["auto", "direct", "proxy"] as const) {
  requiredFixturePaths.push(`valid/UploadMode--${mode}.json`);
}
for (const schemaName of ["PongFrame", "ReplayDoneFrame", "ResyncFrame", "PingFrame"] as const) {
  requiredFixturePaths.push(`invalid/${schemaName}--discriminator-required.json`);
  requiredFixturePaths.push(`invalid/${schemaName}--wrong-discriminator.json`);
}

test("fixture metadata exhaustively covers every JSON schema", () => {
  const schemaNames = Object.keys(jsonSchemas);
  const fixturePaths = new Set<string>();
  const counts = new Map<string, { valid: number; invalid: number }>();
  const fixtures = buildFixtures();

  for (const schemaName of schemaNames) {
    counts.set(schemaName, { valid: 0, invalid: 0 });
  }

  for (const fixtureCase of fixtureCases) {
    const schema = jsonSchemas[fixtureCase.schemaName];
    if (schema === undefined) fail(fixtureCase.path, "references an unknown schema");
    if (fixturePaths.has(fixtureCase.path))
      fail(fixtureCase.path, "is duplicated in fixture metadata");
    fixturePaths.add(fixtureCase.path);

    const count = counts.get(fixtureCase.schemaName);
    if (count === undefined) fail(fixtureCase.path, "has no schema coverage counter");
    count[fixtureCase.expectation] += 1;

    const contents = fixtures[fixtureCase.path];
    if (contents === undefined) fail(fixtureCase.path, "builder omitted fixture metadata");

    let fixtureValue: unknown;
    try {
      fixtureValue = JSON.parse(contents);
    } catch {
      fail(fixtureCase.path, "fixture is not valid JSON");
    }
    const parsed = schema.safeParse(fixtureValue).success;
    if (fixtureCase.expectation === "valid" && !parsed) {
      fail(fixtureCase.path, "valid fixture does not satisfy its schema");
    }
    if (fixtureCase.expectation === "invalid" && parsed) {
      fail(fixtureCase.path, "invalid fixture unexpectedly satisfies its schema");
    }
  }

  for (const schemaName of schemaNames) {
    const count = counts.get(schemaName);
    if (count === undefined || count.valid < 1)
      fail(schemaName, "needs at least one valid fixture");
    if (count.invalid < 2) fail(schemaName, "needs at least two invalid fixtures");
  }

  for (const path of requiredFixturePaths) {
    if (!fixturePaths.has(path)) fail(path, "required schema variant is missing");
  }
});

test("fixture builder is deterministic", () => {
  const first = buildFixtures();
  const second = buildFixtures();
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error("fixture output is not deterministic");
  }
});

test("checked-in fixture files exactly match the pure builder", async () => {
  const expected = buildFixtures();
  const expectedPaths = Object.keys(expected);
  const actualPaths = (
    await Promise.all([
      listFiles(join(fixtureRoot, "valid")),
      listFiles(join(fixtureRoot, "invalid")),
    ])
  )
    .flat()
    .sort(comparePaths);
  const actualPathSet = new Set(actualPaths);
  const expectedPathSet = new Set(expectedPaths);

  for (const path of expectedPaths) {
    if (!actualPathSet.has(path)) {
      fail(path, "fixture is missing; run pnpm --filter @pneumo/protocol fixtures:generate");
    }
  }
  for (const path of actualPaths) {
    if (!expectedPathSet.has(path)) {
      fail(path, "fixture is stale; run pnpm --filter @pneumo/protocol fixtures:generate");
    }
  }

  for (const path of expectedPaths) {
    const actualContents = await readFile(join(fixtureRoot, path), "utf8");
    if (actualContents !== expected[path]) {
      fail(path, "fixture bytes drifted; run pnpm --filter @pneumo/protocol fixtures:generate");
    }
  }
});
