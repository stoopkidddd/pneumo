// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { HistoryRow } from "./HistoryRow.js";
import type { HistoryItem } from "./reducer.js";

const item: HistoryItem = {
  id: "019a3598-c400-7000-8000-000000000001",
  createdAt: "2026-10-31T12:00:00.000Z",
  sourceDeviceId: "source",
  targetDeviceId: null,
  file: null,
  envelope: { v: 1, n: "", c: "" },
  payload: { type: "note", body: "Keep this note" },
  pending: false,
};
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("clipboard denial leaves the note available and offers a recovery message", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockRejectedValue(new Error("Denied")) },
  });
  render(
    <HistoryRow
      item={item}
      devices={[]}
      highlighted={false}
      now={Date.parse(item.createdAt)}
      onDelete={async () => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Allow clipboard access");
  expect(screen.getByText("Keep this note")).not.toBeNull();
});

test("deletion requires confirmation, can be cancelled, and can retry a failed request", async () => {
  const failure = Promise.withResolvers<void>();
  const remove = vi.fn().mockReturnValueOnce(failure.promise).mockResolvedValueOnce(undefined);
  render(
    <HistoryRow
      item={item}
      devices={[]}
      highlighted={false}
      now={Date.parse(item.createdAt)}
      onDelete={remove}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Confirm delete" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
  await act(async () => failure.reject(new Error("Offline")));
  expect(screen.getByRole("alert").textContent).toContain("Could not delete");
  fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
  expect(remove).toHaveBeenCalledTimes(2);
});
