// @vitest-environment jsdom
import type { DeviceDTO } from "@pneumo/protocol";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ApiClient } from "../api/client.js";
import type { Session } from "../session/store.js";
import { PairingModal } from "./PairingModal.js";

const qrCode = vi.hoisted(() => ({ toCanvas: vi.fn() }));
vi.mock("qrcode", () => ({ default: { toCanvas: qrCode.toCanvas } }));

const NOW = Date.parse("2026-10-31T12:00:00.000Z");
const FIRST_CODE = "AAAAAAAAAAAAAAAAAAAAAA";
const SECOND_CODE = "AQEBAQEBAQEBAQEBAQEBAQ";
const session: Session = {
  deviceId: "019a3598-c400-7000-8000-000000000001",
  token: "fixed-fake-device-token",
  mk: new Uint8Array(32).fill(7),
  contentKey: {} as CryptoKey,
};
type PairResponse = {
  code: string;
  expiresAt: string;
};

const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
const originalGetContext = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  "getContext",
);

const canvasContext = {
  clearRect: vi.fn(),
  drawImage: vi.fn(),
};

function response(code: string, expiresAt: number): PairResponse {
  return { code, expiresAt: new Date(expiresAt).toISOString() };
}

function apiFrom(request: unknown): ApiClient {
  return { request } as unknown as ApiClient;
}

function addedDevice(id: string, createdAt: number): DeviceDTO {
  return {
    id,
    name: "New phone",
    platform: "android",
    createdAt: new Date(createdAt).toISOString(),
    lastSeenAt: new Date(createdAt).toISOString(),
    online: true,
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  canvasContext.clearRect.mockReset();
  canvasContext.drawImage.mockReset();
  qrCode.toCanvas.mockReset();
  qrCode.toCanvas.mockImplementation(async (canvas: HTMLCanvasElement) => {
    canvas.width = 300;
    canvas.height = 300;
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: vi.fn(() => canvasContext),
  });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalShowModal) {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalShowModal);
  } else {
    delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
  }
  if (originalClose) {
    Object.defineProperty(HTMLDialogElement.prototype, "close", originalClose);
  } else {
    delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;
  }
  if (originalGetContext) {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", originalGetContext);
  }
});

test("counts down from the server expiry without exposing pairing material", async () => {
  const request = vi.fn().mockResolvedValue(response(FIRST_CODE, NOW + 10 * 60_000));
  const onClose = vi.fn();
  const onPaired = vi.fn();

  render(
    <PairingModal
      api={apiFrom(request)}
      session={session}
      addedDevice={null}
      onClose={onClose}
      onPaired={onPaired}
    />,
  );
  await settle();

  expect(screen.getByRole("timer").textContent).toBe("Code expires in 10:00");
  const secretInText = document.body.textContent?.includes(FIRST_CODE) ?? false;
  const secretInAttributes = [...document.querySelectorAll("*")].some((element) =>
    [...element.attributes].some((attribute) => attribute.value.includes(FIRST_CODE)),
  );
  expect(secretInText).toBe(false);
  expect(secretInAttributes).toBe(false);

  act(() => vi.advanceTimersByTime(1_000));
  expect(screen.getByRole("timer").textContent).toBe("Code expires in 9:59");
});

test("clears the QR code at expiry and offers recovery", async () => {
  const request = vi.fn().mockResolvedValue(response(FIRST_CODE, NOW + 2_000));
  render(
    <PairingModal
      api={apiFrom(request)}
      session={session}
      addedDevice={null}
      onClose={vi.fn()}
      onPaired={vi.fn()}
    />,
  );
  await settle();

  const canvas = screen.getByRole("img", { name: "Pairing QR code" }) as HTMLCanvasElement;
  expect(screen.getByRole("timer").textContent).toBe("Code expires in 0:02");

  act(() => vi.advanceTimersByTime(2_000));
  expect(screen.getByRole("alert").textContent).toBe(
    "This code has expired. Make a new code to continue.",
  );
  expect(screen.queryByRole("img", { name: "Pairing QR code" })).toBeNull();
  expect(canvas.width === 0 && canvas.height === 0).toBe(true);
  expect((screen.getByRole("button", { name: "New code" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
});

test("regenerates immediately, resets the countdown, and retries an error", async () => {
  let requestNumber = 0;
  const request = vi.fn().mockImplementation(() => {
    requestNumber += 1;
    if (requestNumber === 1) return Promise.reject(new TypeError("Offline"));
    return Promise.resolve(response(SECOND_CODE, Date.now() + 10 * 60_000));
  });
  render(
    <PairingModal
      api={apiFrom(request)}
      session={session}
      addedDevice={null}
      onClose={vi.fn()}
      onPaired={vi.fn()}
    />,
  );
  await settle();

  expect(screen.getByRole("alert").textContent).toBe(
    "Could not make a pairing code. Check your connection and try again.",
  );
  fireEvent.click(screen.getByRole("button", { name: "New code" }));
  expect(screen.getByRole("status").textContent).toBe("Making a secure pairing code…");
  await settle();

  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("timer").textContent).toBe("Code expires in 10:00");
  expect(screen.getByRole("img", { name: "Pairing QR code" })).not.toBeNull();
});

test("wipes the old QR immediately while a new code is generated", async () => {
  const nextResponse = Promise.withResolvers<PairResponse>();
  const request = vi
    .fn()
    .mockResolvedValueOnce(response(FIRST_CODE, NOW + 10 * 60_000))
    .mockReturnValueOnce(nextResponse.promise);
  render(
    <PairingModal
      api={apiFrom(request)}
      session={session}
      addedDevice={null}
      onClose={vi.fn()}
      onPaired={vi.fn()}
    />,
  );
  await settle();

  act(() => vi.advanceTimersByTime(60_000));
  expect(screen.getByRole("timer").textContent).toBe("Code expires in 9:00");

  const canvas = screen.getByRole("img", { name: "Pairing QR code" }) as HTMLCanvasElement;
  fireEvent.click(screen.getByRole("button", { name: "New code" }));
  expect(screen.queryByRole("img", { name: "Pairing QR code" })).toBeNull();
  expect(canvas.width === 0 && canvas.height === 0).toBe(true);

  nextResponse.resolve(response(SECOND_CODE, Date.now() + 10 * 60_000));
  await settle();
  expect(screen.getByRole("timer").textContent).toBe("Code expires in 10:00");
});

test("ignores a stale response after a request generation is replaced", async () => {
  const staleResponse = Promise.withResolvers<PairResponse>();
  const staleRequest = vi.fn().mockReturnValue(staleResponse.promise);
  const currentRequest = vi.fn().mockResolvedValue(response(SECOND_CODE, NOW + 10 * 60_000));
  const onClose = vi.fn();
  const onPaired = vi.fn();
  const view = render(
    <PairingModal
      api={apiFrom(staleRequest)}
      session={session}
      addedDevice={null}
      onClose={onClose}
      onPaired={onPaired}
    />,
  );
  await settle();

  view.rerender(
    <PairingModal
      api={apiFrom(currentRequest)}
      session={session}
      addedDevice={null}
      onClose={onClose}
      onPaired={onPaired}
    />,
  );
  await settle();
  expect(screen.getByRole("timer").textContent).toBe("Code expires in 10:00");

  staleResponse.resolve(response(FIRST_CODE, NOW + 60_000));
  await settle();
  expect(screen.getByRole("timer").textContent).toBe("Code expires in 10:00");
});

test("pairs only for a new device created after the active server-side code creation", async () => {
  const expiresAt = NOW + 5 * 60_000;
  const codeCreatedAt = expiresAt - 10 * 60_000;
  const baseline = addedDevice("019a3598-c400-7000-8000-000000000002", NOW + 60_000);
  const request = vi.fn().mockResolvedValue(response(FIRST_CODE, expiresAt));
  const api = apiFrom(request);
  const onClose = vi.fn();
  const onPaired = vi.fn();
  const view = render(
    <PairingModal
      api={api}
      session={session}
      addedDevice={baseline}
      onClose={onClose}
      onPaired={onPaired}
    />,
  );
  await settle();

  view.rerender(
    <PairingModal
      api={api}
      session={session}
      addedDevice={{ ...baseline, online: false }}
      onClose={onClose}
      onPaired={onPaired}
    />,
  );
  await settle();
  expect(onPaired).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();

  const stale = addedDevice("019a3598-c400-7000-8000-000000000003", codeCreatedAt);
  view.rerender(
    <PairingModal
      api={api}
      session={session}
      addedDevice={stale}
      onClose={onClose}
      onPaired={onPaired}
    />,
  );
  await settle();
  expect(onPaired).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();

  const paired = addedDevice("019a3598-c400-7000-8000-000000000004", codeCreatedAt + 1);
  view.rerender(
    <PairingModal
      api={api}
      session={session}
      addedDevice={paired}
      onClose={onClose}
      onPaired={onPaired}
    />,
  );
  await settle();
  expect(onPaired).toHaveBeenCalledOnce();
  expect(onPaired).toHaveBeenCalledWith(paired);
  expect(onClose).not.toHaveBeenCalled();
});

test("a device added during code rendering still completes the pairing", async () => {
  const drawing = Promise.withResolvers<void>();
  qrCode.toCanvas.mockImplementation(async (canvas: HTMLCanvasElement) => {
    await drawing.promise;
    canvas.width = 300;
    canvas.height = 300;
  });
  const api = apiFrom(vi.fn().mockResolvedValue(response(FIRST_CODE, NOW + 10 * 60_000)));
  const onPaired = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <PairingModal
      api={api}
      session={session}
      addedDevice={null}
      onClose={onClose}
      onPaired={onPaired}
    />,
  );
  await settle();
  const phone = addedDevice("019a3598-c400-7000-8000-000000000005", NOW + 1);
  view.rerender(
    <PairingModal
      api={api}
      session={session}
      addedDevice={phone}
      onClose={onClose}
      onPaired={onPaired}
    />,
  );
  drawing.resolve();
  await settle();
  expect(onPaired).toHaveBeenCalledWith(phone);
  expect(onClose).not.toHaveBeenCalled();
});
