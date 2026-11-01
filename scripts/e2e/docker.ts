import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { HealthResponse } from "@pneumo/protocol";
import { startMinio, stopMinio } from "./minio.js";

const exec = promisify(execFile);
const version = "0.1.0-docker-smoke";
const image = "pneumo:eng-267";

// Never propagate execFile errors: their messages can contain credential-bearing args/output.
async function docker(args: string[], env = process.env): Promise<string> {
  try {
    const { stdout } = await exec("docker", args, { env, timeout: 180_000, maxBuffer: 8_000_000 });
    return stdout.trim();
  } catch {
    throw new Error(`docker ${args[0]} failed`);
  }
}

async function build(tag: string, target: string, buildVersion?: string): Promise<void> {
  const versionArgs = buildVersion === undefined ? [] : ["--build-arg", `VERSION=${buildVersion}`];
  const child = spawn("docker", ["build", ...versionArgs, "--target", target, "--tag", tag, "."], {
    stdio: "inherit",
  });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, `Docker ${target} build failed`);
}

async function remove(kind: "container" | "image", name: string): Promise<void> {
  try {
    await exec("docker", [kind, "rm", "--force", name], { timeout: 30_000 });
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("stderr" in error) ||
      typeof error.stderr !== "string" ||
      !error.stderr.includes(`No such ${kind}`)
    ) {
      throw new Error(`Docker ${kind} cleanup failed`);
    }
  }
}

async function healthy(origin: string): Promise<{ version: string; initialized: boolean }> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return HealthResponse.parse(await response.json());
      await response.body?.cancel();
    } catch {
      // Boot must finish loading the S3 index before the server listens.
    }
    await delay(100);
  }
  throw new Error("Container healthcheck timed out");
}

async function main(): Promise<void> {
  const suppliedImage = process.env.IMAGE?.trim() || undefined;
  const usingSuppliedImage = suppliedImage !== undefined;
  const run = randomBytes(12).toString("hex");
  const buildImage = `pneumo-docker-build:${run}`;
  const defaultImage = `pneumo-docker-default:${run}`;
  const network = `pneumo-docker-${run}`;
  const cleanup: (() => Promise<unknown>)[] = [];
  let size: number;
  let runtimeImages: Record<"direct" | "proxy", string>;
  let expectedVersions: Record<"direct" | "proxy", string>;
  try {
    cleanup.push(() => remove("image", buildImage));
    await build(buildImage, "build", version);
    if (suppliedImage !== undefined) {
      const imageId = await docker(["image", "inspect", "--format", "{{.Id}}", suppliedImage]);
      assert.match(imageId, /^sha256:[a-f0-9]{64}$/u);
      size = Number(await docker(["image", "inspect", "--format", "{{.Size}}", imageId]));
      const label = await docker([
        "image",
        "inspect",
        "--format",
        '{{index .Config.Labels "org.opencontainers.image.version"}}',
        imageId,
      ]);
      assert(
        label.trim() !== "" && label !== "<no value>",
        "Supplied image must have a nonempty org.opencontainers.image.version label",
      );
      runtimeImages = { direct: imageId, proxy: imageId };
      expectedVersions = { direct: label, proxy: label };
      console.log(`Image size ${size} bytes (${(size / 1_000_000).toFixed(2)} MB)`);
      console.log(`PASS supplied image version label ${label}`);
    } else {
      await build(image, "runtime", version);
      const imageId = await docker(["image", "inspect", "--format", "{{.Id}}", image]);
      assert.match(imageId, /^sha256:[a-f0-9]{64}$/u);
      size = Number(await docker(["image", "inspect", "--format", "{{.Size}}", imageId]));
      const label = await docker([
        "image",
        "inspect",
        "--format",
        '{{index .Config.Labels "org.opencontainers.image.version"}}',
        imageId,
      ]);
      assert.equal(label, version);
      console.log(`Image size ${size} bytes (${(size / 1_000_000).toFixed(2)} MB)`);
      console.log(`PASS image version label ${version}`);

      cleanup.push(() => remove("image", defaultImage));
      await build(defaultImage, "runtime");
      const { version: packageVersion } = HealthResponse.pick({ version: true }).parse(
        JSON.parse(
          await readFile(new URL("../../apps/server/package.json", import.meta.url), "utf8"),
        ),
      );
      const defaultLabel = await docker([
        "image",
        "inspect",
        "--format",
        '{{index .Config.Labels "org.opencontainers.image.version"}}',
        defaultImage,
      ]);
      assert.equal(defaultLabel, "", "Default build must not claim an explicit version override");
      runtimeImages = { direct: imageId, proxy: defaultImage };
      expectedVersions = { direct: version, proxy: packageVersion };
    }

    await docker(["network", "create", network]);
    cleanup.push(() => docker(["network", "rm", network]));
    const minio = await startMinio();
    cleanup.push(() => stopMinio(minio));
    assert.equal(
      minio.mode,
      "docker",
      "Docker smoke requires Docker MinIO; unset PNEUMO_E2E_MINIO",
    );
    await docker(["network", "connect", "--alias", "minio", network, minio.name]);

    for (const mode of ["direct", "proxy"] as const) {
      const runtimeImage = runtimeImages[mode];
      const expectedVersion = expectedVersions[mode];
      const server = `pneumo-docker-${run}-${mode}`;
      const client = `${server}-smoke`;
      const env = {
        ...process.env,
        ...minio.env,
        S3_ENDPOINT: "http://minio:9000",
        S3_PREFIX: `docker/${run}/${mode}/`,
        PORT: "8080",
        PUBLIC_URL: "http://server:8080",
        UPLOAD_MODE: mode,
        PNEUMO_SETUP_TOKEN: randomBytes(32).toString("hex"),
        PNEUMO_SMOKE_PASSPHRASE: randomBytes(32).toString("hex"),
        LOG_LEVEL: "silent",
      };
      cleanup.push(() => remove("container", server));
      await docker(
        [
          "run",
          "--detach",
          "--name",
          server,
          "--network",
          network,
          "--network-alias",
          "server",
          "--publish",
          "127.0.0.1::8080",
          ...[
            ...Object.keys(minio.env),
            "S3_PREFIX",
            "PORT",
            "PUBLIC_URL",
            "UPLOAD_MODE",
            "PNEUMO_SETUP_TOKEN",
            "LOG_LEVEL",
          ].flatMap((key) => ["--env", key]),
          runtimeImage,
        ],
        env,
      );
      const port = await docker([
        "inspect",
        "--format",
        '{{(index (index .NetworkSettings.Ports "8080/tcp") 0).HostPort}}',
        server,
      ]);
      const origin = `http://127.0.0.1:${port}`;
      const health = await healthy(origin);
      assert.equal(health.version, expectedVersion);
      if (!usingSuppliedImage && mode === "proxy") {
        console.log(
          `PASS default build health version ${expectedVersion} without VERSION build arg`,
        );
      }
      assert.equal(health.initialized, false);
      const uid = await docker(["exec", server, "id", "-u"]);
      assert(/^\d+$/u.test(uid) && Number(uid) > 0, "Container must run as non-root");
      const page = await fetch(origin, { signal: AbortSignal.timeout(5000) });
      assert.equal(page.status, 200);
      assert.match(page.headers.get("content-type") ?? "", /text\/html/u);
      const html = await page.text();
      const script = /src="(\/assets\/[^"]+\.js)"/u.exec(html)?.[1];
      assert(script, "Web dist must reference a built JavaScript asset");
      const asset = await fetch(`${origin}${script}`, { signal: AbortSignal.timeout(5000) });
      assert.equal(asset.status, 200);
      assert.match(asset.headers.get("content-type") ?? "", /javascript/u);
      await asset.body?.cancel();
      console.log(
        `PASS ${mode} health version, web assets, non-root uid ${uid}, random port ${port}`,
      );

      // Both containers resolve minio identically, including direct-mode presigned URLs.
      // Secrets travel through the child environment, never command diagnostics or files.
      cleanup.push(() => remove("container", client));
      const output = await docker(
        [
          "run",
          "--name",
          client,
          "--network",
          network,
          ...["PUBLIC_URL", "PNEUMO_SETUP_TOKEN", "PNEUMO_SMOKE_PASSPHRASE"].flatMap((key) => [
            "--env",
            key,
          ]),
          buildImage,
          "sh",
          "-c",
          'exec pnpm --silent dev-client smoke --url "$PUBLIC_URL" --setup-token "$PNEUMO_SETUP_TOKEN" --passphrase "$PNEUMO_SMOKE_PASSPHRASE" --session /tmp/pneumo-session.json',
        ],
        env,
      );
      for (const line of output.split("\n")) {
        if (line.startsWith("PASS ")) console.log(`${mode}: ${line}`);
      }
      assert.equal((await healthy(origin)).initialized, true);
      await remove("container", client);
      await docker(["stop", "--time", "15", server]);
      assert.equal(await docker(["inspect", "--format", "{{.State.ExitCode}}", server]), "0");
      await remove("container", server);
      console.log(`PASS ${mode} smoke and SIGTERM shutdown`);
    }
    console.log(
      usingSuppliedImage
        ? `PASS both upload modes; supplied image ${suppliedImage} retained`
        : `PASS both upload modes; retained image ${image}`,
    );
    assert(size > 0 && size <= 300_000_000, `Image exceeds 300 MB: ${size} bytes`);
    console.log("PASS image size limit");
  } finally {
    let failed = false;
    // Reverse creation order removes the servers, MinIO, network, then build image.
    for (const stop of cleanup.reverse()) {
      try {
        await stop();
      } catch {
        failed = true;
      }
    }
    if (failed) {
      console.error("Docker smoke cleanup failed");
      process.exitCode = 1;
    } else {
      console.log("PASS Docker smoke cleanup");
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Docker smoke failed");
  process.exitCode = 1;
});
