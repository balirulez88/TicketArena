import { describe, expect, it } from "vitest";
import type { MessageBus } from "./message-bus.js";

export interface ContractSubject {
  /** A bus whose topology is isolated to the calling test file. */
  connect(): Promise<MessageBus>;
}

let sequence = 0;
function unique(label: string): string {
  sequence += 1;
  return `${label}-${Date.now()}-${sequence}`;
}

/**
 * Behaviour every `MessageBus` adapter must provide. Run it against the real broker: dedupe,
 * redelivery and ack semantics are exactly what a fake would get wrong.
 */
export function describeMessageBusContract(name: string, subject: ContractSubject): void {
  describe(`MessageBus contract: ${name}`, () => {
    async function withBus(run: (bus: MessageBus) => Promise<void>): Promise<void> {
      const bus = await subject.connect();
      try {
        await bus.ensureTopology();
        await run(bus);
      } finally {
        await bus.close();
      }
    }

    const fetchOne = { maxMessages: 10, expiresMs: 1_000 };

    it("ensures the topology idempotently", async () => {
      await withBus(async (bus) => {
        await expect(bus.ensureTopology()).resolves.toBeUndefined();
      });
    });

    it("delivers a published message with its subject, payload and message id", async () => {
      await withBus(async (bus) => {
        const consumer = unique("deliver");
        const topic = unique("topic");
        const subscription = await bus.subscribe({
          stream: "main",
          consumer,
          filterSubject: `ta.order.${topic}`,
        });
        const msgId = unique("msg");
        await bus.publish({ subject: `ta.order.${topic}`, data: '{"n":1}', msgId });

        const [message, ...rest] = await subscription.fetch(fetchOne);

        expect(rest).toEqual([]);
        expect(message).toMatchObject({
          subject: `ta.order.${topic}`,
          data: '{"n":1}',
          msgId,
          deliveryCount: 1,
        });
        message?.ack();
      });
    });

    it("suppresses a publish repeating a message id and says so in the ack", async () => {
      await withBus(async (bus) => {
        const consumer = unique("dedupe");
        const topic = unique("topic");
        const subscription = await bus.subscribe({
          stream: "main",
          consumer,
          filterSubject: `ta.order.${topic}`,
        });
        const msgId = unique("msg");
        const first = await bus.publish({ subject: `ta.order.${topic}`, data: "a", msgId });
        const second = await bus.publish({ subject: `ta.order.${topic}`, data: "a", msgId });

        expect(first.duplicate).toBe(false);
        expect(second).toEqual({ streamSeq: first.streamSeq, duplicate: true });
        const messages = await subscription.fetch(fetchOne);
        expect(messages).toHaveLength(1);
        for (const message of messages) {
          message.ack();
        }
      });
    });

    it("does not redeliver an acked message", async () => {
      await withBus(async (bus) => {
        const consumer = unique("ack");
        const topic = unique("topic");
        const subscription = await bus.subscribe({
          stream: "main",
          consumer,
          filterSubject: `ta.hold.${topic}`,
          ackWaitMs: 500,
        });
        await bus.publish({ subject: `ta.hold.${topic}`, data: "x", msgId: unique("msg") });
        for (const message of await subscription.fetch(fetchOne)) {
          message.ack();
        }
        await new Promise((resolve) => setTimeout(resolve, 1_200));

        expect(await subscription.fetch({ maxMessages: 10, expiresMs: 1_000 })).toEqual([]);
      });
    });

    it("redelivers a nak'd message with a higher delivery count", async () => {
      await withBus(async (bus) => {
        const consumer = unique("nak");
        const topic = unique("topic");
        const subscription = await bus.subscribe({
          stream: "main",
          consumer,
          filterSubject: `ta.payment.${topic}`,
        });
        await bus.publish({ subject: `ta.payment.${topic}`, data: "x", msgId: unique("msg") });
        const [first] = await subscription.fetch(fetchOne);
        first?.nak(0);

        const [second] = await subscription.fetch(fetchOne);

        expect(second?.deliveryCount).toBe(2);
        expect(second?.streamSeq).toBe(first?.streamSeq);
        second?.ack();
      });
    });

    it("redelivers an unacked message after the ack wait", async () => {
      await withBus(async (bus) => {
        const consumer = unique("ackwait");
        const topic = unique("topic");
        const subscription = await bus.subscribe({
          stream: "main",
          consumer,
          filterSubject: `ta.seat.${topic}`,
          ackWaitMs: 500,
        });
        await bus.publish({ subject: `ta.seat.${topic}`, data: "x", msgId: unique("msg") });
        const [first] = await subscription.fetch({ maxMessages: 1, expiresMs: 1_000 });
        expect(first?.deliveryCount).toBe(1);

        const [second] = await subscription.fetch({ maxMessages: 1, expiresMs: 3_000 });

        expect(second?.deliveryCount).toBe(2);
        second?.ack();
      });
    });

    it("never redelivers a termed message", async () => {
      await withBus(async (bus) => {
        const consumer = unique("term");
        const topic = unique("topic");
        const subscription = await bus.subscribe({
          stream: "main",
          consumer,
          filterSubject: `ta.order.${topic}`,
          ackWaitMs: 500,
        });
        await bus.publish({ subject: `ta.order.${topic}`, data: "x", msgId: unique("msg") });
        for (const message of await subscription.fetch(fetchOne)) {
          message.term("poison");
        }
        await new Promise((resolve) => setTimeout(resolve, 1_200));

        expect(await subscription.fetch({ maxMessages: 10, expiresMs: 1_000 })).toEqual([]);
      });
    });
  });
}
