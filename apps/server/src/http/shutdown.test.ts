import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, vi } from "vitest";
import { createLogger } from "../log.js";
import { shutdownServer } from "./shutdown.js";

test("shutdown closes acceptance, sends 1012 to hooks, and drains an in-flight response", async () => {
  const started = Promise.withResolvers<ServerResponse>();
  const server = createServer((_request, response) => started.resolve(response));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const pending = fetch(`http://127.0.0.1:${port}/in-flight`);
  const response = await started.promise;
  const codes: number[] = [];
  const stopped = shutdownServer(
    server,
    [
      (code) => {
        codes.push(code);
      },
    ],
    createLogger("silent"),
  );
  try {
    await expect(fetch(`http://127.0.0.1:${port}/new`)).rejects.toThrow();
    response.end("completed in flight");
    expect(await (await pending).text()).toBe("completed in flight");
    expect(await stopped).toBe(true);
    expect(codes).toEqual([1012]);
  } finally {
    response.end();
    server.closeAllConnections();
    server.close();
  }
});

test("shutdown stops waiting after ten seconds even if a hook does not settle", async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const hook = Promise.withResolvers<void>();
    const stopped = shutdownServer(server, [() => hook.promise], createLogger("silent"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await stopped).toBe(false);
    hook.resolve();
  } finally {
    vi.useRealTimers();
    server.closeAllConnections();
    server.close();
  }
});
