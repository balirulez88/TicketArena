import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { setupTestNats } from "@ticketarena/test-infra";
import { describe, expect, it } from "vitest";
import { connectJetStreamMessageBus } from "./index.js";
import { describeMessageBusContract } from "./message-bus.contract.js";

const nats = setupTestNats();

const isolated = () =>
  connectJetStreamMessageBus({
    servers: nats.url,
    streamPrefix: nats.streamPrefix,
    subjectPrefix: nats.subjectPrefix,
  });

describeMessageBusContract("JetStream adapter", { connect: isolated });

describe("JetStream topology", () => {
  it("declares the two streams exactly as ADR 0004 specifies", async () => {
    const bus = await isolated();
    await bus.ensureTopology();
    await bus.ensureTopology();
    await bus.close();

    const connection = await connect({ servers: nats.url });
    try {
      const manager = await jetstreamManager(connection);
      const main = (await manager.streams.info(`${nats.streamPrefix}TICKETARENA`)).config;
      const dlq = (await manager.streams.info(`${nats.streamPrefix}TICKETARENA_DLQ`)).config;
      const root = nats.subjectPrefix;
      const days = (n: number) => n * 86_400_000 * 1_000_000;

      expect(main).toMatchObject({
        subjects: ["seat", "hold", "order", "payment"].map((s) => `${root}.ta.${s}.>`),
        retention: "limits",
        discard: "new",
        max_age: days(7),
      });
      expect(main.max_bytes).toBeGreaterThan(0);
      expect(dlq).toMatchObject({
        subjects: [`${root}.ta.dlq.>`],
        retention: "limits",
        discard: "new",
        max_age: days(30),
        duplicate_window: 10 * 60 * 1_000_000_000,
      });
      expect(dlq.max_bytes).toBeGreaterThan(0);
    } finally {
      await connection.close();
    }
  });

  it("configures consumers with AckWait 30s, no BackOff and MaxDeliver -1", async () => {
    const bus = await isolated();
    await bus.ensureTopology();
    await bus.subscribe({ stream: "main", consumer: "shape", filterSubject: "ta.order.>" });
    await bus.close();

    const connection = await connect({ servers: nats.url });
    try {
      const manager = await jetstreamManager(connection);
      const info = await manager.consumers.info(`${nats.streamPrefix}TICKETARENA`, "shape");
      expect(info.config.ack_wait).toBe(30_000 * 1_000_000);
      expect(info.config.max_deliver).toBe(-1);
      expect(info.config.backoff ?? []).toEqual([]);
      expect(info.config.durable_name).toBe("shape");
    } finally {
      await connection.close();
    }
  });
});
