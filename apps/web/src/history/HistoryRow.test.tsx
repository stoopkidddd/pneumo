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
  Element.prototype.scrollIntoView = vi.fn();
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
      onDownload={vi.fn()}
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
      onDownload={vi.fn()}
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

test("a file deep link focuses Download and a failed download can be retried", async () => {
  const pending = Promise.withResolvers<void>();
  const download = vi.fn().mockReturnValue(pending.promise);
  const fileItem: HistoryItem = {
    ...item,
    file: { id: item.id, size: 1048624 },
    payload: {
      type: "file",
      body: "An encrypted attachment",
      file: {
        name: "photo.png",
        mime: "image/png",
        size: 1048576,
        key: "A".repeat(43),
      },
    },
  };
  render(
    <HistoryRow
      item={fileItem}
      devices={[]}
      highlighted
      now={Date.parse(item.createdAt)}
      onDelete={vi.fn()}
      onDownload={download}
    />,
  );
  expect(screen.getByText("photo.png")).not.toBeNull();
  expect(screen.getByText("1 MiB")).not.toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Download" }));
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  expect((screen.getByRole("button", { name: "Downloading…" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  await act(async () => pending.reject(new Error("This file was corrupted or tampered with")));
  expect(screen.getByRole("alert").textContent).toContain("corrupted or tampered with");
  expect((screen.getByRole("button", { name: "Download" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
});
