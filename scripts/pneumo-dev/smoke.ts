import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidv7 } from "@pneumo/protocol";
import { Client, claim, login, setup } from "./client.js";
import { SafeError } from "./errors.js";
import { writeSession } from "./session.js";
import { Connection } from "./socket.js";

export const smokePassphrase = "pneumo smoke test passphrase";

export async function smoke(
  options: Record<string, string>,
  sessionPath: string,
  out: (line: string) => void,
): Promise<number> {
  let a: Client | undefined;
  let b: Client | undefined;
  let socket: Connection | undefined;
  let temporary: string | undefined;
  let revoked = false;
  let failed = false;
  const created: string[] = [];
  let step = "authentication";
  const pass = () => out(`PASS ${step}`);
  try {
    const url = options.url ?? "";
    const passphrase = options.passphrase ?? smokePassphrase;
    const session = options["setup-token"]
      ? await setup(url, options["setup-token"], passphrase)
      : await login(url, passphrase);
    a = new Client(session);
    await writeSession(sessionPath, session);
    pass();

    step = "pair and claim";
    temporary = await mkdtemp(join(tmpdir(), "pneumo-smoke-"));
    const phone = await claim(await a.pairUri());
    b = new Client(phone);
    await writeSession(join(temporary, "phone.json"), phone);
    socket = new Connection(phone);
    await socket.wait((frame) => frame.type === "replay_done");
    pass();

    step = "note over WebSocket";
    const body = `pneumo smoke note ${uuidv7()}`;
    const note = await a.send({ type: "note", body }, phone.deviceId);
    created.push(note.id);
    const noteFrame = await socket.wait(
      (frame) => frame.type === "push" && frame.push.id === note.id,
    );
    if (noteFrame.type !== "push") throw new SafeError("Expected a push");
    const notePayload = await b.payload(noteFrame.push);
    if (
      notePayload.type !== "note" ||
      notePayload.body !== body ||
      noteFrame.push.sourceDeviceId !== session.deviceId ||
      noteFrame.push.targetDeviceId !== phone.deviceId
    ) {
      throw new SafeError("The note was not delivered intact");
    }
    pass();

    step = "link over WebSocket";
    const link = await a.send(
      { type: "link", title: "Pneumo smoke", url: "https://example.com/pneumo-smoke" },
      phone.deviceId,
    );
    created.push(link.id);
    const linkFrame = await socket.wait(
      (frame) => frame.type === "push" && frame.push.id === link.id,
    );
    if (linkFrame.type !== "push") throw new SafeError("Expected a push");
    const linkPayload = await b.payload(linkFrame.push);
    if (
      linkPayload.type !== "link" ||
      linkPayload.url !== "https://example.com/pneumo-smoke" ||
      linkPayload.title !== "Pneumo smoke"
    ) {
      throw new SafeError("The link was not delivered intact");
    }
    pass();

    step = "2 MB file round trip";
    const bytes = new Uint8Array(2 * 1024 * 1024);
    for (let offset = 0; offset < bytes.length; offset += 65_536) {
      crypto.getRandomValues(bytes.subarray(offset, offset + 65_536));
    }
    const input = join(temporary, "smoke.bin");
    const output = join(temporary, "download.bin");
    await writeFile(input, bytes);
    const file = await a.sendFile(input, phone.deviceId);
    created.push(file.id);
    const fileFrame = await socket.wait(
      (frame) => frame.type === "push" && frame.push.id === file.id,
    );
    if (fileFrame.type !== "push") throw new SafeError("Expected a push");
    const filePayload = await b.payload(fileFrame.push);
    if (
      filePayload.type !== "file" ||
      filePayload.file.name !== "smoke.bin" ||
      filePayload.file.size !== bytes.length
    ) {
      throw new SafeError("The file metadata was not delivered intact");
    }
    await b.download(file.id, output);
    if (!Buffer.from(bytes.buffer).equals(await readFile(output)))
      throw new SafeError("The downloaded file differs");
    pass();

    step = "push_deleted";
    await a.deletePush(file.id);
    created.splice(created.indexOf(file.id), 1);
    await socket.wait((frame) => frame.type === "push_deleted" && frame.id === file.id);
    pass();

    step = "revoke closes 4401";
    await a.removeDevice(phone.deviceId);
    revoked = true;
    if ((await socket.waitForClose()) !== 4401)
      throw new SafeError("Revocation did not close with 4401");
    pass();
  } catch {
    failed = true;
    out(`FAIL ${step}`);
  } finally {
    socket?.close();
    if (a) {
      for (const id of created) {
        try {
          await a.deletePush(id);
        } catch {
          failed = true;
          out("FAIL cleanup push");
        }
      }
      if (b && !revoked) {
        try {
          await a.removeDevice(b.session.deviceId);
        } catch {
          failed = true;
          out("FAIL cleanup device");
        }
      }
    }
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
  return failed ? 1 : 0;
}
