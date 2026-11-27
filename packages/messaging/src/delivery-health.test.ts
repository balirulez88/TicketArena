import { setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectJetStreamMessageBus, type DeliveryHealthProbe, type MessageBus } from "./index.js";

// The dashboard's message-health figures (spec: Admin dashboard), read from real JetStream:
// consumer lag, pending acks and redeliveries per durable consumer, and the DLQ's size and age.
const nats = setupTestNats();

let bus: MessageBus & DeliveryHealthProbe;

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

function newConsumer(): { name: string; subject: string } {
  const suffix = crypto.randomUUID().slice(0, 8);
  return { name: `health-${suffix}`, subject: `ta.order.health${suffix}` };
}

async function publish(subject: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await bus.publish({ subject, data: `{"n":${i}}`, msgId: crypto.randomUUID() });
  }
}

describe("deliveryHealth", () => {
  it("reports undelivered messages as lag, unacked ones as pending acks, and redeliveries", async () => {
    const consumer = newConsumer();
    const subscription = await bus.subscribe({
      stream: "main",
      consumer: consumer.name,
      filterSubject: consumer.subject,
    });
    await publish(consumer.subject, 3);

    const [first] = await subscription.fetch({ maxMessages: 1, expiresMs: 2000 });
    const afterFirst = await bus.deliveryHealth([consumer.name], new Date());
    expect(afterFirst.consumers[consumer.name]).toEqual({
      lag: 2,
      pendingAcks: 1,
      redeliveries: 0,
    });

    first?.nak();
    const [again] = await subscription.fetch({ maxMessages: 1, expiresMs: 2000 });
    expect(again?.deliveryCount).toBe(2);
    const afterRedelivery = await bus.deliveryHealth([consumer.name], new Date());
    expect(afterRedelivery.consumers[consumer.name]).toEqual({
      lag: 2,
      pendingAcks: 1,
      redeliveries: 1,
    });

    again?.ack();
    const rest = await subscription.fetch({ maxMessages: 2, expiresMs: 2000 });
    for (const message of rest) {
      message.ack();
    }
    // Acks are fire-and-forget; poll until the broker has counted them.
    await expect
      .poll(async () => (await bus.deliveryHealth([consumer.name], new Date())).consumers, {
        timeout: 5000,
      })
      .toEqual({ [consumer.name]: { lag: 0, pendingAcks: 0, redeliveries: 0 } });
  });

  it("reports a consumer the broker does not know as null", async () => {
    const health = await bus.deliveryHealth(["never-created"], new Date());

    expect(health.consumers).toEqual({ "never-created": null });
  });

  it("reports an empty DLQ as size 0 with no age, then its size and oldest message's age", async () => {
    expect((await bus.deliveryHealth([], new Date())).dlq).toEqual({
      size: 0,
      oldestAgeMs: null,
    });
    const publishedFrom = Date.now();
    await publish(`ta.dlq.${newConsumer().name}`, 1);
    await publish(`ta.dlq.${newConsumer().name}`, 1);
    const publishedTo = Date.now();
    const now = new Date(publishedTo + 60_000);

    const { dlq } = await bus.deliveryHealth([], now);

    expect(dlq.size).toBe(2);
    // Stamped by the broker's clock; a second of slack covers a container's clock drift.
    expect(dlq.oldestAgeMs).toBeGreaterThanOrEqual(now.getTime() - publishedTo - 1000);
    expect(dlq.oldestAgeMs).toBeLessThanOrEqual(now.getTime() - publishedFrom + 1000);
  });
});
