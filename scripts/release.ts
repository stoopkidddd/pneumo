import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const signingKeys = [
  "ANDROID_KEYSTORE_PATH",
  "ANDROID_KEYSTORE_PASSWORD",
  "ANDROID_KEY_ALIAS",
  "ANDROID_KEY_PASSWORD",
] as const;
// Signing material is supplied only to the Gradle child, never checks or Docker.
const publicEnv = { ...process.env };
for (const key of signingKeys) delete publicEnv[key];

function command(program: string, args: string[]): string {
  return [
    program,
    ...args.map((arg) => (/^[\w./:=,@+-]+$/u.test(arg) ? arg : JSON.stringify(arg))),
  ].join(" ");
}

async function run(
  program: string,
  args: string[],
  options: { capture?: boolean; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<string> {
  console.log(`$ ${command(program, args)}`);
  const cwd = options.cwd ?? root;
  const env = options.env ?? publicEnv;
  try {
    if (options.capture) {
      const { stdout } = await exec(program, args, { cwd, env, maxBuffer: 64_000_000 });
      return stdout.trim();
    }
    const child = spawn(program, args, { cwd, env, stdio: "inherit" });
    const [code] = await once(child, "exit");
    if (code !== 0) throw new Error();
    return "";
  } catch {
    // Child errors may include credential-bearing output. Never print them.
    throw new Error(`${program} ${args[0] ?? ""} failed`);
  }
}

interface Version {
  text: string;
  core: bigint[];
  prerelease: string[];
}

function version(text: string): Version {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][\da-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][\da-zA-Z-]*))*))?(?:\+([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?$/u.exec(
      text,
    );
  if (!match) throw new Error("Version must be SemVer without a leading v");
  return { text, core: match.slice(1, 4).map(BigInt), prerelease: match[4]?.split(".") ?? [] };
}

function compare(a: Version, b: Version): number {
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    return Number(!a.prerelease.length) - Number(!b.prerelease.length);
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const leftNumeric = /^\d+$/u.test(left);
    const rightNumeric = /^\d+$/u.test(right);
    if (leftNumeric && rightNumeric) return BigInt(left) > BigInt(right) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left > right ? 1 : -1;
  }
  return 0;
}

async function cleanMain(): Promise<string> {
  if ((await run("git", ["branch", "--show-current"], { capture: true })) !== "main") {
    throw new Error("Release requires the main branch");
  }
  if (await run("git", ["status", "--porcelain", "--untracked-files=all"], { capture: true })) {
    throw new Error("Release requires a clean working tree");
  }
  const head = await run("git", ["rev-parse", "HEAD"], { capture: true });
  const origin = await run("git", ["rev-parse", "refs/remotes/origin/main"], { capture: true });
  if (head !== origin) throw new Error("main must equal origin/main");
  return head;
}

function fingerprint(value: string): string {
  const normalized = value.replaceAll(":", "").toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized))
    throw new Error("Expected a certificate SHA-256 fingerprint");
  return normalized;
}

async function signingEnvironment(path: string): Promise<NodeJS.ProcessEnv> {
  const metadata = await stat(path);
  if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error("Release env file must have mode 600");
  }
  const values: Record<string, string> = {};
  for (const row of (await readFile(path, "utf8")).split(/\r?\n/u)) {
    if (!row.trim() || row.trimStart().startsWith("#")) continue;
    const match = /^(ANDROID_[A-Z_]+)=(.*)$/u.exec(row);
    if (!match || !signingKeys.some((key) => key === match[1]) || match[1] in values) {
      throw new Error("Release env must contain only one KEY=value line per signing variable");
    }
    let value = match[2];
    if (/^(['"]).*\1$/u.test(value)) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  if (signingKeys.some((key) => !values[key]))
    throw new Error("Release env is missing signing variables");
  if (!isAbsolute(values.ANDROID_KEYSTORE_PATH)) throw new Error("Keystore path must be absolute");
  const keystore = await stat(values.ANDROID_KEYSTORE_PATH);
  if (!keystore.isFile() || (keystore.mode & 0o777) !== 0o600) {
    throw new Error("Release keystore must have mode 600");
  }
  return { ...publicEnv, ...values };
}

async function login(): Promise<void> {
  console.log("$ gh auth token | docker login ghcr.io -u stoopkidddd --password-stdin");
  const source = spawn("gh", ["auth", "token"], {
    cwd: root,
    env: publicEnv,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const sink = spawn("docker", ["login", "ghcr.io", "-u", "stoopkidddd", "--password-stdin"], {
    cwd: root,
    env: publicEnv,
    stdio: ["pipe", "ignore", "ignore"],
  });
  // A failed login may close stdin before gh finishes; do not expose stream errors.
  sink.stdin.on("error", () => {});
  source.stdout.pipe(sink.stdin);
  try {
    const results = await Promise.all([once(source, "exit"), once(sink, "exit")]);
    if (results.some(([code]) => code !== 0)) throw new Error();
  } catch {
    source.kill();
    sink.kill();
    throw new Error("GHCR login failed");
  }
}

async function main(): Promise<void> {
  const [input, ...flags] = process.argv.slice(2);
  if (!input || flags.some((flag) => flag !== "--dry-run") || flags.length > 1) {
    throw new Error("Usage: mise run release <version> [--dry-run]");
  }
  const release = version(input);
  const dryRun = flags.includes("--dry-run");
  const testEnv = process.env.PNEUMO_RELEASE_ENV;
  const testFingerprint = process.env.PNEUMO_RELEASE_CERT_SHA256;
  if ((testEnv || testFingerprint) && (!dryRun || !testEnv || !testFingerprint)) {
    throw new Error("Test env and certificate overrides require each other and --dry-run");
  }
  const code = release.core[0] * 10000n + release.core[1] * 100n + release.core[2];
  if (code < 1n || code > 2100000000n)
    throw new Error("Android versionCode must be in 1..2100000000");
  const commit = await cleanMain();
  await run("git", ["fetch", "--tags", "origin", "main:refs/remotes/origin/main"]);
  await cleanMain();
  const tags = await run("git", ["tag", "--list", "v*"], { capture: true });
  let previous: Version | undefined;
  for (const tag of tags.split("\n").filter(Boolean)) {
    const tagged = version(tag.slice(1));
    if (!previous || compare(tagged, previous) > 0) previous = tagged;
  }
  if (previous && compare(release, previous) <= 0) {
    throw new Error(`Version must be newer than v${previous.text}`);
  }
  console.log(
    `REMINDER: confirm Tangled CI is green for ${commit} on the Pipelines tab before releasing.`,
  );
  await run("mise", ["run", "check"]);
  if ((await cleanMain()) !== commit) throw new Error("Release commit changed during checks");

  const documentation = await readFile(join(root, "docs/RELEASING.md"), "utf8");
  const recorded = /^Release certificate SHA-256: `([a-fA-F0-9:]+)`$/mu.exec(documentation)?.[1];
  if (!testFingerprint && !recorded)
    throw new Error("Record the real certificate fingerprint in docs/RELEASING.md first");
  const expected = fingerprint(testFingerprint ?? recorded ?? "");
  const envPath = testEnv ?? join(homedir(), ".config/pneumo/release.env");
  // Validate the files before starting an expensive build, but keep secrets out of other children.
  const gradleEnv = await signingEnvironment(envPath);
  // Docker tags cannot contain SemVer's '+'. Its metadata is preserved in the image and APK.
  const image = `ghcr.io/stoopkidddd/pneumo:${input.replaceAll("+", "_")}`;
  const rc = release.prerelease[0] === "rc";
  const build = [
    "buildx",
    "build",
    "--platform",
    "linux/amd64,linux/arm64",
    "--build-arg",
    `VERSION=${input}`,
    "-t",
    image,
  ];
  if (!rc) build.push("-t", "ghcr.io/stoopkidddd/pneumo:latest");
  await run("docker", [...build, "--output=type=cacheonly", "."]);
  await run(
    "./gradlew",
    [
      "--no-daemon",
      "--no-configuration-cache",
      "assembleRelease",
      `-PreleaseVersionName=${input}`,
      `-PreleaseVersionCode=${code}`,
    ],
    {
      cwd: join(root, "apps/android"),
      env: gradleEnv,
      capture: true,
    },
  );
  console.log("PASS signed assembleRelease");
  const apk = join(root, "apps/android/app/build/outputs/apk/release/app-release.apk");
  const sdk = publicEnv.ANDROID_HOME ?? publicEnv.ANDROID_SDK_ROOT;
  if (!sdk) throw new Error("ANDROID_HOME or ANDROID_SDK_ROOT is required for apksigner");
  const apksigner = join(sdk, "build-tools/37.0.0/apksigner");
  const certificate = await run(apksigner, ["verify", "--print-certs", apk], { capture: true });
  const certificates = new Set(
    [
      ...certificate.matchAll(
        /^(?:Signer #\d+|V\d+ Signer):? certificate SHA-256 digest: ([a-fA-F0-9:]+)$/gmu,
      ),
    ].map((match) => fingerprint(match[1])),
  );
  if (certificates.size !== 1 || !certificates.has(expected)) {
    throw new Error("APK certificate fingerprint mismatch; no release artifacts written");
  }
  console.log(`PASS APK certificate SHA-256 ${expected}`);
  const output = join(root, "dist/release");
  const name = `pneumo-${input}.apk`;
  const digest = createHash("sha256")
    .update(await readFile(apk))
    .digest("hex");
  await mkdir(output, { recursive: true });
  await copyFile(apk, join(output, name));
  await writeFile(join(output, "SHA256SUMS"), `${digest}  ${name}\n`);
  console.log(`PASS dist/release/${name} and SHA256SUMS`);
  const changes = await run(
    "git",
    ["log", "--format=- %s (%h)", previous ? `v${previous.text}..HEAD` : "HEAD"],
    { capture: true },
  );
  const notes = `## Changes\n${changes}\n\n## Install\nDownload ${name} and SHA256SUMS into one directory. Run \`shasum -a 256 -c SHA256SUMS\`, then install with \`adb install -r ${name}\` (or open the APK on Android and allow installation from that source).\n\nRelease candidates and final releases of the same version share versionCode ${code}; see docs/RELEASING.md for the uninstall requirement.\n\nContainer: \`docker pull ${image}\` (linux/amd64, linux/arm64).\n`;
  const tag = ["tag", "-a", `v${input}`, "-m", `Pneumo ${input}`];
  const originPush = ["push", "origin", `refs/tags/v${input}`];
  const mirrorPush = ["push", "github", "refs/heads/main:refs/heads/main", `refs/tags/v${input}`];
  const publish = [
    "release",
    "create",
    `v${input}`,
    "--repo",
    "stoopkidddd/pneumo",
    "--verify-tag",
    "--title",
    `Pneumo ${input}`,
    "--notes",
    notes,
    ...(rc ? ["--prerelease"] : []),
    join(output, name),
    join(output, "SHA256SUMS"),
  ];
  if ((await cleanMain()) !== commit) throw new Error("Release commit changed during builds");

  // Every authenticated/publication operation lives behind this single boundary.
  if (dryRun) {
    console.log("DRY RUN: built and verified locally; would publish with:");
    console.log("$ gh auth token | docker login ghcr.io -u stoopkidddd --password-stdin");
    for (const [program, args] of [
      ["docker", [...build, "--push", "."]],
      ["git", tag],
      ["git", originPush],
      ["git", mirrorPush],
      ["gh", publish],
    ] as const) {
      console.log(`$ ${command(program, [...args])}`);
    }
    return;
  } else {
    await login();
    await run("docker", [...build, "--push", "."]);
    await run("git", tag);
    await run("git", originPush);
    await run("git", mirrorPush);
    await run("gh", publish);
  }
}

main().catch((error: unknown) => {
  // Never surface third-party exceptions that might include secrets.
  console.error(error instanceof Error ? error.message : "Release failed");
  process.exitCode = 1;
});
