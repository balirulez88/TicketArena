import { connect } from "@nats-io/transport-node";
import { describe, expect, it } from "vitest";
import { setupNatsStandIn } from "./index";

const standIn = setupNatsStandIn();

describe("setupNatsStandIn", () => {
  it("forwards to the real NATS and refuses connections while closed", async () => {
    const connection = await connect({ servers: standIn.url });
    await connection.flush();
    await connection.close();

    await standIn.setMode("closed");
    await expect(
      connect({ servers: standIn.url, reconnect: false, timeout: 1000 }),
    ).rejects.toThrow();
    await standIn.setMode("forward");
    const again = await connect({ servers: standIn.url });
    await again.flush();
    await again.close();
    expect(again.isClosed()).toBe(true);
  });
});
