import { expect, test } from "vitest";
import { emptyHistory, type HistoryItem, historyReducer } from "./reducer.js";

function item(id: string, createdAt = "2026-10-31T12:00:00.000Z", pending = false): HistoryItem {
  return {
    id,
    createdAt,
    sourceDeviceId: "source",
    targetDeviceId: null,
    file: null,
    envelope: { v: 1, n: "", c: "" },
    payload: { type: "note", body: id },
    pending,
  };
}

test("history orders by server time and id, not arrival or client id alone", () => {
  const state = historyReducer(emptyHistory, {
    type: "merge",
    items: [item("z", "2026-10-31T10:00:00.000Z"), item("a"), item("b")],
  });
  expect(state.items.map((push) => push.id)).toEqual(["b", "a", "z"]);
});

test("server echo replaces optimistic metadata without duplicating or reverting it", () => {
  const draft = item("a", "2026-10-31T12:00:00.000Z", true);
  const echo = { ...draft, pending: false, createdAt: "2026-10-31T12:00:01.000Z" };
  let state = historyReducer(emptyHistory, { type: "merge", items: [draft] });
  state = historyReducer(state, { type: "merge", items: [echo, echo] });
  state = historyReducer(state, { type: "merge", items: [draft] });
  expect(state.items).toEqual([echo]);
});

test("deleted pushes cannot reappear from delayed decryption, pages, or send responses", () => {
  let state = historyReducer(emptyHistory, { type: "merge", items: [item("a"), item("b")] });
  state = historyReducer(state, { type: "delete", id: "a" });
  state = historyReducer(state, { type: "merge", items: [item("a")] });
  state = historyReducer(state, {
    type: "replace",
    startedWith: new Set(["a", "b"]),
    items: [item("a"), item("b")],
  });
  expect(state.items.map((push) => push.id)).toEqual(["b"]);
});

test("resync removes stale history but retains sends and live arrivals during the request", () => {
  let state = historyReducer(emptyHistory, { type: "merge", items: [item("stale")] });
  const startedWith = new Set(state.items.map((push) => push.id));
  state = historyReducer(state, {
    type: "merge",
    items: [item("draft", undefined, true), item("live")],
  });
  state = historyReducer(state, { type: "replace", startedWith, items: [item("snapshot")] });
  expect(state.items.map((push) => push.id)).toEqual(["snapshot", "live", "draft"]);
});

test("failed optimistic sends roll back without preventing later confirmed delivery", () => {
  let state = historyReducer(emptyHistory, { type: "merge", items: [item("a", undefined, true)] });
  state = historyReducer(state, { type: "rollback", id: "a" });
  expect(state.items).toEqual([]);
  state = historyReducer(state, { type: "merge", items: [item("a")] });
  expect(state.items).toEqual([item("a")]);
});
