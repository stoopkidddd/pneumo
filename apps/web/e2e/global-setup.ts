import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  buildWebRuntime,
  type MinioInstance,
  type RunningWebRuntime,
  startMinio,
  startWebRuntime,
  stopMinio,
} from "./runtime.js";

const screenshotDirectory = fileURLToPath(new URL("../test-results/screens", import.meta.url));

export default async function globalSetup(): Promise<() => Promise<void>> {
  let minio: MinioInstance | undefined;
  let runtime: RunningWebRuntime | undefined;
  async function teardown() {
    try {
      await runtime?.stop();
    } finally {
      if (minio) await stopMinio(minio);
    }
  }
  try {
    await rm(screenshotDirectory, { recursive: true, force: true });
    await buildWebRuntime();
    minio = await startMinio();
    runtime = await startWebRuntime(`eng252/web/global/${randomUUID()}/`);
    process.env.PNEUMO_E2E_ORIGIN = runtime.origin;
    return teardown;
  } catch (error) {
    await teardown();
    throw error;
  }
}
