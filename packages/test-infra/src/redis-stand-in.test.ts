import { connect } from "node:net";
import { createClient } from "redis";
import { describe, expect, it } from "vitest";
import { setupRedisStandIn } from "./index";

const standIn = setupRedisStandIn();

/** Resolves with what a raw TCP connect to the stand-in sees: refused, or accepted. */
function probe(url: string): Promise<"refused" | "accepted"> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve) => {
    const socket = connect(Number(port), hostname);
    socket.once("connect", () => {
      socket.destroy();
      resolve("accepted");
    });
    socket.once("error", () => resolve("refused"));
  });
}

describe("setupRedisStandIn", () => {
  it("forwards to the real Redis, refuses when closed and answers again on the same port", async () => {
    const forwarded = async () => {
      const client = createClient({ url: standIn.url });
      await client.connect();
      try {
        return await client.ping();
      } finally {
        client.destroy();
      }
    };

    expect(await forwarded()).toBe("PONG");
    await standIn.setMode("closed");
    expect(await probe(standIn.url)).toBe("refused");
    await standIn.setMode("forward");
    expect(await forwarded()).toBe("PONG");
  });

  it("in silent mode accepts connections but never answers", async () => {
    await standIn.setMode("silent");
    const socket = connect(Number(new URL(standIn.url).port), "127.0.0.1");
    const answered = new Promise<boolean>((resolve) => {
      socket.once("data", () => resolve(true));
      socket.once("close", () => resolve(false));
    });
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    socket.write("*1\r\n$4\r\nPING\r\n");
    await expect.poll(() => standIn.openConnections()).toBe(1);

    await standIn.setMode("forward");

    expect(await answered).toBe(false);
    await expect.poll(() => standIn.openConnections()).toBe(0);
  });
});
