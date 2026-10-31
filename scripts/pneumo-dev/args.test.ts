import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64uEncode, buildPairingUri } from "@pneumo/crypto";
import { describe, expect, test } from "vitest";
import { parseArgs } from "./args.js";
import { SafeError } from "./errors.js";

const URL = "https://pneumo.example.test";
const LINK_URL = "https://example.test/article";
const DEVICE_ID = "019a33b0-4200-7000-8000-000000000001";
const PUSH_ID = "019a33b0-4200-7000-8000-000000000002";
const SETUP_TOKEN = "setup-token-that-must-not-leak";
const PASSPHRASE = "long passphrase that must not leak";
const SESSION_PATH = "/tmp/private-pneumo-session.json";
const PAIRING_URI = buildPairingUri({
  origin: URL,
  code: b64uEncode(new Uint8Array(16)),
  mk: new Uint8Array(32),
});

function rejectsSafely(argv: string[], sensitive: readonly string[] = []): boolean {
  try {
    parseArgs(argv);
    return false;
  } catch (error) {
    return error instanceof SafeError && sensitive.every((value) => !error.message.includes(value));
  }
}

describe("parseArgs valid commands", () => {
  test("parses setup with its required setup token and passphrase", () => {
    const parsed = parseArgs([
      "--session",
      SESSION_PATH,
      "setup",
      "--passphrase",
      PASSPHRASE,
      "--url",
      URL,
      "--setup-token",
      SETUP_TOKEN,
    ]);

    expect(parsed.name).toBe("setup");
    expect(parsed.session).toBe(SESSION_PATH);
    expect(parsed.positionals).toEqual([]);
    expect(parsed.options.url).toBe(URL);
    expect(parsed.options["setup-token"] === SETUP_TOKEN).toBe(true);
    expect(parsed.options.passphrase === PASSPHRASE).toBe(true);
    expect(Object.hasOwn(parsed.options, "session")).toBe(false);
  });

  test("parses login and defaults the session path", () => {
    const parsed = parseArgs([
      "login",
      "--name",
      "Development client",
      "--passphrase",
      PASSPHRASE,
      "--url",
      URL,
    ]);

    expect(parsed.name).toBe("login");
    expect(parsed.session).toBe(join(tmpdir(), "pneumo-dev-session.json"));
    expect(parsed.options.passphrase === PASSPHRASE).toBe(true);
    expect(parsed.options.name).toBe("Development client");
  });

  test("parses pair-uri and claim", () => {
    const pair = parseArgs(["pair-uri"]);
    const claim = parseArgs(["claim", "--uri", PAIRING_URI]);

    expect(pair.positionals).toEqual([]);
    expect(Object.keys(pair.options)).toHaveLength(0);
    expect(claim.options.uri === PAIRING_URI).toBe(true);
  });

  test.each([
    { kind: "note", value: "hello", extra: [] as string[] },
    { kind: "link", value: LINK_URL, extra: ["--title", "Article"] },
    { kind: "file", value: "./payload.bin", extra: [] as string[] },
  ])("parses send $kind", ({ kind, value, extra }) => {
    const parsed = parseArgs([
      "send",
      kind,
      "--to",
      DEVICE_ID,
      ...extra,
      value,
      "--session",
      SESSION_PATH,
    ]);

    expect(parsed.name).toBe("send");
    expect(parsed.positionals).toEqual([kind, value]);
    expect(parsed.options.to).toBe(DEVICE_ID);
    expect(parsed.session).toBe(SESSION_PATH);
  });

  test("parses listen", () => {
    const parsed = parseArgs(["listen", "--session", SESSION_PATH]);

    expect(parsed.name).toBe("listen");
    expect(parsed.positionals).toEqual([]);
  });

  test.each([
    ["note", "body", "hello"],
    ["link", "url", LINK_URL],
    ["file", "file-name", "payload.bin"],
  ])("parses wait-for %s filters", (type, filter, value) => {
    const parsed = parseArgs([
      "wait-for",
      `--${filter}`,
      value,
      "--timeout",
      "1.5",
      "--type",
      type,
    ]);

    expect(parsed.options.type).toBe(type);
    expect(parsed.options[filter]).toBe(value);
    expect(parsed.options.timeout).toBe("1.5");
  });
  test("normalizes a trailing slash on a server origin", () => {
    const parsed = parseArgs(["login", "--url", `${URL}/`, "--passphrase", PASSPHRASE]);
    expect(parsed.options.url).toBe(URL);
  });

  test("accepts a caption filter on a link", () => {
    const parsed = parseArgs(["wait-for", "--type", "link", "--body", "caption", "--timeout", "1"]);
    expect(parsed.options.body).toBe("caption");
  });

  test("parses download", () => {
    const parsed = parseArgs(["download", PUSH_ID, "--out", "./download.bin"]);

    expect(parsed.positionals).toEqual([PUSH_ID]);
    expect(parsed.options.out).toBe("./download.bin");
  });

  test("accepts either or both smoke credential modes", () => {
    const setup = parseArgs(["smoke", "--url", URL, "--setup-token", SETUP_TOKEN]);
    const login = parseArgs(["smoke", "--passphrase", PASSPHRASE, "--url", URL]);
    const setupWithOverride = parseArgs([
      "smoke",
      "--url",
      URL,
      "--setup-token",
      SETUP_TOKEN,
      "--passphrase",
      PASSPHRASE,
    ]);

    expect(setup.options["setup-token"] === SETUP_TOKEN).toBe(true);
    expect(login.options.passphrase === PASSPHRASE).toBe(true);
    expect(setupWithOverride.options["setup-token"] === SETUP_TOKEN).toBe(true);
    expect(setupWithOverride.options.passphrase === PASSPHRASE).toBe(true);
  });
});

describe("parseArgs errors", () => {
  test.each([
    { label: "missing command", argv: [] },
    { label: "unknown command", argv: ["unknown"] },
    { label: "unknown option", argv: ["listen", "--verbose", "yes"] },
    { label: "missing option value", argv: ["login", "--url"] },
    { label: "duplicate option", argv: ["listen", "--session", "one", "--session", "two"] },
    { label: "missing required option", argv: ["setup", "--url", URL] },
    {
      label: "short setup passphrase",
      argv: ["setup", "--url", URL, "--setup-token", SETUP_TOKEN, "--passphrase", "short"],
      sensitive: [SETUP_TOKEN],
    },
    {
      label: "short login passphrase",
      argv: ["login", "--url", URL, "--passphrase", "short"],
    },
    {
      label: "invalid server URL",
      argv: ["setup", "--url", "ftp://invalid.test", "--setup-token", SETUP_TOKEN],
    },
    { label: "invalid link URL", argv: ["send", "link", "relative", "--title", "bad"] },
    { label: "invalid target device", argv: ["send", "note", "hello", "--to", "device-1"] },
    { label: "invalid pairing URI", argv: ["claim", "--uri", "pneumo://pair?invalid"] },
    { label: "unknown send kind", argv: ["send", "image", "payload"] },
    { label: "note title combination", argv: ["send", "note", "hello", "--title", "bad"] },
    { label: "missing send value", argv: ["send", "note"] },
    { label: "invalid wait type", argv: ["wait-for", "--type", "image", "--timeout", "1"] },
    {
      label: "wrong wait filter",
      argv: ["wait-for", "--type", "note", "--url", LINK_URL, "--timeout", "1"],
    },
    { label: "zero timeout", argv: ["wait-for", "--type", "note", "--timeout", "0"] },
    { label: "timeout overflow", argv: ["wait-for", "--type", "note", "--timeout", "2147484"] },
    {
      label: "missing setup passphrase",
      argv: ["setup", "--url", URL, "--setup-token", SETUP_TOKEN],
    },
    {
      label: "multiple wait filters",
      argv: [
        "wait-for",
        "--type",
        "link",
        "--url",
        LINK_URL,
        "--body",
        "caption",
        "--timeout",
        "1",
      ],
    },
    {
      label: "server URL with a path",
      argv: ["login", "--url", `${URL}/api`, "--passphrase", PASSPHRASE],
      sensitive: [PASSPHRASE],
    },
    { label: "nondecimal timeout", argv: ["wait-for", "--type", "note", "--timeout", "1e2"] },
    { label: "invalid push ID", argv: ["download", "push-1", "--out", "file"] },
    { label: "missing output", argv: ["download", PUSH_ID] },
    { label: "missing smoke credential mode", argv: ["smoke", "--url", URL] },
    { label: "unexpected positional", argv: ["listen", "extra"] },
  ])("rejects $label without exposing supplied secrets", ({ argv, sensitive = [] }) => {
    expect(rejectsSafely(argv, sensitive)).toBe(true);
  });
});
