import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePairingUri } from "@pneumo/crypto";
import { HttpUrl, Uuidv7 } from "@pneumo/protocol";
import { SafeError } from "./errors.js";

type CommandName =
  | "setup"
  | "login"
  | "pair-uri"
  | "claim"
  | "send"
  | "listen"
  | "wait-for"
  | "download"
  | "smoke";

type ParsedArgs = {
  name: CommandName;
  session: string;
  options: Record<string, string>;
  positionals: string[];
};

const DEFAULT_SESSION = join(tmpdir(), "pneumo-dev-session.json");
const OPTION_NAME = /^--([a-z][a-z0-9-]*)$/;
const POSITIVE_SECONDS = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

function fail(message: string): never {
  throw new SafeError(message);
}

function tokenize(argv: string[]): { options: Map<string, string>; positionals: string[] } {
  const options = new Map<string, string>();
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (!argument.startsWith("--")) {
      if (argument.startsWith("-")) fail("Unknown option");
      positionals.push(argument);
      continue;
    }

    const name = OPTION_NAME.exec(argument)?.[1];
    if (name === undefined) fail("Unknown option");
    if (options.has(name)) fail("Duplicate option");

    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail("Missing option value");
    options.set(name, value);
    index += 1;
  }

  return { options, positionals };
}

function commandName(value: string | undefined): CommandName {
  switch (value) {
    case "setup":
    case "login":
    case "pair-uri":
    case "claim":
    case "send":
    case "listen":
    case "wait-for":
    case "download":
    case "smoke":
      return value;
    case undefined:
      return fail("Missing command");
    default:
      return fail("Unknown command");
  }
}

function selectOptions(
  source: Map<string, string>,
  allowed: readonly string[],
): Record<string, string> {
  const allowedNames = new Set(["session", ...allowed]);
  for (const name of source.keys()) {
    if (!allowedNames.has(name)) fail("Unknown option");
  }

  const selected: Record<string, string> = {};
  for (const [name, value] of source) {
    if (name !== "session") selected[name] = value;
  }
  return selected;
}

function requireOption(options: Record<string, string>, name: string): string {
  const value = options[name];
  if (value === undefined) fail(`Missing --${name}`);
  return value;
}

function requireNoExtraPositionals(positionals: string[], expected: number): void {
  if (positionals.length < expected) fail("Missing argument");
  if (positionals.length > expected) fail("Unexpected argument");
}

function requireHttpUrl(value: string, option: string): void {
  if (!HttpUrl.safeParse(value).success) fail(`Invalid --${option}`);
}

function requireDeviceId(value: string): void {
  if (!Uuidv7.safeParse(value).success) fail("Invalid --to");
}

function requireNonempty(value: string, option: string): void {
  if (value.length === 0) fail(`Invalid --${option}`);
}

function requirePassphrase(value: string): void {
  if (value.length < 12) fail("Passphrase must be at least 12 characters");
}

function parseSetup(source: Map<string, string>, positionals: string[]): Record<string, string> {
  requireNoExtraPositionals(positionals, 1);
  const options = selectOptions(source, ["url", "setup-token", "passphrase"]);
  requireHttpUrl(requireOption(options, "url"), "url");
  requireNonempty(requireOption(options, "setup-token"), "setup-token");
  requirePassphrase(requireOption(options, "passphrase"));
  return options;
}

function parseLogin(source: Map<string, string>, positionals: string[]): Record<string, string> {
  requireNoExtraPositionals(positionals, 1);
  const options = selectOptions(source, ["url", "passphrase", "name"]);
  requireHttpUrl(requireOption(options, "url"), "url");
  requirePassphrase(requireOption(options, "passphrase"));
  if (options.name !== undefined) requireNonempty(options.name, "name");
  return options;
}

function parsePairUri(source: Map<string, string>, positionals: string[]): Record<string, string> {
  requireNoExtraPositionals(positionals, 1);
  return selectOptions(source, []);
}

function parseClaim(source: Map<string, string>, positionals: string[]): Record<string, string> {
  requireNoExtraPositionals(positionals, 1);
  const options = selectOptions(source, ["uri"]);
  const uri = requireOption(options, "uri");
  try {
    parsePairingUri(uri);
  } catch {
    fail("Invalid --uri");
  }
  return options;
}

function parseSend(source: Map<string, string>, positionals: string[]): Record<string, string> {
  requireNoExtraPositionals(positionals, 3);
  const kind = positionals[1];
  let allowed: readonly string[];
  switch (kind) {
    case "note":
      allowed = ["to"];
      break;
    case "link":
      allowed = ["title", "to"];
      break;
    case "file":
      allowed = ["to"];
      break;
    default:
      return fail("Invalid send kind");
  }

  const options = selectOptions(source, allowed);
  const value = positionals[2] ?? "";
  if (kind === "link") requireHttpUrl(value, "url");
  if (kind === "file" && value.length === 0) fail("Invalid file path");
  if (options.to !== undefined) requireDeviceId(options.to);
  return options;
}

function parseListen(source: Map<string, string>, positionals: string[]): Record<string, string> {
  requireNoExtraPositionals(positionals, 1);
  return selectOptions(source, []);
}

function parseWaitFor(source: Map<string, string>, positionals: string[]): Record<string, string> {
  requireNoExtraPositionals(positionals, 1);
  const options = selectOptions(source, ["type", "body", "url", "file-name", "timeout"]);
  const type = requireOption(options, "type");
  const timeout = requireOption(options, "timeout");
  if (
    !POSITIVE_SECONDS.test(timeout) ||
    !Number.isFinite(Number(timeout)) ||
    Number(timeout) <= 0 ||
    Number(timeout) * 1_000 > 2_147_483_647
  ) {
    fail("Invalid --timeout");
  }
  if (["body", "url", "file-name"].filter((key) => options[key] !== undefined).length > 1) {
    fail("Use only one wait-for filter");
  }

  switch (type) {
    case "note":
      if (options.url !== undefined || options["file-name"] !== undefined)
        fail("Invalid wait-for filters");
      break;
    case "link":
      if (options["file-name"] !== undefined) fail("Invalid wait-for filters");
      if (options.url !== undefined) requireHttpUrl(options.url, "url");
      break;
    case "file":
      if (options.url !== undefined) fail("Invalid wait-for filters");
      break;
    default:
      fail("Invalid --type");
  }

  return options;
}

function parseDownload(source: Map<string, string>, positionals: string[]): Record<string, string> {
  requireNoExtraPositionals(positionals, 2);
  if (!Uuidv7.safeParse(positionals[1]).success) fail("Invalid push ID");
  const options = selectOptions(source, ["out"]);
  requireNonempty(requireOption(options, "out"), "out");
  return options;
}

function parseSmoke(source: Map<string, string>, positionals: string[]): Record<string, string> {
  requireNoExtraPositionals(positionals, 1);
  const options = selectOptions(source, ["url", "setup-token", "passphrase"]);
  requireHttpUrl(requireOption(options, "url"), "url");
  const setupToken = options["setup-token"];
  const passphrase = options.passphrase;
  if (setupToken === undefined && passphrase === undefined) {
    fail("Provide --setup-token or --passphrase");
  }
  if (setupToken !== undefined) requireNonempty(setupToken, "setup-token");
  if (passphrase !== undefined) requirePassphrase(passphrase);
  return options;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const { options: source, positionals } = tokenize(argv);
  const name = commandName(positionals[0]);
  const session = source.get("session") ?? DEFAULT_SESSION;
  requireNonempty(session, "session");

  let options: Record<string, string>;
  switch (name) {
    case "setup":
      options = parseSetup(source, positionals);
      break;
    case "login":
      options = parseLogin(source, positionals);
      break;
    case "pair-uri":
      options = parsePairUri(source, positionals);
      break;
    case "claim":
      options = parseClaim(source, positionals);
      break;
    case "send":
      options = parseSend(source, positionals);
      break;
    case "listen":
      options = parseListen(source, positionals);
      break;
    case "wait-for":
      options = parseWaitFor(source, positionals);
      break;
    case "download":
      options = parseDownload(source, positionals);
      break;
    case "smoke":
      options = parseSmoke(source, positionals);
      break;
  }

  if ((name === "setup" || name === "login" || name === "smoke") && options.url) {
    const url = new URL(options.url);
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password)
      fail("Expected a server origin");
    options.url = url.origin;
  }
  return { name, session, options, positionals: positionals.slice(1) };
}
