import { createServer } from "http";
import type { AddressInfo } from "net";
import type { IncomingMessage } from "http";
import express from "express";
import { WebSocket } from "ws";

import { attachTaskStream, getClientIp } from "../src/api/routes/stream";
import { getConfig } from "../src/config";
import type { EventStore } from "../src/events/eventStore";
import type { Task } from "../src/types/task";

describe("WebSocket client connection limiting", () => {
  it("uses the socket address unless a trusted proxy supplies the client address", () => {
    const req = {
      headers: { "x-forwarded-for": "198.51.100.24, 10.0.0.2" },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as IncomingMessage;

    const app = express();
    app.set("trust proxy", false);
    expect(getClientIp(req, app.get("trust proxy fn"))).toBe("127.0.0.1");

    app.set("trust proxy", 2);
    expect(getClientIp(req, app.get("trust proxy fn"))).toBe("198.51.100.24");
  });

  it("does not let 20 distinct forwarded headers reset one socket address limit", async () => {
    const httpServer = createServer();
    const detach = attachTaskStream({
      httpServer,
      eventStore: {} as EventStore,
      getTask: () => ({ walletPublicKey: "owner" }) as Task,
      authTimeoutMs: 5_000,
    });
    const clients: WebSocket[] = [];

    await new Promise<void>((resolve) =>
      httpServer.listen(0, "127.0.0.1", resolve),
    );
    const address = httpServer.address() as AddressInfo;

    try {
      const attempts = Array.from({ length: 20 }, (_, index) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${address.port}/tasks/test/stream`,
          {
            headers: { "X-Forwarded-For": `198.51.100.${index + 1}` },
          },
        );
        clients.push(ws);

        return new Promise<boolean>((resolve) => {
          ws.once("open", () => resolve(true));
          ws.once("unexpected-response", (_request, response) => {
            response.resume();
            resolve(false);
          });
          ws.once("error", () => resolve(false));
        });
      });

      const accepted = await Promise.all(attempts);
      expect(accepted.filter(Boolean)).toHaveLength(
        getConfig().WS_MAX_CONNECTIONS_PER_CLIENT,
      );
      expect(accepted.filter((value) => !value)).toHaveLength(
        20 - getConfig().WS_MAX_CONNECTIONS_PER_CLIENT,
      );
    } finally {
      detach();
      for (const client of clients) client.terminate();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  }, 10_000);
});
