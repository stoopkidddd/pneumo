import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./pneumo-dev/args.js";
import { Client, claim, login, setup } from "./pneumo-dev/client.js";
import { SafeError } from "./pneumo-dev/errors.js";
import { readSession, writeSession } from "./pneumo-dev/session.js";
import { smoke } from "./pneumo-dev/smoke.js";
import { pushes } from "./pneumo-dev/socket.js";

export type CliIO = {
  out(line: string): void;
  err(line: string): void;
  signal?: AbortSignal;
};

export async function run(
  argv: string[],
  io: CliIO = { out: (line) => console.log(line), err: (line) => console.error(line) },
): Promise<number> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  const signal = io.signal ?? controller.signal;
  try {
    const args = parseArgs(argv);
    if (!io.signal && (args.name === "listen" || args.name === "wait-for")) {
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    }
    const options = args.options;
    switch (args.name) {
      case "setup": {
        const session = await setup(
          options.url ?? "",
          options["setup-token"] ?? "",
          options.passphrase ?? "",
        );
        await writeSession(args.session, session);
        io.out(session.deviceId);
        return 0;
      }
      case "login": {
        const session = await login(options.url ?? "", options.passphrase ?? "", options.name);
        await writeSession(args.session, session);
        io.out(session.deviceId);
        return 0;
      }
      case "claim": {
        const session = await claim(options.uri ?? "");
        await writeSession(args.session, session);
        io.out(session.deviceId);
        return 0;
      }
      case "smoke":
        return await smoke(options, args.session, io.out);
    }
    const client = new Client(await readSession(args.session));
    switch (args.name) {
      case "pair-uri":
        io.out(await client.pairUri());
        return 0;
      case "send": {
        const [kind, value = ""] = args.positionals;
        const to = options.to ?? null;
        const push =
          kind === "file"
            ? await client.sendFile(value, to)
            : await client.send(
                kind === "link"
                  ? {
                      type: "link",
                      url: value,
                      ...(options.title === undefined ? {} : { title: options.title }),
                    }
                  : { type: "note", body: value },
                to,
              );
        io.out(push.id);
        return 0;
      }
      case "download":
        await client.download(args.positionals[0] ?? "", options.out ?? "");
        return 0;
      case "listen":
        for await (const push of pushes(client, signal)) io.out(JSON.stringify(push));
        return 0;
      case "wait-for": {
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), Number(options.timeout) * 1_000);
        try {
          for await (const push of pushes(client, AbortSignal.any([signal, timeout.signal]))) {
            if (
              push.type !== options.type ||
              (options.body !== undefined && push.body !== options.body) ||
              (options.url !== undefined && push.url !== options.url) ||
              (options["file-name"] !== undefined && push.fileName !== options["file-name"])
            )
              continue;
            io.out(JSON.stringify(push));
            return 0;
          }
          return 1;
        } finally {
          clearTimeout(timer);
        }
      }
    }
  } catch (error) {
    // Never echo input, HTTP response bodies, native errors, or crypto/schema diagnostics.
    io.err(error instanceof SafeError ? error.message : "Command failed");
    return 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
