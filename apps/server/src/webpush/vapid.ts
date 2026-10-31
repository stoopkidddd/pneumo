import { B64u, MeResponse } from "@pneumo/protocol";
import webPush from "web-push";
import { z } from "zod";
import type { Config } from "../config.js";
import { type Storage, StorageError } from "../storage/types.js";

const VapidKeys = z.object({
  publicKey: MeResponse.shape.vapidPublicKey,
  privateKey: B64u.refine((value) => Math.floor((value.length * 3) / 4) === 32),
  subject: z.string().min(1),
});
export type VapidKeys = z.infer<typeof VapidKeys>;

export async function loadVapidKeys({
  storage,
  config,
}: {
  storage: Storage;
  config: Pick<Config, "VAPID_SUBJECT">;
}): Promise<VapidKeys> {
  try {
    return VapidKeys.parse(await storage.getJson("meta/vapid.json"));
  } catch (error) {
    if (!(error instanceof StorageError) || error.code !== "NotFound") throw error;
  }
  const keys = VapidKeys.parse({
    ...webPush.generateVAPIDKeys(),
    subject: config.VAPID_SUBJECT,
  });
  await storage.putJson("meta/vapid.json", keys);
  return keys;
}
