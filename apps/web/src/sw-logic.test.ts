import { webcrypto } from "node:crypto";
import { decryptPush, encryptPush } from "@pneumo/crypto";
import type { PushDTO, PushPayload } from "@pneumo/protocol";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  genericNotification,
  notificationForPush,
  resolveWebPush,
  routeNotificationClick,
} from "./sw-logic.js";

const PUSH_ID = "019a33b0-4200-7000-8000-000000000001";
const SOURCE_ID = "019a33b0-4200-7000-8000-000000000002";
const ICONS = { icon: "/icons/icon-192.png", badge: "/favicon.svg" };

beforeAll(() => {
  vi.stubGlobal("crypto", webcrypto);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function pushDto(envelope: PushDTO["envelope"]): PushDTO {
  return {
    id: PUSH_ID,
    createdAt: "2026-10-31T12:00:00.000Z",
    sourceDeviceId: SOURCE_ID,
    targetDeviceId: null,
    envelope,
    file: null,
  };
}

async function encryptedPush(payload: PushPayload) {
  const contentKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const push = pushDto(await encryptPush(contentKey, PUSH_ID, payload));
  return { contentKey, push };
}

function dependencies(contentKey: CryptoKey, push: PushDTO) {
  return {
    loadSession: vi.fn(async () => ({ contentKey })),
    fetchPush: vi.fn(async () => push),
    decryptPush,
  };
}

describe("notificationForPush", () => {
  test("maps a note and uses the note default title", () => {
    expect(notificationForPush(PUSH_ID, { type: "note", body: "Meet at ten" })).toEqual({
      title: "New note",
      options: {
        ...ICONS,
        body: "Meet at ten",
        tag: PUSH_ID,
        data: { pushId: PUSH_ID },
      },
    });
  });

  test("maps a link with its title, URL fallback body, data, and action", () => {
    expect(
      notificationForPush(PUSH_ID, {
        type: "link",
        title: "Release notes",
        url: "https://example.test/releases/1",
      }),
    ).toEqual({
      title: "Release notes",
      options: {
        ...ICONS,
        body: "https://example.test/releases/1",
        tag: PUSH_ID,
        data: { pushId: PUSH_ID, url: "https://example.test/releases/1" },
        actions: [{ action: "open", title: "Open link" }],
      },
    });
  });

  test("maps a file and uses its type title and filename body defaults", () => {
    expect(
      notificationForPush(PUSH_ID, {
        type: "file",
        file: {
          name: "report.pdf",
          mime: "application/pdf",
          size: 123,
          key: "A".repeat(43),
        },
      }),
    ).toEqual({
      title: "New file",
      options: {
        ...ICONS,
        body: "report.pdf",
        tag: PUSH_ID,
        data: { pushId: PUSH_ID },
      },
    });
  });
});

describe("resolveWebPush", () => {
  test("parses and decrypts an inline payload with the real crypto implementation", async () => {
    const fixture = await encryptedPush({ type: "note", title: "Private", body: "Ciphertext" });
    const deps = dependencies(fixture.contentKey, fixture.push);

    await expect(resolveWebPush({ t: "push", push: fixture.push }, deps)).resolves.toMatchObject({
      title: "Private",
      options: { body: "Ciphertext", tag: PUSH_ID },
    });
    expect(deps.fetchPush).not.toHaveBeenCalled();
  });

  test("fetches and decrypts a referenced payload with real crypto", async () => {
    const fixture = await encryptedPush({
      type: "link",
      body: "Read this",
      url: "https://example.test/article",
    });
    const deps = dependencies(fixture.contentKey, fixture.push);

    await expect(resolveWebPush({ t: "ref", id: PUSH_ID }, deps)).resolves.toMatchObject({
      title: "New link",
      options: {
        body: "Read this",
        data: { pushId: PUSH_ID, url: "https://example.test/article" },
      },
    });
    expect(deps.fetchPush).toHaveBeenCalledTimes(1);
    expect(deps.fetchPush).toHaveBeenCalledWith(PUSH_ID);
  });

  test.each([
    ["no session", null],
    ["no content key", {}],
  ] as const)("uses a generic notification with %s", async (_label, session) => {
    const fetchPush = vi.fn();
    const decrypt = vi.fn();
    await expect(
      resolveWebPush(
        { t: "ref", id: PUSH_ID },
        { loadSession: vi.fn(async () => session), fetchPush, decryptPush: decrypt },
      ),
    ).resolves.toEqual(genericNotification(PUSH_ID));
    expect(fetchPush).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
  });

  test("uses an untagged generic notification when parsing fails", async () => {
    const loadSession = vi.fn();
    await expect(
      resolveWebPush(
        { t: "push", push: { id: "not-a-push" } },
        { loadSession, fetchPush: vi.fn(), decryptPush: vi.fn() },
      ),
    ).resolves.toEqual(genericNotification());
    expect(loadSession).not.toHaveBeenCalled();
  });

  test("does not leak content when fetching a reference fails", async () => {
    const fixture = await encryptedPush({ type: "note", body: "Never displayed" });
    await expect(
      resolveWebPush(
        { t: "ref", id: PUSH_ID },
        {
          loadSession: vi.fn(async () => ({ contentKey: fixture.contentKey })),
          fetchPush: vi.fn(async () => {
            throw new Error("offline");
          }),
          decryptPush,
        },
      ),
    ).resolves.toEqual(genericNotification(PUSH_ID));
  });

  test("does not leak content when decryption fails", async () => {
    const fixture = await encryptedPush({ type: "note", body: "Never displayed" });
    await expect(
      resolveWebPush(
        { t: "push", push: fixture.push },
        {
          loadSession: vi.fn(async () => ({ contentKey: fixture.contentKey })),
          fetchPush: vi.fn(),
          decryptPush: vi.fn(async () => {
            throw new Error("authentication failed");
          }),
        },
      ),
    ).resolves.toEqual(genericNotification(PUSH_ID));
  });
});

describe("routeNotificationClick", () => {
  test("opens only an HTTP(S) link for the link action", () => {
    expect(
      routeNotificationClick("open", { pushId: PUSH_ID, url: "https://outside.test/item" }, true),
    ).toEqual({ type: "open-link", url: "https://outside.test/item" });
    expect(
      routeNotificationClick("open", { pushId: PUSH_ID, url: "javascript:alert(1)" }, true),
    ).toEqual({
      type: "focus-app",
      pushId: PUSH_ID,
    });
  });

  test("focuses an existing app for a plain click", () => {
    expect(routeNotificationClick("", { pushId: PUSH_ID }, true)).toEqual({
      type: "focus-app",
      pushId: PUSH_ID,
    });
  });

  test("deep-links a plain click when no app client exists", () => {
    expect(routeNotificationClick("", { pushId: PUSH_ID }, false)).toEqual({
      type: "open-app",
      url: `/?push=${PUSH_ID}`,
    });
  });
});
