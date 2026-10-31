import type { TestProject } from "vitest/node";
import { startMinio, stopMinio } from "../../../scripts/e2e/minio.js";

declare module "vitest" {
  export interface ProvidedContext {
    minio: Record<string, string>;
  }
}

export default async function setup({ provide }: TestProject): Promise<() => Promise<void>> {
  const instance = await startMinio().catch(() => {
    throw new Error("MinIO setup failed");
  });
  provide("minio", instance.env);
  return async () => {
    await stopMinio(instance).catch(() => {
      throw new Error("MinIO teardown failed");
    });
  };
}
