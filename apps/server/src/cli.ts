import { pathToFileURL } from "node:url";
import { type Config, loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { S3Storage } from "./storage/s3.js";
import type { Storage } from "./storage/types.js";
import { resolveUploadMode } from "./storage/upload-mode.js";

const DELETE_BATCH_SIZE = 1_000;
const DEVICE_KEY = /^devices\/[^/]+\.json$/u;
const PUSH_KEY = /^pushes\/\d{13}_[^/]+\.json$/u;
const quietLogger = createLogger("silent");

type WriteLine = (line: string) => void;

export interface CliDependencies {
  storage: Storage;
  config: Config;
  write: WriteLine;
  writeError: WriteLine;
}

async function countMatching(storage: Storage, prefix: string, pattern: RegExp): Promise<number> {
  let count = 0;
  for await (const object of storage.list(prefix)) {
    if (pattern.test(object.key)) count += 1;
  }
  return count;
}

async function runInfo(deps: CliDependencies): Promise<number> {
  const [owner, deviceCount, pushCount, uploadMode] = await Promise.all([
    deps.storage.head("meta/owner.json"),
    countMatching(deps.storage, "devices/", DEVICE_KEY),
    countMatching(deps.storage, "pushes/", PUSH_KEY),
    resolveUploadMode({
      storage: deps.storage,
      mode: deps.config.UPLOAD_MODE,
      publicUrl: deps.config.PUBLIC_URL,
      logger: quietLogger,
    }),
  ]);

  deps.write(`Initialized: ${owner === null ? "no" : "yes"}`);
  deps.write(`Devices: ${deviceCount}`);
  deps.write(`Pushes: ${pushCount}`);
  deps.write(`Upload mode: ${uploadMode}`);
  return 0;
}

async function runReset(deps: CliDependencies): Promise<number> {
  const keys: string[] = [];
  for await (const object of deps.storage.list("")) keys.push(object.key);

  for (let start = 0; start < keys.length; start += DELETE_BATCH_SIZE) {
    await deps.storage.deleteMany(keys.slice(start, start + DELETE_BATCH_SIZE));
  }

  deps.write(`Deleted objects: ${keys.length}`);
  return 0;
}

function refusalRequired(args: readonly string[]): boolean {
  return args[0] === "reset" && !args.includes("--yes");
}

function validInvocation(args: readonly string[]): boolean {
  return (
    (args.length === 1 && args[0] === "info") ||
    (args.length === 2 && args[0] === "reset" && args[1] === "--yes")
  );
}

export async function runCli(args: readonly string[], deps: CliDependencies): Promise<number> {
  if (refusalRequired(args)) {
    deps.writeError("Refusing to reset without --yes.");
    return 1;
  }
  if (!validInvocation(args)) {
    deps.writeError("Usage: cli.js info | reset --yes");
    return 1;
  }
  return args[0] === "info" ? runInfo(deps) : runReset(deps);
}

export async function runCliEntry(
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    write?: WriteLine;
    writeError?: WriteLine;
  } = {},
): Promise<number> {
  const write = options.write ?? console.log;
  const writeError = options.writeError ?? console.error;

  if (refusalRequired(args)) {
    writeError("Refusing to reset without --yes.");
    return 1;
  }
  if (!validInvocation(args)) {
    writeError("Usage: cli.js info | reset --yes");
    return 1;
  }

  let storage: S3Storage | undefined;
  try {
    const config = loadConfig(options.env ?? process.env);
    storage = new S3Storage(config);
    return await runCli(args, { storage, config, write, writeError });
  } catch {
    writeError("CLI command failed.");
    return 1;
  } finally {
    storage?.destroy();
  }
}

function isEntryPoint(): boolean {
  const script = process.argv[1];
  return script !== undefined && import.meta.url === pathToFileURL(script).href;
}

if (isEntryPoint()) process.exitCode = await runCliEntry(process.argv.slice(2));
