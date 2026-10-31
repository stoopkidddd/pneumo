import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { constants } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

// Official MinIO registry images were removed; use pinned Bitnami legacy builds.
const minioImage = "bitnamilegacy/minio:2025.4.22-debian-12-r2";
const mcImage = "bitnamilegacy/minio-client:2025.4.16-debian-12-r2";
const exec = promisify(execFile);
const active = new Set<string>();
const starting = new Set<Promise<void>>();
let interrupted = false;
let listening = false;

export interface MinioInstance {
  name: string;
  mode: "docker" | "native";
  env: Record<string, string>;
}

async function run(command: string, args: string[]): Promise<string> {
  const { stdout } = await exec(command, args, { timeout: 120_000 });
  return stdout.trim();
}

async function executable(command: string): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const path = resolve(directory, command);
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      // Try the next PATH entry.
    }
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No free MinIO port");
  await promisify(server.close.bind(server))();
  return address.port;
}

async function healthy(endpoint: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error("MinIO startup interrupted");
    try {
      const response = await fetch(`${endpoint}/minio/health/ready`, {
        signal: AbortSignal.timeout(1000),
      });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      // The listener may not have bound yet.
    }
    await delay(100);
  }
  throw new Error(`MinIO did not become healthy at ${endpoint}`);
}

async function removeContainer(name: string): Promise<void> {
  try {
    await run("docker", ["rm", "--force", "--volumes", name]);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("No such container")) throw error;
  }
}

async function removeOldContainers(): Promise<void> {
  const names = await run("docker", [
    "ps",
    "--all",
    "--filter",
    "name=^/pneumo-e2e-",
    "--format",
    "{{.Names}}",
  ]);
  if (!names) return;
  for (const name of names.split("\n")) {
    let created: string;
    try {
      created = await run("docker", ["inspect", "--format", "{{.Created}}", name]);
    } catch (error) {
      // Another concurrent start may already have removed the same stale container.
      if (error instanceof Error && error.message.includes("No such object")) continue;
      throw error;
    }
    if (Date.now() - Date.parse(created) > 2 * 60 * 60 * 1000) {
      await removeContainer(name);
    }
  }
}

function listenForInterrupt(): void {
  if (listening) return;
  listening = true;
  process.once("SIGINT", () => {
    interrupted = true;
    void (async () => {
      await Promise.allSettled(starting);
      await Promise.all([...active].map(stopMinio));
      process.exit(130);
    })().catch(() => process.exit(1));
  });
}

async function provision(instance: MinioInstance, envOut?: string): Promise<void> {
  const { name, mode, env } = instance;
  const directory = join(tmpdir(), name);
  if (mode === "docker") {
    await run("docker", [
      "run",
      "--detach",
      "--name",
      name,
      "--publish",
      "127.0.0.1::9000",
      "--env",
      "MINIO_ROOT_USER=minioadmin",
      "--env",
      "MINIO_ROOT_PASSWORD=minioadmin",
      "--env",
      "MINIO_API_CORS_ALLOW_ORIGIN=*",
      "--entrypoint",
      "minio",
      minioImage,
      "server",
      "/tmp/data",
    ]);
    const port = await run("docker", [
      "inspect",
      "--format",
      '{{(index (index .NetworkSettings.Ports "9000/tcp") 0).HostPort}}',
      name,
    ]);
    env.S3_ENDPOINT = `http://127.0.0.1:${port}`;
  } else {
    const minio = await executable("minio");
    const mc = await executable("mc");
    if (!minio || !mc) throw new Error("Native MinIO requires minio and mc on PATH");
    await mkdir(directory, { mode: 0o700 });
    const port = await freePort();
    env.S3_ENDPOINT = `http://127.0.0.1:${port}`;
    const child = spawn(
      minio,
      [
        "server",
        join(directory, "data"),
        "--address",
        `127.0.0.1:${port}`,
        "--console-address",
        "127.0.0.1:0",
      ],
      {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          MINIO_ROOT_USER: "minioadmin",
          MINIO_ROOT_PASSWORD: "minioadmin",
          MINIO_API_CORS_ALLOW_ORIGIN: "*",
          MINIO_REGION_NAME: env.S3_REGION,
        },
      },
    );
    await once(child, "spawn");
    child.unref();
    await writeFile(join(directory, "pid"), String(child.pid), { mode: 0o600 });
  }

  await healthy(env.S3_ENDPOINT);
  if (mode === "docker") {
    await run("docker", [
      "run",
      "--rm",
      "--name",
      `${name}-init`,
      "--network",
      `container:${name}`,
      "--env",
      "MC_CONFIG_DIR=/tmp/mc",
      "--entrypoint",
      "/bin/sh",
      mcImage,
      "-c",
      "mc alias set local http://127.0.0.1:9000 minioadmin minioadmin >/dev/null && mc mb --ignore-existing local/pneumo >/dev/null",
    ]);
  } else {
    const config = join(directory, "mc");
    await run("mc", [
      "--config-dir",
      config,
      "alias",
      "set",
      "local",
      env.S3_ENDPOINT,
      "minioadmin",
      "minioadmin",
    ]);
    await run("mc", ["--config-dir", config, "mb", "--ignore-existing", "local/pneumo"]);
  }
  if (interrupted) throw new Error("MinIO startup interrupted");
  if (envOut) {
    const content = { PNEUMO_E2E_MINIO_NAME: name, ...env };
    await writeFile(
      envOut,
      `${Object.entries(content)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n")}\n`,
      { mode: 0o600 },
    );
  }
}

/**
 * Start an isolated store for Vitest/Playwright global setup.
 * Pass instance.env to the server. Vitest setup can return () => stopMinio(instance);
 * Playwright teardown can call stopMinio(instance) or stopMinio(instance.name).
 * envOut is optional for API callers. CLI env files also contain PNEUMO_E2E_MINIO_NAME.
 * Native mode needs minio and mc on PATH; it is automatic when Docker is absent.
 */
export async function startMinio(options: { envOut?: string } = {}): Promise<MinioInstance> {
  listenForInterrupt();
  const docker = await executable("docker");
  const mode = process.env.PNEUMO_E2E_MINIO === "native" || !docker ? "native" : "docker";
  if (docker) {
    try {
      await removeOldContainers();
    } catch (error) {
      if (mode === "docker") throw error;
      // Forced native mode also works when a Docker client has no running daemon.
    }
  }
  const instance: MinioInstance = {
    name: `pneumo-e2e-${randomBytes(12).toString("hex")}`,
    mode,
    env: {
      S3_ENDPOINT: "",
      S3_BUCKET: "pneumo",
      S3_ACCESS_KEY_ID: "minioadmin",
      S3_SECRET_ACCESS_KEY: "minioadmin",
      S3_FORCE_PATH_STYLE: "true",
      S3_REGION: "us-east-1",
    },
  };
  active.add(instance.name);
  const startup = provision(instance, options.envOut).catch(async (error: unknown) => {
    await stopMinio(instance);
    throw error;
  });
  starting.add(startup);
  try {
    await startup;
    return instance;
  } finally {
    starting.delete(startup);
  }
}

/** Also accepts the PNEUMO_E2E_MINIO_NAME written by the CLI, across processes. */
export async function stopMinio(instance: MinioInstance | string): Promise<void> {
  const name = typeof instance === "string" ? instance : instance.name;
  if (!/^pneumo-e2e-[a-f0-9]{24}$/.test(name)) throw new Error("Invalid MinIO instance name");
  const directory = join(tmpdir(), name);
  let pid: number | undefined;
  try {
    pid = Number(await readFile(join(directory, "pid"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (pid) {
    // A stale pid file must never terminate an unrelated process after PID reuse.
    const command =
      process.platform === "linux"
        ? await readFile(`/proc/${pid}/cmdline`, "utf8").catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return "";
            throw error;
          })
        : await run("/bin/ps", ["-p", String(pid), "-o", "command="]).catch(
            (error: { code?: number }) => {
              if (error.code === 1) return "";
              throw error;
            },
          );
    if (command.includes(join(directory, "data"))) {
      process.kill(pid, "SIGTERM");
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0);
        } catch {
          break;
        }
        await delay(50);
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  } else if (
    (typeof instance === "string" || instance.mode === "docker") &&
    (await executable("docker"))
  ) {
    await removeContainer(`${name}-init`);
    await removeContainer(name);
  }
  await rm(directory, { recursive: true, force: true });
  active.delete(name);
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { "env-out": { type: "string" }, name: { type: "string" } },
  });
  if (positionals.length === 1 && positionals[0] === "start" && values["env-out"]) {
    await startMinio({ envOut: resolve(values["env-out"]) });
    console.log(values["env-out"]);
  } else if (positionals.length === 1 && positionals[0] === "stop" && values.name) {
    await stopMinio(values.name);
  } else {
    throw new Error("Usage: minio.ts start --env-out PATH | stop --name NAME");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "MinIO command failed");
    process.exitCode = 1;
  });
}
