import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { B64u, IsoTimestamp, KdfParams, type SetupRequest } from "@pneumo/protocol";
import type { Logger } from "pino";
import { z } from "zod";
import type { Clock } from "../app.js";
import { createVerifier } from "../auth/verifier.js";
import type { Config } from "../config.js";
import { type Storage, StorageError } from "../storage/types.js";
import { Mutex } from "./mutex.js";

const bytes = (size: number) => B64u.refine((value) => Math.floor((value.length * 3) / 4) === size);

const OwnerRecord = z.object({
  v: z.literal(1),
  createdAt: IsoTimestamp,
  kdf: KdfParams,
  authVerifier: z.object({
    alg: z.literal("scrypt"),
    N: z.literal(16_384),
    r: z.literal(8),
    p: z.literal(1),
    salt: bytes(16),
    hash: bytes(32),
  }),
  keyCheck: bytes(32),
});
export type OwnerRecord = z.infer<typeof OwnerRecord>;

interface InstanceDependencies {
  storage: Storage;
  config: Config;
  clock: Clock;
  logger: Logger;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export class InstanceState {
  private currentOwner: OwnerRecord | null = null;
  private setupTokenHash: Buffer | null = null;
  private readonly mutex = new Mutex();

  private constructor(private readonly deps: InstanceDependencies) {}

  static async load(deps: InstanceDependencies): Promise<InstanceState> {
    const state = new InstanceState(deps);
    try {
      state.currentOwner = OwnerRecord.parse(await deps.storage.getJson("meta/owner.json"));
    } catch (error) {
      if (!(error instanceof StorageError) || error.code !== "NotFound") throw error;
    }
    if (!state.initialized) {
      const token = deps.config.PNEUMO_SETUP_TOKEN ?? randomBytes(32).toString("base64url");
      state.setupTokenHash = digest(token);
      if (deps.config.PNEUMO_SETUP_TOKEN === undefined) {
        // The sole allowed credential log: the fragment never reaches request logs.
        deps.logger.warn(
          `Pneumo is not set up yet. Open ${deps.config.PUBLIC_URL}/setup#token=${token}`,
        );
      }
    }
    return state;
  }

  get owner(): OwnerRecord | null {
    return this.currentOwner;
  }

  get initialized(): boolean {
    return this.currentOwner !== null;
  }

  validSetupToken(token: unknown): boolean {
    return (
      typeof token === "string" &&
      this.setupTokenHash !== null &&
      timingSafeEqual(digest(token), this.setupTokenHash)
    );
  }

  async initialize(request: SetupRequest): Promise<boolean> {
    return this.mutex.run(async () => {
      if (this.initialized) return false;
      const owner: OwnerRecord = {
        v: 1,
        createdAt: new Date(this.deps.clock.now()).toISOString(),
        kdf: request.kdf,
        authVerifier: await createVerifier(request.authKey),
        keyCheck: request.keyCheck,
      };
      try {
        await this.deps.storage.putJson("meta/owner.json", owner, { ifNoneMatch: "*" });
      } catch (error) {
        if (!(error instanceof StorageError)) throw error;
        if (error.code === "PreconditionFailed") {
          this.currentOwner = OwnerRecord.parse(await this.deps.storage.getJson("meta/owner.json"));
          this.setupTokenHash = null;
          return false;
        }
        if (error.code !== "Unsupported") throw error;
        await this.deps.storage.putJson("meta/owner.json", owner);
      }
      this.currentOwner = owner;
      this.setupTokenHash = null;
      return true;
    });
  }
}
