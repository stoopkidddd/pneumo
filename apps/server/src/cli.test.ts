import { expect, test } from "vitest";
import { runCli } from "./cli.js";
import { loadConfig } from "./config.js";
import { MemoryBucket, MemoryStorage } from "./storage/memory.js";

function testConfig(uploadMode: "auto" | "direct" | "proxy" = "proxy") {
  return loadConfig({
    PUBLIC_URL: "https://pneumo.example",
    S3_ENDPOINT: "https://storage.example",
    S3_BUCKET: "test-bucket",
    S3_ACCESS_KEY_ID: "test-access-key",
    S3_SECRET_ACCESS_KEY: "test-secret-key",
    UPLOAD_MODE: uploadMode,
  });
}

function capture() {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    write: (line: string) => output.push(line),
    writeError: (line: string) => errors.push(line),
  };
}

test("info reports persisted state without creating instance objects", async () => {
  const storage = new MemoryStorage();
  await storage.putJson("meta/owner.json", { secret: "must-not-be-read" });
  await storage.putJson("devices/one.json", {});
  await storage.putJson("devices/two.json", {});
  await storage.putJson("devices/nested/ignored.json", {});
  await storage.putJson("pushes/9999999999999_one.json", {});
  await storage.putJson("pushes/9999999999998_two.json", {});
  await storage.putJson("pushes/not-a-record.json", {});
  const target = capture();

  const result = await runCli(["info"], {
    storage,
    config: testConfig("direct"),
    write: target.write,
    writeError: target.writeError,
  });

  expect(result).toBe(0);
  expect(target.output).toEqual([
    "Initialized: yes",
    "Devices: 2",
    "Pushes: 2",
    "Upload mode: direct",
  ]);
  expect(target.errors).toEqual([]);
  expect(await storage.head("meta/vapid.json")).toBeNull();
  expect(await storage.head("meta/owner.json")).not.toBeNull();
});

test("info reports an empty uninitialized namespace", async () => {
  const target = capture();

  const result = await runCli(["info"], {
    storage: new MemoryStorage(),
    config: testConfig("auto"),
    write: target.write,
    writeError: target.writeError,
  });

  expect(result).toBe(0);
  expect(target.output).toEqual([
    "Initialized: no",
    "Devices: 0",
    "Pushes: 0",
    "Upload mode: direct",
  ]);
  expect(target.errors).toEqual([]);
});

test("reset refuses without --yes and does not inspect or mutate storage", async () => {
  const storage = new MemoryStorage();
  await storage.putJson("keep.json", { keep: true });
  const target = capture();

  const result = await runCli(["reset"], {
    storage,
    config: testConfig(),
    write: target.write,
    writeError: target.writeError,
  });

  expect(result).toBe(1);
  expect(target.output).toEqual([]);
  expect(target.errors).toEqual(["Refusing to reset without --yes."]);
  expect(await storage.getJson("keep.json")).toEqual({ keep: true });
});

test("reset deletes every object in its namespace in bounded batches", async () => {
  const bucket = new MemoryBucket();
  const batchSizes: number[] = [];
  class RecordingStorage extends MemoryStorage {
    override async deleteMany(keys: string[]): Promise<void> {
      batchSizes.push(keys.length);
      await super.deleteMany(keys);
    }
  }
  const storage = new RecordingStorage({ bucket, prefix: "selected" });
  const outside = new MemoryStorage({ bucket, prefix: "outside" });
  for (let index = 0; index < 1_005; index += 1) {
    await storage.putJson(`objects/${String(index).padStart(4, "0")}.json`, { index });
  }
  await outside.putJson("keep.json", { keep: true });
  const target = capture();

  const result = await runCli(["reset", "--yes"], {
    storage,
    config: testConfig(),
    write: target.write,
    writeError: target.writeError,
  });

  expect(result).toBe(0);
  expect(target.output).toEqual(["Deleted objects: 1005"]);
  expect(target.errors).toEqual([]);
  expect(batchSizes).toEqual([1_000, 5]);
  const remaining: string[] = [];
  for await (const object of storage.list("")) remaining.push(object.key);
  expect(remaining).toEqual([]);
  expect(await outside.getJson("keep.json")).toEqual({ keep: true });
});
