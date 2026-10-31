import { describe, expect, test } from "vitest";
import { type UploadItem, uploadReducer } from "./progress.js";

const initial: UploadItem = {
  id: "upload-1",
  name: "report.bin",
  size: 10,
  phase: "encrypting",
  loaded: 0,
  total: 10,
};

describe("uploadReducer", () => {
  test("adds, advances, clamps, and removes an upload", () => {
    let state = uploadReducer([], { type: "add", item: initial });
    state = uploadReducer(state, {
      type: "progress",
      id: initial.id,
      progress: { phase: "encrypting", loaded: 7, total: 10 },
    });
    state = uploadReducer(state, {
      type: "progress",
      id: initial.id,
      progress: { phase: "encrypting", loaded: 4, total: 6 },
    });
    expect(state[0]).toMatchObject({ phase: "encrypting", loaded: 7, total: 10 });

    state = uploadReducer(state, {
      type: "progress",
      id: initial.id,
      progress: { phase: "uploading", loaded: 99, total: 26 },
    });
    expect(state[0]).toMatchObject({ phase: "uploading", loaded: 26, total: 26 });

    state = uploadReducer(state, { type: "sending", id: initial.id });
    expect(state[0]?.phase).toBe("sending");
    expect(uploadReducer(state, { type: "cancel", id: initial.id })).toBe(state);
    expect(uploadReducer(state, { type: "remove", id: initial.id })).toEqual([]);
  });

  test.each(["cancelled", "error"] as const)(
    "ignores late progress and phase races after %s",
    (terminalPhase) => {
      const terminal: UploadItem = {
        ...initial,
        phase: terminalPhase,
        ...(terminalPhase === "error" ? { error: "Upload failed" } : {}),
      };
      const state = [terminal];
      const actions = [
        {
          type: "progress" as const,
          id: initial.id,
          progress: { phase: "uploading" as const, loaded: 10, total: 10 },
        },
        { type: "sending" as const, id: initial.id },
        { type: "error" as const, id: initial.id, error: "Late failure" },
        { type: "cancel" as const, id: initial.id },
      ];

      for (const action of actions) expect(uploadReducer(state, action)).toBe(state);
    },
  );

  test("does not regress from uploading to a late encryption event", () => {
    const state: UploadItem[] = [{ ...initial, phase: "uploading", loaded: 5, total: 20 }];
    expect(
      uploadReducer(state, {
        type: "progress",
        id: initial.id,
        progress: { phase: "encrypting", loaded: 10, total: 10 },
      }),
    ).toBe(state);
  });

  test("turns a non-terminal transfer failure into a stable terminal error", () => {
    const failed = uploadReducer([initial], {
      type: "error",
      id: initial.id,
      error: "File upload failed (HTTP 500)",
    });
    expect(failed[0]).toMatchObject({
      phase: "error",
      error: "File upload failed (HTTP 500)",
    });
    expect(uploadReducer(failed, { type: "cancel", id: initial.id })).toBe(failed);
  });
});
