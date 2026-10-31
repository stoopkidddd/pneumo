// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import type { FilePayload } from "@pneumo/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ApiClient } from "../api/client.js";
import type { Session } from "../session/store.js";
import { type FileSender, useFiles } from "./useFiles.js";

const transfer = vi.hoisted(() => ({ uploadFile: vi.fn(), validateFile: vi.fn() }));
vi.mock("./transfer.js", () => ({ ...transfer, downloadFile: vi.fn() }));
const uploaded = {
  payload: {
    type: "file",
    file: { name: "report.txt", mime: "text/plain", size: 1, key: "A".repeat(43) },
  } satisfies FilePayload,
  file: { id: "019a3598-c400-7000-8000-000000000001", size: 25 },
};
let session: Session;
const api = { request: vi.fn() } as ApiClient;
const onUnauthorized = vi.fn();

beforeEach(async () => {
  vi.stubGlobal("crypto", webcrypto);
  transfer.uploadFile.mockReset();
  transfer.validateFile.mockReset();
  session = {
    deviceId: uploaded.file.id,
    token: "fixed-fake-token",
    mk: new Uint8Array(32),
    contentKey: await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]),
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(send: FileSender) {
  return renderHook(() =>
    useFiles({
      api,
      session,
      send,
      maxFileBytes: 1024,
      maxEnvelopeBytes: 65536,
      uploadMode: "direct",
      onUnauthorized,
    }),
  );
}

test("a cancelled transfer cannot publish a push even if upload completion arrives late", async () => {
  const pending = Promise.withResolvers<typeof uploaded>();
  transfer.uploadFile.mockReturnValue(pending.promise);
  const send = vi.fn<FileSender>().mockResolvedValue(undefined);
  const { result } = mount(send);
  act(() => result.current.sendFiles([new File(["x"], "report.txt")], "", "", null));
  const id = result.current.uploads[0]?.id;
  if (!id) throw new Error("Expected a pending file");
  act(() => result.current.cancelUpload(id));
  await act(async () => pending.resolve(uploaded));
  expect(result.current.uploads[0]?.phase).toBe("cancelled");
  expect(send).not.toHaveBeenCalled();
});

test("a stale Cancel click after upload success cannot strand an already sending row", async () => {
  transfer.uploadFile.mockResolvedValue(uploaded);
  const pendingPush = Promise.withResolvers<void>();
  const send = vi.fn<FileSender>().mockReturnValue(pendingPush.promise);
  const { result } = mount(send);
  act(() => result.current.sendFiles([new File(["x"], "report.txt")], "", "", null));
  await waitFor(() => expect(result.current.uploads[0]?.phase).toBe("sending"));
  const id = result.current.uploads[0]?.id;
  if (!id) throw new Error("Expected a sending file");
  act(() => result.current.cancelUpload(id));
  await act(async () => pendingPush.resolve());
  expect(result.current.uploads).toEqual([]);
});
