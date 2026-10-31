// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { encryptPush } from "@pneumo/crypto";
import type { PushDTO } from "@pneumo/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ApiClient } from "../api/client.js";
import type { ConnectLiveOptions } from "../live/ws.js";
import type { Session } from "../session/store.js";
import { useHome } from "./useHome.js";

const live = vi.hoisted(() => ({ options: null as ConnectLiveOptions | null }));
vi.mock("../live/ws.js", () => ({
  connectLive: (options: ConnectLiveOptions) => {
    live.options = options;
    return { stop: vi.fn(), reconnect: vi.fn() };
  },
}));
let session: Session;
let pushes: PushDTO[];
let api: ApiClient;
const unauthorized = vi.fn();

async function push(id: string, createdAt: string): Promise<PushDTO> {
  return {
    id,
    createdAt,
    sourceDeviceId: session.deviceId,
    targetDeviceId: null,
    file: null,
    envelope: await encryptPush(session.contentKey, id, { type: "note", body: id }),
  };
}

beforeEach(async () => {
  vi.stubGlobal("crypto", webcrypto);
  window.history.replaceState(null, "", "/");
  live.options = null;
  session = {
    deviceId: "019a3598-c400-7000-8000-000000000001",
    token: "fixed-fake-token",
    mk: new Uint8Array(32),
    contentKey: await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]),
  };
  pushes = [];
  api = {
    request: vi.fn(async (name: string) => {
      if (name === "listPushes") return { pushes, nextBefore: null };
      if (name === "listDevices") return { devices: [] };
      if (name === "me")
        return {
          limits: { maxEnvelopeBytes: 65536, maxFileBytes: 524288000 },
          uploadMode: "direct",
        };
      throw new Error(`Unexpected request: ${name}`);
    }) as ApiClient["request"],
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("replay advances the cursor synchronously, before asynchronous decryption", async () => {
  const { result } = renderHook(() => useHome(api, session, unauthorized));
  await waitFor(() => expect(result.current.loading).toBe(false));
  const replayed = await push("019a3598-c400-7000-8000-000000000010", "2026-10-31T12:00:00.000Z");
  act(() => {
    live.options?.onFrame({ type: "push", push: replayed });
    expect(live.options?.since()).toBe(replayed.id);
  });
  await waitFor(() =>
    expect(result.current.items[0]?.payload).toEqual({ type: "note", body: replayed.id }),
  );
});

test("resync replaces a deleted newest cursor rather than reconnecting forever with an unknown id", async () => {
  const older = await push("019a3598-c400-7000-8000-000000000010", "2026-10-31T12:00:00.000Z");
  const newer = await push("019a3598-c400-7000-8000-000000000011", "2026-10-31T12:00:01.000Z");
  pushes = [newer, older];
  const { result } = renderHook(() => useHome(api, session, unauthorized));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(live.options?.since()).toBe(newer.id);
  act(() => live.options?.onFrame({ type: "push_deleted", id: newer.id }));
  pushes = [older];
  await act(async () => {
    await live.options?.onResync();
  });
  expect(live.options?.since()).toBe(older.id);
  expect(result.current.items.map((item) => item.id)).toEqual([older.id]);
});

test("refresh retains an old deep-linked item outside the newest page", async () => {
  const older = await push("019a3598-c400-7000-8000-000000000010", "2026-10-31T12:00:00.000Z");
  const newer = await push("019a3598-c400-7000-8000-000000000011", "2026-10-31T12:00:01.000Z");
  window.history.replaceState(null, "", `/?push=${older.id}`);
  pushes = [older];
  const { result } = renderHook(() => useHome(api, session, unauthorized));
  await waitFor(() => expect(result.current.loading).toBe(false));
  pushes = [newer];
  await act(async () => {
    await live.options?.onResync();
  });
  expect(result.current.items.map((item) => item.id)).toEqual([newer.id, older.id]);
});
