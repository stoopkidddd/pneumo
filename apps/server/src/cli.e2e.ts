import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { expect, inject, test } from "vitest";
import { S3Storage } from "./storage/s3.js";

const execute = promisify(execFile);
const minio = inject("minio");
const serverDir = new URL("../", import.meta.url);

function required(name: string): string {
  const value = minio[name];
  if (!value) throw new Error(`MinIO setup did not provide ${name}`);
  return value;
}

function cliEnvironment(prefix: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    PUBLIC_URL: "http://localhost",
    S3_ENDPOINT: required("S3_ENDPOINT"),
    S3_REGION: required("S3_REGION"),
    S3_BUCKET: required("S3_BUCKET"),
    S3_ACCESS_KEY_ID: required("S3_ACCESS_KEY_ID"),
    S3_SECRET_ACCESS_KEY: required("S3_SECRET_ACCESS_KEY"),
    S3_FORCE_PATH_STYLE: required("S3_FORCE_PATH_STYLE"),
    S3_PREFIX: prefix,
    UPLOAD_MODE: "proxy",
    LOG_LEVEL: "silent",
  };
}

function storageFor(prefix: string): S3Storage {
  return new S3Storage({
    S3_ENDPOINT: required("S3_ENDPOINT"),
    S3_REGION: required("S3_REGION"),
    S3_BUCKET: required("S3_BUCKET"),
    S3_ACCESS_KEY_ID: required("S3_ACCESS_KEY_ID"),
    S3_SECRET_ACCESS_KEY: required("S3_SECRET_ACCESS_KEY"),
    S3_FORCE_PATH_STYLE: required("S3_FORCE_PATH_STYLE") === "true",
    S3_PREFIX: prefix,
  });
}

async function clear(storage: S3Storage): Promise<void> {
  const keys: string[] = [];
  for await (const object of storage.list("")) keys.push(object.key);
  if (keys.length > 0) await storage.deleteMany(keys);
}

test("the built reset command refuses before configuration or storage access", async () => {
  let failure: unknown;
  try {
    await execute(process.execPath, ["dist/cli.js", "reset"], {
      cwd: serverDir,
      env: { PATH: process.env.PATH },
    });
  } catch (error) {
    failure = error;
  }

  expect(failure).toMatchObject({
    code: 1,
    stdout: "",
    stderr: "Refusing to reset without --yes.\n",
  });
});

test("the built info and reset commands operate on only the configured MinIO prefix", async () => {
  const root = `eng251/cli/${randomUUID()}`;
  const selectedPrefix = `${root}/selected`;
  const outsidePrefix = `${root}/outside`;
  const storage = storageFor(selectedPrefix);
  const outside = storageFor(outsidePrefix);

  try {
    await storage.putJson("meta/owner.json", { initialized: true });
    await storage.putJson("devices/one.json", {});
    await storage.putJson("devices/two.json", {});
    await storage.putJson("pushes/9999999999999_one.json", {});
    await storage.putJson("pushes/9999999999998_two.json", {});
    await storage.putJson("files/file-one", {});
    await outside.putJson("keep.json", { keep: true });

    const info = await execute(process.execPath, ["dist/cli.js", "info"], {
      cwd: serverDir,
      env: cliEnvironment(selectedPrefix),
    });
    expect(info.stderr).toBe("");
    expect(info.stdout).toBe("Initialized: yes\nDevices: 2\nPushes: 2\nUpload mode: proxy\n");

    const reset = await execute(process.execPath, ["dist/cli.js", "reset", "--yes"], {
      cwd: serverDir,
      env: cliEnvironment(selectedPrefix),
    });
    expect(reset.stderr).toBe("");
    expect(reset.stdout).toBe("Deleted objects: 6\n");

    const remaining: string[] = [];
    for await (const object of storage.list("")) remaining.push(object.key);
    expect(remaining).toEqual([]);
    expect(await outside.getJson("keep.json")).toEqual({ keep: true });
  } finally {
    await clear(storage);
    await clear(outside);
    storage.destroy();
    outside.destroy();
  }
});
