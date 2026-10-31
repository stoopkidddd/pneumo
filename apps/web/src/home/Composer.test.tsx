// @vitest-environment jsdom
import type { DeviceDTO } from "@pneumo/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { Composer } from "./Composer.js";
import { buildPushPayload, envelopeByteLength } from "./payload.js";

const onlineDevice: DeviceDTO = {
  id: "019a3598-c400-7000-8000-000000000001",
  name: "Office browser",
  platform: "web",
  createdAt: "2026-10-31T00:00:00.000Z",
  lastSeenAt: "2026-10-31T00:00:00.000Z",
  online: true,
};
const offlineDevice: DeviceDTO = {
  id: "019a3598-c400-7000-8000-000000000002",
  name: "Kitchen tablet",
  platform: "android",
  createdAt: "2026-10-31T00:00:00.000Z",
  lastSeenAt: "2026-10-31T00:00:00.000Z",
  online: false,
};

function renderComposer(
  onSend = vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  props: Partial<ComponentProps<typeof Composer>> = {},
) {
  return render(
    <Composer
      devices={[onlineDevice, offlineDevice]}
      maxEnvelopeBytes={65_536}
      onSend={onSend}
      onFiles={vi.fn()}
      offline={false}
      {...props}
    />,
  );
}

afterEach(() => {
  cleanup();
});

test("uses frozen link detection live and sends a trimmed link payload", async () => {
  const onSend = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  renderComposer(onSend);
  const message = screen.getByLabelText("Message");

  fireEvent.change(message, { target: { value: "Read https://example.test" } });
  expect(screen.queryByText("Link")).toBeNull();

  fireEvent.change(message, { target: { value: "  https://example.test/article  " } });
  expect(screen.getByText("Link").getAttribute("role")).toBe("status");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));

  await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
  expect(onSend).toHaveBeenCalledWith({ type: "link", url: "https://example.test/article" }, null);
});

test("keeps title optional and includes it after the collapsed control is expanded", async () => {
  const onSend = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  renderComposer(onSend);
  expect(screen.queryByLabelText("Title")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Add a title" }));
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Trip list" } });
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Bring a charger" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));

  await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
  expect(onSend).toHaveBeenCalledWith(
    { type: "note", title: "Trip list", body: "Bring a charger" },
    null,
  );
  await screen.findByText("Sent.");
  expect(screen.queryByLabelText("Title")).toBeNull();
});

test("lists device presence in the native target select and sends to the chosen device", async () => {
  const onSend = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  renderComposer(onSend);
  const target = screen.getByLabelText("Send to") as HTMLSelectElement;

  expect(screen.getByRole("option", { name: "All devices" })).not.toBeNull();
  expect(screen.getByRole("option", { name: "Office browser · online" })).not.toBeNull();
  expect(screen.getByRole("option", { name: "Kitchen tablet · offline" })).not.toBeNull();
  fireEvent.change(target, { target: { value: offlineDevice.id } });
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Dinner is ready" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));

  await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
  expect(onSend).toHaveBeenCalledWith({ type: "note", body: "Dinner is ready" }, offlineDevice.id);
});

test("Enter sends while Shift+Enter and IME composition do not", async () => {
  const onSend = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  renderComposer(onSend);
  const message = screen.getByLabelText("Message");
  fireEvent.change(message, { target: { value: "First line\nSecond line" } });

  fireEvent.keyDown(message, { key: "Enter", shiftKey: true });
  expect(onSend).not.toHaveBeenCalled();
  fireEvent.compositionStart(message);
  fireEvent.keyDown(message, { key: "Enter" });
  expect(onSend).not.toHaveBeenCalled();
  fireEvent.compositionEnd(message);
  fireEvent.keyDown(message, { key: "Enter" });

  await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
  expect(onSend).toHaveBeenCalledWith({ type: "note", body: "First line\nSecond line" }, null);
  await waitFor(() => expect(document.activeElement).toBe(message));
});

test("enforces the exact encrypted envelope boundary before sending", () => {
  const body = 'escaped "quote" and snowman ☃';
  const exact = envelopeByteLength(buildPushPayload(body, ""));
  const onSend = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const view = renderComposer(onSend, { maxEnvelopeBytes: exact });
  const message = screen.getByLabelText("Message");
  fireEvent.change(message, { target: { value: body } });
  expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByText(`${exact} / ${exact} encrypted bytes`)).not.toBeNull();

  view.rerender(
    <Composer
      devices={[onlineDevice, offlineDevice]}
      maxEnvelopeBytes={exact - 1}
      onSend={onSend}
      onFiles={vi.fn()}
      offline={false}
    />,
  );

  expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("alert").textContent).toContain("Message is too large");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(onSend).not.toHaveBeenCalled();
});

test("disables all inputs while sending and retains the draft after an error", async () => {
  const pending = Promise.withResolvers<void>();
  const onSend = vi.fn<() => Promise<void>>().mockReturnValue(pending.promise);
  renderComposer(onSend);
  const message = screen.getByLabelText("Message") as HTMLTextAreaElement;
  const target = screen.getByLabelText("Send to") as HTMLSelectElement;
  const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
  fireEvent.change(message, { target: { value: "Do not lose this draft" } });
  fireEvent.click(send);

  await screen.findByText("Sending…", { selector: '[role="status"]' });
  expect(message.disabled).toBe(true);
  expect(target.disabled).toBe(true);
  expect(send.disabled).toBe(true);

  await act(async () => {
    pending.reject(new Error("network unavailable"));
  });

  expect((await screen.findByRole("alert")).textContent).toContain("Could not send");
  expect(message.value).toBe("Do not lose this draft");
  expect(message.disabled).toBe(false);
  expect(send.disabled).toBe(false);
  expect(document.activeElement).toBe(message);
});

test("keeps a draft visible but disables the composer while offline", () => {
  const view = renderComposer(undefined, { offline: false });
  const message = screen.getByLabelText("Message") as HTMLTextAreaElement;
  fireEvent.change(message, { target: { value: "Waiting for a connection" } });

  view.rerender(
    <Composer
      devices={[onlineDevice, offlineDevice]}
      maxEnvelopeBytes={65_536}
      onSend={vi.fn<() => Promise<void>>().mockResolvedValue(undefined)}
      onFiles={vi.fn()}
      offline
    />,
  );

  expect(message.value).toBe("Waiting for a connection");
  expect(message.disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
});

test("rejects an oversized attachment without losing the caption or allowing a send", () => {
  renderComposer(undefined, {
    onFiles: () => {
      throw new Error("The encrypted file exceeds the 1 MiB file limit");
    },
  });
  const message = screen.getByLabelText("Message") as HTMLTextAreaElement;
  fireEvent.change(message, { target: { value: "Keep this caption" } });
  fireEvent.change(screen.getByLabelText("Attach files"), {
    target: { files: [new File(["content"], "large.bin")] },
  });
  expect(screen.getByRole("alert").textContent).toContain("1 MiB file limit");
  expect(message.value).toBe("Keep this caption");
});

test("file paste consumes the event but ordinary text paste stays native", () => {
  renderComposer();
  const message = screen.getByLabelText("Message") as HTMLTextAreaElement;
  fireEvent.change(message, { target: { value: "Caption for the picture" } });
  const plain = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(plain, "clipboardData", { value: { files: [] } });
  fireEvent(message, plain);
  expect(plain.defaultPrevented).toBe(false);
  const picture = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(picture, "clipboardData", {
    value: { files: [new File(["image"], "picture.png", { type: "image/png" })] },
  });
  fireEvent(message, picture);
  expect(picture.defaultPrevented).toBe(true);
  expect(message.value).toBe("");
  expect(document.activeElement).toBe(message);
});

test("drops prevent browser navigation and explain why files cannot send offline", () => {
  renderComposer(undefined, { offline: true });
  const drop = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", {
    value: { types: ["Files"], files: [new File(["content"], "offline.txt")] },
  });
  fireEvent(window, drop);
  expect(drop.defaultPrevented).toBe(true);
  expect(screen.getByRole("alert").textContent).toContain("Reconnect");
});
