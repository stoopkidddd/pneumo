import { ClaimPairRequest, HttpUrl } from "@pneumo/protocol";
import { b64uDecode, b64uEncode } from "./encoding.js";
import { requireKeyBytes } from "./internal.js";

export type PairingData = { origin: string; code: string; mk: Uint8Array };

function validateOrigin(origin: string): void {
  HttpUrl.parse(origin);
  const parsed = new URL(origin);
  if (origin !== parsed.origin) throw new TypeError("Expected an HTTP(S) origin without a path");
}

function validateCode(code: string): void {
  ClaimPairRequest.shape.code.parse(code);
}

export function buildPairingUri({ origin, code, mk }: PairingData): string {
  validateOrigin(origin);
  validateCode(code);
  requireKeyBytes(mk);
  const query = new URLSearchParams({ v: "1", u: origin, c: code, k: b64uEncode(mk) });
  return `pneumo://pair?${query}`;
}

export function parsePairingUri(uri: string): {
  origin: string;
  code: string;
  mk: Uint8Array<ArrayBuffer>;
} {
  if (!uri.startsWith("pneumo://pair?") || /[\s#]/.test(uri)) {
    throw new TypeError("Invalid pairing URI");
  }
  const parsed = new URL(uri);
  if (
    parsed.protocol !== "pneumo:" ||
    parsed.host !== "pair" ||
    parsed.pathname !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError("Invalid pairing URI");
  }
  const fields = parsed.searchParams;
  if (
    fields.size !== 4 ||
    ["v", "u", "c", "k"].some((name) => fields.getAll(name).length !== 1) ||
    fields.get("v") !== "1"
  ) {
    throw new TypeError("Invalid pairing parameters");
  }
  const origin = fields.get("u") ?? "";
  const code = fields.get("c") ?? "";
  const mk = b64uDecode(fields.get("k") ?? "");
  validateOrigin(origin);
  validateCode(code);
  requireKeyBytes(mk);
  return { origin, code, mk };
}
