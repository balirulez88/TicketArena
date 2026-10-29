import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestNats } from "./index";

const nats = setupTestNats();
let connection: NatsConnection;

beforeAll(async () => {
  connection = await connect({ servers: nats.url });
});
afterAll(async () => {
  await connection.close();
});

describe("setupTestNats", () => {
  it("reaches a real JetStream server", async () => {
    const manager = await jetstreamManager(connection);
    const info = await manager.getAccountInfo();
    expect(info.limits).toBeDefined();
  });

  it("isolates streams by prefix and dedupes publishes by message id", async () => {
    const manager = await jetstreamManager(connection);
    const stream = `${nats.streamPrefix}SMOKE`;
    const subject = `${nats.subjectPrefix}.smoke`;
    await manager.streams.add({ name: stream, subjects: [`${nats.subjectPrefix}.>`] });

    const client = jetstream(connection);
    const first = await client.publish(subject, "hello", { msgID: "event-1" });
    const replay = await client.publish(subject, "hello", { msgID: "event-1" });

    expect(first.stream).toBe(stream);
    expect(first.duplicate).toBe(false);
    expect(replay.duplicate).toBe(true);
    expect((await manager.streams.info(stream)).state.messages).toBe(1);
  });
});
