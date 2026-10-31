# @pneumo/crypto

WebCrypto implementation of [SPEC §6](../../docs/SPEC.md#6-cryptography-normative).
The same source runs in browsers, service workers, and Node 26. Runtime code uses
`globalThis.crypto.subtle` and `getRandomValues`; it has no Node dependencies.
The library typecheck uses ES2023 + DOM declarations and explicitly excludes Node
types. Tests and vector scripts have a separate typecheck with Node declarations.

## API

All binary arguments and results are `Uint8Array`, not encoded strings, unless
noted. Asynchronous operations return promises. Schemas, labels, and wire constants
come from `@pneumo/protocol`.

| API                                         | Result / contract                                                                                                                                                                                     |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `newKdfParams()`                            | Protocol `KdfParams`: PBKDF2-SHA256, fresh 16-byte b64u salt, 600,000 iterations.                                                                                                                     |
| `deriveMasterKey(passphrase, kdf)`          | 32-byte MK; UTF-8 after NFC normalization, PBKDF2-HMAC-SHA256. The client enforces the 12-character minimum.                                                                                          |
| `deriveKeys(mk)`                            | `DerivedKeys`: `{ contentKey, authKey }`; non-extractable AES-256-GCM `CryptoKey` and 32 auth bytes, HKDF-SHA256 with the §6.2 labels.                                                                |
| `keyCheck(mk)`                              | 32-byte HMAC-SHA256 key check (§6.3).                                                                                                                                                                 |
| `encryptPush(contentKey, pushId, payload)`  | Protocol `Envelope`, with a fresh 12-byte nonce and push-id AAD; validates the input payload.                                                                                                         |
| `decryptPush(contentKey, pushId, envelope)` | Authenticated, UTF-8/JSON-decoded and protocol-schema-validated `PushPayload`; rejects malformed input or authentication failure.                                                                     |
| `generateFileKey()`                         | Fresh random 32-byte FK. Use a new FK for each file.                                                                                                                                                  |
| `createFileEncryptor(fk, fileId)`           | `TransformStream<Uint8Array, Uint8Array>` producing the §6.6 header and authenticated blocks.                                                                                                         |
| `createFileDecryptor(fk, fileId)`           | Same stream type; verifies the header, each block, and the final-block marker.                                                                                                                        |
| `encryptBlob(fk, fileId, blob)`             | Encrypted `Blob`.                                                                                                                                                                                     |
| `decryptBlob(fk, fileId, blob)`             | Decrypted `Blob`; MIME metadata is not preserved.                                                                                                                                                     |
| `buildPairingUri({ origin, code, mk })`     | §6.7 URI; accepts an exact HTTP(S) `URL.origin`, a canonical b64u 16-byte pairing code, and a 32-byte MK.                                                                                             |
| `parsePairingUri(uri)`                      | `{ origin, code, mk }`; rejects wrong scheme/host/version, credentials, paths, fragments, whitespace, missing/duplicate/unknown fields, invalid origins, and noncanonical/wrong-length binary values. |
| `b64uEncode(bytes)` / `b64uDecode(value)`   | Canonical, unpadded RFC 4648 base64url, including strict validation of trailing pad bits. Empty bytes/string are valid.                                                                               |

`PairingData` is the pairing builder's input type. `DerivedKeys` describes the
result of `deriveKeys`; protocol DTOs are not redefined here.

### Streaming

Input chunk boundaries are irrelevant, including empty input chunks. Encryptors
buffer at most one 65,536-byte plaintext block; decryptors buffer at most one
65,552-byte ciphertext block, plus their header position. A full block is held
until another byte arrives, so the last block always uses the authenticated last
flag. Empty files have one authenticated empty block; an empty last block after
another block is invalid. Nonces use a uint64 big-endian chunk counter.

Use the protocol's `ciphertextSize(plainSize)` before uploading. Consume the
readable side concurrently with writing (or use `pipeThrough`) to respect stream
backpressure. A decryptor can emit authenticated earlier blocks before a later
block fails: **discard all output if the stream fails**, and do not treat partial
output as a complete file. Blob helpers buffer the result and reject on failure.
Callers enforce the deployment's envelope/file size limits.

## Verification

```sh
mise run check:protocol
mise exec -- pnpm --filter @pneumo/crypto vectors:generate
python3 -I scripts/crosscheck_vectors.py packages/crypto/vectors/v1.json
```

The crypto Vitest project checks vector freshness in memory, all vector cases,
Python's independent KDF/HKDF/HMAC calculations, streaming/tamper behavior, and
browser-safe source imports. No root task changes are needed.

## Vectors v1

`vectors/v1.json` is generated in full by `scripts/generate-vectors.ts` from the
pure `buildVectors()` function in `scripts/vectors.ts`. Run `vectors:generate`
after changing the generator; never edit the JSON by hand. Commit messages must
explicitly mention vector regeneration. These contract vectors freeze after M1.

The top-level `$comment` documents the format for the Kotlin consumer. All binary
values, including SHA-256 digests, are canonical unpadded b64u. `version` is `1`.
Sections:

| Section               | Shape / meaning                                                                                                                                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kdf`                 | Array of `{ name, passphrase, params: { alg, iterations, salt }, masterKey }`. One 600,000-iteration case; fast 1,000-iteration cases include NFC-equivalent input. Passphrases are fixed fake test strings.                                                                                                             |
| `hkdf`                | Array of `{ name, masterKey, label, length, output }`, covering content, auth, and check subkeys; empty salt, SHA-256, output length in bytes.                                                                                                                                                                           |
| `keyCheck`, `authKey` | Arrays of `{ name, masterKey, output }`; key check includes the §6.3 HMAC step, auth is the §6.2 auth subkey.                                                                                                                                                                                                            |
| `envelope`            | Array of `{ name, masterKey, pushId, nonce, payload, envelope: { v, n, c } }` for all three payload variants with fixed nonces.                                                                                                                                                                                          |
| `file`                | `{ key, fileId, plaintextPattern, cases }`. Each case has `{ name, size, ciphertextLength }` and either `ciphertext` (sizes 0, 1, 65,535, 65,536, 65,537) or `sha256` (200,000 bytes). Plaintext byte `i` is `(i * 31 + 17) & 255`.                                                                                      |
| `negative`            | Array of `{ name, operation, source, mutation, expected: \"reject\" }`. Source references an envelope name or file size. Mutations specify byte XOR, truncation, appended bytes, or replacement AAD ids; apply them to the referenced positive vector before decrypting. Exact tagged mutation shapes are in `$comment`. |

The deterministic seam (`deriveHkdf` and fixed-nonce `encryptPushWithNonce`) is
internal, not a package export. Salts, FKs, and ids enter through ordinary API
arguments. Production entry points always generate random salts, nonces, and FKs.

`scripts/crosscheck_vectors.py` uses only Python's standard library: PBKDF2-HMAC,
NFC normalization, HMAC-SHA256, and RFC 5869 HKDF written out directly. It checks
every `kdf`, `hkdf`, `keyCheck`, and `authKey` output. Run with `python3 -I` for
isolated imports. Kotlin cross-checks AES-GCM envelopes/files in M4.

## Security boundary

See [SPEC §6.11 (threat model)](../../docs/SPEC.md#611-threat-model). Encryption
protects content from bucket compromise and Web Push providers, not a compromised
origin serving modified JavaScript, a compromised device, or metadata disclosure.
Key storage is outside this package. Never log passphrases, MKs, FKs, auth keys,
pairing URIs, or device tokens.
