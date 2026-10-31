import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64uEncode, deriveKeys, encryptBlob, encryptPush } from "@pneumo/crypto";
import { uuidv7 } from "@pneumo/protocol";
import { expect, test } from "vitest";
import { run } from "../pneumo-dev.js";
import { writeSession } from "./session.js";

test("a failed final file tag leaves the existing output intact and removes partial plaintext", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pneumo-download-test-"));
  const id = uuidv7();
  const fileId = uuidv7();
  const deviceId = uuidv7();
  const mk = new Uint8Array(32).fill(17);
  const fk = new Uint8Array(32).fill(19);
  const token = b64uEncode(new Uint8Array(32).fill(23));
  const { contentKey } = await deriveKeys(mk);
  const bytes = new Uint8Array(70_000).fill(41);
  const envelope = await encryptPush(contentKey, id, {
    type: "file",
    file: {
      name: "payload.bin",
      mime: "application/octet-stream",
      size: bytes.length,
      key: b64uEncode(fk),
    },
  });
  const ciphertext = new Uint8Array(
    await (await encryptBlob(fk, fileId, new Blob([bytes]))).arrayBuffer(),
  );
  ciphertext[ciphertext.length - 1] = (ciphertext[ciphertext.length - 1] ?? 0) ^ 1;
  let contentAuthenticated = false;
  const server = createServer((request, response) => {
    if (request.url === `/api/pushes/${id}`) {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          id,
          createdAt: "2026-10-31T12:00:00.000Z",
          sourceDeviceId: deviceId,
          targetDeviceId: null,
          envelope,
          file: { id: fileId, size: ciphertext.length },
        }),
      );
    } else if (request.url === `/api/files/${fileId}`) {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          download: { url: `/api/files/${fileId}/content`, headers: {} },
          expiresAt: "2026-10-31T12:00:00.000Z",
        }),
      );
    } else if (request.url === `/api/files/${fileId}/content`) {
      contentAuthenticated = request.headers.authorization === `Bearer ${token}`;
      response.end(ciphertext);
    } else {
      response.writeHead(404).end();
    }
  });
  try {
    const listening = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test port");
    const sessionPath = join(directory, "session.json");
    const out = join(directory, "output.bin");
    const original = new Uint8Array([1, 2, 3]);
    await writeSession(sessionPath, {
      url: `http://127.0.0.1:${address.port}`,
      deviceId,
      token,
      mk: b64uEncode(mk),
    });
    await writeFile(out, original);
    const output: string[] = [];
    const code = await run(["download", id, "--out", out, "--session", sessionPath], {
      out: (line) => output.push(line),
      err: (line) => output.push(line),
    });
    expect(code).toBe(1);
    expect(contentAuthenticated).toBe(true);
    expect(Buffer.from(original).equals(await readFile(out))).toBe(true);
    expect((await readdir(directory)).sort()).toEqual(["output.bin", "session.json"]);
    expect(
      [token, b64uEncode(mk), b64uEncode(fk)].some((secret) => output.join("").includes(secret)),
    ).toBe(false);
  } finally {
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    server.closeAllConnections();
    await closed.promise;
    await rm(directory, { recursive: true, force: true });
  }
});
