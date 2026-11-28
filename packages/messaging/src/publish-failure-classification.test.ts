import { setupNatsStandIn, setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectJetStreamMessageBus, type MessageBus, PermanentPublishError } from "./index.js";

// What tells a permanent publish failure (specific to the row) from a transient one (the broker),
// pinned against real NATS. The adapter's constants and checks these depend on are noted beside
// them in jetstream-message-bus.ts; a NATS client upgrade that changes them turns this file red.
const nats = setupTestNats();
const standIn = setupNatsStandIn();

let bus: MessageBus;

beforeAll(async () => {
  bus = await connectJetStreamMessageBus({
    servers: nats.url,
    streamPrefix: nats.streamPrefix,
    subjectPrefix: nats.subjectPrefix,
  });
  await bus.ensureTopology();
});

afterAll(async () => {
  await bus.close();
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the publish to be rejected");
}

describe("publish failure classification", () => {
  it("classifies a subject outside every stream as permanent (no_stream)", async () => {
    const error = await rejection(
      bus.publish({ subject: "ta.unrouted.event", data: "{}", msgId: crypto.randomUUID() }),
    );

    expect(error).toBeInstanceOf(PermanentPublishError);
    expect(error).toMatchObject({ reason: "no_stream" });
    expect(String(error)).toMatch(/no stream matches subject/);
  });

  it("classifies a payload over the broker's max_payload as permanent (payload_too_large)", async () => {
    const error = await rejection(
      bus.publish({
        subject: "ta.order.placed",
        data: "x".repeat(2 * 1024 * 1024),
        msgId: crypto.randomUUID(),
      }),
    );

    expect(error).toBeInstanceOf(PermanentPublishError);
    expect(error).toMatchObject({ reason: "payload_too_large" });
    expect(String(error)).toMatch(/max_payload/);
  });

  it("classifies a stopped broker as transient, and publishes again once it is back", async () => {
    const outageBus = await connectJetStreamMessageBus({
      servers: standIn.url,
      streamPrefix: nats.streamPrefix,
      subjectPrefix: nats.subjectPrefix,
      requestTimeoutMs: 500,
      reconnectTimeWaitMs: 50,
    });
    try {
      await standIn.setMode("closed");
      const error = await rejection(
        outageBus.publish({ subject: "ta.order.placed", data: "{}", msgId: crypto.randomUUID() }),
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(PermanentPublishError);

      await standIn.setMode("forward");
      await expect
        .poll(
          async () =>
            outageBus
              .publish({ subject: "ta.order.placed", data: "{}", msgId: crypto.randomUUID() })
              .then(() => "published"),
          { timeout: 15_000, interval: 200 },
        )
        .toBe("published");
    } finally {
      await standIn.setMode("forward");
      await outageBus.close();
    }
  });
});
