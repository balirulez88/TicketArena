import { JetStreamApiError, type JetStreamManager, jetstreamManager } from "@nats-io/jetstream";
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

/** A topology of its own per test, so a test may shrink, break or pre-empt its streams. */
function ownTopology(tag: string) {
  return {
    servers: nats.url,
    streamPrefix: `${nats.streamPrefix}${tag.toUpperCase()}_`,
    subjectPrefix: `${nats.subjectPrefix}${tag}`,
  };
}

async function withManager<T>(use: (manager: JetStreamManager) => Promise<T>): Promise<T> {
  const connection = await connect({ servers: nats.url });
  try {
    return await use(await jetstreamManager(connection));
  } finally {
    await connection.close();
  }
}

describe("JetStream topology re-application (AT-35)", () => {
  it("re-applies an unchanged topology without touching the stored messages", async () => {
    const options = ownTopology("same");
    const bus = await connectJetStreamMessageBus(options);
    await bus.ensureTopology();
    await bus.publish({ subject: "ta.order.placed", data: "{}", msgId: crypto.randomUUID() });
    const before = await withManager((m) => m.streams.info(`${options.streamPrefix}TICKETARENA`));

    await bus.ensureTopology();
    await bus.close();

    const after = await withManager((m) => m.streams.info(`${options.streamPrefix}TICKETARENA`));
    expect(after.created).toBe(before.created);
    expect(after.state.messages).toBe(1);
  });

  it("updates a stream declared by an older topology in place, keeping its messages", async () => {
    const options = ownTopology("older");
    const older = await connectJetStreamMessageBus({
      ...options,
      streamMaxBytes: { main: 64 * 1024, dlq: 32 * 1024 },
    });
    await older.ensureTopology();
    await older.publish({ subject: "ta.order.placed", data: "{}", msgId: crypto.randomUUID() });
    await older.close();
    const before = await withManager((m) => m.streams.info(`${options.streamPrefix}TICKETARENA`));
    expect(before.config.max_bytes).toBe(64 * 1024);

    const current = await connectJetStreamMessageBus(options);
    await current.ensureTopology();
    await current.close();

    const main = await withManager((m) => m.streams.info(`${options.streamPrefix}TICKETARENA`));
    const dlq = await withManager((m) => m.streams.info(`${options.streamPrefix}TICKETARENA_DLQ`));
    expect(main.config.max_bytes).toBe(1024 * 1024 * 1024);
    expect(dlq.config.max_bytes).toBe(256 * 1024 * 1024);
    expect(main.created).toBe(before.created);
    expect(main.state.messages).toBe(1);
  });

  it("keeps the two streams' subjects disjoint: each message lands in exactly one stream", async () => {
    const options = ownTopology("disjoint");
    const bus = await connectJetStreamMessageBus(options);
    await bus.ensureTopology();
    for (const subject of [
      "ta.seat.held",
      "ta.hold.expired",
      "ta.order.placed",
      "ta.payment.failed",
    ]) {
      await bus.publish({ subject, data: "{}", msgId: crypto.randomUUID() });
    }
    await bus.publish({ subject: "ta.dlq.payment", data: "{}", msgId: crypto.randomUUID() });
    await bus.close();

    const main = await withManager((m) => m.streams.info(`${options.streamPrefix}TICKETARENA`));
    const dlq = await withManager((m) => m.streams.info(`${options.streamPrefix}TICKETARENA_DLQ`));
    expect(main.state.messages).toBe(4);
    expect(dlq.state.messages).toBe(1);
  });
});

describe("JetStream topology failures (TD-036)", () => {
  it("falls back to update only when the stream already exists with another configuration", async () => {
    const options = ownTopology("exists");
    await withManager((m) =>
      m.streams.add({
        name: `${options.streamPrefix}TICKETARENA`,
        subjects: [`${options.subjectPrefix}.ta.order.>`],
        max_bytes: 4096,
      }),
    );

    const bus = await connectJetStreamMessageBus(options);
    await bus.ensureTopology();
    await bus.close();

    const main = await withManager((m) => m.streams.info(`${options.streamPrefix}TICKETARENA`));
    expect(main.config.subjects).toHaveLength(4);
    expect(main.config.max_bytes).toBe(1024 * 1024 * 1024);
  });

  it("propagates any other add failure with its original cause and attempts no update", async () => {
    const options = ownTopology("overlap");
    // A foreign stream owning one of our subjects makes the add itself invalid.
    await withManager((m) =>
      m.streams.add({
        name: `${options.streamPrefix}FOREIGN`,
        subjects: [`${options.subjectPrefix}.ta.order.>`],
      }),
    );
    const bus = await connectJetStreamMessageBus(options);

    const failure = await bus.ensureTopology().then(
      () => undefined,
      (error: unknown) => error,
    );
    await bus.close();

    expect(failure).toBeInstanceOf(JetStreamApiError);
    expect(String(failure)).toMatch(/overlap/i);
    const names = await withManager(async (m) => {
      const found: string[] = [];
      for await (const stream of m.streams.list()) {
        if (stream.config.name.startsWith(options.streamPrefix)) {
          found.push(stream.config.name);
        }
      }
      return found;
    });
    expect(names).toEqual([`${options.streamPrefix}FOREIGN`]);
  });

  it("propagates an unreachable broker's failure from the add", async () => {
    const bus = await connectJetStreamMessageBus(ownTopology("gone"));
    await bus.close();

    await expect(bus.ensureTopology()).rejects.toThrow(/closed/i);
  });
});
